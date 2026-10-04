import { cp, lstat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export type CopySkipRules = {
  // Paths relative to the substrate root, e.g. "vendor/bundle".
  rootPaths?: readonly string[];
  // Directory or file names skipped at any depth, e.g. "build".
  anySegment?: readonly string[];
};

export async function copySubstrate(src: string, dest: string, rules: CopySkipRules): Promise<void> {
  const rootPaths = rules.rootPaths ?? [];
  const anySegment = new Set(rules.anySegment ?? []);
  const root = resolve(src);
  await cp(root, dest, {
    recursive: true,
    force: true,
    // Default cp rewrites relative symlinks as absolute paths into the
    // substrate, so a later in-place rewrite of out/ would edit the substrate.
    verbatimSymlinks: true,
    filter: async (source: string) => {
      const segments = relative(root, source).split(sep).filter(Boolean);
      const rel = segments.join("/");
      if (rootPaths.some((p) => rel === p || rel.startsWith(`${p}/`))) return false;
      if (segments.some((seg) => anySegment.has(seg))) return false;
      try {
        const s = await lstat(source);
        if (s.isSocket() || s.isFIFO() || s.isBlockDevice() || s.isCharacterDevice()) return false;
      } catch {
        return false;
      }
      return true;
    },
  });
}
