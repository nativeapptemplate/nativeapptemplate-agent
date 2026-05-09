import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { scrubbedEnv } from "../env.js";
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
  // optional:true swallows wait/find failures and just continues. Use
  // for system overlays that appear conditionally (e.g. iOS Keychain
  // "Save password?" prompt after signup) — you want to dismiss the
  // dialog if it shows, otherwise no-op.
  | { kind: "tap_text"; text: string; timeoutMs?: number; optional?: boolean }
  | { kind: "tap_coordinates"; x: number; y: number; label?: string }
  // Tap a few px below an element matched by text. For forms where a
  // StaticText label sits above a TextField with no label-for binding
  // (the substrate's pattern) — tap_text would hit the dead label;
  // tap_below_text focuses the field below it. Default offset is 30px.
  | { kind: "tap_below_text"; text: string; offsetY?: number; timeoutMs?: number }
  // submit:true taps the keyboard's return/submit key after typing —
  // useful as the last form-field type to dismiss the keyboard so a
  // submit button below it becomes tappable.
  | { kind: "type"; text: string; submit?: boolean }
  | { kind: "press_button"; button: string; optional?: boolean }
  | { kind: "screenshot"; label: string }
  | { kind: "assert_text"; text: string }
  // Run a single-line Ruby snippet via `mise exec -- bin/rails runner`
  // in the given outDir. Used to bypass parts of the substrate's auth
  // flow that aren't traversable via UI alone (e.g. clicking the email
  // confirmation link). The Ruby snippet runs server-side, scoped to
  // the just-spawned Stage 2 Rails process, so it can manipulate the
  // app's database directly.
  | { kind: "rails_runner"; outDir: string; ruby: string; label?: string; timeoutMs?: number }
  // Tap an unlabeled input by element type. iOS forms often have a
  // StaticText label sitting above an unlabeled TextField/
  // SecureTextField; tap_below_text bias-taps where the field
  // *should* be, but is fragile when the form layout differs from
  // the substrate's typical Sign Up form. tap_field finds the n-th
  // element matching ANY of the provided types (substring,
  // case-insensitive — so "TextField" matches "TextField" + iOS
  // "SecureTextField", "EditText" matches Android "android.widget.
  // EditText") and taps its center directly. Pass multiple types to
  // handle iOS + Android in one step.
  | { kind: "tap_field"; fieldTypes: readonly string[]; nth?: number };

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
      // Prefer a Button-typed match when multiple elements share the
      // text — tap_text implies tapping something interactive, and
      // pages often duplicate copy between a StaticText header and a
      // Button at the bottom (e.g. iOS sign-up form has both).
      const optional = a.step.optional === true;
      try {
        const el = await waitForText(a.client, a.step.text, a.step.timeoutMs ?? a.waitMs, a.pollMs, "Button");
        const center = centerOf(el);
        if (!center) throw new Error(`tap_text "${a.step.text}": found element but could not extract coordinates`);
        await a.client.click(center.x, center.y);
      } catch (err) {
        if (optional) return undefined;
        throw err;
      }
      return undefined;
    }
    case "tap_coordinates": {
      await a.client.click(a.step.x, a.step.y);
      return undefined;
    }
    case "tap_below_text": {
      const el = await waitForText(a.client, a.step.text, a.step.timeoutMs ?? a.waitMs, a.pollMs);
      const center = centerOf(el);
      if (!center) throw new Error(`tap_below_text "${a.step.text}": found element but could not extract coordinates`);
      const labelHeight = labelHeightOf(el) ?? 0;
      const offsetY = a.step.offsetY ?? 30;
      // Bias to the center of where the field below typically sits:
      // labelCenter.y + labelHeight/2 (bottom of label) + offsetY.
      const targetY = center.y + labelHeight / 2 + offsetY;
      await a.client.click(center.x, targetY);
      return undefined;
    }
    case "type": {
      await a.client.typeKeys(a.step.text, a.step.submit ?? false);
      return undefined;
    }
    case "press_button": {
      try {
        await a.client.pressButton(a.step.button);
      } catch (err) {
        if (a.step.optional) return undefined;
        throw err;
      }
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
    case "rails_runner": {
      await runRailsRunner(a.step.outDir, a.step.ruby, a.step.timeoutMs ?? 30_000, a.step.label);
      return undefined;
    }
    case "tap_field": {
      const fieldTypes = a.step.fieldTypes.map((t) => t.toLowerCase());
      const nth = a.step.nth ?? 0;
      const elements = await a.client.listElements();
      const matches = elements.filter((el) => {
        const t = el["type"];
        if (typeof t !== "string") return false;
        const lower = t.toLowerCase();
        return fieldTypes.some((ft) => lower.includes(ft));
      });
      const target = matches[nth];
      if (!target) {
        throw new Error(`tap_field [${a.step.fieldTypes.join(",")}] (nth=${nth}): no element matched (saw ${matches.length} of these types out of ${elements.length} total)`);
      }
      const center = centerOf(target);
      if (!center) throw new Error(`tap_field [${a.step.fieldTypes.join(",")}]: found element but could not extract coordinates`);
      await a.client.click(center.x, center.y);
      return undefined;
    }
  }
}

async function runRailsRunner(outDir: string, ruby: string, timeoutMs: number, label?: string): Promise<void> {
  await new Promise<void>((resolveStep, rejectStep) => {
    const child = spawn("mise", ["exec", "--", "bin/rails", "runner", ruby], {
      cwd: outDir,
      env: scrubbedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: string[] = [];
    child.stdout?.on("data", (c: Buffer) => out.push(c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => out.push(c.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveStep();
      else rejectStep(new Error(`rails_runner${label ? ` (${label})` : ""} exited ${code}: ${out.join("").slice(-500)}`));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectStep(err);
    });
  });
}

async function waitForText(
  client: MobileClient,
  text: string,
  timeoutMs: number,
  pollMs: number,
  preferType?: string,
): Promise<ScreenElement> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = 0;
  while (Date.now() < deadline) {
    const elements = await client.listElements();
    lastSeen = elements.length;
    const match = findByText(elements, text, preferType);
    if (match) return match;
    await sleep(pollMs);
  }
  throw new Error(
    `wait_for_text "${text}": not found within ${timeoutMs}ms (last poll saw ${lastSeen} elements)`,
  );
}

const TEXT_FIELDS = ["label", "name", "text", "value", "title", "accessibilityLabel", "placeholder", "identifier"] as const;

function findByText(
  elements: readonly ScreenElement[],
  needle: string,
  preferType?: string,
): ScreenElement | undefined {
  const target = needle.toLowerCase();
  const matches: ScreenElement[] = [];
  for (const el of elements) {
    for (const field of TEXT_FIELDS) {
      const v = el[field];
      if (typeof v === "string" && v.toLowerCase().includes(target)) {
        matches.push(el);
        break;
      }
    }
  }
  if (matches.length === 0) return undefined;
  // When the same text appears on multiple elements (e.g. "Sign Up"
  // shows up as both a StaticText page-header AND a Button at the
  // bottom of the form), prefer the typed match the caller asked for
  // — typically Button for tappable intents. preferType is a
  // case-insensitive substring match so it covers both iOS ("Button")
  // and Android ("android.widget.Button") type strings.
  if (preferType) {
    const want = preferType.toLowerCase();
    const typed = matches.find((el) => {
      const t = el["type"];
      return typeof t === "string" && t.toLowerCase().includes(want);
    });
    if (typed) return typed;
    // preferType was asked but didn't match — common on Android
    // Compose where a submit "Button" is rendered as TextView instead
    // of a typed widget. Fall back to the bottom-most match (submit
    // buttons sit below page headers in every form pattern we've
    // seen). Only do this when preferType was specified — otherwise
    // bottom-most would pick validation messages over labels for
    // cases like wait_for_text "Password" on a form.
    if (matches.length > 1) {
      const withY = matches.map((el) => ({ el, y: topYOf(el) ?? 0 }));
      withY.sort((a, b) => b.y - a.y);
      return withY[0]!.el;
    }
  }
  return matches[0];
}

function topYOf(element: ScreenElement): number | undefined {
  const candidates: Record<string, unknown>[] = [
    element,
    element["coordinates"] as Record<string, unknown> | undefined ?? {},
    element["rect"] as Record<string, unknown> | undefined ?? {},
    element["bounds"] as Record<string, unknown> | undefined ?? {},
    element["frame"] as Record<string, unknown> | undefined ?? {},
  ];
  for (const c of candidates) {
    const y = numberAt(c, "y");
    if (y !== undefined) return y;
  }
  return undefined;
}

// mobile-mcp's element shape varies by platform: iOS often returns a flat
// {x, y, width, height}; Android sometimes nests under {rect: {...}} or
// {bounds: {...}}. Probe the common shapes; return undefined if none match.
function centerOf(element: ScreenElement): { x: number; y: number } | undefined {
  const candidates: Record<string, unknown>[] = [
    element,
    // mobile-mcp 0.0.54 nests under `coordinates: {x,y,width,height}`.
    // iOS/Android variants have used `rect`, `bounds`, `frame` over time.
    element["coordinates"] as Record<string, unknown> | undefined ?? {},
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

function labelHeightOf(element: ScreenElement): number | undefined {
  const candidates: Record<string, unknown>[] = [
    element,
    element["coordinates"] as Record<string, unknown> | undefined ?? {},
    element["rect"] as Record<string, unknown> | undefined ?? {},
    element["bounds"] as Record<string, unknown> | undefined ?? {},
    element["frame"] as Record<string, unknown> | undefined ?? {},
  ];
  for (const c of candidates) {
    const h = numberAt(c, "height") ?? numberAt(c, "h");
    if (h !== undefined) return h;
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
