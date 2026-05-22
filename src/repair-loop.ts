import type { Platform, PlatformDetail } from "./agents/types.js";
import type { RepairAttempt } from "./report/model.js";
import type { RepairLayer } from "./agents/repair.js";

// Re-validation of a single platform after a repair pass: a fresh Layer 1
// (token scan) + Layer 2 (build) result. Layer 3 is intentionally not
// re-run here — it's not code-repairable in this loop (see runRepairLoop).
export type RevalidateResult = Pick<PlatformDetail, "layer1" | "layer2">;

export type RepairLoopDeps = {
  // Make one repair pass over a failing platform/layer; returns a summary
  // of what changed. Whether it worked is decided by revalidate, not here.
  repair: (platform: Platform, layer: RepairLayer, detail: PlatformDetail) => Promise<{ action: string }>;
  // Re-run Layer 1 + Layer 2 for one platform.
  revalidate: (platform: Platform) => Promise<RevalidateResult>;
};

export type RepairLoopInput = {
  platforms: readonly PlatformDetail[];
  reviewerPass: boolean;
  maxIterations: number;
  deps: RepairLoopDeps;
};

export type RepairLoopResult = {
  platforms: PlatformDetail[];
  attempts: RepairAttempt[];
  overallPass: boolean;
  summary: string;
};

type TargetRef = { platform: Platform; layer: RepairLayer };

// The CLAUDE.md hard cap: never iterate more than this regardless of the
// requested maxIterations.
export const REPAIR_ITERATION_CAP = 5;

// Bounded self-repair: while a code-repairable layer is failing, repair the
// highest-priority failure, re-validate that platform, and record the
// attempt — until everything passes or the iteration cap is hit. Pure
// control flow: all I/O (the repair agent, the validators) is injected via
// deps, so this is unit-testable without the LLM or a device.
//
// Scope: Layer 1 (leftover tokens) then Layer 2 (build) are the
// code-repairable, cheaply re-checkable layers. Layer 3 (vision) and the
// contract reviewer are surfaced but not auto-repaired — a Layer 3 miss is
// often environmental (e.g. a first-launch system dialog), not a source bug.
export async function runRepairLoop(input: RepairLoopInput): Promise<RepairLoopResult> {
  const cap = Math.min(input.maxIterations, REPAIR_ITERATION_CAP);
  const platforms: PlatformDetail[] = input.platforms.map((p) => ({ ...p }));
  const attempts: RepairAttempt[] = [];

  for (let iteration = 1; iteration <= cap; iteration++) {
    const target = nextTarget(platforms);
    if (!target) break; // no code-repairable failure remains

    const detail = platforms.find((p) => p.platform === target.platform)!;
    const { action } = await input.deps.repair(target.platform, target.layer, detail);

    const revalidated = await input.deps.revalidate(target.platform);
    const idx = platforms.findIndex((p) => p.platform === target.platform);
    platforms[idx] = { ...platforms[idx]!, layer1: revalidated.layer1, layer2: revalidated.layer2 };

    const resolved = target.layer === "layer1" ? revalidated.layer1.pass : revalidated.layer2.pass;
    attempts.push({ iteration, failingLayer: target.layer, platform: target.platform, action, resolved });

    if (computeOverall(platforms, input.reviewerPass)) break;
  }

  return {
    platforms,
    attempts,
    overallPass: computeOverall(platforms, input.reviewerPass),
    summary: summarize(platforms, input.reviewerPass),
  };
}

// Highest-priority code-repairable failure: all Layer 1 misses before any
// Layer 2 miss (leftover tokens routinely cause the build error, so fixing
// structure first avoids chasing a downstream symptom).
function nextTarget(platforms: readonly PlatformDetail[]): TargetRef | undefined {
  for (const p of platforms) if (!p.layer1.pass) return { platform: p.platform, layer: "layer1" };
  for (const p of platforms) if (!p.layer2.pass) return { platform: p.platform, layer: "layer2" };
  return undefined;
}

function computeOverall(platforms: readonly PlatformDetail[], reviewerPass: boolean): boolean {
  const layer1And2 = platforms.every((p) => p.layer1.pass && p.layer2.pass);
  const layer3 = platforms.every((p) => p.layer3 === undefined || p.layer3.pass);
  return layer1And2 && layer3 && reviewerPass;
}

// Mirrors the judge's one-line summary so the post-repair report reads
// identically to a first-pass report.
function summarize(platforms: readonly PlatformDetail[], reviewerPass: boolean): string {
  const total = platforms.length;
  const l1 = platforms.filter((p) => p.layer1.pass).length;
  const l2 = platforms.filter((p) => p.layer2.pass).length;
  const l3Plats = platforms.filter((p) => p.layer3 !== undefined);
  const l3 = l3Plats.filter((p) => p.layer3!.pass).length;
  const l3Summary = l3Plats.length > 0 ? `Layer 3 ${l3}/${l3Plats.length} pass` : "Layer 3 skipped";
  return `Layer 1 ${l1}/${total} pass · Layer 2 ${l2}/${total} pass · ${l3Summary} · reviewer ${reviewerPass ? "PASS" : "FAIL"}`;
}
