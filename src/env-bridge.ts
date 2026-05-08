import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { slugToPascal } from "./slug.js";
import type { DomainSpec } from "./agents/types.js";

// Bridges substrate-named API config (NATIVEAPPTEMPLATE_API_*) to the
// renamed-product equivalents (<PRODUCT>_API_*) so the agent's auto-
// validation runs see the right values without forcing the user to
// hand-set N env vars per generated app.
//
// Three sinks the agent has to feed:
//   1. ~/.gradle/gradle.properties (so Android Studio + manual ./gradlew
//      see the value when the user opens the generated project later)
//   2. ORG_GRADLE_PROJECT_<KEY>=<value> in the child env when the agent
//      itself spawns ./gradlew (Layer 2 build mode, defensive — works
//      even if gradle.properties is mid-write or the user hasn't saved)
//   3. SIMCTL_CHILD_<KEY>=<value> in the child env when the agent spawns
//      `xcrun simctl launch` (so the env var reaches the running iOS
//      app via simctl's child-env passthrough convention)
//
// Source of truth, by suffix:
//   API_DOMAIN ← $NATIVEAPPTEMPLATE_API/.env HOST
//   API_PORT   ← $NATIVEAPPTEMPLATE_API/.env PORT
//   API_SCHEME ← shell env NATIVEAPPTEMPLATE_API_SCHEME, fall back to
//                 ~/.gradle/gradle.properties (since the substrate's
//                 Rails .env doesn't carry SCHEME)
//
// Single source of truth: the substrate's own Rails .env (where Rails
// actually binds). The mobile clients connect to exactly that host:port,
// so reading from .env eliminates the drift risk of a parallel shell
// export. User maintains one file, .env, for their dev-network setup.

// The three keys we mirror. Adding a new one here automatically threads
// it through all three sinks. Listed in the same order they appear in
// the substrate's gradle.properties / .env.sample so diffs read
// naturally.
const MIRRORED_SUFFIXES = ["API_DOMAIN", "API_PORT", "API_SCHEME"] as const;

const SENTINEL_BEGIN = "# BEGIN nativeapptemplate-agent (mirrored API config — do not edit by hand)";
const SENTINEL_END = "# END nativeapptemplate-agent";

export type BridgeValues = {
  // Map from <PRODUCT>_<SUFFIX> → value, e.g.
  //   { VETCLINICQUEUE_API_DOMAIN: "192.168.1.11", ... }
  readonly values: Readonly<Record<string, string>>;
};

export function productTokenFor(domain: DomainSpec): string {
  return slugToPascal(domain.slug).toUpperCase();
}

// Read the substrate side of the bridge. Returns only the keys whose
// source-of-truth carries a non-empty value — silently omits anything
// missing. Caller decides what to do with empty results.
export async function readSubstrateApiVars(): Promise<Readonly<Record<string, string>>> {
  const result: Record<string, string> = {};

  // DOMAIN + PORT come from the substrate's Rails .env (HOST + PORT —
  // where Rails actually binds). Mobile clients must connect to that
  // exact host:port, so this is the single source of truth.
  const substratePath = process.env['NATIVEAPPTEMPLATE_API'];
  if (substratePath) {
    const env = await readDotenv(join(substratePath, ".env"));
    if (env['HOST']) result['API_DOMAIN'] = env['HOST'];
    if (env['PORT']) result['API_PORT'] = env['PORT'];
  }

  // SCHEME isn't in the Rails .env — pull it from the user's shell
  // env, fall back to ~/.gradle/gradle.properties, fall back to nothing
  // (caller treats missing as "use the app's compiled-in default").
  const shellScheme = process.env['NATIVEAPPTEMPLATE_API_SCHEME'];
  if (shellScheme) {
    result['API_SCHEME'] = shellScheme;
  } else {
    const gradleScheme = (await readGradleProperties())['NATIVEAPPTEMPLATE_API_SCHEME'];
    if (gradleScheme) result['API_SCHEME'] = gradleScheme;
  }

  return result;
}

async function readDotenv(path: string): Promise<Readonly<Record<string, string>>> {
  const raw = await readFileOrEmpty(path);
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const valueRaw = trimmed.slice(eq + 1).trim();
    const value = valueRaw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (key && value) out[key] = value;
  }
  return out;
}

export async function buildBridgeValues(domain: DomainSpec): Promise<BridgeValues> {
  const product = productTokenFor(domain);
  const substrate = await readSubstrateApiVars();
  const values: Record<string, string> = {};
  for (const [suffix, value] of Object.entries(substrate)) {
    values[`${product}_${suffix}`] = value;
  }
  return { values };
}

// Set ORG_GRADLE_PROJECT_<KEY> and SIMCTL_CHILD_<KEY> entries in the
// agent's own process.env so any subsequent child spawn that inherits
// process.env (via env.ts's scrubbedEnv) sees them. Idempotent — calling
// twice with the same domain is a no-op.
export function applyBridgeToProcessEnv(bridge: BridgeValues): void {
  for (const [key, value] of Object.entries(bridge.values)) {
    process.env[`ORG_GRADLE_PROJECT_${key}`] = value;
    process.env[`SIMCTL_CHILD_${key}`] = value;
  }
}

export type SyncMode = "wrote" | "skipped" | "dry-run" | "noop";

export type SyncResult = {
  path: string;
  mode: SyncMode;
  removedStale: boolean;
  // The exact content that was (or would have been) written. Useful for
  // dry-run logging without re-computing.
  preview?: string;
};

// Write a sentinel block to ~/.gradle/gradle.properties containing the
// mirrored keys. Replaces an existing block from a prior run; preserves
// every line outside the block. If gradle.properties doesn't exist,
// creates it. If the bridge has no values (substrate vars unset),
// removes the existing block (so stale values from a prior run don't
// linger) and writes nothing else.
//
// Safety knobs (env vars, both default to off):
//   NATIVEAPPTEMPLATE_BRIDGE=off       — skip the file write entirely;
//                                         process.env injection still
//                                         runs for the agent's own
//                                         child-spawn paths.
//   NATIVEAPPTEMPLATE_BRIDGE_DRY_RUN=1 — log what would be written
//                                         instead of writing. Useful for
//                                         users who want to inspect the
//                                         bridge's behavior before
//                                         giving it write access to
//                                         their user-global gradle.
export async function syncGradleProperties(bridge: BridgeValues): Promise<SyncResult> {
  const path = join(homedir(), ".gradle", "gradle.properties");

  if (process.env['NATIVEAPPTEMPLATE_BRIDGE'] === "off") {
    return { path, mode: "skipped", removedStale: false };
  }

  const existing = await readFileOrEmpty(path);
  const stripped = removeSentinelBlock(existing);
  const hasValues = Object.keys(bridge.values).length > 0;
  const removedStale = stripped !== existing && !hasValues;

  let next: string;
  if (!hasValues) {
    next = stripped;
  } else {
    const block = formatSentinelBlock(bridge.values);
    next = ensureTrailingNewline(stripped) + block + "\n";
  }

  const dryRun = process.env['NATIVEAPPTEMPLATE_BRIDGE_DRY_RUN'] === "1";
  if (next === existing) {
    return { path, mode: "noop", removedStale };
  }
  if (dryRun) {
    return { path, mode: "dry-run", removedStale, preview: next };
  }

  await writeFile(path, next);
  return { path, mode: hasValues ? "wrote" : "noop", removedStale };
}

async function readGradleProperties(): Promise<Readonly<Record<string, string>>> {
  const path = join(homedir(), ".gradle", "gradle.properties");
  const raw = await readFileOrEmpty(path);
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function removeSentinelBlock(content: string): string {
  const beginIdx = content.indexOf(SENTINEL_BEGIN);
  if (beginIdx === -1) return content;
  const endIdx = content.indexOf(SENTINEL_END, beginIdx);
  if (endIdx === -1) return content;
  const after = endIdx + SENTINEL_END.length;
  // Also consume the newline after END if present, so removing leaves
  // no orphan blank line.
  const trailing = content[after] === "\n" ? after + 1 : after;
  // And consume one preceding blank-separator newline so we don't
  // accumulate blanks across cycles.
  let before = beginIdx;
  if (before > 0 && content[before - 1] === "\n" && content[before - 2] === "\n") {
    before -= 1;
  }
  return content.slice(0, before) + content.slice(trailing);
}

function formatSentinelBlock(values: Readonly<Record<string, string>>): string {
  const lines: string[] = [SENTINEL_BEGIN];
  for (const key of Object.keys(values).sort()) {
    lines.push(`${key}=${values[key]}`);
  }
  lines.push(SENTINEL_END);
  return lines.join("\n");
}

function ensureTrailingNewline(s: string): string {
  if (s === "") return "";
  return s.endsWith("\n") ? s : s + "\n";
}
