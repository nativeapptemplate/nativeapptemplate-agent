import { execFile } from "node:child_process";
import { resolveAdbPath } from "./adb.js";
import { scrubbedEnv } from "./env.js";
import { parseAdbDevices } from "./validation/launch.js";
import type { VisualLevel } from "./run-options.js";

// Visual levels 1 and 2 install and judge the app on a booted iOS simulator and
// an attached Android emulator/device, and level 2 also boots the generated
// Rails API under `mise exec -- bin/dev`. Without them the run would spend the
// planner call and minutes of builds before failing in Stage 1, so check first
// (#160) — before any Anthropic API call.

export type IosSimulator = { udid: string; name: string };
type Listing<T> = { ok: true; items: readonly T[] } | { ok: false; error: string };

export type PreflightDeps = {
  bootedIosSimulators(): Promise<Listing<IosSimulator>>;
  // Online adb serials (`adb devices` rows in state "device").
  adbDevices(): Promise<Listing<string>>;
  hasMise(): Promise<boolean>;
};

export class PreflightError extends Error {
  readonly problems: readonly string[];
  constructor(level: VisualLevel, problems: readonly string[]) {
    super(`visual level ${level} needs a few things that aren't ready:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "PreflightError";
    this.problems = problems;
  }
}

export async function preflightVisual(
  level: VisualLevel,
  deps: PreflightDeps = defaultPreflightDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly string[]> {
  if (level < 1) return [];
  const [ios, android, mise] = await Promise.all([
    checkIos(deps, env),
    checkAndroid(deps, env),
    level >= 2 ? deps.hasMise() : Promise.resolve(true),
  ]);
  const problems = [ios, android].filter((p): p is string => p !== undefined);
  if (!mise) {
    problems.push("`mise` isn't on PATH: visual level 2 boots the generated Rails API with `mise exec -- bin/dev` for the Stage 2 walk. Install it (https://mise.jdx.dev) or use --visual=1.");
  }
  return problems;
}

export async function assertVisualPreflight(level: VisualLevel, deps?: PreflightDeps, env?: NodeJS.ProcessEnv): Promise<void> {
  const problems = await preflightVisual(level, deps, env);
  if (problems.length > 0) throw new PreflightError(level, problems);
}

async function checkIos(deps: PreflightDeps, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const list = await deps.bootedIosSimulators();
  if (!list.ok) return `couldn't list iOS simulators (xcrun simctl list devices booted): ${list.error}`;
  const override = env["NATIVEAPPTEMPLATE_MOBILE_IOS_DEVICE"];
  if (override) {
    if (list.items.some((d) => d.udid === override || d.name === override)) return undefined;
    const seen = list.items.map((d) => `${d.name} (${d.udid})`).join(", ") || "none";
    return `NATIVEAPPTEMPLATE_MOBILE_IOS_DEVICE="${override}" is not a booted simulator (booted: ${seen}). Boot it or fix the variable.`;
  }
  if (list.items.length === 0) {
    return 'no iOS simulator is booted. Boot one (e.g. `xcrun simctl boot "iPhone 17 Pro"`, or open Simulator.app), or use --visual=0.';
  }
  return undefined;
}

async function checkAndroid(deps: PreflightDeps, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const list = await deps.adbDevices();
  if (!list.ok) return `couldn't list Android devices (adb devices): ${list.error}`;
  const serial = env["NATIVEAPPTEMPLATE_ADB_SERIAL"];
  if (serial && !list.items.includes(serial)) {
    return `NATIVEAPPTEMPLATE_ADB_SERIAL="${serial}" is not attached (adb devices: ${list.items.join(", ") || "none"}). Boot it or fix the variable.`;
  }
  if (list.items.length === 0) {
    return "no Android emulator or device is attached (adb devices lists none). Boot an emulator in Android Studio's Device Manager (or `emulator -avd <name>`), or use --visual=0.";
  }
  return undefined;
}

export const defaultPreflightDeps: PreflightDeps = {
  async bootedIosSimulators() {
    const out = await capture("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
    if (!out.ok) return out;
    try {
      return { ok: true, items: parseBootedIosSimulators(out.stdout) };
    } catch (err) {
      return { ok: false, error: `unreadable simctl output: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
  async adbDevices() {
    const out = await capture(resolveAdbPath(), ["devices"]);
    return out.ok ? { ok: true, items: parseAdbDevices(out.stdout) } : out;
  },
  async hasMise() {
    return (await capture("mise", ["--version"])).ok;
  },
};

// `xcrun simctl list devices booted -j`: {"devices": {"<runtime id>": [{udid, name, state}]}}.
// Only iOS runtimes count — a booted watchOS simulator can't run the app.
export function parseBootedIosSimulators(json: string): readonly IosSimulator[] {
  const parsed = JSON.parse(json) as { devices?: Record<string, Array<{ udid?: string; name?: string; state?: string }>> };
  const result: IosSimulator[] = [];
  for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
    if (!/\.iOS-/.test(runtime)) continue;
    for (const d of devices) {
      if (d.state === "Booted" && d.udid && d.name) result.push({ udid: d.udid, name: d.name });
    }
  }
  return result;
}

function capture(cmd: string, args: readonly string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(cmd, [...args], { env: scrubbedEnv(), timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: String(stderr).trim() || err.message });
      else resolve({ ok: true, stdout: String(stdout) });
    });
  });
}
