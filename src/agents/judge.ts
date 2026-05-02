import { resolve } from "node:path";
import { trace } from "../trace.js";
import { isStub } from "../stub.js";
import { runLayer1 } from "../validation/layer1.js";
import { runLayer2, type Layer2Mode } from "../validation/layer2.js";
import { runStage1Visual } from "../validation/stage1.js";
import type { Layer3Criterion } from "../validation/layer3.js";
import type { VisualJudgeResult } from "../validation/visual-judge.js";
import type {
  DomainSpec,
  JudgeResult,
  Platform,
  ReviewerResult,
  VisualJudgePlatformReport,
  WorkerResult,
} from "./types.js";

export type JudgeInput = {
  domain: DomainSpec;
  rails: WorkerResult;
  ios: WorkerResult;
  android: WorkerResult;
  reviewer: ReviewerResult;
  layer2Mode?: Layer2Mode;
  visual?: VisualJudgeConfig;
};

// outDir-based: runJudge calls runStage1Visual which discovers the build
// artifact + identifier from each provided platform dir post-Layer-2-build.
// Caller must enable layer2Mode: "build" for the discovery to find anything.
export type VisualJudgeConfig = {
  iosDir?: string;
  androidDir?: string;
  screenshotDir?: string;
  rubric?: readonly Layer3Criterion[];
  spec?: string;
};

type PlatformReport = {
  platform: Platform;
  layer1Pass: boolean;
  layer1Findings: number;
  layer2Pass: boolean;
  layer2Command: string;
  layer2DurationMs: number;
};

export async function runJudge(input: JudgeInput): Promise<JudgeResult> {
  if (isStub("judge")) return runStubJudge();

  const layer2Mode: Layer2Mode = input.layer2Mode ?? "fast";
  trace("judge", "Layer 1 (structural) — scanning for leftover tokens");
  trace("judge", `Layer 2 (runtime, ${layer2Mode} mode) — validating toolchains load`);

  const reports = await Promise.all([
    evaluate(input.rails, layer2Mode),
    evaluate(input.ios, layer2Mode),
    evaluate(input.android, layer2Mode),
  ]);

  for (const r of reports) {
    const l1 = r.layer1Pass ? "PASS" : `FAIL (${r.layer1Findings} leftover tokens)`;
    const l2 = r.layer2Pass ? `PASS (${(r.layer2DurationMs / 1000).toFixed(1)}s)` : "FAIL";
    trace("judge", `${r.platform}: Layer 1 ${l1} · Layer 2 ${l2} [${r.layer2Command}]`);
  }

  let visualReport: { ios?: VisualJudgePlatformReport; android?: VisualJudgePlatformReport } | undefined;
  let layer3Summary = "Layer 3 skipped";
  if (input.visual && (input.visual.iosDir || input.visual.androidDir)) {
    visualReport = await runVisualPhase(input.visual, input.domain);
    layer3Summary = formatLayer3Summary(visualReport);
  } else {
    trace("judge", "Layer 3 (semantic, Opus 4.7 vision judge) — visual config not provided; skipped");
  }

  const layer1Layer2Pass = reports.every((r) => r.layer1Pass && r.layer2Pass);
  const visualPass = visualReport
    ? Object.values(visualReport).every((r): r is VisualJudgePlatformReport => Boolean(r) && r!.pass)
    : true;
  const overallPass = layer1Layer2Pass && visualPass;
  const l1Total = reports.filter((r) => r.layer1Pass).length;
  const l2Total = reports.filter((r) => r.layer2Pass).length;

  return {
    overallPass,
    summary: `Layer 1 ${l1Total}/3 pass · Layer 2 ${l2Total}/3 pass · ${layer3Summary}`,
    ...(visualReport ? { visual: visualReport } : {}),
  };
}

async function runVisualPhase(
  config: VisualJudgeConfig,
  domain: DomainSpec,
): Promise<{ ios?: VisualJudgePlatformReport; android?: VisualJudgePlatformReport }> {
  const platforms: Array<"ios" | "android"> = [];
  if (config.iosDir) platforms.push("ios");
  if (config.androidDir) platforms.push("android");

  const rubric = config.rubric;
  trace("judge", `Layer 3 (semantic) — judging ${platforms.join(" + ")} home screen against rubric`);

  const stage1 = await runStage1Visual({
    ...(config.iosDir !== undefined ? { iosDir: config.iosDir } : {}),
    ...(config.androidDir !== undefined ? { androidDir: config.androidDir } : {}),
    spec: config.spec ?? domain.displayName,
    ...(rubric !== undefined ? { rubric } : {}),
    ...(config.screenshotDir !== undefined ? { screenshotDir: config.screenshotDir } : {}),
  });

  const report: { ios?: VisualJudgePlatformReport; android?: VisualJudgePlatformReport } = {};
  if (stage1.ios) {
    report.ios = toPlatformReport(stage1.ios);
    trace("judge", `Layer 3 ios: ${stage1.ios.ok ? "PASS" : "FAIL"}` + (stage1.ios.error ? ` — ${stage1.ios.error}` : ""));
  }
  if (stage1.android) {
    report.android = toPlatformReport(stage1.android);
    trace("judge", `Layer 3 android: ${stage1.android.ok ? "PASS" : "FAIL"}` + (stage1.android.error ? ` — ${stage1.android.error}` : ""));
  }
  return report;
}

function toPlatformReport(result: VisualJudgeResult): VisualJudgePlatformReport {
  const report: VisualJudgePlatformReport = { pass: result.ok };
  if (result.screenshotPath !== undefined) report.screenshotPath = result.screenshotPath;
  if (result.layer3?.scores) report.scores = result.layer3.scores;
  if (result.error !== undefined) report.error = result.error;
  return report;
}

function formatLayer3Summary(report: { ios?: VisualJudgePlatformReport; android?: VisualJudgePlatformReport }): string {
  const platforms = (["ios", "android"] as const).filter((p) => report[p] !== undefined);
  const passing = platforms.filter((p) => report[p]?.pass).length;
  return `Layer 3 ${passing}/${platforms.length} pass`;
}

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

async function runStubJudge(): Promise<JudgeResult> {
  trace("judge", "(stub mode)");
  trace("judge", "Layer 1 (structural): ripgrep leftover tokens");
  await delay(200);
  trace("judge", "Layer 1: PASS");
  await delay(100);
  trace("judge", "Layer 2 (runtime): boot Rails, launch iOS, launch Android");
  await delay(400);
  trace("judge", "Layer 2: PASS (scripted CRUD walk)");
  await delay(100);
  trace("judge", "Layer 3 (semantic): Opus 4.7 judge, median of 3 runs");
  await delay(300);
  trace("judge", "Layer 3: PASS (semantic score above threshold)");
  return { overallPass: true, summary: "Layer 1/2/3 PASS" };
}

async function evaluate(worker: WorkerResult, layer2Mode: Layer2Mode): Promise<PlatformReport> {
  const outDir = resolve(process.cwd(), worker.outDir);

  const [layer1, layer2] = await Promise.all([
    runLayer1({ projectDir: outDir, forbiddenTokens: worker.renamedFrom }),
    runLayer2({ platform: worker.platform, outDir, mode: layer2Mode }),
  ]);

  return {
    platform: worker.platform,
    layer1Pass: layer1.pass,
    layer1Findings: layer1.findings.length,
    layer2Pass: layer2.pass,
    layer2Command: layer2.command,
    layer2DurationMs: layer2.durationMs,
  };
}
