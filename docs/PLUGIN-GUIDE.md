# The Claude Code plugin — complete A-to-Z guide

This is the long-form, follow-top-to-bottom guide to the **`nativeapptemplate-agent`
Claude Code plugin**: what it is, how to install it, and how to use both of its
skills end-to-end — generating a validated three-platform app and then walking the
running app on a simulator/emulator.

If you just want the short reference card (manifest layout, MCP pins, one-line
install), see [`plugin/README.md`](../plugin/README.md). This document is the
tutorial; that one is the cheat sheet. For the agent's overall design, see
[`README.md`](../README.md) and [`docs/SPEC.md`](./SPEC.md).

---

## Contents

1. [What the plugin is](#1-what-the-plugin-is)
2. [The two skills at a glance](#2-the-two-skills-at-a-glance)
3. [Prerequisites](#3-prerequisites)
4. [Installing the plugin](#4-installing-the-plugin)
5. [Verifying the install](#5-verifying-the-install)
6. [Skill 1 — `generate-app`, end to end](#6-skill-1--generate-app-end-to-end)
7. [Skill 2 — `walk-app`, end to end](#7-skill-2--walk-app-end-to-end)
8. [A full session: generate, then walk](#8-a-full-session-generate-then-walk)
9. [Flags and environment variables — full reference](#9-flags-and-environment-variables--full-reference)
10. [Troubleshooting & FAQ](#10-troubleshooting--faq)
11. [See also](#11-see-also)

---

## 1. What the plugin is

The plugin drives the
[`nativeapptemplate-agent`](https://github.com/nativeapptemplate/nativeapptemplate-agent)
generator from **inside Claude Code**. You describe an app in one sentence; the
plugin generates a validated three-platform implementation — **Rails 8.1 API +
SwiftUI iOS + Jetpack Compose Android** — then reads the validation report back to
you in plain language. A second skill puts the generated app on a device and lets
you walk its UI conversationally.

It is one of three ways the same generator ships (the others are the standalone
`npx nativeapptemplate-agent` CLI and a raw MCP server for non-Claude-Code
assistants). The plugin is the most integrated surface: skills + bundled MCP
servers, no separate terminal.

What's inside the `plugin/` directory:

```
plugin/
├── .claude-plugin/plugin.json   # manifest (name, version, author)
├── .mcp.json                    # bundles the generator MCP server + mobile-mcp
├── skills/
│   ├── generate-app/SKILL.md    # generate → validate → explain
│   └── walk-app/SKILL.md        # launch on a device, walk the UI with mobile-mcp
└── README.md                    # the concise reference card
```

The `SKILL.md` files are the machine-facing source of truth — the exact
instructions Claude follows. This guide is the human-facing narration of the same
flow; if the two ever drift, the `SKILL.md` files win.

---

## 2. The two skills at a glance

| Skill | Invoke | What it does |
|---|---|---|
| **generate-app** | `/nativeapptemplate-agent:generate-app <spec>` | Runs the generator on your spec, parses `out/<slug>/report.json`, and summarizes per-platform / per-layer results, the domain mapping, and any failures with specific evidence and the next move. |
| **walk-app** | `/nativeapptemplate-agent:walk-app <slug> ios\|android` | Launches a generated app on a **booted** simulator/emulator and drives `mobile-mcp` to capture the home screen and walk the UI conversationally, surfacing screenshots inline. |

They compose: generate an app, then walk what you generated. `generate-app` is a
self-contained ~3–5 minute run; `walk-app` is interactive and depends on a live
device — it's the flakiest link in the chain, so [§7](#7-skill-2--walk-app-end-to-end)
is deliberately explicit about its prerequisites.

The plugin also bundles **two MCP servers** (visible via `/mcp`): the generator
server (`nativeapptemplate-agent`) and `mobile-mcp` for device automation.

---

## 3. Prerequisites

### Always required (for `generate-app`)

- **Node.js 22+** — the generator and both MCP servers run on Node. Check with
  `node -v`.
- **An Anthropic API key with access to `claude-opus-4-7`**, exported as
  `ANTHROPIC_API_KEY` (or the dedicated `NATIVEAPPTEMPLATE_AGENT_ANTHROPIC_KEY` —
  see [§9](#9-flags-and-environment-variables--full-reference)):
  ```bash
  export ANTHROPIC_API_KEY="sk-ant-..."
  ```
  Generation makes real API calls and costs real tokens. Set a spend cap on your
  workspace as a backstop.
- **Local checkouts of the three substrate repos**, referenced via environment
  variables. The plugin reads these from your environment and never changes them:
  ```bash
  export NATIVEAPPTEMPLATE_API="/path/to/nativeapptemplateapi"
  export NATIVEAPPTEMPLATE_IOS="/path/to/NativeAppTemplate-Free-iOS"
  export NATIVEAPPTEMPLATE_ANDROID="/path/to/NativeAppTemplate-Free-Android"
  ```
  The defaults target the paid edition; the env vars above point at the public
  free (MIT) edition repos — [`nativeapptemplateapi`](https://github.com/nativeapptemplate/nativeapptemplateapi),
  [`NativeAppTemplate-Free-iOS`](https://github.com/nativeapptemplate/NativeAppTemplate-Free-iOS),
  [`NativeAppTemplate-Free-Android`](https://github.com/nativeapptemplate/NativeAppTemplate-Free-Android) —
  for an OSS-reproducible run. Either works — the same pipeline handles both. A
  starter [`.env.example`](../.env.example) lists every variable in one place.

> **Tip — where to set these.** Claude Code inherits the environment of the shell
> it was launched from, so export the vars (or load a `.env`/`direnv`) **before**
> starting `claude`. If you change them mid-session, restart Claude Code so the
> MCP servers pick up the new values.

### Additionally required for `walk-app` (and for visual validation)

`walk-app` — and any `NATIVEAPPTEMPLATE_VISUAL=1/2` generate run — puts a real
app on a real device, so it needs the mobile toolchains booted and ready:

- **iOS:** Xcode 26.3+ with an **iPhone 17 Pro simulator on iOS 26.2+**, booted.
  mobile-mcp's iOS-simulator driver also needs **WebDriverAgent listening on
  `:8100`** — start it before walking (a `wda-up`-style helper is the convenient
  way; see [§7](#7-skill-2--walk-app-end-to-end)).
- **Android:** Android SDK with an **API 26+ emulator**, running. Boot it from
  **Android Studio's Device Manager** (Android Studio owns `adb` on a typical
  dev machine; starting the emulator from the CLI can leave `adb` unable to see
  it). No WebDriverAgent needed — mobile-mcp drives the emulator over `adb`.
- **Rails (only if you want live data past the welcome screen):** the generated
  Rails app must be **running** and the mobile app must be **pointed at it**. See
  [§7.4](#74-getting-live-data-rails--the-ios-host-passthrough).

You do **not** need any of the mobile toolchains for a plain `generate-app` run —
the default fast path type-checks/boots rather than doing full device builds.

---

## 4. Installing the plugin

There are two ways to install the plugin itself, plus a note on using the
generator without the plugin.

### Option A — From the marketplace (recommended)

The repo ships a marketplace manifest
([`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)) that
points at the `plugin/` directory. Add the marketplace, then install:

```
/plugin marketplace add nativeapptemplate/nativeapptemplate-agent
/plugin install nativeapptemplate-agent@nativeapptemplate
```

- `nativeapptemplate` is the **marketplace** name.
- `nativeapptemplate-agent` is the **plugin** name.

The CLI equivalents (outside an interactive session) are:

```bash
claude plugin marketplace add nativeapptemplate/nativeapptemplate-agent
claude plugin install nativeapptemplate-agent@nativeapptemplate
```

### Option B — Locally from the repo (for trying or developing it)

From the agent repo root, launch Claude Code with the plugin directory loaded —
no marketplace needed:

```bash
claude --plugin-dir ./plugin
```

This is the fastest path if you have the repo checked out and want to try or
modify the plugin. After editing any plugin file, run **`/reload-plugins`** to
pick up the change without restarting.

### Without the plugin (other assistants)

If you're not in Claude Code, the same generator is available as a standalone MCP
server you can wire into any MCP-capable assistant (Cursor, Cline, Goose, …):

```bash
npx -y -p nativeapptemplate-agent@latest nativeapptemplate-agent-mcp
```

It exposes a single `generate_app` tool. (The `-p` matters — the MCP entry point
is a *bin* of the `nativeapptemplate-agent` package, not its own package, so
`npx -y nativeapptemplate-agent-mcp` will 404.) `walk-app` is Claude-Code-only.

---

## 5. Verifying the install

Two quick checks confirm both halves loaded:

1. **Skills — `/help`.** You should see `nativeapptemplate-agent:generate-app`
   and `nativeapptemplate-agent:walk-app` listed.
2. **MCP servers — `/mcp`.** You should see two servers connected:
   - `nativeapptemplate-agent` — the generator, wired as
     `npx -y -p nativeapptemplate-agent@latest nativeapptemplate-agent-mcp`.
   - `mobile-mcp` — wired as `npx -y @mobilenext/mobile-mcp@0.0.54`.

Two pins in [`plugin/.mcp.json`](../plugin/.mcp.json) are load-bearing — if a run
fails at startup, check these first:

- **`nativeapptemplate-agent@latest`** — the `@latest` forces registry
  resolution. Without a version spec, when the MCP server is spawned with
  `cwd` = the agent's own repo root, `npx -p` resolves the *local* package
  instead of the published one and fails with `command not found`. `@latest`
  sidesteps that cwd shadowing.
- **`@mobilenext/mobile-mcp@0.0.54`** — pinned on purpose. `0.0.55+` closes the
  stdio connection on startup (`Connection closed` ~6s in), so `@latest` fails.
  This matches the agent's own pin in `src/mobile.ts`. If you have a *global*
  `mobile-mcp` config on `@latest`, it'll show ✘ failed in `/mcp` — this bundled,
  pinned copy is the working one (its command differs, so it won't dedup against
  your global).

---

## 6. Skill 1 — `generate-app`, end to end

### 6.1 Invoke it

```
/nativeapptemplate-agent:generate-app a walk-in queue for a barbershop
```

The spec is a plain one-sentence description. Specs that work well:

- `a walk-in queue for a barbershop`
- `a restaurant waitlist for casual dining`
- `a personal task tracker with due dates`

The generator is scoped to the **queue / booking / simple-CRUD SaaS family**. If
you ask for something far outside that (a multiplayer game, a video app), the
skill will say so and offer the closest in-scope shape rather than generating
something that fails validation.

If you invoke the skill with no spec, it will ask you for a one-sentence
description before doing anything.

### 6.2 Optional overrides

You can pass these inline; they're forwarded straight to the generator:

| Override | Example | Effect |
|---|---|---|
| Project name | `--project-name="Vet Clinic"` | Fixes the display name **and** the output slug, independent of the domain rename. You can also say it in plain language — *"…for household pest detection. project name is Sentova."* — and the skill maps it to the same argument. |
| Rename override | `--rename Shopkeeper=Vet` (repeatable) | Overrides one of the planner's chosen renames. `From` must be a substrate token (`Shop`, `Shopkeeper`, `ItemTag`). Only renames the planner *already planned* are overridable; an override that matches nothing is reported and dropped. |

Example with both:

```
/nativeapptemplate-agent:generate-app a walk-in clinic queue --project-name="Vet Clinic" --rename Shopkeeper=Vet
```

### 6.3 What happens during the run

Before it starts, the skill sets expectations: the run makes real Anthropic API
calls and takes **~3–5 minutes** (longer with visual validation), output lands in
`./out/<slug>/{rails,ios,android}/` in the current directory (each an independent
git-initialized project), and substrate selection comes from your environment.

Under the hood the generator parses the spec into a domain, copies the substrate,
renames the skeleton coherently across all three platforms, adapts or replaces the
domain module, drives the build, and validates. On completion it prints a line
like:

```
report: file://…/out/<slug>/validation-report.html
```

Note the `<slug>` — `report.json` sits next to that HTML at `out/<slug>/report.json`.

### 6.4 Reading the report back

The skill reads `out/<slug>/report.json` and narrates it. Its shape:

```jsonc
{
  "meta": { "spec", "slug", "displayName", "visualLevel" /* 0|1|2 */, "durationMs", … },
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

The validation layers:

- **Layer 1 — structural.** Leftover domain tokens (ripgrep) + OpenAPI contract
  parity across Rails ↔ iOS ↔ Android.
- **Layer 2 — runtime.** Rails boots / iOS builds / Android builds. `mode: "build"`
  means a full build was run (visual mode); `mode: "fast"` is the default
  type-check/boot path.
- **Layer 3 — semantic.** Opus 4.7 vision judge scoring the rendered UI against a
  rubric. Present **only** when `visualLevel > 0`.

The skill leads with the headline (`overallPass` + `summary` + total time), then a
compact per-platform ✅/❌ table, then the domain mapping the planner chose
(`Shop → Clinic`, `Shopkeeper → Vet`, …) and the entities, and finishes with the
path to `validation-report.html` (and offers to `open` it on macOS).

### 6.5 When something fails

The skill pulls the **exact evidence** and proposes a next move rather than just
saying "it failed":

- **Layer 1 fail** → lists `layer1.findings` (leftover substrate tokens). Usually
  a rename the planner missed; the fix is a targeted re-run with `--rename From=To`.
- **Layer 2 fail** → shows `layer2.stderrTail` for the failing platform. Jetpack
  Compose compile + Hilt DI are the known-cryptic ones. Offer of opting into the
  self-repair loop by re-running with `NATIVEAPPTEMPLATE_REPAIR=on`.
- **Reviewer parity fail** → lists `reviewer.diffs` (Rails ↔ iOS ↔ Android
  contract drift).
- For semantic depth, it mentions `NATIVEAPPTEMPLATE_VISUAL=1` (build +
  home-screen judge) or `=2` (full mobile-mcp walk-through).

### 6.6 After a successful generation

The generated projects are real, git-initialized, and buildable. Natural
follow-ups: open the report, tweak generated code, commit a project, re-run with
overrides — or **see the app running**, which hands off to `walk-app`.

---

## 7. Skill 2 — `walk-app`, end to end

`walk-app` is the interactive companion to `generate-app`: it puts a generated app
**on screen** and lets you explore it — capture the current screen, list its
elements, tap through a flow, screenshots inline. It depends on `mobile-mcp`
(bundled) plus a real booted device and an installed build. Those parts are
environment-dependent and the flakiest link, so the skill is explicit about what's
required.

### 7.1 Invoke it

```
/nativeapptemplate-agent:walk-app barbershop-queue ios
```

- **Project (slug):** the first argument, e.g. `barbershop-queue`. If omitted, the
  skill uses the most recently modified directory under `./out/`. It confirms
  `out/<slug>/` exists.
- **Platform:** `ios` or `android`. If unspecified, the skill asks — the two need
  different devices and only one can be driven at a time.

### 7.2 Get the app onto a device (the heavy prerequisite)

mobile-mcp drives an app that is already **installed and running** on a **booted**
device. Two routes:

**Recommended — let the generator build + install it.** A
`NATIVEAPPTEMPLATE_VISUAL=1` (home-screen build) or `=2` (full scripted walk)
generate run does the full build → install → launch on both platforms and is the
tested path. After it finishes, the app is installed and launched on the booted
device, and you can pick up `walk-app` for interactive exploration:

```
/nativeapptemplate-agent:generate-app a walk-in queue for a barbershop
# re-run with NATIVEAPPTEMPLATE_VISUAL=1 set in the environment, then:
/nativeapptemplate-agent:walk-app barbershop-queue ios
```

**Manual — build it yourself** from `out/<slug>/`:

- **iOS:** the scheme is the project's PascalCase name (run `xcodebuild -list` in
  `out/<slug>/ios/` to confirm). Build for the iPhone 17 Pro simulator, then
  install/launch on the booted sim:
  ```bash
  xcodebuild -scheme <Pascal> -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.2' build
  ```
- **Android:** from `out/<slug>/android/`:
  ```bash
  ./gradlew assembleDebug && ./gradlew installDebug
  ```

### 7.3 Device readiness

- **iOS:** ensure a simulator is booted:
  ```bash
  xcrun simctl list devices | grep Booted   # boot iPhone 17 Pro + `open -a Simulator` if none
  ```
  mobile-mcp's iOS-sim driver **also** needs **WebDriverAgent running on `:8100`**
  — start it first (a `wda-up`-style helper is the convenient way on a dev
  machine).
- **Android:** ensure an emulator is running, booted from **Android Studio's
  Device Manager** (not the CLI `emulator -avd`, which can leave `adb` blind to
  it). Confirm with `adb devices`.

### 7.4 Getting live data: Rails + the iOS host passthrough

If you only want to see the welcome/sign-up screens, the steps above are enough.
To get **past the welcome screen into real data**, two things must both be true —
Rails must be **running** and the app must be **pointed at it**.

**Rails up.** From `out/<slug>/rails/` (after `bundle install` +
`bin/rails db:prepare` + `bin/rails db:seed_fu`):

```bash
mise exec -- bin/dev
```

It binds to the `HOST` in `out/<slug>/rails/.env` (a LAN/Wi-Fi IP, not
`localhost`). The seeded login for these specs is
`barber1@example.com` / `password` (renamed per spec).

**App → that Rails.** This is where the platforms differ:

- **Android** bakes the API host in at build time (`<PRODUCT>_API_*` gradle
  properties), so a normal launch reaches it. Nothing extra to do.
- **iOS does not.** The DEBUG build reads its host from the process environment at
  launch and otherwise falls back to the nonexistent `https://api.<product>.com`.
  A plain `mobile-mcp` launch will render screens but **every network call
  silently fails**. To reach a local Rails on iOS, relaunch the app via `simctl`
  with the `SIMCTL_CHILD_` passthrough (the same env-bridge the generator's visual
  mode uses — see `src/env-bridge.ts`):

  ```bash
  xcrun simctl terminate booted <bundleId>
  SIMCTL_CHILD_<PRODUCT>_API_SCHEME=http \
  SIMCTL_CHILD_<PRODUCT>_API_DOMAIN=<HOST from out/<slug>/rails/.env> \
  SIMCTL_CHILD_<PRODUCT>_API_PORT=<PORT from out/<slug>/rails/.env> \
  xcrun simctl launch booted <bundleId>
  ```

  `<PRODUCT>` is the PascalCase project name **upper-cased** (e.g.
  `BARBERSHOPQUEUE`); `SCHEME` is `http` for LAN dev. mobile-mcp still drives the
  app via WDA regardless of how it was launched, so do this relaunch **before** you
  tap into data-backed screens.

### 7.5 Connect, capture, and walk

The skill uses mobile-mcp to list available devices, select the booted
simulator/emulator, list installed apps, and launch the generated one (matching on
the display / PascalCase name — launching by name avoids hunting for the bundle
id / package name). Then it:

1. Takes a screenshot of the current screen and **surfaces it inline**.
2. Lists on-screen elements (mobile-mcp prefers the accessibility tree — more
   reliable than coordinate taps) so you can both see what's actionable.
3. Describes the screen in **domain terms** (the renamed entities — "Barbershop
   list", "Add Ticket" — not substrate tokens).

Then it offers to walk a short flow. The sensible default mirrors the validated
scenario: **Welcome → Sign Up → Sign In → drill into the seeded sample**, taking a
fresh screenshot after each meaningful step and confirming before any destructive
action.

This is exploratory, not a fixed script. After the home-screen capture, you drive:
*"tap Sign Up"*, *"go back"*, *"what's on this screen?"* — the skill runs
mobile-mcp per request and returns a screenshot each time. That conversational
loop is the whole reason the skill exists.

---

## 8. A full session: generate, then walk

A complete session, including a **custom project name passed in plain language**:

```
/nativeapptemplate-agent:generate-app a two-device home monitor for household pest detection. project name is Sentova.
/nativeapptemplate-agent:walk-app sentova ios
/nativeapptemplate-agent:walk-app sentova android
```

The `project name is Sentova` clause sets the display name and output slug
(`out/sentova/`, `Sentova.xcodeproj`, `Sentova API`) independently of the domain
rename the planner chooses. That spec is an **adapt** of the queue toggle — it
keeps `ItemTag` and renames it (one run produced `Shop → Household`,
`Shopkeeper → Resident`, `ItemTag → Sighting`, states `Idled → Active` /
`Completed → Resolved`); the planner's exact targets vary run to run, so don't
hard-code them.

The barbershop walk-in-queue spec is the canonical demo:

```
/nativeapptemplate-agent:generate-app a walk-in queue for a barbershop
/nativeapptemplate-agent:walk-app barbershop-queue ios
```

---

## 9. Flags and environment variables — full reference

### CLI flags (passed through `generate-app`)

| Flag | Default | Effect |
|---|---|---|
| `--project-name="Vet Clinic"` | planner's pick | Names the project. Accepts a human name (`"Vet Clinic"`), PascalCase (`VetClinic`), or kebab (`vet-clinic`); derives the Pascal project name, slug/output dir (`out/vet-clinic/`), DB prefix + env-bridge token, and display name. Invalid (no derivable slug) is reported and skipped. |
| `--rename From=To` | planner's pick | Overrides one planner rename target (repeatable). `From` is a substrate token (`Shop`, `Shopkeeper`, `ItemTag`). An override matching no planned rename is reported and skipped. |
| `--report-format=html\|json\|both` | `both` | Which report artifact(s) to write. The skill always uses `both` so `report.json` exists to parse. |
| `--report-embed=true\|false` | `true` | Embed screenshots as `data:` URIs (one portable HTML file) vs. copy to `report-assets/`. |
| `--report-open` | — | Open the HTML in your browser when the run finishes (macOS). |
| `--no-report` | — | Skip writing the report entirely. |
| `--exit-zero` | — | Always exit 0, even on validation FAIL. The skill uses this so a FAIL doesn't abort before it can read and explain the report. |

### Environment variables

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic key (needs `claude-opus-4-7`). The only sensitive secret the agent requires. |
| `NATIVEAPPTEMPLATE_AGENT_ANTHROPIC_KEY` | Optional dedicated workspace key; preferred over `ANTHROPIC_API_KEY` when set, so a runaway loop hits the workspace cap instead of your tier limit. |
| `NATIVEAPPTEMPLATE_API` / `_IOS` / `_ANDROID` | Paths to the three substrate repos. Defaults target the paid edition; point at the free repos for an OSS-reproducible run. |
| `NATIVEAPPTEMPLATE_VISUAL=1` | Stage-1 visual judging: Layer 2 runs in **build mode** (full `xcodebuild build` + `./gradlew assembleDebug`), installs on the booted sim/emulator, captures the home screen, and judges it with Opus 4.7 vision. Requires a sim/emulator booted per platform. Adds ~60–180s per platform. |
| `NATIVEAPPTEMPLATE_VISUAL=2` | Implies `=1` and additionally runs **Stage 2**: boots the generated Rails app, drives a scripted CRUD walk-through via `mobile-mcp` (Sign Up → email-confirm → Sign In → drill into seeded sample), then judges the post-walk screenshot. Requires both sims/emulators booted + the substrate's `mise` toolchain. Adds 2–4 min/platform. |
| `NATIVEAPPTEMPLATE_REPAIR` | Opts into the bounded self-repair loop. `on` (or a positive integer N, hard-capped at 5). On a code-repairable failure (Layer 1 leftover tokens or Layer 2 build errors) the agent runs a repair pass scoped to the failing project and re-validates, up to the cap. Layer 3 + reviewer misses are surfaced, not auto-repaired. Off by default. |
| `NATIVEAPPTEMPLATE_BRIDGE=off` | Skip writing `<PRODUCT>_API_*` into `~/.gradle/gradle.properties` (process.env injection still runs for child-spawn paths). |
| `NATIVEAPPTEMPLATE_BRIDGE_DRY_RUN=1` | Log what *would* be written to `~/.gradle/gradle.properties` instead of writing it. |
| `ANDROID_SERIAL` | When more than one Android device/emulator is attached, set this to the target serial (`adb devices` lists them). Visual runs with multiple Android targets error with `more than one device/emulator` without it. |

> The agent strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and
> `NATIVEAPPTEMPLATE_AGENT_ANTHROPIC_KEY` from the environment of every
> subprocess it spawns — only the Anthropic SDK in the Node process sees the key.

---

## 10. Troubleshooting & FAQ

**`/mcp` shows the generator server failed.**
Almost always the `@latest` pin. Confirm
[`plugin/.mcp.json`](../plugin/.mcp.json) wires the generator as
`npx -y -p nativeapptemplate-agent@latest nativeapptemplate-agent-mcp`. Without
`@latest`, when the server spawns with `cwd` = the agent repo root, `npx -p`
resolves the *local* package and fails with `command not found`.

**`/mcp` shows `mobile-mcp` failed (`Connection closed` ~6s in).**
You're on `0.0.55+`. Pin to `@mobilenext/mobile-mcp@0.0.54`. If you also have a
*global* mobile-mcp on `@latest`, it'll show ✘ — that's expected; the bundled
pinned copy is the working one.

**The skills don't appear in `/help`.**
If you loaded locally, you launched without the plugin dir — start with
`claude --plugin-dir ./plugin`, or install from the marketplace ([§4](#4-installing-the-plugin)).
After editing plugin files, run `/reload-plugins`.

**Generation fails immediately on substrate paths.**
`NATIVEAPPTEMPLATE_API` / `_IOS` / `_ANDROID` aren't set or don't point at valid
checkouts. Set them **before** launching Claude Code (it inherits the launching
shell's env); restart if you changed them mid-session. See [`.env.example`](../.env.example).

**`walk-app`: "no device" / mobile-mcp finds nothing.**
The sim/emulator isn't booted, or (Android) Studio isn't running and `adb` sees
no device. Boot it per [§7.3](#73-device-readiness).

**`walk-app`: "app not installed."**
The build/install step didn't run or failed. Easiest fix is the recommended
`NATIVEAPPTEMPLATE_VISUAL=1` route ([§7.2](#72-get-the-app-onto-a-device-the-heavy-prerequisite)),
which builds + installs + launches for you.

**`walk-app`: app launches but data screens are blank / sign-in fails / lists empty.**
Rails isn't running, or the app isn't pointed at it. Start Rails
([§7.4](#74-getting-live-data-rails--the-ios-host-passthrough)); on **iOS**,
confirm you relaunched with the `SIMCTL_CHILD_<PRODUCT>_API_*` passthrough — a
plain mobile-mcp launch hits the nonexistent default host, so every call fails
while screens still render.

**`walk-app`: build fails (iOS/Android).**
Surface the compiler output; Jetpack Compose + Hilt are the known-cryptic ones.
Offer a repair re-run of `generate-app` with `NATIVEAPPTEMPLATE_REPAIR=on`.

**How long does a run take / how much does it cost?**
A plain `generate-app` run is ~3–5 minutes of real Anthropic API calls;
`NATIVEAPPTEMPLATE_VISUAL=1/2` adds device build + walk time. Set a workspace
spend cap as a backstop.

**Where does output go?**
`./out/<slug>/{rails,ios,android}/` in the current working directory, plus
`out/<slug>/report.json` and `out/<slug>/validation-report.html`. Each platform
dir is an independent, buildable, git-initialized project.

**Can I use the generator outside Claude Code?**
Yes — the standalone CLI (`npx nativeapptemplate-agent "<spec>"`) and the MCP
server ([§4](#4-installing-the-plugin)). `walk-app` is Claude-Code-only.

---

## 11. See also

- [`plugin/README.md`](../plugin/README.md) — the concise plugin reference card.
- [`plugin/skills/generate-app/SKILL.md`](../plugin/skills/generate-app/SKILL.md)
  and [`plugin/skills/walk-app/SKILL.md`](../plugin/skills/walk-app/SKILL.md) —
  the machine-facing skill definitions (source of truth).
- [`README.md`](../README.md) — the agent overall: CLI, MCP, validation, security.
- [`docs/SPEC.md`](./SPEC.md) — full technical specification.
- [`docs/validation-report.md`](./validation-report.md) — the report schema.
- [`ROADMAP.md`](../ROADMAP.md) — where the project is headed.
