import type { AgentName } from "./agents/types.js";

export function isStub(agent: AgentName): boolean {
  if (process.env['NATEMPLATE_STUB_ALL'] === "1") return true;
  return process.env[`NATEMPLATE_STUB_${agent.toUpperCase()}`] === "1";
}
