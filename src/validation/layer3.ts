import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { isStub } from "../stub.js";
import { trace } from "../trace.js";
import { FALLBACK_BETA, FALLBACKS, JUDGE_EFFORT, JUDGE_MODEL } from "../models.js";
import { readStructuredJson, usageLine } from "../structured-output.js";
import { recordMessageUsage } from "../usage.js";

export type Layer3Criterion = {
  id: string;
  question: string;
};

export type Layer3Input = {
  screenshotPath: string;
  rubric: readonly Layer3Criterion[];
  spec: string;
  model?: string;
  samplesPerCriterion?: number;
};

export type Layer3Score = {
  criterionId: string;
  pass: boolean;
  rationale: string;
};

export type Layer3Result = {
  pass: boolean;
  scores: Layer3Score[];
};

const DEFAULT_SAMPLES = 3;
// Opus 5.5 always thinks, and thinking counts toward max_tokens: leave room
// for it on top of the short verdict JSON.
const MAX_TOKENS = 8192;

const SYSTEM_PROMPT = `You are a vision judge for a SaaS code generator. You receive a one-sentence natural-language spec describing a SaaS product and a screenshot of a generated app's home screen, and you assess one rubric criterion at a time.

Score conservatively: when in doubt, answer No. Base the verdict ONLY on what is visible in the screenshot — do not assume features that aren't shown.`;

// JSON schema for the judge's structured output (output_config.format).
// Opus 5.5 rejects forced tool_choice, so the verdict is the response body
// instead of a submit_verdict tool call.
export const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    pass: {
      type: "boolean",
      description: "true if the criterion is met based on what is visible in the screenshot; false otherwise. Be conservative — when uncertain, answer false.",
    },
    rationale: {
      type: "string",
      description: "One-sentence rationale grounded in what is visible.",
    },
  },
  required: ["pass", "rationale"],
  additionalProperties: false,
} as const;

// The Messages API request for one judge sample. Exported so tests can check
// its shape without a network call.
export function buildJudgeRequest(
  model: string,
  imageBase64: string,
  spec: string,
  criterion: Layer3Criterion,
): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: {
      effort: JUDGE_EFFORT,
      format: { type: "json_schema", schema: VERDICT_SCHEMA as unknown as Record<string, unknown> },
    },
    betas: [FALLBACK_BETA],
    fallbacks: FALLBACKS,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: imageBase64 },
            cache_control: { type: "ephemeral" },
          },
          {
            type: "text",
            text: `Spec: ${spec}\n\nCriterion: ${criterion.question}`,
          },
        ],
      },
    ],
  };
}

// Reads one verdict, failing loudly on a refusal, a truncated response, or a
// malformed verdict.
export function parseVerdict(response: Anthropic.Beta.Messages.BetaMessage): { pass: boolean; rationale: string } {
  const verdict = readStructuredJson(response, "layer3 judge") as { pass: unknown; rationale: unknown };
  if (typeof verdict.pass !== "boolean" || typeof verdict.rationale !== "string") {
    throw new Error("layer3 judge: malformed verdict: " + JSON.stringify(verdict));
  }
  return { pass: verdict.pass, rationale: verdict.rationale };
}

export async function runLayer3(input: Layer3Input): Promise<Layer3Result> {
  if (isStub("judge")) return runStubLayer3(input);

  const samplesPerCriterion = input.samplesPerCriterion ?? DEFAULT_SAMPLES;
  const model = input.model ?? JUDGE_MODEL;

  const png = await readFile(input.screenshotPath);
  const imageBase64 = png.toString("base64");

  const apiKey = process.env['NATIVEAPPTEMPLATE_AGENT_ANTHROPIC_KEY'] ?? process.env['ANTHROPIC_API_KEY'];
  const client = new Anthropic({ apiKey });

  // Every sample shares the cached prefix (system prompt + screenshot); only
  // the criterion text after the breakpoint differs. Calls sent at the same
  // time all miss the cache and each write it, so judge one sample first to
  // write it, then send the rest together to read it (0.1× input instead of
  // 1.25×).
  const judge = (criterion: Layer3Criterion) => judgeOne(client, model, imageBase64, input.spec, criterion);
  const jobs = input.rubric.flatMap((criterion) => Array.from({ length: samplesPerCriterion }, () => criterion));
  const verdicts = await firstThenTogether(jobs, judge);

  const scores: Layer3Score[] = input.rubric.map((criterion, index) => {
    const samples = verdicts.slice(index * samplesPerCriterion, (index + 1) * samplesPerCriterion);
    const passCount = samples.filter((s) => s.pass).length;
    const median = passCount > samplesPerCriterion / 2;
    const winningSample = samples.find((s) => s.pass === median) ?? samples[0]!;
    return {
      criterionId: criterion.id,
      pass: median,
      rationale: winningSample.rationale,
    };
  });

  const pass = scores.every((s) => s.pass);
  return { pass, scores };
}

// Runs `run` on the first item alone, then on the rest at once; results keep
// the input order. Lets the first call write a prompt cache the others read.
export async function firstThenTogether<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const [first, ...rest] = items;
  if (first === undefined) return [];
  const head = await run(first);
  return [head, ...(await Promise.all(rest.map(run)))];
}

async function judgeOne(
  client: Anthropic,
  model: string,
  imageBase64: string,
  spec: string,
  criterion: Layer3Criterion,
): Promise<{ pass: boolean; rationale: string }> {
  const response = await client.beta.messages.create(buildJudgeRequest(model, imageBase64, spec, criterion));
  trace("judge", `layer3 ${criterion.id}: ${usageLine(response, model)}`);
  recordMessageUsage("judge", response, model);
  return parseVerdict(response);
}

async function runStubLayer3(input: Layer3Input): Promise<Layer3Result> {
  return {
    pass: true,
    scores: input.rubric.map((c) => ({
      criterionId: c.id,
      pass: true,
      rationale: "(stub)",
    })),
  };
}
