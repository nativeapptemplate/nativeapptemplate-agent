// Inline stylesheet for the validation report. Palette matches
// docs/social-preview.svg (light-blue vivid) for brand coherence.
// No web fonts, no external assets — the report is a single portable
// file. Kept as a plain string so render.ts stays pure.
export const REPORT_CSS = `
:root {
  --bg: #1f2933;
  --bg-2: #0b69a3;
  --panel: #243441;
  --panel-2: #1b2a38;
  --border: #3e4c59;
  --text: #f5f7fa;
  --muted: #9aa5b1;
  --accent: #40c3f7;
  --accent-2: #2bb0ed;
  --pass: #34d399;
  --fail: #f87171;
  --na: #52606d;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: linear-gradient(160deg, var(--bg) 0%, #14202a 60%, #0e1820 100%);
  color: var(--text);
  line-height: 1.5;
  padding: 32px 20px 80px;
}
.wrap { max-width: 1100px; margin: 0 auto; }
a { color: var(--accent); }
header.report-head {
  border-bottom: 1px solid var(--border);
  padding-bottom: 20px;
  margin-bottom: 28px;
}
.badge {
  display: inline-block;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 1px;
  padding: 6px 14px;
  border-radius: 20px;
  text-transform: uppercase;
}
.badge.pass { background: rgba(52,211,153,0.16); color: var(--pass); border: 1px solid rgba(52,211,153,0.4); }
.badge.fail { background: rgba(248,113,113,0.16); color: var(--fail); border: 1px solid rgba(248,113,113,0.4); }
h1 { font-size: 30px; font-weight: 800; letter-spacing: -0.5px; margin: 14px 0 4px; }
.spec { color: var(--muted); font-size: 16px; margin: 0 0 12px; }
.spec b { color: var(--text); font-weight: 600; }
.meta { color: var(--muted); font-size: 13px; font-family: "SF Mono", Menlo, monospace; }
.meta span { margin-right: 16px; white-space: nowrap; }
section { margin: 30px 0; }
h2 {
  font-size: 13px; text-transform: uppercase; letter-spacing: 1.2px;
  color: var(--accent); margin: 0 0 14px; font-weight: 700;
}
.gates { display: flex; flex-wrap: wrap; gap: 12px; }
.gate {
  flex: 1 1 160px; background: var(--panel); border: 1px solid var(--border);
  border-radius: 12px; padding: 14px 16px;
}
.gate .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.6px; }
.gate .value { font-size: 22px; font-weight: 800; margin-top: 4px; }
.gate.pass .value { color: var(--pass); }
.gate.fail .value { color: var(--fail); }
.gate.muted .value { color: var(--muted); font-size: 15px; font-weight: 600; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
.matrix th, .matrix td { padding: 10px 12px; text-align: center; border: 1px solid var(--border); }
.matrix th:first-child, .matrix td:first-child { text-align: left; font-weight: 600; }
.matrix thead th { background: var(--panel-2); color: var(--muted); font-weight: 600; text-transform: uppercase; font-size: 12px; letter-spacing: 0.5px; }
.mark { font-weight: 800; font-size: 16px; }
.mark.pass { color: var(--pass); }
.mark.fail { color: var(--fail); }
.mark.na { color: var(--na); }
.card {
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 12px; padding: 16px 18px; margin-bottom: 14px;
}
.card h3 { margin: 0 0 10px; font-size: 16px; display: flex; align-items: center; gap: 10px; }
.pill { font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
.pill.pass { background: rgba(52,211,153,0.16); color: var(--pass); }
.pill.fail { background: rgba(248,113,113,0.16); color: var(--fail); }
.findings th, .findings td { padding: 7px 10px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: top; }
.findings th { color: var(--muted); font-weight: 600; }
.findings code, code.inline { font-family: "SF Mono", Menlo, monospace; font-size: 12px; color: var(--accent); }
.kv { font-family: "SF Mono", Menlo, monospace; font-size: 13px; color: var(--muted); }
.kv b { color: var(--text); font-weight: 600; }
.empty { color: var(--muted); font-style: italic; font-size: 13px; }
details { margin-top: 10px; }
summary { cursor: pointer; color: var(--accent); font-size: 13px; }
pre {
  background: #0d1820; border: 1px solid var(--border); border-radius: 8px;
  padding: 12px; overflow-x: auto; font-size: 12px; color: #cbd2d9; margin: 10px 0 0;
}
.shots { display: flex; flex-wrap: wrap; gap: 14px; margin: 12px 0; }
.shot { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--panel-2); }
.shot img { display: block; max-width: 240px; height: auto; }
.shot .cap { font-size: 11px; color: var(--muted); padding: 6px 8px; font-family: "SF Mono", Menlo, monospace; }
.shot.missing { padding: 24px; color: var(--muted); font-size: 12px; font-style: italic; max-width: 240px; }
.scores th, .scores td { padding: 7px 10px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: top; }
.scores th { color: var(--muted); font-weight: 600; }
.rename td { padding: 7px 10px; border-bottom: 1px solid var(--border); font-size: 13px; }
.rename .arrow { color: var(--muted); padding: 0 8px; }
footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; }
footer pre { color: var(--text); }
@media (max-width: 640px) {
  .gate { flex-basis: 100%; }
  .shot img { max-width: 100%; }
}
@media print {
  body { background: #fff; color: #111; }
  .card, .gate { break-inside: avoid; }
}
`;
