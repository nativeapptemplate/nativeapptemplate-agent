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
// Source priority for the substrate values:
//   shell env > ~/.gradle/gradle.properties > nothing (skip the key)
//
// User typically exports NATIVEAPPTEMPLATE_API_DOMAIN=<dev-ip> in their
// shell when running the agent for local validation; the gradle.properties
// fallback exists for users who keep their dev config there permanently.

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
// substrate equivalent is set somewhere — silently omits any key that
// has no value in either source. Caller decides what to do with empty
// results.
export async function readSubstrateApiVars(): Promise<Readonly<Record<string, string>>> {
  const fromShell: Record<string, string> = {};
  for (const suffix of MIRRORED_SUFFIXES) {
    const v = process.env[`NATIVEAPPTEMPLATE_${suffix}`];
    if (v !== undefined && v !== "") fromShell[suffix] = v;
  }

  const fromGradle = await readGradleProperties();

  const result: Record<string, string> = {};
  for (const suffix of MIRRORED_SUFFIXES) {
    const v = fromShell[suffix] ?? fromGradle[`NATIVEAPPTEMPLATE_${suffix}`];
    if (v !== undefined && v !== "") result[suffix] = v;
  }
  return result;
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

// Write a sentinel block to ~/.gradle/gradle.properties containing the
// mirrored keys. Replaces an existing block from a prior run; preserves
// every line outside the block. If gradle.properties doesn't exist,
// creates it. If the bridge has no values (substrate vars unset),
// removes the existing block (so stale values from a prior run don't
// linger) and writes nothing else.
export async function syncGradleProperties(bridge: BridgeValues): Promise<{
  path: string;
  wrote: boolean;
  removedStale: boolean;
}> {
  const path = join(homedir(), ".gradle", "gradle.properties");
  const existing = await readFileOrEmpty(path);
  const stripped = removeSentinelBlock(existing);
  const removedStale = stripped !== existing && Object.keys(bridge.values).length === 0;

  if (Object.keys(bridge.values).length === 0) {
    if (existing === stripped) return { path, wrote: false, removedStale: false };
    await writeFile(path, stripped);
    return { path, wrote: false, removedStale };
  }

  const block = formatSentinelBlock(bridge.values);
  const next = ensureTrailingNewline(stripped) + block + "\n";
  if (next === existing) return { path, wrote: false, removedStale: false };
  await writeFile(path, next);
  return { path, wrote: true, removedStale };
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
