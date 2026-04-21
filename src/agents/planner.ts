import Anthropic from "@anthropic-ai/sdk";
import { trace } from "../trace.js";
import { isStub } from "../stub.js";
import type { DomainSpec } from "./types.js";

const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 4096;

const SYSTEM_PROMPT = `You are a domain modeler for a three-platform SaaS code generator. You receive a one-sentence natural-language specification of a SaaS product and output a structured DomainSpec that drives code generation across Rails 8.1 (API), SwiftUI (iOS), and Jetpack Compose (Android).

The substrate you specialize is a walk-in queue management system. Its generic types are:
- Shop (the primary tenant resource) — renamed to a domain-appropriate noun
- Shopkeeper (the user/owner) — renamed to match
- ItemTag (a queue entry with Idled/Completed states) — adapted for queue-like specs, or replaced with a new entity for non-queue specs

For queue-like specs (restaurant waitlist, walk-in clinic, barbershop queue), keep ItemTag as an adapted queue entry; rename its states only if the spec requires it.
For non-queue specs (task tracker, note-taking, inventory), propose replacing ItemTag with a new entity and include that replacement in renamePlan.

slug must be kebab-case and filesystem-safe. Keep entities tight (2-4 per spec). Keep jsonApiContract minimal — a later reviewer sub-agent expands it.`;

const DOMAIN_TOOL: Anthropic.Messages.Tool = {
  name: "submit_domain_spec",
  description: "Submit the parsed DomainSpec for downstream code generation.",
  input_schema: {
    type: "object",
    properties: {
      slug: {
        type: "string",
        pattern: "^[a-z0-9][a-z0-9-]*$",
        description: "kebab-case filesystem slug, e.g. 'clinic-queue'",
      },
      displayName: {
        type: "string",
        description: "Human-readable name, e.g. 'Clinic Queue'",
      },
      entities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Entity name in PascalCase" },
            replaces: { type: "string", description: "Which substrate type this replaces: Shop, Shopkeeper, or ItemTag" },
            fields: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  type: { type: "string", enum: ["string", "integer", "boolean", "datetime", "reference"] },
                  references: { type: "string", description: "If type=reference, the target entity name" },
                },
                required: ["name", "type"],
              },
            },
            states: {
              type: "array",
              items: { type: "string" },
              description: "Optional state-machine states for this entity",
            },
          },
          required: ["name", "replaces", "fields"],
        },
      },
      renamePlan: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: { type: "string", description: "Substrate token, e.g. 'Shop'" },
            to: { type: "string", description: "Replacement token, e.g. 'Clinic'" },
          },
          required: ["from", "to"],
        },
      },
      jsonApiContract: {
        type: "object",
        description: "Placeholder JSON:API contract object; can be empty {} for now",
      },
    },
    required: ["slug", "displayName", "entities", "renamePlan", "jsonApiContract"],
  },
};

export async function runPlanner(spec: string): Promise<DomainSpec> {
  trace("planner", `received spec: "${spec}"`);

  if (isStub("planner")) {
    return runStubPlanner(spec);
  }

  const client = new Anthropic();
  trace("planner", `calling ${MODEL} to extract domain`);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools: [DOMAIN_TOOL],
    tool_choice: { type: "tool", name: "submit_domain_spec" },
    messages: [{ role: "user", content: spec }],
  });

  const toolUse = response.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("planner: expected tool_use in response, got: " + JSON.stringify(response.content));
  }

  const domain = toolUse.input as DomainSpec;
  trace("planner", `derived slug: ${domain.slug}`);
  trace("planner", `rename plan: ${domain.renamePlan.map((r) => `${r.from}->${r.to}`).join(", ")}`);
  trace("planner", `entities: ${domain.entities.map((e) => e.name).join(", ")}`);
  trace("planner", `usage: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`);
  trace("planner", "done");

  return domain;
}

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

async function runStubPlanner(spec: string): Promise<DomainSpec> {
  trace("planner", "(stub mode — NATEMPLATE_STUB_ALL or NATEMPLATE_STUB_PLANNER set)");
  await delay(200);
  trace("planner", "extracting entities and fields");
  await delay(250);
  trace("planner", "choosing rename plan: Shop -> Clinic, Shopkeeper -> Vet");
  await delay(200);
  trace("planner", "freezing JSON:API contract");
  await delay(150);
  trace("planner", "done");
  void spec;

  return {
    slug: "clinic-queue",
    displayName: "Clinic Queue",
    entities: [],
    renamePlan: [
      { from: "Shop", to: "Clinic" },
      { from: "Shopkeeper", to: "Vet" },
    ],
    jsonApiContract: {},
  };
}
