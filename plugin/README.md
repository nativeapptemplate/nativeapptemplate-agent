# nativeapptemplate-agent — Claude Code plugin

Drive the [`nativeapptemplate-agent`](https://github.com/nativeapptemplate/nativeapptemplate-agent)
generator from inside Claude Code. Describe an app in one sentence; the plugin
generates a validated three-platform implementation (Rails 8.1 API + SwiftUI iOS
+ Jetpack Compose Android), then reads the validation report back to you in plain
language.

Two skills: **generate → validate → explain**, and an interactive **walk the
running app** layer over `mobile-mcp`.

## What's in here

```
plugin/
├── .claude-plugin/plugin.json   # manifest
├── .mcp.json                    # bundles the generator MCP server + mobile-mcp
├── skills/
│   ├── generate-app/SKILL.md    # generate → validate → explain
│   └── walk-app/SKILL.md        # launch on a device, walk the UI with mobile-mcp
└── README.md
```

- **`/nativeapptemplate-agent:generate-app <spec>`** — runs the generator on your
  spec, parses `out/<slug>/report.json`, and summarizes per-platform / per-layer
  results, the domain mapping, and any failures with the specific evidence and the
  next move.
- **`/nativeapptemplate-agent:walk-app <slug> ios|android`** — launches a generated
  app on a **booted simulator/emulator** and drives `mobile-mcp` to capture the
  home screen and walk the UI conversationally, surfacing screenshots inline.
  Needs a booted device + an installed build (easiest via a
  `NATIVEAPPTEMPLATE_VISUAL=1` generate run — see the skill for details).
- **Bundled MCP servers** (`/mcp` to check): the generator server
  (`nativeapptemplate-agent`, wired as
  `npx -y -p nativeapptemplate-agent@latest nativeapptemplate-agent-mcp`) and
  `mobile-mcp` (`@mobilenext/mobile-mcp@0.0.54`) for device automation.

  Two non-obvious bits in that generator command: the MCP entry point is a **bin**
  of the `nativeapptemplate-agent` package, not its own package, so `-p` is
  required; and the **`@latest`** is load-bearing — without a version spec, `npx`
  resolves the *local* package when the server is spawned from inside the agent's
  own repo (cwd shadowing) and fails with `command not found`. `@latest` forces
  registry resolution regardless of cwd.

  `mobile-mcp` is **pinned to 0.0.54** on purpose: 0.0.55+ closes the stdio
  connection on startup (`Connection closed` ~6s in), so `@latest` fails. This
  matches the agent's own pin in `src/mobile.ts`. If you have a global `mobile-mcp`
  config on `@latest`, it'll show ✘ failed in `/mcp` — this bundled, pinned one is
  the working copy (different command, so it won't dedup against your global).

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

## Install from the marketplace

The repo ships a marketplace manifest (`.claude-plugin/marketplace.json`) that points at
this `plugin/` directory. Add the marketplace, then install:

```
/plugin marketplace add nativeapptemplate/nativeapptemplate-agent
/plugin install nativeapptemplate-agent@nativeapptemplate
```

`nativeapptemplate` is the marketplace name; `nativeapptemplate-agent` is the plugin. Once
installed, the skills are available as `/nativeapptemplate-agent:generate-app` and
`/nativeapptemplate-agent:walk-app` (and `/mcp` shows both bundled servers). The CLI forms
are `claude plugin marketplace add nativeapptemplate/nativeapptemplate-agent` and
`claude plugin install nativeapptemplate-agent@nativeapptemplate`.
