import type { RenamePair } from "./agents/types.js";

// Manual rename overrides (ROADMAP §"Optional explicit naming overrides").
// The planner is the sole source of the rename plan; these let a human veto a
// single noun choice without taking over the whole DomainSpec. Flag-based, not
// interactive — ROADMAP keeps the CLI scriptable and CI/MCP-safe (no TTY).

export type OverrideOutcome =
  | { kind: "changed"; from: string; was: string; to: string }
  | { kind: "noop"; from: string; to: string }
  | { kind: "unmatched"; from: string; to: string };

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
// silently invent new renames. Later overrides for the same `from` win.
export function applyRenameOverrides(
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
    if (target.to === override.to) {
      outcomes.push({ kind: "noop", from: override.from, to: override.to });
      continue;
    }
    outcomes.push({ kind: "changed", from: override.from, was: target.to, to: override.to });
    target.to = override.to;
  }
  return { plan: merged, outcomes };
}
