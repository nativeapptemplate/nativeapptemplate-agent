import { cp, lstat, mkdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { trace } from "../../trace.js";
import { isStub } from "../../stub.js";
import { runRuby } from "../../ruby.js";
import type { DomainSpec, RenamePair, WorkerResult } from "../types.js";

type RenameStats = {
  files_scanned: number;
  files_changed: number;
  substitutions: number;
  files_renamed: number;
};

const SKIP_RELATIVE_PATHS = ["/.git", "/node_modules", "/tmp", "/log", "/vendor/bundle"];

export async function runRailsWorker(domain: DomainSpec): Promise<WorkerResult> {
  if (isStub("rails")) {
    return runStubRailsWorker(domain);
  }

  const substrate = process.env['NATEMPLATE_API'];
  if (!substrate) {
    throw new Error("rails worker: NATEMPLATE_API env var is not set; see CLAUDE.md Substrate section");
  }

  const outDir = resolve(process.cwd(), "out", domain.slug, "rails");

  trace("rails", `copying substrate from ${substrate} to ${outDir}`);
  await prepareFresh(outDir);
  await copyFiltered(substrate, outDir);

  const plan = domain.renamePlan.map((p) => `${p.from}->${p.to}`).join(", ");
  trace("rails", `running scripts/ruby/rename.rb: ${plan}`);

  const renameStats = await runRuby<{ renamePlan: readonly RenamePair[]; root: string }, RenameStats>(
    "rename.rb",
    { renamePlan: domain.renamePlan, root: outDir },
  );

  trace(
    "rails",
    `scanned ${renameStats.files_scanned} files, changed ${renameStats.files_changed}, ${renameStats.substitutions} substitutions, ${renameStats.files_renamed} file/dir renames`,
  );

  await initGit(outDir);
  trace("rails", `done (out/${domain.slug}/rails)`);

  return {
    platform: "rails",
    outDir: `./out/${domain.slug}/rails`,
    filesTouched: renameStats.files_changed + renameStats.files_renamed,
  };
}

async function prepareFresh(dir: string): Promise<void> {
  try {
    await stat(dir);
    await rm(dir, { recursive: true, force: true });
  } catch {
    // dest doesn't exist — nothing to clean
  }
  await mkdir(dir, { recursive: true });
}

async function copyFiltered(src: string, dest: string): Promise<void> {
  await cp(src, dest, {
    recursive: true,
    force: true,
    filter: async (source: string) => {
      const rel = source.slice(src.length);
      if (SKIP_RELATIVE_PATHS.some((p) => rel === p || rel.startsWith(`${p}/`))) return false;
      try {
        const s = await lstat(source);
        if (s.isSocket() || s.isFIFO() || s.isBlockDevice() || s.isCharacterDevice()) return false;
      } catch {
        return false;
      }
      return true;
    },
  });
}

async function initGit(dir: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["init", "-q", "-b", "main"], { cwd: dir });
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`git init exited ${code}`));
    });
    child.on("error", rejectPromise);
  });
}

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

async function runStubRailsWorker(domain: DomainSpec): Promise<WorkerResult> {
  const plan = domain.renamePlan.map((p) => `${p.from}->${p.to}`).join(", ");
  trace("rails", "(stub mode)");
  trace("rails", `copying substrate for ${domain.displayName}`);
  await delay(200);
  trace("rails", `renaming Ruby symbols: ${plan}`);
  await delay(300);
  trace("rails", "regenerating migrations");
  await delay(250);
  trace("rails", "updating routes.rb + JSON:API serializers");
  await delay(200);
  trace("rails", `done (out/${domain.slug}/rails)`);

  return {
    platform: "rails",
    outDir: `./out/${domain.slug}/rails`,
    filesTouched: 47,
  };
}
