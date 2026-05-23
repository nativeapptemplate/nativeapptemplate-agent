import { setTimeout as sleep } from "node:timers/promises";
import { readFile } from "node:fs/promises";
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
  // Initial sleep after launch before the first capture, to let the app get
  // past cold start. 3s works for most apps; bump for cold-start-heavy ones.
  renderWaitMs?: number;
  // After the initial wait, poll the screen until two consecutive captures are
  // byte-identical (settled) — so the judged frame isn't a mid-transition one.
  // Cap the extra wait at stabilityTimeoutMs; on cap the last frame is used.
  stabilityIntervalMs?: number;
  stabilityTimeoutMs?: number;
  // If the judge fails *only* on transient render quality (renders-cleanly),
  // re-settle + re-judge up to this many times — a fresh frame may render
  // clean. Content failures (e.g. substrate-leak) are deterministic and not
  // retried. Each retry is a full vision-judge pass, so keep it small.
  maxJudgeRetries?: number;
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
const DEFAULT_STABILITY_INTERVAL_MS = 700;
const DEFAULT_STABILITY_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_JUDGE_RETRIES = 1;

// Criteria whose failure is plausibly a transient bad capture (mid-transition
// frame) rather than a deterministic content problem — safe to retry with a
// fresh capture. Substrate-leak is content-based and NOT in here.
const RETRYABLE_CRITERIA = new Set<string>(["renders-cleanly"]);

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

  const stabilityOpts = {
    intervalMs: input.stabilityIntervalMs ?? DEFAULT_STABILITY_INTERVAL_MS,
    maxWaitMs: input.stabilityTimeoutMs ?? DEFAULT_STABILITY_TIMEOUT_MS,
  };

  // Settle the screen (two consecutive byte-identical frames) before judging,
  // and retry the settle+judge if the judge fails *only* on transient render
  // quality — a fresh frame may render clean. See judgeWithRetry.
  const result = await judgeWithRetry(
    {
      settleCapture: async () => {
        // Each capture overwrites screenshotPath, so on success it holds the
        // settled (or last) frame the judge then reads.
        const stable = await waitForStableCapture(
          {
            captureOnce: async () => {
              const c = await captureScreenshot({ platform: input.platform, outPath: input.screenshotPath });
              if (!c.ok) return { ok: false, ...(c.error !== undefined ? { error: c.error } : {}) };
              try {
                return { ok: true, bytes: await readFile(input.screenshotPath) };
              } catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
              }
            },
            sleep: (ms) => sleep(ms),
            now: () => Date.now(),
          },
          stabilityOpts,
        );
        return stable.ok ? { ok: true } : { ok: false, ...(stable.error !== undefined ? { error: stable.error } : {}) };
      },
      judge: () =>
        runLayer3({
          screenshotPath: input.screenshotPath,
          rubric: input.rubric,
          spec: input.spec,
          ...(input.samplesPerCriterion !== undefined ? { samplesPerCriterion: input.samplesPerCriterion } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
        }),
    },
    { maxRetries: input.maxJudgeRetries ?? DEFAULT_MAX_JUDGE_RETRIES },
  );
  if (!result.ok || result.layer3 === undefined) {
    return {
      ok: false,
      launch,
      error: `screenshot capture failed: ${result.error ?? "unknown"}`,
    };
  }

  return {
    ok: result.layer3.pass,
    launch,
    screenshotPath: input.screenshotPath,
    layer3: result.layer3,
  };
}

// Poll captures until two consecutive frames are byte-identical (the screen
// has settled), or until maxWaitMs elapses (then accept the last frame). DI'd
// (captureOnce / sleep / now) so the loop is unit-testable without a sim.
export type StableCaptureDeps = {
  captureOnce: () => Promise<{ ok: boolean; bytes?: Buffer; error?: string }>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export async function waitForStableCapture(
  deps: StableCaptureDeps,
  opts: { intervalMs: number; maxWaitMs: number },
): Promise<{ ok: boolean; settled: boolean; error?: string }> {
  const deadline = deps.now() + opts.maxWaitMs;
  let prev: Buffer | undefined;
  for (;;) {
    const cap = await deps.captureOnce();
    if (!cap.ok) {
      return { ok: false, settled: false, ...(cap.error !== undefined ? { error: cap.error } : {}) };
    }
    if (prev !== undefined && cap.bytes !== undefined && cap.bytes.equals(prev)) {
      return { ok: true, settled: true };
    }
    prev = cap.bytes;
    if (deps.now() >= deadline) {
      return { ok: true, settled: false }; // cap hit — accept the last frame
    }
    await deps.sleep(opts.intervalMs);
  }
}

// True when the judge failed and *every* failing criterion is retry-safe
// (transient render quality), so a fresh capture might pass. A content failure
// (e.g. substrate-leak) is deterministic — re-capturing the same screen won't
// change it — so this returns false and the caller won't waste a judge pass.
export function isTransientRenderFail(layer3: Layer3Result): boolean {
  if (layer3.pass) return false;
  const failing = layer3.scores.filter((s) => !s.pass);
  return failing.length > 0 && failing.every((s) => RETRYABLE_CRITERIA.has(s.criterionId));
}

// Settle + capture + judge, retrying the whole thing when the judge fails only
// on transient render quality. DI'd (settleCapture / judge) so it's unit-tested
// without a sim or the real vision judge. ok=false only when the *initial*
// capture fails (nothing to judge); a capture failure on a retry keeps the
// prior judgement.
export type JudgeRetryDeps = {
  settleCapture: () => Promise<{ ok: boolean; error?: string }>;
  judge: () => Promise<Layer3Result>;
};

export async function judgeWithRetry(
  deps: JudgeRetryDeps,
  opts: { maxRetries: number },
): Promise<{ ok: boolean; layer3?: Layer3Result; error?: string }> {
  const first = await deps.settleCapture();
  if (!first.ok) {
    return { ok: false, ...(first.error !== undefined ? { error: first.error } : {}) };
  }
  let layer3 = await deps.judge();
  let retries = 0;
  while (!layer3.pass && retries < opts.maxRetries && isTransientRenderFail(layer3)) {
    retries++;
    const re = await deps.settleCapture();
    if (!re.ok) break; // capture failed on retry — keep the prior judgement
    layer3 = await deps.judge();
  }
  return { ok: true, layer3 };
}

// Default Stage 1 rubric — two Yes/No criteria covering substrate-leak
// detection and basic render sanity. Phrased so pass=true is the desired
// state on every criterion.
//
// Per docs/SPEC.md, Stage 1 captures the post-launch screen and is scoped
// to "catch egregious rename failures" — substrate-leak detection plus
// 'does anything render at all'. Domain-semantic matching (e.g. "does this
// read as a clinic queue?") requires reaching the actual domain UI past
// onboarding/login and lives in Stage 2 (mobile-mcp navigation), where
// the agent can drive the app to a list/detail/form screen before
// judging. Adding a domain-match criterion here would false-fail any
// substrate that ships with onboarding-before-domain-UI — which is the
// substrate's intentional design.
export const DEFAULT_STAGE1_RUBRIC: readonly Layer3Criterion[] = [
  {
    id: "no-substrate-leak",
    question:
      "Is the screen free of substrate-original tokens like 'Shop', 'Shopkeeper', 'ItemTag', 'NativeAppTemplate', or 'Number Tag'?",
  },
  {
    id: "renders-cleanly",
    question:
      "Does the screen render without an actual rendering failure — that is, no crash dialog, no broken-image-icon glyphs, no text overlapping other text, no content cut off the side of the screen? A welcome / launch / onboarding screen with decorative graphics counts as PASS as long as nothing is technically broken; do not judge whether the screen looks 'finished' or shows the app's domain content.",
  },
];

function requireField<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
