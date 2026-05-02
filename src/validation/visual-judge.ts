import { setTimeout as sleep } from "node:timers/promises";
import { runLayer3, type Layer3Criterion, type Layer3Result } from "./layer3.js";
import { captureScreenshot, type CapturePlatform } from "./capture.js";
import { installAndLaunch, type LaunchResult } from "./launch.js";

export type VisualJudgeInput = {
  platform: CapturePlatform;
  // .app bundle path (iOS) or .apk path (Android).
  artifactPath: string;
  // Required when platform === "ios".
  bundleId?: string;
  // Required when platform === "android".
  packageName?: string;
  // Where to write the captured PNG.
  screenshotPath: string;
  spec: string;
  rubric: readonly Layer3Criterion[];
  // How long to sleep between launch and screenshot to let the home screen
  // render. 3s works for most apps; bump for cold-start-heavy ones.
  renderWaitMs?: number;
  // Forwarded to runLayer3.
  samplesPerCriterion?: number;
  model?: string;
};

export type VisualJudgeResult = {
  ok: boolean;
  launch: LaunchResult;
  screenshotPath?: string;
  layer3?: Layer3Result;
  error?: string;
};

const DEFAULT_RENDER_WAIT_MS = 3_000;

// End-to-end Stage 1 visual judge for one platform:
//   1. install + launch the built app on the booted sim/emulator
//   2. wait for render
//   3. capture the home screen as PNG
//   4. send PNG + rubric to the Opus 4.7 vision judge (median-of-3 per criterion)
//
// Fail-fast: any step's failure short-circuits and surfaces in the result.
// Caller is responsible for: building the artifact (Layer 2 build mode),
// resolving artifactPath / bundleId / packageName from the slug, and ensuring
// a sim/emulator is booted.
export async function runVisualJudge(input: VisualJudgeInput): Promise<VisualJudgeResult> {
  const launch = await installAndLaunch(
    input.platform === "ios"
      ? {
          platform: "ios",
          appPath: input.artifactPath,
          bundleId: requireField(input.bundleId, "bundleId is required for platform=ios"),
        }
      : {
          platform: "android",
          apkPath: input.artifactPath,
          packageName: requireField(input.packageName, "packageName is required for platform=android"),
        },
  );
  if (!launch.ok) {
    return {
      ok: false,
      launch,
      error: `install/launch failed: ${launch.error ?? "unknown"}`,
    };
  }

  await sleep(input.renderWaitMs ?? DEFAULT_RENDER_WAIT_MS);

  const capture = await captureScreenshot({
    platform: input.platform,
    outPath: input.screenshotPath,
  });
  if (!capture.ok) {
    return {
      ok: false,
      launch,
      error: `screenshot capture failed: ${capture.error ?? "unknown"}`,
    };
  }

  const layer3 = await runLayer3({
    screenshotPath: capture.path,
    rubric: input.rubric,
    spec: input.spec,
    ...(input.samplesPerCriterion !== undefined ? { samplesPerCriterion: input.samplesPerCriterion } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
  });

  return {
    ok: layer3.pass,
    launch,
    screenshotPath: capture.path,
    layer3,
  };
}

// Default Stage 1 rubric for home-screen judging — three Yes/No criteria
// covering domain match, substrate-leak detection, and basic render sanity.
// Phrased so pass=true is the desired state on every criterion.
export const DEFAULT_STAGE1_RUBRIC: readonly Layer3Criterion[] = [
  {
    id: "domain-match",
    question:
      "Does this screen unambiguously read as the SaaS product described in the spec, to a typical user seeing it for the first time?",
  },
  {
    id: "no-substrate-leak",
    question:
      "Is the screen free of substrate-original tokens like 'Shop', 'Shopkeeper', 'ItemTag', 'NativeAppTemplate', or 'Number Tag'?",
  },
  {
    id: "renders-cleanly",
    question:
      "Does the home screen render without obvious layout breakage, missing icons or images, or placeholder text where real content should appear?",
  },
];

function requireField<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
