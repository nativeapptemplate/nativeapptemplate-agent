import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { JudgeResult, Platform, StepResult } from "../agents/types.js";
import { iosSimulatorDestination } from "./ios-destination.js";
import { commandAvailable, runStep, tailLines, withMisePrefix, type StepRun } from "./run-step.js";

// SPEC §4 Operation 3: the generated apps' own test suites must pass. Layer 2
// only builds, and the suites take minutes (Rails ~650 tests, iOS ~1,100,
// Android ~900 on the paid substrates), so they run only when
// NATIVEAPPTEMPLATE_TESTS=1. A rename can break a test without breaking the
// build (#150: the iOS substrate's "unknown type" example became a real type).

const RAILS_TEST_TIMEOUT_MS = 1_800_000;
const IOS_TEST_TIMEOUT_MS = 2_700_000;
const ANDROID_TEST_TIMEOUT_MS = 1_800_000;
const DB_PREPARE_TIMEOUT_MS = 300_000;
const OUTPUT_TAIL_LINES = 60;

export type TestSuiteOptions = {
  // Defaults to "mise is on PATH", as Layer 2 decides for Rails.
  useMise?: boolean;
  env?: NodeJS.ProcessEnv;
};

export function testsEnabled(): boolean {
  const raw = (process.env['NATIVEAPPTEMPLATE_TESTS'] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "on" || raw === "true";
}

export async function runTestSuite(platform: Platform, outDir: string, options: TestSuiteOptions = {}): Promise<StepResult> {
  switch (platform) {
    case "rails": return runRailsTests(outDir, options);
    case "ios": return runIosTests(outDir, options);
    case "android": return runAndroidTests(outDir, options);
  }
}

async function runRailsTests(outDir: string, options: TestSuiteOptions): Promise<StepResult> {
  if (!(await exists(join(outDir, "bin", "rails")))) return skipped("bin/rails test", "no bin/rails in the generated app");
  const useMise = options.useMise ?? (await commandAvailable("mise", options.env));
  const env = options.env ? { env: options.env } : {};
  // The generated app's own <slug>_api_test database; Layer 2's db:prepare
  // only sets up development.
  const prepare = await runStep(outDir, ["bin/rails", "db:test:prepare"], { timeoutMs: DB_PREPARE_TIMEOUT_MS, useMise, ...env });
  if (prepare.exitCode !== 0) {
    return fromRun(withMisePrefix("bin/rails db:test:prepare", useMise), prepare, "tests not run: db:test:prepare failed");
  }
  const run = await runStep(outDir, ["bin/rails", "test"], { timeoutMs: RAILS_TEST_TIMEOUT_MS, useMise, ...env });
  return fromRun(withMisePrefix("bin/rails test", useMise), run);
}

async function runIosTests(outDir: string, options: TestSuiteOptions): Promise<StepResult> {
  let entries: string[] = [];
  try { entries = await readdir(outDir); } catch { /* reported below */ }
  const xcodeproj = entries.find((e) => e.endsWith(".xcodeproj"));
  if (!xcodeproj) return skipped("xcodebuild test", `no .xcodeproj in ${outDir}`);
  const scheme = xcodeproj.slice(0, -".xcodeproj".length);
  // Same project, scheme, destination and configuration as Layer 2's build,
  // so xcodebuild reuses that build.
  const args = ["xcodebuild", "-project", xcodeproj, "-scheme", scheme, "-destination", iosSimulatorDestination(), "-configuration", "Debug", "test"];
  const run = await runStep(outDir, args, { timeoutMs: IOS_TEST_TIMEOUT_MS, ...(options.env ? { env: options.env } : {}) });
  return fromRun(`xcodebuild test -scheme ${scheme}`, run);
}

async function runAndroidTests(outDir: string, options: TestSuiteOptions): Promise<StepResult> {
  if (!(await exists(join(outDir, "gradlew")))) return skipped("./gradlew testDebugUnitTest", "no ./gradlew wrapper in the generated app");
  const run = await runStep(outDir, ["./gradlew", "testDebugUnitTest", "--no-daemon"], {
    timeoutMs: ANDROID_TEST_TIMEOUT_MS,
    ...(options.env ? { env: options.env } : {}),
  });
  return fromRun("./gradlew testDebugUnitTest", run);
}

// The last line each runner prints about the whole run:
//   Minitest:    "643 runs, 2108 assertions, 0 failures, 0 errors, 0 skips"
//   XCTest:      "Executed 1117 tests, with 1 failure (0 unexpected) in ..."
//   Swift Testing: "✘ Test run with 1117 tests in 85 suites failed after ..."
//   xcodebuild:  "** TEST SUCCEEDED **" / "** TEST FAILED **"
//   Gradle:      "BUILD SUCCESSFUL in 1m 2s" / "BUILD FAILED in 40s",
//                "888 tests completed, 1 failed"
const SUMMARY_PATTERNS: readonly RegExp[] = [
  /^\d+ runs, \d+ assertions, \d+ failures, \d+ errors, \d+ skips$/,
  /Executed \d+ tests?, with \d+ failures?.*$/,
  /Test run with \d+ tests?.*$/,
  /^\d+ tests completed, \d+ failed.*$/,
  /^\*\* TEST (SUCCEEDED|FAILED) \*\*$/,
  /^BUILD (SUCCESSFUL|FAILED) in .*$/,
];

export function extractSummary(output: string): string | undefined {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const pattern of SUMMARY_PATTERNS) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i]!.match(pattern);
      if (m) return m[0];
    }
  }
  return undefined;
}

function fromRun(command: string, run: StepRun, failNote?: string): StepResult {
  const pass = run.exitCode === 0;
  const tail = tailLines(run.output, OUTPUT_TAIL_LINES);
  const summary = extractSummary(run.output);
  return {
    status: pass ? "pass" : "fail",
    command,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    ...(tail ? { outputTail: tail } : {}),
    ...(summary ? { summary } : {}),
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

// Fold suite results into the judge result: each platform carries its
// `tests`, and an opted-in suite that fails fails the run (SPEC §4
// Operation 3). Skipped suites are shown but don't count.
export function applyTestResults(judge: JudgeResult, results: Partial<Record<Platform, StepResult>>): JudgeResult {
  const platforms = (judge.platforms ?? []).map((p) => {
    const tests = results[p.platform];
    return tests ? { ...p, tests } : p;
  });
  const ran = platforms.filter((p) => p.tests && p.tests.status !== "skipped");
  const passed = ran.filter((p) => p.tests!.status === "pass").length;
  return {
    ...judge,
    overallPass: judge.overallPass && passed === ran.length,
    summary: `${judge.summary} · tests ${passed}/${ran.length} pass`,
    platforms,
  };
}
