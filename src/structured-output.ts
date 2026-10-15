import type Anthropic from "@anthropic-ai/sdk";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;

// Reads the JSON body of a structured-output (`output_config.format`)
// response. Checks stop_reason before touching content: a refusal may carry
// no text at all, and a max_tokens cut leaves truncated JSON.
export function readStructuredJson(response: BetaMessage, label: string): unknown {
  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category ?? "unknown";
    throw new Error(`${label}: request was declined (stop_reason refusal, category ${category})`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(`${label}: response hit max_tokens before the JSON was complete`);
  }

  const text = response.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (text.trim() === "") {
    throw new Error(`${label}: expected JSON text in response, got: ${JSON.stringify(response.content)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: response is not valid JSON (${String(error)}): ${text.slice(0, 200)}`);
  }
}

// One trace line per call: tokens, plus the model that actually answered
// (differs from the requested one when a refusal fallback served it).
// Cache writes/reads are billed separately from input_tokens (the judge's
// screenshot is cached, so most of its tokens land there); scripts/cost.sh
// parses this exact shape, so keep all four fields even when zero.
export function usageLine(response: BetaMessage, requestedModel: string): string {
  const servedBy = response.model !== requestedModel ? ` (served by ${response.model})` : "";
  return `usage: ${tokenCounts(response.usage)}${servedBy}`;
}

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

// "<in> in / <out> out / <write> cache-write / <read> cache-read"
export function tokenCounts(usage: TokenUsage): string {
  const write = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  return `${usage.input_tokens} in / ${usage.output_tokens} out / ${write} cache-write / ${read} cache-read`;
}
