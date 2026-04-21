import { dispatch } from "./dispatch.js";

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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
