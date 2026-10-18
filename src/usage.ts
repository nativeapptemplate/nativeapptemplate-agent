import { AsyncLocalStorage } from "node:async_hooks";
import type Anthropic from "@anthropic-ai/sdk";
import { OPUS_MODEL, OPUS_PRICE_PER_MTOK } from "./models.js";
import type { TokenUsage } from "./structured-output.js";

export type CostAgent = "planner" | "judge" | "repair";

export type AgentCost = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  usd: number;
};

// One run's API spend, as report.json carries it. An estimate: Messages API
// calls are priced from their token counts at list price, the repair agent's
// cost is the Agent SDK's own total_cost_usd (same rules as scripts/cost.sh).
export type RunCost = {
  currency: "USD";
  estimatedUsd: number;
  calls: number;
  byAgent: Partial<Record<CostAgent, AgentCost>>;
  // Calls a refusal fallback answered on another model. Still priced at the
  // requested model's rates, as cost.sh does.
  fallbackCalls?: number;
  pricing: { model: string; perMTok: typeof OPUS_PRICE_PER_MTOK };
};

type Ledger = {
  byAgent: Partial<Record<CostAgent, AgentCost>>;
  fallbackCalls: number;
};

// Per run, not per process: the MCP server can serve several generate_app
// calls, and the smoke tests call dispatch() many times in one process.
const ledgerStore = new AsyncLocalStorage<Ledger>();

export function withUsageLedger<T>(fn: () => Promise<T>): Promise<T> {
  return ledgerStore.run({ byAgent: {}, fallbackCalls: 0 }, fn);
}

export function recordMessageUsage(agent: "planner" | "judge", response: Anthropic.Beta.Messages.BetaMessage, requestedModel: string): void {
  const ledger = ledgerStore.getStore();
  if (!ledger) return;
  if (response.model !== requestedModel) ledger.fallbackCalls += 1;
  add(ledger, agent, response.usage, priceOf(response.usage));
}

export function recordSdkCost(totalCostUsd: number, usage: TokenUsage): void {
  const ledger = ledgerStore.getStore();
  if (!ledger) return;
  add(ledger, "repair", usage, totalCostUsd);
}

// Undefined outside a ledger or when the run made no API call (stub mode).
export function currentRunCost(): RunCost | undefined {
  const ledger = ledgerStore.getStore();
  if (!ledger) return undefined;
  const agents = Object.values(ledger.byAgent);
  const calls = agents.reduce((n, a) => n + a.calls, 0);
  if (calls === 0) return undefined;
  const byAgent: Partial<Record<CostAgent, AgentCost>> = {};
  for (const [agent, cost] of Object.entries(ledger.byAgent) as [CostAgent, AgentCost][]) {
    byAgent[agent] = { ...cost, usd: roundUsd(cost.usd) };
  }
  return {
    currency: "USD",
    estimatedUsd: roundUsd(agents.reduce((sum, a) => sum + a.usd, 0)),
    calls,
    byAgent,
    ...(ledger.fallbackCalls > 0 ? { fallbackCalls: ledger.fallbackCalls } : {}),
    pricing: { model: OPUS_MODEL, perMTok: OPUS_PRICE_PER_MTOK },
  };
}

export function priceOf(usage: TokenUsage): number {
  const rates = OPUS_PRICE_PER_MTOK;
  return (
    usage.input_tokens * rates.input +
    usage.output_tokens * rates.output +
    (usage.cache_creation_input_tokens ?? 0) * rates.cacheWrite5m +
    (usage.cache_read_input_tokens ?? 0) * rates.cacheRead
  ) / 1_000_000;
}

function add(ledger: Ledger, agent: CostAgent, usage: TokenUsage, usd: number): void {
  const cost = ledger.byAgent[agent] ??= { calls: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, usd: 0 };
  cost.calls += 1;
  cost.inputTokens += usage.input_tokens;
  cost.outputTokens += usage.output_tokens;
  cost.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
  cost.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  cost.usd += usd;
}

// Four decimals, as cost.sh prints.
function roundUsd(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}
