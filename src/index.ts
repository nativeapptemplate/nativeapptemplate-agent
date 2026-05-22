#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { dispatch, type DispatchReportOptions } from "./dispatch.js";
import { loadDotenvIfPresent } from "./env.js";
import { parseRenamePair } from "./rename-overrides.js";
import { isValidSlug, slugToPascal } from "./slug.js";
import type { RenamePair } from "./agents/types.js";

loadDotenvIfPresent();

export type ParsedArgs = {
  spec: string;
  report: DispatchReportOptions;
  open: boolean;
  exitZero: boolean;
  renameOverrides: RenamePair[];
  slug?: string;
};

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const specParts: string[] = [];
  const report: DispatchReportOptions = {};
  const renameOverrides: RenamePair[] = [];
  let open = false;
  let exitZero = false;
  let slug: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--no-report") report.enabled = false;
    else if (arg === "--report-open") open = true;
    else if (arg === "--exit-zero") exitZero = true;
    else if (arg.startsWith("--report-format=")) {
      const value = arg.slice("--report-format=".length);
      if (value === "html" || value === "json" || value === "both") report.format = value;
    } else if (arg.startsWith("--report-embed=")) {
      report.embed = arg.slice("--report-embed=".length) !== "false";
    } else if (arg === "--rename" || arg.startsWith("--rename=")) {
      // Accept both `--rename From=To` (per ROADMAP) and `--rename=From=To`.
      const raw = arg === "--rename" ? argv[++i] : arg.slice("--rename=".length);
      const pair = parseRenamePair(raw);
      if (pair) renameOverrides.push(pair);
      else console.error(`warning: ignoring malformed --rename "${raw ?? ""}" (expected From=To, e.g. --rename Shop=Clinic)`);
    } else if (arg === "--slug" || arg.startsWith("--slug=")) {
      const raw = (arg === "--slug" ? argv[++i] : arg.slice("--slug=".length))?.trim();
      if (raw && isValidSlug(raw)) slug = raw;
      else console.error(`warning: ignoring invalid --slug "${raw ?? ""}" (expected kebab-case, e.g. --slug=vet-clinic)`);
    } else {
      specParts.push(arg);
    }
  }
  return { spec: specParts.join(" ").trim(), report, open, exitZero, renameOverrides, ...(slug !== undefined ? { slug } : {}) };
}

export async function main(spec?: string): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const input = (spec ?? parsed.spec).trim();
  if (!input) {
    console.error(
      'Usage: nativeapptemplate-agent "your spec here" [--slug=kebab-name] [--rename From=To]... [--no-report] [--report-format=html|json|both] [--report-embed=true|false] [--report-open] [--exit-zero]',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`nativeapptemplate-agent: received spec: ${input}`);
  console.log('(tail tmp/trace/*.log in a tiled view via scripts/demo-tmux.sh)');

  const result = await dispatch(input, {
    report: parsed.report,
    renameOverrides: parsed.renameOverrides,
    ...(parsed.slug !== undefined ? { slug: parsed.slug } : {}),
  });

  if (parsed.slug !== undefined) {
    const finalSlug = result.report.meta.slug;
    console.log(`project: ${slugToPascal(finalSlug)} (slug ${finalSlug}, output out/${finalSlug}/)`);
  }

  for (const o of result.renameOverrideOutcomes) {
    if (o.kind === "changed") console.log(`override: ${o.from} → ${o.to} (overrode planner's "${o.was}")`);
    else if (o.kind === "noop") console.log(`override: ${o.from} → ${o.to} (already the planner's pick)`);
    else {
      const sources = result.report.domain.renamePlan.map((p) => p.from).join(", ");
      console.error(`warning: --rename ${o.from}=${o.to} matched no planned rename — skipped (renamable: ${sources || "none"})`);
    }
  }

  console.log('');
  console.log('=== run complete ===');
  console.log(`result: ${result.summary}`);
  console.log(`overall: ${result.overallPass ? 'PASS' : 'FAIL'}`);
  if (result.reportPaths.htmlPath) {
    console.log(`report: file://${result.reportPaths.htmlPath}`);
    if (parsed.open && process.platform === 'darwin') {
      spawn('open', [result.reportPaths.htmlPath], { stdio: 'ignore', detached: true }).unref();
    }
  } else if (result.reportPaths.jsonPath) {
    console.log(`report: ${result.reportPaths.jsonPath}`);
  }

  // Non-zero exit on validation failure so CI / shell `&&` chains catch
  // it. --exit-zero opts out (e.g. when you only want the report).
  if (!result.overallPass && !parsed.exitZero) {
    process.exitCode = 1;
  }
}

// Entry guard: run main() when this file is the program entry point. Resolve
// both sides to canonical (symlink-followed) paths so npm bin symlinks (e.g.
// node_modules/.bin/nativeapptemplate-agent → ../nativeapptemplate-agent/dist/
// index.js) compare equal to import.meta.url. Without realpath, the guard
// fails silently on symlinked invocations and main() never runs — the CLI
// would exit 0 with no output.
if (isEntryPoint()) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const modulePath = fileURLToPath(import.meta.url);
    const argv1Real = realpathSync(argv1);
    return argv1Real === modulePath;
  } catch {
    return false;
  }
}
