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
