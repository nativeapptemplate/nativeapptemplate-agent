import { resolve } from "node:path";
import { trace } from "../trace.js";
import { isStub } from "../stub.js";
import {
  extractRailsContract,
  extractAndroidEndpoints,
  extractIosEndpoints,
  diffContracts,
  type ContractDiff,
  type Endpoint,
} from "./contract-extract.js";
import type { DomainSpec, ReviewerResult, WorkerResult } from "./types.js";

export type ReviewerInput = {
  domain: DomainSpec;
  rails: WorkerResult;
  ios: WorkerResult;
  android: WorkerResult;
};

// Phase 3: extract from all three platforms (Rails OpenAPI, iOS Request
// structs, Android Retrofit interfaces), canonicalize their path encodings
// (strip tenant {account_id}, /api/v<N>, role segment, normalize path-param
// names), then diff.
//
// Pass/fail policy:
//   - PASS  if every iOS and Android endpoint maps to a Rails endpoint AND
//           the two mobile clients implement the same set.
//   - FAIL  if any mobile-orphan exists (client calls something Rails
//           doesn't expose — runtime 404), or if iOS and Android implement
//           different subsets ("mobile clients must agree" per project USP).
//   - rails-only endpoints are informational (admin / server-only routes
//     that aren't supposed to be called from mobile).
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

  const iosEndpoints = await extractIosEndpoints(iosDir);
  const androidEndpoints = await extractAndroidEndpoints(androidDir);
  trace("reviewer", `iOS: ${iosEndpoints.length} request endpoints`);
  trace("reviewer", `Android: ${androidEndpoints.length} Retrofit endpoints`);

  const role = deriveRole(domain);
  const diff = diffContracts(railsContract.endpoints, iosEndpoints, androidEndpoints, { role });

  const summary = formatDiffSummary(diff);
  for (const line of summary) trace("reviewer", line);

  const fatalCount =
    diff.iosOrphan.length + diff.androidOrphan.length + diff.iosOnly.length + diff.androidOnly.length;

  const baseDiffs: string[] = [
    `rails:openapi=${railsContract.openapiVersion}`,
    `rails:title=${railsContract.title}`,
    `rails:endpoints=${railsContract.endpoints.length}`,
    `rails:schemas=${railsContract.schemaCount}`,
    `ios:endpoints=${iosEndpoints.length}`,
    `android:endpoints=${androidEndpoints.length}`,
    `role=${role}`,
    `rails-only=${diff.railsOnly.length}`,
    `ios-orphan=${diff.iosOrphan.length}`,
    `android-orphan=${diff.androidOrphan.length}`,
    `ios-only=${diff.iosOnly.length}`,
    `android-only=${diff.androidOnly.length}`,
  ];
  const findings: string[] = [
    ...formatFindings("ios-orphan", diff.iosOrphan),
    ...formatFindings("android-orphan", diff.androidOrphan),
    ...formatFindings("ios-only", diff.iosOnly),
    ...formatFindings("android-only", diff.androidOnly),
  ];

  if (fatalCount > 0) {
    trace("reviewer", `${domain.displayName}: contract parity FAIL — ${fatalCount} drift(s)`);
    return { contractParity: "fail", diffs: [...baseDiffs, ...findings] };
  }

  trace("reviewer", `${domain.displayName}: contract parity PASS`);
  return { contractParity: "pass", diffs: [...baseDiffs, ...findings] };
}

function deriveRole(domain: DomainSpec): string {
  const pair = domain.renamePlan.find((p) => p.from === "Shopkeeper");
  return (pair?.to ?? "Shopkeeper").toLowerCase();
}

function formatDiffSummary(diff: ContractDiff): string[] {
  const lines: string[] = [];
  lines.push(
    `diff: rails-only=${diff.railsOnly.length}, ios-orphan=${diff.iosOrphan.length}, android-orphan=${diff.androidOrphan.length}, ios-only=${diff.iosOnly.length}, android-only=${diff.androidOnly.length}`,
  );
  if (diff.iosOrphan.length > 0) lines.push(`iOS calls endpoints not in Rails: ${preview(diff.iosOrphan)}`);
  if (diff.androidOrphan.length > 0) lines.push(`Android calls endpoints not in Rails: ${preview(diff.androidOrphan)}`);
  if (diff.iosOnly.length > 0) lines.push(`iOS-only (Android missing): ${preview(diff.iosOnly)}`);
  if (diff.androidOnly.length > 0) lines.push(`Android-only (iOS missing): ${preview(diff.androidOnly)}`);
  return lines;
}

function formatFindings(label: string, endpoints: readonly Endpoint[]): string[] {
  return endpoints.map((e) => `${label}:${e.method} ${e.path}`);
}

function preview(endpoints: readonly Endpoint[], max: number = 3): string {
  const sample = endpoints.slice(0, max).map((e) => `${e.method} ${e.path}`).join(", ");
  return endpoints.length > max ? `${sample}, ... (+${endpoints.length - max} more)` : sample;
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
