import { resolve } from "node:path";
import { runPlanner } from "./agents/planner.js";
import { runRailsWorker } from "./agents/workers/rails.js";
import { runIosWorker } from "./agents/workers/ios.js";
import { runAndroidWorker } from "./agents/workers/android.js";
import { runReviewer } from "./agents/reviewer.js";
import { runJudge, type VisualJudgeConfig } from "./agents/judge.js";
import type { JudgeResult } from "./agents/types.js";

export async function dispatch(spec: string): Promise<JudgeResult> {
  const domain = await runPlanner(spec);
  const [rails, ios, android] = await Promise.all([
    runRailsWorker(domain),
    runIosWorker(domain),
    runAndroidWorker(domain),
  ]);
  const reviewer = await runReviewer({ domain, rails, ios, android });

  // Stage 1 visual judging is opt-in via NATIVEAPPTEMPLATE_VISUAL=1.
  // It forces Layer 2 build mode (so .app / .apk artifacts exist for the
  // discovery + install + launch + capture chain) and adds 60-180s to a
  // run depending on the substrate's cold-build time. Off by default.
  const visualEnabled = process.env['NATIVEAPPTEMPLATE_VISUAL'] === "1";
  const visual: VisualJudgeConfig | undefined = visualEnabled
    ? {
        iosDir: resolve(process.cwd(), ios.outDir),
        androidDir: resolve(process.cwd(), android.outDir),
        spec: domain.displayName,
      }
    : undefined;

  return runJudge({
    domain,
    rails,
    ios,
    android,
    reviewer,
    ...(visualEnabled ? { layer2Mode: "build" as const } : {}),
    ...(visual ? { visual } : {}),
  });
}
