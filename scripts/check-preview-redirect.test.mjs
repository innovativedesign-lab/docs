/**
 * check-preview-redirect.test.mjs
 *
 * Unit tests for the preview-redirect validation logic in
 * scripts/check-preview-redirect.mjs.  Uses node:test with a lightweight
 * http server so no live Mintlify deployment is required.
 *
 * Run:
 *   node --test scripts/check-preview-redirect.test.mjs
 * or via the package.json script:
 *   pnpm run test:preview-redirect
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { validatePreviewRedirect } from "./check-preview-redirect.mjs";

// ---------------------------------------------------------------------------
// Pure-function unit tests (no network).
// ---------------------------------------------------------------------------

test("accepts a valid 301 redirect to /introduction", () => {
  const result = validatePreviewRedirect(
    "http://localhost/README",
    301,
    "/introduction",
    "/introduction",
  );
  assert.equal(result.ok, true);
  assert.match(result.message, /Verified/);
  assert.match(result.message, /301/);
  assert.match(result.message, /\/introduction/);
});

test("accepts a valid 302 redirect to /introduction", () => {
  const result = validatePreviewRedirect(
    "http://localhost/README",
    302,
    "/introduction",
    "/introduction",
  );
  assert.equal(result.ok, true);
});

test("rejects a 200 response (not a redirect)", () => {
  const result = validatePreviewRedirect(
    "http://localhost/README",
    200,
    null,
    "/introduction",
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /3xx redirect/);
  assert.match(result.message, /200/);
});

test("rejects a 404 response", () => {
  const result = validatePreviewRedirect(
    "http://localhost/README",
    404,
    null,
    "/introduction",
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /3xx redirect/);
});

test("rejects a 3xx redirect that has no Location header", () => {
  const result = validatePreviewRedirect(
    "http://localhost/README",
    301,
    null,
    "/introduction",
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /Location header/);
});

test("rejects a redirect to the wrong destination path", () => {
  const result = validatePreviewRedirect(
    "http://localhost/README",
    301,
    "/getting-started",
    "/introduction",
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /\/introduction/);
  assert.match(result.message, /\/getting-started/);
});

test("resolves an absolute Location URL correctly", () => {
  const result = validatePreviewRedirect(
    "http://localhost/README",
    301,
    "http://localhost/introduction",
    "/introduction",
  );
  assert.equal(result.ok, true);
});

test("rejects an absolute Location URL pointing to the wrong path", () => {
  const result = validatePreviewRedirect(
    "http://localhost/README",
    301,
    "http://localhost/wrong-page",
    "/introduction",
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /\/wrong-page/);
});

// ---------------------------------------------------------------------------
// Integration test: spins up a real HTTP server and exercises the full fetch
// path, using the same fixtures defined in
// scripts/fixtures/preview-redirect.json.
// ---------------------------------------------------------------------------

const FIXTURES_PATH = new URL("./fixtures/preview-redirect.json", import.meta.url);

/** @type {{ cases: Array<{ description: string, status: number, location: string|null, expectedPath: string, expectOk: boolean }> }} */
const { cases } = JSON.parse(
  await (await import("node:fs/promises")).readFile(FIXTURES_PATH, "utf8"),
);

for (const fixture of cases) {
  test(`HTTP fixture – ${fixture.description}`, async () => {
    // Create a one-shot server that responds according to the fixture.
    const server = http.createServer((_req, res) => {
      if (fixture.location !== null) {
        res.writeHead(fixture.status, { location: fixture.location });
      } else {
        res.writeHead(fixture.status);
      }
      res.end();
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const requestUrl = `http://127.0.0.1:${port}/README`;

    try {
      const response = await fetch(requestUrl, { redirect: "manual" });
      const location = response.headers.get("location");
      const result = validatePreviewRedirect(
        requestUrl,
        response.status,
        location,
        fixture.expectedPath,
      );
      assert.equal(
        result.ok,
        fixture.expectOk,
        `${fixture.description}: expected ok=${fixture.expectOk} but got ok=${result.ok}. Message: ${result.message}`,
      );
    } finally {
      await new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
}
