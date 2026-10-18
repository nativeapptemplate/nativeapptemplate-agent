import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { trace } from "../trace.js";
import type { Platform, StepResult } from "../agents/types.js";
import { commandAvailable, runStep, tailLines, withMisePrefix, type StepRun } from "./run-step.js";

// The rename changes identifier lengths and alphabetical order, which the
// substrates' own lint configs then flag although the builds pass (#149):
// RuboCop Layout/HashAlignment when shopkeeper_auth becomes teammate_auth,
// ktlint import ordering when ShopkeeperLocaleUpdate becomes
// TeammateLocaleUpdate. Run each substrate's autocorrecting formatter on the
// generated project and report whatever it could not fix.

const BUNDLE_CHECK_TIMEOUT_MS = 120_000;
const BUNDLE_INSTALL_TIMEOUT_MS = 900_000;
const RUBOCOP_TIMEOUT_MS = 600_000;
const SPOTLESS_TIMEOUT_MS = 900_000;
const SWIFTFORMAT_TIMEOUT_MS = 300_000;
const OUTPUT_TAIL_LINES = 40;

export type FormatterOptions = {
  // Defaults to "mise is on PATH", as Layer 2 decides for Rails.
  useMise?: boolean;
  env?: NodeJS.ProcessEnv;
};

// NATIVEAPPTEMPLATE_FORMAT=off skips the formatters (e.g. to save the
// Gradle/Bundler time on a quick run).
export function formattersEnabled(): boolean {
  return (process.env['NATIVEAPPTEMPLATE_FORMAT'] ?? "").trim().toLowerCase() !== "off";
}

export async function runFormatter(platform: Platform, outDir: string, options: FormatterOptions = {}): Promise<StepResult> {
  if (!formattersEnabled()) return skipped(FORMATTER_COMMAND[platform], "NATIVEAPPTEMPLATE_FORMAT=off");
  switch (platform) {
    case "rails": return runRubocop(outDir, options);
    case "android": return runSpotless(outDir, options);
    case "ios": return runSwiftformat(outDir, options);
  }
}

export function traceFormat(platform: Platform, result: StepResult): void {
  if (result.status === "skipped") {
    trace(platform, `formatter skipped (${result.command}): ${result.note ?? ""}`);
  } else if (result.status === "pass") {
    trace(platform, `formatter: ${result.command} — clean (${(result.durationMs / 1000).toFixed(1)}s)`);
  } else {
    trace(platform, `formatter: ${result.command} — issues left (exit ${result.exitCode ?? "none"})${result.note ? `: ${result.note}` : ""}`);
    for (const line of (result.outputTail ?? "").split("\n")) trace(platform, `  ${line}`);
  }
}

const FORMATTER_COMMAND: Record<Platform, string> = {
  rails: "bin/rubocop -a",
  android: "./gradlew spotlessApply",
  ios: "swiftformat",
};

async function runRubocop(outDir: string, options: FormatterOptions): Promise<StepResult> {
  if (!(await exists(join(outDir, "bin", "rubocop")))) return skipped("bin/rubocop -a", "no bin/rubocop in the generated app");
  const useMise = options.useMise ?? (await commandAvailable("mise", options.env));
  const env = options.env;

  // bin/rubocop loads the bundle; install it first as Layer 2 would.
  if (await exists(join(outDir, "Gemfile"))) {
    const check = await runStep(outDir, ["bundle", "check"], { timeoutMs: BUNDLE_CHECK_TIMEOUT_MS, useMise, ...(env ? { env } : {}) });
    if (check.exitCode !== 0) {
      const install = await runStep(outDir, ["bundle", "install"], { timeoutMs: BUNDLE_INSTALL_TIMEOUT_MS, useMise, ...(env ? { env } : {}) });
      if (install.exitCode !== 0) {
        return fromRun(withMisePrefix("bundle install", useMise), install, "RuboCop not run: bundle install failed");
      }
    }
  }
  const run = await runStep(outDir, ["bin/rubocop", "-a"], { timeoutMs: RUBOCOP_TIMEOUT_MS, useMise, ...(env ? { env } : {}) });
  return fromRun(withMisePrefix("bin/rubocop -a", useMise), run);
}

async function runSpotless(outDir: string, options: FormatterOptions): Promise<StepResult> {
  if (!(await exists(join(outDir, "gradlew")))) return skipped("./gradlew spotlessApply", "no ./gradlew wrapper in the generated app");
  const run = await runStep(outDir, ["./gradlew", "spotlessApply", "--no-daemon"], {
    timeoutMs: SPOTLESS_TIMEOUT_MS,
    ...(options.env ? { env: options.env } : {}),
  });
  return fromRun("./gradlew spotlessApply", run);
}

async function runSwiftformat(outDir: string, options: FormatterOptions): Promise<StepResult> {
  // The iOS templates format their app sources only (`make format`:
  // `swiftformat NativeAppTemplate`); their test targets aren't kept
  // SwiftFormat-clean, so formatting "." would rewrite dozens of test files
  // the rename never touched.
  const target = (await appSourceDir(outDir)) ?? ".";
  const command = `swiftformat ${target}`;
  if (!(await commandAvailable("swiftformat", options.env))) return skipped(command, "swiftformat not on PATH");
  const run = await runStep(outDir, ["swiftformat", target], {
    timeoutMs: SWIFTFORMAT_TIMEOUT_MS,
    ...(options.env ? { env: options.env } : {}),
  });
  return fromRun(command, run);
}

// <Product>.xcodeproj's sibling <Product>/ directory, when there is one.
async function appSourceDir(outDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(outDir);
  } catch {
    return null;
  }
  const project = entries.find((e) => e.endsWith(".xcodeproj"));
  if (!project) return null;
  const name = project.slice(0, -".xcodeproj".length);
  return entries.includes(name) ? name : null;
}

function fromRun(command: string, run: StepRun, failNote?: string): StepResult {
  const pass = run.exitCode === 0;
  const tail = tailLines(run.output, OUTPUT_TAIL_LINES);
  return {
    status: pass ? "pass" : "fail",
    command,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    ...(tail ? { outputTail: tail } : {}),
    ...(!pass && failNote ? { note: failNote } : {}),
    ...(!pass && !failNote && run.timedOut ? { note: "timed out" } : {}),
  };
}

function skipped(command: string, note: string): StepResult {
  return { status: "skipped", command, exitCode: null, durationMs: 0, note };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
