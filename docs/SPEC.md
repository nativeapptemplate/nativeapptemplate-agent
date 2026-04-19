# NativeAppTemplate Agent — Specification

**Author:** Daisuke
**Event:** Built with Opus 4.7: a Claude Code Hackathon (Cerebral Valley × Anthropic, April 21, 2026)
**Status:** Pre-hackathon specification, v1.0
**Repository:** `github.com/nativeapptemplate/nativeapptemplate-agent` (to be created)

---

## 1. One-liner

A Claude Code agent that turns a natural-language spec — something as informal as `"a walk-in queue for a barbershop"` — into a working three-platform implementation: true native Swift iOS, true native Kotlin Android, and a Ruby on Rails API backend, coherent across all three, in under an hour.

## 2. Problem

Most "AI builds an app" tools stop at a single web frontend. The real pain for anyone shipping a mobile product is that the *same* domain has to be implemented three times — multi-tenant Rails API, native iOS, native Android — each with its own idioms. Keeping them consistent under iteration is where weeks disappear: a renamed field on the server silently breaks the iOS model; a new endpoint added for Android isn't exposed on iOS; localized copy drifts between platforms; API contract and client code diverge.

Existing code-generation tools either target only the web, or scaffold a single-stack monolith. None of them produce a coherent three-platform implementation driven by a single NL spec.

## 2.5. Why this project, why now

I run NativeAppTemplate as a commercial mobile boilerplate business at nativeapptemplate.com. Four paid SKUs today (iOS and Android, each in Solo and Team tiers); the Rails API used to be paid as well but I open-sourced it this year. That puts me in an unusual seat: I watch my own market getting rewritten by AI coding tools in real time, and I've already started restructuring the business around that.

My honest assessment, written up as an internal strategy doc this month: a skilled developer would need 12–16 weeks to recreate my paid iOS + Android clients manually from the free versions plus the open-sourced API. With AI coding tools like Claude Code, the same work compresses to 2–3 weeks. The traditional boilerplate value proposition — "save X weeks of setup" — is evaporating, and I've been thinking about what replaces it.

One answer is to stop selling the *output* of the boilerplate and start selling a *generator* that produces it on demand. Instead of fighting AI, lean into it: turn the boilerplate itself into an agent. That's what NativeAppTemplate Agent is.

The interesting technical problem that remains — even after AI compresses the scaffold work — is **cross-platform coherence**. An AI-assisted solo developer can generate a Rails controller, a SwiftUI screen, and a Compose screen faster than ever. Keeping all three consistent under iteration, with no contract drift, no forgotten rename, no localized-copy divergence, is exactly where AI-assisted workflows still break down. That's the gap this agent closes, and it's only practically solvable now, with Opus 4.7's 1M-token context and multi-agent orchestration.

The agent ships as open source (MIT), matching the free-edition substrate it operates on. A commercial hosted version — a chat interface on nativeapptemplate.com, with an upgrade path to the paid-edition substrate (so generated apps get multi-tenancy, invitations, and role-based access baked in) and usage-based generation credits — is the natural follow-on, but everything the hackathon produces is fully open and reproducible.

## 3. Substrate: NativeAppTemplate (Free edition)

The agent operates on top of the **free, MIT-licensed edition** of my open-source NativeAppTemplate, which is structurally a multi-tenant SaaS skeleton plus an attached domain module. The free edition is publicly available on GitHub, so judges and other developers can clone the substrate and reproduce the agent's output end-to-end — no paid access required.

**Skeleton (kept in every generated output):**
- `Account` — tenant root
- `Shop` — per-tenant primary resource container; editable name / description / time zone
- `Shopkeeper` — the user/owner of a Shop; the authenticated identity
- Multi-tenancy via `acts_as_tenant`, auth via `devise_token_auth`, authorization via `pundit`
- Sign up / sign in / email confirmation / password reset / password update / profile update / forced app / privacy policy / terms of use version updates
- NFC tag writing/reading (background tag reading) and QR code generation — shared utilities kept across all generated variants

**Tech stack (production-grade, exactly what's in the substrate):**
- **API** — Rails 8.1, PostgreSQL, Solid Queue / Cable / Cache, `devise_token_auth`, `pundit`, `acts_as_tenant`, Turbo, Minitest
- **iOS** — Swift, 100% SwiftUI, `@Observable`, MVVM, protocol-based repository, Liquid Glass design, Swift Testing, iOS 26.2+
- **Android** — 100% Kotlin, 100% Jetpack Compose, MVVM, interface-based repository, Hilt, Retrofit2, Proto DataStore, unit tests, API 26+

The agent preserves these patterns when it renames and regenerates code: generated SwiftUI views keep `@Observable` + MVVM, generated Compose screens keep Hilt injection and the repository interface pattern, generated Rails controllers keep `pundit` policies and `acts_as_tenant` scoping.

**Domain module (adapted, or stripped and replaced):**
- `ItemTag` (a.k.a. Number Tag) attached to Shop
- Walk-in queue semantics: two-state toggle — `Idled` (waiting) ↔ `Completed`

**Three repos, public and reproducible:**
- `nativeapptemplate/nativeapptemplateapi` — Rails 8.1 API, Ruby 7,687 LOC
- `nativeapptemplate/NativeAppTemplate-Free-iOS` — native SwiftUI iOS, Swift 15,311 LOC
- `nativeapptemplate/NativeAppTemplate-Free-Android` — native Jetpack Compose Android, Kotlin 19,521 LOC

Measured 2026-04-19 with `cloc --vcs=git` (tracked files only). Total ~42.5k LOC of application code across the three repos, sharing one domain model through a documented JSON:API contract. This fits comfortably in Opus 4.7's 1M-token context with headroom for tests, generated output, and sub-agent coordination.

The free edition is a stripped-down sibling of my paid NativeAppTemplate distribution, which powers MyTurnTag Creator — the walk-in queue management SaaS I've been running on both app stores for the past two years. That production history matters for provenance (the skeleton has been battle-tested by a shipping product), but the hackathon deliverable stays entirely on the public, MIT-licensed free edition so anyone can reproduce it.

## 4. Agent operations

The agent performs three clean operations against this substrate.

**Operation 1 — Rename the skeleton.** Based on the natural-language spec (NL spec) the user provides — e.g., `"a walk-in queue for a barbershop"` or `"a simple task tracker with due dates"` — propagate renames like `Shop → Clinic`, `Shopkeeper → Staff` consistently across:

- Rails: migrations, models, controllers, serializers, policies, tests, i18n, routes, factories, seeds
- iOS: entity types, view models, networking DTOs, SwiftUI views, Localizable.strings
- Android: data classes, repositories, ViewModels, Compose screens, strings.xml

**Operation 2 — Adapt or replace the domain module.**

- *Adapt path* (walk-in-queue variants like clinic queue, restaurant waitlist, salon walk-ins): keep `ItemTag`, rename to the variant's terminology, preserve the two-state toggle (`Idled` ↔ `Completed`) and its transition logic. Variants that genuinely need a three-state lifecycle (e.g., a clinic queue wanting a distinct "in-service" state) extend the state machine rather than replace it — the planner decides whether to preserve, extend, or replace the states based on the NL spec.
- *Replace path* (non-queue SaaS like task tracker, simple CRM, inventory): strip `ItemTag` end-to-end, insert a new primary resource with equivalent coverage (migration + model + controller + policy + serializer + iOS/Android screens + state transitions if applicable).

The planner sub-agent decides which path to run based on the NL spec.

**Operation 3 — Drive the build green.** `bin/rails test`, `xcodebuild test`, and `./gradlew test` must all pass on the generated code before the agent exits. Failures feed into the self-repair loop (section 6).

## 5. Opus 4.7 capabilities used

Three Opus 4.7 capabilities are essential, and the project is specifically designed to showcase them.

**1M-token context window.** All three substrate repos — Rails (Ruby 7,687 LOC), iOS (Swift 15,311 LOC), and Android (Kotlin 19,521 LOC), ~42.5k total LOC of application code — load into a single context. This is what makes cross-repo coherent renames actually possible: when `Shop → Clinic` happens, the model simultaneously sees `app/models/shop.rb`, `ShopViewModel.swift`, and `ShopRepository.kt`, and can apply the rename with matching naming conventions per language. At 200k tokens this isn't tractable without aggressive chunking, and chunking is exactly what produces drift.

**Multi-agent orchestration.** Work splits across specialized sub-agents:

- *Planner* — ingests the NL spec, produces a structured domain description (entities, fields, relationships, state machines, key verbs) and picks the adapt-or-replace path
- *Rails worker* — applies rename + domain changes to the Rails repo
- *iOS worker* — applies corresponding changes to the iOS repo
- *Android worker* — applies corresponding changes to the Android repo
- *Contract reviewer* — after workers finish, diffs the OpenAPI schema emitted by Rails against both clients' networking layers; blocks on any mismatch

Rails, iOS, and Android workers run in parallel against a shared API contract frozen by the planner.

**Vision-guided self-repair.** On test or build failures the agent reads logs and patches; this is the standard Claude Agent SDK loop. For UI correctness specifically, the agent captures simulator and emulator screenshots and uses Opus 4.7 vision to verify the rendered UIs match the intended domain (e.g., does the screen read as a "clinic queue" to a user?). The design works in three stages depending on depth:

- **Stage 1 (in-week minimum):** screenshots of the launch / home screen only, captured immediately after app boot via `xcrun simctl io booted screenshot` (iOS) and `adb exec-out screencap` (Android). Vision judge scores the one screenshot against a rubric. This alone catches egregious rename failures ("the app still says 'Shop' everywhere").
- **Stage 2 (in-week stretch):** UI-driven navigation to 2–3 additional key screens — list view, detail view, form — using [`mobile-next/mobile-mcp`](https://github.com/mobile-next/mobile-mcp), the de facto standard mobile automation MCP server (3.7k stars, Apache-2.0, 36 releases). It exposes a platform-agnostic API that uses native accessibility trees on both iOS and Android for deterministic element interaction, falling back to coordinate-based taps on screenshots when accessibility data is unavailable. The agent navigates the generated app via `mobile_list_elements_on_screen` + `mobile_click_on_screen_at_coordinates` + `mobile_type_keys`, capturing screenshots via `mobile_take_screenshot` at each target screen, and feeding those screenshots to Layer 3 as vision input.
- **Stage 3 (post-hackathon):** richer multi-step scenarios — sign-up → CRUD → state transitions → logout — assembled on top of the same primitives.

The self-repair loop itself is bounded: a hard maximum of N repair iterations per generated project (target N=5), after which the agent surfaces the residual failures and exits rather than looping indefinitely. Failure modes that are known to be cryptic — Jetpack Compose compilation errors, Hilt DI misconfigurations — are tagged in the planner's context so the agent knows to slow down and verify rather than pattern-match.

## 6. Validation — three layers

Green builds are not enough. A shallow test suite will pass even if a rename is inconsistent or the API contract drifted between platforms. Validation runs in three layers, each gating the next.

**Layer 1 — Structural.** Runs before any tests execute.

- *Rename completeness:* `ripgrep` for original domain tokens (`Shop`, `Shopkeeper`, `ItemTag`, and derived forms) across all three generated projects. Zero residual hits required outside an explicit allow-list (e.g., license files, git history).
- *OpenAPI contract parity:* Rails emits an OpenAPI spec via `rswag` at generation time. The agent parses the iOS networking layer and Android repository layer and confirms every client call maps to a spec path with matching request and response schemas. Any contract drift fails the run immediately.

**Layer 2 — Runtime end-to-end.** Unit tests alone aren't enough. This layer runs in stages matching the Vision-guided self-repair stages in section 5.

- *Stage 1 (minimum):* boot the generated Rails server; confirm it responds to `GET /api/v1/health` (or equivalent). Build the iOS app for a simulator target and the Android app for an emulator target; confirm both build artifacts are produced. Launch each app and capture the first screen. No scripted user flow yet — just "does it boot, does it render a non-crashing home screen."
- *Stage 2 (stretch):* UI-driven scenario via `mobile-next/mobile-mcp` on both platforms — sign up → create primary resource → list → update state → delete. The agent enumerates on-screen elements with `mobile_list_elements_on_screen`, taps target elements via `mobile_click_on_screen_at_coordinates`, types into fields with `mobile_type_keys`, and verifies expected-text presence by re-reading the element list after each action (the agent side implements lightweight `wait_for_element` / `assert_visible` helpers over these primitives). API-side failures are caught in parallel: a scripted HTTP tail against the Rails server logs 4xx/5xx responses during the scenario and fails the run on any unexpected status.
- *Stage 3 (post-hackathon):* richer multi-user scenarios (invite members, role-based access checks), offline-mode testing, and cross-device coordination — still on the same mobile-mcp primitives, just with more elaborate scripts.

Even Stage 1 is enough to surface silent field renames: a field renamed on the server but not on a client will show up as a build error or a runtime crash on first screen load.

**Layer 3 — Semantic, via Opus 4.7 as judge.**

- Parse the original NL spec into a structured "expected domain" (entities, fields, relationships, key verbs).
- Read the generated Rails code and ask Opus 4.7 to score, on a structured rubric (Yes/No per criterion with justification), whether the implementation expresses the expected domain.
- Repeat separately for iOS copy / labels and Android copy / labels, derived from `Localizable.strings` and `strings.xml`.
- For UI specifically, Opus 4.7 vision reads the simulator and emulator screenshots captured in Layer 2 / section-5 Stage 1 and scores: "does this screen read as a [clinic queue / restaurant waitlist / task tracker] to a real user?"

Guardrails against known LLM-as-judge weaknesses:
- Rubrics are structured Yes/No-per-criterion, never free-form scoring, to reduce the "well, I guess that's fine" drift LLM judges default to.
- Each screenshot is judged three times; the median score is used, dissent is logged.
- Sanity-calibrated against the known-good MyTurnTag-like case: if the agent generates a walk-in clinic queue (close to the substrate's domain), the judge should return near-maximal scores. If it doesn't, the judge itself needs adjustment before results elsewhere are trusted.
- Runs that score below a threshold fail

The headline evaluation metric becomes layered rather than binary: Layer 1 pass rate, Layer 2 pass rate, and Layer 3 mean semantic score. A run can green-build and still fail the semantic rubric, and that's exactly the gap this surfaces.

## 7. Evaluation plan for the hackathon

Three specs, covering both operation paths:

- **Walk-in clinic queue** — adapt `ItemTag`. Easy mode; closest to MyTurnTag's actual domain. Target: all three layers pass.
- **Restaurant waitlist** — adapt `ItemTag`. Medium; slightly different state names and workflow. Target: all three layers pass.
- **Simple task tracker** — strip `ItemTag`, insert `Task` resource. Hard; exercises the replace path. Target: Layer 1 and Layer 2 pass; Layer 3 score ≥ threshold.

Total output: 9 generated projects (3 specs × 3 platforms each). Report Layer 1 pass rate, Layer 2 pass rate, and Layer 3 mean semantic score as the primary metrics.

## 8. Architecture & packaging

**Host language: TypeScript.** The agent is driven by the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), which provides the agent loop, context management, sub-agents, skills, and hooks out of the box. Ruby is not a viable host: the Claude Agent SDK is only available in TypeScript and Python, so a Ruby agent would mean reimplementing the loop, sub-agent orchestration, and context compaction from scratch — a week-long project in itself.

**Ruby subprocesses for Rails-specific transformations.** Where Ruby tooling is stronger than anything in the Node ecosystem — AST edits via the `parser` gem, ERB template generation, migration scaffolding, running `bin/rails` commands — the TypeScript host shells out to Ruby scripts bundled in the repo. This plays to the strength of each language: Claude Agent SDK infrastructure in TypeScript, Rails surgery in Ruby.

**Sub-agent layout.** The TypeScript host spawns:

- A planner sub-agent (parses the NL spec, chooses adapt vs. replace path)
- Three worker sub-agents (Rails / iOS / Android) running in parallel against a frozen API contract
- A contract reviewer (OpenAPI diff)
- A Layer 3 judge (Opus 4.7, text + vision)

Sub-agents communicate through the SDK's structured messages; file I/O happens on a shared working tree.

**External dependencies.** The agent delegates mobile device interaction to one battle-tested external MCP:

- [`mobile-next/mobile-mcp`](https://github.com/mobile-next/mobile-mcp) (Apache-2.0, ~3.7k stars, 36 releases, active development) — the de facto standard MCP server for mobile automation. Provides a platform-agnostic API across iOS Simulator, Android Emulator, and real devices; prefers native accessibility trees for deterministic interaction and falls back to screenshot-based taps when accessibility data is unavailable. Installed with a single `npx -y @mobilenext/mobile-mcp@latest` and supported by essentially every MCP-capable IDE and agent harness — Claude Code, Claude Desktop, Cursor, Codex, Copilot, VS Code, Cline, opencode, Gemini CLI, Kiro, Goose, Windsurf, and Qodo Gen. Used for all of Layer 2 Stage 2 and for Vision-guided self-repair Stage 2.

The selection criteria were, in order: MCP client coverage (maximizes judge reproducibility — any reviewer can verify the demo regardless of their tooling), license compatibility (Apache-2.0 is compatible with our MIT deliverable), community validation (3.7k stars and 36 releases indicate battle-testing across many environments), and API surface (accessibility-tree-first reduces LLM round-trip count, an important throughput concern for hackathon-scale timing). Using an existing, maintained MCP here is a deliberate choice — reinventing mobile UI automation would consume most of the hackathon week and produce something worse.

**Packaging — two surfaces.**

- `npx nativeapptemplate-agent "your spec"` — standalone CLI for anyone with an Anthropic API key. One command, no install.
- A Claude Code plugin — installable into a developer's existing Claude Code workflow (`claude plugin install …`), exposing the agent's operations as slash commands and skills.

**Output layout.** Generated outputs are written to `./out/<spec-slug>/{rails,ios,android}` as standalone git-initialized project directories, each independently buildable.

## 9. Non-goals for the hackathon week

Kept out of scope to make the week's scope realistic:

- Social login (OmniAuth / Apple / Google) — post-hackathon addition to the substrate itself
- Paid-edition features not present in the free substrate — URL path-based multi-tenancy (`/:account_id/` routing with multiple organizations), user invitation to organizations, role-based permissions and access control, and organization-switching UI. The free edition is intentionally single-organization (the personal account is transparent to the user), and this hackathon builds only on top of that.
- Customizable queue-display web pages (a paid-edition feature of MyTurnTag Creator / NativeAppTemplate commercial distribution)
- App Store / Play Store submission automation
- Generated app deployment (to Heroku / Render / Fly etc.)
- Domains far outside the queue / simple-CRUD-SaaS family (e.g., real-time multiplayer games, video streaming)

## 10. Risks & mitigations

- **Risk: 1M-token context budget exhausted by three large repos.** Mitigation: sub-agents each take a scoped slice of context; planner and reviewer work over structured summaries rather than raw code where possible.
- **Risk: simulator/emulator infra brittleness inside the agent loop.** Mitigation: abstract the device layer behind a thin adapter with a recorded-session fallback, so Layer 2 Stage 1 has a path forward even if live simulators flake.
- **Risk: Opus 4.7 as semantic judge is noisy.** Mitigation: structured Yes/No-per-criterion rubrics; median-of-three scoring per screenshot; sanity-calibrate on the clinic queue case.
- **Risk: self-repair loop diverges on cryptic Compose / Hilt / Kotlin compile errors.** Mitigation: hard cap of 5 repair iterations per project; known-cryptic error classes tagged in the planner context so the agent pauses and reasons instead of pattern-matching; on exceeding the cap the agent surfaces the residual failure rather than looping indefinitely.
- **Risk: scope creep from "non-queue SaaS".** Mitigation: the replace path is deliberately tested against only one spec (task tracker) during the hackathon week; broadening is post-hackathon.

## 11. Success criteria (end of hackathon week)

Organized by priority so that "what ships in the demo video" is unambiguous even if time runs short.

**Must-have (demo video shows these no matter what):**
- `npx nativeapptemplate-agent "walk-in clinic queue for small veterinary practices"` produces three generated projects that pass Layer 1 (structural / ripgrep + OpenAPI parity) with zero residual failures.
- Layer 2 Stage 1 passes on all three: Rails server boots and responds to a health check; iOS builds for a simulator and launches to a home screen; Android builds for an emulator and launches to a home screen.
- Layer 3 runs against the captured home-screen screenshots and returns a rubric-based assessment.
- 90-second demo video of one end-to-end run with the validation report on screen.
- Public repo with working README, architecture diagram, and the demo video embedded.
- **End-to-end reproducibility**: a judge with an Anthropic API key can run `npx nativeapptemplate-agent "..."` and regenerate the demo output from the public, MIT-licensed free-edition substrate — no private code, no proprietary dependencies, no handwaving.

**Stretch (likely but not guaranteed):**
- Restaurant waitlist spec passes the same Must-have bar as clinic queue.
- Task tracker spec (replace path) passes Layer 1 and Layer 2 Stage 1.
- Layer 2 Stage 2 runtime HTTP CRUD flow succeeds against the Rails server for at least one generated project.
- The self-repair loop demonstrably fixes at least one real build or test failure inside the demo video.

**Ambitious (Anthropic finalist-level demo):**
- All three specs pass Must-have + Stretch bars.
- Deep-link driven navigation to list / detail screens, with per-screen Opus 4.7 vision verdicts.
- Self-repair loop fixes multiple unrelated failure modes across the three platforms (Rails migration error, Swift type mismatch, Kotlin Compose error) in a single agent run.