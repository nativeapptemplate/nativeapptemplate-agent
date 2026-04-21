import { trace } from "../../trace.js";
import type { DomainSpec, WorkerResult } from "../types.js";

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

export async function runAndroidWorker(domain: DomainSpec): Promise<WorkerResult> {
  const plan = domain.renamePlan.map((p) => `${p.from}->${p.to}`).join(", ");
  trace("android", `copying Jetpack Compose substrate for ${domain.displayName}`);
  await delay(200);
  trace("android", `renaming Kotlin symbols: ${plan}`);
  await delay(300);
  trace("android", "regenerating data classes + Hilt modules");
  await delay(250);
  trace("android", "updating res/values/strings.xml");
  await delay(200);
  trace("android", `done (out/${domain.slug}/android)`);

  return {
    platform: "android",
    outDir: `./out/${domain.slug}/android`,
    filesTouched: 81,
  };
}
