#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dispatch } from "./dispatch.js";
import { loadDotenvIfPresent } from "./env.js";

loadDotenvIfPresent();

export async function main(spec?: string): Promise<void> {
  const input = spec ?? process.argv.slice(2).join(" ").trim();
  if (!input) {
    console.error('Usage: nativeapptemplate-agent "your spec here"');
    process.exitCode = 1;
    return;
  }

  console.log(`nativeapptemplate-agent: received spec: ${input}`);
  console.log('(tail tmp/trace/*.log in a tiled view via scripts/demo-tmux.sh)');

  const result = await dispatch(input);

  console.log('');
  console.log('=== run complete ===');
  console.log(`result: ${result.summary}`);
  console.log(`overall: ${result.overallPass ? 'PASS' : 'FAIL'}`);
}

// Entry guard: run main() when this file is the program entry point. Resolve
// both sides to canonical (symlink-followed) paths so npm bin symlinks (e.g.
// node_modules/.bin/nativeapptemplate-agent → ../nativeapptemplate-agent/dist/
// index.js) compare equal to import.meta.url. Without realpath, the guard
// fails silently on symlinked invocations and main() never runs — the CLI
// would exit 0 with no output.
if (isEntryPoint()) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const modulePath = fileURLToPath(import.meta.url);
    const argv1Real = realpathSync(argv1);
    return argv1Real === modulePath;
  } catch {
    return false;
  }
}
