import { cp, lstat, mkdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { trace } from "../../trace.js";
import { isStub } from "../../stub.js";
import { runRuby } from "../../ruby.js";
import { slugToPascal } from "../../slug.js";
import type { DomainSpec, RenamePair, WorkerResult } from "../types.js";

type RenameStats = {
  files_scanned: number;
  files_changed: number;
  substitutions: number;
  files_renamed: number;
};

const SKIP_RELATIVE_PATHS = ["/.git", "/DerivedData", "/.build", "/Pods", "/Carthage"];

export async function runIosWorker(domain: DomainSpec): Promise<WorkerResult> {
  if (isStub("ios")) {
    return runStubIosWorker(domain);
  }

  const substrate = process.env['NATEMPLATE_IOS'];
  if (!substrate) {
    throw new Error("ios worker: NATEMPLATE_IOS env var is not set; see CLAUDE.md Substrate section");
  }

  const outDir = resolve(process.cwd(), "out", domain.slug, "ios");

  trace("ios", `copying substrate from ${substrate} to ${outDir}`);
  await prepareFresh(outDir);
  await copyFiltered(substrate, outDir);

  const productPairs = buildProductRenamePairs(domain.slug);
  const renamePlan: readonly RenamePair[] = [...productPairs, ...domain.renamePlan];
  const plan = renamePlan.map((p) => `${p.from}->${p.to}`).join(", ");
  trace("ios", `running scripts/ruby/rename.rb: ${plan}`);

  const renameStats = await runRuby<{ renamePlan: readonly RenamePair[]; root: string }, RenameStats>(
    "rename.rb",
    { renamePlan, root: outDir },
  );

  trace(
    "ios",
    `scanned ${renameStats.files_scanned} files, changed ${renameStats.files_changed}, ${renameStats.substitutions} substitutions, ${renameStats.files_renamed} file/dir renames`,
  );

  await initGit(outDir);
  trace("ios", `done (out/${domain.slug}/ios)`);

  return {
    platform: "ios",
    outDir: `./out/${domain.slug}/ios`,
    filesTouched: renameStats.files_changed + renameStats.files_renamed,
  };
}

function buildProductRenamePairs(slug: string): readonly RenamePair[] {
  const pascal = slugToPascal(slug);
  return [
    { from: "NativeAppTemplateFree", to: `${pascal}Free` },
    { from: "NativeAppTemplate", to: pascal },
  ];
}

async function prepareFresh(dir: string): Promise<void> {
  try {
    await stat(dir);
    await rm(dir, { recursive: true, force: true });
  } catch {
    // dest doesn't exist
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

async function runStubIosWorker(domain: DomainSpec): Promise<WorkerResult> {
  const plan = domain.renamePlan.map((p) => `${p.from}->${p.to}`).join(", ");
  trace("ios", "(stub mode)");
  trace("ios", `copying SwiftUI substrate for ${domain.displayName}`);
  await delay(200);
  trace("ios", `renaming Swift symbols: ${plan}`);
  await delay(300);
  trace("ios", "regenerating @Observable view models");
  await delay(250);
  trace("ios", "updating Localizable.strings");
  await delay(200);
  trace("ios", `done (out/${domain.slug}/ios)`);

  return {
    platform: "ios",
    outDir: `./out/${domain.slug}/ios`,
    filesTouched: 63,
  };
}
