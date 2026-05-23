import { resolve } from "node:path";
import { trace } from "../trace.js";
import { isStub } from "../stub.js";
import { runLayer1, type Layer1Result } from "../validation/layer1.js";
import { runLayer2, type Layer2Mode, type Layer2Result } from "../validation/layer2.js";
import { runStage1Visual } from "../validation/stage1.js";
import { runStage2Visual } from "../validation/stage2-judge.js";
import { buildQueueScenario } from "../validation/scenarios/queue.js";
import type { Layer3Criterion } from "../validation/layer3.js";
import type { VisualJudgeResult } from "../validation/visual-judge.js";
import type {
  DomainSpec,
  JudgeResult,
  Platform,
  PlatformDetail,
  ReviewerResult,
  Stage2PlatformReport,
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
//
// stage2: when set, runJudge follows Stage 1 with a scripted-CRUD walk
// via mobile-mcp, capturing intermediate screenshots and feeding the
// post-toggle screenshot through Layer 3 against a Stage-2-specific
// rubric. Off by default; opt-in via NATIVEAPPTEMPLATE_VISUAL=2 in the
// dispatch entry point.
export type VisualJudgeConfig = {
  iosDir?: string;
  androidDir?: string;
  screenshotDir?: string;
  rubric?: readonly Layer3Criterion[];
  spec?: string;
  stage2?: {
    primaryResourceName: string;
    fullName: string;
    email: string;
    password: string;
    railsOutDir: string;
    rubric?: readonly Layer3Criterion[];
  };
};

type PlatformEval = {
  platform: Platform;
  layer1: Layer1Result;
  layer2: Layer2Result;
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
    const l1 = r.layer1.pass ? "PASS" : `FAIL (${r.layer1.findings.length} leftover tokens)`;
    const l2 = r.layer2.pass ? `PASS (${(r.layer2.durationMs / 1000).toFixed(1)}s)` : "FAIL";
    trace("judge", `${r.platform}: Layer 1 ${l1} · Layer 2 ${l2} [${r.layer2.command}]`);
  }

  let visualReport: { ios?: VisualJudgePlatformReport; android?: VisualJudgePlatformReport } | undefined;
  let layer3Summary = "Layer 3 skipped";
  if (input.visual && (input.visual.iosDir || input.visual.androidDir)) {
    visualReport = await runVisualPhase(input.visual, input.domain);
    if (input.visual.stage2) {
      visualReport = await runStage2Phase(visualReport, input.visual, input.domain);
    }
    layer3Summary = formatLayer3Summary(visualReport);
  } else {
    trace("judge", "Layer 3 (semantic, Opus 4.7 vision judge) — visual config not provided; skipped");
  }

  const layer1Layer2Pass = reports.every((r) => r.layer1.pass && r.layer2.pass);
  const visualPass = visualReport
    ? Object.values(visualReport).every((r): r is VisualJudgePlatformReport => Boolean(r) && r!.pass)
    : true;
  const reviewerPass = input.reviewer.contractParity === "pass";
  const overallPass = layer1Layer2Pass && visualPass && reviewerPass;
  const l1Total = reports.filter((r) => r.layer1.pass).length;
  const l2Total = reports.filter((r) => r.layer2.pass).length;
  const reviewerSummary = reviewerPass ? "reviewer PASS" : "reviewer FAIL";

  const platforms: PlatformDetail[] = reports.map((r) => {
    const layer3 = r.platform === "ios" ? visualReport?.ios
      : r.platform === "android" ? visualReport?.android
      : undefined;
    return {
      platform: r.platform,
      layer1: { pass: r.layer1.pass, findings: r.layer1.findings },
      layer2: {
        pass: r.layer2.pass,
        command: r.layer2.command,
        mode: layer2Mode,
        exitCode: r.layer2.exitCode,
        durationMs: r.layer2.durationMs,
        ...(r.layer2.stderrTail !== undefined ? { stderrTail: r.layer2.stderrTail } : {}),
      },
      ...(layer3 !== undefined ? { layer3 } : {}),
    };
  });

  return {
    overallPass,
    summary: `Layer 1 ${l1Total}/3 pass · Layer 2 ${l2Total}/3 pass · ${layer3Summary} · ${reviewerSummary}`,
    ...(visualReport ? { visual: visualReport } : {}),
    platforms,
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

async function runStage2Phase(
  base: { ios?: VisualJudgePlatformReport; android?: VisualJudgePlatformReport },
  config: VisualJudgeConfig,
  domain: DomainSpec,
): Promise<{ ios?: VisualJudgePlatformReport; android?: VisualJudgePlatformReport }> {
  if (!config.stage2) return base;

  // Per-platform scenarios with platform-suffixed emails so iOS and
  // Android signups don't collide on "email already taken" — both
  // run against the same shared Rails DB.
  const baseInputs = {
    fullName: config.stage2.fullName,
    password: config.stage2.password,
    primaryResourceName: config.stage2.primaryResourceName,
    railsOutDir: config.stage2.railsOutDir,
  };
  const splitEmail = config.stage2.email.split("@");
  const emailLocal = splitEmail[0] ?? "stage2";
  const emailDomain = splitEmail[1] ?? "example.com";
  const iosScenario = buildQueueScenario(
    domain,
    { ...baseInputs, email: `${emailLocal}+ios@${emailDomain}` },
    "ios",
  );
  const androidScenario = buildQueueScenario(
    domain,
    { ...baseInputs, email: `${emailLocal}+android@${emailDomain}` },
    "android",
  );

  // Only walk Stage 2 on platforms whose Stage 1 already passed — a
  // failed launch means there's no live app to drive.
  const wantIos = config.iosDir !== undefined && base.ios?.pass === true;
  const wantAndroid = config.androidDir !== undefined && base.android?.pass === true;

  if (!wantIos && !wantAndroid) {
    trace("judge", "Stage 2 — skipped (no Stage 1 PASS to build on)");
    return base;
  }

  const platforms = [wantIos && "ios", wantAndroid && "android"].filter(Boolean).join(" + ");
  trace("judge", `Stage 2 — scripted-CRUD walk via mobile-mcp on ${platforms}`);

  const merged: { ios?: VisualJudgePlatformReport; android?: VisualJudgePlatformReport } = { ...base };

  // Guard the whole Stage 2 walk: mobile-mcp runs in a child process, and if
  // it exits mid-walk the SDK rejects with `McpError: Connection closed`. That
  // must degrade to a recorded Stage 2 failure — not an unhandled throw that
  // aborts dispatch before the report is written.
  try {
    const stage2 = await runStage2Visual({
      spec: config.spec ?? domain.displayName,
      ...(wantIos ? { iosScenario } : {}),
      ...(wantAndroid ? { androidScenario } : {}),
      ...(config.stage2.rubric !== undefined ? { rubric: config.stage2.rubric } : {}),
      ...(config.screenshotDir !== undefined ? { screenshotDir: config.screenshotDir } : {}),
    });
    if (stage2.ios && merged.ios) {
      merged.ios = mergeStage2(merged.ios, stage2.ios);
      trace("judge", `Stage 2 ios: ${stage2.ios.pass ? "PASS" : "FAIL"}` + (stage2.ios.error ? ` — ${stage2.ios.error}` : ""));
    }
    if (stage2.android && merged.android) {
      merged.android = mergeStage2(merged.android, stage2.android);
      trace("judge", `Stage 2 android: ${stage2.android.pass ? "PASS" : "FAIL"}` + (stage2.android.error ? ` — ${stage2.android.error}` : ""));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    trace("judge", `Stage 2 — aborted: ${message}; recorded as Stage 2 failure so the run still produces a report`);
    if (wantIos && merged.ios) merged.ios = mergeStage2(merged.ios, stage2Failure(iosScenario.name, message));
    if (wantAndroid && merged.android) merged.android = mergeStage2(merged.android, stage2Failure(androidScenario.name, message));
  }
  return merged;
}

function stage2Failure(scenarioName: string, error: string): Stage2PlatformReport {
  return { pass: false, scenarioName, stepCount: 0, stepsPassed: 0, screenshots: [], error };
}

function mergeStage2(base: VisualJudgePlatformReport, stage2: Stage2PlatformReport): VisualJudgePlatformReport {
  return {
    ...base,
    pass: base.pass && stage2.pass,
    stage2,
  };
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

async function evaluate(worker: WorkerResult, layer2Mode: Layer2Mode): Promise<PlatformEval> {
  const outDir = resolve(process.cwd(), worker.outDir);

  const [layer1, layer2] = await Promise.all([
    runLayer1({ projectDir: outDir, forbiddenTokens: worker.renamedFrom }),
    runLayer2({ platform: worker.platform, outDir, mode: layer2Mode }),
  ]);

  return { platform: worker.platform, layer1, layer2 };
}
