import Anthropic from "@anthropic-ai/sdk";
import { trace } from "../trace.js";
import { isStub } from "../stub.js";
import type { DomainSpec } from "./types.js";
import { BILLING_RESERVED, ERROR_MONITORING_RESERVED, STDLIB_RESERVED, SUBSTRATE_RESERVED } from "../reserved-words.js";
import { FALLBACK_BETA, FALLBACKS, PLANNER_EFFORT, PLANNER_MODEL } from "../models.js";
import { isValidSlug } from "../slug.js";
import { readStructuredJson, usageLine } from "../structured-output.js";

// Opus 5.5 always thinks, and thinking counts toward max_tokens: leave room
// for it on top of the DomainSpec JSON.
const MAX_TOKENS = 16000;

export const SYSTEM_PROMPT = `You are a domain modeler for a three-platform SaaS code generator. You receive a one-sentence natural-language specification of a SaaS product and output a structured DomainSpec that drives code generation across Rails 8.1 (API), SwiftUI (iOS), and Jetpack Compose (Android).

The substrate you specialize is a walk-in queue management system. Its generic types are:
- Shop (the primary tenant resource) — renamed to a domain-appropriate noun
- Shopkeeper (the user/owner) — renamed to match
- ItemTag (a queue entry with Idled/Completed states) — adapted for queue-like specs, or replaced with a new entity for non-queue specs

For queue-like specs (restaurant waitlist, walk-in clinic, barbershop queue), keep ItemTag as an adapted queue entry; rename its states only if the spec requires it.
For non-queue specs (task tracker, note-taking, inventory), propose replacing ItemTag with a new entity and include that replacement in renamePlan.

IMPORTANT — substrate-reserved vocabulary: the substrate's auth/admin layer already uses these tokens as unrelated identifiers, so rename targets MUST NOT collide with them (a lexical rename would produce duplicate-identifier build errors):

  ${SUBSTRATE_RESERVED.join(", ")}

IMPORTANT — billing-reserved vocabulary: the substrate's subscription layer (RevenueCat) already uses these tokens — its own type names (SubscriptionRepository, PaywallView, SubscriptionPlan, FreeTrial…) and the RevenueCat / StoreKit / Play Billing types it calls — so rename targets MUST NOT collide with them either:

  ${BILLING_RESERVED.join(", ")}

IMPORTANT — error-monitoring-reserved vocabulary: the substrate's error monitoring layer (Sentry) already uses these tokens — its own type names (ErrorReporter, ErrorReport, ErrorReporting), the template's logging Event type, and the Sentry SDK names it calls — so rename targets MUST NOT collide with them either:

  ${ERROR_MONITORING_RESERVED.join(", ")}

IMPORTANT — language-stdlib-reserved vocabulary: the generated code must compile in Swift, Kotlin, and Ruby. A rename target that collides with any of these standard-library types silently shadows the stdlib and breaks compilation (e.g. Task.isCancelled no longer resolves if Task is shadowed):

${Object.entries(STDLIB_RESERVED).map(([lang, words]) => `  ${lang} — ${words.join(", ")}`).join("\n")}

For Shopkeeper, prefer domain-distinctive nouns: Assignee, Maintainer, Host, Vet, Barber, Stylist, Staff, Curator, Editor, Author — NOT Owner / User / Admin.
For Shop, prefer: Clinic, Restaurant, Workspace, Project, Board, Journal, Space, Studio — NOT Account / Store / Event.
For ItemTag replacements, prefer: Todo, Ticket, Entry, Card, Issue, Note, Memo, Patient, Reservation — NOT Task (Swift Concurrency) / Actor (Swift Concurrency) / Scan / Notification.

For the Shop and ItemTag renames, also give toJa: the natural Japanese noun a Japanese app would use for the target, e.g. Clinic → 医院, Restaurant → 店, Patient → 患者, Reservation → 予約. The substrate's Japanese messages use 店舗 (Shop) and アイテムタグ (ItemTag), and toJa replaces them as a plain substring, so it must be a bare noun (no particles, no 様/さん) that reads naturally before 名, は and を, as in 医院名, 医院は3件まで作成できます. Omit toJa for other renames.

Never emit identity rename pairs (from === to). If the target happens to equal the source, pick a different target.

slug must be kebab-case and filesystem-safe. Keep entities tight (2-4 per spec). Keep jsonApiContract minimal — a later reviewer sub-agent expands it.`;

// JSON schema for the planner's structured output (output_config.format).
// Structured outputs need additionalProperties: false on every object and
// don't support `pattern`, so the slug rule lives in the description and is
// checked after parsing (isValidSlug).
export const DOMAIN_SPEC_SCHEMA = {
  type: "object",
  properties: {
    slug: {
      type: "string",
      description: "kebab-case filesystem slug matching ^[a-z0-9][a-z0-9-]*$, e.g. 'clinic-queue'",
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
              additionalProperties: false,
            },
          },
          states: {
            type: "array",
            items: { type: "string" },
            description: "Optional state-machine states for this entity",
          },
        },
        required: ["name", "replaces", "fields"],
        additionalProperties: false,
      },
    },
    renamePlan: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "string", description: "Substrate token, e.g. 'Shop'" },
          to: { type: "string", description: "Replacement token, e.g. 'Clinic'" },
          toJa: { type: "string", description: "Shop and ItemTag only: the Japanese noun for the target, e.g. '医院'" },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
    },
    jsonApiContract: {
      type: "object",
      description: "Placeholder JSON:API contract object; empty {} for now (a later reviewer sub-agent expands it)",
      properties: {},
      additionalProperties: false,
    },
  },
  required: ["slug", "displayName", "entities", "renamePlan", "jsonApiContract"],
  additionalProperties: false,
} as const;

// The Messages API request the planner sends. Exported so tests can check
// its shape without a network call. Opus 5.5 rejects forced tool_choice, so
// the DomainSpec comes back as structured output instead of a tool call.
export function buildPlannerRequest(spec: string): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
  return {
    model: PLANNER_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: {
      effort: PLANNER_EFFORT,
      format: { type: "json_schema", schema: DOMAIN_SPEC_SCHEMA as unknown as Record<string, unknown> },
    },
    betas: [FALLBACK_BETA],
    fallbacks: FALLBACKS,
    messages: [{ role: "user", content: spec }],
  };
}

// Turns the planner's response into a DomainSpec, failing loudly on a
// refusal, a truncated response, or a slug that breaks the contract.
export function parsePlannerResponse(response: Anthropic.Beta.Messages.BetaMessage): DomainSpec {
  const domain = readStructuredJson(response, "planner") as DomainSpec;
  if (typeof domain.slug !== "string" || !isValidSlug(domain.slug)) {
    throw new Error(`planner: invalid slug ${JSON.stringify(domain.slug)} (must match ^[a-z0-9][a-z0-9-]*$)`);
  }
  return domain;
}

export async function runPlanner(spec: string): Promise<DomainSpec> {
  trace("planner", `received spec: "${spec}"`);

  if (isStub("planner")) {
    return runStubPlanner(spec);
  }

  // Prefer a dedicated workspace key when set so the agent's spend, rate
  // limits, and revocability are isolated from the user's other Anthropic
  // SDK / Claude Code usage. Falls back to ANTHROPIC_API_KEY for the
  // single-key default path.
  const apiKey = process.env['NATIVEAPPTEMPLATE_AGENT_ANTHROPIC_KEY'] ?? process.env['ANTHROPIC_API_KEY'];
  const client = new Anthropic({ apiKey });
  trace("planner", `calling ${PLANNER_MODEL} (effort ${PLANNER_EFFORT}) to extract domain`);

  const response = await client.beta.messages.create(buildPlannerRequest(spec));
  const domain = parsePlannerResponse(response);
  trace("planner", `derived slug: ${domain.slug}`);
  trace("planner", `rename plan: ${domain.renamePlan.map((r) => `${r.from}->${r.to}${r.toJa ? ` (${r.toJa})` : ""}`).join(", ")}`);
  trace("planner", `entities: ${domain.entities.map((e) => e.name).join(", ")}`);
  trace("planner", usageLine(response, PLANNER_MODEL));
  trace("planner", "done");

  return domain;
}

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

async function runStubPlanner(spec: string): Promise<DomainSpec> {
  trace("planner", "(stub mode — NATIVEAPPTEMPLATE_STUB_ALL or NATIVEAPPTEMPLATE_STUB_PLANNER set)");
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
      { from: "Shop", to: "Clinic", toJa: "医院" },
      { from: "Shopkeeper", to: "Vet" },
    ],
    jsonApiContract: {},
  };
}
