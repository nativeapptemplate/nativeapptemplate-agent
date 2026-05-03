import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type Endpoint = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
};

export type ContractDiff = {
  // Endpoints in Rails not implemented by EITHER mobile client. Informational
  // only — Rails has admin / server-only endpoints that aren't called from
  // mobile apps; this list helps surface what's available but unused.
  railsOnly: Endpoint[];
  // Endpoints called by a mobile client that Rails doesn't expose. Real
  // failure: client will get 404 at runtime.
  iosOrphan: Endpoint[];
  androidOrphan: Endpoint[];
  // Endpoints implemented by exactly one mobile client. Real failure if
  // both should be in feature parity (per "mobile clients must agree").
  iosOnly: Endpoint[];
  androidOnly: Endpoint[];
};

export type CanonicalizationContext = {
  // Lowercased rename target for "Shopkeeper" — the API role segment in the
  // URL (`/vet/...` for Vet, `/shopkeeper/...` for the unrenamed substrate).
  // Defaults to "shopkeeper" if the rename plan doesn't include Shopkeeper.
  role: string;
};

const TENANT_PLACEHOLDER = "{account_id}";
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const OPENAPI_PARAM_RE = /^\{[^}]+\}$/;
const SWIFT_INTERPOLATION_RE = /^\\\([^)]+\)$/;

// Strip tenant prefix, /api/v1, role segment, and normalize path parameter
// names to {*} so the three platforms' encodings reduce to the same
// comparable string. Rails OpenAPI server URLs (e.g. `/api/v1/vet`) are
// already factored out by extractRailsContract, so Rails endpoints arrive
// here with just the per-operation path.
export function canonicalizeEndpoint(
  endpoint: Endpoint,
  ctx: CanonicalizationContext,
): Endpoint {
  const role = ctx.role.toLowerCase();
  const segments = endpoint.path.split("/").filter(Boolean);

  // Drop tenant segment (literal placeholder or runtime UUID).
  if (segments[0] === TENANT_PLACEHOLDER || (segments[0] && UUID_RE.test(segments[0]))) {
    segments.shift();
  }
  // Drop /api/v<N>/.
  if (segments[0] === "api") {
    segments.shift();
    if (segments[0] && /^v\d+$/.test(segments[0])) segments.shift();
  }
  // Drop role segment.
  if (segments[0] === role) segments.shift();

  // Normalize path-param names to {*} so {shopId} === {id} === \(id).
  const normalized = segments.map((s) =>
    OPENAPI_PARAM_RE.test(s) || SWIFT_INTERPOLATION_RE.test(s) ? "{*}" : s,
  );

  return { method: endpoint.method, path: "/" + normalized.join("/") };
}

// Three-way diff. Endpoints are first canonicalized so cross-platform
// encoding differences don't show up as drift.
export function diffContracts(
  rails: readonly Endpoint[],
  ios: readonly Endpoint[],
  android: readonly Endpoint[],
  ctx: CanonicalizationContext,
): ContractDiff {
  const canon = (e: Endpoint) => canonicalizeEndpoint(e, ctx);
  const key = (e: Endpoint) => `${e.method} ${e.path}`;

  const railsSet = new Map(rails.map(canon).map((e) => [key(e), e]));
  const iosSet = new Map(ios.map(canon).map((e) => [key(e), e]));
  const androidSet = new Map(android.map(canon).map((e) => [key(e), e]));

  const railsOnly: Endpoint[] = [];
  for (const [k, e] of railsSet) {
    if (!iosSet.has(k) && !androidSet.has(k)) railsOnly.push(e);
  }
  const iosOrphan: Endpoint[] = [];
  for (const [k, e] of iosSet) {
    if (!railsSet.has(k)) iosOrphan.push(e);
  }
  const androidOrphan: Endpoint[] = [];
  for (const [k, e] of androidSet) {
    if (!railsSet.has(k)) androidOrphan.push(e);
  }
  const iosOnly: Endpoint[] = [];
  for (const [k, e] of iosSet) {
    if (railsSet.has(k) && !androidSet.has(k)) iosOnly.push(e);
  }
  const androidOnly: Endpoint[] = [];
  for (const [k, e] of androidSet) {
    if (railsSet.has(k) && !iosSet.has(k)) androidOnly.push(e);
  }

  return { railsOnly, iosOrphan, androidOrphan, iosOnly, androidOnly };
}

export type RailsContract = {
  openapiVersion: string;
  title: string;
  endpoints: Endpoint[];
  schemaCount: number;
};

const HTTP_METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// Rails: parse out/<slug>/rails/docs/openapi.yaml. Returns null if the file
// is missing or doesn't have the canonical OpenAPI 3.x shape.
export async function extractRailsContract(railsDir: string): Promise<RailsContract | null> {
  const specPath = join(railsDir, "docs", "openapi.yaml");
  let raw: string;
  try {
    raw = await readFile(specPath, "utf8");
  } catch {
    return null;
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;
  const openapiVersion = typeof doc["openapi"] === "string" ? doc["openapi"] : null;
  if (!openapiVersion) return null;

  const info = isRecord(doc["info"]) ? doc["info"] : {};
  const title = typeof info["title"] === "string" ? info["title"] : "";

  const paths = isRecord(doc["paths"]) ? doc["paths"] : {};
  const endpoints: Endpoint[] = [];
  for (const [path, value] of Object.entries(paths)) {
    if (!isRecord(value)) continue;
    for (const verb of Object.keys(value)) {
      const upper = verb.toUpperCase();
      if (HTTP_METHODS.has(upper)) {
        endpoints.push({ method: upper as Endpoint["method"], path });
      }
    }
  }

  const components = isRecord(doc["components"]) ? doc["components"] : {};
  const schemas = isRecord(components["schemas"]) ? components["schemas"] : {};
  const schemaCount = Object.keys(schemas).length;

  return { openapiVersion, title, endpoints, schemaCount };
}

// Android: walk app/src/main/kotlin/**/data/**/*Api.kt, extract Retrofit
// annotations (@GET("path"), @POST("path"), etc.). The substrate's auth
// data layer also lives under data/login/, so capture all *Api.kt under
// data/.
export async function extractAndroidEndpoints(androidDir: string): Promise<Endpoint[]> {
  const dataDir = join(androidDir, "app", "src", "main", "kotlin");
  const apiFiles = await collectFiles(dataDir, (path) => /\/data\/.*Api\.kt$/.test(path));

  const endpoints: Endpoint[] = [];
  const re = /@(GET|POST|PUT|PATCH|DELETE)\(\s*"([^"]+)"\s*\)/g;
  for (const file of apiFiles) {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    let match;
    while ((match = re.exec(raw)) !== null) {
      endpoints.push({ method: match[1] as Endpoint["method"], path: match[2]! });
    }
  }
  return endpoints;
}

// iOS: walk **/Networking/**/*Request.swift and Login/*Request.swift, where
// each struct has matched `var method: HTTPMethod { .METHOD }` and
// `var path: String { "..." }` getters. Pair them by struct order.
export async function extractIosEndpoints(iosDir: string): Promise<Endpoint[]> {
  const appDir = await findAppRoot(iosDir);
  if (!appDir) return [];
  const requestFiles = await collectFiles(appDir, (path) => /Request\.swift$/.test(path));

  const endpoints: Endpoint[] = [];
  for (const file of requestFiles) {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    endpoints.push(...parseSwiftRequests(raw));
  }
  return endpoints;
}

function parseSwiftRequests(raw: string): Endpoint[] {
  // Split on `struct ... {` boundaries; within each chunk, find the first
  // `.METHOD` enum reference and the first `"..."` string literal that follows
  // a `var path` declaration. Crude but robust for the substrate's layout.
  const structs = raw.split(/\nstruct\s+\w+\b/).slice(1);
  const out: Endpoint[] = [];
  for (const chunk of structs) {
    const methodMatch = chunk.match(/var\s+method:\s*HTTPMethod\s*\{\s*\.(GET|POST|PUT|PATCH|DELETE)\s*\}/);
    const pathMatch = chunk.match(/var\s+path:\s*String\s*\{\s*"([^"]+)"\s*\}/);
    if (methodMatch && pathMatch) {
      out.push({ method: methodMatch[1] as Endpoint["method"], path: pathMatch[1]! });
    }
  }
  return out;
}

async function findAppRoot(iosDir: string): Promise<string | null> {
  const entries = await readdir(iosDir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isDirectory() && !e.name.endsWith(".xcodeproj") && !e.name.endsWith("Tests") && !e.name.startsWith(".")) {
      const candidate = join(iosDir, e.name);
      const sub = await readdir(candidate).catch(() => [] as string[]);
      if (sub.some((n) => n === "Networking" || n === "Login")) return candidate;
    }
  }
  return null;
}

async function collectFiles(root: string, predicate: (path: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === ".git" || e.name === "build" || e.name === ".gradle" || e.name === "Pods") continue;
        await walk(full);
      } else if (predicate(full)) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
