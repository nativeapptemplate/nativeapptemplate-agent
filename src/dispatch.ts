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
import type { RunReport } from "./report/model.js";
import type { JudgeResult } from "./agents/types.js";

export type DispatchReportOptions = {
  enabled?: boolean;
  format?: ReportFormat;
  embed?: boolean;
  dir?: string;
};

export type DispatchOptions = {
  report?: DispatchReportOptions;
};

export type DispatchResult = JudgeResult & {
  report: RunReport;
  reportPaths: ReportPaths;
};

export async function dispatch(spec: string, options: DispatchOptions = {}): Promise<DispatchResult> {
  const startedAt = Date.now();
  const domain = await runPlanner(spec);

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
      ...(visualLevel >= 1 ? { layer2Mode: "build" as const } : {}),
      ...(visual ? { visual } : {}),
    });
  } finally {
    if (railsServer) {
      await railsServer.stop().catch((err) => {
        trace("dispatch", `rails-lifecycle: stop() error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
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

  return { ...judge, report, reportPaths };
}
