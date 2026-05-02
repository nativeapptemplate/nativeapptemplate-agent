import { resolve } from "node:path";
import { trace } from "../trace.js";
import { isStub } from "../stub.js";
import {
  extractRailsContract,
  extractAndroidEndpoints,
  extractIosEndpoints,
} from "./contract-extract.js";
import type { DomainSpec, ReviewerResult, WorkerResult } from "./types.js";

export type ReviewerInput = {
  domain: DomainSpec;
  rails: WorkerResult;
  ios: WorkerResult;
  android: WorkerResult;
};

// Phase 2: extract API surface from all three platforms — Rails OpenAPI,
// Android Retrofit interfaces, iOS Request structs — and surface counts in
// the trace + result. This proves rename left every platform's network
// layer parseable and provides the contract objects Phase 3 will use to
// detect actual drift (paths in Rails but missing from a client, methods
// that disagree, etc.).
//
// For now reviewer stays at contractParity: "pass" unless extraction itself
// fails — count mismatches alone don't fail the run, since iOS / Android
// may legitimately implement a subset of Rails endpoints (e.g. the Rails
// admin namespace isn't called from mobile clients). Phase 3 wires the
// pass/fail logic against a normalized path-level diff.
export async function runReviewer(input: ReviewerInput): Promise<ReviewerResult> {
  if (isStub("reviewer")) return runStubReviewer(input);

  const { domain, rails, ios, android } = input;
  const railsDir = resolve(process.cwd(), rails.outDir);
  const iosDir = resolve(process.cwd(), ios.outDir);
  const androidDir = resolve(process.cwd(), android.outDir);

  trace("reviewer", `extracting Rails OpenAPI from ${rails.outDir}`);
  const railsContract = await extractRailsContract(railsDir);
  if (!railsContract) {
    trace("reviewer", `${domain.displayName}: contract parity FAIL — Rails OpenAPI unreadable`);
    return {
      contractParity: "fail",
      diffs: ["rails: OpenAPI spec missing or did not parse as OpenAPI 3.x"],
    };
  }
  trace(
    "reviewer",
    `Rails: ${railsContract.endpoints.length} endpoints, ${railsContract.schemaCount} schemas, openapi=${railsContract.openapiVersion}, title="${railsContract.title}"`,
  );

  trace("reviewer", `extracting iOS Request structs from ${ios.outDir}`);
  const iosEndpoints = await extractIosEndpoints(iosDir);
  trace("reviewer", `iOS: ${iosEndpoints.length} request endpoints`);

  trace("reviewer", `extracting Android Retrofit annotations from ${android.outDir}`);
  const androidEndpoints = await extractAndroidEndpoints(androidDir);
  trace("reviewer", `Android: ${androidEndpoints.length} Retrofit endpoints`);

  trace("reviewer", "three-way diff — not yet implemented (Phase 3+)");
  trace("reviewer", `${domain.displayName}: contract parity PASS (Phase 2 extraction-only)`);

  return {
    contractParity: "pass",
    diffs: [
      `rails:openapi=${railsContract.openapiVersion}`,
      `rails:title=${railsContract.title}`,
      `rails:endpoints=${railsContract.endpoints.length}`,
      `rails:schemas=${railsContract.schemaCount}`,
      `ios:endpoints=${iosEndpoints.length}`,
      `android:endpoints=${androidEndpoints.length}`,
    ],
  };
}

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

async function runStubReviewer(input: ReviewerInput): Promise<ReviewerResult> {
  trace("reviewer", "(stub mode)");
  trace("reviewer", `extracting OpenAPI from ${input.rails.outDir}`);
  await delay(200);
  trace("reviewer", "diffing iOS networking layer against contract");
  await delay(200);
  trace("reviewer", "diffing Android repository layer against contract");
  await delay(200);
  trace("reviewer", `${input.domain.displayName}: contract parity PASS (stub)`);
  return { contractParity: "pass", diffs: [] };
}
