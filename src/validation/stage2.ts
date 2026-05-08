import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { MobileClient, ScreenElement } from "../mobile.js";

// Layer 2 Stage 2 scenario runner per docs/SPEC.md.
//
// Drives a typed sequence of UI steps against an already-launched app via
// the mobile-mcp wrapper. Captures screenshots at labeled gates so they can
// flow into Layer 3 (Stage 2 vision rubric) in the eventual judge wiring.
//
// Scope of this file:
//   - Step DSL (find/click/type/wait/assert/screenshot)
//   - Sequential runner that fail-stops on the first error
//   - Defensive element parsing — mobile-mcp's element shape varies by
//     platform; we probe common label / coord fields rather than commit
//     to one schema.
//
// Out of scope:
//   - Spawning the app or sim — caller does that (Layer 2 build mode +
//     install + launch lives in src/validation/launch.ts).
//   - Rails log tail companion — small follow-up PR.
//   - Judge integration (Layer 3 rubric specific to Stage 2 screenshots) —
//     PR 3 of the Stage 2 series.

export type Stage2Step =
  | { kind: "wait_for_text"; text: string; timeoutMs?: number }
  | { kind: "tap_text"; text: string; timeoutMs?: number }
  | { kind: "tap_coordinates"; x: number; y: number; label?: string }
  | { kind: "type"; text: string }
  | { kind: "press_button"; button: string }
  | { kind: "screenshot"; label: string }
  | { kind: "assert_text"; text: string };

export type Stage2Scenario = {
  name: string;
  steps: readonly Stage2Step[];
};

export type Stage2StepResult = {
  step: Stage2Step;
  ok: boolean;
  durationMs: number;
  error?: string;
  screenshotPath?: string;
};

export type Stage2Result = {
  ok: boolean;
  scenarioName: string;
  steps: readonly Stage2StepResult[];
  screenshots: readonly string[];
};

export type Stage2Input = {
  client: MobileClient;
  scenario: Stage2Scenario;
  screenshotDir: string;
  pollIntervalMs?: number;
  defaultWaitMs?: number;
};

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_WAIT_MS = 10_000;

export async function runStage2Scenario(input: Stage2Input): Promise<Stage2Result> {
  await mkdir(input.screenshotDir, { recursive: true });
  const pollMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const waitMs = input.defaultWaitMs ?? DEFAULT_WAIT_MS;

  const stepResults: Stage2StepResult[] = [];
  const screenshots: string[] = [];
  let ok = true;

  for (let i = 0; i < input.scenario.steps.length; i++) {
    const step = input.scenario.steps[i]!;
    const started = Date.now();
    try {
      const screenshotPath = await runStep({
        step,
        index: i,
        client: input.client,
        scenario: input.scenario,
        screenshotDir: input.screenshotDir,
        pollMs,
        waitMs,
      });
      const result: Stage2StepResult = {
        step,
        ok: true,
        durationMs: Date.now() - started,
      };
      if (screenshotPath) {
        result.screenshotPath = screenshotPath;
        screenshots.push(screenshotPath);
      }
      stepResults.push(result);
    } catch (err) {
      ok = false;
      stepResults.push({
        step,
        ok: false,
        durationMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }
  }

  return {
    ok,
    scenarioName: input.scenario.name,
    steps: stepResults,
    screenshots,
  };
}

type RunStepArgs = {
  step: Stage2Step;
  index: number;
  client: MobileClient;
  scenario: Stage2Scenario;
  screenshotDir: string;
  pollMs: number;
  waitMs: number;
};

async function runStep(a: RunStepArgs): Promise<string | undefined> {
  switch (a.step.kind) {
    case "wait_for_text": {
      await waitForText(a.client, a.step.text, a.step.timeoutMs ?? a.waitMs, a.pollMs);
      return undefined;
    }
    case "tap_text": {
      const el = await waitForText(a.client, a.step.text, a.step.timeoutMs ?? a.waitMs, a.pollMs);
      const center = centerOf(el);
      if (!center) throw new Error(`tap_text "${a.step.text}": found element but could not extract coordinates`);
      await a.client.click(center.x, center.y);
      return undefined;
    }
    case "tap_coordinates": {
      await a.client.click(a.step.x, a.step.y);
      return undefined;
    }
    case "type": {
      await a.client.typeKeys(a.step.text);
      return undefined;
    }
    case "press_button": {
      await a.client.pressButton(a.step.button);
      return undefined;
    }
    case "screenshot": {
      const filename = `${slug(a.scenario.name)}-${pad(a.index)}-${slug(a.step.label)}.png`;
      const path = join(a.screenshotDir, filename);
      await a.client.saveScreenshot(path);
      return path;
    }
    case "assert_text": {
      const elements = await a.client.listElements();
      if (!findByText(elements, a.step.text)) {
        throw new Error(`assert_text "${a.step.text}": not visible on screen`);
      }
      return undefined;
    }
  }
}

async function waitForText(
  client: MobileClient,
  text: string,
  timeoutMs: number,
  pollMs: number,
): Promise<ScreenElement> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = 0;
  while (Date.now() < deadline) {
    const elements = await client.listElements();
    lastSeen = elements.length;
    const match = findByText(elements, text);
    if (match) return match;
    await sleep(pollMs);
  }
  throw new Error(
    `wait_for_text "${text}": not found within ${timeoutMs}ms (last poll saw ${lastSeen} elements)`,
  );
}

const TEXT_FIELDS = ["label", "name", "text", "value", "title", "accessibilityLabel", "placeholder"] as const;

function findByText(elements: readonly ScreenElement[], needle: string): ScreenElement | undefined {
  const target = needle.toLowerCase();
  for (const el of elements) {
    for (const field of TEXT_FIELDS) {
      const v = el[field];
      if (typeof v === "string" && v.toLowerCase().includes(target)) return el;
    }
  }
  return undefined;
}

// mobile-mcp's element shape varies by platform: iOS often returns a flat
// {x, y, width, height}; Android sometimes nests under {rect: {...}} or
// {bounds: {...}}. Probe the common shapes; return undefined if none match.
function centerOf(element: ScreenElement): { x: number; y: number } | undefined {
  const candidates: Record<string, unknown>[] = [
    element,
    element["rect"] as Record<string, unknown> | undefined ?? {},
    element["bounds"] as Record<string, unknown> | undefined ?? {},
    element["frame"] as Record<string, unknown> | undefined ?? {},
  ];
  for (const c of candidates) {
    const x = numberAt(c, "x");
    const y = numberAt(c, "y");
    const w = numberAt(c, "width") ?? numberAt(c, "w");
    const h = numberAt(c, "height") ?? numberAt(c, "h");
    if (x !== undefined && y !== undefined && w !== undefined && h !== undefined) {
      return { x: x + w / 2, y: y + h / 2 };
    }
    if (x !== undefined && y !== undefined) {
      return { x, y };
    }
  }
  return undefined;
}

function numberAt(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === "number" ? v : undefined;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "step";
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
