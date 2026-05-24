# NativeAppTemplate Agent — Roadmap

This document describes the shape of the project beyond the hackathon week. It is a deliberately open description of direction, scoped to what is useful for contributors, users, and reviewers to know. Pricing specifics, migration plans for existing customers, and internal competitive analysis live in private documents; what is here is what is public.

---

## Status (April 2026)

The project was submitted to Cerebral Valley's *Built with Opus 4.7: a Claude Code Hackathon* (Apr 21–27, 2026). It was not selected — roughly 13,000 applications, ~500 seats. The April 21–27 calendar block remains in place as a self-imposed sprint with the same 6-day rhythm and the same demo-video deliverable. The hackathon was an accelerant, not a prerequisite.

- **v0.1 target:** April 27, 2026. Public tag, working `npx nativeapptemplate-agent "<spec>"` CLI, demo video published.
- **Public launch:** May 2026. Wider announcement (HN / Twitter / Reddit). Phase A's hosted-chat layer on nativeapptemplate.com begins taking paying users shortly after.

The pipeline generates three coherent platforms from a one-sentence natural-language spec, with real structural and runtime validation. Demo-grade as of April 22, ahead of the self-imposed storyboard; the remaining work before v0.1 is the Opus 4.7 vision judge (Layer 3), full mobile builds in validation, and the reviewer sub-agent's OpenAPI contract diff.

## Where this project sits

`nativeapptemplate-agent` is the open-source (MIT) generator component of a wider ecosystem. It operates on top of the **MIT-licensed free edition** of NativeAppTemplate — three repositories covering a Rails 8.1 API, a SwiftUI iOS client, and a Jetpack Compose Android client. Anything this agent produces is fully reproducible from public code.

There is also a **commercial NativeAppTemplate** distribution that adds paid-only features (URL path-based multi-tenancy, user invitation to organizations, role-based access, organization switching). The commercial distribution is separate from this repository and not required to use the agent.

## Why it exists

Classic mobile boilerplates sell "save 12–16 weeks of setup." In the era of AI coding tools, that value compresses to 2–3 weeks of AI-assisted work. The durable problem that remains — even with AI — is **cross-platform coherence**: keeping a Rails API, a native iOS client, and a native Android client all consistent under iteration, with no contract drift, no forgotten rename, no divergent localized copy.

This agent is an answer to that: instead of selling the output of a boilerplate once, turn the boilerplate itself into a generator that produces coherent three-platform implementations on demand, with structural and semantic validation built in.

## Product shape — open source + hosted

The strategy is two-track.

### Track 1 — Open source (this repository)

`npx nativeapptemplate-agent "your spec"` — the CLI form of the agent, and the primary surface. A second surface ships alongside it: `npx -y -p nativeapptemplate-agent nativeapptemplate-agent-mcp`, a stdio MCP server exposing a `generate_app` tool so any MCP-capable assistant (Claude Code, Cursor, Cline, Goose) can invoke the agent without a terminal — the distribution multiplier. Both target the free-edition substrate and require an Anthropic API key; every generation run reproduces end-to-end on the reviewer's machine. A **Claude Code plugin** is the third surface (in [`plugin/`](plugin/)) — `claude --plugin-dir ./plugin` loads the `generate-app` and `walk-app` skills; see [Claude Code plugin](#claude-code-plugin) below.

This track is permanent. It is not a free trial of a commercial product — it is how we believe a generator like this should ship by default in 2026.

### Track 2 — Hosted (nativeapptemplate.com)

A chat interface on nativeapptemplate.com that runs the agent for paying users, with two things the open-source CLI doesn't give them:

1. A path to the **paid-edition substrate**, so generated apps include multi-tenancy, invitations, and role-based access without any extra wiring. **Validated end-to-end during v0.1 development** — the agent's same code path handles both free and paid substrates by choosing which repos the env vars point at; multi-tenant features (org switching, invitations, role permissions) survive the rename pipeline intact.
2. Convenience features that come from running on our infrastructure — generation history, shareable results, priority execution.

The hosted version is a natural follow-on, not the primary product. It's the option for people who want the paid substrate and don't want to manage the agent themselves.

## Rollout

Beyond v0.1, the project will evolve in phases driven by evidence, not calendar.

### Phase A — Ship the CLI, keep the existing sales flow

- `nativeapptemplate-agent` **v0.1 public release on April 27, 2026** (self-imposed-sprint deliverable)
- **Public launch on May 2026** — wider announcement, developer-audience posts
- Minimal chat interface added to nativeapptemplate.com; generation authorized by one-time codes so no login infrastructure is needed yet
- Existing Team customers gain access to the chat on top of what they already purchased — no disruption to the current Team SKU flow (25 GitHub usernames at checkout, GitHub ACL for substrate access)

### Phase B — Login-based workspace (only when the evidence justifies it)

Migration to a login + organization + membership model will happen when support ticket patterns, team-sharing requests, or operational load make Phase A untenable — not on a fixed schedule. If Phase A continues to serve customers well, Phase A is a valid steady state.

## Post-v0.1 backlog

Features considered but deliberately deferred until after Layer 3 (vision judge) and the reviewer sub-agent (OpenAPI contract diff) ship. These add convenience or determinism on top of an already-working pipeline; they don't move the validation story forward, so they wait.

### Optional explicit naming overrides

**Status: `--rename` and `--project-name` shipped.** Both overrides are implemented (`src/rename-overrides.ts` + name/slug helpers in `src/slug.ts`; `--rename From=To` and `--project-name="Vet Clinic"` on the CLI, `renameOverrides` + `projectName` on the MCP `generate_app` tool and `dispatch()`). `--rename` semantics are "change a planned target" — an override keys on the substrate token and replaces the planner's chosen target, and overrides matching no planned rename are reported and dropped rather than silently added. `--project-name` accepts a human/Pascal/kebab name and derives the slug (output dir, DB prefix, env-bridge token, Pascal project name across all three platforms) **and** the display name from it — closing the earlier `displayName`-override gap; a name yielding no valid slug is reported and ignored.

Today the planner is the sole source of slug, displayName, and rename plan (`Shop → Clinic`, `Shopkeeper → Vet`, `ItemTag → Patient`, etc.) — derived from a one-sentence natural-language spec. Output is good but not deterministic across runs (model evolution, prompt sensitivity), and there's no escape hatch when the planner picks a less-natural noun (e.g. forced into a non-substrate-reserved alternate).

Proposed shape — flag-based optional overrides on top of natural language. The planner still parses the spec and proposes a full DomainSpec; CLI flags merge in afterward, taking precedence on conflicts. Anything not specified falls through to the planner's pick.

```bash
npx nativeapptemplate-agent "a walk-in clinic queue for small veterinary practices" \
  --project-name="Clinic Queue" \
  --rename Shopkeeper=Vet \
  --rename ItemTag=Patient
```

Why optional and not required: the project's pitch is "natural-language → working app." Forcing the user to think *"what's my Shop equivalent? My Shopkeeper equivalent? My ItemTag equivalent?"* defeats the value the planner exists to add. Most users won't have that domain-modelling vocabulary; the planner does.

Use cases the override solves: reproducible runs (demo videos, automated tests, docs examples), manual veto when the planner's noun choice doesn't match the user's mental model, escape hatch when the substrate-reserved-token list pushes the planner into less-natural alternates.

No interactive prompts — keeps the CLI scriptable and CI-friendly, no TTY assumptions.

### Claude Code plugin

**Status: shipped.** Lives in [`plugin/`](plugin/); load it locally with `claude --plugin-dir ./plugin`. Two skills, bundling two MCP servers (the generator + `mobile-mcp`):

1. **`/nativeapptemplate-agent:generate-app <spec>`** — runs the generator, parses `out/<slug>/report.json`, and explains per-platform / per-layer results, the domain mapping, and any failures with the specific evidence and the next move.
2. **`/nativeapptemplate-agent:walk-app <slug> ios|android`** — launches a generated app on a booted simulator/emulator and drives `mobile-mcp` to capture the home screen and walk the UI conversationally, screenshots inline.

The original plan gated this on `dispatch()` streaming + an orchestration skill. In practice the skill carries the value without streaming: `generate-app` drives the CLI and narrates around it, delivering the post-generation story (validate → explain; generate → walk) with no streaming needed. Streaming remains a nice-to-have for the single-tool MCP surface, not a blocker for the plugin.

Verified end-to-end 2026-05-24: `generate-app` (barbershop-queue, all layers green) and `walk-app` (Android launch + interactive tap-through with inline screenshots on the Pixel emulator).

## What stays out of scope

Indefinitely:

- Pivoting away from native iOS + Android. The value proposition is *true* native Swift and Kotlin paired with Rails — not a web-first cross-platform generator.
- Becoming a general-purpose code-generation agent. The agent is scoped to SaaS shapes close to the substrate's domain family (queue, booking, simple CRUD). Breadth invites competition where no moat exists.

For the hackathon week specifically, see `docs/SPEC.md` section 9 for the full non-goals list.

## How to contribute

During the self-imposed April 21–27, 2026 sprint the repository moves quickly and breaking changes are expected. After v0.1 ships, contributions are welcome — the project will adopt standard OSS norms (issues, PRs, code review). Detailed guidelines will land in `CONTRIBUTING.md` once the dust settles.