import { readFileSync } from "node:fs";

// Subprocesses inherit the agent's full environment by default, including
// ANTHROPIC_API_KEY. None of the things the agent spawns (ruby, git, psql,
// xcodebuild, gradlew, bin/rails) need that key, and one of them — eventually
// the mobile-mcp client — is third-party code. Strip anything that looks like
// an Anthropic credential before handing env to a child.

const SENSITIVE_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "NATIVEAPPTEMPLATE_AGENT_ANTHROPIC_KEY",
] as const;

export function scrubbedEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SENSITIVE_KEYS) delete env[key];
  return extra ? { ...env, ...extra } : env;
}

// Load `.env` if present, but never overwrite an already-set process.env
// value. Shell exports (`export FOO=x`) and inline assignment
// (`FOO=x npm run dev`) win over the file. `.env` is just a convenience
// for users who don't want to manage shell config.
//
// Format: KEY=value per line, comments with `#`, surrounding double or
// single quotes are stripped. No shell interpolation.
export function loadDotenvIfPresent(path = ".env"): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const valueRaw = trimmed.slice(eq + 1).trim();
    const value = valueRaw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
