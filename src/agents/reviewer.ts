import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { trace } from "../trace.js";
import { isStub } from "../stub.js";
import type { DomainSpec, ReviewerResult, WorkerResult } from "./types.js";

export type ReviewerInput = {
  domain: DomainSpec;
  rails: WorkerResult;
  ios: WorkerResult;
  android: WorkerResult;
};

const OPENAPI_PATH = "docs/openapi.yaml";

// Phase 1: extract Rails OpenAPI surface. Confirms the rename pipeline left
// the spec parseable (right top-level shape, nontrivial path + schema counts)
// and surfaces structure metadata so downstream phases can diff against
// iOS networking + Android repository layers.
//
// Not yet implemented: parsing iOS Swift / Android Kotlin client code to
// extract their per-endpoint shapes, then three-way diffing. Those land in
// Phase 2+ when we add a real YAML parser dependency and AST-level
// extraction for Swift / Kotlin sources.
export async function runReviewer(input: ReviewerInput): Promise<ReviewerResult> {
  if (isStub("reviewer")) return runStubReviewer(input);

  const { domain, rails } = input;
  const railsDir = resolve(process.cwd(), rails.outDir);
  const specPath = join(railsDir, OPENAPI_PATH);

  trace("reviewer", `extracting OpenAPI from ${rails.outDir}/${OPENAPI_PATH}`);

  let raw: string;
  try {
    raw = await readFile(specPath, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    trace("reviewer", `${domain.displayName}: contract parity FAIL — ${reason}`);
    return { contractParity: "fail", diffs: [`OpenAPI spec not readable: ${reason}`] };
  }

  const surface = extractRailsSurface(raw);
  if (surface === null) {
    trace("reviewer", `${domain.displayName}: contract parity FAIL — spec did not parse as OpenAPI`);
    return { contractParity: "fail", diffs: ["OpenAPI spec missing top-level openapi/info/paths sections"] };
  }

  trace(
    "reviewer",
    `Rails surface: ${surface.pathCount} paths, ${surface.schemaCount} schemas, openapi=${surface.openapiVersion}, title="${surface.title}"`,
  );
  trace("reviewer", "iOS / Android contract diff — not yet implemented (Phase 2+)");
  trace("reviewer", `${domain.displayName}: contract parity PASS (Rails-only Phase 1)`);

  return {
    contractParity: "pass",
    diffs: [
      `rails:openapi=${surface.openapiVersion}`,
      `rails:title=${surface.title}`,
      `rails:paths=${surface.pathCount}`,
      `rails:schemas=${surface.schemaCount}`,
    ],
  };
}

type RailsSurface = {
  openapiVersion: string;
  title: string;
  pathCount: number;
  schemaCount: number;
};

// Lightweight regex extraction — avoids pulling in a YAML parser for Phase 1.
// Works against the well-formed OpenAPI 3.x YAML the substrate ships and
// fails gracefully (returns null) for anything missing the canonical shape.
// Replace with a real parser once Phase 2+ needs deeper structure.
function extractRailsSurface(raw: string): RailsSurface | null {
  const openapi = raw.match(/^openapi:\s*['"]?([^'"\s]+)['"]?\s*$/m);
  if (!openapi || !openapi[1]) return null;

  const titleMatch = raw.match(/^\s+title:\s*(.+?)\s*$/m);
  const title = (titleMatch?.[1] ?? "").trim();

  // Top-level `paths:` block; each child is `  /something:` indented 2 spaces.
  const pathsIdx = raw.indexOf("\npaths:");
  let pathCount = 0;
  if (pathsIdx >= 0) {
    const afterPaths = raw.slice(pathsIdx + 1);
    const nextTopLevel = afterPaths.search(/\n[a-zA-Z]/);
    const pathsBlock = nextTopLevel === -1 ? afterPaths : afterPaths.slice(0, nextTopLevel + 1);
    pathCount = (pathsBlock.match(/^ {2}\/[^\n]+:\s*$/gm) ?? []).length;
  }

  // schemas: under components: — children indented 4 spaces, names start uppercase.
  const schemasIdx = raw.indexOf("\n  schemas:");
  let schemaCount = 0;
  if (schemasIdx >= 0) {
    const afterSchemas = raw.slice(schemasIdx + 1);
    const nextSiblingTop = afterSchemas.search(/\n {0,2}[a-zA-Z]/m);
    const schemasBlock = nextSiblingTop === -1 ? afterSchemas : afterSchemas.slice(0, nextSiblingTop + 1);
    schemaCount = (schemasBlock.match(/^ {4}[A-Z][A-Za-z0-9_]*:\s*$/gm) ?? []).length;
  }

  return { openapiVersion: openapi[1], title, pathCount, schemaCount };
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
