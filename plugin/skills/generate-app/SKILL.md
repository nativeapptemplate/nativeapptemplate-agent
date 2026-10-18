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
  override that matches nothing is reported and dropped, and so is one whose
  target is a reserved name — the substrate's own (Owner, Account, User…), its
  subscription layer's (Subscription, Paywall, Plan, Purchase, Product, Store,
  Customer…), its error monitoring layer's (Sentry, ErrorReporter, Event…) or a
  Swift/Kotlin/Ruby stdlib type (Task, List, Result…). If the
  user asks for one, suggest a nearby noun instead.
- `--domain=orangebaton.app` — the app's web domain. It replaces the template's
  `nativeapptemplate.com` (subdomains and email addresses included) and, reversed,
  sets the iOS bundle ID (`app.orangebaton.OrangeBaton.ios`) and the Android
  applicationId / package (`app.orangebaton.orangebaton`). Without it the app gets
  `<project name>.com` and `com.<project name>…`. Mention it when the user plans
  to ship: neither ID can change after the first store release.
- `--rename-ja Shop=動物病院` (repeatable) — the Japanese noun that replaces 店舗
  (Shop) or アイテムタグ (ItemTag) in the Rails API's Japanese messages. Use it
  when the user wants a specific Japanese name; otherwise the planner picks one.
- `--visual=0|1|2` — how much of the UI to validate on this run (overrides
  `NATIVEAPPTEMPLATE_VISUAL`; without the flag the environment decides, default
  `0`). `1` builds both apps and has the vision model judge their home screens on
  the booted iOS simulator and Android emulator; `2` also boots the generated
  Rails API and walks sign-up / sign-in through both apps.
- `--tests` — also run the generated apps' own test suites (`bin/rails test`,
  `xcodebuild test`, `./gradlew testDebugUnitTest`); overrides
  `NATIVEAPPTEMPLATE_TESTS` (`--no-tests` turns them off when it is set).

The user may say these in plain language; map them to the flags:
- "project name is Vet Clinic" → `--project-name="Vet Clinic"`
- "domain is vetclinic.app" (or "use the domain vetclinic.app") →
  `--domain=vetclinic.app`. Pass what they wrote; the CLI lowercases it and
  checks it. If it isn't a domain with at least two labels (e.g. just
  `vetclinic`, a URL with `https://` or a path, an email address, a label
  starting with a digit), the CLI exits with `error: --domain "…" …` before
  generating anything: relay that message and ask for a bare domain such as
  `vetclinic.app`.
- "visual 2", "visual validation", "check the UI too", "walk through the app",
  "画面も確認して" → `--visual=2`. "visual 1", "just check the home screen" →
  `--visual=1`. "visual 0", "skip the UI check", "quick run" → `--visual=0`.
- "run the tests", "with tests", "テストも回して" → `--tests`.

## 2. Set expectations before running

Tell the user, briefly, before you start:
- This makes real Anthropic API calls and needs `ANTHROPIC_API_KEY` in the
  environment. Time and cost by visual level (README "Runtime"; measured on an M1
  Max with the devices pre-booted): `0` ~2–3 min, ~$0.02; `1` ~2.5 min (full
  builds), ~$0.13; `2` ~7–8 min, ~$0.22. Cold builds add a minute or two; `--tests`
  adds several minutes per platform.
- Prerequisites for the level you're running — say them before you start, and
  for `--visual=1`/`2` ask the user to confirm they're ready: `1` and `2` need a
  **booted iOS simulator** (Xcode; the build targets iPhone 17 Pro / iOS 26.2
  unless `NATIVEAPPTEMPLATE_IOS_DESTINATION` says otherwise) **and a running
  Android emulator** (or attached device); `2` also needs **`mise`** with the
  template's Ruby (it boots the generated Rails API) and WebDriverAgent for the iOS
  walk. `--tests` needs the same simulator for `xcodebuild test`.
- With `--visual=1`/`2` the CLI checks the devices (and `mise`) first and, if one
  is missing, exits 2 with `error: visual level N needs a few things that aren't
  ready:` and a list, before generating anything or making an API call. Relay the
  list and offer to retry once the user has booted the device, or to run at a
  lower level.
- Output lands in `./out/<slug>/{rails,ios,android}/` in the current directory,
  each an independent git-initialized project.
- Substrate selection comes from the environment (`NATIVEAPPTEMPLATE_API` /
  `_IOS` / `_ANDROID`). All three are required — there is no default; if one is
  unset, the run fails immediately. Don't change them unless the user asks.
- With the paid templates, the generated apps include RevenueCat subscriptions,
  switched off until the user sets their own RevenueCat key; the generated iOS
  project resolves `purchases-ios` via Swift Package Manager, so its first build
  needs network access.
- The generated apps also include Sentry error monitoring, off until the user
  sets their own DSN; nothing is sent and no dSYM / mapping is uploaded before
  that.

## 3. Run the generator

Prefer a local build when present, otherwise the published CLI:
- If you are inside the agent's own repo and `dist/index.js` exists, run
  `node dist/index.js …`.
- Otherwise run `npx -y nativeapptemplate-agent …`.

Always pass `--report-format=both` (so `report.json` is written for parsing) and
`--exit-zero` (so a validation FAIL doesn't abort the command before you can
read and explain the report — you decide pass/fail from the report yourself).

Pass the spec as a **single quoted argument**, then append any flags. Example:

```bash
node dist/index.js "a walk-in queue for a barbershop" --report-format=both --exit-zero
# or, outside this repo:
npx -y nativeapptemplate-agent "a restaurant waitlist" --report-format=both --exit-zero
# "…, check the UI too and run the tests":
npx -y nativeapptemplate-agent "a restaurant waitlist" --visual=2 --tests --report-format=both --exit-zero
```

The run prints a `report: file://…/out/<slug>/validation-report.html` line on
completion. Note the `<slug>` — `report.json` sits next to that HTML file at
`out/<slug>/report.json`.

## 4. Read and interpret the report

Read `out/<slug>/report.json`. Its shape:

```jsonc
{
  "meta": { "spec", "slug", "displayName", "visualLevel" /* 0|1|2 */, "durationMs", ...,
            "appDomain": { "domain", "custom" /* --domain given */, "bundleIdPrefix", "androidPackagePrefix",
                           "androidRemapped"? /* labels written differently in the Android package */,
                           "iosBundleId"?, "androidApplicationId"? } },
  "overallPass": true,       // nothing failed (drives the exit code)
  "verdict": "pass"|"partial"|"fail", // "partial" = nothing failed, but Layer 3 didn't judge every mobile UI (e.g. visualLevel 0)
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

Layers: **Layer 1** = structural (leftover domain tokens; OpenAPI parity is the
separate `reviewer` result),
**Layer 2** = runtime (Rails boots / iOS builds / Android builds; `mode: "build"`
means a full build was run), **Layer 3** = semantic vision judge (only when
`visualLevel > 0`).

## 5. Summarize for the user

Lead with the headline (`verdict` + `summary` + total time from
`meta.durationMs`). Say PARTIAL plainly when `verdict` is `"partial"`: Layer 1/2
and the reviewer passed, but the UI was not judged (Layer 3 didn't run) — offer a
re-run with `--visual=1` (or `--visual=2` for the full walk) for a full verdict. Then a compact per-platform table — Layer 1 / Layer 2 (/
Layer 3 if present) as ✅/❌ for rails, ios, android — plus reviewer contract
parity. Then the app's domain and store IDs (`meta.appDomain`: domain, iOS
bundle ID, Android applicationId) — if `androidRemapped` is present, say which
labels the Android package spells differently (e.g. `orange-baton` →
`orange_baton`) and why (not a valid Java/Kotlin package segment). Then the domain mapping the planner chose (`domain.renamePlan`, e.g.
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
- **test suite fail** (only with `--tests` / `NATIVEAPPTEMPLATE_TESTS=1`) → show
  `tests.summary` and `tests.outputTail` for the failing platform.
- **formatter issues left** (`format.status: "fail"`, reported, not gated) →
  show `format.outputTail`; the rename shifted alignment or import order in a
  way the autocorrect couldn't fix.
- For semantic checks, offer a re-run with `--visual=1` (build + home-screen
  judge) or `--visual=2` (full mobile-mcp walk-through), with the time and
  prerequisites from step 2.
- The apps' own test suites don't run by default; offer a re-run with `--tests`
  (`bin/rails test`, `xcodebuild test`, `./gradlew testDebugUnitTest`) when the
  user wants them.

## 7. Hand off to the rest of the session

The generated projects are real, git-initialized, and buildable. Offer concrete
follow-ups: open the report, tweak generated code, commit a project, or re-run
with overrides. If the user wants to **see the app running** — capture the home
screen, walk the UI, screenshots inline — hand off to the `walk-app` skill
(`/nativeapptemplate-agent:walk-app <slug> ios|android`), which drives `mobile-mcp`
against a booted simulator/emulator.
