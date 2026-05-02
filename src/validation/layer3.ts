import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { isStub } from "../stub.js";

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

const DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_SAMPLES = 3;
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT = `You are a vision judge for a SaaS code generator. You receive a one-sentence natural-language spec describing a SaaS product and a screenshot of a generated app's home screen, and you assess one rubric criterion at a time.

Score conservatively: when in doubt, answer No. Base the verdict ONLY on what is visible in the screenshot — do not assume features that aren't shown.`;

const VERDICT_TOOL: Anthropic.Tool = {
  name: "submit_verdict",
  description: "Record the Yes/No verdict and one-sentence rationale for this rubric criterion.",
  input_schema: {
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
  },
};

export async function runLayer3(input: Layer3Input): Promise<Layer3Result> {
  if (isStub("judge")) return runStubLayer3(input);

  const samplesPerCriterion = input.samplesPerCriterion ?? DEFAULT_SAMPLES;
  const model = input.model ?? DEFAULT_MODEL;

  const png = await readFile(input.screenshotPath);
  const imageBase64 = png.toString("base64");

  const apiKey = process.env['NATIVEAPPTEMPLATE_AGENT_ANTHROPIC_KEY'] ?? process.env['ANTHROPIC_API_KEY'];
  const client = new Anthropic({ apiKey });

  const scores: Layer3Score[] = await Promise.all(
    input.rubric.map(async (criterion) => {
      const samples = await Promise.all(
        Array.from({ length: samplesPerCriterion }, () =>
          judgeOne(client, model, imageBase64, input.spec, criterion),
        ),
      );
      const passCount = samples.filter((s) => s.pass).length;
      const median = passCount > samplesPerCriterion / 2;
      const winningSample = samples.find((s) => s.pass === median) ?? samples[0]!;
      return {
        criterionId: criterion.id,
        pass: median,
        rationale: winningSample.rationale,
      };
    }),
  );

  const pass = scores.every((s) => s.pass);
  return { pass, scores };
}

async function judgeOne(
  client: Anthropic,
  model: string,
  imageBase64: string,
  spec: string,
  criterion: Layer3Criterion,
): Promise<{ pass: boolean; rationale: string }> {
  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools: [VERDICT_TOOL],
    tool_choice: { type: "tool", name: "submit_verdict" },
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
  });

  const toolUse = response.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("layer3 judge: expected tool_use in response, got: " + JSON.stringify(response.content));
  }

  const verdict = toolUse.input as { pass: boolean; rationale: string };
  if (typeof verdict.pass !== "boolean" || typeof verdict.rationale !== "string") {
    throw new Error("layer3 judge: malformed verdict: " + JSON.stringify(verdict));
  }
  return verdict;
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
