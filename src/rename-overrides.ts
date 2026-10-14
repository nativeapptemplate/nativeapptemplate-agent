import type { Entity, RenamePair } from "./agents/types.js";
import { reservedReason } from "./reserved-words.js";

// Manual rename overrides (ROADMAP §"Optional explicit naming overrides").
// The planner is the sole source of the rename plan; these let a human veto a
// single noun choice without taking over the whole DomainSpec. Flag-based, not
// interactive — ROADMAP keeps the CLI scriptable and CI/MCP-safe (no TTY).

export type OverrideOutcome =
  | { kind: "changed"; from: string; was: string; to: string }
  | { kind: "noop"; from: string; to: string }
  | { kind: "unmatched"; from: string; to: string }
  // kept: the target left in place — the planner's pick, or an earlier
  // --rename for the same token that was accepted.
  | { kind: "reserved"; from: string; to: string; reason: string; kept: string; keptFrom: "planner" | "override" };

export type ApplyOverridesResult = {
  plan: RenamePair[];
  outcomes: OverrideOutcome[];
};

// Parse a single `--rename From=To` value. Splits on the first `=` only;
// returns null for malformed input (missing flag value, empty side) so the
// caller can warn and skip rather than push a junk pair into the plan.
export function parseRenamePair(raw: string | undefined): RenamePair | null {
  if (raw === undefined) return null;
  const eq = raw.indexOf("=");
  if (eq <= 0) return null;
  const from = raw.slice(0, eq).trim();
  const to = raw.slice(eq + 1).trim();
  if (!from || !to) return null;
  return { from, to };
}

// Merge manual overrides onto the planner's rename plan. Semantics are
// "change a planned target": an override keys on the substrate token (`from`)
// and replaces the planner's chosen target (`to`). Overrides whose `from`
// matches no planned rename are reported as `unmatched` and dropped — we don't
// silently invent new renames. Overrides into a reserved word
// (src/reserved-words.ts) are reported as `reserved` and dropped, keeping the
// current target (the planner's pick or an earlier accepted override): the planner is told to avoid those words, and an override
// must not reintroduce a collision that breaks the build. Later overrides for
// the same `from` win.
export function applyRenameOverrides(
  plan: readonly RenamePair[],
  overrides: readonly RenamePair[],
): ApplyOverridesResult {
  const merged: RenamePair[] = plan.map((p) => ({ ...p }));
  const outcomes: OverrideOutcome[] = [];
  const overridden = new Set<string>();
  for (const override of overrides) {
    const target = merged.find((p) => p.from === override.from);
    if (!target) {
      outcomes.push({ kind: "unmatched", from: override.from, to: override.to });
      continue;
    }
    const reason = reservedReason(override.to);
    if (reason) {
      const keptFrom = overridden.has(override.from) ? "override" : "planner";
      outcomes.push({ kind: "reserved", from: override.from, to: override.to, reason, kept: target.to, keptFrom });
      continue;
    }
    if (target.to === override.to) {
      outcomes.push({ kind: "noop", from: override.from, to: override.to });
      continue;
    }
    outcomes.push({ kind: "changed", from: override.from, was: target.to, to: override.to });
    target.to = override.to;
    overridden.add(override.from);
  }
  return { plan: merged, outcomes };
}

export function describeKeptTarget(o: Extract<OverrideOutcome, { kind: "reserved" }>): string {
  return o.keptFrom === "override" ? `kept "${o.kept}" from an earlier --rename` : `kept the planner's pick "${o.kept}"`;
}

// The CLI line for one --rename outcome. renamable lists the plan's `from`
// tokens, shown when an override matched none of them.
export function describeRenameOverride(o: OverrideOutcome, renamable: readonly string[]): string {
  switch (o.kind) {
    case "changed": return `override: ${o.from} → ${o.to} (overrode planner's "${o.was}")`;
    case "noop": return `override: ${o.from} → ${o.to} (already the planner's pick)`;
    case "reserved": return `warning: --rename ${o.from}=${o.to} rejected: ${o.reason} — ${describeKeptTarget(o)}`;
    case "unmatched":
      return `warning: --rename ${o.from}=${o.to} matched no planned rename — skipped (renamable: ${renamable.join(", ") || "none"})`;
  }
}

// Keep entity names in step with rename-plan overrides. The planner names each
// entity after its rename target (e.g. it emits both `Shopkeeper -> Monitor`
// and an entity `Monitor` that `replaces` Shopkeeper), so a `--rename` that
// changes the target must also rename the entity or the report contradicts its
// own rename plan. Only entities whose name still matches the planner's old
// target are touched — an entity deliberately named differently is left alone.
export function syncEntityNames(
  entities: readonly Entity[],
  outcomes: readonly OverrideOutcome[],
): readonly Entity[] {
  const changes = new Map<string, { was: string; to: string }>();
  for (const o of outcomes) {
    if (o.kind === "changed") changes.set(o.from, { was: o.was, to: o.to });
  }
  if (changes.size === 0) return entities;
  return entities.map((e) => {
    const change = changes.get(e.replaces);
    return change && e.name === change.was ? { ...e, name: change.to } : e;
  });
}

// Merge `--rename-ja From=名前` onto the plan: sets the Japanese name of a
// planned rename (the planner's toJa, if any, is replaced). Like --rename, an
// override for a token the plan doesn't rename is reported and dropped.
export function applyJapaneseOverrides(
  plan: readonly RenamePair[],
  overrides: readonly RenamePair[],
): ApplyOverridesResult {
  const merged: RenamePair[] = plan.map((p) => ({ ...p }));
  const outcomes: OverrideOutcome[] = [];
  for (const override of overrides) {
    const target = merged.find((p) => p.from === override.from);
    if (!target) {
      outcomes.push({ kind: "unmatched", from: override.from, to: override.to });
      continue;
    }
    if (target.toJa === override.to) {
      outcomes.push({ kind: "noop", from: override.from, to: override.to });
      continue;
    }
    outcomes.push({ kind: "changed", from: override.from, was: target.toJa ?? "", to: override.to });
    target.toJa = override.to;
  }
  return { plan: merged, outcomes };
}
