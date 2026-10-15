// Single source of truth for the Claude models and request settings the agent
// uses. A model bump is a one-line change to OPUS_MODEL.

export const OPUS_MODEL = "claude-opus-5-5";

export const PLANNER_MODEL = OPUS_MODEL;
export const JUDGE_MODEL = OPUS_MODEL;
export const REPAIR_MODEL = OPUS_MODEL;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// Claude Opus 5.5 always thinks (thinking can't be disabled) and defaults to
// effort "medium", so every role sets its effort explicitly.
//
// - Planner: one call per run whose output drives every rename, and that
//   has to respect long reserved-vocabulary lists. Cheap in absolute terms,
//   so it gets "high".
// - Judge: many calls per run (3 samples x rubric criteria x platforms), each
//   a Yes/No read of one screenshot, which Opus 5.5 does well at lower effort.
//   "medium" keeps the per-run cost down.
// - Repair: an agentic edit/build loop on cryptic compiler errors (Compose,
//   Hilt), where effort pays off. It only runs on failures, so "high".
export const PLANNER_EFFORT: Effort = "high";
export const JUDGE_EFFORT: Effort = "medium";
export const REPAIR_EFFORT: Effort = "high";

// Server-side refusal fallback: if Opus 5.5's safety classifiers decline a
// request, the API re-runs it on the model Anthropic recommends for that
// refusal category, inside the same call. The "default" form needs exactly
// this beta header (the array form uses server-side-fallback-2026-06-01).
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const FALLBACKS = "default" as const;
