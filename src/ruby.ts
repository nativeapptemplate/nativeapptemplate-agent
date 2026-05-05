import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubbedEnv } from "./env.js";

// Resolve scripts/ruby/ relative to the module's own location, not the
// caller's cwd. When installed via npm, the package layout is:
//   <install>/dist/ruby.js
//   <install>/scripts/ruby/<script>.rb
// So scripts/ruby/ is one level up from the dist file. Using process.cwd()
// here would look for scripts/ in whatever directory the user runs `npx`
// from — broken for every published-package code path.
const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ruby");

export async function runRuby<TInput, TOutput>(
  scriptName: string,
  input: TInput,
): Promise<TOutput> {
  const scriptPath = resolve(SCRIPTS_DIR, scriptName);
  const child = spawn("ruby", [scriptPath], { env: scrubbedEnv() });

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
