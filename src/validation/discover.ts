import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { scrubbedEnv } from "../env.js";

export type IosArtifact = { appPath: string; bundleId: string };
export type AndroidArtifact = { apkPath: string; packageName: string };

// Matches Layer 2 build mode's IOS_DESTINATION so showBuildSettings sees the
// same SDK/configuration that `xcodebuild build` produced.
const IOS_DESTINATION = "platform=iOS Simulator,name=iPhone 17,OS=26.2";

// After Layer 2 build mode has built the iOS .app, ask xcodebuild where it
// landed and read the bundle identifier from the built Info.plist (so any
// $(VAR) interpolations are already resolved). Returns null if the build
// hasn't happened, the project layout doesn't match expectations, or the
// build settings query fails.
export async function discoverIosArtifact(iosDir: string): Promise<IosArtifact | null> {
  const entries = await readdir(iosDir).catch(() => [] as string[]);
  const xcodeproj = entries.find((e) => e.endsWith(".xcodeproj"));
  if (!xcodeproj) return null;
  const scheme = xcodeproj.replace(/\.xcodeproj$/, "");

  const settings = await runShowBuildSettings(iosDir, xcodeproj, scheme);
  if (!settings) return null;
  const builtProductsDir = settings["BUILT_PRODUCTS_DIR"];
  const wrapperName = settings["WRAPPER_NAME"];
  if (!builtProductsDir || !wrapperName) return null;

  const appPath = join(builtProductsDir, wrapperName);
  const appExists = await stat(appPath).then(() => true).catch(() => false);
  if (!appExists) return null;

  const bundleId = await readBundleId(join(appPath, "Info.plist"));
  if (!bundleId) return null;

  return { appPath, bundleId };
}

// Android `applicationId` lives in `app/build.gradle.kts`; the APK path is
// predictable. Returns null if the build hasn't happened or the gradle file
// doesn't have an `applicationId = "..."` line.
export async function discoverAndroidArtifact(androidDir: string): Promise<AndroidArtifact | null> {
  const apkPath = join(androidDir, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
  const apkExists = await stat(apkPath).then(() => true).catch(() => false);
  if (!apkExists) return null;

  const gradlePath = join(androidDir, "app", "build.gradle.kts");
  let gradle: string;
  try {
    gradle = await readFile(gradlePath, "utf8");
  } catch {
    return null;
  }
  const match = gradle.match(/applicationId\s*=\s*"([^"]+)"/);
  if (!match || !match[1]) return null;

  return { apkPath, packageName: match[1] };
}

async function runShowBuildSettings(
  cwd: string,
  xcodeproj: string,
  scheme: string,
): Promise<Record<string, string> | null> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(
        "xcodebuild",
        [
          "-project", xcodeproj,
          "-scheme", scheme,
          "-destination", IOS_DESTINATION,
          "-showBuildSettings",
          "-json",
        ],
        { cwd, env: scrubbedEnv(), stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      resolvePromise(null);
      return;
    }
    const stdoutChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.on("close", (code) => {
      if (code !== 0) { resolvePromise(null); return; }
      try {
        const arr = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")) as Array<{ buildSettings: Record<string, string> }>;
        resolvePromise(arr[0]?.buildSettings ?? null);
      } catch {
        resolvePromise(null);
      }
    });
    child.on("error", () => resolvePromise(null));
  });
}

async function readBundleId(infoPlistPath: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(
        "plutil",
        ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlistPath],
        { env: scrubbedEnv(), stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      resolvePromise(null);
      return;
    }
    const stdoutChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.on("close", (code) => {
      if (code !== 0) { resolvePromise(null); return; }
      const out = Buffer.concat(stdoutChunks).toString("utf8").trim();
      resolvePromise(out || null);
    });
    child.on("error", () => resolvePromise(null));
  });
}
