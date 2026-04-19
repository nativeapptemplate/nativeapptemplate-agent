# NativeAppTemplate Agent — Roadmap

This document describes the shape of the project beyond the hackathon week. It is a deliberately open description of direction, scoped to what is useful for contributors, users, and reviewers to know. Pricing specifics, migration plans for existing customers, and internal competitive analysis live in private documents; what is here is what is public.

---

## Where this project sits

`nativeapptemplate-agent` is the open-source (MIT) generator component of a wider ecosystem. It operates on top of the **MIT-licensed free edition** of NativeAppTemplate — three repositories covering a Rails 8.1 API, a SwiftUI iOS client, and a Jetpack Compose Android client. Anything this agent produces is fully reproducible from public code.

There is also a **commercial NativeAppTemplate** distribution that adds paid-only features (URL path-based multi-tenancy, user invitation to organizations, role-based access, organization switching). The commercial distribution is separate from this repository and not required to use the agent.

## Why it exists

Classic mobile boilerplates sell "save 12–16 weeks of setup." In the era of AI coding tools, that value compresses to 2–3 weeks of AI-assisted work. The durable problem that remains — even with AI — is **cross-platform coherence**: keeping a Rails API, a native iOS client, and a native Android client all consistent under iteration, with no contract drift, no forgotten rename, no divergent localized copy.

This agent is an answer to that: instead of selling the output of a boilerplate once, turn the boilerplate itself into a generator that produces coherent three-platform implementations on demand, with structural and semantic validation built in.

## Product shape — open source + hosted

The strategy is two-track.

### Track 1 — Open source (this repository)

`npx nativeapptemplate-agent "your spec"` — the CLI form of the agent. Also ships as a Claude Code plugin. Targets the free-edition substrate. Requires an Anthropic API key; every generation run reproduces end-to-end on the reviewer's machine.

This track is permanent. It is not a free trial of a commercial product — it is how we believe a generator like this should ship by default in 2026.

### Track 2 — Hosted (nativeapptemplate.com)

A chat interface on nativeapptemplate.com that runs the agent for paying users, with two things the open-source CLI doesn't give them:

1. A path to the **paid-edition substrate**, so generated apps include multi-tenancy, invitations, and role-based access without any extra wiring.
2. Convenience features that come from running on our infrastructure — generation history, shareable results, priority execution.

The hosted version is a natural follow-on, not the primary product. It's the option for people who want the paid substrate and don't want to manage the agent themselves.

## Rollout

Beyond the hackathon week, the project will evolve in phases driven by evidence, not calendar.

### Phase A — Ship the CLI, keep the existing sales flow

- `nativeapptemplate-agent` v0.1 public release
- Minimal chat interface added to nativeapptemplate.com; generation authorized by one-time codes so no login infrastructure is needed yet
- Existing Team customers gain access to the chat on top of what they already purchased — no disruption to the current Team SKU flow (25 GitHub usernames at checkout, GitHub ACL for substrate access)

### Phase B — Login-based workspace (only when the evidence justifies it)

Migration to a login + organization + membership model will happen when support ticket patterns, team-sharing requests, or operational load make Phase A untenable — not on a fixed schedule. If Phase A continues to serve customers well, Phase A is a valid steady state.

## What stays out of scope

Indefinitely:

- Pivoting away from native iOS + Android. The value proposition is *true* native Swift and Kotlin paired with Rails — not a web-first cross-platform generator.
- Becoming a general-purpose code-generation agent. The agent is scoped to SaaS shapes close to the substrate's domain family (queue, booking, simple CRUD). Breadth invites competition where no moat exists.

For the hackathon week specifically, see `docs/SPEC.md` section 9 for the full non-goals list.

## How to contribute

During the hackathon week (Apr 21–27, 2026) the repository may move quickly and breaking changes are expected. After that, contributions are welcome — the project will adopt standard OSS norms (issues, PRs, code review). Detailed guidelines will land in `CONTRIBUTING.md` once the dust settles.