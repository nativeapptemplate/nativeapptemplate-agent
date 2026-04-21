import { trace } from "../trace.js";
import type { DomainSpec } from "./types.js";

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

export async function runPlanner(spec: string): Promise<DomainSpec> {
  trace("planner", `received spec: "${spec}"`);
  await delay(200);
  trace("planner", "extracting entities and fields");
  await delay(250);
  trace("planner", "choosing rename plan: Shop -> Clinic, Shopkeeper -> Vet");
  await delay(200);
  trace("planner", "freezing JSON:API contract");
  await delay(150);
  trace("planner", "done");

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
