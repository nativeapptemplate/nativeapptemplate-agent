import { test } from "node:test";
import assert from "node:assert/strict";
import { runLayer1, runLayer2, runLayer3, captureScreenshot, installAndLaunch, runVisualJudge, DEFAULT_STAGE1_RUBRIC, discoverIosArtifact, discoverAndroidArtifact, runStage1Visual } from "../src/validation/index.js";
import { dispatch } from "../src/dispatch.js";
import { runReviewer } from "../src/agents/reviewer.js";

test("validation layers are exported as functions", () => {
  assert.equal(typeof runLayer1, "function");
  assert.equal(typeof runLayer2, "function");
  assert.equal(typeof runLayer3, "function");
  assert.equal(typeof captureScreenshot, "function");
  assert.equal(typeof installAndLaunch, "function");
  assert.equal(typeof runVisualJudge, "function");
  assert.equal(typeof discoverIosArtifact, "function");
  assert.equal(typeof discoverAndroidArtifact, "function");
  assert.equal(typeof runStage1Visual, "function");
});

test("runStage1Visual returns structured failure when artifacts not built", async () => {
  const result = await runStage1Visual({
    iosDir: "/nonexistent/ios",
    androidDir: "/nonexistent/android",
    spec: "test",
  });
  assert.equal(result.ios?.ok, false);
  assert.equal(result.android?.ok, false);
  assert.match(result.ios?.error ?? "", /not discovered/i);
  assert.match(result.android?.error ?? "", /not discovered/i);
});

test("runStage1Visual returns empty result when no platforms requested", async () => {
  const result = await runStage1Visual({ spec: "test" });
  assert.equal(result.ios, undefined);
  assert.equal(result.android, undefined);
});

test("discoverAndroidArtifact returns null for missing dir", async () => {
  const result = await discoverAndroidArtifact("/nonexistent/path/to/android");
  assert.equal(result, null);
});

test("discoverIosArtifact returns null for missing dir", async () => {
  const result = await discoverIosArtifact("/nonexistent/path/to/ios");
  assert.equal(result, null);
});

test("DEFAULT_STAGE1_RUBRIC has the expected criteria ids", () => {
  const ids = DEFAULT_STAGE1_RUBRIC.map((c) => c.id);
  assert.deepEqual(ids, ["domain-match", "no-substrate-leak", "renders-cleanly"]);
});

test("runVisualJudge short-circuits on launch failure (no sim booted)", async () => {
  const result = await runVisualJudge({
    platform: "ios",
    artifactPath: "/nonexistent/Foo.app",
    bundleId: "com.example.app",
    screenshotPath: "/tmp/foo.png",
    spec: "test",
    rubric: DEFAULT_STAGE1_RUBRIC,
  });
  // No sim → launch fails → result.ok=false, layer3 never runs.
  assert.equal(typeof result.ok, "boolean");
  assert.equal(typeof result.launch.ok, "boolean");
  assert.ok(result.launch.command.length > 0);
  if (!result.launch.ok) {
    assert.equal(result.ok, false);
    assert.equal(result.layer3, undefined);
    assert.equal(typeof result.error, "string");
  }
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

test("installAndLaunch returns a structured failure when no sim is booted (iOS)", async () => {
  const result = await installAndLaunch({
    platform: "ios",
    appPath: "/nonexistent/path/to/App.app",
    bundleId: "com.example.app",
    timeoutMs: 5_000,
  });
  // Either no sim booted / missing .app → ok=false, or somehow it succeeded
  // (unlikely with a nonexistent path). Either way the result shape must
  // be well-formed.
  assert.equal(typeof result.ok, "boolean");
  assert.equal(typeof result.command, "string");
  assert.equal(typeof result.durationMs, "number");
  assert.ok(result.command.includes("xcrun simctl install"));
  if (!result.ok) {
    assert.equal(typeof result.error, "string");
  }
});

test("runReviewer in stub mode passes without touching disk", async () => {
  const result = await runReviewer({
    domain: { slug: "x", displayName: "X", entities: [], renamePlan: [], jsonApiContract: {} },
    rails: { platform: "rails", outDir: "/nonexistent/rails", filesTouched: 0, renamedFrom: [] },
    ios: { platform: "ios", outDir: "/nonexistent/ios", filesTouched: 0, renamedFrom: [] },
    android: { platform: "android", outDir: "/nonexistent/android", filesTouched: 0, renamedFrom: [] },
  });
  assert.equal(result.contractParity, "pass");
  assert.deepEqual(result.diffs, []);
});

test("dispatch runs planner + workers + reviewer + judge end-to-end (stub pipeline)", async () => {
  const result = await dispatch("a walk-in clinic queue for small veterinary practices");
  assert.equal(result.overallPass, true);
  assert.match(result.summary, /PASS/);
});
