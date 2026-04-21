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

const SKIP_SEGMENTS = new Set([
  ".git",
  "build",
  ".gradle",
  ".idea",
  ".kotlin",
  "captures",
  "node_modules",
]);

export async function runAndroidWorker(domain: DomainSpec): Promise<WorkerResult> {
  if (isStub("android")) {
    return runStubAndroidWorker(domain);
  }

  const substrate = process.env['NATEMPLATE_ANDROID'];
  if (!substrate) {
    throw new Error("android worker: NATEMPLATE_ANDROID env var is not set; see CLAUDE.md Substrate section");
  }

  const outDir = resolve(process.cwd(), "out", domain.slug, "android");

  trace("android", `copying substrate from ${substrate} to ${outDir}`);
  await prepareFresh(outDir);
  await copyFiltered(substrate, outDir);

  const productPairs = buildProductRenamePairs(domain.slug);
  const renamePlan: readonly RenamePair[] = [...productPairs, ...domain.renamePlan];
  const plan = renamePlan.map((p) => `${p.from}->${p.to}`).join(", ");
  trace("android", `running scripts/ruby/rename.rb: ${plan}`);

  const renameStats = await runRuby<{ renamePlan: readonly RenamePair[]; root: string }, RenameStats>(
    "rename.rb",
    { renamePlan, root: outDir },
  );

  trace(
    "android",
    `scanned ${renameStats.files_scanned} files, changed ${renameStats.files_changed}, ${renameStats.substitutions} substitutions, ${renameStats.files_renamed} file/dir renames`,
  );

  await initGit(outDir);
  trace("android", `done (out/${domain.slug}/android)`);

  return {
    platform: "android",
    outDir: `./out/${domain.slug}/android`,
    filesTouched: renameStats.files_changed + renameStats.files_renamed,
  };
}

function buildProductRenamePairs(slug: string): readonly RenamePair[] {
  const pascal = slugToPascal(slug);
  return [
    { from: "NativeAppTemplateFree", to: `${pascal}App` },
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
      const segments = rel.split("/").filter(Boolean);
      if (segments.some((seg) => SKIP_SEGMENTS.has(seg))) return false;
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

async function runStubAndroidWorker(domain: DomainSpec): Promise<WorkerResult> {
  const plan = domain.renamePlan.map((p) => `${p.from}->${p.to}`).join(", ");
  trace("android", "(stub mode)");
  trace("android", `copying Jetpack Compose substrate for ${domain.displayName}`);
  await delay(200);
  trace("android", `renaming Kotlin symbols: ${plan}`);
  await delay(300);
  trace("android", "regenerating data classes + Hilt modules");
  await delay(250);
  trace("android", "updating res/values/strings.xml");
  await delay(200);
  trace("android", `done (out/${domain.slug}/android)`);

  return {
    platform: "android",
    outDir: `./out/${domain.slug}/android`,
    filesTouched: 81,
  };
}
