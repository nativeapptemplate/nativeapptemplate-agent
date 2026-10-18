import { slugToPascal } from "./slug.js";

// The app's own domain (CLI --domain, MCP generate_app `domain`). It replaces
// the template's nativeapptemplate.com, and its reverse (orangebaton.app ->
// app.orangebaton) replaces the template's com.nativeapptemplate prefix of the
// iOS bundle ID and the Android package. Without it the mechanical rename's
// defaults stand: <flat product>.com and com.<flat product>.

export type AppDomainCheck = { ok: true; domain: string } | { ok: false; error: string };

// RFC 1035 label: letters, digits and hyphens, at most 63, no hyphen at
// either end.
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateAppDomain(raw: string): AppDomainCheck {
  const domain = raw.trim().toLowerCase();
  const example = 'a bare domain such as "orangebaton.app"';
  if (domain === "") return { ok: false, error: `--domain is empty; expected ${example}` };
  if (/[/:@?#\s]/.test(domain)) {
    return { ok: false, error: `--domain "${raw}" is not a bare domain; expected ${example}, without scheme, path, port or email` };
  }
  if (domain.length > 253) return { ok: false, error: `--domain "${raw}" is longer than 253 characters` };
  const labels = domain.split(".");
  if (labels.length < 2) return { ok: false, error: `--domain "${raw}" needs at least two labels, e.g. "orangebaton.app"` };
  const bad = labels.find((l) => !DNS_LABEL.test(l));
  if (bad !== undefined) {
    const which = bad === "" ? "an empty label" : `the label "${bad}"`;
    return { ok: false, error: `--domain "${raw}" has ${which}; each label must be 1-63 letters, digits or hyphens, not starting or ending with a hyphen` };
  }
  if (/^\d+$/.test(labels[labels.length - 1]!)) {
    return { ok: false, error: `--domain "${raw}" ends in a numeric label; expected a domain name, not an IP address` };
  }
  // aapt2 requires every segment of the Android package (applicationId and
  // namespace) to start with a letter, so the JLS's "_" prefix for a leading
  // digit (com._1password) doesn't build.
  const digitLed = labels.find((l) => /^\d/.test(l));
  if (digitLed !== undefined) {
    return { ok: false, error: `--domain "${raw}" has the label "${digitLed}", which starts with a digit; Android package segments must start with a letter` };
  }
  return { ok: true, domain };
}

// Java reserved words and literals (JLS §3.9, §3.10.3, §3.10.7) plus Kotlin's
// hard keywords: the generated Android sources are Kotlin, where e.g.
// `package app.fun.x` doesn't compile.
const RESERVED_SEGMENTS = new Set([
  "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const",
  "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally", "float",
  "for", "goto", "if", "implements", "import", "instanceof", "int", "interface", "long", "native",
  "new", "package", "private", "protected", "public", "return", "short", "static", "strictfp", "super",
  "switch", "synchronized", "this", "throw", "throws", "transient", "try", "void", "volatile", "while",
  "true", "false", "null",
  "as", "fun", "in", "is", "object", "typealias", "typeof", "val", "var", "when",
]);

// A DNS label as an Android package segment, per the JLS's naming convention
// (§6.1) that Android's package names follow: hyphens become underscores and
// a reserved word gets a trailing underscore.
export function javaPackageSegment(label: string): string {
  const segment = label.replace(/-/g, "_");
  return RESERVED_SEGMENTS.has(segment) ? `${segment}_` : segment;
}

export type AppIdentifiers = {
  domain: string;
  // Whether --domain chose it (otherwise the rename's default).
  custom: boolean;
  // Reverse-DNS prefix of the iOS bundle ID: hyphens are allowed there.
  bundleIdPrefix: string;
  // Reverse-DNS prefix of the Android package (applicationId, namespace,
  // source directories, package declarations).
  androidPackagePrefix: string;
  // Labels whose Android segment differs from the label.
  androidRemapped: readonly { label: string; segment: string }[];
};

export function appIdentifiers(slug: string, domain?: string): AppIdentifiers {
  const flat = slugToPascal(slug).toLowerCase();
  const chosen = domain ?? `${flat}.com`;
  const reversed = chosen.split(".").reverse();
  const androidRemapped = reversed
    .map((label) => ({ label, segment: javaPackageSegment(label) }))
    .filter((m) => m.segment !== m.label);
  return {
    domain: chosen,
    custom: domain !== undefined,
    bundleIdPrefix: reversed.join("."),
    androidPackagePrefix: reversed.map(javaPackageSegment).join("."),
    androidRemapped,
  };
}

export function describeAppIdentifiers(ids: AppIdentifiers): string[] {
  const lines = [`domain: ${ids.domain} (iOS bundle ID prefix ${ids.bundleIdPrefix}, Android package prefix ${ids.androidPackagePrefix})`];
  for (const m of ids.androidRemapped) {
    lines.push(`domain: "${m.label}" is "${m.segment}" in the Android package (not a valid Java/Kotlin package segment as is)`);
  }
  return lines;
}

export type RenameAppDomain = { domain: string; bundleIdPrefix: string; androidPackagePrefix: string };

// rename.rb's appDomain input; absent without --domain so the rename is
// byte-for-byte the default one.
export function renameAppDomainInput(slug: string, appDomain: string | undefined): { appDomain?: RenameAppDomain } {
  if (appDomain === undefined) return {};
  const ids = appIdentifiers(slug, appDomain);
  return { appDomain: { domain: ids.domain, bundleIdPrefix: ids.bundleIdPrefix, androidPackagePrefix: ids.androidPackagePrefix } };
}

// The main app target's bundle ID in a renamed pbxproj (the one ending in
// .ios; test targets and ${SAMPLE_CODE_DISAMBIGUATOR} left out).
export function bundleIdFromPbxproj(pbxproj: string): string | undefined {
  const ids = [...pbxproj.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([A-Za-z0-9.-]+)/g)].map((m) => m[1]!);
  return ids.find((id) => id.endsWith(".ios")) ?? ids[0];
}

export function applicationIdFromGradle(buildGradle: string): string | undefined {
  return /applicationId\s*=\s*"([^"]+)"/.exec(buildGradle)?.[1];
}
