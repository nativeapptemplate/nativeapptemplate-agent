import type { AgentName } from "./agents/types.js";

export function isStub(agent: AgentName): boolean {
  if (process.env['NATIVEAPPTEMPLATE_STUB_ALL'] === "1") return true;
  return process.env[`NATIVEAPPTEMPLATE_STUB_${agent.toUpperCase()}`] === "1";
}
