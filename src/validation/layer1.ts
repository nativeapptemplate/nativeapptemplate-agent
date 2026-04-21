import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, basename } from "node:path";

export type Layer1Input = {
  projectDir: string;
  forbiddenTokens: readonly string[];
};

export type Layer1Finding = {
  token: string;
  file: string;
  line: number;
  text: string;
};

export type Layer1Result = {
  pass: boolean;
  findings: Layer1Finding[];
};

const TEXT_EXTS = new Set([
  ".rb", ".erb", ".yml", ".yaml", ".json", ".md", ".gemspec", ".rake", ".ru",
  ".txt", ".sample", ".example", ".conf", ".html", ".css", ".scss", ".js", ".mjs",
  ".tt", ".lock",
  ".swift", ".plist", ".strings", ".xcconfig", ".entitlements", ".pbxproj",
  ".xcworkspacedata", ".modulemap",
  ".kt", ".kts", ".xml", ".gradle", ".pro", ".toml", ".properties", ".cfg",
]);

const TEXT_BASENAMES = new Set([
  "Gemfile", "Gemfile.lock", "Rakefile", "Procfile", "Procfile.dev",
  "config.ru", "Dockerfile",
  "Podfile", "Podfile.lock", "Package.swift", "Cartfile", "Makefile",
  "gradlew", "gradlew.bat", "gradle.properties", "local.properties",
]);

const SKIP_SEGMENTS = new Set([
  ".git", "node_modules", "tmp", "log", "vendor",
  "DerivedData", "Pods", "Carthage", "xcuserdata", ".build",
  "build", ".gradle", ".idea", ".kotlin", "captures",
]);

export async function runLayer1(input: Layer1Input): Promise<Layer1Result> {
  if (input.forbiddenTokens.length === 0) {
    return { pass: true, findings: [] };
  }

  const root = await realRoot(input.projectDir);
  if (!root) {
    return { pass: false, findings: [] };
  }

  const regex = buildRegex(input.forbiddenTokens);
  const findings: Layer1Finding[] = [];

  for await (const filePath of walk(root)) {
    const content = await safeRead(filePath);
    if (!content) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(line)) !== null) {
        findings.push({
          token: m[0],
          file: relative(root, filePath),
          line: i + 1,
          text: line,
        });
      }
    }
  }

  return { pass: findings.length === 0, findings };
}

async function realRoot(dir: string): Promise<string | null> {
  try {
    const s = await stat(dir);
    return s.isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

function buildRegex(tokens: readonly string[]): RegExp {
  const escaped = tokens.map(escapeRegex).join("|");
  return new RegExp(`(?:${escaped})`, "g");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_SEGMENTS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && isTextFile(full)) {
      yield full;
    }
  }
}

function isTextFile(path: string): boolean {
  const base = basename(path);
  if (TEXT_BASENAMES.has(base)) return true;
  return TEXT_EXTS.has(extname(path));
}

async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
