import { test } from "node:test";
import assert from "node:assert/strict";
import { runLayer1, runLayer2, runLayer3, captureScreenshot, installAndLaunch, runVisualJudge, DEFAULT_STAGE1_RUBRIC, discoverIosArtifact, discoverAndroidArtifact, runStage1Visual, waitForStableCapture, judgeWithRetry, isTransientRenderFail } from "../src/validation/index.js";
import { dispatch } from "../src/dispatch.js";
import { runReviewer } from "../src/agents/reviewer.js";
import { canonicalizeEndpoint, diffContracts } from "../src/agents/contract-extract.js";
import { renderReport } from "../src/report/render.js";
import { buildRunReport, writeReport, collectScreenshotPaths } from "../src/report/collect.js";
import type { DomainSpec, JudgeResult, ReviewerResult, Platform, PlatformDetail } from "../src/agents/types.js";
import { runRepairLoop, REPAIR_ITERATION_CAP, type RepairLoopDeps, type RevalidateResult } from "../src/repair-loop.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";

// Stage 2 device overrides exported in the developer's shell would steer
// selectDevice away from the fake mobile-mcp devices; tests that need an
// override set it themselves.
delete process.env['NATIVEAPPTEMPLATE_MOBILE_IOS_DEVICE'];
delete process.env['NATIVEAPPTEMPLATE_MOBILE_ANDROID_DEVICE'];

// rename.rb is a Ruby subprocess; CI runs the suite in stub mode with no
// Ruby step, so guard the one test that shells out to it.
const RUBY_AVAILABLE = (() => {
  try { return spawnSync("ruby", ["-v"]).status === 0; } catch { return false; }
})();

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

test("both leak checks tell the judge to ignore the OS status bar", async () => {
  // A real run (2026-10-15) failed no-substrate-leak on the iOS status bar's
  // "◀ Native App Templ…" back link, drawn by the OS because the substrate was
  // the previously open app on the shared simulator. The app itself was clean.
  const { DEFAULT_STAGE2_RUBRIC } = await import("../src/validation/stage2-judge.js");
  for (const rubric of [DEFAULT_STAGE1_RUBRIC, DEFAULT_STAGE2_RUBRIC]) {
    const leak = rubric.find((c) => c.id === "no-substrate-leak");
    assert.ok(leak, "rubric has no-substrate-leak");
    assert.match(leak.question, /status bar/);
    assert.match(leak.question, /link back to a previously open app/);
  }
});

test("DEFAULT_STAGE1_RUBRIC has the expected criteria ids", () => {
  const ids = DEFAULT_STAGE1_RUBRIC.map((c) => c.id);
  assert.deepEqual(ids, ["no-substrate-leak", "renders-cleanly"]);
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

test("waitForStableCapture settles once two consecutive frames match (waits through a transition)", async () => {
  const frames = [Buffer.from("frame-A"), Buffer.from("frame-B"), Buffer.from("frame-B")];
  let i = 0;
  const res = await waitForStableCapture(
    {
      captureOnce: async () => ({ ok: true, bytes: frames[Math.min(i++, frames.length - 1)]! }),
      sleep: async () => {},
      now: () => 0,
    },
    { intervalMs: 1, maxWaitMs: 10_000 },
  );
  assert.deepEqual(res, { ok: true, settled: true });
  assert.equal(i, 3); // A → B (transition) → B (settled)
});

test("waitForStableCapture caps out on a never-settling screen, and surfaces capture failure", async () => {
  // Never-settling: every frame differs; clock advances past the deadline.
  let n = 0, t = 0;
  const capped = await waitForStableCapture(
    {
      captureOnce: async () => ({ ok: true, bytes: Buffer.from("f" + n++) }),
      sleep: async () => {},
      now: () => { const v = t; t += 600; return v; },
    },
    { intervalMs: 1, maxWaitMs: 1_000 },
  );
  assert.deepEqual(capped, { ok: true, settled: false }); // accepted last frame

  // Capture failure short-circuits.
  const failed = await waitForStableCapture(
    { captureOnce: async () => ({ ok: false, error: "no sim booted" }), sleep: async () => {}, now: () => 0 },
    { intervalMs: 1, maxWaitMs: 1_000 },
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "no sim booted");
});

test("isTransientRenderFail: true only when all failing criteria are retry-safe", () => {
  const score = (id: string, pass: boolean) => ({ criterionId: id, pass, rationale: "" });
  // pass → never retry
  assert.equal(isTransientRenderFail({ pass: true, scores: [score("renders-cleanly", true)] }), false);
  // only renders-cleanly failing → retry
  assert.equal(isTransientRenderFail({ pass: false, scores: [score("no-substrate-leak", true), score("renders-cleanly", false)] }), true);
  // a content criterion failing → do NOT retry (deterministic)
  assert.equal(isTransientRenderFail({ pass: false, scores: [score("no-substrate-leak", false), score("renders-cleanly", true)] }), false);
  // both failing → not retry-safe (content failure present)
  assert.equal(isTransientRenderFail({ pass: false, scores: [score("no-substrate-leak", false), score("renders-cleanly", false)] }), false);
});

test("judgeWithRetry retries a transient render fail, but not a content fail, and caps retries", async () => {
  const score = (id: string, pass: boolean) => ({ criterionId: id, pass, rationale: "" });
  const renderFail = { pass: false, scores: [score("no-substrate-leak", true), score("renders-cleanly", false)] };
  const contentFail = { pass: false, scores: [score("no-substrate-leak", false), score("renders-cleanly", true)] };
  const ok = { pass: true, scores: [score("no-substrate-leak", true), score("renders-cleanly", true)] };

  // transient fail then pass → 1 retry, returns the pass; recover runs before
  // the retry's re-capture (e.g. tap "Back to Start Screen").
  let judged = 0, settled = 0, recovered = 0;
  const seq = [renderFail, ok];
  const r1 = await judgeWithRetry(
    {
      settleCapture: async () => { settled++; return { ok: true }; },
      judge: async () => seq[judged++]!,
      recover: async () => { recovered++; },
    },
    { maxRetries: 1 },
  );
  assert.equal(r1.ok, true); assert.equal(r1.layer3?.pass, true);
  assert.equal(judged, 2); assert.equal(settled, 2);
  assert.equal(recovered, 1); // recover fired once, before the single retry

  // content fail → no retry
  let j2 = 0;
  const r2 = await judgeWithRetry(
    { settleCapture: async () => ({ ok: true }), judge: async () => { j2++; return contentFail; } },
    { maxRetries: 3 },
  );
  assert.equal(r2.layer3?.pass, false); assert.equal(j2, 1);

  // persistent transient fail → exhausts maxRetries (initial + 2)
  let j3 = 0;
  const r3 = await judgeWithRetry(
    { settleCapture: async () => ({ ok: true }), judge: async () => { j3++; return renderFail; } },
    { maxRetries: 2 },
  );
  assert.equal(r3.layer3?.pass, false); assert.equal(j3, 3);

  // initial capture failure → ok:false, no judging
  let j4 = 0;
  const r4 = await judgeWithRetry(
    { settleCapture: async () => ({ ok: false, error: "no sim" }), judge: async () => { j4++; return ok; } },
    { maxRetries: 2 },
  );
  assert.equal(r4.ok, false); assert.equal(r4.error, "no sim"); assert.equal(j4, 0);
});

test("recoverFromErrorScreen taps Back to Start Screen when present, no-ops otherwise", async () => {
  const { recoverFromErrorScreen } = await import("../src/validation/stage2.js");
  type Client = Parameters<typeof recoverFromErrorScreen>[0];
  const clicks: { x: number; y: number }[] = [];
  const make = (elements: unknown[]): Client =>
    ({ listElements: async () => elements, click: async (x: number, y: number) => { clicks.push({ x, y }); } } as unknown as Client);

  // error screen present → taps the button's center (x+w/2, y+h/2)
  assert.equal(
    await recoverFromErrorScreen(make([{ label: "Back to Start Screen", coordinates: { x: 10, y: 20, width: 100, height: 40 } }])),
    true,
  );
  assert.deepEqual(clicks, [{ x: 60, y: 40 }]);

  // no error screen → false, no tap
  clicks.length = 0;
  assert.equal(await recoverFromErrorScreen(make([{ label: "Welcome to Sentova" }])), false);
  assert.equal(clicks.length, 0);
});

test("runLayer1 returns pass when forbiddenTokens is empty", async () => {
  const result = await runLayer1({ projectDir: "/tmp", forbiddenTokens: [] });
  assert.equal(result.pass, true);
  assert.deepEqual(result.findings, []);
});

test("runLayer1 skips compiled build output so un-renamed bundle tokens aren't flagged", async () => {
  // Mirrors rename.rb's SKIP_SUBPATHS (#84): the build bundle is intentionally
  // left un-renamed (Turbo's visitCompleted), so Layer 1 must not flag it.
  const root = mkdtempSync(join(tmpdir(), "layer1-skip-"));
  mkdirSync(join(root, "app", "assets", "builds"), { recursive: true });
  mkdirSync(join(root, "public", "assets"), { recursive: true });
  mkdirSync(join(root, "app", "models"), { recursive: true });
  writeFileSync(join(root, "app", "assets", "builds", "application.js"), "this.state = VisitState.completed; // visitCompleted");
  writeFileSync(join(root, "public", "assets", "app-abc123.js"), "VisitState.visitCompleted");
  // A genuine leftover in real source MUST still be flagged.
  writeFileSync(join(root, "app", "models", "item.rb"), "# Completed state stays here\n");

  const result = await runLayer1({ projectDir: root, forbiddenTokens: ["Completed"] });
  assert.equal(result.findings.length, 1, "only the real-source leftover is flagged, not the build bundles");
  assert.match(result.findings[0]?.file ?? "", /app\/models\/item\.rb/);
  assert.equal(result.pass, false);
});

test("runLayer1 doesn't flag tokens inside links to the template's repos or the agent's name (#155)", async () => {
  const root = mkdtempSync(join(tmpdir(), "layer1-protected-"));
  writeFileSync(join(root, "README.md"), [
    "https://github.com/nativeapptemplate/NativeAppTemplate-iOS/blob/main/NativeAppTemplate/ShopView.swift",
    "git@github.com:nativeapptemplate/NativeAppTemplate-Android.git",
    "nativeapptemplate-agent and nativeapptemplate-agent-mcp",
    "NativeAppTemplate is a leftover, and so is support@nativeapptemplate.com",
    "github.com/nativeapptemplatefoo/NativeAppTemplate is another org",
  ].join("\n"));
  const result = await runLayer1({ projectDir: root, forbiddenTokens: ["NativeAppTemplate", "nativeapptemplate", "Shop"] });
  // Only lines 4 and 5 hold leftovers: the bare product name and the email on line 4,
  // and both tokens of the look-alike org on line 5 (not protected: different org).
  assert.deepEqual(
    result.findings.map((f) => [f.line, f.token]),
    [[4, "NativeAppTemplate"], [4, "nativeapptemplate"], [5, "nativeapptemplate"], [5, "NativeAppTemplate"]],
  );
  assert.equal(result.pass, false);
});

test("runLayer1 scans .kamal/secrets, which has no extension", async () => {
  // Kamal's secrets file is extensionless. config/deploy.yml (a .yml) names the
  // secret keys it reads from there, so a leftover substrate token in
  // .kamal/secrets means the two files disagree and `kamal setup` fails on
  // the renamed key. Mirrors rename.rb's TEXT_BASENAMES.
  const root = mkdtempSync(join(tmpdir(), "layer1-secrets-"));
  mkdirSync(join(root, ".kamal"), { recursive: true });
  writeFileSync(join(root, ".kamal", "secrets"), "NATIVEAPPTEMPLATEAPI_ORIGIN_CERT=$(cat $HOME/.config/nativeapptemplateapi/origin-cert.pem)\n");

  const result = await runLayer1({ projectDir: root, forbiddenTokens: ["Nativeapptemplateapi", "NATIVEAPPTEMPLATEAPI", "nativeapptemplateapi"] });
  assert.equal(result.pass, false);
  assert.deepEqual(result.findings.map((f) => f.file), [".kamal/secrets", ".kamal/secrets"]);
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

test("firstThenTogether finishes the first call before starting the rest, then runs the rest at once", async () => {
  // The judge's first sample writes the screenshot's prompt cache; samples sent
  // at the same time would each write it again instead of reading it.
  const { firstThenTogether } = await import("../src/validation/layer3.js");
  const events: string[] = [];
  let inFlight = 0;
  let maxInFlightAfterFirst = 0;
  const results = await firstThenTogether([1, 2, 3, 4], async (n) => {
    events.push(`start ${n}`);
    inFlight++;
    if (n !== 1) maxInFlightAfterFirst = Math.max(maxInFlightAfterFirst, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    events.push(`end ${n}`);
    return n * 10;
  });
  assert.deepEqual(results, [10, 20, 30, 40]);
  assert.deepEqual(events.slice(0, 2), ["start 1", "end 1"]);
  assert.equal(maxInFlightAfterFirst, 3);
  assert.deepEqual(await firstThenTogether([], async (n: number) => n), []);
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
  // Clean-install: a best-effort uninstall runs before install so stale
  // per-run app/Keychain state can't error the app on launch.
  assert.ok(result.command.includes("xcrun simctl uninstall booted com.example.app"));
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

test("canonicalizeEndpoint reduces all three platform encodings to the same string", async () => {
  const ctx = { role: "vet" };
  // Rails OpenAPI: server is /api/v1/vet, path is just /clinics
  const rails = canonicalizeEndpoint({ method: "GET", path: "/clinics" }, ctx);
  // iOS Request struct: "/vet/shops/\(id)" (literal Swift interpolation in extracted string)
  const ios = canonicalizeEndpoint({ method: "GET", path: "/vet/clinics/\\(id)" }, ctx);
  // Android Retrofit: literal full path
  const android = canonicalizeEndpoint(
    { method: "GET", path: "{account_id}/api/v1/vet/clinics/{id}" },
    ctx,
  );
  assert.equal(rails.path, "/clinics");
  assert.equal(ios.path, "/clinics/{*}");
  assert.equal(android.path, "/clinics/{*}");
});

test("diffContracts surfaces ios orphan when client calls endpoint not in rails", async () => {
  const ctx = { role: "vet" };
  const rails = [{ method: "GET" as const, path: "/clinics" }];
  const ios = [
    { method: "GET" as const, path: "/vet/clinics" },
    { method: "DELETE" as const, path: "/vet/clinics/\\(id)/reset" },
  ];
  const android = [{ method: "GET" as const, path: "{account_id}/api/v1/vet/clinics" }];
  const diff = diffContracts(rails, ios, android, ctx);
  assert.equal(diff.iosOrphan.length, 1);
  assert.equal(diff.iosOrphan[0]?.method, "DELETE");
  assert.equal(diff.iosOrphan[0]?.path, "/clinics/{*}/reset");
  assert.equal(diff.iosOnly.length, 0);
  assert.equal(diff.androidOnly.length, 0);
});

test("dispatch runs planner + workers + reviewer + judge end-to-end (stub pipeline)", async () => {
  const result = await dispatch("a walk-in clinic queue for small veterinary practices");
  assert.equal(result.overallPass, true);
  assert.match(result.summary, /PASS/);
});

test("createMobileClient in stub mode short-circuits without spawning", async () => {
  const { createMobileClient, isStubMobile } = await import("../src/mobile.js");
  assert.equal(isStubMobile(), true);
  const mobile = await createMobileClient();
  assert.deepEqual(await mobile.listDevices(), []);
  assert.deepEqual(await mobile.listElements(), []);
  await mobile.click(10, 20);
  await mobile.typeKeys("hello");
  await mobile.pressButton("HOME");
  const shot = await mobile.takeScreenshot();
  assert.equal(shot.mimeType, "image/png");
  assert.equal(shot.data.length, 0);
  await mobile.saveScreenshot("/tmp/ignored.png");
  await mobile.close();
});

test("attachMobileClient drives a fake mobile-mcp server end-to-end", async () => {
  const { attachMobileClient } = await import("../src/mobile.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { z } = await import("zod");

  const fake = new McpServer({ name: "fake-mobile-mcp", version: "0.0.0" });
  const calls: { name: string; args: unknown }[] = [];

  fake.registerTool(
    "mobile_list_available_devices",
    { description: "fake", inputSchema: {} },
    async () => ({
      content: [{ type: "text", text: JSON.stringify([{ name: "iPhone 17", platform: "ios" }]) }],
    }),
  );
  fake.registerTool(
    "mobile_list_elements_on_screen",
    { description: "fake", inputSchema: {} },
    async () => ({
      content: [{ type: "text", text: JSON.stringify([{ label: "Sign Up", x: 100, y: 200 }]) }],
    }),
  );
  fake.registerTool(
    "mobile_click_on_screen_at_coordinates",
    { description: "fake", inputSchema: { x: z.number(), y: z.number() } },
    async (args) => {
      calls.push({ name: "click", args });
      return { content: [] };
    },
  );
  fake.registerTool(
    "mobile_type_keys",
    { description: "fake", inputSchema: { text: z.string() } },
    async (args) => {
      calls.push({ name: "type", args });
      return { content: [] };
    },
  );
  fake.registerTool(
    "mobile_take_screenshot",
    { description: "fake", inputSchema: {} },
    async () => ({
      content: [{ type: "image", data: Buffer.from("PNGDATA").toString("base64"), mimeType: "image/png" }],
    }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([fake.connect(serverTransport), client.connect(clientTransport)]);
  const mobile = attachMobileClient(client);

  // NB: stub mode is on (NATIVEAPPTEMPLATE_STUB_ALL=1) so a separate
  // createMobileClient() call would short-circuit. attachMobileClient skips
  // that gate by accepting an already-connected Client, which is the seam
  // we want to exercise.
  const devices = await mobile.listDevices();
  assert.equal(devices.length, 1);
  assert.equal((devices[0] as { name: string }).name, "iPhone 17");

  const elements = await mobile.listElements();
  assert.equal(elements.length, 1);
  assert.equal((elements[0] as { label: string }).label, "Sign Up");

  await mobile.click(100, 200);
  await mobile.typeKeys("hello@example.com");

  const shot = await mobile.takeScreenshot();
  assert.equal(shot.mimeType, "image/png");
  assert.equal(shot.data.toString("utf8"), "PNGDATA");

  assert.deepEqual(calls, [
    { name: "click", args: { x: 100, y: 200 } },
    { name: "type", args: { text: "hello@example.com" } },
  ]);

  await mobile.close();
  await fake.close();
});

test("buildQueueScenario opens with verified welcome → start → auth choice → sign-up form flow", async () => {
  const { buildQueueScenario } = await import("../src/validation/scenarios/queue.js");
  const scenario = buildQueueScenario(
    {
      slug: "vet-clinic",
      displayName: "Vet Clinic",
      entities: [],
      renamePlan: [
        { from: "Shop", to: "Clinic" },
        { from: "Shopkeeper", to: "Vet" },
      ],
      jsonApiContract: {},
    },
    { fullName: "Test User", email: "x@y.z", password: "p", primaryResourceName: "Acme", railsOutDir: "/tmp/test-rails" },
  );
  assert.equal(scenario.name, "queue-crud-vet-clinic");

  // The opening sequence is verified against the live iOS sim — assert
  // it in order so we catch any regression that drops the welcome step.
  const opening = scenario.steps.slice(0, 6);
  assert.deepEqual(opening, [
    { kind: "wait_for_text", text: "Welcome to" },
    { kind: "screenshot", label: "01-welcome" },
    { kind: "tap_text", text: "Start" },
    { kind: "wait_for_text", text: "Sign Up for an Account" },
    { kind: "screenshot", label: "02-auth-choice" },
    { kind: "tap_text", text: "Sign Up for an Account" },
  ]);

  // All four user-supplied inputs reach the type steps.
  assert.ok(scenario.steps.some((s) => s.kind === "type" && s.text === "Test User"));
  assert.ok(scenario.steps.some((s) => s.kind === "type" && s.text === "x@y.z"));
  assert.ok(scenario.steps.some((s) => s.kind === "type" && s.text === "p"));

  // Drills into the auto-seeded "Sample <Primary>" rather than
  // creating a new resource (the substrate's
  // Account#create_default_clinic! seeds one on every signup).
  assert.ok(
    scenario.steps.some((s) => s.kind === "wait_for_text" && s.text === "Sample"),
    "expected a wait_for_text 'Sample' step",
  );
  assert.ok(
    scenario.steps.some((s) => s.kind === "tap_text" && s.text === "Sample"),
    "expected a tap_text 'Sample' step",
  );

  // Scenario tails with the queue-entry-list screenshot (not the
  // toggle-state assertion — Add/Toggle/Delete are deferred since
  // they require mapping icon-only affordances). The screenshot at
  // the tail is what Layer 3 judges.
  const tail = scenario.steps[scenario.steps.length - 1];
  assert.deepEqual(tail, { kind: "screenshot", label: "06-queue-entry-list" });
});

test("buildQueueScenario dismisses iOS system dialogs (Keychain + notification) before the gated steps", async () => {
  const { buildQueueScenario } = await import("../src/validation/scenarios/queue.js");
  const scenario = buildQueueScenario(
    { slug: "vet-clinic", displayName: "Vet Clinic", entities: [], renamePlan: [{ from: "Shop", to: "Clinic" }, { from: "Shopkeeper", to: "Vet" }], jsonApiContract: {} },
    { fullName: "T", email: "x@y.z", password: "p", primaryResourceName: "Acme", railsOutDir: "/tmp/r" },
    "ios",
  );
  const idx = (pred: (s: { kind: string; text?: string }) => boolean) => scenario.steps.findIndex(pred as never);

  // Keychain "Save password?" dismiss must exist BEFORE the Sign-In tap
  // (the dialog can surface late and cover the auth screen).
  const keychainBeforeSignIn = idx((s) => s.kind === "tap_text" && s.text === "今はしない");
  const signInTap = idx((s) => s.kind === "tap_text" && s.text === "Sign In to Your Account");
  assert.ok(keychainBeforeSignIn !== -1 && signInTap !== -1, "keychain dismiss + sign-in tap present");
  assert.ok(keychainBeforeSignIn < signInTap, "keychain dismiss precedes the Sign-In tap");

  // Notification-permission dismiss (paid-only, optional) must precede the
  // "Sample" wait, which a system alert would otherwise hide.
  const notifDismiss = idx((s) => s.kind === "tap_text" && s.text === "許可");
  const sampleWait = idx((s) => s.kind === "wait_for_text" && s.text === "Sample");
  assert.ok(notifDismiss !== -1 && sampleWait !== -1, "notification dismiss + Sample wait present");
  assert.ok(notifDismiss < sampleWait, "notification dismiss precedes the Sample wait");
});

test("buildQueueScenario never submits a typed password on Android (mobile-mcp types a literal newline)", async () => {
  const { buildQueueScenario } = await import("../src/validation/scenarios/queue.js");
  const build = (platform: "ios" | "android") =>
    buildQueueScenario(
      { slug: "vet-clinic", displayName: "Vet Clinic", entities: [], renamePlan: [{ from: "Shop", to: "Clinic" }, { from: "Shopkeeper", to: "Vet" }], jsonApiContract: {} },
      { fullName: "T", email: "x@y.z", password: "p", primaryResourceName: "Acme", railsOutDir: "/tmp/r" },
      platform,
    );
  const passwordTypes = (platform: "ios" | "android") =>
    build(platform).steps.filter((s) => s.kind === "type" && s.text === "p") as { submit?: boolean }[];

  // Sign Up + Sign In each type the password once.
  assert.equal(passwordTypes("android").length, 2);
  // Observed 2026-10-17: Sign Up typed "p\n", so the account's password had a
  // trailing newline and the later Sign In got 401.
  assert.ok(passwordTypes("android").every((s) => !s.submit), "no Android password step submits");
  // iOS still submits at Sign Up to dismiss the keyboard over the Sign Up button.
  assert.equal(passwordTypes("ios")[0]?.submit, true);
});

test("runStage2Scenario walks a simple step list against a fake mobile-mcp", async () => {
  const { tmpdir } = await import("node:os");
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { attachMobileClient } = await import("../src/mobile.js");
  const { runStage2Scenario } = await import("../src/validation/stage2.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { z } = await import("zod");

  // Fake mobile-mcp serving a tiny screen with a "Sign Up" button at
  // (100, 200) rect 80x40 → expected center (140, 220).
  const fake = new McpServer({ name: "fake-mobile-mcp", version: "0.0.0" });
  const calls: { name: string; args: unknown }[] = [];

  fake.registerTool(
    "mobile_list_elements_on_screen",
    { description: "fake", inputSchema: {} },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { label: "Sign Up", x: 100, y: 200, width: 80, height: 40 },
            { label: "Welcome", x: 0, y: 0, width: 400, height: 60 },
          ]),
        },
      ],
    }),
  );
  fake.registerTool(
    "mobile_click_on_screen_at_coordinates",
    { description: "fake", inputSchema: { x: z.number(), y: z.number() } },
    async (args) => {
      calls.push({ name: "click", args });
      return { content: [] };
    },
  );
  fake.registerTool(
    "mobile_type_keys",
    { description: "fake", inputSchema: { text: z.string() } },
    async (args) => {
      calls.push({ name: "type", args });
      return { content: [] };
    },
  );
  fake.registerTool(
    "mobile_save_screenshot",
    { description: "fake", inputSchema: { saveTo: z.string() } },
    async (args) => {
      calls.push({ name: "saveScreenshot", args });
      return { content: [] };
    },
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([fake.connect(serverTransport), client.connect(clientTransport)]);
  const mobile = attachMobileClient(client);

  const screenshotDir = mkdtempSync(join(tmpdir(), "stage2-test-"));

  const result = await runStage2Scenario({
    client: mobile,
    scenario: {
      name: "smoke",
      steps: [
        { kind: "wait_for_text", text: "Welcome" },
        { kind: "tap_text", text: "Sign Up" },
        { kind: "type", text: "user@example.com" },
        { kind: "screenshot", label: "after-tap" },
        { kind: "assert_text", text: "Sign Up" },
      ],
    },
    screenshotDir,
    pollIntervalMs: 10,
    defaultWaitMs: 500,
  });

  assert.equal(result.ok, true);
  assert.equal(result.steps.length, 5);
  assert.ok(result.steps.every((s) => s.ok));
  // Click landed on the Sign-Up element's center.
  const click = calls.find((c) => c.name === "click");
  assert.deepEqual(click?.args, { x: 140, y: 220 });
  // Type text propagated.
  assert.deepEqual(calls.find((c) => c.name === "type")?.args, { text: "user@example.com" });
  // Screenshot saved with a slugged filename.
  const saved = calls.find((c) => c.name === "saveScreenshot");
  assert.ok((saved?.args as { saveTo: string }).saveTo.endsWith("smoke-03-after-tap.png"));
  assert.equal(result.screenshots.length, 1);

  await mobile.close();
  await fake.close();
});

test("runStage2Scenario short-circuits on missing element and surfaces a meaningful error", async () => {
  const { tmpdir } = await import("node:os");
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { attachMobileClient } = await import("../src/mobile.js");
  const { runStage2Scenario } = await import("../src/validation/stage2.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

  const fake = new McpServer({ name: "fake-mobile-mcp", version: "0.0.0" });
  fake.registerTool(
    "mobile_list_elements_on_screen",
    { description: "fake", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "[]" }] }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([fake.connect(serverTransport), client.connect(clientTransport)]);
  const mobile = attachMobileClient(client);

  const result = await runStage2Scenario({
    client: mobile,
    scenario: {
      name: "missing",
      steps: [
        { kind: "wait_for_text", text: "Sign Up", timeoutMs: 200 },
        { kind: "type", text: "should not run" },
      ],
    },
    screenshotDir: mkdtempSync(join(tmpdir(), "stage2-fail-")),
    pollIntervalMs: 10,
  });

  assert.equal(result.ok, false);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]?.ok, false);
  assert.match(result.steps[0]?.error ?? "", /not found within 200ms/);

  await mobile.close();
  await fake.close();
});

test("runStage2Visual walks scenario + Layer 3 against a fake mobile-mcp", async () => {
  const { tmpdir } = await import("node:os");
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { attachMobileClient } = await import("../src/mobile.js");
  const { runStage2Visual, DEFAULT_STAGE2_RUBRIC } = await import("../src/validation/stage2-judge.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { z } = await import("zod");

  // Fake mobile-mcp serving an "Idled" badge that satisfies the
  // scenario's tail wait_for_text + assert_text. We only stub the
  // primitives the truncated scenario below actually calls — plus
  // list_available_devices for the selectDevice bootstrap.
  const fake = new McpServer({ name: "fake-mobile-mcp", version: "0.0.0" });
  fake.registerTool(
    "mobile_list_available_devices",
    { description: "fake", inputSchema: {} },
    async () => ({
      content: [{ type: "text", text: JSON.stringify([{ name: "iPhone 17", platform: "ios" }]) }],
    }),
  );
  fake.registerTool(
    "mobile_list_elements_on_screen",
    { description: "fake", inputSchema: {} },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { label: "Idled", x: 200, y: 400, width: 80, height: 24 },
          ]),
        },
      ],
    }),
  );
  fake.registerTool(
    "mobile_save_screenshot",
    { description: "fake", inputSchema: { saveTo: z.string() } },
    async () => ({ content: [] }),
  );
  // #4: Stage 2 foregrounds the app before walking — record the launch call.
  let launchedWith: { packageName?: unknown } | null = null;
  fake.registerTool(
    "mobile_launch_app",
    { description: "fake", inputSchema: { device: z.string(), packageName: z.string() } },
    async (args) => { launchedWith = args; return { content: [] }; },
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([fake.connect(serverTransport), client.connect(clientTransport)]);
  const mobile = attachMobileClient(client);

  const screenshotDir = mkdtempSync(join(tmpdir(), "stage2-judge-"));

  const result = await runStage2Visual({
    spec: "a vet clinic queue",
    iosScenario: {
      name: "smoke",
      steps: [
        // Truncated walk: just enough to get a screenshot + an assert
        // hit, so we exercise the runner -> Layer 3 wiring without
        // pretending to mock a real auth flow.
        { kind: "wait_for_text", text: "Idled", timeoutMs: 500 },
        { kind: "screenshot", label: "post-toggle" },
        { kind: "assert_text", text: "Idled" },
      ],
    },
    rubric: DEFAULT_STAGE2_RUBRIC,
    screenshotDir,
    iosAppId: "com.example.app",
    iosClient: mobile,
  });

  // STUB_ALL is on (NATIVEAPPTEMPLATE_STUB_ALL=1) so isStub("judge")
  // routes Layer 3 through its stub path and every criterion passes.
  // We're verifying wiring + structural output here, not vision quality.
  assert.equal(result.ios?.pass, true);
  assert.equal(result.ios?.scenarioName, "smoke");
  assert.equal(result.ios?.stepCount, 3);
  assert.equal(result.ios?.stepsPassed, 3);
  assert.equal(result.ios?.screenshots.length, 1);
  assert.ok(result.ios?.representativeScreenshot?.endsWith("smoke-01-post-toggle.png"));
  assert.equal(result.ios?.layer3Scores?.length, DEFAULT_STAGE2_RUBRIC.length);
  // #4: the app was foregrounded (launched) before the walk, with the app id.
  assert.equal((launchedWith as { packageName?: unknown } | null)?.packageName, "com.example.app");

  await mobile.close();
  await fake.close();
});

test("runStage2Visual relaunches the app when the first launch leaves the iOS springboard up", async () => {
  const { tmpdir } = await import("node:os");
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { attachMobileClient } = await import("../src/mobile.js");
  const { runStage2Visual, DEFAULT_STAGE2_RUBRIC } = await import("../src/validation/stage2-judge.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { z } = await import("zod");

  // The app only comes to front on the second launch; until then the screen
  // is the springboard (app icons, type "Icon"), as observed 2026-10-17.
  let launches = 0;
  const fake = new McpServer({ name: "fake-mobile-mcp", version: "0.0.0" });
  fake.registerTool(
    "mobile_list_available_devices",
    { description: "fake", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: JSON.stringify([{ name: "iPhone 17", platform: "ios" }]) }] }),
  );
  fake.registerTool(
    "mobile_list_elements_on_screen",
    { description: "fake", inputSchema: {} },
    async () => ({
      content: [{
        type: "text",
        text: JSON.stringify(
          launches >= 2
            ? [{ label: "Welcome to Vet Clinic", x: 60, y: 650, width: 280, height: 100 }]
            : [{ type: "Icon", label: "Vet Clinic", x: 200, y: 290, width: 99, height: 90 }],
        ),
      }],
    }),
  );
  fake.registerTool(
    "mobile_save_screenshot",
    { description: "fake", inputSchema: { saveTo: z.string() } },
    async () => ({ content: [] }),
  );
  const launchLocales: (string | undefined)[] = [];
  fake.registerTool(
    "mobile_launch_app",
    { description: "fake", inputSchema: { device: z.string(), packageName: z.string(), locale: z.string().optional() } },
    async ({ locale }) => { launches++; launchLocales.push(locale); return { content: [] }; },
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([fake.connect(serverTransport), client.connect(clientTransport)]);
  const mobile = attachMobileClient(client);

  const result = await runStage2Visual({
    spec: "a vet clinic queue",
    iosScenario: {
      name: "smoke",
      steps: [
        { kind: "wait_for_text", text: "Welcome to", timeoutMs: 500 },
        { kind: "screenshot", label: "01-welcome" },
      ],
    },
    rubric: DEFAULT_STAGE2_RUBRIC,
    screenshotDir: mkdtempSync(join(tmpdir(), "stage2-relaunch-")),
    iosAppId: "com.example.app",
    iosClient: mobile,
  });

  assert.equal(launches, 2);
  assert.equal(result.ios?.stepsPassed, 2, result.ios?.error);
  // #159: the first launch and the springboard relaunch both ask for English.
  assert.deepEqual(launchLocales, ["en-US", "en-US"]);

  await mobile.close();
  await fake.close();
});

// #159: the app under test is launched in English whatever the device
// language. Expected commands from the issue: iOS `simctl launch <udid>
// <bundle> -AppleLanguages "(en)" -AppleLocale en_US` (Apple's documented
// launch-argument overrides of the NSGlobalDomain keys); Android `cmd locale
// set-app-locales <pkg> --locales en-US` (Android 13 per-app language).
function recordingExec(fail: (args: readonly string[]) => string | undefined = () => undefined) {
  const calls: { cmd: string; args: readonly string[] }[] = [];
  const exec = {
    run: async (cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args });
      const err = fail(args);
      return err === undefined ? { ok: true } : { ok: false, error: err };
    },
    capture: async (cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args });
      return { ok: true as const, stdout: "List of devices attached\n1C081FDF600CMG\tdevice\nemulator-5554\tdevice\n" };
    },
  };
  return { calls, exec };
}

test("installAndLaunch launches the iOS app in English (-AppleLanguages (en) -AppleLocale en_US)", async () => {
  const { calls, exec } = recordingExec();
  const result = await installAndLaunch({ platform: "ios", appPath: "/tmp/App.app", bundleId: "com.example.app" }, exec);
  assert.equal(result.ok, true);
  const launch = calls.find((c) => c.args[1] === "launch");
  assert.deepEqual(launch, {
    cmd: "xcrun",
    args: ["simctl", "launch", "booted", "com.example.app", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"],
  });
  assert.match(result.command, /xcrun simctl launch booted com\.example\.app -AppleLanguages "\(en\)" -AppleLocale en_US$/);
});

test("installAndLaunch sets the Android app's locale to en-US before launching it", async () => {
  const saved = process.env['NATIVEAPPTEMPLATE_ADB_SERIAL'];
  delete process.env['NATIVEAPPTEMPLATE_ADB_SERIAL'];
  try {
    const { calls, exec } = recordingExec();
    const result = await installAndLaunch({ platform: "android", apkPath: "/tmp/app-debug.apk", packageName: "com.example.app" }, exec);
    assert.equal(result.ok, true);
    assert.equal(result.warnings, undefined);
    const shell = calls.filter((c) => c.args.includes("shell")).map((c) => c.args);
    // Emulator picked over the phone; locale set after install, before monkey.
    assert.deepEqual(shell[1], ["-s", "emulator-5554", "shell", "cmd", "locale", "set-app-locales", "com.example.app", "--locales", "en-US"]);
    assert.equal(shell[2]?.[3], "monkey");
    assert.match(result.command, /set-app-locales com\.example\.app --locales en-US && .*monkey/);
  } finally {
    if (saved !== undefined) process.env['NATIVEAPPTEMPLATE_ADB_SERIAL'] = saved;
  }
});

test("installAndLaunch still launches on Android < 13 (no per-app locale) and warns", async () => {
  const saved = process.env['NATIVEAPPTEMPLATE_ADB_SERIAL'];
  process.env['NATIVEAPPTEMPLATE_ADB_SERIAL'] = "emulator-5554";
  try {
    const { calls, exec } = recordingExec((args) => (args.includes("set-app-locales") ? "cmd: Can't find service: locale" : undefined));
    const result = await installAndLaunch({ platform: "android", apkPath: "/tmp/app-debug.apk", packageName: "com.example.app" }, exec);
    assert.equal(result.ok, true);
    assert.ok(calls.some((c) => c.args.includes("monkey")));
    assert.equal(result.warnings?.length, 1);
    assert.match(result.warnings?.[0] ?? "", /API 33\+.*device language/);
  } finally {
    if (saved !== undefined) process.env['NATIVEAPPTEMPLATE_ADB_SERIAL'] = saved;
    else delete process.env['NATIVEAPPTEMPLATE_ADB_SERIAL'];
  }
});

async function stage2OnScreen(elements: readonly Record<string, unknown>[]) {
  const { tmpdir } = await import("node:os");
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { attachMobileClient } = await import("../src/mobile.js");
  const { runStage2Visual, DEFAULT_STAGE2_RUBRIC } = await import("../src/validation/stage2-judge.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const fake = new McpServer({ name: "fake-mobile-mcp", version: "0.0.0" });
  fake.registerTool(
    "mobile_list_available_devices",
    { description: "fake", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: JSON.stringify([{ name: "iPhone 17", platform: "ios" }]) }] }),
  );
  fake.registerTool(
    "mobile_list_elements_on_screen",
    { description: "fake", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: JSON.stringify(elements) }] }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([fake.connect(serverTransport), client.connect(clientTransport)]);
  const mobile = attachMobileClient(client);
  try {
    return await runStage2Visual({
      spec: "a queue",
      iosScenario: { name: "smoke", steps: [{ kind: "wait_for_text", text: "Welcome to", timeoutMs: 300 }] },
      rubric: DEFAULT_STAGE2_RUBRIC,
      screenshotDir: mkdtempSync(join(tmpdir(), "stage2-locale-")),
      iosClient: mobile,
    });
  } finally {
    await mobile.close();
    await fake.close();
  }
}

test("Stage 2 reports a non-English UI as an environment problem, not a bare wait_for_text failure", async () => {
  // The screen observed in #159 on a ja-JP simulator.
  const result = await stage2OnScreen([{ type: "StaticText", label: "Orange Baton へようこそ", x: 60, y: 650, width: 280, height: 100 }]);
  assert.equal(result.ios?.pass, false);
  assert.match(result.ios?.error ?? "", /^environment: the app's UI is not in English \(the screen shows "Orange Baton へようこそ"\)/);
  assert.match(result.ios?.error ?? "", /wait_for_text "Welcome to": not found/);
});

test("Stage 2 keeps the plain step error when the screen is in English", async () => {
  const result = await stage2OnScreen([{ type: "StaticText", label: "Something else", x: 60, y: 650, width: 280, height: 100 }]);
  assert.match(result.ios?.error ?? "", /^wait_for_text "Welcome to": not found/);
});

test("dispatch with NATIVEAPPTEMPLATE_VISUAL=2 plumbs through to JudgeResult.visual.<platform>.stage2 (stub pipeline)", async () => {
  // We can't run the full real Stage 2 here (no booted sim), but we
  // CAN verify the env-var → judge config wiring by patching the env
  // and checking that dispatch produces a JudgeResult shape that would
  // contain stage2 when wired. In stub mode, judge short-circuits to
  // runStubJudge — so the real assertion is "the plumbing typechecks
  // and dispatch still completes". That's covered by the build step
  // and the existing stub-pipeline test. Here we just sanity-check
  // that VISUAL=2 doesn't break the stub path.
  process.env['NATIVEAPPTEMPLATE_VISUAL'] = "2";
  try {
    const { dispatch: dispatchFn } = await import("../src/dispatch.js");
    const result = await dispatchFn("a walk-in clinic queue for vets");
    assert.equal(result.overallPass, true);
    assert.match(result.summary, /PASS/);
  } finally {
    delete process.env['NATIVEAPPTEMPLATE_VISUAL'];
  }
});

test("env-bridge: productTokenFor uppercases the slug-derived flat token", async () => {
  const { productTokenFor } = await import("../src/env-bridge.js");
  assert.equal(
    productTokenFor({ slug: "vet-clinic-queue", displayName: "x", entities: [], renamePlan: [], jsonApiContract: {} }),
    "VETCLINICQUEUE",
  );
  assert.equal(
    productTokenFor({ slug: "clinic-queue", displayName: "x", entities: [], renamePlan: [], jsonApiContract: {} }),
    "CLINICQUEUE",
  );
});

test("env-bridge: readSubstrateApiVars pulls HOST + PORT from substrate Rails .env", async () => {
  const { tmpdir } = await import("node:os");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const fakeSubstrate = mkdtempSync(join(tmpdir(), "substrate-api-"));
  writeFileSync(
    join(fakeSubstrate, ".env"),
    "HOST=192.168.1.11\nPORT=3000\nSOLID_QUEUE_IN_PUMA=true\n",
  );

  const realSubstrate = process.env['NATIVEAPPTEMPLATE_API'];
  process.env['NATIVEAPPTEMPLATE_API'] = fakeSubstrate;
  try {
    const { readSubstrateApiVars } = await import("../src/env-bridge.js");
    const result = await readSubstrateApiVars();
    assert.equal(result['API_DOMAIN'], "192.168.1.11");
    assert.equal(result['API_PORT'], "3000");
    // SOLID_QUEUE_IN_PUMA is .env clutter, must not bleed into the bridge.
    assert.equal(Object.keys(result).includes('SOLID_QUEUE_IN_PUMA'), false);
  } finally {
    if (realSubstrate !== undefined) process.env['NATIVEAPPTEMPLATE_API'] = realSubstrate;
    else delete process.env['NATIVEAPPTEMPLATE_API'];
  }
});

test("env-bridge: readSubstrateApiVars takes SCHEME from shell env (Rails .env doesn't carry it)", async () => {
  const { tmpdir } = await import("node:os");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const fakeSubstrate = mkdtempSync(join(tmpdir(), "substrate-scheme-"));
  writeFileSync(join(fakeSubstrate, ".env"), "HOST=192.168.1.11\nPORT=3000\n");

  const realSubstrate = process.env['NATIVEAPPTEMPLATE_API'];
  process.env['NATIVEAPPTEMPLATE_API'] = fakeSubstrate;
  process.env['NATIVEAPPTEMPLATE_API_SCHEME'] = "http";
  try {
    const { readSubstrateApiVars } = await import("../src/env-bridge.js");
    const result = await readSubstrateApiVars();
    assert.equal(result['API_SCHEME'], "http");
  } finally {
    if (realSubstrate !== undefined) process.env['NATIVEAPPTEMPLATE_API'] = realSubstrate;
    else delete process.env['NATIVEAPPTEMPLATE_API'];
    delete process.env['NATIVEAPPTEMPLATE_API_SCHEME'];
  }
});

test("env-bridge: buildBridgeValues maps Rails .env HOST+PORT onto <PRODUCT>_API_DOMAIN+PORT", async () => {
  const { tmpdir } = await import("node:os");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const fakeSubstrate = mkdtempSync(join(tmpdir(), "substrate-build-"));
  writeFileSync(join(fakeSubstrate, ".env"), "HOST=192.168.1.11\nPORT=3000\n");

  const realSubstrate = process.env['NATIVEAPPTEMPLATE_API'];
  process.env['NATIVEAPPTEMPLATE_API'] = fakeSubstrate;
  process.env['NATIVEAPPTEMPLATE_API_SCHEME'] = "http";
  try {
    const { buildBridgeValues } = await import("../src/env-bridge.js");
    const bridge = await buildBridgeValues({
      slug: "vet-clinic-queue",
      displayName: "Vet Clinic Queue",
      entities: [],
      renamePlan: [],
      jsonApiContract: {},
    });
    assert.equal(bridge.values['VETCLINICQUEUE_API_DOMAIN'], "192.168.1.11");
    assert.equal(bridge.values['VETCLINICQUEUE_API_PORT'], "3000");
    assert.equal(bridge.values['VETCLINICQUEUE_API_SCHEME'], "http");
  } finally {
    if (realSubstrate !== undefined) process.env['NATIVEAPPTEMPLATE_API'] = realSubstrate;
    else delete process.env['NATIVEAPPTEMPLATE_API'];
    delete process.env['NATIVEAPPTEMPLATE_API_SCHEME'];
  }
});

test("env-bridge: applyBridgeToProcessEnv sets ORG_GRADLE_PROJECT_* and SIMCTL_CHILD_*", async () => {
  const { applyBridgeToProcessEnv } = await import("../src/env-bridge.js");
  applyBridgeToProcessEnv({
    values: { VETCLINICQUEUE_API_DOMAIN: "192.168.1.11", VETCLINICQUEUE_API_PORT: "3000" },
  });
  try {
    assert.equal(process.env['ORG_GRADLE_PROJECT_VETCLINICQUEUE_API_DOMAIN'], "192.168.1.11");
    assert.equal(process.env['ORG_GRADLE_PROJECT_VETCLINICQUEUE_API_PORT'], "3000");
    assert.equal(process.env['SIMCTL_CHILD_VETCLINICQUEUE_API_DOMAIN'], "192.168.1.11");
    assert.equal(process.env['SIMCTL_CHILD_VETCLINICQUEUE_API_PORT'], "3000");
  } finally {
    delete process.env['ORG_GRADLE_PROJECT_VETCLINICQUEUE_API_DOMAIN'];
    delete process.env['ORG_GRADLE_PROJECT_VETCLINICQUEUE_API_PORT'];
    delete process.env['SIMCTL_CHILD_VETCLINICQUEUE_API_DOMAIN'];
    delete process.env['SIMCTL_CHILD_VETCLINICQUEUE_API_PORT'];
  }
});

test("env-bridge: syncGradleProperties sentinel block round-trips and replaces idempotently", async () => {
  // Point HOME at a temp dir so the test doesn't touch the real
  // ~/.gradle/gradle.properties.
  const { tmpdir } = await import("node:os");
  const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");

  const fakeHome = mkdtempSync(join(tmpdir(), "env-bridge-"));
  mkdirSync(join(fakeHome, ".gradle"), { recursive: true });
  const gradlePath = join(fakeHome, ".gradle", "gradle.properties");
  writeFileSync(
    gradlePath,
    "# pre-existing content\nNATIVEAPPTEMPLATE_API_DOMAIN=api.nativeapptemplate.com\n",
  );

  const realHome = process.env['HOME'];
  process.env['HOME'] = fakeHome;
  try {
    const { syncGradleProperties } = await import("../src/env-bridge.js");

    // First write — adds sentinel block, preserves prior content.
    const r1 = await syncGradleProperties({
      values: { VETCLINICQUEUE_API_DOMAIN: "192.168.1.11", VETCLINICQUEUE_API_PORT: "3000" },
    });
    assert.equal(r1.mode, "wrote");
    let content = readFileSync(gradlePath, "utf8");
    assert.match(content, /^NATIVEAPPTEMPLATE_API_DOMAIN=api\.nativeapptemplate\.com$/m);
    assert.match(content, /^# BEGIN nativeapptemplate-agent/m);
    assert.match(content, /^VETCLINICQUEUE_API_DOMAIN=192\.168\.1\.11$/m);
    assert.match(content, /^VETCLINICQUEUE_API_PORT=3000$/m);
    assert.match(content, /^# END nativeapptemplate-agent$/m);

    // Second write with the same values — idempotent, no churn.
    const r2 = await syncGradleProperties({
      values: { VETCLINICQUEUE_API_DOMAIN: "192.168.1.11", VETCLINICQUEUE_API_PORT: "3000" },
    });
    assert.equal(r2.mode, "noop");

    // Third write with a different product's keys — joins the same block
    // and keeps the first product's lines (#148).
    const r3 = await syncGradleProperties({
      product: "CLINICQUEUE",
      values: { CLINICQUEUE_API_DOMAIN: "10.0.0.5" },
    });
    assert.equal(r3.mode, "wrote");
    content = readFileSync(gradlePath, "utf8");
    assert.equal((content.match(/# BEGIN nativeapptemplate-agent/g) ?? []).length, 1);
    assert.match(content, /^CLINICQUEUE_API_DOMAIN=10\.0\.0\.5$/m);
    assert.match(content, /^VETCLINICQUEUE_API_DOMAIN=192\.168\.1\.11$/m);

    // Empty bridge for one product — drops only that product's lines.
    const r4 = await syncGradleProperties({ product: "CLINICQUEUE", values: {} });
    assert.equal(r4.removedStale, true);
    content = readFileSync(gradlePath, "utf8");
    assert.doesNotMatch(content, /CLINICQUEUE_API_DOMAIN=10/);
    assert.match(content, /^VETCLINICQUEUE_API_DOMAIN=192\.168\.1\.11$/m);

    // ...and once the last product's lines go, the block goes with them,
    // leaving the rest untouched.
    const r4b = await syncGradleProperties({ product: "VETCLINICQUEUE", values: {} });
    assert.equal(r4b.removedStale, true);
    content = readFileSync(gradlePath, "utf8");
    assert.doesNotMatch(content, /BEGIN nativeapptemplate-agent/);
    assert.equal(content, "# pre-existing content\nNATIVEAPPTEMPLATE_API_DOMAIN=api.nativeapptemplate.com\n");

    // Smoke: existsSync still true.
    assert.equal(existsSync(gradlePath), true);

    // NATIVEAPPTEMPLATE_BRIDGE=off — skip the file write entirely.
    process.env['NATIVEAPPTEMPLATE_BRIDGE'] = "off";
    const r5 = await syncGradleProperties({
      values: { CLINICQUEUE_API_DOMAIN: "10.0.0.99" },
    });
    delete process.env['NATIVEAPPTEMPLATE_BRIDGE'];
    assert.equal(r5.mode, "skipped");
    content = readFileSync(gradlePath, "utf8");
    assert.doesNotMatch(content, /CLINICQUEUE_API_DOMAIN=10\.0\.0\.99/);

    // NATIVEAPPTEMPLATE_BRIDGE_DRY_RUN=1 — log preview, don't write.
    process.env['NATIVEAPPTEMPLATE_BRIDGE_DRY_RUN'] = "1";
    const r6 = await syncGradleProperties({
      values: { CLINICQUEUE_API_DOMAIN: "10.0.0.99" },
    });
    delete process.env['NATIVEAPPTEMPLATE_BRIDGE_DRY_RUN'];
    assert.equal(r6.mode, "dry-run");
    assert.match(r6.preview ?? "", /CLINICQUEUE_API_DOMAIN=10\.0\.0\.99/);
    content = readFileSync(gradlePath, "utf8");
    assert.doesNotMatch(content, /CLINICQUEUE_API_DOMAIN=10\.0\.0\.99/);
  } finally {
    if (realHome !== undefined) process.env['HOME'] = realHome;
    else delete process.env['HOME'];
  }
});

test("env-bridge: a second product's run keeps the first product's lines in the managed block (#148)", async () => {
  // Repro from #148: generate orange-baton, then clinic-queue — the
  // orange-baton Debug build must still find ORANGEBATON_API_* in
  // ~/.gradle/gradle.properties. HOME points at a temp dir so the real
  // file is never touched.
  const fakeHome = mkdtempSync(join(tmpdir(), "env-bridge-multi-"));
  mkdirSync(join(fakeHome, ".gradle"), { recursive: true });
  const gradlePath = join(fakeHome, ".gradle", "gradle.properties");
  writeFileSync(gradlePath, "org.gradle.jvmargs=-Xmx4g\n");
  const fakeSubstrate = mkdtempSync(join(tmpdir(), "substrate-multi-"));
  writeFileSync(join(fakeSubstrate, ".env"), "HOST=192.168.1.11\nPORT=3000\n");
  const saved = { HOME: process.env['HOME'], API: process.env['NATIVEAPPTEMPLATE_API'], SCHEME: process.env['NATIVEAPPTEMPLATE_API_SCHEME'] };
  process.env['HOME'] = fakeHome;
  process.env['NATIVEAPPTEMPLATE_API'] = fakeSubstrate;
  process.env['NATIVEAPPTEMPLATE_API_SCHEME'] = "http";
  try {
    const { buildBridgeValues, syncGradleProperties } = await import("../src/env-bridge.js");
    const domainFor = (slug: string): DomainSpec => ({ slug, displayName: slug, entities: [], renamePlan: [], jsonApiContract: {} });

    await syncGradleProperties(await buildBridgeValues(domainFor("orange-baton")));
    writeFileSync(join(fakeSubstrate, ".env"), "HOST=10.0.0.5\nPORT=3001\n");
    await syncGradleProperties(await buildBridgeValues(domainFor("clinic-queue")));

    // Keys sorted within the block (formatSentinelBlock), one block only.
    assert.equal(
      readFileSync(gradlePath, "utf8"),
      [
        "org.gradle.jvmargs=-Xmx4g",
        "# BEGIN nativeapptemplate-agent (mirrored API config — do not edit by hand)",
        "CLINICQUEUE_API_DOMAIN=10.0.0.5",
        "CLINICQUEUE_API_PORT=3001",
        "CLINICQUEUE_API_SCHEME=http",
        "ORANGEBATON_API_DOMAIN=192.168.1.11",
        "ORANGEBATON_API_PORT=3000",
        "ORANGEBATON_API_SCHEME=http",
        "# END nativeapptemplate-agent",
        "",
      ].join("\n"),
    );

    // Re-running orange-baton replaces only its own lines; a key its run no
    // longer mirrors (SCHEME unset) goes away instead of lingering.
    delete process.env['NATIVEAPPTEMPLATE_API_SCHEME'];
    writeFileSync(join(fakeSubstrate, ".env"), "HOST=192.168.1.20\nPORT=3000\n");
    const r = await syncGradleProperties(await buildBridgeValues(domainFor("orange-baton")));
    assert.equal(r.mode, "wrote");
    const content = readFileSync(gradlePath, "utf8");
    assert.match(content, /^ORANGEBATON_API_DOMAIN=192\.168\.1\.20$/m);
    assert.doesNotMatch(content, /ORANGEBATON_API_SCHEME/);
    assert.match(content, /^CLINICQUEUE_API_SCHEME=http$/m);
    assert.equal((content.match(/^ORANGEBATON_API_DOMAIN=/gm) ?? []).length, 1);
  } finally {
    for (const [k, v] of [["HOME", saved.HOME], ["NATIVEAPPTEMPLATE_API", saved.API], ["NATIVEAPPTEMPLATE_API_SCHEME", saved.SCHEME]] as const) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  }
});

test("parseAdbDevices skips header + offline + unauthorized; keeps online serials", async () => {
  const { parseAdbDevices } = await import("../src/validation/launch.js");
  const sample = [
    "List of devices attached",
    "1C081FDF600CMG\tdevice",
    "emulator-5554\tdevice",
    "0123456789ABCDEF\toffline",
    "FEDCBA9876543210\tunauthorized",
    "",
  ].join("\n");
  assert.deepEqual(parseAdbDevices(sample), ["1C081FDF600CMG", "emulator-5554"]);
  assert.deepEqual(parseAdbDevices(""), []);
  assert.deepEqual(parseAdbDevices("List of devices attached\n"), []);
});

test("selectAdbTarget honors NATIVEAPPTEMPLATE_ADB_SERIAL override", async () => {
  const { selectAdbTarget } = await import("../src/validation/launch.js");
  process.env['NATIVEAPPTEMPLATE_ADB_SERIAL'] = "my-special-device";
  try {
    // Override returns synchronously without invoking adb, so the path
    // we hand it doesn't matter — never executed.
    const result = await selectAdbTarget("/nonexistent/adb", 1000);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.serial, "my-special-device");
  } finally {
    delete process.env['NATIVEAPPTEMPLATE_ADB_SERIAL'];
  }
});

test("selectAdbTarget returns ok with no serial when adb missing (single device fallback)", async () => {
  const { selectAdbTarget } = await import("../src/validation/launch.js");
  // No override + a nonexistent adb path → spawn fails → returns
  // ok:false with a useful error. Stronger test (real adb run with N
  // devices) belongs in an integration suite, not the smoke tests.
  const result = await selectAdbTarget("/nonexistent/adb-binary", 1000);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.error.length > 0);
});

test("attachMobileClient: listDevices unwraps {devices: [...]} envelope and listElements strips text prefix", async () => {
  const { attachMobileClient } = await import("../src/mobile.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { z } = await import("zod");

  const fake = new McpServer({ name: "fake-mobile-mcp", version: "0.0.0" });
  // mobile-mcp 0.0.54 wraps the device list inside {"devices": [...]}.
  fake.registerTool(
    "mobile_list_available_devices",
    { description: "fake", inputSchema: {} },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            devices: [{ id: "B929BDBD-X", name: "iPhone 17", platform: "ios", type: "simulator" }],
          }),
        },
      ],
    }),
  );
  // mobile-mcp 0.0.54 prepends "Found these elements on screen: " to
  // its JSON array, so a naïve JSON.parse of the whole text fails.
  fake.registerTool(
    "mobile_list_elements_on_screen",
    { description: "fake", inputSchema: { device: z.string() } },
    async () => ({
      content: [
        {
          type: "text",
          text:
            'Found these elements on screen: ' +
            JSON.stringify([
              { type: "Button", label: "Start", coordinates: { x: 311, y: 66, width: 70, height: 36 } },
            ]),
        },
      ],
    }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([fake.connect(serverTransport), client.connect(clientTransport)]);
  const mobile = attachMobileClient(client);

  const devices = await mobile.listDevices();
  assert.equal(devices.length, 1);
  assert.equal((devices[0] as { id: string }).id, "B929BDBD-X");

  mobile.useDevice("B929BDBD-X");
  const elements = await mobile.listElements();
  assert.equal(elements.length, 1);
  assert.equal((elements[0] as { label: string }).label, "Start");

  await mobile.close();
  await fake.close();
});

test("attachMobileClient: useDevice injects `device` arg into every subsequent call", async () => {
  const { attachMobileClient } = await import("../src/mobile.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { z } = await import("zod");

  const fake = new McpServer({ name: "fake-mobile-mcp", version: "0.0.0" });
  const calls: { name: string; args: Record<string, unknown> }[] = [];

  fake.registerTool(
    "mobile_list_available_devices",
    { description: "fake", inputSchema: {} },
    async (args) => {
      calls.push({ name: "list_devices", args });
      return {
        content: [{ type: "text", text: JSON.stringify([{ name: "iPhone 17", platform: "ios" }]) }],
      };
    },
  );
  fake.registerTool(
    "mobile_list_elements_on_screen",
    { description: "fake", inputSchema: { device: z.string() } },
    async (args) => {
      calls.push({ name: "list_elements", args });
      return { content: [{ type: "text", text: "[]" }] };
    },
  );
  fake.registerTool(
    "mobile_click_on_screen_at_coordinates",
    { description: "fake", inputSchema: { device: z.string(), x: z.number(), y: z.number() } },
    async (args) => {
      calls.push({ name: "click", args });
      return { content: [] };
    },
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([fake.connect(serverTransport), client.connect(clientTransport)]);
  const mobile = attachMobileClient(client);

  // Before useDevice — listDevices works (device-independent tool).
  await mobile.listDevices();
  assert.equal(calls[0]?.name, "list_devices");
  assert.deepEqual(calls[0]?.args, {});

  // Set device and exercise device-dependent calls.
  mobile.useDevice("iPhone 17");
  await mobile.listElements();
  await mobile.click(10, 20);

  assert.deepEqual(calls[1]?.args, { device: "iPhone 17" });
  assert.deepEqual(calls[2]?.args, { device: "iPhone 17", x: 10, y: 20 });

  // Clear device — back to no injection (and listDevices still works).
  mobile.useDevice(undefined);
  await mobile.listDevices();
  assert.deepEqual(calls[3]?.args, {});

  await mobile.close();
  await fake.close();
});

test("selectDevice picks iOS sim by platform field, sets it on the client", async () => {
  const { attachMobileClient } = await import("../src/mobile.js");
  const { selectDevice } = await import("../src/validation/stage2-judge.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { z } = await import("zod");

  const fake = new McpServer({ name: "fake-mobile-mcp", version: "0.0.0" });
  const calls: { name: string; args: Record<string, unknown> }[] = [];

  fake.registerTool(
    "mobile_list_available_devices",
    { description: "fake", inputSchema: {} },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { name: "emulator-5554", platform: "android" },
            { name: "iPhone 17", platform: "ios" },
            { name: "iPad Pro", platform: "ios" },
          ]),
        },
      ],
    }),
  );
  fake.registerTool(
    "mobile_take_screenshot",
    { description: "fake", inputSchema: { device: z.string() } },
    async (args) => {
      calls.push({ name: "take_screenshot", args });
      return {
        content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      };
    },
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([fake.connect(serverTransport), client.connect(clientTransport)]);
  const mobile = attachMobileClient(client);

  const err = await selectDevice(mobile, "ios");
  assert.equal(err, undefined);

  // After selectDevice, subsequent calls should carry the picked iOS device.
  await mobile.takeScreenshot();
  assert.equal(calls[0]?.args['device'], "iPhone 17");

  await mobile.close();
  await fake.close();
});

test("selectDevice surfaces a useful error when no platform match found", async () => {
  const { attachMobileClient } = await import("../src/mobile.js");
  const { selectDevice } = await import("../src/validation/stage2-judge.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

  const fake = new McpServer({ name: "fake-mobile-mcp", version: "0.0.0" });
  fake.registerTool(
    "mobile_list_available_devices",
    { description: "fake", inputSchema: {} },
    async () => ({
      content: [{ type: "text", text: JSON.stringify([{ name: "emulator-5554", platform: "android" }]) }],
    }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([fake.connect(serverTransport), client.connect(clientTransport)]);
  const mobile = attachMobileClient(client);

  const err = await selectDevice(mobile, "ios");
  assert.match(err ?? "", /no mobile-mcp device matched platform=ios/);
  assert.match(err ?? "", /emulator-5554/);
  assert.match(err ?? "", /NATIVEAPPTEMPLATE_MOBILE_IOS_DEVICE/);

  await mobile.close();
  await fake.close();
});

test("selectDevice resolves the IOS override (display name -> canonical id) and errors on no match", async () => {
  const { attachMobileClient } = await import("../src/mobile.js");
  const { selectDevice } = await import("../src/validation/stage2-judge.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { z } = await import("zod");

  const fake = new McpServer({ name: "fake-mobile-mcp", version: "0.0.0" });
  fake.registerTool(
    "mobile_list_available_devices",
    { description: "fake", inputSchema: {} },
    async () => ({
      content: [{ type: "text", text: JSON.stringify({ devices: [{ id: "UDID-123", name: "iPhone 17", platform: "ios", type: "simulator" }] }) }],
    }),
  );
  const calls: { device?: unknown }[] = [];
  fake.registerTool(
    "mobile_take_screenshot",
    { description: "fake", inputSchema: { device: z.string() } },
    async (args) => { calls.push(args); return { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }; },
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([fake.connect(serverTransport), client.connect(clientTransport)]);
  const mobile = attachMobileClient(client);

  // Override given as the DISPLAY NAME must resolve to the canonical id so
  // subsequent per-device tool calls carry the UDID (not the name, which
  // mobile-mcp's tools reject).
  process.env['NATIVEAPPTEMPLATE_MOBILE_IOS_DEVICE'] = "iPhone 17";
  try {
    assert.equal(await selectDevice(mobile, "ios"), undefined);
    await mobile.takeScreenshot();
    assert.equal(calls[0]?.device, "UDID-123", "override name resolved to the device id");
  } finally {
    delete process.env['NATIVEAPPTEMPLATE_MOBILE_IOS_DEVICE'];
  }

  // An override matching no booted device returns an informative error.
  process.env['NATIVEAPPTEMPLATE_MOBILE_IOS_DEVICE'] = "Nonexistent Device";
  try {
    const err = await selectDevice(mobile, "ios");
    assert.match(err ?? "", /matched no booted device/);
  } finally {
    delete process.env['NATIVEAPPTEMPLATE_MOBILE_IOS_DEVICE'];
  }

  await mobile.close();
  await fake.close();
});

test("createMcpServer registers generate_app and routes through dispatch", async () => {
  const { createMcpServer } = await import("../src/mcp.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === "generate_app"));

  const call = await client.callTool({
    name: "generate_app",
    arguments: { spec: "a walk-in clinic queue for small veterinary practices" },
  });
  assert.equal(call.isError, false);
  const sc = call.structuredContent as { overallPass?: boolean; summary?: string; report?: { meta?: { slug?: string } } };
  assert.equal(sc.overallPass, true);
  assert.match(sc.summary ?? "", /PASS/);
  // Step 7: the RunReport is surfaced in structuredContent.
  assert.ok(sc.report, "expected report in structuredContent");
  assert.equal(typeof sc.report?.meta?.slug, "string");

  await client.close();
  await server.close();
});

// --- HTML validation report (docs/validation-report.md) ---

const reportDomain: DomainSpec = {
  slug: "vet-clinic",
  displayName: "Vet Clinic",
  entities: [
    { name: "Patient", replaces: "ItemTag", fields: [{ name: "name", type: "string" }], states: ["Idled", "Completed"] },
  ],
  renamePlan: [
    { from: "Shop", to: "Clinic" },
    { from: "Shopkeeper", to: "Vet" },
  ],
  jsonApiContract: {},
};

function mixedJudge(iosScreenshot?: string): JudgeResult {
  return {
    overallPass: false,
    summary: "Layer 1 2/3 pass · Layer 2 2/3 pass · Layer 3 1/2 pass · reviewer FAIL",
    platforms: [
      {
        platform: "rails",
        layer1: { pass: true, findings: [] },
        layer2: { pass: true, command: "bin/rails runner", mode: "build", exitCode: 0, durationMs: 4200 },
      },
      {
        platform: "ios",
        layer1: { pass: false, findings: [{ token: "Shop", file: "ios/Foo.swift", line: 12, text: "var s: Shop<Tag>" }] },
        layer2: { pass: true, command: "xcodebuild build", mode: "build", exitCode: 0, durationMs: 61000 },
        layer3: {
          pass: true,
          ...(iosScreenshot !== undefined ? { screenshotPath: iosScreenshot } : {}),
          scores: [{ criterionId: "no-substrate-leak", pass: true, rationale: "No Shop tokens visible." }],
        },
      },
      {
        platform: "android",
        layer1: { pass: true, findings: [] },
        layer2: { pass: false, command: "./gradlew assembleDebug", mode: "build", exitCode: 1, durationMs: 30000, stderrTail: "e: Unresolved reference: Shopkeeper" },
        layer3: { pass: false, error: "launch failed" },
      },
    ],
  };
}

const failReviewer: ReviewerResult = { contractParity: "fail", diffs: ["iOS calls DELETE /clinics/{id}/reset not in Rails"] };

test("buildRunReport assembles meta + platforms + domain from the run pieces", () => {
  const report = buildRunReport({
    spec: "a vet clinic queue",
    domain: reportDomain,
    judge: mixedJudge(),
    reviewer: failReviewer,
    agentVersion: "9.9.9",
    judgeModel: "claude-opus-5-5",
    visualLevel: 1,
    startedAt: 1000,
    finishedAt: 4000,
  });
  assert.equal(report.meta.slug, "vet-clinic");
  assert.equal(report.meta.durationMs, 3000);
  assert.equal(report.meta.agentVersion, "9.9.9");
  assert.equal(report.platforms.length, 3);
  assert.equal(report.reviewer.contractParity, "fail");
  assert.deepEqual(report.domain.renamePlan, [
    { from: "Shop", to: "Clinic" },
    { from: "Shopkeeper", to: "Vet" },
  ]);
});

test("renderReport surfaces findings, stderr, reviewer diff, rename plan, and overall verdict", () => {
  const report = buildRunReport({
    spec: "a vet clinic queue",
    domain: reportDomain,
    // A screenshot path the (empty) asset map can't resolve → exercises
    // the "screenshot unavailable" placeholder branch.
    judge: mixedJudge("/tmp/nonexistent/ios-home.png"),
    reviewer: failReviewer,
    agentVersion: "9.9.9",
    judgeModel: "claude-opus-5-5",
    visualLevel: 1,
    startedAt: 1000,
    finishedAt: 4000,
  });
  const html = renderReport(report);

  assert.match(html, /<!doctype html>/i);
  assert.ok(html.includes("Vet Clinic"));
  assert.ok(html.includes("✗ Fail"), "overall fail badge");
  assert.ok(html.includes("2/3 pass"), "layer 1 gate count");
  // Layer 1 finding details, HTML-escaped (the fixture text has angle brackets).
  assert.ok(html.includes("ios/Foo.swift:12"));
  assert.ok(html.includes("Shop&lt;Tag&gt;"), "finding text is HTML-escaped");
  assert.ok(!html.includes("Shop<Tag>"), "no unescaped angle brackets leak through");
  // Layer 2 stderr tail.
  assert.ok(html.includes("Unresolved reference: Shopkeeper"));
  // Reviewer diff.
  assert.ok(html.includes("DELETE /clinics/{id}/reset"));
  // Domain rename plan.
  assert.ok(html.includes("Clinic") && html.includes("Vet"));
  // No screenshot provided in assets → placeholder, not a broken image.
  assert.ok(html.includes("screenshot unavailable"));
});

test("renderReport falls back to the summary line when platforms are empty (stub run)", () => {
  const report = buildRunReport({
    spec: "x",
    domain: reportDomain,
    judge: { overallPass: true, summary: "Layer 1/2/3 PASS" },
    reviewer: { contractParity: "pass", diffs: [] },
    agentVersion: "1.0.0",
    judgeModel: "claude-opus-5-5",
    visualLevel: 0,
    startedAt: 0,
    finishedAt: 10,
  });
  const html = renderReport(report);
  assert.ok(html.includes("Layer 1/2/3 PASS"));
  assert.ok(html.includes("✓ Pass"));
});

// --- autocorrecting formatters after the rename (#149) ---

function fakeTool(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

test("runFormatter rails runs bin/rubocop -a and reports offenses it could not autocorrect", async () => {
  const { runFormatter } = await import("../src/validation/autoformat.js");
  const dir = mkdtempSync(join(tmpdir(), "fmt-rails-"));
  mkdirSync(join(dir, "bin"));
  // RuboCop exits 1 when offenses remain after -a; its report goes to stdout.
  fakeTool(join(dir, "bin", "rubocop"), 'echo "$@" > args.txt\necho "test/a_test.rb:3:5: C: Layout/HashAlignment: Align the keys"\necho "1 file inspected, 2 offenses detected, 1 offense corrected"\nexit 1');
  const left = await runFormatter("rails", dir, { useMise: false });
  assert.equal(left.status, "fail");
  assert.equal(left.command, "bin/rubocop -a");
  assert.equal(left.exitCode, 1);
  assert.match(left.outputTail ?? "", /Layout\/HashAlignment/);
  assert.equal(readFileSync(join(dir, "args.txt"), "utf8").trim(), "-a");

  fakeTool(join(dir, "bin", "rubocop"), 'echo "1 file inspected, 1 offense detected, 1 offense corrected"\nexit 0');
  const clean = await runFormatter("rails", dir, { useMise: false });
  assert.equal(clean.status, "pass");
  assert.equal(clean.exitCode, 0);
});

test("runFormatter android runs ./gradlew spotlessApply and surfaces a failing apply", async () => {
  const { runFormatter } = await import("../src/validation/autoformat.js");
  const dir = mkdtempSync(join(tmpdir(), "fmt-android-"));
  fakeTool(join(dir, "gradlew"), 'echo "$@" > args.txt\nexit 0');
  const ok = await runFormatter("android", dir);
  assert.equal(ok.status, "pass");
  assert.equal(readFileSync(join(dir, "args.txt"), "utf8").trim(), "spotlessApply --no-daemon");

  // ktlint violations without an autocorrect fail spotlessApply (on stderr).
  fakeTool(join(dir, "gradlew"), 'echo "SignUpApi.kt:3:1 Lint error > [standard:import-ordering]" >&2\nexit 1');
  const left = await runFormatter("android", dir);
  assert.equal(left.status, "fail");
  assert.match(left.outputTail ?? "", /import-ordering/);
});

test("runFormatter ios formats the app sources with swiftformat, and skips when it isn't installed", async () => {
  const { runFormatter } = await import("../src/validation/autoformat.js");
  const dir = mkdtempSync(join(tmpdir(), "fmt-ios-"));
  mkdirSync(join(dir, "OrangeBaton.xcodeproj"));
  mkdirSync(join(dir, "OrangeBaton"));
  mkdirSync(join(dir, "OrangeBatonTests"));
  const bin = mkdtempSync(join(tmpdir(), "fmt-ios-bin-"));
  fakeTool(join(bin, "swiftformat"), 'echo "$@" > args.txt\nexit 0');
  const ran = await runFormatter("ios", dir, { env: { PATH: `${bin}:/usr/bin:/bin` } });
  assert.equal(ran.status, "pass");
  assert.equal(ran.command, "swiftformat OrangeBaton");
  assert.equal(readFileSync(join(dir, "args.txt"), "utf8").trim(), "OrangeBaton");

  // `which` lives in /usr/bin; swiftformat (Homebrew) does not.
  const missing = await runFormatter("ios", dir, { env: { PATH: "/usr/bin:/bin" } });
  assert.equal(missing.status, "skipped");
  assert.match(missing.note ?? "", /not on PATH/);
});

test("runFormatter never throws: a missing tool or NATIVEAPPTEMPLATE_FORMAT=off comes back as a result", async () => {
  const { runFormatter } = await import("../src/validation/autoformat.js");
  const { runStep } = await import("../src/validation/run-step.js");
  const { existsSync } = await import("node:fs");
  const empty = mkdtempSync(join(tmpdir(), "fmt-empty-"));
  assert.equal((await runFormatter("rails", empty, { useMise: false })).status, "skipped");
  assert.equal((await runFormatter("android", empty)).status, "skipped");

  const gone = await runStep(empty, ["definitely-not-a-command-149"], { timeoutMs: 5_000 });
  assert.equal(gone.exitCode, null);

  const slow = await runStep(empty, ["sleep", "5"], { timeoutMs: 200 });
  assert.equal(slow.exitCode, null);
  assert.equal(slow.timedOut, true);

  const dir = mkdtempSync(join(tmpdir(), "fmt-off-"));
  fakeTool(join(dir, "gradlew"), "touch ran.txt\nexit 0");
  process.env['NATIVEAPPTEMPLATE_FORMAT'] = "off";
  try {
    const off = await runFormatter("android", dir);
    assert.equal(off.status, "skipped");
    assert.equal(off.note, "NATIVEAPPTEMPLATE_FORMAT=off");
    assert.equal(existsSync(join(dir, "ran.txt")), false);
  } finally {
    delete process.env['NATIVEAPPTEMPLATE_FORMAT'];
  }
});

test("renderReport shows formatter results, with what was left after autocorrect", () => {
  const judge = mixedJudge();
  const platforms = (judge.platforms ?? []).map((p) =>
    p.platform === "rails"
      ? { ...p, format: { status: "fail" as const, command: "mise exec -- bin/rubocop -a", exitCode: 1, durationMs: 9000, outputTail: "registrations_controller_test.rb:4:7: C: Layout/HashAlignment" } }
      : p.platform === "ios"
        ? { ...p, format: { status: "skipped" as const, command: "swiftformat OrangeBaton", exitCode: null, durationMs: 0, note: "swiftformat not on PATH" } }
        : p,
  );
  const report = buildRunReport({
    spec: "a vet clinic queue",
    domain: reportDomain,
    judge: { ...judge, platforms },
    reviewer: { contractParity: "pass", diffs: [] },
    agentVersion: "0.0.0",
    judgeModel: "claude-opus-5-5",
    visualLevel: 0,
    startedAt: 0,
    finishedAt: 1000,
  });
  const html = renderReport(report);
  assert.match(html, /Formatters — autocorrect after the rename/);
  assert.match(html, /issues left/);
  assert.match(html, /Layout\/HashAlignment/);
  assert.match(html, /swiftformat not on PATH/);
  assert.equal(report.platforms[0]?.format?.status, "fail");

  const without = renderReport(buildRunReport({
    spec: "a vet clinic queue",
    domain: reportDomain,
    judge: mixedJudge(),
    reviewer: { contractParity: "pass", diffs: [] },
    agentVersion: "0.0.0",
    judgeModel: "claude-opus-5-5",
    visualLevel: 0,
    startedAt: 0,
    finishedAt: 1000,
  }));
  assert.doesNotMatch(without, /Formatters —/);
});

// --- opt-in test suites (#150, SPEC §4 Operation 3) ---

test("testsEnabled follows NATIVEAPPTEMPLATE_TESTS and is off by default", async () => {
  const { testsEnabled } = await import("../src/validation/test-suites.js");
  const saved = process.env['NATIVEAPPTEMPLATE_TESTS'];
  try {
    delete process.env['NATIVEAPPTEMPLATE_TESTS'];
    assert.equal(testsEnabled(), false);
    for (const on of ["1", "on", "true", " TRUE "]) {
      process.env['NATIVEAPPTEMPLATE_TESTS'] = on;
      assert.equal(testsEnabled(), true, on);
    }
    for (const off of ["0", "off", "", "2"]) {
      process.env['NATIVEAPPTEMPLATE_TESTS'] = off;
      assert.equal(testsEnabled(), false, off);
    }
  } finally {
    if (saved !== undefined) process.env['NATIVEAPPTEMPLATE_TESTS'] = saved;
    else delete process.env['NATIVEAPPTEMPLATE_TESTS'];
  }
});

test("runTestSuite rails prepares the test DB, runs bin/rails test and keeps Minitest's summary", async () => {
  const { runTestSuite } = await import("../src/validation/test-suites.js");
  const dir = mkdtempSync(join(tmpdir(), "tests-rails-"));
  mkdirSync(join(dir, "bin"));
  fakeTool(join(dir, "bin", "rails"), 'echo "$@" >> calls.txt\nif [ "$1" = test ]; then echo "Failure: JSONAPIDocumentTest"; echo "643 runs, 2108 assertions, 1 failures, 0 errors, 0 skips"; exit 1; fi\nexit 0');
  const r = await runTestSuite("rails", dir, { useMise: false });
  assert.equal(readFileSync(join(dir, "calls.txt"), "utf8"), "db:test:prepare\ntest\n");
  assert.equal(r.status, "fail");
  assert.equal(r.command, "bin/rails test");
  assert.equal(r.summary, "643 runs, 2108 assertions, 1 failures, 0 errors, 0 skips");
  assert.match(r.outputTail ?? "", /JSONAPIDocumentTest/);

  // A failing db:test:prepare stops before the suite.
  fakeTool(join(dir, "bin", "rails"), 'echo "$@" >> calls2.txt\n[ "$1" = db:test:prepare ] && exit 1\nexit 0');
  const prep = await runTestSuite("rails", dir, { useMise: false });
  assert.equal(prep.status, "fail");
  assert.equal(prep.command, "bin/rails db:test:prepare");
  assert.equal(readFileSync(join(dir, "calls2.txt"), "utf8"), "db:test:prepare\n");
});

test("runTestSuite android runs testDebugUnitTest; ios runs xcodebuild test on the Layer 2 scheme + destination", async () => {
  const { runTestSuite } = await import("../src/validation/test-suites.js");
  const android = mkdtempSync(join(tmpdir(), "tests-android-"));
  fakeTool(join(android, "gradlew"), 'echo "$@" > args.txt\necho "BUILD SUCCESSFUL in 1m 2s"\nexit 0');
  const a = await runTestSuite("android", android);
  assert.equal(a.status, "pass");
  assert.equal(readFileSync(join(android, "args.txt"), "utf8").trim(), "testDebugUnitTest --no-daemon");
  assert.equal(a.summary, "BUILD SUCCESSFUL in 1m 2s");

  const ios = mkdtempSync(join(tmpdir(), "tests-ios-"));
  mkdirSync(join(ios, "OrangeBaton.xcodeproj"));
  const bin = mkdtempSync(join(tmpdir(), "tests-ios-bin-"));
  fakeTool(join(bin, "xcodebuild"), 'echo "$@" > args.txt\necho "Executed 1117 tests, with 1 failure (0 unexpected) in 85.2 (86.0) seconds"\necho "** TEST FAILED **"\nexit 65');
  const savedDest = process.env['NATIVEAPPTEMPLATE_IOS_DESTINATION'];
  process.env['NATIVEAPPTEMPLATE_IOS_DESTINATION'] = "platform=iOS Simulator,name=iPhone 16";
  try {
    const i = await runTestSuite("ios", ios, { env: { PATH: `${bin}:/usr/bin:/bin` } });
    assert.equal(i.status, "fail");
    assert.equal(i.exitCode, 65);
    assert.equal(i.command, "xcodebuild test -scheme OrangeBaton");
    assert.equal(
      readFileSync(join(ios, "args.txt"), "utf8").trim(),
      "-project OrangeBaton.xcodeproj -scheme OrangeBaton -destination platform=iOS Simulator,name=iPhone 16 -configuration Debug test",
    );
    assert.equal(i.summary, "Executed 1117 tests, with 1 failure (0 unexpected) in 85.2 (86.0) seconds");
  } finally {
    if (savedDest !== undefined) process.env['NATIVEAPPTEMPLATE_IOS_DESTINATION'] = savedDest;
    else delete process.env['NATIVEAPPTEMPLATE_IOS_DESTINATION'];
  }

  const empty = mkdtempSync(join(tmpdir(), "tests-empty-"));
  for (const p of ["rails", "ios", "android"] as const) {
    assert.equal((await runTestSuite(p, empty, { useMise: false })).status, "skipped", p);
  }
});

test("applyTestResults fails the run on a failing suite, ignores skipped ones, and the report shows them", async () => {
  const { applyTestResults } = await import("../src/validation/test-suites.js");
  const base: JudgeResult = {
    overallPass: true,
    summary: "Layer 1 3/3 pass · Layer 2 3/3 pass · Layer 3 2/2 pass · reviewer PASS",
    platforms: (["rails", "ios", "android"] as const).map((platform) => ({
      platform,
      layer1: { pass: true, findings: [] },
      layer2: { pass: true, command: "build", mode: "build" as const, exitCode: 0, durationMs: 1 },
    })),
  };
  const pass = { status: "pass" as const, command: "bin/rails test", exitCode: 0, durationMs: 60_000, summary: "643 runs, 2108 assertions, 0 failures, 0 errors, 0 skips" };
  const fail = { status: "fail" as const, command: "xcodebuild test -scheme OrangeBaton", exitCode: 65, durationMs: 90_000, summary: "** TEST FAILED **", outputTail: "JSONAPIDocumentTest.unknownTypeHasNoEntityType failed" };
  const skip = { status: "skipped" as const, command: "./gradlew testDebugUnitTest", exitCode: null, durationMs: 0, note: "no ./gradlew wrapper in the generated app" };

  const allGreen = applyTestResults(base, { rails: pass, ios: pass, android: skip });
  assert.equal(allGreen.overallPass, true);
  assert.match(allGreen.summary, / · tests 2\/2 pass$/);

  const red = applyTestResults(base, { rails: pass, ios: fail, android: skip });
  assert.equal(red.overallPass, false);
  assert.match(red.summary, / · tests 1\/2 pass$/);
  assert.equal(red.platforms?.[1]?.tests?.status, "fail");

  const report = buildRunReport({
    spec: "a job hand-off tracker",
    domain: reportDomain,
    judge: red,
    reviewer: { contractParity: "pass", diffs: [] },
    agentVersion: "0.0.0",
    judgeModel: "claude-opus-5-5",
    visualLevel: 2,
    testsEnabled: true,
    startedAt: 0,
    finishedAt: 1000,
  });
  assert.equal(report.verdict, "fail");
  assert.equal(report.meta.tests, true);
  const html = renderReport(report);
  assert.match(html, /Test suites \(NATIVEAPPTEMPLATE_TESTS=1\)/);
  assert.match(html, /unknownTypeHasNoEntityType/);
  assert.match(html, /643 runs, 2108 assertions/);
  assert.match(html, /<div class="label">Test suites<\/div><div class="value">1\/2 pass<\/div>/);
  assert.match(html, /npx nativeapptemplate-agent &quot;[^&]*&quot; --visual=2 --tests/);

  const off = renderReport(buildRunReport({
    spec: "a job hand-off tracker",
    domain: reportDomain,
    judge: base,
    reviewer: { contractParity: "pass", diffs: [] },
    agentVersion: "0.0.0",
    judgeModel: "claude-opus-5-5",
    visualLevel: 0,
    startedAt: 0,
    finishedAt: 1000,
  }));
  assert.doesNotMatch(off, /Test suites/);
  assert.doesNotMatch(off, /tests: on/);
});

test("runStep keeps only the end of a very large output", async () => {
  const { runStep } = await import("../src/validation/run-step.js");
  const dir = mkdtempSync(join(tmpdir(), "step-big-"));
  // ~3.9 MB of output, then a last line that must survive.
  fakeTool(join(dir, "loud"), 'i=0; while [ $i -lt 30000 ]; do echo "........................................................................................................................................"; i=$((i+1)); done; echo "LAST LINE"');
  const r = await runStep(dir, ["./loud"], { timeoutMs: 30_000 });
  assert.equal(r.exitCode, 0);
  assert.ok(r.output.length <= 2_000_000, `kept ${r.output.length} bytes`);
  assert.match(r.output, /LAST LINE\n$/);
});

test("writeReport emits a self-contained report.json + HTML with embedded screenshot", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "report-test-"));
  const shotPath = join(tmp, "ios-home.png");
  // Minimal valid-ish PNG header bytes — enough to base64-embed.
  writeFileSync(shotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const report = buildRunReport({
    spec: "a vet clinic queue",
    domain: reportDomain,
    judge: mixedJudge(shotPath),
    reviewer: failReviewer,
    agentVersion: "1.0.0",
    judgeModel: "claude-opus-5-5",
    visualLevel: 1,
    startedAt: 0,
    finishedAt: 1000,
  });

  assert.ok(collectScreenshotPaths(report).includes(shotPath));

  const dir = join(tmp, "out");
  const paths = await writeReport(report, { dir, embed: true });

  assert.ok(paths.jsonPath, "json path");
  assert.ok(paths.htmlPath, "html path");

  const json = JSON.parse(readFileSync(paths.jsonPath!, "utf8")) as { overallPass: boolean; meta: { slug: string } };
  assert.equal(json.overallPass, false);
  assert.equal(json.meta.slug, "vet-clinic");

  const html = readFileSync(paths.htmlPath!, "utf8");
  assert.ok(html.includes("data:image/png;base64,"), "screenshot embedded as data URI");
  // Portability guarantees: no ephemeral tmp paths, no network/asset URLs.
  assert.ok(!html.includes(shotPath), "must not leak the raw tmp/ screenshot path");
  assert.ok(!/https?:\/\//.test(html), "must not reference any external URL");
});

test("writeReport with embed=false externalizes screenshots to report-assets/", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "report-ext-"));
  const shotPath = join(tmp, "ios-home.png");
  writeFileSync(shotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const report = buildRunReport({
    spec: "x",
    domain: reportDomain,
    judge: mixedJudge(shotPath),
    reviewer: { contractParity: "pass", diffs: [] },
    agentVersion: "1.0.0",
    judgeModel: "claude-opus-5-5",
    visualLevel: 1,
    startedAt: 0,
    finishedAt: 1,
  });

  const dir = join(tmp, "out");
  const paths = await writeReport(report, { dir, embed: false, format: "html" });
  assert.equal(paths.jsonPath, undefined, "format=html skips json");
  const html = readFileSync(paths.htmlPath!, "utf8");
  assert.ok(html.includes("report-assets/ios-home.png"), "relative asset reference");
  assert.ok(!html.includes("data:image/png"), "no embedded data URI when embed=false");
  // The copied asset exists on disk.
  assert.ok(readFileSync(join(dir, "report-assets", "ios-home.png")).length > 0);
});

test("parseArgs splits the spec from report + exit flags", async () => {
  const { parseArgs } = await import("../src/index.js");
  const parsed = parseArgs(["a", "walk-in", "queue", "--no-report", "--report-format=json", "--report-embed=false", "--report-open", "--exit-zero"]);
  assert.equal(parsed.spec, "a walk-in queue");
  assert.equal(parsed.report.enabled, false);
  assert.equal(parsed.report.format, "json");
  assert.equal(parsed.report.embed, false);
  assert.equal(parsed.open, true);
  assert.equal(parsed.exitZero, true);
});

test("parseArgs defaults: a bare spec leaves report options unset", async () => {
  const { parseArgs } = await import("../src/index.js");
  const parsed = parseArgs(["just", "a", "spec"]);
  assert.equal(parsed.spec, "just a spec");
  assert.deepEqual(parsed.report, {});
  assert.equal(parsed.open, false);
  assert.equal(parsed.exitZero, false);
});

test("parseArgs ignores an invalid --report-format value", async () => {
  const { parseArgs } = await import("../src/index.js");
  const parsed = parseArgs(["spec", "--report-format=xml"]);
  assert.equal(parsed.spec, "spec");
  assert.equal(parsed.report.format, undefined);
});

// --- manual rename overrides (src/rename-overrides.ts, --rename flag) ---

test("parseArgs collects repeatable --rename pairs (space form) without polluting the spec", async () => {
  const { parseArgs } = await import("../src/index.js");
  const parsed = parseArgs(["a", "vet", "clinic", "--rename", "Shop=Clinic", "--rename", "Shopkeeper=Vet"]);
  assert.equal(parsed.spec, "a vet clinic");
  assert.deepEqual(parsed.renameOverrides, [
    { from: "Shop", to: "Clinic" },
    { from: "Shopkeeper", to: "Vet" },
  ]);
});

test("parseArgs also accepts the --rename=From=To form", async () => {
  const { parseArgs } = await import("../src/index.js");
  const parsed = parseArgs(["spec", "--rename=Shopkeeper=Vet"]);
  assert.deepEqual(parsed.renameOverrides, [{ from: "Shopkeeper", to: "Vet" }]);
});

test("parseArgs skips a malformed --rename value and keeps the spec clean", async () => {
  const { parseArgs } = await import("../src/index.js");
  const parsed = parseArgs(["spec", "--rename", "Shop"]);
  assert.equal(parsed.spec, "spec");
  assert.deepEqual(parsed.renameOverrides, []);
});

test("parseRenamePair splits on the first = and rejects empty sides", async () => {
  const { parseRenamePair } = await import("../src/rename-overrides.js");
  assert.deepEqual(parseRenamePair("Shop=Clinic"), { from: "Shop", to: "Clinic" });
  assert.deepEqual(parseRenamePair(" Shop = Clinic "), { from: "Shop", to: "Clinic" });
  assert.equal(parseRenamePair("Shop"), null);
  assert.equal(parseRenamePair("=Clinic"), null);
  assert.equal(parseRenamePair("Shop="), null);
  assert.equal(parseRenamePair(undefined), null);
});

test("applyRenameOverrides changes a planned target and leaves the rest", async () => {
  const { applyRenameOverrides } = await import("../src/rename-overrides.js");
  const plan = [
    { from: "Shop", to: "Clinic" },
    { from: "Shopkeeper", to: "Vet" },
  ];
  const { plan: merged, outcomes } = applyRenameOverrides(plan, [{ from: "Shopkeeper", to: "Provider" }]);
  assert.deepEqual(merged, [
    { from: "Shop", to: "Clinic" },
    { from: "Shopkeeper", to: "Provider" },
  ]);
  assert.deepEqual(outcomes, [{ kind: "changed", from: "Shopkeeper", was: "Vet", to: "Provider" }]);
  // Original plan is not mutated.
  assert.equal(plan[1]?.to, "Vet");
});

test("applyRenameOverrides reports unmatched + noop overrides distinctly", async () => {
  const { applyRenameOverrides } = await import("../src/rename-overrides.js");
  const plan = [{ from: "Shop", to: "Clinic" }];
  const { plan: merged, outcomes } = applyRenameOverrides(plan, [
    { from: "Shop", to: "Clinic" }, // already the target → noop
    { from: "ItemTag", to: "Patient" }, // no planned rename → unmatched, dropped
  ]);
  assert.deepEqual(merged, [{ from: "Shop", to: "Clinic" }]);
  assert.deepEqual(outcomes, [
    { kind: "noop", from: "Shop", to: "Clinic" },
    { kind: "unmatched", from: "ItemTag", to: "Patient" },
  ]);
});

test("syncEntityNames renames an entity whose name still matches the overridden target", async () => {
  const { syncEntityNames } = await import("../src/rename-overrides.js");
  const entities = [
    { name: "Household", replaces: "Shop", fields: [{ name: "address", type: "string" as const }] },
    { name: "Monitor", replaces: "Shopkeeper", fields: [], states: ["Active", "Resolved"] as const },
  ];
  const synced = syncEntityNames(entities, [
    { kind: "changed", from: "Shopkeeper", was: "Monitor", to: "Resident" },
  ]);
  assert.equal(synced[0]?.name, "Household"); // untouched
  assert.equal(synced[1]?.name, "Resident"); // renamed Monitor -> Resident
  // `replaces` and other fields are preserved.
  assert.equal(synced[1]?.replaces, "Shopkeeper");
  assert.deepEqual(synced[1]?.states, ["Active", "Resolved"]);
});

test("syncEntityNames leaves entities alone when name diverges, no changed outcomes, or no match", async () => {
  const { syncEntityNames } = await import("../src/rename-overrides.js");
  const entities = [{ name: "Watcher", replaces: "Shopkeeper", fields: [] }];
  // Name diverges from the old target → conservative: leave it.
  assert.equal(
    syncEntityNames(entities, [{ kind: "changed", from: "Shopkeeper", was: "Monitor", to: "Resident" }])[0]?.name,
    "Watcher",
  );
  // No changed outcomes (noop/unmatched only) → returns input untouched.
  const noop = syncEntityNames(entities, [{ kind: "noop", from: "Shop", to: "Clinic" }]);
  assert.equal(noop, entities);
  // Override targets a token no entity replaces → unchanged.
  assert.equal(
    syncEntityNames(entities, [{ kind: "changed", from: "Shop", was: "Store", to: "Household" }])[0]?.name,
    "Watcher",
  );
});

test("dispatch applies a rename override end-to-end and surfaces the outcome (stub pipeline)", async () => {
  const result = await dispatch("a walk-in clinic queue for small veterinary practices", {
    renameOverrides: [{ from: "Shopkeeper", to: "Provider" }],
  });
  assert.equal(result.overallPass, true);
  assert.deepEqual(result.renameOverrideOutcomes, [
    { kind: "changed", from: "Shopkeeper", was: "Vet", to: "Provider" },
  ]);
  // The override flows into the plan the report renders from.
  assert.ok(
    result.report.domain.renamePlan.some((p) => p.from === "Shopkeeper" && p.to === "Provider"),
    "overridden pair present in report rename plan",
  );
});

test("dispatch with no overrides leaves renameOverrideOutcomes empty (stub pipeline)", async () => {
  const result = await dispatch("a walk-in clinic queue for vets");
  assert.deepEqual(result.renameOverrideOutcomes, []);
});

// --- project-name override (--project-name, src/slug.ts) ---

test("isValidSlug accepts kebab-case and rejects everything else", async () => {
  const { isValidSlug } = await import("../src/slug.js");
  assert.equal(isValidSlug("vet-clinic"), true);
  assert.equal(isValidSlug("clinic-queue-2"), true);
  assert.equal(isValidSlug("abc"), true);
  assert.equal(isValidSlug("VetClinic"), false); // uppercase
  assert.equal(isValidSlug("vet clinic"), false); // space
  assert.equal(isValidSlug("-vet"), false); // leading dash
  assert.equal(isValidSlug("vet_clinic"), false); // underscore
  assert.equal(isValidSlug(""), false);
});

test("projectName helpers derive slug + display name from any input form", async () => {
  const { projectNameToSlug, projectNameToDisplayName } = await import("../src/slug.js");
  for (const input of ["Vet Clinic", "VetClinic", "vet-clinic", "vet_clinic", "vet clinic"]) {
    assert.equal(projectNameToSlug(input), "vet-clinic", `slug from "${input}"`);
    assert.equal(projectNameToDisplayName(input), "Vet Clinic", `display from "${input}"`);
  }
  assert.equal(projectNameToSlug("Vet Clinic Queue"), "vet-clinic-queue");
  assert.equal(projectNameToDisplayName("vet-clinic-queue"), "Vet Clinic Queue");
});

test("parseArgs captures --project-name (both = and space forms) and drops empty ones", async () => {
  const { parseArgs } = await import("../src/index.js");
  assert.equal(parseArgs(["spec", "--project-name=Vet Clinic"]).projectName, "Vet Clinic");
  assert.equal(parseArgs(["spec", "--project-name", "VetClinic"]).projectName, "VetClinic");
  // Empty/whitespace or punctuation-only (no valid slug) → dropped, spec kept.
  assert.equal(parseArgs(["spec", "--project-name=   "]).projectName, undefined);
  const bad = parseArgs(["spec", "--project-name=!!!"]);
  assert.equal(bad.projectName, undefined);
  assert.equal(bad.spec, "spec");
});

test("dispatch applies --project-name: derives slug + display name (stub pipeline)", async () => {
  const result = await dispatch("a walk-in clinic queue for vets", { projectName: "Vet Clinic" });
  assert.equal(result.overallPass, true);
  // The name drives the report meta.slug (output dir + Pascal name follow).
  assert.equal(result.report.meta.slug, "vet-clinic");
  assert.equal(result.report.meta.displayName, "Vet Clinic");
});

test("dispatch ignores a project name that yields no valid slug (stub pipeline)", async () => {
  const result = await dispatch("a walk-in clinic queue for vets", { projectName: "!!!" });
  // Stub planner's slug is clinic-queue; an unusable name must not stick.
  assert.equal(result.report.meta.slug, "clinic-queue");
});

// --- rename.rb asset-file scope (scripts/ruby/rename.rb TEXT_EXTS/BASENAMES) ---

test(
  "rename.rb rewrites brand tokens in .webmanifest / .svg / .swiftformat assets",
  { skip: RUBY_AVAILABLE ? false : "ruby not on PATH" },
  async () => {
    const { runRuby } = await import("../src/ruby.js");
    const root = mkdtempSync(join(tmpdir(), "rename-assets-"));
    mkdirSync(join(root, "public"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "public", "site.webmanifest"), '{ "name": "NativeAppTemplate", "short_name": "NativeAppTemplate" }');
    writeFileSync(join(root, "docs", "social-preview.svg"), "<svg><text>NativeAppTemplate</text></svg>");
    writeFileSync(join(root, ".swiftformat"), '# SwiftFormat Configuration for NativeAppTemplate\n--header "//  NativeAppTemplate"\n');

    const stats = await runRuby<{ renamePlan: { from: string; to: string }[]; root: string }, { files_changed: number }>(
      "rename.rb",
      { renamePlan: [{ from: "NativeAppTemplate", to: "Sentova" }], root },
    );
    assert.equal(stats.files_changed, 3);

    for (const rel of ["public/site.webmanifest", "docs/social-preview.svg", ".swiftformat"]) {
      const content = readFileSync(join(root, rel), "utf8");
      assert.ok(content.includes("Sentova"), `${rel} should contain Sentova`);
      assert.ok(!content.includes("NativeAppTemplate"), `${rel} should not contain NativeAppTemplate`);
    }
  },
);

test(
  "rename.rb skips compiled build output so generic tokens in bundles aren't clobbered",
  { skip: RUBY_AVAILABLE ? false : "ruby not on PATH" },
  async () => {
    const { runRuby } = await import("../src/ruby.js");
    const root = mkdtempSync(join(tmpdir(), "rename-skip-"));
    mkdirSync(join(root, "app", "assets", "builds"), { recursive: true });
    mkdirSync(join(root, "public", "assets"), { recursive: true });
    mkdirSync(join(root, "app", "models"), { recursive: true });
    // Build artifacts: a compiled bundle (Turbo's unrelated VisitState.completed)
    // and a fingerprinted Sprockets file — must be left untouched.
    writeFileSync(join(root, "app", "assets", "builds", "application.js"), "this.state = VisitState.completed; // NativeAppTemplate");
    writeFileSync(join(root, "public", "assets", "application-abc123.js"), "VisitState.completed");
    // Real source: the legit ItemTag state — must be renamed.
    writeFileSync(join(root, "app", "models", "item_tag.rb"), "enum :state, {idled: 1, completed: 2} # NativeAppTemplate");

    await runRuby<{ renamePlan: { from: string; to: string }[]; root: string }, unknown>(
      "rename.rb",
      { renamePlan: [{ from: "Completed", to: "Resolved" }, { from: "NativeAppTemplate", to: "Sentova" }], root },
    );

    // Build outputs untouched (still the original tokens).
    assert.equal(readFileSync(join(root, "app/assets/builds/application.js"), "utf8"), "this.state = VisitState.completed; // NativeAppTemplate");
    assert.equal(readFileSync(join(root, "public/assets/application-abc123.js"), "utf8"), "VisitState.completed");
    // Real source renamed (control): proves the skip is targeted, not global.
    const model = readFileSync(join(root, "app/models/item_tag.rb"), "utf8");
    assert.ok(model.includes("resolved: 2"), "source state renamed completed -> resolved");
    assert.ok(model.includes("Sentova") && !model.includes("NativeAppTemplate"), "source brand token renamed");
  },
);

test(
  "rename.rb rewrites .kamal/secrets so its keys keep matching config/deploy.yml",
  { skip: RUBY_AVAILABLE ? false : "ruby not on PATH" },
  async () => {
    const { runRuby } = await import("../src/ruby.js");
    const root = mkdtempSync(join(tmpdir(), "rename-secrets-"));
    mkdirSync(join(root, ".kamal"), { recursive: true });
    mkdirSync(join(root, "config"), { recursive: true });
    // Same key spelled in both files: deploy.yml references it, secrets defines it.
    writeFileSync(join(root, ".kamal", "secrets"), "POSTGRES_PASSWORD=$NATIVEAPPTEMPLATEAPI_POSTGRES_PASSWORD\nNATIVEAPPTEMPLATEAPI_ORIGIN_CERT=$(cat $HOME/.config/nativeapptemplateapi/origin-cert.pem)\n");
    writeFileSync(join(root, "config", "deploy.yml"), "proxy:\n  ssl:\n    certificate_pem: NATIVEAPPTEMPLATEAPI_ORIGIN_CERT\n");

    const stats = await runRuby<{ renamePlan: { from: string; to: string }[]; root: string }, { files_changed: number }>(
      "rename.rb",
      { renamePlan: [{ from: "Nativeapptemplateapi", to: "VetClinicApi" }], root },
    );
    assert.equal(stats.files_changed, 2);

    // Expected forms follow rename.rb's case rules for Nativeapptemplateapi -> VetClinicApi:
    // snake_case token vet_clinic_api, and the upper case of that, VET_CLINIC_API
    // (a one-word `from` has a single lower-case spelling; see build_patterns).
    const secrets = readFileSync(join(root, ".kamal/secrets"), "utf8");
    const deploy = readFileSync(join(root, "config/deploy.yml"), "utf8");
    assert.equal(secrets, "POSTGRES_PASSWORD=$VET_CLINIC_API_POSTGRES_PASSWORD\nVET_CLINIC_API_ORIGIN_CERT=$(cat $HOME/.config/vet_clinic_api/origin-cert.pem)\n");
    assert.equal(deploy, "proxy:\n  ssl:\n    certificate_pem: VET_CLINIC_API_ORIGIN_CERT\n");
  },
);

// --- self-repair loop (src/repair-loop.ts) ---

function platDetail(platform: Platform, l1: boolean, l2: boolean, l3?: boolean): PlatformDetail {
  return {
    platform,
    layer1: { pass: l1, findings: l1 ? [] : [{ token: "Shop", file: "X.kt", line: 1, text: "class Shop" }] },
    layer2: {
      pass: l2,
      command: "build",
      mode: "build",
      exitCode: l2 ? 0 : 1,
      durationMs: 10,
      ...(l2 ? {} : { stderrTail: "Unresolved reference: Shop" }),
    },
    ...(l3 !== undefined ? { layer3: { pass: l3 } } : {}),
  };
}

function passLayers(platform: Platform): RevalidateResult {
  return platDetail(platform, true, true);
}

test("runRepairLoop resolves a Layer 2 failure after one repair pass", async () => {
  const repaired: string[] = [];
  const deps: RepairLoopDeps = {
    repair: async (platform, layer) => {
      repaired.push(`${platform}/${layer}`);
      return { action: `patched ${platform}` };
    },
    revalidate: async (platform) => passLayers(platform),
  };
  const result = await runRepairLoop({
    platforms: [platDetail("rails", true, false)],
    reviewerPass: true,
    maxIterations: 5,
    deps,
  });
  assert.equal(result.attempts.length, 1);
  assert.deepEqual(result.attempts[0], {
    iteration: 1,
    failingLayer: "layer2",
    platform: "rails",
    action: "patched rails",
    resolved: true,
  });
  assert.equal(result.overallPass, true);
  assert.match(result.summary, /Layer 2 1\/1 pass/);
  assert.deepEqual(repaired, ["rails/layer2"]);
});

test("runRepairLoop gives up after the cap when repair never resolves", async () => {
  let repairCalls = 0;
  const deps: RepairLoopDeps = {
    repair: async () => {
      repairCalls += 1;
      return { action: "tried" };
    },
    // Never fixes anything — layer1 stays failing.
    revalidate: async (platform) => platDetail(platform, false, true),
  };
  const result = await runRepairLoop({
    platforms: [platDetail("android", false, true)],
    reviewerPass: true,
    maxIterations: 5,
    deps,
  });
  assert.equal(result.attempts.length, 5);
  assert.equal(repairCalls, 5);
  assert.ok(result.attempts.every((a) => a.failingLayer === "layer1" && a.resolved === false));
  assert.equal(result.overallPass, false);
});

test("runRepairLoop clamps maxIterations to the AGENTS.md cap of 5", async () => {
  const deps: RepairLoopDeps = {
    repair: async () => ({ action: "x" }),
    revalidate: async (platform) => platDetail(platform, false, true),
  };
  const result = await runRepairLoop({
    platforms: [platDetail("ios", false, true)],
    reviewerPass: true,
    maxIterations: 99,
    deps,
  });
  assert.equal(result.attempts.length, REPAIR_ITERATION_CAP);
});

test("runRepairLoop fixes Layer 1 before Layer 2 on a platform failing both", async () => {
  let call = 0;
  const deps: RepairLoopDeps = {
    repair: async (_platform, _layer, detail) => ({ action: `saw ${detail.platform}` }),
    revalidate: async (platform) => {
      call += 1;
      // First revalidate: layer1 now clean, layer2 still broken.
      // Second revalidate: both clean.
      return call === 1 ? platDetail(platform, true, false) : platDetail(platform, true, true);
    },
  };
  const result = await runRepairLoop({
    platforms: [platDetail("android", false, false)],
    reviewerPass: true,
    maxIterations: 5,
    deps,
  });
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0]?.failingLayer, "layer1");
  assert.equal(result.attempts[1]?.failingLayer, "layer2");
  assert.equal(result.overallPass, true);
});

test("runRepairLoop with a Layer 3 failure it can't repair surfaces FAIL and makes no attempts", async () => {
  let repairCalls = 0;
  const deps: RepairLoopDeps = {
    repair: async () => {
      repairCalls += 1;
      return { action: "should not run" };
    },
    revalidate: async (platform) => passLayers(platform),
  };
  // Layers 1 + 2 pass; only Layer 3 fails — not code-repairable here.
  const result = await runRepairLoop({
    platforms: [platDetail("rails", true, true), platDetail("ios", true, true, false)],
    reviewerPass: true,
    maxIterations: 5,
    deps,
  });
  assert.equal(repairCalls, 0);
  assert.equal(result.attempts.length, 0);
  assert.equal(result.overallPass, false);
});

test("buildRunReport carries repairAttempts and renderReport shows the self-repair section", () => {
  const report = buildRunReport({
    spec: "a vet clinic queue",
    domain: reportDomain,
    judge: mixedJudge(),
    reviewer: failReviewer,
    agentVersion: "9.9.9",
    judgeModel: "claude-opus-5-5",
    visualLevel: 1,
    startedAt: 1000,
    finishedAt: 4000,
    repairAttempts: [
      { iteration: 1, failingLayer: "layer2", platform: "android", action: "added missing Hilt @Provides", resolved: true },
    ],
  });
  assert.equal(report.repairAttempts?.length, 1);
  const html = renderReport(report);
  assert.ok(html.includes("Self-repair"), "repair section heading present");
  assert.ok(html.includes("added missing Hilt @Provides"), "repair action rendered");
});

test("buildRunReport omits repairAttempts when none were made", () => {
  const report = buildRunReport({
    spec: "x",
    domain: reportDomain,
    judge: mixedJudge(),
    reviewer: failReviewer,
    agentVersion: "1.0.0",
    judgeModel: "claude-opus-5-5",
    visualLevel: 0,
    startedAt: 0,
    finishedAt: 1,
    repairAttempts: [],
  });
  assert.equal(report.repairAttempts, undefined);
  assert.ok(!renderReport(report).includes("Self-repair"));
});

// --- CLI flags that must never start a generation run ---

test("parseArgs treats --version/-v and --help/-h as actions, not spec text", async () => {
  const { parseArgs } = await import("../src/index.js");
  for (const flag of ["--version", "-v"]) {
    const parsed = parseArgs([flag]);
    assert.equal(parsed.action, "version");
    assert.equal(parsed.spec, "");
  }
  for (const flag of ["--help", "-h"]) {
    const parsed = parseArgs([flag]);
    assert.equal(parsed.action, "help");
    assert.equal(parsed.spec, "");
  }
});

test("parseArgs rejects an unknown flag instead of folding it into the spec", async () => {
  const { parseArgs } = await import("../src/index.js");
  const parsed = parseArgs(["a", "spec", "--no-reprot"]);
  assert.equal(parsed.spec, "a spec");
  assert.deepEqual(parsed.errors, ['unknown option "--no-reprot"']);
});

test("CLI --version prints the package version and never dispatches", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cli-version-"));
  const entry = join(process.cwd(), "src", "index.ts");
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), entry, "--version"], {
    cwd,
    env: { ...process.env, NATIVEAPPTEMPLATE_STUB_ALL: "1" },
    encoding: "utf8",
  });
  // Expected value comes from package.json, the published version source of truth.
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string };
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), pkg.version);
  assert.equal(spawnSync("test", ["-e", join(cwd, "out")]).status, 1, "a version query must not create out/");
});

// --- substrate copy (src/agents/workers/copy.ts) ---

test("copySubstrate honors root skip paths even when the substrate path has a trailing slash", async () => {
  const { copySubstrate } = await import("../src/agents/workers/copy.js");
  const base = mkdtempSync(join(tmpdir(), "copy-slash-"));
  const src = join(base, "src");
  mkdirSync(join(src, ".git"), { recursive: true });
  writeFileSync(join(src, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(src, "keep.txt"), "x");
  const dest = join(base, "dest");
  await copySubstrate(`${src}/`, dest, { rootPaths: [".git"] });
  assert.equal(readFileSync(join(dest, "keep.txt"), "utf8"), "x");
  assert.equal(spawnSync("test", ["-e", join(dest, ".git")]).status, 1, ".git must not be copied");
});

test("copySubstrate keeps relative symlinks relative so they never point back into the substrate", async () => {
  const { copySubstrate } = await import("../src/agents/workers/copy.js");
  const { symlinkSync, readlinkSync } = await import("node:fs");
  const base = mkdtempSync(join(tmpdir(), "copy-link-"));
  const src = join(base, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "real.swift"), "Shop");
  symlinkSync("real.swift", join(src, "link.swift"));
  const dest = join(base, "dest");
  await copySubstrate(src, dest, {});
  assert.equal(readlinkSync(join(dest, "link.swift")), "real.swift");
});

// --- rename.rb edge cases ---

async function runRenameFixture(files: Record<string, string | Buffer>, renamePlan: { from: string; to: string }[], extra: Record<string, unknown> = {}) {
  const { runRuby } = await import("../src/ruby.js");
  const root = mkdtempSync(join(tmpdir(), "rename-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  await runRuby("rename.rb", { renamePlan, root, ...extra });
  return root;
}

test("rename.rb renames each source token exactly once (no cascade into a later pair)", { skip: !RUBY_AVAILABLE }, async () => {
  // Plan from `--project-name "Pet Shop"` + Shop→Store: NativeAppTemplate→PetShop must not
  // then be rewritten by the Shop→Store pair. Hand-derived: each original token maps once.
  const root = await runRenameFixture(
    { "a.swift": "NativeAppTemplate Shop native_app_template shop" },
    [{ from: "NativeAppTemplate", to: "PetShop" }, { from: "Shop", to: "Store" }],
  );
  assert.equal(readFileSync(join(root, "a.swift"), "utf8"), "PetShop Store pet_shop store");
});

test("rename.rb skips a non-UTF-8 text file instead of aborting the whole rename", { skip: !RUBY_AVAILABLE }, async () => {
  const latin1 = Buffer.from([0x53, 0x68, 0x6f, 0x70, 0x20, 0xe9]); // "Shop é" in Latin-1
  const root = await runRenameFixture(
    { "Latin.strings": latin1, "b.swift": "Shop" },
    [{ from: "Shop", to: "Clinic" }],
  );
  assert.equal(readFileSync(join(root, "b.swift"), "utf8"), "Clinic");
  assert.deepEqual(readFileSync(join(root, "Latin.strings")), latin1);
});

test("rename.rb never writes through a symlink to a file outside the tree", { skip: !RUBY_AVAILABLE }, async () => {
  const { symlinkSync } = await import("node:fs");
  const outside = mkdtempSync(join(tmpdir(), "rename-outside-"));
  writeFileSync(join(outside, "real.swift"), "Shop");
  const root = mkdtempSync(join(tmpdir(), "rename-link-"));
  symlinkSync(join(outside, "real.swift"), join(root, "linked.swift"));
  const { runRuby } = await import("../src/ruby.js");
  await runRuby("rename.rb", { renamePlan: [{ from: "Shop", to: "Clinic" }], root });
  assert.equal(readFileSync(join(outside, "real.swift"), "utf8"), "Shop");
});

// The product pairs buildProductRenamePairs("orange-baton") produces, plus two domain pairs.
const ORANGE_BATON_PLAN = [
  { from: "Nativeapptemplateapi", to: "OrangeBatonApi" },
  { from: "NativeAppTemplate", to: "OrangeBaton" },
  { from: "Nativeapptemplate", to: "OrangeBaton" },
  { from: "ItemTag", to: "Baton" },
  { from: "Shop", to: "Project" },
];

test("rename.rb leaves links to the template's GitHub repos and the agent's name unchanged (#155)", { skip: !RUBY_AVAILABLE }, async () => {
  // Protected spans (github.com/nativeapptemplate/<repo>... and nativeapptemplate-agent[-mcp])
  // must survive byte-for-byte, Shop / ItemTag in their paths included. Everything outside
  // them follows the usual rules: NativeAppTemplate -> OrangeBaton, ItemTag -> Baton,
  // flat nativeapptemplate -> orangebaton (so the domain and email become the app's own,
  // as in out/orange-baton: support@orangebaton.com), shops -> projects.
  const protectedLines = [
    "https://github.com/nativeapptemplate/NativeAppTemplate-iOS/blob/main/NativeAppTemplate/Data/Repositories/ItemTagRepository.swift",
    "[issues](https://github.com/nativeapptemplate/nativeapptemplateapi/issues)",
    "github.com/nativeapptemplate/nativeapptemplate-agent/blob/main/docs/SUBSTRATE-CONTRACT.md",
    "https://github.com/nativeapptemplate/NativeAppTemplate-Free-Android/pull/12",
    "git clone git@github.com:nativeapptemplate/NativeAppTemplate-Android.git",
    "<text>github.com/nativeapptemplate/nativeapptemplateapi</text>",
    "nativeapptemplate-agent renames it; so does nativeapptemplate-agent-mcp.",
  ];
  const root = await runRenameFixture(
    {
      "README.md": [
        ...protectedLines,
        "See https://github.com/nativeapptemplate/NativeAppTemplate-iOS for the NativeAppTemplate ItemTag list.",
        "nativeapptemplate-agent turns each Shop into whatever you name it.",
        "Mail support@nativeapptemplate.com or visit https://api.nativeapptemplate.com/shops",
      ].join("\n"),
    },
    ORANGE_BATON_PLAN,
  );
  assert.deepEqual(readFileSync(join(root, "README.md"), "utf8").split("\n"), [
    ...protectedLines,
    "See https://github.com/nativeapptemplate/NativeAppTemplate-iOS for the OrangeBaton Baton list.",
    "nativeapptemplate-agent turns each Project into whatever you name it.",
    "Mail support@orangebaton.com or visit https://api.orangebaton.com/projects",
  ]);
  // Layer 1 must accept what rename.rb protected (the two mirrored patterns agree).
  const layer1 = await runLayer1({ projectDir: root, forbiddenTokens: ORANGE_BATON_PLAN.map((p) => p.from) });
  assert.deepEqual(layer1.findings, []);
});

test("rename.rb still renames file and directory paths next to protected references (#155)", { skip: !RUBY_AVAILABLE }, async () => {
  const root = await runRenameFixture(
    { "NativeAppTemplate/ShopView.swift": "// https://github.com/nativeapptemplate/NativeAppTemplate-iOS\nstruct ShopView {}\n" },
    ORANGE_BATON_PLAN,
  );
  assert.equal(
    readFileSync(join(root, "OrangeBaton", "ProjectView.swift"), "utf8"),
    "// https://github.com/nativeapptemplate/NativeAppTemplate-iOS\nstruct ProjectView {}\n",
  );
});

// --- app domain (#157, src/app-domain.ts, rename.rb appDomain) ---

// Excerpts of the three templates, as they spell the domain and the reverse-DNS
// prefix (config/settings.yml, devices_controller_test.rb, project.pbxproj,
// Constants.swift, build.gradle.kts, Kotlin sources in app/ and model/, the
// datastore protos, google-services.json).
const DOMAIN_FIXTURE: Record<string, string> = {
  "config/settings.yml": "domain: nativeapptemplate.com\nurl: https://nativeapptemplate.com\nsupport_with_name: Native App Template <support@nativeapptemplate.com>\napi: api.nativeapptemplate.com\n",
  "test/devices_controller_test.rb": 'apple = "com.nativeapptemplate.example"\ngoogle = "com.nativeapptemplate.nativeapptemplate"\n',
  "README.md": "[repo](https://github.com/nativeapptemplate/NativeAppTemplate-Android) · mail support@nativeapptemplate.com.\n",
  "NativeAppTemplate.xcodeproj/project.pbxproj": 'PRODUCT_BUNDLE_IDENTIFIER = "com.nativeapptemplate.NativeAppTemplate.ios${SAMPLE_CODE_DISAMBIGUATOR}";\nPRODUCT_BUNDLE_IDENTIFIER = com.nativeapptemplate.NativeAppTemplateTests;\n',
  "NativeAppTemplate/Constants.swift": 'let keychainService = "com.nativeapptemplate.NativeAppTemplate.DevicePushIdService"\nlet subsystem = "com.nativeapptemplate"\nlet production = "api.nativeapptemplate.com"\n',
  "app/build.gradle.kts": 'applicationId = "com.nativeapptemplate.nativeapptemplate"\nnamespace = "com.nativeapptemplate.nativeapptemplate"\nval domain = "api.nativeapptemplate.com"\n',
  "model/build.gradle.kts": 'namespace = "com.nativeapptemplate.nativeapptemplate.model"\n',
  "app/src/main/kotlin/com/nativeapptemplate/nativeapptemplate/ui/shops/ShopListView.kt": "package com.nativeapptemplate.nativeapptemplate.ui.shops\n\nimport com.nativeapptemplate.nativeapptemplate.model.Shop\n",
  "app/src/test/kotlin/com/nativeapptemplate/nativeapptemplate/HardcodedUiStringsTest.kt": 'package com.nativeapptemplate.nativeapptemplate\nval uiSources = File("src/main/kotlin/com/nativeapptemplate/nativeapptemplate/ui")\n',
  "app/src/androidTest/kotlin/com/nativeapptemplate/nativeapptemplate/LaunchTest.kt": "package com.nativeapptemplate.nativeapptemplate\n",
  "model/src/main/kotlin/com/nativeapptemplate/nativeapptemplate/model/Shop.kt": "package com.nativeapptemplate.nativeapptemplate.model\n",
  "datastore-proto/src/main/proto/user_preferences.proto": 'option java_package = "com.nativeapptemplate.nativeapptemplate";\n',
  "app/google-services.json": '{ "package_name": "com.nativeapptemplate.nativeapptemplate" }\n',
  // Finder litters a template working tree with these.
  "app/src/main/kotlin/com/.DS_Store": "",
};

function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, r);
      else out[r] = readFileSync(full, "utf8");
    }
  };
  walk(root, "");
  return out;
}

async function renameAppDomainInputFor(domain: string) {
  const { renameAppDomainInput } = await import("../src/app-domain.js");
  return renameAppDomainInput("orange-baton", domain);
}

test("validateAppDomain lowercases a domain and rejects what isn't one, with the reason", async () => {
  const { validateAppDomain } = await import("../src/app-domain.js");
  assert.deepEqual(validateAppDomain(" OrangeBaton.App "), { ok: true, domain: "orangebaton.app" });
  assert.deepEqual(validateAppDomain("api.orange-baton.co.uk"), { ok: true, domain: "api.orange-baton.co.uk" });
  const reasons: Array<[string, RegExp]> = [
    ["", /empty/],
    ["orangebaton", /at least two labels/],
    ["https://orangebaton.app", /bare domain/],
    ["orangebaton.app/path", /bare domain/],
    ["support@orangebaton.app", /bare domain/],
    ["orange..app", /an empty label/],
    ["orangebaton.app.", /an empty label/],
    ["-orange.app", /label "-orange"/],
    ["orange-.app", /label "orange-"/],
    ["orange_baton.app", /label "orange_baton"/],
    [`${"a".repeat(64)}.app`, /label "a{64}"/],
    ["10.0.0.1", /numeric label/],
    ["1password.com", /starts with a digit/],
  ];
  for (const [raw, reason] of reasons) {
    const check = validateAppDomain(raw);
    assert.equal(check.ok, false, raw);
    if (!check.ok) assert.match(check.error, reason, raw);
  }
});

test("javaPackageSegment maps a DNS label to a Java/Kotlin package segment", async () => {
  const { javaPackageSegment } = await import("../src/app-domain.js");
  // JLS §6.1: hyphen -> underscore, reserved word -> trailing underscore.
  assert.equal(javaPackageSegment("orangebaton"), "orangebaton");
  assert.equal(javaPackageSegment("orange-baton"), "orange_baton");
  assert.equal(javaPackageSegment("native"), "native_");
  assert.equal(javaPackageSegment("int"), "int_");
  assert.equal(javaPackageSegment("true"), "true_");
  // Kotlin hard keyword: `package app.fun.x` doesn't compile.
  assert.equal(javaPackageSegment("fun"), "fun_");
  assert.equal(javaPackageSegment("app"), "app");
});

test("appIdentifiers derives the reverse-DNS prefixes, and the default from the project name", async () => {
  const { appIdentifiers } = await import("../src/app-domain.js");
  assert.deepEqual(appIdentifiers("orange-baton"), {
    domain: "orangebaton.com", custom: false, bundleIdPrefix: "com.orangebaton", androidPackagePrefix: "com.orangebaton", androidRemapped: [],
  });
  assert.deepEqual(appIdentifiers("orange-baton", "orangebaton.app"), {
    domain: "orangebaton.app", custom: true, bundleIdPrefix: "app.orangebaton", androidPackagePrefix: "app.orangebaton", androidRemapped: [],
  });
  assert.deepEqual(appIdentifiers("orange-baton", "orange-baton.native.app"), {
    domain: "orange-baton.native.app",
    custom: true,
    bundleIdPrefix: "app.native.orange-baton",
    androidPackagePrefix: "app.native_.orange_baton",
    androidRemapped: [{ label: "native", segment: "native_" }, { label: "orange-baton", segment: "orange_baton" }],
  });
});

test("bundleIdFromPbxproj / applicationIdFromGradle read the app's identifier back", async () => {
  const { bundleIdFromPbxproj, applicationIdFromGradle } = await import("../src/app-domain.js");
  assert.equal(
    bundleIdFromPbxproj('PRODUCT_BUNDLE_IDENTIFIER = app.orangebaton.OrangeBatonTests;\nPRODUCT_BUNDLE_IDENTIFIER = "app.orangebaton.OrangeBaton.ios${SAMPLE_CODE_DISAMBIGUATOR}";\n'),
    "app.orangebaton.OrangeBaton.ios",
  );
  assert.equal(applicationIdFromGradle('    applicationId = "app.orangebaton.orangebaton"\n'), "app.orangebaton.orangebaton");
  assert.equal(applicationIdFromGradle("android {}"), undefined);
});

test("rename.rb without appDomain keeps the default domain and reverse-DNS prefix (#157)", { skip: !RUBY_AVAILABLE }, async () => {
  // Today's rename: the flat product rule turns nativeapptemplate into orangebaton.
  const root = await runRenameFixture(DOMAIN_FIXTURE, ORANGE_BATON_PLAN);
  const tree = readTree(root);
  assert.match(tree["config/settings.yml"]!, /^domain: orangebaton\.com$/m);
  assert.match(tree["config/settings.yml"]!, /<support@orangebaton\.com>/);
  assert.match(tree["OrangeBaton.xcodeproj/project.pbxproj"]!, /"com\.orangebaton\.OrangeBaton\.ios\$\{SAMPLE_CODE_DISAMBIGUATOR\}"/);
  assert.match(tree["app/build.gradle.kts"]!, /applicationId = "com\.orangebaton\.orangebaton"/);
  assert.ok(tree["app/src/main/kotlin/com/orangebaton/orangebaton/ui/projects/ProjectListView.kt"]);
  // A domain equal to the default one renames exactly as no domain does.
  const same = await runRenameFixture(DOMAIN_FIXTURE, ORANGE_BATON_PLAN, await renameAppDomainInputFor("orangebaton.com"));
  assert.deepEqual(readTree(same), tree);
});

test("rename.rb with appDomain replaces the domain, subdomains and emails, and the iOS / Android identifiers (#157)", { skip: !RUBY_AVAILABLE }, async () => {
  const root = await runRenameFixture(DOMAIN_FIXTURE, ORANGE_BATON_PLAN, await renameAppDomainInputFor("orangebaton.app"));
  const tree = readTree(root);
  // Expected values: the issue's table with orangebaton.app -> app.orangebaton, the
  // rest of each identifier renamed as usual (NativeAppTemplate -> OrangeBaton,
  // flat nativeapptemplate -> orangebaton, shop(s) -> project(s), Shopkeeper untouched).
  assert.equal(tree["config/settings.yml"], "domain: orangebaton.app\nurl: https://orangebaton.app\nsupport_with_name: Orange Baton <support@orangebaton.app>\napi: api.orangebaton.app\n");
  assert.equal(tree["test/devices_controller_test.rb"], 'apple = "app.orangebaton.example"\ngoogle = "app.orangebaton.orangebaton"\n');
  assert.equal(tree["README.md"], "[repo](https://github.com/nativeapptemplate/NativeAppTemplate-Android) · mail support@orangebaton.app.\n");
  assert.equal(tree["OrangeBaton.xcodeproj/project.pbxproj"], 'PRODUCT_BUNDLE_IDENTIFIER = "app.orangebaton.OrangeBaton.ios${SAMPLE_CODE_DISAMBIGUATOR}";\nPRODUCT_BUNDLE_IDENTIFIER = app.orangebaton.OrangeBatonTests;\n');
  assert.equal(tree["OrangeBaton/Constants.swift"], 'let keychainService = "app.orangebaton.OrangeBaton.DevicePushIdService"\nlet subsystem = "app.orangebaton"\nlet production = "api.orangebaton.app"\n');
  assert.equal(tree["app/build.gradle.kts"], 'applicationId = "app.orangebaton.orangebaton"\nnamespace = "app.orangebaton.orangebaton"\nval domain = "api.orangebaton.app"\n');
  assert.equal(tree["model/build.gradle.kts"], 'namespace = "app.orangebaton.orangebaton.model"\n');
  assert.equal(tree["app/src/main/kotlin/app/orangebaton/orangebaton/ui/projects/ProjectListView.kt"], "package app.orangebaton.orangebaton.ui.projects\n\nimport app.orangebaton.orangebaton.model.Project\n");
  assert.equal(tree["app/src/test/kotlin/app/orangebaton/orangebaton/HardcodedUiStringsTest.kt"], 'package app.orangebaton.orangebaton\nval uiSources = File("src/main/kotlin/app/orangebaton/orangebaton/ui")\n');
  assert.equal(tree["app/src/androidTest/kotlin/app/orangebaton/orangebaton/LaunchTest.kt"], "package app.orangebaton.orangebaton\n");
  assert.equal(tree["model/src/main/kotlin/app/orangebaton/orangebaton/model/Project.kt"], "package app.orangebaton.orangebaton.model\n");
  assert.equal(tree["datastore-proto/src/main/proto/user_preferences.proto"], 'option java_package = "app.orangebaton.orangebaton";\n');
  assert.equal(tree["app/google-services.json"], '{ "package_name": "app.orangebaton.orangebaton" }\n');
  // The template's com/ package directories are gone, not left empty (nor holding only a .DS_Store).
  assert.ok(!existsSync(join(root, "app/src/main/kotlin/com")));
  assert.ok(!existsSync(join(root, "model/src/main/kotlin/com")));
  const layer1 = await runLayer1({ projectDir: root, forbiddenTokens: ORANGE_BATON_PLAN.map((p) => p.from) });
  assert.deepEqual(layer1.findings, []);
});

test("rename.rb writes the Android package with Java-safe segments and keeps hyphens in the iOS bundle ID (#157)", { skip: !RUBY_AVAILABLE }, async () => {
  const root = await runRenameFixture(DOMAIN_FIXTURE, ORANGE_BATON_PLAN, await renameAppDomainInputFor("orange-baton.app"));
  const tree = readTree(root);
  assert.match(tree["OrangeBaton.xcodeproj/project.pbxproj"]!, /"app\.orange-baton\.OrangeBaton\.ios\$/);
  assert.equal(tree["app/build.gradle.kts"], 'applicationId = "app.orange_baton.orangebaton"\nnamespace = "app.orange_baton.orangebaton"\nval domain = "api.orange-baton.app"\n');
  assert.equal(tree["app/src/main/kotlin/app/orange_baton/orangebaton/ui/projects/ProjectListView.kt"], "package app.orange_baton.orangebaton.ui.projects\n\nimport app.orange_baton.orangebaton.model.Project\n");
  assert.match(tree["app/src/test/kotlin/app/orange_baton/orangebaton/HardcodedUiStringsTest.kt"]!, /"src\/main\/kotlin\/app\/orange_baton\/orangebaton\/ui"/);
  assert.equal(tree["test/devices_controller_test.rb"], 'apple = "app.orange-baton.example"\ngoogle = "app.orange_baton.orangebaton"\n');
});

test("rename.rb doesn't rename a domain label that happens to be a rename token (#157)", { skip: !RUBY_AVAILABLE }, async () => {
  // shop.example with Shop -> Project: the domain is the user's, so example.shop stays.
  const root = await runRenameFixture(DOMAIN_FIXTURE, ORANGE_BATON_PLAN, await renameAppDomainInputFor("shop.example"));
  const tree = readTree(root);
  assert.equal(tree["app/src/main/kotlin/example/shop/orangebaton/ui/projects/ProjectListView.kt"], "package example.shop.orangebaton.ui.projects\n\nimport example.shop.orangebaton.model.Project\n");
  assert.match(tree["config/settings.yml"]!, /^api: api\.shop\.example$/m);
  assert.match(tree["OrangeBaton.xcodeproj/project.pbxproj"]!, /"example\.shop\.OrangeBaton\.ios\$/);
});

test("parseArgs takes --domain, lowercased, and reports an invalid one as an error", async () => {
  const { parseArgs } = await import("../src/index.js");
  assert.equal(parseArgs(["a queue", "--domain=OrangeBaton.app"]).domain, "orangebaton.app");
  assert.equal(parseArgs(["a queue", "--domain", "orangebaton.app"]).domain, "orangebaton.app");
  assert.equal(parseArgs(["a queue"]).domain, undefined);
  const bad = parseArgs(["a queue", "--domain=orangebaton"]);
  assert.equal(bad.domain, undefined);
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0]!, /--domain "orangebaton" needs at least two labels/);
});

test("generate_app rejects an invalid domain with the same message, and passes a valid one through", async () => {
  const { createMcpServer } = await import("../src/mcp.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const bad = await client.callTool({ name: "generate_app", arguments: { spec: "a queue", domain: "https://orangebaton.app" } });
  assert.equal(bad.isError, true);
  assert.match(JSON.stringify(bad.content), /--domain \\"https:\/\/orangebaton.app\\" is not a bare domain/);

  const good = await client.callTool({ name: "generate_app", arguments: { spec: "a queue", projectName: "Orange Baton", domain: "Orange-Baton.app" } });
  const sc = good.structuredContent as { report?: { meta?: { appDomain?: unknown } } };
  assert.deepEqual(sc.report?.meta?.appDomain, {
    domain: "orange-baton.app",
    custom: true,
    bundleIdPrefix: "app.orange-baton",
    androidPackagePrefix: "app.orange_baton",
    androidRemapped: [{ label: "orange-baton", segment: "orange_baton" }],
  });
  await client.close();
  await server.close();
});

// #160: --visual / --tests per run. Precedence (issue): a flag wins over
// NATIVEAPPTEMPLATE_VISUAL / _TESTS; without one, the env decides as before.
test("parseArgs takes --visual (= and space forms) and --tests / --no-tests", async () => {
  const { parseArgs } = await import("../src/index.js");
  assert.equal(parseArgs(["a queue", "--visual=2"]).visual, 2);
  assert.equal(parseArgs(["a queue", "--visual", "1"]).visual, 1);
  assert.equal(parseArgs(["a queue", "--visual=0"]).visual, 0);
  const none = parseArgs(["a queue"]);
  assert.equal(none.visual, undefined);
  assert.equal(none.tests, undefined);
  assert.equal(parseArgs(["a queue", "--tests"]).tests, true);
  assert.equal(parseArgs(["a queue", "--no-tests"]).tests, false);
  const both = parseArgs(["a", "queue", "--visual", "2", "--tests"]);
  assert.equal(both.spec, "a queue");
  assert.deepEqual(both.errors, []);
});

test("parseArgs rejects an invalid --visual value as an error (exit 2)", async () => {
  const { parseArgs } = await import("../src/index.js");
  for (const [args, shown] of [[["--visual=3"], '"3"'], [["--visual=high"], '"high"'], [["--visual="], '""'], [["--visual"], "nothing"]] as const) {
    const parsed = parseArgs(["a queue", ...args]);
    assert.equal(parsed.visual, undefined, args.join(" "));
    assert.deepEqual(parsed.errors, [`--visual must be 0, 1, or 2 (got ${shown})`]);
  }
});

test("resolveVisualLevel / resolveTests: a flag wins over the environment, which decides without one", async () => {
  const { resolveVisualLevel, resolveTests } = await import("../src/run-options.js");
  const env = { NATIVEAPPTEMPLATE_VISUAL: "2", NATIVEAPPTEMPLATE_TESTS: "1" };
  assert.equal(resolveVisualLevel(0, env), 0);
  assert.equal(resolveVisualLevel(undefined, env), 2);
  assert.equal(resolveVisualLevel(undefined, {}), 0);
  assert.equal(resolveVisualLevel(1, {}), 1);
  assert.equal(resolveVisualLevel(undefined, { NATIVEAPPTEMPLATE_VISUAL: "3" }), 0); // unchanged env reading
  assert.equal(resolveTests(false, env), false);
  assert.equal(resolveTests(undefined, env), true);
  assert.equal(resolveTests(undefined, {}), false);
  assert.equal(resolveTests(true, {}), true);
});

test("dispatch: options.visual / options.tests override the environment and run the preflight first", async () => {
  const saved = { v: process.env['NATIVEAPPTEMPLATE_VISUAL'], t: process.env['NATIVEAPPTEMPLATE_TESTS'] };
  process.env['NATIVEAPPTEMPLATE_VISUAL'] = "2";
  process.env['NATIVEAPPTEMPLATE_TESTS'] = "1";
  try {
    const levels: number[] = [];
    const preflight = async (level: number) => { levels.push(level); };
    const off = await dispatch("a walk-in clinic queue for vets", { visual: 0, tests: false, preflight });
    assert.equal(off.report.meta.visualLevel, 0);
    assert.equal(off.report.meta.tests, undefined);
    assert.deepEqual(levels, []); // level 0: no preflight
    const env = await dispatch("a walk-in clinic queue for vets", { preflight });
    assert.equal(env.report.meta.visualLevel, 2);
    assert.equal(env.report.meta.tests, true);
    assert.deepEqual(levels, [2]);
  } finally {
    if (saved.v !== undefined) process.env['NATIVEAPPTEMPLATE_VISUAL'] = saved.v; else delete process.env['NATIVEAPPTEMPLATE_VISUAL'];
    if (saved.t !== undefined) process.env['NATIVEAPPTEMPLATE_TESTS'] = saved.t; else delete process.env['NATIVEAPPTEMPLATE_TESTS'];
  }
});

test("dispatch stops on a failed preflight instead of running the pipeline", async () => {
  const { PreflightError } = await import("../src/preflight.js");
  let planned = false;
  await assert.rejects(
    dispatch("a walk-in clinic queue for vets", {
      visual: 1,
      preflight: async (level) => { throw new PreflightError(level, ["no iOS simulator is booted."]); },
      report: { enabled: false },
    }).then(() => { planned = true; }),
    (err: unknown) => err instanceof PreflightError && /visual level 1 needs[\s\S]*- no iOS simulator is booted\./.test(err.message),
  );
  assert.equal(planned, false);
});

test("preflightVisual reports each missing device / tool, with mocked simctl, adb and mise", async () => {
  const { preflightVisual } = await import("../src/preflight.js");
  const sim = { udid: "6136DF2C-DBC4-4B8D-B454-84B1A1E3ECA5", name: "iPhone 17 Pro" };
  const deps = (o: { sims?: { udid: string; name: string }[]; serials?: string[]; mise?: boolean; adbError?: string }) => ({
    bootedIosSimulators: async () => ({ ok: true as const, items: o.sims ?? [sim] }),
    adbDevices: async () => (o.adbError ? { ok: false as const, error: o.adbError } : { ok: true as const, items: o.serials ?? ["emulator-5554"] }),
    hasMise: async () => o.mise ?? true,
  });
  assert.deepEqual(await preflightVisual(0, deps({ sims: [], serials: [], mise: false }), {}), []);
  assert.deepEqual(await preflightVisual(1, deps({ mise: false }), {}), []); // level 1 doesn't need mise
  assert.deepEqual(await preflightVisual(2, deps({}), {}), []);

  const none = await preflightVisual(2, deps({ sims: [], serials: [], mise: false }), {});
  assert.equal(none.length, 3);
  assert.match(none[0]!, /^no iOS simulator is booted/);
  assert.match(none[1]!, /^no Android emulator or device is attached/);
  assert.match(none[2]!, /^`mise` isn't on PATH/);

  const adbBroken = await preflightVisual(1, deps({ adbError: "spawn adb ENOENT" }), {});
  assert.deepEqual(adbBroken, ["couldn't list Android devices (adb devices): spawn adb ENOENT"]);

  // Overrides: the variables Stage 1/2 target must name a live device.
  assert.deepEqual(await preflightVisual(1, deps({}), { NATIVEAPPTEMPLATE_MOBILE_IOS_DEVICE: "iPhone 17 Pro", NATIVEAPPTEMPLATE_ADB_SERIAL: "emulator-5554" }), []);
  assert.deepEqual(await preflightVisual(1, deps({}), { NATIVEAPPTEMPLATE_MOBILE_IOS_DEVICE: sim.udid }), []);
  const wrong = await preflightVisual(1, deps({ serials: ["1C081FDF600CMG"] }), { NATIVEAPPTEMPLATE_MOBILE_IOS_DEVICE: "iPhone 16", NATIVEAPPTEMPLATE_ADB_SERIAL: "emulator-5554" });
  assert.equal(wrong.length, 2);
  assert.match(wrong[0]!, /NATIVEAPPTEMPLATE_MOBILE_IOS_DEVICE="iPhone 16" is not a booted simulator \(booted: iPhone 17 Pro \(6136DF2C/);
  assert.match(wrong[1]!, /NATIVEAPPTEMPLATE_ADB_SERIAL="emulator-5554" is not attached \(adb devices: 1C081FDF600CMG\)/);
});

test("parseBootedIosSimulators keeps booted iOS simulators only", async () => {
  const { parseBootedIosSimulators } = await import("../src/preflight.js");
  const json = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.watchOS-26-2": [{ udid: "W", name: "Apple Watch", state: "Booted" }],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-2": [
        { udid: "A", name: "iPhone 17 Pro", state: "Booted" },
        { udid: "B", name: "iPhone 17", state: "Shutdown" },
      ],
    },
  });
  assert.deepEqual(parseBootedIosSimulators(json), [{ udid: "A", name: "iPhone 17 Pro" }]);
});

test("generate_app passes visual / tests to that call only (no process.env leakage)", async () => {
  const { createMcpServer } = await import("../src/mcp.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const seen: unknown[] = [];
  const recordingDispatch: typeof dispatch = async (spec, options) => {
    seen.push(options ?? {});
    return dispatch(spec, { ...options, preflight: async () => {} });
  };
  const savedVisual = process.env['NATIVEAPPTEMPLATE_VISUAL'];
  const savedTests = process.env['NATIVEAPPTEMPLATE_TESTS'];
  delete process.env['NATIVEAPPTEMPLATE_VISUAL'];
  delete process.env['NATIVEAPPTEMPLATE_TESTS'];
  const server = createMcpServer({ dispatch: recordingDispatch });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const first = await client.callTool({ name: "generate_app", arguments: { spec: "a queue", visual: 2, tests: true } });
    const second = await client.callTool({ name: "generate_app", arguments: { spec: "a queue" } });
    assert.deepEqual(seen, [{ visual: 2, tests: true }, {}]);
    const meta = (r: typeof first) => (r.structuredContent as { report: { meta: { visualLevel: number; tests?: boolean } } }).report.meta;
    assert.equal(meta(first).visualLevel, 2);
    assert.equal(meta(first).tests, true);
    assert.equal(meta(second).visualLevel, 0);
    assert.equal(meta(second).tests, undefined);
    assert.equal(process.env['NATIVEAPPTEMPLATE_VISUAL'], undefined);
    assert.equal(process.env['NATIVEAPPTEMPLATE_TESTS'], undefined);

    const bad = await client.callTool({ name: "generate_app", arguments: { spec: "a queue", visual: 3 } });
    assert.equal(bad.isError, true);
    assert.equal(seen.length, 2); // rejected by the schema, never dispatched
  } finally {
    await client.close();
    await server.close();
    if (savedVisual !== undefined) process.env['NATIVEAPPTEMPLATE_VISUAL'] = savedVisual;
    if (savedTests !== undefined) process.env['NATIVEAPPTEMPLATE_TESTS'] = savedTests;
  }
});

test("generate_app turns a failed preflight into an error result", async () => {
  const { createMcpServer } = await import("../src/mcp.js");
  const { PreflightError } = await import("../src/preflight.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const server = createMcpServer({
    dispatch: async (spec, options) => dispatch(spec, { ...options, preflight: async (level) => { throw new PreflightError(level, ["no Android emulator or device is attached."]); } }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.callTool({ name: "generate_app", arguments: { spec: "a queue", visual: 1 } });
    assert.equal(res.isError, true);
    assert.match(JSON.stringify(res.content), /visual level 1 needs[^"]*no Android emulator or device is attached\.[^"]*Nothing was generated/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("renderReport shows the app's domain and identifiers", () => {
  const report = buildRunReport({
    spec: "a vet clinic queue",
    domain: { ...reportDomain, appDomain: "vet-clinic.app" },
    judge: mixedJudge(),
    reviewer: failReviewer,
    agentVersion: "9.9.9",
    judgeModel: "claude-opus-5-5",
    visualLevel: 0,
    startedAt: 1000,
    finishedAt: 4000,
    appIds: { ios: "app.vet-clinic.VetClinic.ios", android: "app.vet_clinic.vetclinic" },
  });
  assert.deepEqual(report.meta.appDomain, {
    domain: "vet-clinic.app",
    custom: true,
    bundleIdPrefix: "app.vet-clinic",
    androidPackagePrefix: "app.vet_clinic",
    androidRemapped: [{ label: "vet-clinic", segment: "vet_clinic" }],
    iosBundleId: "app.vet-clinic.VetClinic.ios",
    androidApplicationId: "app.vet_clinic.vetclinic",
  });
  const html = renderReport(report);
  assert.match(html, /<span>domain: vet-clinic\.app<\/span>/);
  assert.match(html, /iOS bundle ID<\/td><td><code class="inline">app\.vet-clinic\.VetClinic\.ios</);
  assert.match(html, /Android applicationId \/ package<\/td><td><code class="inline">app\.vet_clinic\.vetclinic</);
  assert.match(html, /vet-clinic<\/code> → <code class="inline">vet_clinic/);
  const byDefault = buildRunReport({ spec: "x", domain: reportDomain, judge: mixedJudge(), reviewer: failReviewer, agentVersion: "9", judgeModel: "m", visualLevel: 0, startedAt: 0, finishedAt: 0 });
  assert.match(renderReport(byDefault), /<span>domain: vetclinic\.com \(default\)<\/span>/);
});

test("runRuby rejects (instead of crashing the process) when ruby is not on PATH", async () => {
  const { runRuby } = await import("../src/ruby.js");
  const realPath = process.env['PATH'];
  process.env['PATH'] = "/nonexistent";
  try {
    await assert.rejects(runRuby("rename.rb", { renamePlan: [], root: tmpdir() }), /ENOENT|ruby/);
  } finally {
    process.env['PATH'] = realPath;
  }
});

test("env-bridge: syncGradleProperties creates ~/.gradle when it does not exist yet", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "env-bridge-nogradle-"));
  const realHome = process.env['HOME'];
  process.env['HOME'] = fakeHome;
  try {
    const { syncGradleProperties } = await import("../src/env-bridge.js");
    const r = await syncGradleProperties({ values: { PETSHOP_API_PORT: "3000" } });
    assert.equal(r.mode, "wrote");
    assert.match(readFileSync(join(fakeHome, ".gradle", "gradle.properties"), "utf8"), /^PETSHOP_API_PORT=3000$/m);
  } finally {
    if (realHome !== undefined) process.env['HOME'] = realHome;
    else delete process.env['HOME'];
  }
});

// --- MCP stdout safety, Stage 1/2 error isolation, report assets, Rails port, reviewer ---

test("runLayer2 build mode never writes child output to stdout (the MCP JSON-RPC channel)", () => {
  const outDir = mkdtempSync(join(tmpdir(), "layer2-stdout-"));
  writeFileSync(join(outDir, "gradlew"), "#!/bin/sh\necho GRADLE-STDOUT-MARKER\n", { mode: 0o755 });
  const layer2 = join(process.cwd(), "src", "validation", "layer2.ts");
  const script = `const m = await import(${JSON.stringify(layer2)}); const r = await m.runLayer2({ platform: "android", outDir: ${JSON.stringify(outDir)}, mode: "build" }); process.stderr.write("PASS=" + r.pass);`;
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.match(r.stderr, /PASS=true/);
  assert.doesNotMatch(r.stdout, /GRADLE-STDOUT-MARKER/);
});

test("judgeWithRetry turns a judge exception into a recorded failure instead of rejecting", async () => {
  const r = await judgeWithRetry(
    { settleCapture: async () => ({ ok: true }), judge: async () => { throw new Error("529 overloaded"); } },
    { maxRetries: 1 },
  );
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /vision judge failed: 529 overloaded/);
});

async function fakeMobileClient(platform: "ios" | "android") {
  const { attachMobileClient } = await import("../src/mobile.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { z } = await import("zod");
  const fake = new McpServer({ name: `fake-${platform}`, version: "0.0.0" });
  const device = platform === "ios" ? { name: "iPhone 17", platform: "ios" } : { name: "emulator-5554", platform: "android" };
  fake.registerTool("mobile_list_available_devices", { description: "fake", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: JSON.stringify([device]) }] }));
  fake.registerTool("mobile_list_elements_on_screen", { description: "fake", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: JSON.stringify([{ label: "Idled", x: 1, y: 1, width: 1, height: 1 }]) }] }));
  fake.registerTool("mobile_save_screenshot", { description: "fake", inputSchema: { saveTo: z.string() } },
    async (args) => { writeFileSync(args.saveTo, platform); return { content: [] }; });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([fake.connect(serverTransport), client.connect(clientTransport)]);
  const mobile = attachMobileClient(client);
  return { mobile, close: async () => { await mobile.close(); await fake.close(); } };
}

const shotScenario = { name: "queue-crud-x", steps: [{ kind: "screenshot" as const, label: "home" }] };

test("runStage2Visual keeps iOS and Android screenshots apart when scenario names match", async () => {
  const { runStage2Visual } = await import("../src/validation/stage2-judge.js");
  const ios = await fakeMobileClient("ios");
  const android = await fakeMobileClient("android");
  try {
    const result = await runStage2Visual({
      spec: "x",
      iosScenario: shotScenario,
      androidScenario: shotScenario,
      screenshotDir: mkdtempSync(join(tmpdir(), "stage2-collide-")),
      iosClient: ios.mobile,
      androidClient: android.mobile,
    });
    const iosShot = result.ios?.representativeScreenshot;
    const androidShot = result.android?.representativeScreenshot;
    assert.ok(iosShot && androidShot);
    assert.notEqual(iosShot, androidShot);
    assert.equal(readFileSync(iosShot, "utf8"), "ios");
  } finally {
    await ios.close();
    await android.close();
  }
});

test("runStage2Visual records one platform's judge error without losing the other platform", async () => {
  const { runStage2Visual } = await import("../src/validation/stage2-judge.js");
  const ios = await fakeMobileClient("ios");
  const android = await fakeMobileClient("android");
  const saved = { stub: process.env['NATIVEAPPTEMPLATE_STUB_ALL'], base: process.env['ANTHROPIC_BASE_URL'], key: process.env['ANTHROPIC_API_KEY'], natKey: process.env['NATIVEAPPTEMPLATE_AGENT_ANTHROPIC_KEY'] };
  delete process.env['NATIVEAPPTEMPLATE_STUB_ALL'];
  delete process.env['NATIVEAPPTEMPLATE_AGENT_ANTHROPIC_KEY'];
  process.env['ANTHROPIC_BASE_URL'] = "http://127.0.0.1:9"; // nothing listens → the iOS judge call throws
  process.env['ANTHROPIC_API_KEY'] = "sk-test";
  try {
    const result = await runStage2Visual({
      spec: "x",
      iosScenario: shotScenario, // screenshot → Layer 3 judge call → throws
      androidScenario: { name: "queue-crud-x", steps: [{ kind: "assert_text", text: "Idled" }] }, // no screenshot → no judge call
      screenshotDir: mkdtempSync(join(tmpdir(), "stage2-isolate-")),
      iosClient: ios.mobile,
      androidClient: android.mobile,
    });
    assert.equal(result.ios?.pass, false);
    assert.ok(result.ios?.error);
    assert.equal(result.android?.pass, true);
    assert.equal(result.android?.stepsPassed, 1);
  } finally {
    for (const [k, v] of [["NATIVEAPPTEMPLATE_STUB_ALL", saved.stub], ["ANTHROPIC_BASE_URL", saved.base], ["ANTHROPIC_API_KEY", saved.key], ["NATIVEAPPTEMPLATE_AGENT_ANTHROPIC_KEY", saved.natKey]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await ios.close();
    await android.close();
  }
});

test("writeReport (embed=false) keeps same-named screenshots from different platforms distinct", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "report-dupe-"));
  mkdirSync(join(tmp, "ios"));
  mkdirSync(join(tmp, "android"));
  writeFileSync(join(tmp, "ios", "home.png"), "ios");
  writeFileSync(join(tmp, "android", "home.png"), "android");
  const judge = mixedJudge(join(tmp, "ios", "home.png"));
  judge.platforms![2]!.layer3 = { pass: true, screenshotPath: join(tmp, "android", "home.png"), scores: [] };
  const report = buildRunReport({
    spec: "x", domain: reportDomain, judge, reviewer: { contractParity: "pass", diffs: [] },
    agentVersion: "1.0.0", judgeModel: "claude-opus-5-5", visualLevel: 1, startedAt: 0, finishedAt: 1,
  });
  const dir = join(tmp, "out");
  await writeReport(report, { dir, embed: false, format: "html" });
  const { readdirSync } = await import("node:fs");
  const contents = readdirSync(join(dir, "report-assets")).map((f) => readFileSync(join(dir, "report-assets", f), "utf8")).sort();
  assert.deepEqual(contents, ["android", "ios"]);
});

test("startRails fails fast with a clear error when the port is already taken", async () => {
  const { createServer } = await import("node:net");
  const { startRails } = await import("../src/rails-lifecycle.js");
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(
      startRails({ outDir: mkdtempSync(join(tmpdir(), "rails-port-")), host: "127.0.0.1", port, readyTimeoutMs: 1_000 }),
      /already in use/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("reviewer role uses the snake_case route segment for a multi-word role", async () => {
  const { deriveRole } = await import("../src/agents/reviewer.js");
  // Rails routes and the renamed mobile paths both carry the snake form (rename.rb's snake pattern).
  assert.equal(deriveRole({ ...reportDomain, renamePlan: [{ from: "Shopkeeper", to: "FrontDesk" }] }), "front_desk");
});

test("reviewer fails when a mobile client yields zero endpoints (nothing was actually compared)", async () => {
  const saved = process.env['NATIVEAPPTEMPLATE_STUB_ALL'];
  delete process.env['NATIVEAPPTEMPLATE_STUB_ALL'];
  try {
    const base = mkdtempSync(join(tmpdir(), "reviewer-empty-"));
    mkdirSync(join(base, "rails", "docs"), { recursive: true });
    writeFileSync(join(base, "rails", "docs", "openapi.yaml"), "openapi: 3.0.0\ninfo:\n  title: t\n  version: '1'\npaths:\n  /api/v1/vet/clinics:\n    get:\n      responses:\n        '200':\n          description: ok\n");
    mkdirSync(join(base, "ios"));
    mkdirSync(join(base, "android"));
    const worker = (platform: "rails" | "ios" | "android") => ({ platform, outDir: join(base, platform), renamedFrom: [] }) as unknown as import("../src/agents/types.js").WorkerResult;
    const result = await runReviewer({ domain: reportDomain, rails: worker("rails"), ios: worker("ios"), android: worker("android") });
    assert.equal(result.contractParity, "fail");
  } finally {
    if (saved === undefined) delete process.env['NATIVEAPPTEMPLATE_STUB_ALL']; else process.env['NATIVEAPPTEMPLATE_STUB_ALL'] = saved;
  }
});

test("iOS simulator destination honors NATIVEAPPTEMPLATE_IOS_DESTINATION", async () => {
  const { iosSimulatorDestination } = await import("../src/validation/ios-destination.js");
  const saved = process.env['NATIVEAPPTEMPLATE_IOS_DESTINATION'];
  process.env['NATIVEAPPTEMPLATE_IOS_DESTINATION'] = "platform=iOS Simulator,name=iPhone 16";
  try {
    assert.equal(iosSimulatorDestination(), "platform=iOS Simulator,name=iPhone 16");
  } finally {
    if (saved === undefined) delete process.env['NATIVEAPPTEMPLATE_IOS_DESTINATION']; else process.env['NATIVEAPPTEMPLATE_IOS_DESTINATION'] = saved;
  }
});

test("plugin manifest version matches the npm package version", () => {
  // Source of truth: package.json, the version published to npm.
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string };
  const plugin = JSON.parse(readFileSync(join(process.cwd(), "plugin", ".claude-plugin", "plugin.json"), "utf8")) as { version: string };
  assert.equal(plugin.version, pkg.version);
});

// --- Rails server teardown + stale DB cleanup ---

test("stopServer also stops the server's own children (bin/dev → Puma / Solid Queue)", async () => {
  const { spawnServer, stopServer } = await import("../src/rails-lifecycle.js");
  const child = spawnServer("sh", ["-c", "sleep 300 & echo $!; wait"], tmpdir());
  const grandchildPid = await new Promise<number>((r) => child.stdout!.once("data", (c: Buffer) => r(Number(c.toString().trim()))));
  await stopServer(child, 1_000);
  await new Promise((r) => setTimeout(r, 200));
  const alive = (() => { try { process.kill(grandchildPid, 0); return true; } catch { return false; } })();
  if (alive) process.kill(grandchildPid, "SIGKILL");
  assert.equal(alive, false, "grandchild must not outlive stopServer");
});

const PSQL_AVAILABLE = spawnSync("psql", ["-h", "localhost", "-d", "postgres", "-tAc", "select 1"]).status === 0;
const psql = (sql: string) => spawnSync("psql", ["-h", "localhost", "-d", "postgres", "-tAc", sql], { encoding: "utf8" });
const dbExists = (name: string) => psql(`SELECT 1 FROM pg_database WHERE datname='${name}'`).stdout.trim() === "1";

test("dropSlugDatabases drops only <slug>_api* databases (LIKE '_' is not a wildcard)", { skip: !PSQL_AVAILABLE }, async () => {
  const { dropSlugDatabases } = await import("../src/agents/workers/rails.js");
  // slug "zzagent-t" → prefix "zzagent_t_api"; "zzagent1t_api_keep" differs only where '_' sits.
  for (const db of ["zzagent_t_api_development", "zzagent1t_api_keep"]) { psql(`DROP DATABASE IF EXISTS ${db}`); psql(`CREATE DATABASE ${db}`); }
  try {
    await dropSlugDatabases("zzagent-t");
    assert.equal(dbExists("zzagent_t_api_development"), false);
    assert.equal(dbExists("zzagent1t_api_keep"), true, "unrelated database must survive");
  } finally {
    psql("DROP DATABASE IF EXISTS zzagent_t_api_development");
    psql("DROP DATABASE IF EXISTS zzagent1t_api_keep");
  }
});

test("dropSlugDatabases does not abort the run when a database is still in use", { skip: !PSQL_AVAILABLE }, async () => {
  const { dropSlugDatabases } = await import("../src/agents/workers/rails.js");
  const { spawn } = await import("node:child_process");
  psql("DROP DATABASE IF EXISTS zzagent_u_api_development");
  psql("CREATE DATABASE zzagent_u_api_development");
  const holder = spawn("psql", ["-h", "localhost", "-d", "zzagent_u_api_development", "-c", "select pg_sleep(30)"]);
  await new Promise((r) => setTimeout(r, 500));
  try {
    await dropSlugDatabases("zzagent-u");
  } finally {
    holder.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    psql("DROP DATABASE IF EXISTS zzagent_u_api_development WITH (FORCE)");
  }
});

// --- PARTIAL verdict: passing run without Layer 3 ---

function verdictReport(judge: JudgeResult) {
  return buildRunReport({
    spec: "x", domain: reportDomain, judge, reviewer: { contractParity: judge.overallPass ? "pass" : "fail", diffs: [] },
    agentVersion: "1.0.0", judgeModel: "claude-opus-5-5", visualLevel: 0, startedAt: 0, finishedAt: 1,
  });
}
const l12pass = (platform: Platform): PlatformDetail => ({
  platform,
  layer1: { pass: true, findings: [] },
  layer2: { pass: true, command: "x", mode: "fast", exitCode: 0, durationMs: 1 },
});

test("report verdict: Layer 1/2 + reviewer pass without Layer 3 is PARTIAL, not PASS", () => {
  // AGENTS.md: "A run that green-builds without passing Layer 3 is a failed run" — so a
  // VISUAL=0 run (no Layer 3) must not read as a full PASS.
  const report = verdictReport({ overallPass: true, summary: "s", platforms: [l12pass("rails"), l12pass("ios"), l12pass("android")] });
  assert.equal(report.verdict, "partial");
  assert.equal(report.overallPass, true, "exit-code semantics unchanged: nothing failed");
});

test("report verdict: PASS with Layer 3 on the mobile platforms, FAIL on any failure", () => {
  const withL3 = (p: Platform): PlatformDetail => ({ ...l12pass(p), layer3: { pass: true, scores: [] } });
  assert.equal(verdictReport({ overallPass: true, summary: "s", platforms: [l12pass("rails"), withL3("ios"), withL3("android")] }).verdict, "pass");
  assert.equal(verdictReport({ overallPass: false, summary: "s", platforms: [l12pass("rails"), l12pass("ios"), l12pass("android")] }).verdict, "fail");
});

test("rendered report and CLI line say PARTIAL for a run without Layer 3", async () => {
  const { overallLine } = await import("../src/index.js");
  const report = verdictReport({ overallPass: true, summary: "s", platforms: [l12pass("rails"), l12pass("ios"), l12pass("android")] });
  const html = renderReport(report, {});
  assert.match(html, /badge partial/);
  assert.doesNotMatch(html, /✓ Pass/);
  assert.match(overallLine(report), /^overall: PARTIAL/);
});

// --- Japanese renames (src/japanese-nouns.ts, rename.rb japaneseRenamePlan) ---

test("japaneseRenamePairs maps each planned toJa onto the substrate's Japanese noun", async () => {
  const { japaneseRenamePairs } = await import("../src/japanese-nouns.js");
  assert.deepEqual(
    japaneseRenamePairs([
      { from: "Shop", to: "Clinic", toJa: "医院" },
      { from: "ItemTag", to: "Patient", toJa: "患者" },
      // No Japanese name: the substrate's Japanese stays, as before
      { from: "Shopkeeper", to: "Vet" },
    ]),
    [
      { from: "店舗", to: "医院" },
      { from: "アイテムタグ", to: "患者" },
    ],
  );
});

test("japaneseRenamePairs skips tokens the substrate has no Japanese for, and identity pairs", async () => {
  const { japaneseRenamePairs } = await import("../src/japanese-nouns.js");
  // ja.yml calls a Shopkeeper ユーザー, which fits any domain, so it is not renamed
  assert.deepEqual(japaneseRenamePairs([{ from: "Shopkeeper", to: "Vet", toJa: "獣医" }]), []);
  assert.deepEqual(japaneseRenamePairs([{ from: "Shop", to: "Store", toJa: "店舗" }]), []);
});

test("renamedTokens adds the Japanese nouns being replaced, so Layer 1 flags any left behind", async () => {
  const { renamedTokens } = await import("../src/japanese-nouns.js");
  assert.deepEqual(
    renamedTokens([{ from: "Shop", to: "Clinic", toJa: "医院" }, { from: "Shopkeeper", to: "Vet" }]),
    ["Shop", "Shopkeeper", "店舗"],
  );
});

test("runLayer1 flags a Japanese noun that should have been renamed", async () => {
  const root = mkdtempSync(join(tmpdir(), "layer1-ja-"));
  mkdirSync(join(root, "config", "locales"), { recursive: true });
  writeFileSync(join(root, "config", "locales", "ja.yml"), 'ja:\n  name: "医院名"\n  limit: "店舗は3件まで"\n');

  const result = await runLayer1({ projectDir: root, forbiddenTokens: ["店舗"] });

  assert.equal(result.pass, false);
  assert.deepEqual(result.findings.map((f) => [f.token, f.file, f.line]), [["店舗", "config/locales/ja.yml", 3]]);
});

test("parseArgs collects --rename-ja pairs in both forms", async () => {
  const { parseArgs } = await import("../src/index.js");
  const parsed = parseArgs(["a", "vet", "clinic", "--rename-ja", "Shop=医院", "--rename-ja=ItemTag=患者"]);
  assert.equal(parsed.spec, "a vet clinic");
  assert.deepEqual(parsed.japaneseOverrides, [
    { from: "Shop", to: "医院" },
    { from: "ItemTag", to: "患者" },
  ]);
});

test("applyJapaneseOverrides sets toJa on planned renames and reports the rest", async () => {
  const { applyJapaneseOverrides } = await import("../src/rename-overrides.js");
  const plan = [
    { from: "Shop", to: "Clinic", toJa: "クリニック" },
    { from: "Shopkeeper", to: "Vet" },
  ];
  const { plan: merged, outcomes } = applyJapaneseOverrides(plan, [
    { from: "Shop", to: "医院" },
    { from: "ItemTag", to: "患者" }, // not in the plan → unmatched, dropped
  ]);
  assert.deepEqual(merged, [
    { from: "Shop", to: "Clinic", toJa: "医院" },
    { from: "Shopkeeper", to: "Vet" },
  ]);
  assert.deepEqual(outcomes, [
    { kind: "changed", from: "Shop", was: "クリニック", to: "医院" },
    { kind: "unmatched", from: "ItemTag", to: "患者" },
  ]);
  assert.equal(plan[0]?.toJa, "クリニック");
});

test(
  "rename.rb replaces the Japanese nouns in a single pass, inside compounds, in every text file",
  { skip: RUBY_AVAILABLE ? false : "ruby not on PATH" },
  async () => {
    const { runRuby } = await import("../src/ruby.js");
    const root = mkdtempSync(join(tmpdir(), "rename-ja-"));
    mkdirSync(join(root, "config", "locales"), { recursive: true });
    mkdirSync(join(root, "test", "i18n"), { recursive: true });
    writeFileSync(
      join(root, "config", "locales", "ja.yml"),
      'ja:\n  activerecord:\n    models:\n      shop: "店舗"\n      item_tag: "アイテムタグ"\n    attributes:\n      shop:\n        name: "店舗名"\n  limit_count_shop: "店舗は%{limit_count}件まで作成できます。"\n',
    );
    // The substrate's tests assert the Japanese too, so they must follow
    writeFileSync(join(root, "test", "i18n", "japanese_messages_test.rb"), 'assert_equal "店舗", I18n.t("activerecord.models.shop", locale: :ja)\n');

    await runRuby<object, unknown>("rename.rb", {
      renamePlan: [{ from: "Shop", to: "Clinic" }, { from: "ItemTag", to: "Patient" }],
      japaneseRenamePlan: [{ from: "店舗", to: "医院" }, { from: "アイテムタグ", to: "患者" }],
      root,
    });

    assert.equal(
      readFileSync(join(root, "config/locales/ja.yml"), "utf8"),
      'ja:\n  activerecord:\n    models:\n      clinic: "医院"\n      patient: "患者"\n    attributes:\n      clinic:\n        name: "医院名"\n  limit_count_clinic: "医院は%{limit_count}件まで作成できます。"\n',
    );
    assert.equal(
      readFileSync(join(root, "test/i18n/japanese_messages_test.rb"), "utf8"),
      'assert_equal "医院", I18n.t("activerecord.models.clinic", locale: :ja)\n',
    );
  },
);

test(
  "rename.rb leaves Japanese alone without a japaneseRenamePlan",
  { skip: RUBY_AVAILABLE ? false : "ruby not on PATH" },
  async () => {
    const { runRuby } = await import("../src/ruby.js");
    const root = mkdtempSync(join(tmpdir(), "rename-ja-none-"));
    writeFileSync(join(root, "ja.yml"), 'shop: "店舗"\n');

    await runRuby<object, unknown>("rename.rb", { renamePlan: [{ from: "Shop", to: "Clinic" }], root });

    assert.equal(readFileSync(join(root, "ja.yml"), "utf8"), 'clinic: "店舗"\n');
  },
);

// The table must name the substrate's actual Japanese, or nothing gets renamed
test(
  "SUBSTRATE_JAPANESE_NOUNS match the substrate's ja.yml",
  { skip: process.env["NATIVEAPPTEMPLATE_API"] ? false : "NATIVEAPPTEMPLATE_API not set" },
  async () => {
    const { SUBSTRATE_JAPANESE_NOUNS } = await import("../src/japanese-nouns.js");
    const jaYml = readFileSync(join(process.env["NATIVEAPPTEMPLATE_API"]!, "config", "locales", "ja.yml"), "utf8");
    assert.match(jaYml, new RegExp(`shop: "${SUBSTRATE_JAPANESE_NOUNS["Shop"]}"`));
    assert.match(jaYml, new RegExp(`item_tag: "${SUBSTRATE_JAPANESE_NOUNS["ItemTag"]}"`));
  },
);

// String Catalogs hold both the English keys the code looks up and the
// Japanese values, so both must follow the rename
test(
  "rename.rb rewrites .xcstrings keys and Japanese values",
  { skip: RUBY_AVAILABLE ? false : "ruby not on PATH" },
  async () => {
    const { runRuby } = await import("../src/ruby.js");
    const root = mkdtempSync(join(tmpdir(), "rename-xcstrings-"));
    writeFileSync(
      join(root, "Localizable.xcstrings"),
      '{ "strings" : { "Add Shop" : { "localizations" : { "ja" : { "stringUnit" : { "value" : "店舗を追加" } } } } } }',
    );

    await runRuby<object, unknown>("rename.rb", {
      renamePlan: [{ from: "Shop", to: "Clinic" }],
      japaneseRenamePlan: [{ from: "店舗", to: "動物病院" }],
      root,
    });

    assert.equal(
      readFileSync(join(root, "Localizable.xcstrings"), "utf8"),
      '{ "strings" : { "Add Clinic" : { "localizations" : { "ja" : { "stringUnit" : { "value" : "動物病院を追加" } } } } } }',
    );
  },
);

test("runLayer1 scans .xcstrings", async () => {
  const root = mkdtempSync(join(tmpdir(), "layer1-xcstrings-"));
  writeFileSync(join(root, "Localizable.xcstrings"), '{ "strings" : { "Add Shop" : {} } }');

  const result = await runLayer1({ projectDir: root, forbiddenTokens: ["Shop"] });

  assert.equal(result.pass, false);
  assert.deepEqual(result.findings.map((f) => f.file), ["Localizable.xcstrings"]);
});

// --- reserved rename targets (src/reserved-words.ts) ---

// The billing names, as listed in the paid templates' subscription docs
// (iOS docs/subscription.md "Keeping it safe for nativeapptemplate-agent's
// rename"; Android docs/subscriptions.md "Renaming the app") plus the SDK /
// StoreKit / Play Billing type names their billing code refers to.
const BILLING_NAMES = [
  "Subscription", "Paywall", "Plan", "Purchase", "Purchases", "Billing", "Entitlement", "Trial", "Customer",
  "Package", "Offering", "Store", "StoreProduct", "Product", "Transaction", "Price", "Period",
];

test("reservedReason rejects every billing name, in any case, and accepts ordinary domain nouns", async () => {
  const { reservedReason } = await import("../src/reserved-words.js");
  for (const name of BILLING_NAMES) {
    assert.match(reservedReason(name) ?? "", /subscription/, `${name} must be reserved`);
    assert.ok(reservedReason(name.toLowerCase()), `${name.toLowerCase()} must be reserved`);
  }
  assert.match(reservedReason("Owner") ?? "", /auth\/admin/);
  assert.match(reservedReason("Task") ?? "", /Swift/);
  for (const name of ["Clinic", "Vet", "Patient", "Restaurant", "Project", "Ticket"]) {
    assert.equal(reservedReason(name), null, `${name} must be allowed`);
  }
});

test("planner prompt lists every billing-reserved name", async () => {
  const { SYSTEM_PROMPT } = await import("../src/agents/planner.js");
  const billingLine = SYSTEM_PROMPT.split("\n").find((l) => l.includes("Subscription, Paywall")) ?? "";
  for (const name of BILLING_NAMES) {
    assert.ok(billingLine.split(", ").map((w) => w.trim()).includes(name), `planner prompt must reserve ${name}`);
  }
});

test("applyRenameOverrides rejects a reserved target and keeps the planner's pick", async () => {
  const { applyRenameOverrides } = await import("../src/rename-overrides.js");
  const plan = [
    { from: "Shop", to: "Clinic", toJa: "医院" },
    { from: "Shopkeeper", to: "Vet" },
  ];
  const { plan: merged, outcomes } = applyRenameOverrides(plan, [
    { from: "Shop", to: "Store" },
    { from: "Shopkeeper", to: "Owner" },
  ]);
  assert.deepEqual(merged, plan);
  assert.deepEqual(outcomes.map((o) => [o.kind, o.from, o.to]), [
    ["reserved", "Shop", "Store"],
    ["reserved", "Shopkeeper", "Owner"],
  ]);
});

test("dispatch drops a reserved --rename override and reports it (stub pipeline)", async () => {
  const result = await dispatch("a walk-in clinic queue for vets", {
    renameOverrides: [{ from: "Shop", to: "Subscription" }],
  });
  assert.equal(result.renameOverrideOutcomes[0]?.kind, "reserved");
  // Stub planner picks Shop -> Clinic (src/agents/planner.ts runStubPlanner).
  assert.ok(result.report.domain.renamePlan.some((p) => p.from === "Shop" && p.to === "Clinic"));
  assert.deepEqual(result.reservedTargets, []);
});

test("reservedTargets flags a planned target that collides with a reserved word", async () => {
  const { reservedTargets } = await import("../src/reserved-words.js");
  const hits = reservedTargets([
    { from: "Shop", to: "Clinic" },
    { from: "ItemTag", to: "Purchase" },
  ]);
  assert.deepEqual(hits.map((h) => [h.from, h.to]), [["ItemTag", "Purchase"]]);
});

// --- the developer's local billing key must not reach generated apps ---

test("iOS copy leaves out RevenueCat.local.xcconfig but keeps API.local.xcconfig", async () => {
  const { copySubstrate } = await import("../src/agents/workers/copy.js");
  const { IOS_SKIP_RULES } = await import("../src/agents/workers/ios.js");
  const { existsSync } = await import("node:fs");
  const base = mkdtempSync(join(tmpdir(), "copy-rc-"));
  const src = join(base, "src");
  mkdirSync(join(src, "Nested"), { recursive: true });
  writeFileSync(join(src, "RevenueCat.xcconfig"), 'REVENUECAT_API_KEY =\n#include? "RevenueCat.local.xcconfig"\n');
  writeFileSync(join(src, "RevenueCat.local.xcconfig"), "REVENUECAT_API_KEY = appl_developers_own_key\n");
  writeFileSync(join(src, "Nested", "RevenueCat.local.xcconfig"), "REVENUECAT_API_KEY = appl_developers_own_key\n");
  writeFileSync(join(src, "API.local.xcconfig"), "NATIVEAPPTEMPLATE_API_DOMAIN = 192.168.1.11\n");
  const dest = join(base, "dest");
  await copySubstrate(src, dest, IOS_SKIP_RULES);
  assert.equal(existsSync(join(dest, "RevenueCat.local.xcconfig")), false);
  assert.equal(existsSync(join(dest, "Nested", "RevenueCat.local.xcconfig")), false);
  assert.equal(existsSync(join(dest, "RevenueCat.xcconfig")), true);
  assert.equal(existsSync(join(dest, "API.local.xcconfig")), true);
});

test("env-bridge never mirrors the template's RevenueCat key to the generated app", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "env-bridge-rc-"));
  mkdirSync(join(fakeHome, ".gradle"), { recursive: true });
  writeFileSync(
    join(fakeHome, ".gradle", "gradle.properties"),
    "NATIVEAPPTEMPLATE_API_SCHEME=http\nNATIVEAPPTEMPLATE_REVENUECAT_GOOGLE_API_KEY=goog_developers_own_key\n",
  );
  const fakeSubstrate = mkdtempSync(join(tmpdir(), "substrate-rc-"));
  writeFileSync(join(fakeSubstrate, ".env"), "HOST=192.168.1.11\nPORT=3000\n");

  const saved = {
    HOME: process.env['HOME'],
    NATIVEAPPTEMPLATE_API: process.env['NATIVEAPPTEMPLATE_API'],
    NATIVEAPPTEMPLATE_API_SCHEME: process.env['NATIVEAPPTEMPLATE_API_SCHEME'],
    NATIVEAPPTEMPLATE_REVENUECAT_GOOGLE_API_KEY: process.env['NATIVEAPPTEMPLATE_REVENUECAT_GOOGLE_API_KEY'],
  };
  process.env['HOME'] = fakeHome;
  process.env['NATIVEAPPTEMPLATE_API'] = fakeSubstrate;
  delete process.env['NATIVEAPPTEMPLATE_API_SCHEME'];
  process.env['NATIVEAPPTEMPLATE_REVENUECAT_GOOGLE_API_KEY'] = "goog_developers_own_key";
  try {
    const { buildBridgeValues } = await import("../src/env-bridge.js");
    const bridge = await buildBridgeValues({
      slug: "clinic-queue", displayName: "Clinic Queue", entities: [], renamePlan: [], jsonApiContract: {},
    });
    // The API settings still bridge (control: the fixture is read at all).
    assert.equal(bridge.values['CLINICQUEUE_API_SCHEME'], "http");
    assert.deepEqual(Object.keys(bridge.values).filter((k) => /REVENUECAT/.test(k)), []);
    assert.ok(!Object.values(bridge.values).includes("goog_developers_own_key"));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  }
});

test("rename.rb renames the shop wording in billing strings and leaves billing identifiers alone", { skip: !RUBY_AVAILABLE }, async () => {
  // Inputs are lines from the paid templates' billing code (iOS Constants.swift /
  // PaywallView, Android strings.xml / PaywallFeature.kt); the expected output is
  // the hand-applied Shop -> Clinic rename of the shop words only.
  const root = await runRenameFixture(
    {
      "Paywall.swift": 'case multipleRecords\nlet t = "Run all your shops from one account"\nSubscriptionRepository.purchase(RevenueCat.Package)',
      "strings.xml": '<string name="paywall_title_shops">Manage multiple shops from one account</string>',
      "PaywallFeature.kt": "enum class PaywallFeature { SHOPS, ORGANIZATIONS, MEMBERS }",
    },
    [{ from: "Shop", to: "Clinic" }],
  );
  assert.equal(
    readFileSync(join(root, "Paywall.swift"), "utf8"),
    'case multipleRecords\nlet t = "Run all your clinics from one account"\nSubscriptionRepository.purchase(RevenueCat.Package)',
  );
  assert.equal(
    readFileSync(join(root, "strings.xml"), "utf8"),
    '<string name="paywall_title_clinics">Manage multiple clinics from one account</string>',
  );
  assert.equal(
    readFileSync(join(root, "PaywallFeature.kt"), "utf8"),
    "enum class PaywallFeature { CLINICS, ORGANIZATIONS, MEMBERS }",
  );
});

test("runLayer1 ignores Material's ShoppingCart icons but still flags a leftover Shop next to them", async () => {
  // The paid Android template's Settings subscription section uses
  // Icons.Outlined.ShoppingCart / AddShoppingCart. rename.rb leaves them alone
  // (Shop is followed by a lowercase letter, not a word boundary), so they are
  // not leftovers; renaming them would break the build.
  const root = mkdtempSync(join(tmpdir(), "layer1-shopping-"));
  writeFileSync(
    join(root, "SettingsView.kt"),
    "import androidx.compose.material.icons.outlined.AddShoppingCart\nicon = Icons.Outlined.ShoppingCart,\n",
  );
  const clean = await runLayer1({ projectDir: root, forbiddenTokens: ["Shop"] });
  assert.deepEqual(clean.findings, []);

  writeFileSync(join(root, "Leftover.kt"), "val s: Shop = Shops.first() // ShoppingCart\n");
  const dirty = await runLayer1({ projectDir: root, forbiddenTokens: ["Shop"] });
  // Hand count: "Shop" and the "Shop" of "Shops" are leftovers; ShoppingCart is not.
  assert.deepEqual(dirty.findings.map((f) => [f.file, f.token]), [["Leftover.kt", "Shop"], ["Leftover.kt", "Shop"]]);
});

// --- Sentry error monitoring in the templates ---

// The error monitoring names: the templates' own types (iOS NativeAppTemplate/
// ErrorReporting/, Android common/errors/reporting/), the iOS template's logging
// `struct Event` (Logger.swift, why SentryErrorReporter writes `Sentry.Event`),
// and the SDK names used unqualified (iOS SentryErrorReporterTest: Breadcrumb,
// Exception) or as a top-level module (Swift `import Sentry`, Ruby `Sentry`).
const ERROR_MONITORING_NAMES = [
  "Sentry", "ErrorReport", "ErrorReporter", "ErrorReporting", "Event", "Breadcrumb", "Exception",
];

test("reservedReason rejects every error monitoring name, in any case, and still accepts ordinary domain nouns", async () => {
  const { reservedReason } = await import("../src/reserved-words.js");
  for (const name of ERROR_MONITORING_NAMES) {
    assert.match(reservedReason(name) ?? "", /error monitoring \(Sentry\)/, `${name} must be reserved`);
    assert.ok(reservedReason(name.toUpperCase()), `${name.toUpperCase()} must be reserved`);
  }
  // Nouns a barbershop / clinic / bug-tracker spec could pick; none is an
  // identifier the error monitoring layer declares or imports.
  for (const name of ["Barbershop", "Barber", "Visit", "Report", "Incident", "Clinic"]) {
    assert.equal(reservedReason(name), null, `${name} must be allowed`);
  }
});

test("planner prompt lists every error-monitoring-reserved name", async () => {
  const { SYSTEM_PROMPT } = await import("../src/agents/planner.js");
  const line = SYSTEM_PROMPT.split("\n").find((l) => l.includes("Sentry, ErrorReport")) ?? "";
  for (const name of ERROR_MONITORING_NAMES) {
    assert.ok(line.split(", ").map((w) => w.trim()).includes(name), `planner prompt must reserve ${name}`);
  }
});

test("applyRenameOverrides rejects an error monitoring target and keeps the planner's pick", async () => {
  const { applyRenameOverrides } = await import("../src/rename-overrides.js");
  const plan = [
    { from: "Shop", to: "Barbershop" },
    { from: "ItemTag", to: "Visit" },
  ];
  const { plan: merged, outcomes } = applyRenameOverrides(plan, [
    { from: "Shop", to: "Event" },
    { from: "ItemTag", to: "sentry" },
  ]);
  assert.deepEqual(merged, plan);
  assert.deepEqual(outcomes.map((o) => [o.kind, o.from, o.to]), [
    ["reserved", "Shop", "Event"],
    ["reserved", "ItemTag", "sentry"],
  ]);
});

test("copies leave out Sentry's local config and credentials but keep the committed Sentry files", async () => {
  const { copySubstrate } = await import("../src/agents/workers/copy.js");
  const { IOS_SKIP_RULES } = await import("../src/agents/workers/ios.js");
  const { ANDROID_SKIP_RULES } = await import("../src/agents/workers/android.js");
  const { RAILS_SKIP_RULES } = await import("../src/agents/workers/rails.js");
  const { existsSync } = await import("node:fs");
  const base = mkdtempSync(join(tmpdir(), "copy-sentry-"));

  const ios = join(base, "ios");
  mkdirSync(join(ios, "scripts"), { recursive: true });
  writeFileSync(join(ios, "Project.xcconfig"), '#include "RevenueCat.xcconfig"\n#include "Sentry.xcconfig"\n');
  writeFileSync(join(ios, "Sentry.xcconfig"), 'SENTRY_DSN =\nSENTRY_ORG =\nSENTRY_PROJECT =\n#include? "Sentry.local.xcconfig"\n');
  writeFileSync(join(ios, "Sentry.local.xcconfig"), "SENTRY_DSN = https:/$()/developers-own@o1.ingest.us.sentry.io/1\n");
  writeFileSync(join(ios, ".sentryclirc"), "[auth]\ntoken=developers_own_token\n");
  writeFileSync(join(ios, "scripts", "upload-dsyms-to-sentry.sh"), "#!/bin/sh\nexit 0\n");
  await copySubstrate(ios, join(base, "ios-out"), IOS_SKIP_RULES);
  assert.equal(existsSync(join(base, "ios-out", "Sentry.local.xcconfig")), false);
  assert.equal(existsSync(join(base, "ios-out", ".sentryclirc")), false);
  for (const kept of ["Project.xcconfig", "Sentry.xcconfig", "scripts/upload-dsyms-to-sentry.sh"]) {
    assert.equal(existsSync(join(base, "ios-out", kept)), true, `${kept} must be copied`);
  }

  for (const [name, rules] of [["android", ANDROID_SKIP_RULES], ["rails", RAILS_SKIP_RULES]] as const) {
    const src = join(base, name);
    mkdirSync(join(src, "app"), { recursive: true });
    writeFileSync(join(src, ".sentryclirc"), "[auth]\ntoken=developers_own_token\n");
    writeFileSync(join(src, "app", "sentry.properties"), "auth.token=developers_own_token\n");
    writeFileSync(join(src, ".gitignore"), ".sentryclirc\nsentry.properties\n");
    await copySubstrate(src, join(base, `${name}-out`), rules);
    assert.equal(existsSync(join(base, `${name}-out`, ".sentryclirc")), false, `${name}: .sentryclirc`);
    assert.equal(existsSync(join(base, `${name}-out`, "app", "sentry.properties")), false, `${name}: sentry.properties`);
    assert.equal(existsSync(join(base, `${name}-out`, ".gitignore")), true, `${name}: control file copied`);
  }
});

test("env-bridge never mirrors the template's Sentry settings to the generated app", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "env-bridge-sentry-"));
  mkdirSync(join(fakeHome, ".gradle"), { recursive: true });
  writeFileSync(
    join(fakeHome, ".gradle", "gradle.properties"),
    "NATIVEAPPTEMPLATE_API_SCHEME=http\nNATIVEAPPTEMPLATE_SENTRY_DSN=https://developers-own@o1.ingest.us.sentry.io/1\nNATIVEAPPTEMPLATE_SENTRY_ORG=developers-org\n",
  );
  const fakeSubstrate = mkdtempSync(join(tmpdir(), "substrate-sentry-"));
  writeFileSync(join(fakeSubstrate, ".env"), "HOST=192.168.1.11\nPORT=3000\n");
  const saved = {
    HOME: process.env['HOME'],
    NATIVEAPPTEMPLATE_API: process.env['NATIVEAPPTEMPLATE_API'],
    NATIVEAPPTEMPLATE_API_SCHEME: process.env['NATIVEAPPTEMPLATE_API_SCHEME'],
    NATIVEAPPTEMPLATE_SENTRY_DSN: process.env['NATIVEAPPTEMPLATE_SENTRY_DSN'],
  };
  process.env['HOME'] = fakeHome;
  process.env['NATIVEAPPTEMPLATE_API'] = fakeSubstrate;
  delete process.env['NATIVEAPPTEMPLATE_API_SCHEME'];
  process.env['NATIVEAPPTEMPLATE_SENTRY_DSN'] = "https://developers-own@o1.ingest.us.sentry.io/1";
  try {
    const { buildBridgeValues } = await import("../src/env-bridge.js");
    const bridge = await buildBridgeValues({
      slug: "barbershop-queue", displayName: "Barbershop Queue", entities: [], renamePlan: [], jsonApiContract: {},
    });
    // Control: the fixture is read at all.
    assert.equal(bridge.values['BARBERSHOPQUEUE_API_SCHEME'], "http");
    assert.deepEqual(Object.keys(bridge.values).filter((k) => /SENTRY/.test(k)), []);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  }
});

test("rename.rb keeps the API's Sentry DSN secret matching the deploy test's SERVICE.upcase", { skip: !RUBY_AVAILABLE }, async () => {
  // Lines from nativeapptemplateapi (config/deploy.yml, .kamal/secrets,
  // test/config/deploy_config_test.rb, config/initializers/sentry.rb, test/config/sentry_test.rb).
  // The deploy test asserts `SENTRY_DSN=$#{SERVICE.upcase}_SENTRY_DSN`, so after the rename the
  // secret's prefix must be the upper case of the renamed service name.
  const { buildProductRenamePairs } = await import("../src/agents/workers/rails.js");
  const root = await runRenameFixture(
    {
      "config/deploy.yml": "service: nativeapptemplateapi\n",
      ".kamal/secrets": "SENTRY_DSN=$NATIVEAPPTEMPLATEAPI_SENTRY_DSN\n",
      "test/config/deploy_config_test.rb": 'SERVICE = "nativeapptemplateapi"\n',
      "config/initializers/sentry.rb": 'module NativeapptemplateSentry\nend\nNativeapptemplateSentry.init(ENV["SENTRY_DSN"])\n',
      "test/config/sentry_test.rb": "NativeapptemplateSentry.init(Sentry::TestHelper::DUMMY_DSN)\n",
    },
    [...buildProductRenamePairs("barbershop-queue")],
  );
  const service = /SERVICE = "(.+)"/.exec(readFileSync(join(root, "test/config/deploy_config_test.rb"), "utf8"))?.[1] ?? "";
  // snake_case("BarbershopQueueApi") = barbershop_queue_api (rename.rb snake_case)
  assert.equal(service, "barbershop_queue_api");
  assert.equal(readFileSync(join(root, "config/deploy.yml"), "utf8"), `service: ${service}\n`);
  assert.equal(readFileSync(join(root, ".kamal/secrets"), "utf8"), `SENTRY_DSN=$${service.toUpperCase()}_SENTRY_DSN\n`);
  // The module and every call to it move together; the SDK's own `Sentry` stays.
  assert.equal(
    readFileSync(join(root, "config/initializers/sentry.rb"), "utf8"),
    'module BarbershopQueueSentry\nend\nBarbershopQueueSentry.init(ENV["SENTRY_DSN"])\n',
  );
  assert.equal(readFileSync(join(root, "test/config/sentry_test.rb"), "utf8"), "BarbershopQueueSentry.init(Sentry::TestHelper::DUMMY_DSN)\n");
});

test("rename.rb renames the Sentry Gradle properties with the app and leaves Sentry identifiers and xcconfig wiring alone", { skip: !RUBY_AVAILABLE }, async () => {
  // Lines from the paid templates: Android app/build.gradle.kts and
  // SentryErrorReporter.kt; iOS project.pbxproj (Project.xcconfig as the project's
  // base configuration), Project.xcconfig and SentryErrorReporter.swift.
  const root = await runRenameFixture(
    {
      "app/build.gradle.kts":
        'val sentryOrg = gradleProperty("NATIVEAPPTEMPLATE_SENTRY_ORG")\n' +
        'buildConfigField("String", "SENTRY_DSN", "\\"${property("NATIVEAPPTEMPLATE_SENTRY_DSN") ?: ""}\\"")\n',
      "SentryErrorReporter.kt": "import io.sentry.Sentry\nimport io.sentry.Breadcrumb\nSentry.captureEvent(event)\n",
      "App.xcodeproj/project.pbxproj":
        "5E7A10000000000000000105 /* Project.xcconfig */ = {isa = PBXFileReference; path = Project.xcconfig; };\n" +
        "baseConfigurationReference = 5E7A10000000000000000105 /* Project.xcconfig */;\n" +
        "shellScript = \"\\\"${SRCROOT}/scripts/upload-dsyms-to-sentry.sh\\\"\\n\";\n",
      "Project.xcconfig": '#include "RevenueCat.xcconfig"\n#include "Sentry.xcconfig"\n',
      "SentryErrorReporter.swift": "static func scrub(_ event: Sentry.Event) -> Sentry.Event {\n    SentrySDK.setUser(Sentry.User(userId: id))\n",
    },
    [
      { from: "NativeAppTemplate", to: "BarbershopQueue" },
      { from: "Shop", to: "Barbershop" },
      { from: "Shopkeeper", to: "Barber" },
      { from: "ItemTag", to: "Visit" },
    ],
  );
  // NativeAppTemplate is two words, so its upper form stays flat: BARBERSHOPQUEUE,
  // the same token the env bridge uses (slugToPascal(slug).toUpperCase()).
  assert.equal(
    readFileSync(join(root, "app/build.gradle.kts"), "utf8"),
    'val sentryOrg = gradleProperty("BARBERSHOPQUEUE_SENTRY_ORG")\n' +
      'buildConfigField("String", "SENTRY_DSN", "\\"${property("BARBERSHOPQUEUE_SENTRY_DSN") ?: ""}\\"")\n',
  );
  for (const unchanged of ["SentryErrorReporter.kt", "App.xcodeproj/project.pbxproj", "Project.xcconfig", "SentryErrorReporter.swift"]) {
    const original = {
      "SentryErrorReporter.kt": "import io.sentry.Sentry\nimport io.sentry.Breadcrumb\nSentry.captureEvent(event)\n",
      "App.xcodeproj/project.pbxproj":
        "5E7A10000000000000000105 /* Project.xcconfig */ = {isa = PBXFileReference; path = Project.xcconfig; };\n" +
        "baseConfigurationReference = 5E7A10000000000000000105 /* Project.xcconfig */;\n" +
        "shellScript = \"\\\"${SRCROOT}/scripts/upload-dsyms-to-sentry.sh\\\"\\n\";\n",
      "Project.xcconfig": '#include "RevenueCat.xcconfig"\n#include "Sentry.xcconfig"\n',
      "SentryErrorReporter.swift": "static func scrub(_ event: Sentry.Event) -> Sentry.Event {\n    SentrySDK.setUser(Sentry.User(userId: id))\n",
    }[unchanged];
    assert.equal(readFileSync(join(root, unchanged), "utf8"), original, `${unchanged} must be untouched`);
  }
});

test("rename.rb upper-cases a one-word token from its snake_case rename", { skip: !RUBY_AVAILABLE }, async () => {
  // Shop -> PetSalon: shop_id becomes pet_salon_id (snake), so SHOP_ID must become
  // PET_SALON_ID (its upper case), not PETSALON_ID. ItemTag is two words: its upper
  // form ITEMTAG keeps following the flat rename (itemtag -> visitlog -> VISITLOG).
  const root = await runRenameFixture(
    { "a.kt": "const val SHOP_ID = \"shop_id\"\nenum class F { SHOPS }\nval x = ITEMTAG\n" },
    [{ from: "Shop", to: "PetSalon" }, { from: "ItemTag", to: "VisitLog" }],
  );
  assert.equal(
    readFileSync(join(root, "a.kt"), "utf8"),
    "const val PET_SALON_ID = \"pet_salon_id\"\nenum class F { PET_SALONS }\nval x = VISITLOG\n",
  );
});

test("rename.rb renames a Gradle property after -P", { skip: !RUBY_AVAILABLE }, async () => {
  // Android template README / build.gradle.kts: "-PNATIVEAPPTEMPLATE_SENTRY_UPLOAD_MAPPING=false".
  // The P of -P is a letter, so the plain left boundary missed it and the generated
  // app's docs named a property its build no longer reads.
  const root = await runRenameFixture(
    { "README.md": "./gradlew assembleRelease -PNATIVEAPPTEMPLATE_SENTRY_UPLOAD_MAPPING=false\nXNATIVEAPPTEMPLATE_KEEP\n" },
    [{ from: "NativeAppTemplate", to: "FadeQueue" }],
  );
  // Hand-applied: -P prefix renamed; a token glued to another letter (X...) is still left alone.
  assert.equal(
    readFileSync(join(root, "README.md"), "utf8"),
    "./gradlew assembleRelease -PFADEQUEUE_SENTRY_UPLOAD_MAPPING=false\nXNATIVEAPPTEMPLATE_KEEP\n",
  );
});

// --- substrate copies take only what the template's git would commit ---

function gitIn(cwd: string, ...args: string[]) {
  const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}

test("copySubstrate leaves out a git substrate's ignored build output but keeps tracked, new and required local files", async () => {
  const { copySubstrate } = await import("../src/agents/workers/copy.js");
  const { IOS_SKIP_RULES } = await import("../src/agents/workers/ios.js");
  const { existsSync } = await import("node:fs");
  const base = mkdtempSync(join(tmpdir(), "copy-git-"));
  const src = join(base, "src");
  mkdirSync(join(src, "App"), { recursive: true });
  // Mirrors NativeAppTemplate's .gitignore (build/, DerivedData/, xcuserdata/)
  // plus *.xcresult, the bundle `xcodebuild test` leaves in the working tree,
  // and the gitignored local xcconfig the copy must keep.
  writeFileSync(join(src, ".gitignore"), "build/\nDerivedData/\nxcuserdata/\n*.xcresult\nAPI.local.xcconfig\n/docs-private/\n");
  writeFileSync(join(src, "App", "Shop.swift"), "struct Shop {}\n");
  gitIn(src, "init", "-q");
  gitIn(src, "add", ".");
  gitIn(src, "commit", "-q", "-m", "init");
  writeFileSync(join(src, "App", "NewWork.swift"), "struct NewWork {}\n");
  writeFileSync(join(src, "API.local.xcconfig"), "NATIVEAPPTEMPLATE_API_DOMAIN = 192.168.1.11\n");
  mkdirSync(join(src, "build", "Build", "Products"), { recursive: true });
  writeFileSync(join(src, "build", "Build", "Products", "App.o"), "obj");
  mkdirSync(join(src, "TestResults.xcresult", "Data"), { recursive: true });
  writeFileSync(join(src, "TestResults.xcresult", "Info.plist"), "<plist/>");
  mkdirSync(join(src, "App", "Nested.xcresult"), { recursive: true });
  writeFileSync(join(src, "App", "Nested.xcresult", "Info.plist"), "<plist/>");
  mkdirSync(join(src, "docs-private"), { recursive: true });
  writeFileSync(join(src, "docs-private", "notes.md"), "private\n");

  const dest = join(base, "dest");
  await copySubstrate(src, dest, IOS_SKIP_RULES);
  for (const kept of [".gitignore", "App/Shop.swift", "App/NewWork.swift", "API.local.xcconfig"]) {
    assert.equal(existsSync(join(dest, kept)), true, `${kept} must be copied`);
  }
  for (const left of ["build", "TestResults.xcresult", "App/Nested.xcresult", "docs-private", ".git"]) {
    assert.equal(existsSync(join(dest, left)), false, `${left} must not be copied`);
  }
});

test("every platform keeps its gitignored files the generated app needs", async () => {
  const { IOS_SKIP_RULES } = await import("../src/agents/workers/ios.js");
  const { ANDROID_SKIP_RULES } = await import("../src/agents/workers/android.js");
  const { RAILS_SKIP_RULES } = await import("../src/agents/workers/rails.js");
  // API.local.xcconfig: Debug builds' Rails host (ios.ts). local.properties:
  // Gradle's sdk.dir. .env: HOST/PORT read by rails-lifecycle.ts from the
  // generated dir. development.key: decrypts development.yml.enc for bin/dev.
  assert.deepEqual(IOS_SKIP_RULES.keepIgnored, ["API.local.xcconfig"]);
  assert.deepEqual(ANDROID_SKIP_RULES.keepIgnored, ["local.properties"]);
  assert.deepEqual(RAILS_SKIP_RULES.keepIgnored, [".env", "config/credentials/development.key"]);
});

test("copySubstrate of a non-git iOS substrate still leaves out build/ and .xcresult bundles", async () => {
  const { copySubstrate } = await import("../src/agents/workers/copy.js");
  const { IOS_SKIP_RULES } = await import("../src/agents/workers/ios.js");
  const { existsSync } = await import("node:fs");
  const base = mkdtempSync(join(tmpdir(), "copy-nogit-"));
  const src = join(base, "src");
  mkdirSync(join(src, "build"), { recursive: true });
  writeFileSync(join(src, "build", "App.o"), "obj");
  mkdirSync(join(src, "TestResults.xcresult"), { recursive: true });
  writeFileSync(join(src, "TestResults.xcresult", "Info.plist"), "<plist/>");
  writeFileSync(join(src, "Shop.swift"), "struct Shop {}\n");
  const dest = join(base, "dest");
  await copySubstrate(src, dest, IOS_SKIP_RULES);
  assert.equal(existsSync(join(dest, "Shop.swift")), true);
  assert.equal(existsSync(join(dest, "build")), false);
  assert.equal(existsSync(join(dest, "TestResults.xcresult")), false);
});

// --- a rejected --rename names what it actually kept ---

test("a rejected --rename after an accepted one reports keeping the earlier override, not the planner's pick", async () => {
  const { applyRenameOverrides, describeRenameOverride } = await import("../src/rename-overrides.js");
  const plan = [{ from: "Shopkeeper", to: "Stylist" }];
  const { plan: merged, outcomes } = applyRenameOverrides(plan, [
    { from: "Shopkeeper", to: "Barber" },
    { from: "Shopkeeper", to: "Sentry" },
  ]);
  // The first override wins; Sentry is reserved (error monitoring).
  assert.deepEqual(merged, [{ from: "Shopkeeper", to: "Barber" }]);
  const rejected = describeRenameOverride(outcomes[1]!, ["Shopkeeper"]);
  assert.match(rejected, /--rename Shopkeeper=Sentry rejected/);
  assert.match(rejected, /kept "Barber" from an earlier --rename/);
  assert.doesNotMatch(rejected, /planner's pick/);
});

test("a rejected --rename with no earlier override reports keeping the planner's pick by name", async () => {
  const { applyRenameOverrides, describeRenameOverride } = await import("../src/rename-overrides.js");
  const { outcomes } = applyRenameOverrides([{ from: "Shopkeeper", to: "Stylist" }], [{ from: "Shopkeeper", to: "Sentry" }]);
  assert.match(describeRenameOverride(outcomes[0]!, ["Shopkeeper"]), /kept the planner's pick "Stylist"/);
});

// ---- Claude Opus 5.5 request shapes (src/models.ts) ----
//
// Expected values come from the Opus 5.5 migration notes: forced tool_choice
// is a 400, thinking can't be disabled (no thinking / budget_tokens fields),
// sampling params are rejected, structured outputs need additionalProperties:
// false on every object and don't support `pattern`, and the "default"
// fallbacks form needs exactly the server-side-fallback-2026-07-01 beta.

type JsonNode = { [k: string]: unknown };

function walkSchema(node: unknown, visit: (n: JsonNode) => void): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((n) => walkSchema(n, visit)); return; }
  visit(node as JsonNode);
  for (const v of Object.values(node as JsonNode)) walkSchema(v, visit);
}

function assertOpus55Request(req: Record<string, unknown>, effort: string): void {
  assert.equal(req["model"], "claude-opus-5-5");
  for (const banned of ["tool_choice", "tools", "thinking", "temperature", "top_p", "top_k"]) {
    assert.equal(banned in req, false, `request must not send ${banned}`);
  }
  const outputConfig = req["output_config"] as { effort: string; format: { type: string; schema: unknown } };
  assert.equal(outputConfig.effort, effort);
  assert.equal(outputConfig.format.type, "json_schema");
  walkSchema(outputConfig.format.schema, (n) => {
    if (n["type"] === "object") assert.equal(n["additionalProperties"], false, `object schema needs additionalProperties: false: ${JSON.stringify(n).slice(0, 80)}`);
    assert.equal("pattern" in n, false, "structured outputs don't support pattern");
  });
  assert.deepEqual(req["betas"], ["server-side-fallback-2026-07-01"]);
  assert.equal(req["fallbacks"], "default");
  const messages = req["messages"] as { role: string }[];
  assert.equal(messages.at(-1)?.role, "user", "no assistant prefill");
}

function fakeMessage(overrides: Record<string, unknown>): never {
  return {
    id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5",
    content: [], stop_reason: "end_turn", stop_sequence: null, stop_details: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...overrides,
  } as never;
}

test("model ids live in one module and every role uses Opus 5.5", async () => {
  const m = await import("../src/models.js");
  assert.equal(m.OPUS_MODEL, "claude-opus-5-5");
  assert.equal(m.PLANNER_MODEL, m.OPUS_MODEL);
  assert.equal(m.JUDGE_MODEL, m.OPUS_MODEL);
  assert.equal(m.REPAIR_MODEL, m.OPUS_MODEL);
});

test("planner request uses structured outputs, explicit effort, and default fallbacks", async () => {
  const { buildPlannerRequest } = await import("../src/agents/planner.js");
  const req = buildPlannerRequest("a walk-in queue for a barbershop") as unknown as Record<string, unknown>;
  assertOpus55Request(req, "high");
  // max_tokens must leave room for always-on thinking (was 4096 on 4.7).
  assert.ok((req["max_tokens"] as number) >= 16000);
});

test("judge request uses structured outputs, explicit effort, and default fallbacks", async () => {
  const { buildJudgeRequest } = await import("../src/validation/layer3.js");
  const req = buildJudgeRequest("claude-opus-5-5", "iVBORw0K", "spec", { id: "c1", question: "q?" }) as unknown as Record<string, unknown>;
  assertOpus55Request(req, "medium");
  assert.ok((req["max_tokens"] as number) >= 4096, "max_tokens must leave room for thinking");
});

test("repair agent options pin Opus 5.5 with explicit effort and no thinking override", async () => {
  const { buildRepairOptions } = await import("../src/agents/repair.js");
  const opts = buildRepairOptions({ platform: "ios", outDir: "/tmp/x", layer: "layer2", detail: "" }, "sk-test", ["Read"]);
  assert.equal(opts.model, "claude-opus-5-5");
  assert.equal(opts.effort, "high");
  assert.equal(opts.thinking, undefined);
  assert.equal(opts.maxTurns, 40);
});

test("parsePlannerResponse reads the JSON text after thinking and fallback blocks", async () => {
  const { parsePlannerResponse } = await import("../src/agents/planner.js");
  const domain = parsePlannerResponse(fakeMessage({
    content: [
      { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" } },
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: JSON.stringify({ slug: "fade-queue", displayName: "Fade Queue", entities: [], renamePlan: [{ from: "Shop", to: "Barbershop" }], jsonApiContract: {} }) },
    ],
  }));
  assert.equal(domain.slug, "fade-queue");
  assert.deepEqual(domain.renamePlan, [{ from: "Shop", to: "Barbershop" }]);
});

test("parsePlannerResponse rejects refusals, truncation, and invalid slugs", async () => {
  const { parsePlannerResponse } = await import("../src/agents/planner.js");
  assert.throws(() => parsePlannerResponse(fakeMessage({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } })), /declined.*cyber/);
  assert.throws(() => parsePlannerResponse(fakeMessage({ stop_reason: "max_tokens", content: [{ type: "text", text: "{\"slug\":" }] })), /max_tokens/);
  assert.throws(() => parsePlannerResponse(fakeMessage({ content: [] })), /expected JSON text/);
  assert.throws(() => parsePlannerResponse(fakeMessage({ content: [{ type: "text", text: JSON.stringify({ slug: "Fade Queue", displayName: "x", entities: [], renamePlan: [], jsonApiContract: {} }) }] })), /invalid slug/);
});

test("parseVerdict reads a verdict and rejects refusals and malformed verdicts", async () => {
  const { parseVerdict } = await import("../src/validation/layer3.js");
  assert.deepEqual(parseVerdict(fakeMessage({ content: [{ type: "text", text: "{\"pass\":true,\"rationale\":\"ok\"}" }] })), { pass: true, rationale: "ok" });
  assert.throws(() => parseVerdict(fakeMessage({ stop_reason: "refusal" })), /declined/);
  assert.throws(() => parseVerdict(fakeMessage({ content: [{ type: "text", text: "{\"pass\":\"yes\",\"rationale\":\"ok\"}" }] })), /malformed verdict/);
});

test("dispatch reports the judge model from src/models.ts", async () => {
  const { JUDGE_MODEL } = await import("../src/models.js");
  const result = await dispatch("a walk-in clinic queue for small veterinary practices");
  assert.equal(result.report.meta.judgeModel, JUDGE_MODEL);
  assert.match(renderReport(result.report), new RegExp(`judge: ${JUDGE_MODEL}`));
});

test("usageLine logs cache write/read tokens next to input/output", async () => {
  const { usageLine } = await import("../src/structured-output.js");
  // The judge's screenshot sits under cache_control, so its image tokens are
  // billed as cache writes/reads, not input_tokens.
  const line = usageLine(fakeMessage({
    usage: { input_tokens: 83, output_tokens: 300, cache_creation_input_tokens: 1520, cache_read_input_tokens: 40 },
  }), "claude-opus-5-5");
  assert.equal(line, "usage: 83 in / 300 out / 1520 cache-write / 40 cache-read");
  // Missing/null cache fields print as 0 so the line stays fixed-shape.
  const bare = usageLine(fakeMessage({ usage: { input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: null } }), "claude-opus-5-5");
  assert.equal(bare, "usage: 5 in / 6 out / 0 cache-write / 0 cache-read");
});

test("repairCostLine reports the Agent SDK's total_cost_usd and cache tokens", async () => {
  const { repairCostLine } = await import("../src/agents/repair.js");
  assert.equal(
    repairCostLine({ total_cost_usd: 0.1, usage: { input_tokens: 12, output_tokens: 3400, cache_creation_input_tokens: 15000, cache_read_input_tokens: 90000 } }),
    "sdk-cost: $0.1000 (12 in / 3400 out / 15000 cache-write / 90000 cache-read)",
  );
});

function runCostScript(logs: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "cost-trace-"));
  for (const [name, body] of Object.entries(logs)) writeFileSync(join(dir, name), body);
  const r = spawnSync("bash", ["scripts/cost.sh", dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test("cost.sh prices cache writes/reads and adds the repair agent's SDK cost once", () => {
  const out = runCostScript({
    "judge.log": [
      "[01:00:00] layer3 renders-cleanly: usage: 100 in / 200 out / 1000 cache-write / 0 cache-read",
      "[01:00:01] layer3 renders-cleanly: usage: 100 in / 200 out / 0 cache-write / 1000 cache-read (served by claude-opus-5)",
    ].join("\n") + "\n",
    // Legacy line from before cache tokens were logged: still parses.
    "planner.log": "[01:00:00] usage: 1000 in / 500 out\n",
    "repair.log": [
      "[01:00:00] ios/layer2: invoking repair agent in /tmp/x",
      "[01:01:00] ios/layer2: 3 turns, sdk-cost: $0.1000 (12 in / 3400 out / 15000 cache-write / 90000 cache-read) — added 1 import in Foo.kt, 2 out of 3 errors",
    ].join("\n") + "\n",
  });
  // judge: in 200*$4 + out 400*$20 + write 1000*$5 + read 1000*$0.40
  //      = 800 + 8000 + 5000 + 400 = 14200 µ$ = $0.0142
  assert.match(out, /^judge\s+2\s+200\s+400\s+1000\s+1000\s+\$0\.0142$/m);
  // planner: 1000*$4 + 500*$20 = 4000 + 10000 = 14000 µ$ = $0.0140
  assert.match(out, /^planner\s+1\s+1000\s+500\s+0\s+0\s+\$0\.0140$/m);
  // repair: the SDK's own total, not re-priced from its tokens.
  assert.match(out, /^repair\s+1\s+12\s+3400\s+15000\s+90000\s+\$0\.1000$/m);
  // total = 0.0142 + 0.0140 + 0.1000 = $0.1282
  assert.match(out, /^Total\s+4\s+1212\s+4300\s+16000\s+91000\s+\$0\.1282$/m);
});

test("cost.sh with no argument reads tmp/trace/ of the directory npm run cost was invoked from", () => {
  // trace() writes to process.cwd()/tmp/trace, i.e. wherever the agent ran
  // (an app workspace, not this repo). npm runs scripts from the package
  // root but keeps the caller's directory in INIT_CWD.
  const workspace = mkdtempSync(join(tmpdir(), "cost-workspace-"));
  mkdirSync(join(workspace, "tmp/trace"), { recursive: true });
  writeFileSync(
    join(workspace, "tmp/trace/judge.log"),
    "[01:00:00] layer3 renders-cleanly: usage: 100 in / 200 out / 1000 cache-write / 0 cache-read\n",
  );
  const r = spawnSync("bash", ["scripts/cost.sh"], { encoding: "utf8", env: { ...process.env, INIT_CWD: workspace } });
  assert.equal(r.status, 0, r.stderr);
  // 100*$4 + 200*$20 + 1000*$5 = 400 + 4000 + 5000 = 9400 µ$ = $0.0094
  assert.match(r.stdout, /^judge\s+1\s+100\s+200\s+1000\s+0\s+\$0\.0094$/m);
});

test("cost.sh rates match OPUS_PRICE_PER_MTOK in src/models.ts", async () => {
  const { OPUS_PRICE_PER_MTOK } = await import("../src/models.js");
  // Opus 5.5 list price: $4 in / $20 out; 5-minute cache write = 1.25x input, cache read = 0.1x input.
  assert.deepEqual({ ...OPUS_PRICE_PER_MTOK }, { input: 4, output: 20, cacheWrite5m: 5, cacheRead: 0.4 });
  const script = readFileSync("scripts/cost.sh", "utf8");
  const rate = (name: string) => Number(script.match(new RegExp(`^${name}=([0-9.]+)`, "m"))?.[1]);
  assert.equal(rate("RATE_IN"), OPUS_PRICE_PER_MTOK.input);
  assert.equal(rate("RATE_OUT"), OPUS_PRICE_PER_MTOK.output);
  assert.equal(rate("RATE_CACHE_WRITE"), OPUS_PRICE_PER_MTOK.cacheWrite5m);
  assert.equal(rate("RATE_CACHE_READ"), OPUS_PRICE_PER_MTOK.cacheRead);
});

test("judge screenshot cache uses the default 5-minute TTL that cost.sh prices", async () => {
  const { buildJudgeRequest } = await import("../src/validation/layer3.js");
  const req = buildJudgeRequest("claude-opus-5-5", "iVBORw0K", "spec", { id: "c1", question: "q?" });
  const image = (req.messages[0]!.content as unknown as Array<Record<string, unknown>>)[0]!;
  // No ttl field = 5 minutes; a "1h" TTL bills writes at 2x input instead.
  assert.deepEqual(image["cache_control"], { type: "ephemeral" });
});

// --- the template developer's Firebase config must not reach generated apps (#147) ---

test("Android copy carries google-services.json as the template commits it, never the developer's own", async () => {
  const { copySubstrate } = await import("../src/agents/workers/copy.js");
  const { ANDROID_SKIP_RULES } = await import("../src/agents/workers/android.js");
  const base = mkdtempSync(join(tmpdir(), "copy-gms-"));
  const src = join(base, "src");
  mkdirSync(join(src, "app"), { recursive: true });
  // The paid template commits placeholder values and its AGENTS.md tells the
  // developer to drop their real file in under `git update-index
  // --skip-worktree` — the working tree then differs from the commit.
  const placeholder = '{"project_info":{"project_number":"YourProjectId","project_id":"abc"}}\n';
  const developers = '{"project_info":{"project_number":"915745750384","project_id":"nativeapptemplate"}}\n';
  writeFileSync(join(src, "app", "google-services.json"), placeholder);
  writeFileSync(join(src, "app", "build.gradle.kts"), "plugins {}\n");
  gitIn(src, "init", "-q");
  gitIn(src, "add", ".");
  gitIn(src, "commit", "-q", "-m", "init");
  writeFileSync(join(src, "app", "google-services.json"), developers);
  gitIn(src, "update-index", "--skip-worktree", "app/google-services.json");

  const dest = join(base, "dest");
  await copySubstrate(src, dest, ANDROID_SKIP_RULES);
  assert.equal(readFileSync(join(dest, "app", "google-services.json"), "utf8"), placeholder);
  assert.equal(existsSync(join(dest, "app", "build.gradle.kts")), true);

  // Same without skip-worktree: an uncommitted edit is still the developer's.
  gitIn(src, "update-index", "--no-skip-worktree", "app/google-services.json");
  const dest2 = join(base, "dest2");
  await copySubstrate(src, dest2, ANDROID_SKIP_RULES);
  assert.equal(readFileSync(join(dest2, "app", "google-services.json"), "utf8"), placeholder);
});

test("Android copy of a non-git substrate leaves google-services.json out (nothing tells the placeholder from the real one)", async () => {
  const { copySubstrate } = await import("../src/agents/workers/copy.js");
  const { ANDROID_SKIP_RULES } = await import("../src/agents/workers/android.js");
  const base = mkdtempSync(join(tmpdir(), "copy-gms-nogit-"));
  const src = join(base, "src");
  mkdirSync(join(src, "app"), { recursive: true });
  writeFileSync(join(src, "app", "google-services.json"), '{"project_info":{"project_number":"915745750384"}}\n');
  writeFileSync(join(src, "app", "build.gradle.kts"), "plugins {}\n");
  const dest = join(base, "dest");
  await copySubstrate(src, dest, ANDROID_SKIP_RULES);
  assert.equal(existsSync(join(dest, "app", "google-services.json")), false);
  assert.equal(existsSync(join(dest, "app", "build.gradle.kts")), true);
});
