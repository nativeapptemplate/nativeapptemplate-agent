import { trace } from "../../trace.js";
import type { DomainSpec, WorkerResult } from "../types.js";

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

export async function runIosWorker(domain: DomainSpec): Promise<WorkerResult> {
  const plan = domain.renamePlan.map((p) => `${p.from}->${p.to}`).join(", ");
  trace("ios", `copying SwiftUI substrate for ${domain.displayName}`);
  await delay(200);
  trace("ios", `renaming Swift symbols: ${plan}`);
  await delay(300);
  trace("ios", "regenerating @Observable view models");
  await delay(250);
  trace("ios", "updating Localizable.strings");
  await delay(200);
  trace("ios", `done (out/${domain.slug}/ios)`);

  return {
    platform: "ios",
    outDir: `./out/${domain.slug}/ios`,
    filesTouched: 63,
  };
}
