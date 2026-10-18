import { spawn } from "node:child_process";
import { scrubbedEnv } from "../env.js";
import { resolveAdbPath } from "../adb.js";

export type LaunchResult = {
  ok: boolean;
  command: string;
  durationMs: number;
  error?: string;
  // Non-fatal problems worth surfacing, e.g. the per-app English locale
  // couldn't be set on an Android < 13 device.
  warnings?: readonly string[];
};

// Stage 2's scripted scenario waits for English UI text ("Welcome to", button
// labels), but the generated apps follow the device language. So the app
// under test is launched in English whatever the sim/emulator is set to (#159).
export const APP_UNDER_TEST_LOCALE = "en-US";
export const IOS_ENGLISH_LAUNCH_ARGS = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"] as const;

export function iosLaunchArgs(bundleId: string): readonly string[] {
  return ["simctl", "launch", "booted", bundleId, ...IOS_ENGLISH_LAUNCH_ARGS];
}

// Per-app locale (Android 13 / API 33+). The setting survives relaunches and
// is cleared by the next run's uninstall.
export function androidAppLocaleArgs(packageName: string): readonly string[] {
  return ["shell", "cmd", "locale", "set-app-locales", packageName, "--locales", APP_UNDER_TEST_LOCALE];
}

export type RunResult = { ok: boolean; error?: string };
export type CaptureResult = { ok: true; stdout: string } | { ok: false; error: string };

// The process layer, injectable so tests can check the commands without a
// real simctl / adb.
export type LaunchExec = {
  run(cmd: string, args: readonly string[], timeoutMs: number): Promise<RunResult>;
  capture(cmd: string, args: readonly string[], timeoutMs: number): Promise<CaptureResult>;
};

export const defaultLaunchExec: LaunchExec = {
  run: (cmd, args, timeoutMs) => runOnce(cmd, args, timeoutMs),
  capture: (cmd, args, timeoutMs) => runCapture(cmd, args, timeoutMs),
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
//            xcrun simctl launch    booted <bundleId> -AppleLanguages "(en)" -AppleLocale en_US
//   Android: adb uninstall <package>                           (best-effort)
//            adb install -r <apkPath>
//            adb shell pm grant <package> POST_NOTIFICATIONS   (best-effort)
//            adb shell cmd locale set-app-locales <package> --locales en-US  (API 33+; warns below)
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
export async function installAndLaunch(input: LaunchInput, exec: LaunchExec = defaultLaunchExec): Promise<LaunchResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  switch (input.platform) {
    case "ios":
      return installAndLaunchIos(input.appPath, input.bundleId, timeoutMs, exec);
    case "android":
      return installAndLaunchAndroid(input.apkPath, input.packageName, timeoutMs, exec);
  }
}

async function installAndLaunchIos(appPath: string, bundleId: string, timeoutMs: number, exec: LaunchExec): Promise<LaunchResult> {
  const started = Date.now();
  const uninstallCmd = `xcrun simctl uninstall booted ${bundleId}`;
  const installCmd = `xcrun simctl install booted ${appPath}`;
  const launchArgs = iosLaunchArgs(bundleId);
  const launchCmd = `xcrun ${launchArgs.map((a) => (a.includes("(") ? `"${a}"` : a)).join(" ")}`;

  // Best-effort clean: drop any prior install (and its stale auth/Keychain
  // state) so this run starts fresh. Ignore errors (e.g. not installed yet).
  await exec.run("xcrun", ["simctl", "uninstall", "booted", bundleId], timeoutMs);

  const install = await exec.run("xcrun", ["simctl", "install", "booted", appPath], timeoutMs);
  if (!install.ok) {
    return {
      ok: false,
      command: `${uninstallCmd} ; ${installCmd}`,
      durationMs: Date.now() - started,
      ...(install.error !== undefined ? { error: install.error } : {}),
    };
  }
  const launch = await exec.run("xcrun", launchArgs, timeoutMs);
  return {
    ok: launch.ok,
    command: `${uninstallCmd} ; ${installCmd} && ${launchCmd}`,
    durationMs: Date.now() - started,
    ...(launch.ok || launch.error === undefined ? {} : { error: launch.error }),
  };
}

async function installAndLaunchAndroid(apkPath: string, packageName: string, timeoutMs: number, exec: LaunchExec): Promise<LaunchResult> {
  const adb = resolveAdbPath();
  const started = Date.now();

  // adb fails with "more than one device/emulator" when >1 device is
  // attached unless `-s <serial>` disambiguates. Common on dev machines
  // that have a real phone plugged in alongside an emulator. Pick the
  // emulator (the agent's standard CI target — emulators boot reliably
  // and are reproducible). If exactly one device, pass through with no
  // -s. If zero, fail fast with a useful error rather than letting adb
  // produce its terse "no devices/emulators found".
  const targeting = await selectAdbTarget(adb, timeoutMs, exec);
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
  const localeCmd = `${adb}${targetForCmd} ${androidAppLocaleArgs(packageName).join(" ")}`;
  const launchCmd = `${adb}${targetForCmd} shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`;

  // Best-effort clean: clear prior app data (incl. stale auth) before
  // reinstalling. Ignore errors — `uninstall` fails when the package isn't
  // present (first run).
  await exec.run(adb, [...targetArgs, "uninstall", packageName], timeoutMs);

  const install = await exec.run(adb, [...targetArgs, "install", "-r", apkPath], timeoutMs);
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
  await exec.run(
    adb,
    [...targetArgs, "shell", "pm", "grant", packageName, "android.permission.POST_NOTIFICATIONS"],
    timeoutMs,
  );

  // Launch in English whatever the device language (#159). `cmd locale
  // set-app-locales` needs Android 13 (API 33+); on older devices it fails —
  // launch anyway and say so, since the app then follows the device language.
  const warnings: string[] = [];
  const locale = await exec.run(adb, [...targetArgs, ...androidAppLocaleArgs(packageName)], timeoutMs);
  if (!locale.ok) {
    warnings.push(
      `could not set ${packageName}'s app locale to ${APP_UNDER_TEST_LOCALE} (needs Android 13 / API 33+): ${locale.error ?? "unknown error"} — the app follows the device language, and Stage 2 needs it in English`,
    );
  }

  const launch = await exec.run(
    adb,
    [...targetArgs, "shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"],
    timeoutMs,
  );
  return {
    ok: launch.ok,
    command: `${uninstallCmd} ; ${installCmd} && ${grantCmd} && ${localeCmd} && ${launchCmd}`,
    durationMs: Date.now() - started,
    ...(launch.ok || launch.error === undefined ? {} : { error: launch.error }),
    ...(warnings.length > 0 ? { warnings } : {}),
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
export async function selectAdbTarget(adb: string, timeoutMs: number, exec: LaunchExec = defaultLaunchExec): Promise<AdbTargeting> {
  const override = process.env['NATIVEAPPTEMPLATE_ADB_SERIAL'];
  if (override) return { ok: true, serial: override };

  const list = await exec.capture(adb, ["devices"], timeoutMs);
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
