import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentName } from "./agents/types.js";

const traceDir = resolve(process.cwd(), "tmp/trace");
let dirEnsured = false;

export function trace(agent: AgentName, text: string): void {
  if (!dirEnsured) {
    mkdirSync(traceDir, { recursive: true });
    dirEnsured = true;
  }
  const ts = new Date().toISOString().slice(11, 19);
  appendFileSync(resolve(traceDir, `${agent}.log`), `[${ts}] ${text}\n`);
}
