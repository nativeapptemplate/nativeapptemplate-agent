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

export function runStep(cwd: string, argv: readonly string[], options: StepOptions): Promise<StepRun> {
  const [command, ...rest] = options.useMise ? ["mise", "exec", "--", ...argv] : argv;
  const start = Date.now();
  return new Promise((done) => {
    // Never inherit stdout/stdin: under the MCP server those are the
    // JSON-RPC channel.
    const child = spawn(command!, rest, { cwd, stdio: ["ignore", "pipe", "pipe"], env: scrubbedEnv(options.env) });
    const chunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeoutMs);
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.stderr?.on("data", (c: Buffer) => chunks.push(c));
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
