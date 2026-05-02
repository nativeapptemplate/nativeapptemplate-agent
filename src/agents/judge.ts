import { resolve, join } from "node:path";
import { trace } from "../trace.js";
import { isStub } from "../stub.js";
import { runLayer1 } from "../validation/layer1.js";
import { runLayer2 } from "../validation/layer2.js";
import {
  runVisualJudge,
  DEFAULT_STAGE1_RUBRIC,
  type VisualJudgeResult,
} from "../validation/visual-judge.js";
import type { Layer3Criterion } from "../validation/layer3.js";
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
  visual?: VisualJudgeConfig;
};

export type VisualJudgeConfig = {
  ios?: { artifactPath: string; bundleId: string };
  android?: { artifactPath: string; packageName: string };
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

  trace("judge", "Layer 1 (structural) — scanning for leftover tokens");
  trace("judge", "Layer 2 (runtime) — validating toolchains load");

  const reports = await Promise.all([
    evaluate(input.rails),
    evaluate(input.ios),
    evaluate(input.android),
  ]);

  for (const r of reports) {
    const l1 = r.layer1Pass ? "PASS" : `FAIL (${r.layer1Findings} leftover tokens)`;
    const l2 = r.layer2Pass ? `PASS (${(r.layer2DurationMs / 1000).toFixed(1)}s)` : "FAIL";
    trace("judge", `${r.platform}: Layer 1 ${l1} · Layer 2 ${l2} [${r.layer2Command}]`);
  }

  let visualReport: { ios?: VisualJudgePlatformReport; android?: VisualJudgePlatformReport } | undefined;
  let layer3Summary = "Layer 3 skipped";
  if (input.visual && (input.visual.ios || input.visual.android)) {
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
  const screenshotDir = config.screenshotDir ?? resolve(process.cwd(), "tmp", "screenshots", domain.slug);
  const rubric = config.rubric ?? DEFAULT_STAGE1_RUBRIC;
  const spec = config.spec ?? domain.displayName;

  const platforms: Array<"ios" | "android"> = [];
  if (config.ios) platforms.push("ios");
  if (config.android) platforms.push("android");

  trace("judge", `Layer 3 (semantic) — judging ${platforms.join(" + ")} home screen against ${rubric.length}-criterion rubric`);

  const results = await Promise.all(platforms.map(async (platform) => {
    const cfg = platform === "ios" ? config.ios! : config.android!;
    const screenshotPath = join(screenshotDir, `${platform}-home.png`);
    const visualResult = await runVisualJudge(
      platform === "ios"
        ? {
            platform: "ios",
            artifactPath: cfg.artifactPath,
            bundleId: (cfg as { bundleId: string }).bundleId,
            screenshotPath,
            spec,
            rubric,
          }
        : {
            platform: "android",
            artifactPath: cfg.artifactPath,
            packageName: (cfg as { packageName: string }).packageName,
            screenshotPath,
            spec,
            rubric,
          },
    );
    trace(
      "judge",
      `Layer 3 ${platform}: ${visualResult.ok ? "PASS" : "FAIL"}` +
        (visualResult.error ? ` — ${visualResult.error}` : ""),
    );
    return [platform, toPlatformReport(visualResult)] as const;
  }));

  return Object.fromEntries(results);
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

async function evaluate(worker: WorkerResult): Promise<PlatformReport> {
  const outDir = resolve(process.cwd(), worker.outDir);

  const [layer1, layer2] = await Promise.all([
    runLayer1({ projectDir: outDir, forbiddenTokens: worker.renamedFrom }),
    runLayer2({ platform: worker.platform, outDir }),
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
