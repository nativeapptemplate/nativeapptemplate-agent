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
