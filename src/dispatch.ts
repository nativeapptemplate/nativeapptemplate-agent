import { resolve } from "node:path";
import { runPlanner } from "./agents/planner.js";
import { runRailsWorker } from "./agents/workers/rails.js";
import { runIosWorker } from "./agents/workers/ios.js";
import { runAndroidWorker } from "./agents/workers/android.js";
import { runReviewer } from "./agents/reviewer.js";
import { runJudge, type VisualJudgeConfig } from "./agents/judge.js";
import { applyBridgeToProcessEnv, buildBridgeValues, syncGradleProperties } from "./env-bridge.js";
import { startRails, type RailsHandle } from "./rails-lifecycle.js";
import { isStub } from "./stub.js";
import { trace } from "./trace.js";
import { buildRunReport, writeReport, type ReportFormat, type ReportPaths } from "./report/collect.js";
import { readPackageVersion } from "./version.js";
import { runRepairLoop, REPAIR_ITERATION_CAP, type RepairLoopDeps } from "./repair-loop.js";
import { runRepair } from "./agents/repair.js";
import { runLayer1 } from "./validation/layer1.js";
import { runLayer2, type Layer2Mode } from "./validation/layer2.js";
import type { RepairAttempt, RunReport } from "./report/model.js";
import type { JudgeResult, Platform, PlatformDetail, RenamePair, WorkerResult } from "./agents/types.js";
import { applyRenameOverrides, syncEntityNames, type OverrideOutcome } from "./rename-overrides.js";
import { isValidSlug, slugToPascal, projectNameToSlug, projectNameToDisplayName } from "./slug.js";

export type DispatchReportOptions = {
  enabled?: boolean;
  format?: ReportFormat;
  embed?: boolean;
  dir?: string;
};

export type DispatchOptions = {
  report?: DispatchReportOptions;
  // Manual rename overrides merged onto the planner's plan (CLI --rename).
  // See src/rename-overrides.ts.
  renameOverrides?: readonly RenamePair[];
  // Manual project name (CLI --project-name). A human/Pascal name like
  // "Vet Clinic" or "VetClinic" from which the slug (output dir, DB prefix,
  // env-bridge token, Pascal project name across all three platforms) and the
  // display name are derived. Ignored if it yields no valid slug.
  projectName?: string;
};

export type DispatchResult = JudgeResult & {
  report: RunReport;
  reportPaths: ReportPaths;
  renameOverrideOutcomes: readonly OverrideOutcome[];
};

export async function dispatch(spec: string, options: DispatchOptions = {}): Promise<DispatchResult> {
  const startedAt = Date.now();
  let domain = await runPlanner(spec);

  // Manual project name (CLI --project-name). Derive the slug + display name
  // from it and override the planner's. The slug drives the output dir, DB
  // prefix, env-bridge token, and the Pascal project name — so it must land
  // before the env-bridge and workers read domain.slug. A name that yields no
  // valid slug is traced and ignored rather than corrupting paths downstream.
  const projectName = options.projectName;
  if (projectName !== undefined) {
    const slug = projectNameToSlug(projectName);
    if (isValidSlug(slug)) {
      const displayName = projectNameToDisplayName(projectName);
      trace("dispatch", `project name: "${projectName}" -> ${slugToPascal(slug)} (slug ${slug}, display "${displayName}")`);
      domain = { ...domain, slug, displayName };
    } else {
      trace("dispatch", `project name ignored: "${projectName}" yields no valid slug`);
    }
  }

  // Manual overrides take precedence over the planner's noun choices, but only
  // for renames the planner actually scheduled — unmatched overrides are traced
  // and dropped, not silently added. Apply before workers/reviewer/judge/report
  // so every downstream consumer sees the final plan.
  const renameOverrides = options.renameOverrides ?? [];
  let renameOverrideOutcomes: readonly OverrideOutcome[] = [];
  if (renameOverrides.length > 0) {
    const merged = applyRenameOverrides(domain.renamePlan, renameOverrides);
    renameOverrideOutcomes = merged.outcomes;
    for (const o of merged.outcomes) {
      if (o.kind === "changed") trace("dispatch", `rename override: ${o.from} ${o.was}->${o.to} (overrode planner's pick)`);
      else if (o.kind === "noop") trace("dispatch", `rename override: ${o.from}=${o.to} already the planned target — no change`);
      else trace("dispatch", `rename override ignored: no planned rename for "${o.from}" (got ${o.from}=${o.to})`);
    }
    // Carry the override into entity names too, so the report's entity cards
    // agree with its rename plan (the planner names entities after their
    // targets). Code generation keys off renamePlan, not entities — this is
    // metadata coherence, not a code-affecting change.
    const entities = syncEntityNames(domain.entities, merged.outcomes);
    domain = { ...domain, renamePlan: merged.plan, entities };
  }

  // Mirror the substrate's NATIVEAPPTEMPLATE_API_* config to the
  // renamed product equivalents (<PRODUCT>_API_*) so the agent's auto-
  // validation runs see the right values without forcing the user to
  // hand-set per-app env vars. See src/env-bridge.ts.
  const bridge = await buildBridgeValues(domain);
  if (Object.keys(bridge.values).length > 0) {
    applyBridgeToProcessEnv(bridge);
    const sync = await syncGradleProperties(bridge);
    const keys = Object.keys(bridge.values).sort().join(", ");
    trace("dispatch", `env-bridge: mirrored ${keys}`);
    switch (sync.mode) {
      case "wrote":
        trace("dispatch", `env-bridge: wrote sentinel block to ${sync.path}`);
        break;
      case "skipped":
        trace("dispatch", `env-bridge: file write skipped (NATIVEAPPTEMPLATE_BRIDGE=off); process.env still injected`);
        break;
      case "dry-run":
        trace("dispatch", `env-bridge: DRY RUN — would write to ${sync.path}:`);
        for (const line of (sync.preview ?? "").split("\n")) trace("dispatch", `  ${line}`);
        break;
      case "noop":
        // Same content already in place — nothing to log.
        break;
    }
  } else {
    // No substrate values to mirror — clean up any stale sentinel block
    // from a prior run so we don't leave dangling values behind.
    await syncGradleProperties(bridge);
    trace("dispatch", "env-bridge: no HOST/PORT in $NATIVEAPPTEMPLATE_API/.env; nothing to mirror");
  }

  const [rails, ios, android] = await Promise.all([
    runRailsWorker(domain),
    runIosWorker(domain),
    runAndroidWorker(domain),
  ]);
  const reviewer = await runReviewer({ domain, rails, ios, android });

  // Visual judging is opt-in via NATIVEAPPTEMPLATE_VISUAL:
  //   =1  Stage 1 only — post-launch home screen rubric (substrate-leak
  //       detection + render sanity). Adds 60-180s for build mode.
  //   =2  Stage 1 + Stage 2 — same plus a scripted-CRUD walk via
  //       mobile-mcp (sign up → create resource → toggle state) with
  //       Layer 3 scoring on the post-toggle screen. Adds another
  //       60-120s and requires a sim/emulator booted with the app
  //       already launched after Stage 1. Off by default.
  const visualLevelRaw = process.env['NATIVEAPPTEMPLATE_VISUAL'] ?? "";
  const visualLevel = visualLevelRaw === "2" ? 2 : visualLevelRaw === "1" ? 1 : 0;
  // Visual levels force build mode so Stage 1 has an artifact to launch;
  // level 0 stays in the cheaper fast mode. The repair loop re-validates
  // Layer 2 in the same mode the judge used.
  const layer2Mode: Layer2Mode = visualLevel >= 1 ? "build" : "fast";
  const visual: VisualJudgeConfig | undefined = visualLevel >= 1
    ? {
        iosDir: resolve(process.cwd(), ios.outDir),
        androidDir: resolve(process.cwd(), android.outDir),
        spec: domain.displayName,
        ...(visualLevel >= 2
          ? {
              stage2: {
                primaryResourceName: domain.displayName,
                fullName: "Stage Two Test",
                // Unique per-run email so re-runs don't collide on
                // "email already taken". The substrate's signup
                // accepts "+tag" addresses as distinct identities.
                email: `stage2+${Date.now()}@example.com`,
                password: "ValidPassword1!",
                railsOutDir: resolve(process.cwd(), rails.outDir),
              },
            }
          : {}),
      }
    : undefined;

  // For NATIVEAPPTEMPLATE_VISUAL=2, Stage 2 needs a live Rails server
  // to talk to (the iOS/Android apps make real HTTP calls during
  // signup, resource create, etc.). Layer 2 build mode validates that
  // rails *boots*; we own keeping it *running* during Stage 2 here.
  // Skip in judge-stub mode (smoke tests) — there's no real judge to
  // serve, so spawning Rails would be useless and require `mise` in
  // the test environment.
  let railsServer: RailsHandle | undefined;
  if (visualLevel >= 2 && !isStub("judge")) {
    railsServer = await startRails({ outDir: resolve(process.cwd(), rails.outDir) });
    trace("dispatch", `rails-lifecycle: live at ${railsServer.url} for Stage 2`);
  }

  let judge: JudgeResult;
  try {
    judge = await runJudge({
      domain,
      rails,
      ios,
      android,
      reviewer,
      layer2Mode,
      ...(visual ? { visual } : {}),
    });
  } finally {
    if (railsServer) {
      await railsServer.stop().catch((err) => {
        trace("dispatch", `rails-lifecycle: stop() error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  // Self-repair loop (opt-in via NATIVEAPPTEMPLATE_REPAIR). When the first
  // judge pass fails on a code-repairable layer (Layer 1 leftover tokens or
  // Layer 2 build errors), iterate: patch the failing platform with the
  // repair agent, re-validate, record the attempt — bounded by the cap. Off
  // by default; skipped in stub mode (no real judge/agent to drive).
  let repairAttempts: readonly RepairAttempt[] = [];
  const repairMax = parseRepairMax(process.env['NATIVEAPPTEMPLATE_REPAIR']);
  if (repairMax > 0 && !judge.overallPass && judge.platforms && judge.platforms.length > 0 && !isStub("judge")) {
    const workers: Record<Platform, WorkerResult> = { rails, ios, android };
    const deps: RepairLoopDeps = {
      repair: async (platform, layer, detail) => {
        const w = workers[platform];
        const outDir = resolve(process.cwd(), w.outDir);
        const detailStr = layer === "layer1"
          ? formatFindings(detail.layer1.findings)
          : detail.layer2.stderrTail ?? "(no stderr captured)";
        return runRepair(
          {
            platform,
            outDir,
            layer,
            detail: detailStr,
            ...(layer === "layer1" ? { forbiddenTokens: w.renamedFrom } : {}),
          },
          domain,
        );
      },
      revalidate: async (platform) => {
        const w = workers[platform];
        const outDir = resolve(process.cwd(), w.outDir);
        const [layer1, layer2] = await Promise.all([
          runLayer1({ projectDir: outDir, forbiddenTokens: w.renamedFrom }),
          runLayer2({ platform, outDir, mode: layer2Mode }),
        ]);
        return {
          layer1: { pass: layer1.pass, findings: layer1.findings },
          layer2: {
            pass: layer2.pass,
            command: layer2.command,
            mode: layer2Mode,
            exitCode: layer2.exitCode,
            durationMs: layer2.durationMs,
            ...(layer2.stderrTail !== undefined ? { stderrTail: layer2.stderrTail } : {}),
          },
        };
      },
    };
    trace("dispatch", `self-repair: enabled (cap ${repairMax}); first pass failed — entering loop`);
    const loop = await runRepairLoop({
      platforms: judge.platforms,
      reviewerPass: reviewer.contractParity === "pass",
      maxIterations: repairMax,
      deps,
    });
    repairAttempts = loop.attempts;
    judge = { ...judge, overallPass: loop.overallPass, summary: loop.summary, platforms: loop.platforms };
    const resolved = loop.attempts.filter((a) => a.resolved).length;
    trace("dispatch", `self-repair: ${loop.attempts.length} attempt(s), ${resolved} resolved — overall now ${loop.overallPass ? "PASS" : "FAIL"}`);
  }

  const report = buildRunReport({
    spec,
    domain,
    judge,
    reviewer,
    agentVersion: readPackageVersion(),
    judgeModel: "claude-opus-4-7",
    visualLevel: visualLevel as 0 | 1 | 2,
    startedAt,
    finishedAt: Date.now(),
    repairAttempts,
  });

  // Default off in stub mode so the test suite never writes into ./out.
  const reportOpts = options.report ?? {};
  const reportEnabled = reportOpts.enabled ?? !isStub("dispatch");
  let reportPaths: ReportPaths = {};
  if (reportEnabled) {
    const dir = reportOpts.dir ?? resolve(process.cwd(), "out", domain.slug);
    reportPaths = await writeReport(report, {
      dir,
      ...(reportOpts.format !== undefined ? { format: reportOpts.format } : {}),
      ...(reportOpts.embed !== undefined ? { embed: reportOpts.embed } : {}),
    });
    const written = Object.values(reportPaths).filter(Boolean);
    if (written.length > 0) trace("dispatch", `report: wrote ${written.join(", ")}`);
  }

  return { ...judge, report, reportPaths, renameOverrideOutcomes };
}

// NATIVEAPPTEMPLATE_REPAIR control: unset / "0" / "off" / "false" → disabled;
// "on" / "true" → run up to the cap; a positive integer N → up to min(N, cap).
function parseRepairMax(raw: string | undefined): number {
  if (!raw) return 0;
  const lowered = raw.trim().toLowerCase();
  if (lowered === "" || lowered === "0" || lowered === "off" || lowered === "false") return 0;
  if (lowered === "on" || lowered === "true") return REPAIR_ITERATION_CAP;
  const n = Number.parseInt(lowered, 10);
  if (Number.isFinite(n) && n > 0) return Math.min(n, REPAIR_ITERATION_CAP);
  return 0;
}

function formatFindings(findings: PlatformDetail["layer1"]["findings"]): string {
  if (findings.length === 0) return "(no findings recorded)";
  return findings.map((f) => `${f.token} · ${f.file}:${f.line} · ${f.text}`).join("\n");
}
