import { resolve } from "node:path";
import { trace } from "../trace.js";
import { isStub } from "../stub.js";
import { runLayer1 } from "../validation/layer1.js";
import { runLayer2 } from "../validation/layer2.js";
import type { DomainSpec, JudgeResult, Platform, ReviewerResult, WorkerResult } from "./types.js";

export type JudgeInput = {
  domain: DomainSpec;
  rails: WorkerResult;
  ios: WorkerResult;
  android: WorkerResult;
  reviewer: ReviewerResult;
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

  trace("judge", "Layer 3 (semantic, Opus 4.7 vision judge) — not yet wired; treating as skipped");

  const overallPass = reports.every((r) => r.layer1Pass && r.layer2Pass);
  const l1Total = reports.filter((r) => r.layer1Pass).length;
  const l2Total = reports.filter((r) => r.layer2Pass).length;

  return {
    overallPass,
    summary: `Layer 1 ${l1Total}/3 pass · Layer 2 ${l2Total}/3 pass · Layer 3 skipped`,
  };
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
