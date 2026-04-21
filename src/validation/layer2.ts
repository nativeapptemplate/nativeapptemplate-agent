import { spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";

export type Layer2Platform = "rails" | "ios" | "android";

export type Layer2Input = {
  platform: Layer2Platform;
  outDir: string;
  timeoutMs?: number;
};

export type Layer2Result = {
  pass: boolean;
  command: string;
  exitCode: number | null;
  durationMs: number;
  stderrTail?: string;
};

const DEFAULT_TIMEOUT_MS = 300_000;

export async function runLayer2(input: Layer2Input): Promise<Layer2Result> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  if (!(await exists(input.outDir))) {
    return {
      pass: false,
      command: "stat",
      exitCode: null,
      durationMs: Date.now() - start,
      stderrTail: `outDir does not exist: ${input.outDir}`,
    };
  }

  switch (input.platform) {
    case "rails":   return runRailsLayer2(input.outDir, timeoutMs, start);
    case "ios":     return runIosLayer2(input.outDir, timeoutMs, start);
    case "android": return runAndroidLayer2(input.outDir, timeoutMs, start);
  }
}

async function runRailsLayer2(outDir: string, timeoutMs: number, start: number): Promise<Layer2Result> {
  const useMise = await commandAvailable("mise");

  const bundleCheck = await runIn(outDir, ["bundle", "check"], timeoutMs, useMise);
  if (bundleCheck.exitCode !== 0) {
    const bundleInstall = await runIn(outDir, ["bundle", "install"], timeoutMs, useMise);
    if (bundleInstall.exitCode !== 0) return failed("bundle install", bundleInstall, start, useMise);
  }

  const routes = await runIn(outDir, ["bin/rails", "routes"], timeoutMs, useMise);
  if (routes.exitCode !== 0) return failed("bin/rails routes", routes, start, useMise);

  return { pass: true, command: withPrefix("bin/rails routes", useMise), exitCode: 0, durationMs: Date.now() - start };
}

async function runIosLayer2(outDir: string, timeoutMs: number, start: number): Promise<Layer2Result> {
  const xcodeproj = (await readdir(outDir)).find((e) => e.endsWith(".xcodeproj"));
  if (!xcodeproj) {
    return {
      pass: false,
      command: "find .xcodeproj",
      exitCode: null,
      durationMs: Date.now() - start,
      stderrTail: `no .xcodeproj in ${outDir}`,
    };
  }

  const list = await runIn(outDir, ["xcodebuild", "-list", "-project", xcodeproj], timeoutMs, false);
  if (list.exitCode !== 0) return failed(`xcodebuild -list -project ${xcodeproj}`, list, start, false);

  return {
    pass: true,
    command: `xcodebuild -list -project ${xcodeproj}`,
    exitCode: 0,
    durationMs: Date.now() - start,
  };
}

async function runAndroidLayer2(outDir: string, timeoutMs: number, start: number): Promise<Layer2Result> {
  const wrapper = await exists(`${outDir}/gradlew`);
  if (!wrapper) {
    return {
      pass: false,
      command: "stat ./gradlew",
      exitCode: null,
      durationMs: Date.now() - start,
      stderrTail: `no ./gradlew wrapper in ${outDir}`,
    };
  }

  const version = await runIn(outDir, ["./gradlew", "--version"], timeoutMs, false);
  if (version.exitCode !== 0) return failed("./gradlew --version", version, start, false);

  return {
    pass: true,
    command: "./gradlew --version",
    exitCode: 0,
    durationMs: Date.now() - start,
  };
}

function failed(action: string, result: RunResult, start: number, useMise: boolean): Layer2Result {
  return {
    pass: false,
    command: withPrefix(action, useMise),
    exitCode: result.exitCode,
    durationMs: Date.now() - start,
    stderrTail: tail(result.stderr, 30),
  };
}

function withPrefix(action: string, useMise: boolean): string {
  return useMise ? `mise exec -- ${action}` : action;
}

type RunResult = { exitCode: number | null; stderr: string };

function runIn(cwd: string, argv: readonly string[], timeoutMs: number, useMise: boolean): Promise<RunResult> {
  const [command, ...rest] = useMise ? ["mise", "exec", "--", ...argv] : argv;
  return new Promise((resolvePromise) => {
    const child = spawn(command!, rest, { cwd });
    const stderrChunks: Buffer[] = [];
    const timer = setTimeout(() => { child.kill("SIGTERM"); }, timeoutMs);

    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, stderr: Buffer.concat(stderrChunks).toString("utf8") });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise({ exitCode: null, stderr: Buffer.concat(stderrChunks).toString("utf8") });
    });
  });
}

async function commandAvailable(bin: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const c = spawn("which", [bin]);
    c.on("close", (code) => resolvePromise(code === 0));
    c.on("error", () => resolvePromise(false));
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function tail(s: string, lines: number): string {
  return s.split("\n").slice(-lines).join("\n");
}
