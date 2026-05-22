# Spec: HTML validation report

- Status: Draft
- Scope: A self-contained HTML report (plus a machine-readable `report.json`) emitted at the end of every agent run, summarizing all validation layers + the reviewer with embedded screenshots.
- Relationship to other docs: implements the "HTML validation report" idea (highest-ROI visual surface) without building a native GUI or a hosted web product. Aligns with `MONETIZATION.md` — a thin static artifact over the existing `dispatch()` core, not a new product surface.

---

## 1. Why

The pipeline already produces rich, visual validation evidence — leftover-token findings, per-platform build commands/durations, home-screen screenshots, vision-judge rubric scores with rationales, and a contract-parity diff. Today `index.ts` collapses all of it to two lines:

```
result: Layer 1 3/3 pass · Layer 2 3/3 pass · Layer 3 2/2 pass · reviewer PASS
overall: PASS
```

Everything else is written to `tmp/trace/*.log` (unstructured) and `tmp/screenshots/*.png` (ephemeral, cleaned). The single most valuable, most *visual* output of the agent is invisible unless you tail log files.

The report turns that evidence into one portable artifact you can open, attach to a PR, drop into a demo video, or hand to a non-technical buyer.

**Non-goals:** not interactive, no server, no JS framework, no live re-run, no hosting. That is the Phase-4 web product. This is a static file.

---

## 2. The data gap (read this first — it's the real work)

The report is *mostly* a rendering problem, but there's a structural blocker: **the per-layer detail is computed and then thrown away.**

`runJudge` (`src/agents/judge.ts`) builds a per-platform `PlatformReport` inside `evaluate()` — it has `layer1.findings`, `layer2.command`, `layer2.durationMs`, `layer2.stderrTail`, etc. — but the returned `JudgeResult` keeps only:

```ts
export type JudgeResult = {
  overallPass: boolean;
  summary: string;            // a single formatted string
  visual?: VisualJudgeReport; // the only structured survivor
};
```

So `Layer1Finding[]`, `Layer2Result.stderrTail`, the reviewer's `diffs`, the layer-2 command/duration, and the domain rename plan never reach the caller. **The report cannot be a pure post-process of today's `JudgeResult`.** Step 1 of implementation is widening what survives the run.

### Decision: emit a `report.json`, render HTML from it

Rather than thread more return values through callers ad hoc, introduce a single structured aggregate, `RunReport`, written to disk as `report.json`. The HTML renderer is a **pure function of `RunReport`** (`renderReport(report): string`). Benefits:

- HTML generator is decoupled, deterministic, and golden-file testable (no pipeline needed to test rendering).
- `report.json` is a free machine-readable artifact for CI gating, the MCP tool result, and the future web product.
- `dispatch()` is the natural assembler — it already holds `domain`, the three `WorkerResult`s, `reviewer`, the `JudgeResult`, and run timing.

This requires one upstream change: `runJudge` must return the structured per-platform/per-layer detail it already computes (see §5).

---

## 3. Output layout

Written to the run's output root (sibling to the three generated projects):

```
out/<slug>/
├── rails/  ios/  android/        # existing generated projects
├── report.json                   # machine-readable RunReport (always)
├── validation-report.html        # self-contained, openable anywhere (always)
└── report-assets/                # only when --report-embed=false
    ├── ios-home.png  android-home.png
    └── ios-step-3.png ...
```

**Default = single self-contained file.** Screenshots are base64-embedded and CSS is inlined, so `validation-report.html` is one portable file (emailable, attachable, survives `tmp/` cleanup). For ~4–8 PNGs this is ~1–3 MB — acceptable. `--report-embed=false` writes images to `report-assets/` and references them relatively, for size-sensitive cases.

Screenshots originate in `tmp/screenshots/{ios-home,android-home}.png` (Stage 1) and `tmp/screenshots/*-step-*.png` (Stage 2); the report collector reads them from the paths recorded in `VisualJudgePlatformReport.screenshotPath` / `Stage2PlatformReport.screenshots` and copies-or-embeds them. Never link directly into `tmp/` — it's ephemeral.

---

## 4. Report content (sections, in order)

1. **Header** — overall `PASS`/`FAIL` badge, spec text, `displayName`, slug, timestamp, agent version (from `package.json`), judge model (`claude-opus-4-7`), `NATIVEAPPTEMPLATE_VISUAL` level, total run duration.
2. **Gate strip** — four chips: Layer 1, Layer 2, Layer 3, Reviewer, each `x/3` (or `x/2` for L3) with pass/fail color. This is the existing `summary` string, made visual.
3. **Platform × Layer matrix** — the headline. Rows `rails / ios / android`, columns `Layer 1 / Layer 2 / Layer 3`, each cell a pass/fail/skip mark. (Rails has no Layer 3 — render as "n/a".)
4. **Layer 1 — Structural.** Per platform: pass + count. On failure, a findings table: `token | file:line | text excerpt`. Clean state shows an explicit "no leftover tokens" row.
5. **Layer 2 — Runtime.** Per platform: `command`, mode (`fast`/`build`), `exitCode`, `durationMs`. On failure, `stderrTail` in a native `<details>` (collapsed).
6. **Layer 3 — Semantic (vision judge).** Per platform (ios/android):
   - **Stage 1:** home-screen screenshot thumbnail + rubric table (`question | pass/fail | rationale`). Note "median of 3 samples per criterion" (`DEFAULT_SAMPLES = 3`).
   - **Stage 2** (when `VISUAL=2`): scenario name, `stepsPassed/stepCount`, a screenshot filmstrip (`screenshots[]`), and the post-toggle Layer 3 scores (`layer3Scores`).
   - `error` rendered prominently when a platform's visual phase failed.
7. **Reviewer — Contract parity.** `pass`/`fail` + `diffs[]` in a collapsed `<details>` when non-empty.
8. **Domain spec appendix.** Rename plan table (`from → to`), entities and fields, so the reader sees *what was generated and why the tokens changed*.
9. **Footer / reproduce.** The exact command to reproduce (`npx nativeapptemplate-agent "<spec>"` + the `NATIVEAPPTEMPLATE_VISUAL` value), and a pointer to `tmp/trace/*.log` for raw logs.

**Forward-looking (optional, render only if present):** a **self-repair** section showing the ≤5 iteration history (CLAUDE.md cap) — which layer failed, what was attempted, the delta. The model carries `repairAttempts?` so the renderer is ready when the loop is wired.

---

## 5. Data model

New file `src/report/model.ts`. Field types reuse existing exports verbatim where possible.

```ts
export type RunReport = {
  meta: {
    spec: string;
    slug: string;
    displayName: string;
    agentVersion: string;       // package.json version
    judgeModel: string;         // "claude-opus-4-7"
    visualLevel: 0 | 1 | 2;     // from NATIVEAPPTEMPLATE_VISUAL
    startedAt: string;          // ISO
    finishedAt: string;         // ISO
    durationMs: number;
  };
  overallPass: boolean;
  summary: string;              // existing one-line summary, preserved

  platforms: PlatformDetail[];  // rails, ios, android

  reviewer: {
    contractParity: "pass" | "fail";
    diffs: readonly string[];   // from ReviewerResult
  };

  domain: {
    renamePlan: readonly { from: string; to: string }[];
    entities: readonly { name: string; replaces: string;
      fields: readonly { name: string; type: string; references?: string }[];
      states?: readonly string[] }[];
  };

  repairAttempts?: readonly RepairAttempt[]; // future; render if present
};

export type PlatformDetail = {
  platform: "rails" | "ios" | "android";
  layer1: { pass: boolean; findings: readonly Layer1Finding[] };       // full findings, not a count
  layer2: { pass: boolean; command: string; mode: "fast" | "build";
            exitCode: number | null; durationMs: number; stderrTail?: string };
  layer3?: VisualJudgePlatformReport;  // ios/android only; reuse existing type (incl. .stage2)
};

export type RepairAttempt = {
  iteration: number;            // 1..5
  failingLayer: "layer1" | "layer2" | "layer3" | "reviewer";
  platform?: "rails" | "ios" | "android";
  action: string;
  resolved: boolean;
};
```

`Layer1Finding` and `VisualJudgePlatformReport` are imported from existing modules — no duplication. The report model is the *only* place these get aggregated.

### Required upstream change

`runJudge` already computes everything in `PlatformDetail.layer1`/`layer2` inside `evaluate()`, but discards the detail. Change `evaluate()` to retain full `Layer1Result.findings` and full `Layer2Result` (not just `findings.length` and `command`), and have `runJudge` return them. Smallest viable shape: add an optional `platforms?: PlatformDetail[]` to `JudgeResult` (back-compatible — existing CLI/MCP consumers ignore it). `dispatch()` then assembles `RunReport` from `domain` + `reviewer` + the enriched `JudgeResult` + timing it records around the run.

---

## 6. Code layout

```
src/report/
├── model.ts      # RunReport, PlatformDetail, RepairAttempt
├── collect.ts    # assemble RunReport in dispatch; copy/embed screenshots; write report.json
├── render.ts     # renderReport(report: RunReport): string   ← pure, no I/O, no network
└── theme.ts      # inline CSS string (brand palette), reused by render.ts
```

- `render.ts` is pure: `RunReport → string`. No `fs`, no `Date.now()` inside (timestamps come from `meta`). This makes it golden-file testable and deterministic.
- `collect.ts` owns all I/O: read screenshots, base64-or-copy, write `report.json` and `validation-report.html`.
- Vanilla HTML + inlined CSS. Interactivity limited to native `<details>` — **no JS framework, no bundler, no external assets, no web fonts** (system font stack, matching the social-preview SVG).

### Styling

Reuse the social-preview palette for brand coherence (`docs/social-preview.svg`): dark base `#1F2933`→`#0B69A3`, accent `#40C3F7`/`#2BB0ED`, text `#F5F7FA`/`#CBD2D9`. Pass = green, fail = red, skip/n-a = muted gray. Responsive, print-friendly (`@media print`), single-column on narrow widths.

---

## 7. CLI / MCP integration

`index.ts`, after `dispatch()`:

- Always write `out/<slug>/report.json` + `validation-report.html`.
- Print the report path as a `file://` URL (clickable in terminals) alongside the existing summary lines.

Flags:

| Flag | Default | Effect |
|---|---|---|
| `--no-report` | off | Skip both artifacts |
| `--report-format=html\|json\|both` | `both` | Which to emit |
| `--report-embed=true\|false` | `true` | Inline screenshots vs. `report-assets/` |
| `--report-open` | off | `open` the HTML after the run (macOS) |

**MCP** (`src/mcp.ts`): return `report.json` inline in the tool result and include the `validation-report.html` path, so a calling assistant gets structured pass/fail data plus a human-openable artifact.

`dispatch()` records `startedAt`/`finishedAt` to populate `meta.durationMs` (it currently records no timing).

---

## 8. Testing

- **Golden-file render test:** two fixture `RunReport`s (all-pass; mixed-fail with Layer 1 findings + Layer 2 `stderrTail` + reviewer diffs) → `renderReport` → snapshot the HTML. Pure function, no pipeline, fast.
- **Smoke test:** stub mode (`NATIVEAPPTEMPLATE_STUB_ALL=1`, the existing `runStubJudge` path) must produce a deterministic `RunReport` and write a valid `report.json` + non-empty HTML. Assert the file exists and the gate strip reflects the stub's PASS.
- **Self-contained check:** with `--report-embed=true`, assert the HTML references no `tmp/` paths and no `http(s)://` asset URLs (portability guarantee).
- Stub fixtures keep timestamps fixed so golden output is stable.

---

## 9. Implementation order

1. `src/report/model.ts` — types.
2. Widen `runJudge`/`evaluate` to retain full Layer 1 findings + Layer 2 detail; add `platforms?` to `JudgeResult` (back-compatible).
3. `dispatch()` — record timing; assemble `RunReport`.
4. `src/report/render.ts` + `theme.ts` — pure renderer + golden test.
5. `src/report/collect.ts` — screenshot embed/copy + write files.
6. `index.ts` flags + `file://` output line; smoke-test assertion.
7. `src/mcp.ts` — return `report.json` + HTML path.

Steps 1–4 land the machine-readable artifact and the HTML for the common case; 5–7 are polish and surface integration.

> **Status: shipped.** Steps 1–2 in #73, steps 3–7 in #74, and the CI exit-code + README docs in #75. The forward-looking `repairAttempts` section renders only once the self-repair loop is wired (separate work).

---

## 10. Rendering & visually verifying the report

`validation-report.html` is self-contained (screenshots base64-embedded, no external assets), so the zero-tooling path is just to open it:

```bash
open out/<slug>/validation-report.html        # macOS
```

For *agent-driven* visual verification — having Claude open the report and capture a screenshot — use the **Playwright MCP**. This is a maintainer convenience for eyeballing the rendered output; it is **not** part of the agent's pipeline (device screenshots in Layer 2/3 come from [`mobile-mcp`](https://github.com/mobile-next/mobile-mcp), not Playwright).

### Path A — Playwright MCP (interactive, inside Claude Code)

One-time setup (local scope — this project only, not committed):

```bash
claude mcp add playwright -- npx -y @playwright/mcp@latest
# then restart the Claude Code session so the browser_* tools load
# (mid-session adds register the server but don't inject tools into the running session)
npx playwright install chromium   # only if the first run reports a missing browser
```

Workflow, once a run has produced `out/<slug>/validation-report.html`:

1. Ask Claude to open and screenshot the report.
2. Under the hood it calls `browser_navigate` with a `file://` URL, then `browser_take_screenshot`:
   - `browser_navigate` → `file://<abs-path>/out/<slug>/validation-report.html`
   - `browser_take_screenshot` (use the full-page option to capture the whole report)
3. The PNG is the visual check; `report.json` carries the structured pass/fail.

**Heads-up — `@playwright/mcp` blocks the `file:` protocol by default**, so `browser_navigate` against a `file://…/validation-report.html` fails with *"Access to 'file:' protocol is blocked."* The reliable workaround is to serve the output dir over a throwaway local HTTP server and navigate to that instead:

```bash
# from the run's output dir (out/<slug>/, or wherever the report was written)
python3 -m http.server 8765 --bind 127.0.0.1 &
# then: browser_navigate → http://127.0.0.1:8765/validation-report.html
```

The report is self-contained (screenshots base64-embedded), so a plain static server suffices — there are no asset paths to resolve. Stop the server when done. (Some `@playwright/mcp` builds can instead be launched with `file:` access permitted via config, but that's version-dependent; the local-server route always works.) Note also that `browser_take_screenshot`'s saved PNG lands in the MCP server's working directory (the project root), not the output dir — move it out afterward.

Remove it later with `claude mcp remove playwright`.

### Path B — Playwright CLI (headless, no MCP, CI-friendly)

No session restart and no MCP registration — a one-off that's also suitable for capturing a CI artifact:

```bash
npx -y playwright@latest screenshot --full-page \
  "file://$(pwd)/out/<slug>/validation-report.html" \
  report.png
# if it errors on a missing browser:
npx -y playwright@latest install chromium
```

This needs no project dependency — `npx` fetches Playwright transiently. Don't add Playwright to `package.json`; the report itself has no runtime browser dependency, and keeping it out preserves the lean install.
