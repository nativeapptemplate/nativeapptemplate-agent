import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { scrubbedEnv } from "../env.js";

export type CapturePlatform = "ios" | "android";

export type CaptureResult = {
  ok: boolean;
  path: string;
  command: string;
  durationMs: number;
  error?: string;
};

export type CaptureInput = {
  platform: CapturePlatform;
  outPath: string;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;

// Capture the home screen of whatever's currently booted on the iOS Simulator
// or Android emulator. The agent does NOT boot the sim/emulator itself —
// that's a developer-environment concern (per memory: user runs Android Studio
// Device Manager for AVDs; iOS Simulator started via Xcode). This function
// assumes one is already running and the target app is on its home screen.
//
// Install + launch + screen-readiness polling are separate concerns; they'll
// land in follow-up PRs that wire post-Layer-2-build → install → launch →
// captureScreenshot → runLayer3 together.
export async function captureScreenshot(input: CaptureInput): Promise<CaptureResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await mkdir(dirname(input.outPath), { recursive: true });

  switch (input.platform) {
    case "ios":
      return captureIos(input.outPath, timeoutMs);
    case "android":
      return captureAndroid(input.outPath, timeoutMs);
  }
}

async function captureIos(outPath: string, timeoutMs: number): Promise<CaptureResult> {
  const command = `xcrun simctl io booted screenshot ${outPath}`;
  const started = Date.now();
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn("xcrun", ["simctl", "io", "booted", "screenshot", outPath], {
        env: scrubbedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolvePromise({
        ok: false,
        path: outPath,
        command,
        durationMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    const timer = setTimeout(() => { child.kill("SIGTERM"); }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code === 0) {
        resolvePromise({ ok: true, path: outPath, command, durationMs });
      } else {
        resolvePromise({
          ok: false,
          path: outPath,
          command,
          durationMs,
          error: stderr || `xcrun simctl exited ${code}`,
        });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        ok: false,
        path: outPath,
        command,
        durationMs: Date.now() - started,
        error: err.message,
      });
    });
  });
}

async function captureAndroid(outPath: string, timeoutMs: number): Promise<CaptureResult> {
  const command = `adb exec-out screencap -p > ${outPath}`;
  const started = Date.now();
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn("adb", ["exec-out", "screencap", "-p"], {
        env: scrubbedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolvePromise({
        ok: false,
        path: outPath,
        command,
        durationMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const out = createWriteStream(outPath);
    let pipeError: Error | null = null;
    out.on("error", (err) => { pipeError = err; });
    child.stdout.pipe(out);

    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    const timer = setTimeout(() => { child.kill("SIGTERM"); }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      out.end(() => {
        const durationMs = Date.now() - started;
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        if (code === 0 && !pipeError) {
          resolvePromise({ ok: true, path: outPath, command, durationMs });
        } else {
          resolvePromise({
            ok: false,
            path: outPath,
            command,
            durationMs,
            error: pipeError?.message ?? stderr ?? `adb exited ${code}`,
          });
        }
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      out.end();
      resolvePromise({
        ok: false,
        path: outPath,
        command,
        durationMs: Date.now() - started,
        error: err.message,
      });
    });
  });
}
