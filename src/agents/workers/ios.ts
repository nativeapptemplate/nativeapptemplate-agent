import { mkdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { scrubbedEnv } from "../../env.js";
import { resolve } from "node:path";
import { trace } from "../../trace.js";
import { isStub } from "../../stub.js";
import { runRuby } from "../../ruby.js";
import { copySubstrate, type CopySkipRules } from "./copy.js";
import { slugToPascal } from "../../slug.js";
import type { DomainSpec, RenamePair, WorkerResult } from "../types.js";

type RenameStats = {
  files_scanned: number;
  files_changed: number;
  substitutions: number;
  files_renamed: number;
};

const SKIP_RULES: CopySkipRules = {
  rootPaths: [".git", ".claude", "DerivedData", ".build", "Pods", "Carthage"],
  anySegment: ["xcuserdata"],
};

export async function runIosWorker(domain: DomainSpec): Promise<WorkerResult> {
  if (isStub("ios")) {
    return runStubIosWorker(domain);
  }

  const substrate = process.env['NATIVEAPPTEMPLATE_IOS'];
  if (!substrate) {
    throw new Error("ios worker: NATIVEAPPTEMPLATE_IOS env var is not set; see AGENTS.md Substrate section");
  }

  const outDir = resolve(process.cwd(), "out", domain.slug, "ios");

  trace("ios", `copying substrate from ${substrate} to ${outDir}`);
  await prepareFresh(outDir);
  await copySubstrate(substrate, outDir, SKIP_RULES);

  const productPairs = buildProductRenamePairs(domain.slug);
  const renamePlan: readonly RenamePair[] = [...productPairs, ...domain.renamePlan].filter((p) => p.from !== p.to);
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
    renamedFrom: renamePlan.map((p) => p.from),
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


async function initGit(dir: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["init", "-q", "-b", "main"], { cwd: dir, env: scrubbedEnv() });
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
    renamedFrom: domain.renamePlan.map((p) => p.from),
  };
}
