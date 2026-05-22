import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { DomainSpec, JudgeResult, ReviewerResult } from "../agents/types.js";
import { renderReport } from "./render.js";
import type { AssetMap, RepairAttempt, RunReport } from "./model.js";

export type ReportFormat = "html" | "json" | "both";

export type BuildRunReportInput = {
  spec: string;
  domain: DomainSpec;
  judge: JudgeResult;
  reviewer: ReviewerResult;
  agentVersion: string;
  judgeModel: string;
  visualLevel: 0 | 1 | 2;
  startedAt: number;
  finishedAt: number;
  repairAttempts?: readonly RepairAttempt[];
};

// Pure assembly: fold the run's pieces into the single RunReport
// aggregate. No I/O — writeReport handles disk.
export function buildRunReport(input: BuildRunReportInput): RunReport {
  return {
    meta: {
      spec: input.spec,
      slug: input.domain.slug,
      displayName: input.domain.displayName,
      agentVersion: input.agentVersion,
      judgeModel: input.judgeModel,
      visualLevel: input.visualLevel,
      startedAt: new Date(input.startedAt).toISOString(),
      finishedAt: new Date(input.finishedAt).toISOString(),
      durationMs: input.finishedAt - input.startedAt,
    },
    overallPass: input.judge.overallPass,
    summary: input.judge.summary,
    platforms: input.judge.platforms ?? [],
    reviewer: {
      contractParity: input.reviewer.contractParity,
      diffs: input.reviewer.diffs,
    },
    domain: {
      renamePlan: input.domain.renamePlan.map((r) => ({ from: r.from, to: r.to })),
      entities: input.domain.entities.map((e) => ({
        name: e.name,
        replaces: e.replaces,
        fields: e.fields.map((f) => ({
          name: f.name,
          type: f.type,
          ...(f.references !== undefined ? { references: f.references } : {}),
        })),
        ...(e.states !== undefined ? { states: e.states } : {}),
      })),
    },
    ...(input.repairAttempts && input.repairAttempts.length > 0
      ? { repairAttempts: input.repairAttempts }
      : {}),
  };
}

export type WriteReportOptions = {
  dir: string;
  format?: ReportFormat;
  embed?: boolean;
};

export type ReportPaths = {
  jsonPath?: string;
  htmlPath?: string;
};

export async function writeReport(report: RunReport, options: WriteReportOptions): Promise<ReportPaths> {
  const format = options.format ?? "both";
  const embed = options.embed ?? true;
  await mkdir(options.dir, { recursive: true });

  const paths: ReportPaths = {};

  if (format === "json" || format === "both") {
    const jsonPath = join(options.dir, "report.json");
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    paths.jsonPath = jsonPath;
  }

  if (format === "html" || format === "both") {
    const assets = await resolveAssets(report, options.dir, embed);
    const htmlPath = join(options.dir, "validation-report.html");
    await writeFile(htmlPath, renderReport(report, assets), "utf8");
    paths.htmlPath = htmlPath;
  }

  return paths;
}

// Every screenshot file path referenced anywhere in the report,
// de-duplicated and in stable order.
export function collectScreenshotPaths(report: RunReport): string[] {
  const seen = new Set<string>();
  const add = (p: string | undefined): void => {
    if (p && !seen.has(p)) seen.add(p);
  };
  for (const platform of report.platforms) {
    const l3 = platform.layer3;
    if (!l3) continue;
    add(l3.screenshotPath);
    const s2 = l3.stage2;
    if (s2) {
      add(s2.representativeScreenshot);
      for (const s of s2.screenshots) add(s);
    }
  }
  return [...seen];
}

// Turn screenshot file paths into render-ready <img src> values. With
// embed=true each PNG becomes a base64 data: URI (single self-contained
// file). With embed=false PNGs are copied to <dir>/report-assets/ and
// referenced by relative path. Unreadable paths are skipped — the
// renderer shows a placeholder for any path missing from the map.
async function resolveAssets(report: RunReport, dir: string, embed: boolean): Promise<AssetMap> {
  const paths = collectScreenshotPaths(report);
  if (paths.length === 0) return {};

  const map: AssetMap = {};
  const assetsDir = join(dir, "report-assets");
  if (!embed) await mkdir(assetsDir, { recursive: true });

  await Promise.all(
    paths.map(async (p) => {
      const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
      try {
        if (embed) {
          const buf = await readFile(abs);
          map[p] = `data:image/png;base64,${buf.toString("base64")}`;
        } else {
          const name = basename(abs);
          await copyFile(abs, join(assetsDir, name));
          map[p] = `report-assets/${name}`;
        }
      } catch {
        // Leave unmapped — renderer renders a "screenshot unavailable"
        // placeholder rather than a broken image.
      }
    }),
  );

  return map;
}
