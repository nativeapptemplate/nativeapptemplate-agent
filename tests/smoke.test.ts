import { test } from "node:test";
import assert from "node:assert/strict";
import { runLayer1, runLayer2, runLayer3, captureScreenshot, installAndLaunch, runVisualJudge, DEFAULT_STAGE1_RUBRIC, discoverIosArtifact, discoverAndroidArtifact, runStage1Visual } from "../src/validation/index.js";
import { dispatch } from "../src/dispatch.js";
import { runReviewer } from "../src/agents/reviewer.js";
import { canonicalizeEndpoint, diffContracts } from "../src/agents/contract-extract.js";
import { renderReport } from "../src/report/render.js";
import { buildRunReport, writeReport, collectScreenshotPaths } from "../src/report/collect.js";
import type { DomainSpec, JudgeResult, ReviewerResult, Platform, PlatformDetail } from "../src/agents/types.js";
import { runRepairLoop, REPAIR_ITERATION_CAP, type RepairLoopDeps, type RevalidateResult } from "../src/repair-loop.js";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  await mobile.close();
  await fake.close();
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

    // Third write with different slug's keys — replaces the block,
    // doesn't append a second block.
    const r3 = await syncGradleProperties({
      values: { CLINICQUEUE_API_DOMAIN: "10.0.0.5" },
    });
    assert.equal(r3.mode, "wrote");
    content = readFileSync(gradlePath, "utf8");
    assert.equal((content.match(/# BEGIN nativeapptemplate-agent/g) ?? []).length, 1);
    assert.match(content, /^CLINICQUEUE_API_DOMAIN=10\.0\.0\.5$/m);
    assert.doesNotMatch(content, /VETCLINICQUEUE_API_/);

    // Empty bridge — removes sentinel block, leaves rest untouched.
    const r4 = await syncGradleProperties({ values: {} });
    assert.equal(r4.removedStale, true);
    content = readFileSync(gradlePath, "utf8");
    assert.doesNotMatch(content, /BEGIN nativeapptemplate-agent/);
    assert.match(content, /^NATIVEAPPTEMPLATE_API_DOMAIN=api\.nativeapptemplate\.com$/m);

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

test("selectDevice honors NATIVEAPPTEMPLATE_MOBILE_IOS_DEVICE override (no listDevices call)", async () => {
  const { attachMobileClient } = await import("../src/mobile.js");
  const { selectDevice } = await import("../src/validation/stage2-judge.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

  let listCalled = false;
  const fake = new McpServer({ name: "fake-mobile-mcp", version: "0.0.0" });
  fake.registerTool(
    "mobile_list_available_devices",
    { description: "fake", inputSchema: {} },
    async () => {
      listCalled = true;
      return { content: [{ type: "text", text: "[]" }] };
    },
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([fake.connect(serverTransport), client.connect(clientTransport)]);
  const mobile = attachMobileClient(client);

  process.env['NATIVEAPPTEMPLATE_MOBILE_IOS_DEVICE'] = "MyExplicitDevice";
  try {
    const err = await selectDevice(mobile, "ios");
    assert.equal(err, undefined);
    assert.equal(listCalled, false, "override should skip listDevices entirely");
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
    judgeModel: "claude-opus-4-7",
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
    judgeModel: "claude-opus-4-7",
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
    judgeModel: "claude-opus-4-7",
    visualLevel: 0,
    startedAt: 0,
    finishedAt: 10,
  });
  const html = renderReport(report);
  assert.ok(html.includes("Layer 1/2/3 PASS"));
  assert.ok(html.includes("✓ Pass"));
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
    judgeModel: "claude-opus-4-7",
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
    judgeModel: "claude-opus-4-7",
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

// --- project-name (slug) override (--slug, src/slug.ts isValidSlug) ---

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

test("parseArgs captures a valid --slug (both = and space forms) and drops invalid ones", async () => {
  const { parseArgs } = await import("../src/index.js");
  assert.equal(parseArgs(["spec", "--slug=vet-clinic"]).slug, "vet-clinic");
  assert.equal(parseArgs(["spec", "--slug", "vet-clinic"]).slug, "vet-clinic");
  // Invalid slug → dropped (undefined), spec preserved.
  const bad = parseArgs(["spec", "--slug=Vet Clinic"]);
  assert.equal(bad.slug, undefined);
  assert.equal(bad.spec, "spec");
});

test("dispatch applies a valid --slug override and rewrites the project name (stub pipeline)", async () => {
  const result = await dispatch("a walk-in clinic queue for vets", { slug: "vet-clinic" });
  assert.equal(result.overallPass, true);
  // The override drives the report meta.slug (output dir + Pascal name follow).
  assert.equal(result.report.meta.slug, "vet-clinic");
});

test("dispatch ignores an invalid slug override and keeps the planner's slug (stub pipeline)", async () => {
  const result = await dispatch("a walk-in clinic queue for vets", { slug: "Not A Slug" });
  // Stub planner's slug is clinic-queue; the invalid override must not stick.
  assert.equal(result.report.meta.slug, "clinic-queue");
});

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

test("runRepairLoop clamps maxIterations to the CLAUDE.md cap of 5", async () => {
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
    judgeModel: "claude-opus-4-7",
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
    judgeModel: "claude-opus-4-7",
    visualLevel: 0,
    startedAt: 0,
    finishedAt: 1,
    repairAttempts: [],
  });
  assert.equal(report.repairAttempts, undefined);
  assert.ok(!renderReport(report).includes("Self-repair"));
});
