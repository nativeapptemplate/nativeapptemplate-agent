import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { runStage2Scenario, type Stage2Result, type Stage2Scenario } from "./stage2.js";
import { runLayer3, type Layer3Criterion } from "./layer3.js";
import { createMobileClient, type MobileClient, type ScreenElement } from "../mobile.js";
import type { Stage2PlatformReport } from "../agents/types.js";

// Layer 2 Stage 2 visual judge: pairs the scripted-CRUD scenario runner
// with the Layer 3 vision judge so the agent can score post-CRUD
// screenshots ("does this read as a [renamed-domain] queue?") rather
// than just the launch screen.
//
// Per platform: connect mobile-mcp → walk the scenario → judge the
// representative (last) screenshot against a Stage-2-specific rubric →
// fold into a Stage2PlatformReport. Caller is responsible for ensuring
// Layer 2 has built the artifact, the sim/emulator is booted, and the
// app is already installed + launched on the home screen — runStage2-
// Visual picks up from there and walks the user-flow.
//
// Stub story: the underlying mobile.ts wrapper short-circuits when
// NATIVEAPPTEMPLATE_STUB_MOBILE / STUB_ALL is set, so the stub runner
// returns no elements and wait_for_text times out. To keep stub mode
// usable for smoke tests, callers should pass a pre-built MobileClient
// (the test factory `attachMobileClient` against an in-memory server),
// or accept that scenario execution will fail in stub mode and surface
// as a structured Stage2PlatformReport with ok=false.

export type Stage2VisualInput = {
  // Build a per-platform scenario from outside. We don't pull domain
  // through to keep the orchestrator decoupled — callers (judge.ts)
  // build with buildQueueScenario(domain, inputs).
  iosScenario?: Stage2Scenario;
  androidScenario?: Stage2Scenario;
  screenshotDir?: string;
  spec: string;
  rubric?: readonly Layer3Criterion[];
  // Test seam — let tests pass a pre-wired client (e.g. against an
  // in-memory fake mobile-mcp) instead of spawning npx mobile-mcp.
  iosClient?: MobileClient;
  androidClient?: MobileClient;
};

export type Stage2VisualResult = {
  ios?: Stage2PlatformReport;
  android?: Stage2PlatformReport;
};

// Stage 2 rubric — domain content (because we've now navigated to the
// list/detail view past auth) plus a defensive substrate-leak check.
// Stage 1's "renders cleanly" criterion is intentionally not repeated;
// if the app crashed Layer 2 build mode would have caught it.
export const DEFAULT_STAGE2_RUBRIC: readonly Layer3Criterion[] = [
  {
    id: "domain-content",
    question:
      "Does this screen show the user's domain content (a list with at least one user-created entry, or a detail view of one such entry, with that entry's state badge visible)? PASS if there's a visible list/detail item the user just created. FAIL if it shows only a launch / welcome / login / signup / empty state.",
  },
  {
    id: "no-substrate-leak",
    question:
      "Is the screen free of substrate-original tokens like 'Shop', 'Shopkeeper', 'ItemTag', 'NativeAppTemplate', or 'Number Tag'?",
  },
];

export async function runStage2Visual(input: Stage2VisualInput): Promise<Stage2VisualResult> {
  const screenshotDir = input.screenshotDir ?? join(process.cwd(), "tmp", "screenshots");
  await mkdir(screenshotDir, { recursive: true });
  const rubric = input.rubric ?? DEFAULT_STAGE2_RUBRIC;

  const result: Stage2VisualResult = {};
  if (input.iosScenario) {
    result.ios = await runOnePlatform({
      platform: "ios",
      scenario: input.iosScenario,
      screenshotDir,
      spec: input.spec,
      rubric,
      ...(input.iosClient !== undefined ? { client: input.iosClient } : {}),
    });
  }
  if (input.androidScenario) {
    result.android = await runOnePlatform({
      platform: "android",
      scenario: input.androidScenario,
      screenshotDir,
      spec: input.spec,
      rubric,
      ...(input.androidClient !== undefined ? { client: input.androidClient } : {}),
    });
  }
  return result;
}

type RunOneArgs = {
  platform: "ios" | "android";
  scenario: Stage2Scenario;
  screenshotDir: string;
  spec: string;
  rubric: readonly Layer3Criterion[];
  client?: MobileClient;
};

async function runOnePlatform(args: RunOneArgs): Promise<Stage2PlatformReport> {
  const ownsClient = args.client === undefined;
  const client = args.client ?? (await createMobileClient());
  try {
    // mobile-mcp requires a `device` argument on every tool call.
    // Bootstrap: list available devices, pick the right one for this
    // platform, set it as the active device on the wrapper. Subsequent
    // calls inject device transparently.
    const targetingErr = await selectDevice(client, args.platform);
    if (targetingErr) {
      return {
        pass: false,
        scenarioName: args.scenario.name,
        stepCount: args.scenario.steps.length,
        stepsPassed: 0,
        screenshots: [],
        error: targetingErr,
      };
    }

    const scenario = await runStage2Scenario({
      client,
      scenario: args.scenario,
      screenshotDir: args.screenshotDir,
    });

    const baseReport = toBaseReport(scenario);

    // Run Layer 3 on the LAST captured screenshot even if a later
    // scenario step failed — a partial walk that reached the domain
    // content is still worth scoring. Stage2PlatformReport.pass
    // remains gated on scenario.ok && layer3.pass below, so partial
    // walks don't sneak through as overall PASS.
    if (scenario.screenshots.length === 0) {
      return baseReport;
    }

    const representative = scenario.screenshots[scenario.screenshots.length - 1]!;
    const layer3 = await runLayer3({
      screenshotPath: representative,
      rubric: args.rubric,
      spec: args.spec,
    });

    return {
      ...baseReport,
      pass: scenario.ok && layer3.pass,
      representativeScreenshot: representative,
      layer3Scores: layer3.scores,
    };
  } finally {
    if (ownsClient) await client.close();
  }
}

// Picks the mobile-mcp device for a platform and sets it as active on
// the wrapper. Returns undefined on success, an error string on
// failure. Heuristic: filter listDevices() by platform field if
// available; otherwise filter by a substring match on the name (iOS
// names tend to start with "iPhone"/"iPad"; Android emulators with
// "emulator-"). Honors NATIVEAPPTEMPLATE_MOBILE_<IOS|ANDROID>_DEVICE
// env var as an override for explicit targeting.
export async function selectDevice(
  client: MobileClient,
  platform: "ios" | "android",
): Promise<string | undefined> {
  const overrideKey =
    platform === "ios" ? "NATIVEAPPTEMPLATE_MOBILE_IOS_DEVICE" : "NATIVEAPPTEMPLATE_MOBILE_ANDROID_DEVICE";
  const override = process.env[overrideKey];

  let devices: readonly ScreenElement[];
  try {
    devices = await client.listDevices();
  } catch (err) {
    // Discovery failed. If an override is set, fall back to using it raw as a
    // best-effort escape hatch; otherwise surface the failure.
    if (override) {
      client.useDevice(override);
      return undefined;
    }
    return `mobile-mcp listDevices failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (override) {
    // Resolve the override against the device list, matching either the
    // canonical id or the display name, and pass the id onward. mobile-mcp's
    // per-device tools require the id (UDID for iOS sims, serial for Android);
    // a display name like "iPhone 17" passed raw fails every call with
    // "Device not found" (and the wrapper reads that as 0 elements). Map
    // name -> id here instead of trusting the override string blindly.
    const hit = devices.find((d) => deviceMatchesHandle(d, override));
    if (hit) {
      const id = deviceNameOf(hit);
      if (id) {
        client.useDevice(id);
        return undefined;
      }
    }
    const seen = devices.map((d) => deviceNameOf(d) ?? "<unnamed>").join(", ");
    return `${overrideKey}="${override}" matched no booted device (saw: ${seen}). Pass the device id or its exact name.`;
  }

  if (devices.length === 0) {
    return `no mobile-mcp devices available (boot the ${platform} sim/emulator first)`;
  }

  const match = devices.find((d) => devicePlatformMatches(d, platform));
  if (!match) {
    const names = devices.map((d) => deviceNameOf(d) ?? "<unnamed>").join(", ");
    return `no mobile-mcp device matched platform=${platform} (saw: ${names}). Override with ${overrideKey}=<device-name-or-id>.`;
  }
  const name = deviceNameOf(match);
  if (!name) {
    return `mobile-mcp returned a matching device with no usable name field`;
  }
  client.useDevice(name);
  return undefined;
}

// True if `handle` equals any of the device's identifying fields — used to
// resolve a user-supplied override (which may be a display name OR an id)
// against mobile-mcp's device list.
function deviceMatchesHandle(d: ScreenElement, handle: string): boolean {
  for (const key of ["id", "udid", "serial", "name", "deviceName"] as const) {
    if (d[key] === handle) return true;
  }
  return false;
}

function deviceNameOf(d: ScreenElement): string | undefined {
  // mobile-mcp's response carries both `id` (canonical handle — UDID
  // for iOS sims, serial for Android emulators/devices) and `name`
  // (display name like "Pixel 6", "iPhone 17"). Pass the canonical id
  // to the `device` parameter on subsequent tool calls — it's
  // unambiguous when multiple devices share a display name.
  for (const key of ["id", "udid", "serial", "name", "deviceName"] as const) {
    const v = d[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function devicePlatformMatches(d: ScreenElement, platform: "ios" | "android"): boolean {
  // Direct platform field is the easy case.
  for (const key of ["platform", "type", "os"] as const) {
    const v = d[key];
    if (typeof v === "string" && v.toLowerCase().includes(platform)) return true;
  }
  // Fallback: heuristic on the name.
  const name = deviceNameOf(d) ?? "";
  if (platform === "ios") return /^(iPhone|iPad|iPod)/i.test(name);
  return /^(emulator-|Android|Pixel|Galaxy|Nexus)/i.test(name);
}

function toBaseReport(scenario: Stage2Result): Stage2PlatformReport {
  const stepsPassed = scenario.steps.filter((s) => s.ok).length;
  const failingError = scenario.steps.find((s) => !s.ok)?.error;
  const report: Stage2PlatformReport = {
    pass: scenario.ok,
    scenarioName: scenario.scenarioName,
    stepCount: scenario.steps.length,
    stepsPassed,
    screenshots: scenario.screenshots,
  };
  if (failingError !== undefined) report.error = failingError;
  return report;
}
