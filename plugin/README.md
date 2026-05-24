# nativeapptemplate-agent — Claude Code plugin

Drive the [`nativeapptemplate-agent`](https://github.com/nativeapptemplate/nativeapptemplate-agent)
generator from inside Claude Code. Describe an app in one sentence; the plugin
generates a validated three-platform implementation (Rails 8.1 API + SwiftUI iOS
+ Jetpack Compose Android), then reads the validation report back to you in plain
language.

This is the **first cut** — generate → validate → explain. A live home-screen
walk-through via `mobile-mcp` is planned as a second phase (see the repo
[roadmap](../ROADMAP.md#post-v01-backlog)).

## What's in here

```
plugin/
├── .claude-plugin/plugin.json   # manifest
├── .mcp.json                    # bundles the nativeapptemplate-agent MCP server
├── skills/
│   └── generate-app/SKILL.md    # the orchestration skill
└── README.md
```

- **`/nativeapptemplate-agent:generate-app <spec>`** — the skill. Runs the
  generator on your spec, parses `out/<slug>/report.json`, and summarizes
  per-platform / per-layer results, the domain mapping, and any failures with
  the specific evidence and the next move.
- **Bundled MCP server** (`nativeapptemplate-agent`) — exposes `generate_app` as
  a tool for direct/tool-call use; check it with `/mcp`. Wired as
  `npx -y -p nativeapptemplate-agent nativeapptemplate-agent-mcp` (the MCP entry
  point is a **bin** of the `nativeapptemplate-agent` package, not its own
  package — hence `-p`).

## Requirements

- Node.js 22+ and an `ANTHROPIC_API_KEY` with access to `claude-opus-4-7`.
- For the generated apps to validate, the substrate env vars
  (`NATIVEAPPTEMPLATE_API` / `_IOS` / `_ANDROID`) must point at the substrate
  repos, as documented in the main README. The plugin reads them from your
  environment and does not change them.

## Try it locally (no marketplace needed)

```bash
# from the agent repo root
claude --plugin-dir ./plugin
```

Then in the session:

```
/nativeapptemplate-agent:generate-app a walk-in queue for a barbershop
```

After editing plugin files, run `/reload-plugins` to pick up changes. Confirm the
skill is loaded via `/help` and the MCP server via `/mcp`.

## Install from git

```
/plugin install github.com/nativeapptemplate/nativeapptemplate-agent
```

> Note: the plugin lives in the `plugin/` subdirectory of the repo. If installing
> by path, point at `plugin/`, not the repo root.
