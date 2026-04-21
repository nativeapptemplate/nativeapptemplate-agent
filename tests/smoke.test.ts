import { test } from "node:test";
import assert from "node:assert/strict";
import { runLayer1, runLayer2, runLayer3 } from "../src/validation/index.js";
import { dispatch } from "../src/dispatch.js";

test("validation layers are exported as functions", () => {
  assert.equal(typeof runLayer1, "function");
  assert.equal(typeof runLayer2, "function");
  assert.equal(typeof runLayer3, "function");
});

test("runLayer1 rejects until implemented", async () => {
  await assert.rejects(
    runLayer1({ projectDir: "/tmp", forbiddenTokens: [] }),
    /not implemented/i,
  );
});

test("runLayer2 returns a failed result for a non-Rails directory", async () => {
  const result = await runLayer2({ railsDir: "/tmp", timeoutMs: 10_000 });
  assert.equal(result.pass, false);
  assert.equal(typeof result.command, "string");
  assert.equal(typeof result.durationMs, "number");
});

test("runLayer3 rejects until implemented", async () => {
  await assert.rejects(
    runLayer3({
      screenshotPath: "/tmp/x.png",
      rubric: [],
      spec: "",
    }),
    /not implemented/i,
  );
});

test("dispatch runs planner + workers + reviewer + judge end-to-end (stub pipeline)", async () => {
  const result = await dispatch("a walk-in clinic queue for small veterinary practices");
  assert.equal(result.overallPass, true);
  assert.match(result.summary, /PASS/);
});
