import { spawn } from "node:child_process";
import { scrubbedEnv } from "../env.js";
import { resolveAdbPath } from "../adb.js";

export type LaunchResult = {
  ok: boolean;
  command: string;
  durationMs: number;
  error?: string;
};

export type IosLaunchInput = {
  platform: "ios";
  appPath: string;
  bundleId: string;
  timeoutMs?: number;
};

export type AndroidLaunchInput = {
  platform: "android";
  apkPath: string;
  packageName: string;
  timeoutMs?: number;
};

export type LaunchInput = IosLaunchInput | AndroidLaunchInput;

const DEFAULT_TIMEOUT_MS = 60_000;

// Install and launch the generated app on whatever sim/emulator is currently
// booted. Discovery (finding the .app / .apk artifact, deriving the bundle ID
// / package name from the slug) is the caller's concern — this function takes
// already-resolved inputs and runs the install + launch chain.
//
// Chain per platform (a best-effort uninstall runs first — see below):
//   iOS:     xcrun simctl uninstall booted <bundleId>          (best-effort)
//            xcrun simctl install   booted <appPath>
//            xcrun simctl launch    booted <bundleId>
//   Android: adb uninstall <package>                           (best-effort)
//            adb install -r <apkPath>
//            adb shell pm grant <package> POST_NOTIFICATIONS   (best-effort)
//            adb shell monkey -p <package> -c android.intent.category.LAUNCHER 1
//
// The leading uninstall clears prior per-run state — notably a Keychain/app
// auth token persisted by an earlier run, which (against a since-recreated DB)
// makes the app error to a "Back to Start Screen" launch state and fail Stage
// 1. It's best-effort: on the first run (app not installed) it errors and is
// ignored. This gives each run a clean install.
//
// `monkey` on Android is used over `am start -n <pkg>/<activity>` because it
// only needs the package name — the caller doesn't have to know which activity
// is the entry point, just the rename plan's slug-derived package.
//
// Screen-readiness polling is NOT done here; the caller should sleep briefly
// before captureScreenshot() so the home screen has rendered. A future PR may
// add an explicit ready-poll using accessibility tree or pixel diff.
export async function installAndLaunch(input: LaunchInput): Promise<LaunchResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  switch (input.platform) {
    case "ios":
      return installAndLaunchIos(input.appPath, input.bundleId, timeoutMs);
    case "android":
      return installAndLaunchAndroid(input.apkPath, input.packageName, timeoutMs);
  }
}

async function installAndLaunchIos(appPath: string, bundleId: string, timeoutMs: number): Promise<LaunchResult> {
  const started = Date.now();
  const uninstallCmd = `xcrun simctl uninstall booted ${bundleId}`;
  const installCmd = `xcrun simctl install booted ${appPath}`;
  const launchCmd = `xcrun simctl launch booted ${bundleId}`;

  // Best-effort clean: drop any prior install (and its stale auth/Keychain
  // state) so this run starts fresh. Ignore errors (e.g. not installed yet).
  await runOnce("xcrun", ["simctl", "uninstall", "booted", bundleId], timeoutMs);

  const install = await runOnce("xcrun", ["simctl", "install", "booted", appPath], timeoutMs);
  if (!install.ok) {
    return {
      ok: false,
      command: `${uninstallCmd} ; ${installCmd}`,
      durationMs: Date.now() - started,
      ...(install.error !== undefined ? { error: install.error } : {}),
    };
  }
  const launch = await runOnce("xcrun", ["simctl", "launch", "booted", bundleId], timeoutMs);
  return {
    ok: launch.ok,
    command: `${uninstallCmd} ; ${installCmd} && ${launchCmd}`,
    durationMs: Date.now() - started,
    ...(launch.ok || launch.error === undefined ? {} : { error: launch.error }),
  };
}

async function installAndLaunchAndroid(apkPath: string, packageName: string, timeoutMs: number): Promise<LaunchResult> {
  const adb = resolveAdbPath();
  const started = Date.now();

  // adb fails with "more than one device/emulator" when >1 device is
  // attached unless `-s <serial>` disambiguates. Common on dev machines
  // that have a real phone plugged in alongside an emulator. Pick the
  // emulator (the agent's standard CI target — emulators boot reliably
  // and are reproducible). If exactly one device, pass through with no
  // -s. If zero, fail fast with a useful error rather than letting adb
  // produce its terse "no devices/emulators found".
  const targeting = await selectAdbTarget(adb, timeoutMs);
  if (!targeting.ok) {
    return {
      ok: false,
      command: `${adb} devices`,
      durationMs: Date.now() - started,
      error: targeting.error,
    };
  }

  const targetArgs = targeting.serial !== undefined ? ["-s", targeting.serial] : [];
  const targetForCmd = targeting.serial !== undefined ? ` -s ${targeting.serial}` : "";
  const uninstallCmd = `${adb}${targetForCmd} uninstall ${packageName}`;
  const installCmd = `${adb}${targetForCmd} install -r ${apkPath}`;
  const grantCmd = `${adb}${targetForCmd} shell pm grant ${packageName} android.permission.POST_NOTIFICATIONS`;
  const launchCmd = `${adb}${targetForCmd} shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`;

  // Best-effort clean: clear prior app data (incl. stale auth) before
  // reinstalling. Ignore errors — `uninstall` fails when the package isn't
  // present (first run).
  await runOnce(adb, [...targetArgs, "uninstall", packageName], timeoutMs);

  const install = await runOnce(adb, [...targetArgs, "install", "-r", apkPath], timeoutMs);
  if (!install.ok) {
    return {
      ok: false,
      command: `${uninstallCmd} ; ${installCmd}`,
      durationMs: Date.now() - started,
      ...(install.error !== undefined ? { error: install.error } : {}),
    };
  }

  // Pre-grant the runtime notification permission so Android 13+ (API 33+)
  // doesn't pop the POST_NOTIFICATIONS system dialog on first launch. That
  // dialog overlays the home screen exactly when Stage 1 captures it, which
  // fails Layer 3's "renders-cleanly" rubric. Best-effort: on older API
  // levels (where it isn't a runtime permission) or apps that don't declare
  // it, `pm grant` errors — we ignore the result so it never blocks launch.
  await runOnce(
    adb,
    [...targetArgs, "shell", "pm", "grant", packageName, "android.permission.POST_NOTIFICATIONS"],
    timeoutMs,
  );

  const launch = await runOnce(
    adb,
    [...targetArgs, "shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"],
    timeoutMs,
  );
  return {
    ok: launch.ok,
    command: `${uninstallCmd} ; ${installCmd} && ${grantCmd} && ${launchCmd}`,
    durationMs: Date.now() - started,
    ...(launch.ok || launch.error === undefined ? {} : { error: launch.error }),
  };
}

type AdbTargeting =
  | { ok: true; serial?: string }
  | { ok: false; error: string };

// Picks the right `adb -s <serial>` target when multiple devices are
// attached. Preference: NATIVEAPPTEMPLATE_ADB_SERIAL env override >
// emulator-* (reliable, reproducible) > first device. Returns
// { ok:true, serial:undefined } when exactly one device is attached
// (no -s needed; adb defaults work fine).
export async function selectAdbTarget(adb: string, timeoutMs: number): Promise<AdbTargeting> {
  const override = process.env['NATIVEAPPTEMPLATE_ADB_SERIAL'];
  if (override) return { ok: true, serial: override };

  const list = await runCapture(adb, ["devices"], timeoutMs);
  if (!list.ok) {
    return { ok: false, error: list.error ?? `${adb} devices failed` };
  }

  const serials = parseAdbDevices(list.stdout);
  if (serials.length === 0) {
    return { ok: false, error: "no adb devices/emulators attached (boot one in Android Studio Device Manager)" };
  }
  if (serials.length === 1) return { ok: true };

  const emulator = serials.find((s) => s.startsWith("emulator-"));
  return { ok: true, serial: emulator ?? serials[0]! };
}

export function parseAdbDevices(stdout: string): readonly string[] {
  // `adb devices` output:
  //   List of devices attached
  //   1C081FDF600CMG	device
  //   emulator-5554	device
  //
  // Skip the header, accept only fully-online "device" rows (drop
  // "offline" / "unauthorized" / "no permissions").
  const result: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^(\S+)\s+device$/);
    const serial = m?.[1];
    if (serial !== undefined && serial !== "List") result.push(serial);
  }
  return result;
}

type RunResult = { ok: boolean; error?: string };
type CaptureResult = { ok: true; stdout: string } | { ok: false; error: string };

function runCapture(cmd: string, args: readonly string[], timeoutMs: number): Promise<CaptureResult> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(cmd, [...args], { env: scrubbedEnv(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolvePromise({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const stderrChunks: Buffer[] = [];
    const stdoutChunks: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    const timer = setTimeout(() => { child.kill("SIGTERM"); }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      if (code === 0) {
        resolvePromise({ ok: true, stdout });
      } else {
        resolvePromise({ ok: false, error: stderr || stdout || `${cmd} exited ${code}` });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, error: err.message });
    });
  });
}

function runOnce(cmd: string, args: readonly string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(cmd, [...args], { env: scrubbedEnv(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolvePromise({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const stderrChunks: Buffer[] = [];
    const stdoutChunks: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    const timer = setTimeout(() => { child.kill("SIGTERM"); }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      // adb install prints success/failure on stdout; non-zero exit alone
      // isn't always the right signal. Check for explicit failure markers.
      if (code === 0 && !stdout.toLowerCase().includes("failure")) {
        resolvePromise({ ok: true });
      } else {
        resolvePromise({ ok: false, error: stderr || stdout || `${cmd} exited ${code}` });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, error: err.message });
    });
  });
}
