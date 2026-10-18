// Per-run choice of the visual level and the test suites (#160). A CLI flag or
// MCP argument wins; without one, NATIVEAPPTEMPLATE_VISUAL /
// NATIVEAPPTEMPLATE_TESTS decide as before. Defaults: visual 0, no tests.

export type VisualLevel = 0 | 1 | 2;

export function parseVisualLevel(raw: string): VisualLevel | undefined {
  const v = raw.trim();
  return v === "0" ? 0 : v === "1" ? 1 : v === "2" ? 2 : undefined;
}

// The environment variable's long-standing reading: anything but "1" or "2"
// (unset, "0", a typo) is level 0.
export function visualLevelFromEnv(env: NodeJS.ProcessEnv = process.env): VisualLevel {
  const raw = env["NATIVEAPPTEMPLATE_VISUAL"] ?? "";
  return raw === "2" ? 2 : raw === "1" ? 1 : 0;
}

export function resolveVisualLevel(flag: VisualLevel | undefined, env: NodeJS.ProcessEnv = process.env): VisualLevel {
  return flag ?? visualLevelFromEnv(env);
}

export function testsFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env["NATIVEAPPTEMPLATE_TESTS"] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "on" || raw === "true";
}

export function resolveTests(flag: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return flag ?? testsFromEnv(env);
}
