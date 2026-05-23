import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { discoverIosArtifact, discoverAndroidArtifact } from "./discover.js";
import { runVisualJudge, DEFAULT_STAGE1_RUBRIC, type VisualJudgeResult } from "./visual-judge.js";
import type { Layer3Criterion } from "./layer3.js";

export type Stage1VisualInput = {
  // Pre-built output dirs. Pass undefined to skip the platform.
  iosDir?: string;
  androidDir?: string;
  // Where to write screenshots. Defaults to <cwd>/tmp/screenshots.
  screenshotDir?: string;
  spec: string;
  rubric?: readonly Layer3Criterion[];
  renderWaitMs?: number;
  samplesPerCriterion?: number;
  // Optional per-platform recovery run before a judge retry (e.g. tap "Back to
  // Start Screen" to clear an intermittent error screen). Wired by the caller
  // when a mobile client is available (VISUAL=2).
  iosRecover?: () => Promise<void>;
  androidRecover?: () => Promise<void>;
};

export type Stage1VisualResult = {
  ios?: VisualJudgeResult;
  android?: VisualJudgeResult;
};

// One-call convenience wrapper for the Stage 1 visual judge: discover the
// pre-built artifact + identifier on each requested platform (#42), then run
// the install → launch → capture → judge chain (#40, #41) for that platform.
//
// Returns a Stage1VisualResult shaped to match JudgeInput.visual's per-
// platform expectation, so callers can pass it through to runJudge directly.
//
// Caller responsibilities:
//   - Run Layer 2 in build mode first so the .app / .apk exists.
//   - Ensure a sim/emulator is booted for each platform being judged.
//   - Pick which platforms to judge — pass undefined for the others.
export async function runStage1Visual(input: Stage1VisualInput): Promise<Stage1VisualResult> {
  const screenshotDir = input.screenshotDir ?? join(process.cwd(), "tmp", "screenshots");
  await mkdir(screenshotDir, { recursive: true });
  const rubric = input.rubric ?? DEFAULT_STAGE1_RUBRIC;

  const result: Stage1VisualResult = {};

  if (input.iosDir) {
    const ios = await discoverIosArtifact(input.iosDir);
    if (ios) {
      result.ios = await runVisualJudge({
        platform: "ios",
        artifactPath: ios.appPath,
        bundleId: ios.bundleId,
        screenshotPath: join(screenshotDir, "ios-home.png"),
        spec: input.spec,
        rubric,
        ...(input.renderWaitMs !== undefined ? { renderWaitMs: input.renderWaitMs } : {}),
        ...(input.samplesPerCriterion !== undefined ? { samplesPerCriterion: input.samplesPerCriterion } : {}),
        ...(input.iosRecover !== undefined ? { recover: input.iosRecover } : {}),
      });
    } else {
      result.ios = stubFailure("ios", "iOS artifact not discovered (run Layer 2 build mode first)");
    }
  }

  if (input.androidDir) {
    const android = await discoverAndroidArtifact(input.androidDir);
    if (android) {
      result.android = await runVisualJudge({
        platform: "android",
        artifactPath: android.apkPath,
        packageName: android.packageName,
        screenshotPath: join(screenshotDir, "android-home.png"),
        spec: input.spec,
        rubric,
        ...(input.renderWaitMs !== undefined ? { renderWaitMs: input.renderWaitMs } : {}),
        ...(input.samplesPerCriterion !== undefined ? { samplesPerCriterion: input.samplesPerCriterion } : {}),
        ...(input.androidRecover !== undefined ? { recover: input.androidRecover } : {}),
      });
    } else {
      result.android = stubFailure("android", "Android artifact not discovered (run Layer 2 build mode first)");
    }
  }

  return result;
}

function stubFailure(platform: "ios" | "android", error: string): VisualJudgeResult {
  return {
    ok: false,
    launch: {
      ok: false,
      command: `discover ${platform} artifact`,
      durationMs: 0,
      error,
    },
    error,
  };
}
