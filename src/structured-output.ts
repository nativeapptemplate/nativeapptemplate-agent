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
export function usageLine(response: BetaMessage, requestedModel: string): string {
  const servedBy = response.model !== requestedModel ? ` (served by ${response.model})` : "";
  return `usage: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out${servedBy}`;
}
