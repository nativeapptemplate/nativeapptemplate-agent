import { query } from "@anthropic-ai/claude-agent-sdk";
import { trace } from "../trace.js";
import { isStub } from "../stub.js";
import type { DomainSpec, Platform } from "./types.js";

const MODEL = "claude-opus-4-7";

// Which validation layer this repair attempt targets. Layer 1 (leftover
// substrate tokens) and Layer 2 (build/compile failures) are the
// code-repairable, cheaply re-checkable layers. Layer 3 (vision) and the
// contract reviewer are surfaced but not auto-repaired in this loop.
export type RepairLayer = "layer1" | "layer2";

export type RepairTarget = {
  platform: Platform;
  // Absolute path to out/<slug>/<platform> — the repair agent's cwd. It
  // edits only inside this generated project, never the substrate.
  outDir: string;
  layer: RepairLayer;
  // Failure context handed to the agent: the leftover-token findings
  // (layer1) or the compiler stderr tail (layer2).
  detail: string;
  // Layer 1 only: the substrate tokens that must not remain.
  forbiddenTokens?: readonly string[];
};

export type RepairOutcome = {
  // A short, human-readable summary of what the agent changed, shown in
  // the report's self-repair table. Whether the fix actually worked is
  // decided by re-validation, not by this string.
  action: string;
};

// One repair pass over a single failing platform. Drives the Claude Agent
// SDK's agentic loop (Read/Edit/Bash) scoped to the generated project, then
// returns a summary. The caller re-validates and records resolved/unresolved.
export async function runRepair(target: RepairTarget, domain: DomainSpec): Promise<RepairOutcome> {
  if (isStub("repair")) return runStubRepair(target);

  const apiKey = process.env["NATIVEAPPTEMPLATE_AGENT_ANTHROPIC_KEY"] ?? process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    return { action: "skipped — no Anthropic API key in env" };
  }

  trace("repair", `${target.platform}/${target.layer}: invoking repair agent in ${target.outDir}`);

  // Layer 2 may need to re-run the compiler to confirm; Layer 1 is a pure
  // source edit, so it gets no shell.
  const allowedTools =
    target.layer === "layer2"
      ? ["Read", "Edit", "Grep", "Glob", "Bash"]
      : ["Read", "Edit", "Grep", "Glob"];

  const response = query({
    prompt: buildPrompt(target, domain),
    options: {
      cwd: target.outDir,
      model: MODEL,
      systemPrompt: SYSTEM_PROMPT,
      allowedTools,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: target.layer === "layer2" ? 40 : 20,
      // Hermetic: don't inherit the developer's ~/.claude settings, project
      // CLAUDE.md, or custom agents — the repair agent runs only with the
      // system prompt below.
      settingSources: [],
      env: { ...stringEnv(process.env), ANTHROPIC_API_KEY: apiKey },
    },
  });

  let action = `attempted ${target.layer} fix`;
  let turns = 0;
  for await (const message of response) {
    if (message.type === "result") {
      turns = message.num_turns;
      if (message.subtype === "success" && !message.is_error) {
        action = firstLine(message.result) || action;
      } else {
        action = `repair agent did not converge (${message.subtype})`;
      }
    }
  }

  trace("repair", `${target.platform}/${target.layer}: ${turns} turns — ${action}`);
  return { action };
}

const SYSTEM_PROMPT = `You are a repair agent for a generated three-platform SaaS project (Rails 8.1 API, SwiftUI iOS, Jetpack Compose Android). A generated project failed one validation layer; your job is to make the smallest correct edit that fixes it. You operate ONLY inside the current working directory (one generated platform project) — never touch any other path.

Two failure classes:
- Layer 1 (structural): leftover substrate tokens (e.g. Shop, Shopkeeper, ItemTag, NativeAppTemplate and derived forms) survived the rename. Replace each remaining occurrence with its renamed equivalent, consistently, preserving case style (PascalCase→PascalCase, snake_case→snake_case). Do not rename anything that is NOT a substrate token. Do not introduce a token that collides with a language/framework reserved word.
- Layer 2 (runtime): the project failed to build/compile. Read the compiler error, find the root cause, and fix it with a minimal, idiomatic change.

Known-cryptic failure modes — slow down and verify rather than pattern-match:
- Jetpack Compose compilation errors (often a missing import, a @Composable context mismatch, or a type-inference failure).
- Hilt dependency-injection errors (missing @Inject / @Provides / module binding, or a scope mismatch).

Make targeted edits; do not refactor unrelated code, add dependencies, or rewrite files wholesale. When done, reply with ONE concise sentence describing exactly what you changed.`;

function buildPrompt(target: RepairTarget, domain: DomainSpec): string {
  const renamePlan = domain.renamePlan.map((r) => `${r.from} → ${r.to}`).join(", ");
  if (target.layer === "layer1") {
    const forbidden = (target.forbiddenTokens ?? []).join(", ");
    return `This generated ${target.platform} project still contains leftover substrate tokens that must not appear. Forbidden tokens: ${forbidden || "(see findings)"}. The intended renames are: ${renamePlan}.

Leftover findings (token · file:line · excerpt):
${target.detail}

Replace every leftover occurrence with its renamed equivalent, then confirm none remain.`;
  }
  return `This generated ${target.platform} project failed to build. The intended domain renames were: ${renamePlan}.

Compiler error (stderr tail):
${target.detail}

Diagnose and fix the root cause with a minimal edit. If you have a shell available, you may re-run the build to confirm, but keep it bounded.`;
}

// process.env is Record<string, string | undefined>; the SDK env option
// wants string values only. Drop undefined entries.
function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

async function runStubRepair(target: RepairTarget): Promise<RepairOutcome> {
  trace("repair", `(stub mode) ${target.platform}/${target.layer}`);
  await delay(50);
  return { action: `stub repair: no-op for ${target.platform} ${target.layer}` };
}
