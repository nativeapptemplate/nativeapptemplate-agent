import { test } from "node:test";
import assert from "node:assert/strict";
import { runLayer1, runLayer2, runLayer3, captureScreenshot } from "../src/validation/index.js";
import { dispatch } from "../src/dispatch.js";

test("validation layers are exported as functions", () => {
  assert.equal(typeof runLayer1, "function");
  assert.equal(typeof runLayer2, "function");
  assert.equal(typeof runLayer3, "function");
  assert.equal(typeof captureScreenshot, "function");
});

test("runLayer1 returns pass when forbiddenTokens is empty", async () => {
  const result = await runLayer1({ projectDir: "/tmp", forbiddenTokens: [] });
  assert.equal(result.pass, true);
  assert.deepEqual(result.findings, []);
});

test("runLayer2 returns a failed result for a non-Rails directory", async () => {
  const result = await runLayer2({ platform: "rails", outDir: "/tmp", timeoutMs: 10_000 });
  assert.equal(result.pass, false);
  assert.equal(typeof result.command, "string");
  assert.equal(typeof result.durationMs, "number");
});

test("runLayer2 iOS reports missing xcodeproj", async () => {
  const result = await runLayer2({ platform: "ios", outDir: "/tmp", timeoutMs: 10_000 });
  assert.equal(result.pass, false);
});

test("runLayer2 Android reports missing gradle wrapper", async () => {
  const result = await runLayer2({ platform: "android", outDir: "/tmp", timeoutMs: 10_000 });
  assert.equal(result.pass, false);
});

test("runLayer3 returns synthetic pass for empty rubric in stub mode", async () => {
  const result = await runLayer3({
    screenshotPath: "/tmp/x.png",
    rubric: [],
    spec: "",
  });
  assert.equal(result.pass, true);
  assert.deepEqual(result.scores, []);
});

test("runLayer3 returns one score per rubric criterion in stub mode", async () => {
  const result = await runLayer3({
    screenshotPath: "/tmp/x.png",
    rubric: [
      { id: "domain", question: "Does this look like a clinic queue?" },
      { id: "no-leak", question: "Is any 'Shop' / 'Shopkeeper' token visible?" },
    ],
    spec: "a walk-in clinic queue for small veterinary practices",
  });
  assert.equal(result.scores.length, 2);
  assert.equal(result.scores[0]?.criterionId, "domain");
  assert.equal(result.scores[1]?.criterionId, "no-leak");
  assert.equal(typeof result.pass, "boolean");
});

test("captureScreenshot returns a structured failure when no sim is booted", async () => {
  const result = await captureScreenshot({
    platform: "ios",
    outPath: "/tmp/nativeapptemplate-agent-test-no-such.png",
    timeoutMs: 5_000,
  });
  // Either no booted sim → ok=false with a meaningful error, or a sim is
  // actually booted in the dev environment → ok=true. Both are valid; we
  // only care that the result shape is well-formed.
  assert.equal(typeof result.ok, "boolean");
  assert.equal(typeof result.command, "string");
  assert.equal(typeof result.durationMs, "number");
  assert.ok(result.command.includes("xcrun simctl"));
  if (!result.ok) {
    assert.equal(typeof result.error, "string");
  }
});

test("dispatch runs planner + workers + reviewer + judge end-to-end (stub pipeline)", async () => {
  const result = await dispatch("a walk-in clinic queue for small veterinary practices");
  assert.equal(result.overallPass, true);
  assert.match(result.summary, /PASS/);
});
