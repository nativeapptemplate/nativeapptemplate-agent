import { runPlanner } from "./agents/planner.js";
import { runRailsWorker } from "./agents/workers/rails.js";
import { runIosWorker } from "./agents/workers/ios.js";
import { runAndroidWorker } from "./agents/workers/android.js";
import { runReviewer } from "./agents/reviewer.js";
import { runJudge } from "./agents/judge.js";
import type { JudgeResult } from "./agents/types.js";

export async function dispatch(spec: string): Promise<JudgeResult> {
  const domain = await runPlanner(spec);
  const [rails, ios, android] = await Promise.all([
    runRailsWorker(domain),
    runIosWorker(domain),
    runAndroidWorker(domain),
  ]);
  const reviewer = await runReviewer({ domain, rails, ios, android });
  return runJudge({ domain, rails, ios, android, reviewer });
}
