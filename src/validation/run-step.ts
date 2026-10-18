import { spawn } from "node:child_process";
import { scrubbedEnv } from "../env.js";

// A command the agent runs inside a generated project that is reported but
// doesn't gate the run (formatters after the rename, the opt-in test
// suites). Never throws: a missing binary, a crash or a timeout comes back
// as a failed result so the run still writes its report.
export type StepRun = {
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  // stdout and stderr interleaved, as the tools print their findings to
  // either (RuboCop: stdout, Gradle: stderr).
  output: string;
};

export type StepOptions = {
  timeoutMs: number;
  useMise?: boolean;
  env?: NodeJS.ProcessEnv;
};

// Only the end of the output is ever reported; `xcodebuild test` alone can
// print tens of megabytes.
const MAX_OUTPUT_BYTES = 1_000_000;

export function runStep(cwd: string, argv: readonly string[], options: StepOptions): Promise<StepRun> {
  const [command, ...rest] = options.useMise ? ["mise", "exec", "--", ...argv] : argv;
  const start = Date.now();
  return new Promise((done) => {
    // Never inherit stdout/stdin: under the MCP server those are the
    // JSON-RPC channel.
    const child = spawn(command!, rest, { cwd, stdio: ["ignore", "pipe", "pipe"], env: scrubbedEnv(options.env) });
    let chunks: Buffer[] = [];
    let size = 0;
    const collect = (c: Buffer): void => {
      chunks.push(c);
      size += c.length;
      if (size > MAX_OUTPUT_BYTES * 2) {
        const all = Buffer.concat(chunks);
        chunks = [all.subarray(all.length - MAX_OUTPUT_BYTES)];
        size = MAX_OUTPUT_BYTES;
      }
    };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeoutMs);
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const finish = (exitCode: number | null, extra = ""): void => {
      clearTimeout(timer);
      done({ exitCode, durationMs: Date.now() - start, timedOut, output: Buffer.concat(chunks).toString("utf8") + extra });
    };
    child.on("close", (code) => finish(timedOut ? null : code, timedOut ? `\n(timed out after ${Math.round(options.timeoutMs / 1000)}s)` : ""));
    child.on("error", (err) => finish(null, `\n${err.message}`));
  });
}

export function commandAvailable(bin: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((done) => {
    const c = spawn("which", [bin], { env: scrubbedEnv(env), stdio: "ignore" });
    c.on("close", (code) => done(code === 0));
    c.on("error", () => done(false));
  });
}

export function tailLines(s: string, lines: number): string {
  return s.trimEnd().split("\n").slice(-lines).join("\n");
}

export function withMisePrefix(command: string, useMise: boolean): string {
  return useMise ? `mise exec -- ${command}` : command;
}
