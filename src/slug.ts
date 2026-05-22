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
// DOMAIN_TOOL slug pattern so a manual --slug override obeys the same contract
// the planner does (it drives the output dir, DB prefix, and Pascal project
// name via slugToPascal).
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}
