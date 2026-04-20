# CLAUDE.md

Project-wide Claude Code instructions. Keep this file short — it's loaded into context every session. For deep context, read the linked docs on demand.

## What this project is

`nativeapptemplate-agent` — a Claude Code agent that turns a natural-language SaaS spec (e.g. "a walk-in queue for a barbershop") into a working three-platform implementation: Rails 8.1 API + native SwiftUI iOS + native Jetpack Compose Android. Built during the Built with Opus 4.7 Claude Code Hackathon, April 21–27, 2026.

**Read `docs/SPEC.md` before making non-trivial changes.** It's the source of truth for architecture, three-layer validation, operation paths (adapt vs. replace), and hackathon success criteria.

## Model

- Use `claude-opus-4-7` for all agent invocations.
- Requires Claude Agent SDK `>= 0.2.111`.
- Do not set `thinking.type.enabled` — use `thinking: {type: "adaptive"}` instead (Opus 4.7 uses adaptive thinking).

## Stack

- **Host language:** TypeScript (Claude Agent SDK `@anthropic-ai/claude-agent-sdk`)
- **Ruby subprocesses** for Rails AST / ERB / migration work (called from TypeScript)
- **External MCP:** [`mobile-next/mobile-mcp`](https://github.com/mobile-next/mobile-mcp) for iOS Simulator + Android Emulator UI automation (`npx -y @mobilenext/mobile-mcp@latest`)
- **Node 22+ required.**

## Coding conventions

- TypeScript `strict: true`; no implicit `any`.
- Prefer functions over classes — introduce a class only when state + lifecycle justify it (e.g. a long-lived MCP client wrapper). Stateless transforms are functions.
- Ruby subprocesses: shell out via `execFile("ruby", ["scripts/ruby/<script>.rb", ...])` from a thin wrapper in `src/ruby.ts`. Pass structured data as JSON on stdin/stdout, not positional CLI args. Each script must be self-contained and re-entrant.
- No comments explaining *what* the code does — name things well instead. Reserve comments for non-obvious *why*.

## Substrate (what the agent operates on)

MIT-licensed free edition only — never reach into the paid repos. The three substrate repos can live anywhere on the developer's machine; point the agent at them via environment variables:

- `$NATEMPLATE_API` — Rails 8.1 API repo (`nativeapptemplateapi`, Ruby 7,687 LOC)
- `$NATEMPLATE_IOS` — SwiftUI iOS repo (`NativeAppTemplate-Free-iOS`, Swift 15,311 LOC, iOS 26.2+)
- `$NATEMPLATE_ANDROID` — Jetpack Compose Android repo (`NativeAppTemplate-Free-Android`, Kotlin 19,521 LOC, API 26+)

Combined ~42.5k LOC of application code. Shared JSON:API contract between all three.

**Substrate repos are read-only from the agent's perspective.** The agent never commits, pushes, edits, or runs destructive commands inside the substrate directories. To customize, the agent copies the substrate into `./out/<spec-slug>/{rails,ios,android}/` as fresh git-initialized project directories, and works exclusively inside `./out/` thereafter. Treat the substrate paths the same way you'd treat a read-only mount.

## Domain model (do not misread)

- `Shop` → per-tenant primary resource (not "store", not "shop" in e-commerce sense — a physical location with a walk-in queue)
- `Shopkeeper` → the authenticated user/owner of a Shop
- `ItemTag` (aka Number Tag) → a queue entry, attached to a Shop
- **ItemTag has TWO states: `Idled` ↔ `Completed`.** It's a toggle, not a three-state machine. If a user's spec wants three states (e.g. "in-service"), extend the machine rather than assume it.
- Free edition is single-organization (personal account is transparent). Paid-edition features (multi-tenancy, invitations, roles, org switching) are out of scope for the hackathon.

## Repository state

Pre-implementation as of this writing: `src/` and `scripts/ruby/` are empty, and there is no `package.json`. The npm commands below are the target interface — don't try to run them until the scaffolding lands. Check `src/` before assuming.

## Commands

```bash
# Build & test the agent (run from this repo root — once package.json exists)
npm run build
npm run test
npm run dev -- "your spec here"

# Substrate commands — run from the matching generated project dir in ./out/<slug>/
bin/dev                                        # Rails API
xcodebuild -scheme NativeAppTemplate -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.2' build   # iOS
./gradlew assembleDebug && ./gradlew installDebug                                                          # Android

# Validation (run from this repo root)
rg -n "Shop|Shopkeeper|ItemTag" ./out/<slug>/    # Layer 1 rename completeness check
cloc --vcs=git "$NATEMPLATE_API"                  # LOC measurement for a specific substrate repo

# mobile-mcp — invoked via natural language through Claude Code
# "Take a screenshot", "Tap on Sign Up", "List elements on screen", etc.
```

## Operations the agent performs

Three clean operations on the substrate (details in `docs/SPEC.md` section 4):

1. **Rename the skeleton** — Shop → Clinic, Shopkeeper → Staff, propagated coherently across Rails + Swift + Kotlin.
2. **Adapt or replace the domain module** — keep ItemTag for queue variants; strip and insert a new resource for non-queue SaaS.
3. **Drive the build green** — Rails tests + xcodebuild + gradlew must all pass.

## Validation (three layers, gated)

1. **Structural** — ripgrep for leftover domain tokens + OpenAPI contract parity (Rails ↔ iOS ↔ Android).
2. **Runtime** — Rails boots, iOS builds & launches, Android builds & launches (Stage 1); UI-driven CRUD scenario via mobile-mcp (Stage 2).
3. **Semantic** — Opus 4.7 as judge (text + vision) scoring against a structured rubric. Three runs per screenshot, take the median.

## Guardrails

- **Self-repair loop hard-capped at 5 iterations** per generated project. On exceed, surface residuals and exit.
- Known-cryptic failure modes: Jetpack Compose compilation, Hilt DI. Slow down and verify rather than pattern-match on those.
- **Do not invent tests for the generated code.** The substrate already has tests; use them.
- **Never modify the substrate repos** — clone them fresh into `./out/<slug>/{rails,ios,android}` before editing.
- Token budget: keep per-sub-agent context under 500k tokens to leave headroom for self-repair loops.

## Output layout

```
./out/<spec-slug>/
├── rails/           # customized Rails API (git-initialized)
├── ios/             # customized iOS project (git-initialized)
└── android/         # customized Android project (git-initialized)
```

Each is an independent, buildable git repo.

## Packaging

Ships as:
- `npx nativeapptemplate-agent "your spec"` — standalone CLI
- A Claude Code plugin (slash commands + skills)

## Hackathon success criteria (quick reminder — details in docs/SPEC.md section 11)

**Must-have for the demo video:**
- Clinic queue spec produces 3 projects passing Layer 1 + Layer 2 Stage 1
- Layer 3 rubric scores above threshold for captured home-screen shots
- 90s demo video of end-to-end run with validation report

**Stretch:** restaurant waitlist + task tracker also pass; self-repair loop fixes at least one real failure in the video.

## Sibling docs

- `docs/SPEC.md` — full technical specification (read first for any non-trivial change)
- `ROADMAP.md` — post-hackathon direction, OSS vs hosted tracks, durable scope boundaries
- `docs-private/GTM.md` — business strategy (relevant when discussing product surface, pricing, or Phase A/B transitions). Gitignored, not for publication.
- `docs-private/PREP-CHECKLIST.md` — pre-hackathon setup (should already be all-green by the time development starts). Gitignored.

## Anti-patterns to avoid

- **Don't reimplement mobile UI automation.** Use mobile-mcp. The hackathon is not about inventing device automation.
- **Don't extend scope beyond the queue / simple-CRUD-SaaS family** during the hackathon week. See `docs/SPEC.md` section 9 for the full non-goals list.
- **Don't target the paid edition.** The deliverable operates only on the MIT-licensed free edition so judges can reproduce it end-to-end.
- **Don't skip the validation layers to save time.** They are the demo story. A run that green-builds without passing Layer 3 is a failed run.
- **Don't edit, commit, push, or run `git clean` / `rm` inside `$NATEMPLATE_API`, `$NATEMPLATE_IOS`, or `$NATEMPLATE_ANDROID`.** Those are the developer's working copies of the free-edition substrate, possibly shared with other projects on the same machine. Copy them into `./out/<slug>/` first; change nothing in place. If unsure whether a command is safe, ask.