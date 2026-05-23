export function slugToPascal(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

export function slugToSnake(slug: string): string {
  return slug.replace(/-/g, "_");
}

// Kebab-case, filesystem-safe, leading alphanumeric. Mirrors the planner's
// DOMAIN_TOOL slug pattern so a derived/overridden slug obeys the same contract
// the planner does (it drives the output dir, DB prefix, and Pascal project
// name via slugToPascal).
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

// Split a free-form project name into words: on whitespace / hyphen /
// underscore AND camelCase / PascalCase boundaries. So "Vet Clinic",
// "VetClinic", "vet-clinic", and "vet_clinic" all tokenize to [vet, clinic].
function tokenizeProjectName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean);
}

// Derive a kebab-case slug from a human/Pascal project name. The CLI's
// --project-name accepts any of the forms above; this gives the canonical slug
// that drives the output dir, DB prefix, env-bridge token, and (via
// slugToPascal) the Pascal project name across all three platforms.
export function projectNameToSlug(name: string): string {
  return tokenizeProjectName(name).map((w) => w.toLowerCase()).join("-");
}

// Derive the human-readable display name ("Vet Clinic") from the same input,
// so --project-name also sets domain.displayName coherently.
export function projectNameToDisplayName(name: string): string {
  return tokenizeProjectName(name)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
