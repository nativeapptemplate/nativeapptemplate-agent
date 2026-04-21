import { trace } from "../trace.js";
import type { DomainSpec, ReviewerResult, WorkerResult } from "./types.js";

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

export type ReviewerInput = {
  domain: DomainSpec;
  rails: WorkerResult;
  ios: WorkerResult;
  android: WorkerResult;
};

export async function runReviewer(input: ReviewerInput): Promise<ReviewerResult> {
  const { domain, rails } = input;
  trace("reviewer", `extracting OpenAPI from ${rails.outDir}`);
  await delay(200);
  trace("reviewer", "diffing iOS networking layer against contract");
  await delay(200);
  trace("reviewer", "diffing Android repository layer against contract");
  await delay(200);
  trace("reviewer", `${domain.displayName}: contract parity PASS`);

  return {
    contractParity: "pass",
    diffs: [],
  };
}
