import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { scrubbedEnv } from "../../env.js";
import { join, resolve } from "node:path";
import { trace } from "../../trace.js";
import { isStub } from "../../stub.js";
import { runRuby } from "../../ruby.js";
import { bundleIdFromPbxproj, renameAppDomainInput, type RenameAppDomain } from "../../app-domain.js";
import { japaneseRenamePairs, renamedTokens } from "../../japanese-nouns.js";
import { copySubstrate, SENTRY_CREDENTIAL_FILES, type CopySkipRules } from "./copy.js";
import { runFormatter, traceFormat } from "../../validation/autoformat.js";
import { slugToPascal } from "../../slug.js";
import { clearIosTeam } from "../../app-team.js";
import { resetIosVersion } from "../../app-version.js";
import type { DomainSpec, RenamePair, WorkerResult } from "../types.js";

type RenameStats = {
  files_scanned: number;
  files_changed: number;
  substitutions: number;
  files_renamed: number;
};

// RevenueCat.local.xcconfig is the developer's gitignored RevenueCat key for
// the template itself. Copied, it would switch billing on in the generated app
// with another app's key (offerings fail, every paid feature locked); without
// it the generated app starts with billing off, as the template is committed.
// Sentry.local.xcconfig likewise holds the developer's DSN and org/project:
// copied, the generated app would send its crashes to the template's Sentry
// project and its archives would upload dSYMs there.
// API.local.xcconfig is kept although gitignored: it points Debug builds at
// the developer's Rails. build/ and *.xcresult (what `xcodebuild` and its test
// runs leave in the working tree) are listed only for a substrate outside git;
// in git the template's .gitignore already leaves them out.
export const IOS_SKIP_RULES: CopySkipRules = {
  rootPaths: [".git", ".claude", "build", "DerivedData", ".build", "Pods", "Carthage"],
  anySegment: ["xcuserdata", "RevenueCat.local.xcconfig", "Sentry.local.xcconfig", ...SENTRY_CREDENTIAL_FILES],
  anySuffix: [".xcresult"],
  keepIgnored: ["API.local.xcconfig"],
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
  await copySubstrate(substrate, outDir, IOS_SKIP_RULES);

  const productPairs = buildProductRenamePairs(domain.slug);
  const renamePlan: readonly RenamePair[] = [...productPairs, ...domain.renamePlan].filter((p) => p.from !== p.to);
  const plan = renamePlan.map((p) => `${p.from}->${p.to}`).join(", ");
  trace("ios", `running scripts/ruby/rename.rb: ${plan}`);

  const renameStats = await runRuby<{ renamePlan: readonly RenamePair[]; japaneseRenamePlan: readonly RenamePair[]; appDomain?: RenameAppDomain; root: string }, RenameStats>(
    "rename.rb",
    { renamePlan, japaneseRenamePlan: japaneseRenamePairs(renamePlan), ...renameAppDomainInput(domain.slug, domain.appDomain), root: outDir },
  );

  trace(
    "ios",
    `scanned ${renameStats.files_scanned} files, changed ${renameStats.files_changed}, ${renameStats.substitutions} substitutions, ${renameStats.files_renamed} file/dir renames`,
  );

  const appId = await readBundleId(outDir);
  if (appId) trace("ios", `bundle ID: ${appId}`);
  await resetIosVersion(outDir);
  await clearIosTeam(outDir);
  const format = await runFormatter("ios", outDir);
  traceFormat("ios", format);
  await initGit(outDir);
  trace("ios", `done (out/${domain.slug}/ios)`);

  return {
    platform: "ios",
    outDir: `./out/${domain.slug}/ios`,
    filesTouched: renameStats.files_changed + renameStats.files_renamed,
    renamedFrom: renamedTokens(renamePlan),
    format,
    ...(appId ? { appId } : {}),
  };
}

async function readBundleId(outDir: string): Promise<string | undefined> {
  const project = (await readdir(outDir)).find((name) => name.endsWith(".xcodeproj"));
  if (!project) return undefined;
  try {
    return bundleIdFromPbxproj(await readFile(join(outDir, project, "project.pbxproj"), "utf8"));
  } catch {
    return undefined;
  }
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
    renamedFrom: renamedTokens(domain.renamePlan),
  };
}
