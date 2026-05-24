---
name: generate-app
description: >-
  Generate a validated three-platform SaaS app — Rails 8.1 API + SwiftUI iOS +
  Jetpack Compose Android — from a one-sentence natural-language spec, then read
  the validation report and explain in plain language what passed and what
  failed. Use when the user wants to scaffold, generate, bootstrap, or create a
  new mobile or SaaS app from a description (e.g. "a walk-in queue for a
  barbershop", "a restaurant waitlist", "a task tracker").
---

# Generate a three-platform app and explain the result

You orchestrate the `nativeapptemplate-agent` generator end-to-end: run it on the
user's spec, then turn its machine-readable validation report into a clear
summary. You are the conversational layer over a one-shot CLI — narrate each
step, never just dump raw output.

## 1. Resolve the spec

The user's spec (and any flags) arrive in `$ARGUMENTS`. If empty, ask for a
one-sentence description of the app before doing anything else. Examples that
work well: "a walk-in queue for a barbershop", "a restaurant waitlist for casual
dining", "a personal task tracker with due dates". The generator is scoped to
the queue / booking / simple-CRUD SaaS family — if the spec is far outside that
(e.g. a multiplayer game, a video app), say so and offer the closest in-scope
shape rather than generating something that will fail validation.

Optional overrides the user may include, passed straight through to the CLI:
- `--project-name="Vet Clinic"` — fixes the display name + output slug.
- `--rename Shopkeeper=Vet` (repeatable) — overrides one of the planner's chosen
  renames. Only renames the planner *already planned* are overridable; an
  override that matches nothing is reported and dropped.

## 2. Set expectations before running

Tell the user, briefly, before you start:
- This makes real Anthropic API calls and takes ~3–5 minutes (longer with visual
  validation). It needs `ANTHROPIC_API_KEY` in the environment.
- Output lands in `./out/<slug>/{rails,ios,android}/` in the current directory,
  each an independent git-initialized project.
- Substrate selection comes from the environment (`NATIVEAPPTEMPLATE_API` /
  `_IOS` / `_ANDROID`); the defaults target the paid edition. Don't change these
  unless the user asks.

## 3. Run the generator

Prefer a local build when present, otherwise the published CLI:
- If you are inside the agent's own repo and `dist/index.js` exists (or
  `$NATIVEAPPTEMPLATE_AGENT_HOME` is set), run `node dist/index.js …`.
- Otherwise run `npx -y nativeapptemplate-agent …`.

Always pass `--report-format=both` (so `report.json` is written for parsing) and
`--exit-zero` (so a validation FAIL doesn't abort the command before you can
read and explain the report — you decide pass/fail from the report yourself).

Pass the spec as a **single quoted argument**, then append any flags. Example:

```bash
node dist/index.js "a walk-in queue for a barbershop" --report-format=both --exit-zero
# or, outside this repo:
npx -y nativeapptemplate-agent "a restaurant waitlist" --report-format=both --exit-zero
```

The run prints a `report: file://…/out/<slug>/validation-report.html` line on
completion. Note the `<slug>` — `report.json` sits next to that HTML file at
`out/<slug>/report.json`.

## 4. Read and interpret the report

Read `out/<slug>/report.json`. Its shape:

```jsonc
{
  "meta": { "spec", "slug", "displayName", "visualLevel" /* 0|1|2 */, "durationMs", ... },
  "overallPass": true,
  "summary": "one-line human summary",
  "platforms": [
    { "platform": "rails"|"ios"|"android",
      "layer1": { "pass": bool, "findings": [ /* leftover-token findings */ ] },
      "layer2": { "pass": bool, "command", "mode": "fast"|"build", "exitCode", "stderrTail"? },
      "layer3": { /* present only when visualLevel > 0 — vision-judge scores */ } }
  ],
  "reviewer": { "contractParity": "pass"|"fail", "diffs": [ /* OpenAPI mismatches */ ] },
  "domain": {
    "renamePlan": [ { "from": "Shop", "to": "…" }, … ],
    "entities":   [ { "name", "replaces", "fields", "states"? }, … ]
  },
  "repairAttempts": [ /* present only if the self-repair loop ran */ ]
}
```

Layers: **Layer 1** = structural (leftover domain tokens + OpenAPI parity),
**Layer 2** = runtime (Rails boots / iOS builds / Android builds; `mode: "build"`
means a full build was run), **Layer 3** = semantic vision judge (only when
`visualLevel > 0`).

## 5. Summarize for the user

Lead with the headline (`overallPass` + `summary` + total time from
`meta.durationMs`). Then a compact per-platform table — Layer 1 / Layer 2 (/
Layer 3 if present) as ✅/❌ for rails, ios, android — plus reviewer contract
parity. Then the domain mapping the planner chose (`domain.renamePlan`, e.g.
`Shop → Clinic`, `Shopkeeper → Vet`) and the entities. Finish with the path to
`validation-report.html` and offer to open it (`open <path>` on macOS).

## 6. On failure, be specific and offer the next move

Don't just say "it failed." Pull the exact evidence and propose a fix:
- **Layer 1 fail** → list `layer1.findings` (leftover substrate tokens). Often a
  rename the planner missed; suggest a targeted re-run with `--rename From=To`.
- **Layer 2 fail** → show `layer2.stderrTail` for the failing platform and name
  the likely cause (Jetpack Compose compile + Hilt DI are the known-cryptic ones
  — slow down there). Offer to opt into the self-repair loop by re-running with
  `NATIVEAPPTEMPLATE_REPAIR=on` (targets Layer 1/2, hard-capped at 5 iterations).
- **reviewer parity fail** → list `reviewer.diffs` (Rails ↔ iOS ↔ Android
  contract drift).
- For semantic checks, mention `NATIVEAPPTEMPLATE_VISUAL=1` (build + home-screen
  judge) or `=2` (full mobile-mcp walk-through) as opt-in deeper validation.

## 7. Hand off to the rest of the session

The generated projects are real, git-initialized, and buildable. Offer concrete
follow-ups: open the report, tweak generated code, commit a project, or re-run
with overrides. If the user wants to **see the app running** — capture the home
screen, walk the UI, screenshots inline — hand off to the `walk-app` skill
(`/nativeapptemplate-agent:walk-app <slug> ios|android`), which drives `mobile-mcp`
against a booted simulator/emulator.
