import { spawn } from "node:child_process";
import { resolve } from "node:path";

export async function runRuby<TInput, TOutput>(
  scriptName: string,
  input: TInput,
): Promise<TOutput> {
  const scriptPath = resolve(process.cwd(), "scripts/ruby", scriptName);
  const child = spawn("ruby", [scriptPath]);

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
  child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

  child.stdin.write(JSON.stringify(input));
  child.stdin.end();

  const code: number = await new Promise((r) => { child.on("close", r); });
  if (code !== 0) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    throw new Error(`ruby script ${scriptName} exited ${code}: ${stderr}`);
  }

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  return JSON.parse(stdout) as TOutput;
}
