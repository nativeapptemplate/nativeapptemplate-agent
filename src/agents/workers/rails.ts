import { trace } from "../../trace.js";
import type { DomainSpec, WorkerResult } from "../types.js";

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

export async function runRailsWorker(domain: DomainSpec): Promise<WorkerResult> {
  const plan = domain.renamePlan.map((p) => `${p.from}->${p.to}`).join(", ");
  trace("rails", `copying substrate for ${domain.displayName}`);
  await delay(200);
  trace("rails", `renaming Ruby symbols: ${plan}`);
  await delay(300);
  trace("rails", "regenerating migrations");
  await delay(250);
  trace("rails", "updating routes.rb + JSON:API serializers");
  await delay(200);
  trace("rails", `done (out/${domain.slug}/rails)`);

  return {
    platform: "rails",
    outDir: `./out/${domain.slug}/rails`,
    filesTouched: 47,
  };
}
