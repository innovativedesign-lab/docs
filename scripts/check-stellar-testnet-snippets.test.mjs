/**
 * check-stellar-testnet-snippets.test.mjs
 *
 * Verifies the exit-status classification logic that the CI workflow relies on
 * to distinguish a content regression (exit 1, blocks merge) from a provider
 * outage (exit 2, non-blocking warning).
 *
 * The workflow step "Classify provider-check exit status" uses a shell `case`
 * statement that reads the captured exit status from GITHUB_OUTPUT.  These
 * tests replicate that logic in JS so it can be run with `node --test` without
 * requiring a live runner environment, providing the regression-test coverage
 * requested in https://github.com/wraith-protocol/docs/issues/187.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Mirror of the workflow's case-statement classification logic.
// ---------------------------------------------------------------------------

/**
 * Classifies a provider-step exit status the same way the CI workflow does.
 *
 * Returns:
 *   { action: "pass" }              – exit 0, nothing to do
 *   { action: "fail", reason }      – exit 1 or unexpected, job should fail
 *   { action: "warn", reason }      – exit 2, non-blocking warning
 *
 * @param {number | string} exitStatus
 */
function classifyProviderExit(exitStatus) {
  const code = Number(exitStatus);
  switch (code) {
    case 0:
      return { action: "pass" };
    case 1:
      return {
        action: "fail",
        reason: "Provider step detected a content regression (exit 1). Failing the job.",
      };
    case 2:
      return {
        action: "warn",
        reason: "Provider step reported a testnet outage (exit 2). Non-blocking.",
      };
    default:
      return {
        action: "fail",
        reason: `Provider step exited with unexpected status '${exitStatus}'. Failing the job.`,
      };
  }
}

// ---------------------------------------------------------------------------
// Classification unit tests
// ---------------------------------------------------------------------------

test("exit 0 → pass, job continues normally", () => {
  const result = classifyProviderExit(0);
  assert.equal(result.action, "pass");
});

test("exit 1 → fail, content regression blocks the job", () => {
  const result = classifyProviderExit(1);
  assert.equal(result.action, "fail");
  assert.match(result.reason, /content regression/);
});

test("exit 2 → warn, provider outage is non-blocking", () => {
  const result = classifyProviderExit(2);
  assert.equal(result.action, "warn");
  assert.match(result.reason, /outage/);
});

test("unexpected exit code → fail, not silently swallowed", () => {
  for (const code of [3, 127, 255, -1]) {
    const result = classifyProviderExit(code);
    assert.equal(result.action, "fail", `expected fail for exit code ${code}`);
    assert.match(result.reason, /unexpected status/);
  }
});

test("exit 1 and exit 2 produce different actions (core invariant)", () => {
  const regression = classifyProviderExit(1);
  const outage = classifyProviderExit(2);
  assert.notEqual(
    regression.action,
    outage.action,
    "exit 1 (content regression) and exit 2 (provider outage) must be classified differently",
  );
});

// ---------------------------------------------------------------------------
// Integration smoke test: the TypeScript script itself exits with the right
// codes when run in content mode against the real docs file.
// ---------------------------------------------------------------------------

test("MODE=content exits 0 when stellar.mdx has enough snippets", () => {
  const result = spawnSync(
    "pnpm",
    ["run", "check:stellar-testnet"],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, MODE: "content" },
      encoding: "utf8",
    },
  );
  assert.equal(
    result.status,
    0,
    `expected exit 0 in content mode, got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
});
