/**
 * check-stellar-testnet-snippets.ts
 *
 * Two distinct responsibilities, deliberately separated so CI can treat them
 * with different blocking semantics:
 *
 *   EXIT 0  – everything passed
 *   EXIT 1  – CONTENT REGRESSION: deterministic failure (wrong snippet count,
 *             file unreadable, Horizon response shape mismatch when the
 *             provider WAS reachable). These BLOCK merges.
 *   EXIT 2  – PROVIDER OUTAGE: horizon-testnet is unreachable or returned a
 *             5xx / rate-limit response. These are reported as a warning
 *             annotation but do NOT block merges.
 *
 * The split lets CI run two steps from this same entry-point by passing a
 * MODE environment variable:
 *
 *   MODE=content   – run only the deterministic content checks (exits 0 or 1)
 *   MODE=provider  – run only the live provider checks     (exits 0, 1, or 2)
 *   MODE=all       – run both (default, used locally)
 */

import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const STELLAR_DOCS = "sdk/chains/stellar.mdx";
const TESTNET_BASE_URL = "https://horizon-testnet.stellar.org";
const FETCH_TIMEOUT_MS = 15_000;
const MIN_SNIPPETS = 5;

/** HTTP status codes that indicate a provider outage rather than a content
 *  regression.  429 (rate-limit) and 5xx are transient; 4xx < 429 are not. */
const PROVIDER_OUTAGE_STATUSES = new Set([429, 500, 502, 503, 504]);

type HorizonCheck = {
  name: string;
  path: string;
  validate: (payload: unknown) => boolean;
};

const HORIZON_CHECKS: HorizonCheck[] = [
  {
    name: "root",
    path: "/",
    validate: (payload) => hasString(payload, "horizon_version"),
  },
  {
    name: "latest ledger",
    path: "/ledgers?order=desc&limit=1",
    validate: (payload) =>
      Array.isArray(readPath(payload, ["_embedded", "records"])),
  },
  {
    name: "fee stats",
    path: "/fee_stats",
    validate: (payload) =>
      hasObject(payload, "fee_charged") && hasObject(payload, "max_fee"),
  },
  {
    name: "native asset",
    path: "/assets?asset_type=native&limit=1",
    validate: (payload) =>
      Array.isArray(readPath(payload, ["_embedded", "records"])),
  },
  {
    name: "operations",
    path: "/operations?order=desc&limit=1",
    validate: (payload) =>
      Array.isArray(readPath(payload, ["_embedded", "records"])),
  },
];

// ---------------------------------------------------------------------------
// Sentinel error classes
// ---------------------------------------------------------------------------

/** Thrown when a failure is clearly a content regression (always blocks). */
class ContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentError";
  }
}

/** Thrown when a failure is a provider outage (never blocks merges). */
class ProviderOutageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderOutageError";
  }
}

// ---------------------------------------------------------------------------
// Deterministic content checks (exit 1 on failure)
// ---------------------------------------------------------------------------

async function checkContent(): Promise<string[]> {
  let markdown: string;
  try {
    markdown = await readFile(STELLAR_DOCS, "utf8");
  } catch (err) {
    throw new ContentError(
      `Cannot read ${STELLAR_DOCS}: ${(err as Error).message}`,
    );
  }

  const snippets = Array.from(
    markdown.matchAll(
      /^```(?:ts|tsx|typescript|js|javascript)([^\n]*)\n([\s\S]*?)^```/gm,
    ),
  )
    .map((match, index) => ({
      attrs: match[1] ?? "",
      code: match[2] ?? "",
      index,
      line: markdown.slice(0, match.index).split("\n").length,
    }))
    .filter((snippet) => !/\bno-check\b/.test(snippet.attrs));

  if (snippets.length < MIN_SNIPPETS) {
    throw new ContentError(
      `Expected at least ${MIN_SNIPPETS} checkable Stellar snippets in ` +
        `${STELLAR_DOCS}, found ${snippets.length}. ` +
        `If snippets were intentionally removed, update MIN_SNIPPETS in this script.`,
    );
  }

  const selected = snippets.slice(0, MIN_SNIPPETS);
  return selected.map((s) => `${STELLAR_DOCS}:${s.line}`);
}

// ---------------------------------------------------------------------------
// Live provider checks (exit 2 on outage, exit 1 on reachable-but-wrong-shape)
// ---------------------------------------------------------------------------

async function checkProvider(): Promise<string[]> {
  const passed: string[] = [];

  for (const check of HORIZON_CHECKS) {
    const url = `${TESTNET_BASE_URL}${check.path}`;
    let response: Response;

    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      // Network-level failure (DNS, TCP, timeout) → outage
      throw new ProviderOutageError(
        `[provider-outage] "${check.name}" – network error fetching ${url}: ${
          (err as Error).message
        }`,
      );
    }

    if (PROVIDER_OUTAGE_STATUSES.has(response.status)) {
      throw new ProviderOutageError(
        `[provider-outage] "${check.name}" – ${url} returned HTTP ${response.status} ` +
          `(treated as transient provider outage, not a content regression).`,
      );
    }

    if (!response.ok) {
      // 4xx other than 429 — the endpoint itself is broken; this is a content issue.
      throw new ContentError(
        `[content-regression] "${check.name}" – ${url} returned HTTP ${response.status}. ` +
          `This is unexpected for a stable Horizon endpoint and indicates a ` +
          `documentation or configuration error.`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      // Malformed JSON from a 2xx — content regression (Horizon changed shape).
      throw new ContentError(
        `[content-regression] "${check.name}" – ${url} returned non-JSON body: ${
          (err as Error).message
        }`,
      );
    }

    if (!check.validate(payload)) {
      throw new ContentError(
        `[content-regression] "${check.name}" – response from ${url} did not ` +
          `match the expected Horizon shape. ` +
          `This suggests the Horizon API changed in a way that breaks our docs.`,
      );
    }

    passed.push(check.name);
  }

  return passed;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const MODE = (process.env["MODE"] ?? "all").toLowerCase();
const VALID_MODES = new Set(["all", "content", "provider"]);

if (!VALID_MODES.has(MODE)) {
  console.error(
    `Unknown MODE="${MODE}". Valid values: all | content | provider`,
  );
  process.exit(1);
}

async function main() {
  const runContent = MODE === "all" || MODE === "content";
  const runProvider = MODE === "all" || MODE === "provider";

  // --- content checks ---
  if (runContent) {
    let snippetLocations: string[];
    try {
      snippetLocations = await checkContent();
    } catch (err) {
      if (err instanceof ContentError) {
        console.error(`::error::${err.message}`);
        process.exit(1);
      }
      throw err;
    }
    console.log(`Stellar snippets selected: ${snippetLocations.join(", ")}`);
  }

  // --- provider checks ---
  if (runProvider) {
    let passedChecks: string[];
    try {
      passedChecks = await checkProvider();
    } catch (err) {
      if (err instanceof ProviderOutageError) {
        // Emit a GitHub Actions warning annotation so it's visible in the PR
        // without blocking the merge.
        console.warn(`::warning::${err.message}`);
        process.exit(2);
      }
      if (err instanceof ContentError) {
        console.error(`::error::${err.message}`);
        process.exit(1);
      }
      throw err;
    }
    console.log(
      `Stellar testnet checks passed: ${passedChecks.join(", ")}`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function hasString(payload: unknown, key: string): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as Record<string, unknown>)[key] === "string"
  );
}

function hasObject(payload: unknown, key: string): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as Record<string, unknown>)[key] === "object" &&
    (payload as Record<string, unknown>)[key] !== null
  );
}

function readPath(payload: unknown, path: string[]): unknown {
  return path.reduce<unknown>((value, key) => {
    if (typeof value !== "object" || value === null) return undefined;
    return (value as Record<string, unknown>)[key];
  }, payload);
}
