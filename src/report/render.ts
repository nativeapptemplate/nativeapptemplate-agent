import type { PlatformDetail } from "../agents/types.js";
import type { AssetMap, RunReport } from "./model.js";
import { REPORT_CSS } from "./theme.js";

// Pure: RunReport (+ a resolved screenshot AssetMap) -> a complete,
// self-contained HTML document string. No filesystem, no network, no
// clock — every dynamic value comes from the inputs, so the output is
// deterministic and golden-file testable.
export function renderReport(report: RunReport, assets: AssetMap = {}): string {
  const body = [
    head(report),
    gates(report),
    matrix(report),
    layer1Section(report),
    layer2Section(report),
    layer3Section(report, assets),
    reviewerSection(report),
    repairSection(report),
    domainSection(report),
    footer(report),
  ].join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Validation report — ${esc(report.meta.displayName)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>`;
}

function head(report: RunReport): string {
  const m = report.meta;
  const badge = report.overallPass
    ? `<span class="badge pass">✓ Pass</span>`
    : `<span class="badge fail">✗ Fail</span>`;
  const visual = m.visualLevel === 0 ? "off" : `level ${m.visualLevel}`;
  return `<header class="report-head">
${badge}
<h1>${esc(m.displayName)}</h1>
<p class="spec">spec: <b>${esc(m.spec)}</b></p>
<div class="meta">
<span>slug: ${esc(m.slug)}</span>
<span>agent v${esc(m.agentVersion)}</span>
<span>judge: ${esc(m.judgeModel)}</span>
<span>visual: ${visual}</span>
<span>${fmtDuration(m.durationMs)}</span>
<span>${esc(m.finishedAt)}</span>
</div>
</header>`;
}

type Gate = { label: string; value: string; cls: "pass" | "fail" | "muted" };

function computeGates(report: RunReport): Gate[] | null {
  const plats = report.platforms;
  if (plats.length === 0) return null;
  const l1 = plats.filter((p) => p.layer1.pass).length;
  const l2 = plats.filter((p) => p.layer2.pass).length;
  const l3plats = plats.filter((p) => p.layer3 !== undefined);
  const l3 = l3plats.filter((p) => p.layer3!.pass).length;
  const reviewerPass = report.reviewer.contractParity === "pass";
  return [
    gateOf("Layer 1 · structural", l1, plats.length),
    gateOf("Layer 2 · runtime", l2, plats.length),
    l3plats.length > 0
      ? gateOf("Layer 3 · semantic", l3, l3plats.length)
      : { label: "Layer 3 · semantic", value: "skipped", cls: "muted" as const },
    { label: "Reviewer · contract", value: reviewerPass ? "Pass" : "Fail", cls: reviewerPass ? "pass" : "fail" },
  ];
}

function gateOf(label: string, pass: number, total: number): Gate {
  return { label, value: `${pass}/${total} pass`, cls: pass === total ? "pass" : "fail" };
}

function gates(report: RunReport): string {
  const gs = computeGates(report);
  const cards = gs
    ? gs.map((g) => `<div class="gate ${g.cls}"><div class="label">${esc(g.label)}</div><div class="value">${esc(g.value)}</div></div>`).join("")
    // Stub / detail-less runs: fall back to the one-line summary.
    : `<div class="gate ${report.overallPass ? "pass" : "fail"}"><div class="label">Summary</div><div class="value" style="font-size:15px">${esc(report.summary)}</div></div>`;
  return `<section><h2>Gates</h2><div class="gates">${cards}</div></section>`;
}

function matrix(report: RunReport): string {
  if (report.platforms.length === 0) return "";
  const rows = report.platforms
    .map((p) => {
      const l3 = p.platform === "rails" ? markNa() : p.layer3 ? mark(p.layer3.pass) : markNa();
      return `<tr><td>${esc(p.platform)}</td><td>${mark(p.layer1.pass)}</td><td>${mark(p.layer2.pass)}</td><td>${l3}</td></tr>`;
    })
    .join("");
  return `<section><h2>Platform × layer</h2>
<table class="matrix">
<thead><tr><th>Platform</th><th>Layer 1</th><th>Layer 2</th><th>Layer 3</th></tr></thead>
<tbody>${rows}</tbody>
</table></section>`;
}

function layer1Section(report: RunReport): string {
  if (report.platforms.length === 0) return "";
  const cards = report.platforms.map((p) => {
    const findings = p.layer1.findings;
    const inner = findings.length === 0
      ? `<p class="empty">No leftover substrate tokens.</p>`
      : `<table class="findings">
<thead><tr><th>Token</th><th>Location</th><th>Line</th></tr></thead>
<tbody>${findings.map((f) => `<tr><td><code>${esc(f.token)}</code></td><td>${esc(f.file)}:${f.line}</td><td><code>${esc(f.text)}</code></td></tr>`).join("")}</tbody>
</table>`;
    return card(p.platform, p.layer1.pass, inner);
  }).join("");
  return `<section><h2>Layer 1 — structural (leftover token scan)</h2>${cards}</section>`;
}

function layer2Section(report: RunReport): string {
  if (report.platforms.length === 0) return "";
  const cards = report.platforms.map((p) => {
    const l2 = p.layer2;
    const kv = `<p class="kv">command: <b>${esc(l2.command)}</b><br>mode: <b>${esc(l2.mode)}</b> · exit: <b>${l2.exitCode === null ? "—" : l2.exitCode}</b> · <b>${fmtDuration(l2.durationMs)}</b></p>`;
    const stderr = l2.stderrTail && !l2.pass
      ? `<details><summary>stderr tail</summary><pre>${esc(l2.stderrTail)}</pre></details>`
      : "";
    return card(p.platform, l2.pass, kv + stderr);
  }).join("");
  return `<section><h2>Layer 2 — runtime (toolchain build/boot)</h2>${cards}</section>`;
}

function layer3Section(report: RunReport, assets: AssetMap): string {
  const plats = report.platforms.filter((p): p is PlatformDetail & { layer3: NonNullable<PlatformDetail["layer3"]> } => p.layer3 !== undefined);
  if (plats.length === 0) return "";
  const cards = plats.map((p) => {
    const l3 = p.layer3;
    const parts: string[] = [];
    if (l3.error) parts.push(`<p class="empty">error: ${esc(l3.error)}</p>`);
    if (l3.screenshotPath) parts.push(`<div class="shots">${shot(l3.screenshotPath, "home screen", assets)}</div>`);
    if (l3.scores && l3.scores.length > 0) {
      parts.push(scoreTable("Stage 1 rubric (median of 3 samples)", l3.scores));
    }
    if (l3.stage2) {
      const s2 = l3.stage2;
      parts.push(`<p class="kv" style="margin-top:14px">Stage 2: <b>${esc(s2.scenarioName)}</b> · steps <b>${s2.stepsPassed}/${s2.stepCount}</b></p>`);
      if (s2.error) parts.push(`<p class="empty">error: ${esc(s2.error)}</p>`);
      if (s2.screenshots.length > 0) {
        parts.push(`<div class="shots">${s2.screenshots.map((sp) => shot(sp, capOf(sp), assets)).join("")}</div>`);
      }
      if (s2.layer3Scores && s2.layer3Scores.length > 0) {
        parts.push(scoreTable("Stage 2 rubric (post-toggle screen)", s2.layer3Scores));
      }
    }
    return card(p.platform, l3.pass, parts.join("\n"));
  }).join("");
  return `<section><h2>Layer 3 — semantic (Opus 4.7 vision judge)</h2>${cards}</section>`;
}

function reviewerSection(report: RunReport): string {
  const pass = report.reviewer.contractParity === "pass";
  const diffs = report.reviewer.diffs;
  const inner = diffs.length === 0
    ? `<p class="empty">No contract drift across Rails ↔ iOS ↔ Android.</p>`
    : `<details open><summary>${diffs.length} contract difference(s)</summary><pre>${esc(diffs.join("\n"))}</pre></details>`;
  return `<section><h2>Reviewer — contract parity</h2>${card("Rails ↔ iOS ↔ Android", pass, inner)}</section>`;
}

function repairSection(report: RunReport): string {
  const attempts = report.repairAttempts;
  if (!attempts || attempts.length === 0) return "";
  const rows = attempts.map((a) =>
    `<tr><td>${a.iteration}</td><td>${esc(a.failingLayer)}${a.platform ? ` (${esc(a.platform)})` : ""}</td><td>${esc(a.action)}</td><td>${a.resolved ? `<span class="mark pass">✓</span>` : `<span class="mark fail">✗</span>`}</td></tr>`,
  ).join("");
  return `<section><h2>Self-repair (≤5 iterations)</h2>
<table class="findings">
<thead><tr><th>#</th><th>Failing layer</th><th>Action</th><th>Resolved</th></tr></thead>
<tbody>${rows}</tbody>
</table></section>`;
}

function domainSection(report: RunReport): string {
  const { renamePlan, entities } = report.domain;
  const rename = renamePlan.length === 0
    ? `<p class="empty">No rename pairs.</p>`
    : `<table class="rename"><tbody>${renamePlan.map((r) => `<tr><td><code class="inline">${esc(r.from)}</code></td><td class="arrow">→</td><td><code class="inline">${esc(r.to)}</code></td></tr>`).join("")}</tbody></table>`;
  const ents = entities.length === 0
    ? ""
    : entities.map((e) => {
        const fields = e.fields.map((f) => `<code class="inline">${esc(f.name)}:${esc(f.type)}${f.references ? `→${esc(f.references)}` : ""}</code>`).join(" · ");
        const states = e.states && e.states.length > 0 ? `<br><span class="kv">states: ${e.states.map((s) => esc(s)).join(" ↔ ")}</span>` : "";
        return `<div class="card"><h3>${esc(e.name)} <span class="kv">(replaces ${esc(e.replaces)})</span></h3><p class="kv">${fields || "no fields"}</p>${states}</div>`;
      }).join("");
  return `<section><h2>Domain plan</h2>
<div class="card"><h3>Rename plan</h3>${rename}</div>
${ents}</section>`;
}

function footer(report: RunReport): string {
  const visualPrefix = report.meta.visualLevel > 0 ? `NATIVEAPPTEMPLATE_VISUAL=${report.meta.visualLevel} ` : "";
  const cmd = `${visualPrefix}npx nativeapptemplate-agent ${JSON.stringify(report.meta.spec)}`;
  return `<footer>
<p>Reproduce this run:</p>
<pre>${esc(cmd)}</pre>
<p>Raw per-agent logs: <code class="inline">tmp/trace/*.log</code> · Generated by nativeapptemplate-agent v${esc(report.meta.agentVersion)}.</p>
</footer>`;
}

// --- helpers ---

function card(title: string, pass: boolean, inner: string): string {
  const pill = pass ? `<span class="pill pass">pass</span>` : `<span class="pill fail">fail</span>`;
  return `<div class="card"><h3>${esc(title)} ${pill}</h3>${inner}</div>`;
}

function scoreTable(title: string, scores: readonly { criterionId: string; pass: boolean; rationale: string }[]): string {
  const rows = scores.map((s) =>
    `<tr><td><code>${esc(s.criterionId)}</code></td><td>${s.pass ? `<span class="mark pass">✓</span>` : `<span class="mark fail">✗</span>`}</td><td>${esc(s.rationale)}</td></tr>`,
  ).join("");
  return `<table class="scores"><thead><tr><th colspan="3">${esc(title)}</th></tr><tr><th>Criterion</th><th>Verdict</th><th>Rationale</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function shot(path: string, caption: string, assets: AssetMap): string {
  const src = assets[path];
  if (!src) {
    return `<div class="shot missing">screenshot unavailable<br><code>${esc(caption)}</code></div>`;
  }
  return `<figure class="shot"><img src="${esc(src)}" alt="${esc(caption)}"><figcaption class="cap">${esc(caption)}</figcaption></figure>`;
}

function mark(pass: boolean): string {
  return pass ? `<span class="mark pass">✓</span>` : `<span class="mark fail">✗</span>`;
}

function markNa(): string {
  return `<span class="mark na">—</span>`;
}

function capOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.png$/i, "");
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
