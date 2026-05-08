import { test } from "node:test";
import assert from "node:assert/strict";
import { runLayer1, runLayer2, runLayer3, captureScreenshot, installAndLaunch, runVisualJudge, DEFAULT_STAGE1_RUBRIC, discoverIosArtifact, discoverAndroidArtifact, runStage1Visual } from "../src/validation/index.js";
import { dispatch } from "../src/dispatch.js";
import { runReviewer } from "../src/agents/reviewer.js";
import { canonicalizeEndpoint, diffContracts } from "../src/agents/contract-extract.js";

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

test("buildQueueScenario uses renamed Shop label and walks sign-up → list → toggle", async () => {
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
    { email: "x@y.z", password: "p", primaryResourceName: "Acme" },
  );
  assert.equal(scenario.name, "queue-crud-vet-clinic");
  // Renamed primary noun reaches the wait_for_text after auth.
  assert.ok(
    scenario.steps.some((s) => s.kind === "wait_for_text" && s.text === "Clinic"),
    "expected a wait_for_text 'Clinic' step",
  );
  // Inputs reach the type steps.
  assert.ok(scenario.steps.some((s) => s.kind === "type" && s.text === "x@y.z"));
  assert.ok(scenario.steps.some((s) => s.kind === "type" && s.text === "Acme"));
  // Toggle reaches the assert at the tail.
  const tail = scenario.steps[scenario.steps.length - 1];
  assert.deepEqual(tail, { kind: "assert_text", text: "Completed" });
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
  // primitives the truncated scenario below actually calls.
  const fake = new McpServer({ name: "fake-mobile-mcp", version: "0.0.0" });
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
  const sc = call.structuredContent as { overallPass?: boolean; summary?: string };
  assert.equal(sc.overallPass, true);
  assert.match(sc.summary ?? "", /PASS/);

  await client.close();
  await server.close();
});
