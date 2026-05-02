import { spawn } from "node:child_process";
import { scrubbedEnv } from "../env.js";

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
// Two-step chain per platform:
//   iOS:     xcrun simctl install booted <appPath>
//            xcrun simctl launch  booted <bundleId>
//   Android: adb install <apkPath>
//            adb shell monkey -p <package> -c android.intent.category.LAUNCHER 1
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
  const installCmd = `xcrun simctl install booted ${appPath}`;
  const launchCmd = `xcrun simctl launch booted ${bundleId}`;

  const install = await runOnce("xcrun", ["simctl", "install", "booted", appPath], timeoutMs);
  if (!install.ok) {
    return {
      ok: false,
      command: installCmd,
      durationMs: Date.now() - started,
      ...(install.error !== undefined ? { error: install.error } : {}),
    };
  }
  const launch = await runOnce("xcrun", ["simctl", "launch", "booted", bundleId], timeoutMs);
  return {
    ok: launch.ok,
    command: `${installCmd} && ${launchCmd}`,
    durationMs: Date.now() - started,
    ...(launch.ok || launch.error === undefined ? {} : { error: launch.error }),
  };
}

async function installAndLaunchAndroid(apkPath: string, packageName: string, timeoutMs: number): Promise<LaunchResult> {
  const started = Date.now();
  const installCmd = `adb install -r ${apkPath}`;
  const launchCmd = `adb shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`;

  const install = await runOnce("adb", ["install", "-r", apkPath], timeoutMs);
  if (!install.ok) {
    return {
      ok: false,
      command: installCmd,
      durationMs: Date.now() - started,
      ...(install.error !== undefined ? { error: install.error } : {}),
    };
  }
  const launch = await runOnce(
    "adb",
    ["shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"],
    timeoutMs,
  );
  return {
    ok: launch.ok,
    command: `${installCmd} && ${launchCmd}`,
    durationMs: Date.now() - started,
    ...(launch.ok || launch.error === undefined ? {} : { error: launch.error }),
  };
}

type RunResult = { ok: boolean; error?: string };

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
