import { cp, lstat, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { scrubbedEnv } from "../../env.js";

export type CopySkipRules = {
  // Paths relative to the substrate root, e.g. "vendor/bundle".
  rootPaths?: readonly string[];
  // Directory or file names skipped at any depth, e.g. "build".
  anySegment?: readonly string[];
  // Name endings skipped at any depth, e.g. ".xcresult".
  anySuffix?: readonly string[];
  // Root-relative paths the generated app needs although the template's git
  // ignores them (local config the developer set up, e.g. API.local.xcconfig).
  // Still subject to the skip rules above.
  keepIgnored?: readonly string[];
  // Root-relative files carried as the substrate's git has them staged,
  // never as its working tree has them: the template commits placeholder
  // values there and the developer may drop their own in locally (e.g.
  // under `git update-index --skip-worktree`). Left out entirely when the
  // substrate isn't in git or doesn't track the file.
  committedOnly?: readonly string[];
};

// Sentry's local credentials, gitignored in the templates: sentry-cli's auth
// token (.sentryclirc, sentry.properties). Never carried into a generated app,
// whatever the platform, so an upload can't run with the template developer's
// token against their Sentry project.
export const SENTRY_CREDENTIAL_FILES: readonly string[] = [".sentryclirc", "sentry.properties"];

// A template working tree also holds whatever its builds, tests and IDE left
// there (iOS build/ and TestResults.xcresult, Gradle build/ dirs, Rails logs,
// private docs). When the substrate is a git work tree, copy only what its git
// would commit — tracked files plus new files that aren't ignored — so its own
// .gitignore decides, and nothing has to be listed here per artifact. A
// substrate outside git falls back to the skip rules alone.
export async function copySubstrate(src: string, dest: string, rules: CopySkipRules): Promise<void> {
  const rootPaths = rules.rootPaths ?? [];
  const anySegment = new Set(rules.anySegment ?? []);
  const anySuffix = rules.anySuffix ?? [];
  const keepIgnored = rules.keepIgnored ?? [];
  const committedOnly = rules.committedOnly ?? [];
  const root = resolve(src);
  const committable = await gitCommittablePaths(root);
  await cp(root, dest, {
    recursive: true,
    force: true,
    // Default cp rewrites relative symlinks as absolute paths into the
    // substrate, so a later in-place rewrite of out/ would edit the substrate.
    verbatimSymlinks: true,
    filter: async (source: string) => {
      const segments = relative(root, source).split(sep).filter(Boolean);
      const rel = segments.join("/");
      if (committedOnly.includes(rel)) return false;
      if (rootPaths.some((p) => rel === p || rel.startsWith(`${p}/`))) return false;
      if (segments.some((seg) => anySegment.has(seg))) return false;
      if (segments.some((seg) => anySuffix.some((suffix) => seg.endsWith(suffix)))) return false;
      if (committable && rel !== "" && !committable.has(rel)) {
        if (!keepIgnored.some((p) => rel === p || rel.startsWith(`${p}/`) || p.startsWith(`${rel}/`))) return false;
      }
      try {
        const s = await lstat(source);
        if (s.isSocket() || s.isFIFO() || s.isBlockDevice() || s.isCharacterDevice()) return false;
      } catch {
        return false;
      }
      return true;
    },
  });
  for (const rel of committedOnly) {
    if (!committable?.has(rel)) continue;
    // "./" makes git resolve the path from cwd, which may sit below the
    // repository root.
    const staged = await gitBytes(root, ["show", `:./${rel}`]);
    if (staged === null) continue;
    const target = join(dest, ...rel.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, staged);
  }
}

// Every committable file under root plus each directory on the way to one, as
// root-relative "/" paths; null when root isn't in a git work tree (or git is
// missing), so the caller falls back to the skip rules.
async function gitCommittablePaths(root: string): Promise<Set<string> | null> {
  const listing = await gitOutput(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (listing === null) return null;
  const paths = new Set<string>();
  for (const file of listing.split("\0").filter(Boolean)) {
    const parts = file.split("/");
    for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join("/"));
  }
  return paths;
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string | null> {
  const bytes = await gitBytes(cwd, args);
  return bytes === null ? null : bytes.toString("utf8");
}

function gitBytes(cwd: string, args: readonly string[]): Promise<Buffer | null> {
  return new Promise((done) => {
    const child = spawn("git", [...args], { cwd, env: scrubbedEnv(), stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", () => done(null));
    child.on("close", (code) => done(code === 0 ? Buffer.concat(chunks) : null));
  });
}
