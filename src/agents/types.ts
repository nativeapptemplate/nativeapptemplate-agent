export type DomainSpec = {
  slug: string;
  displayName: string;
  entities: readonly Entity[];
  renamePlan: readonly RenamePair[];
  jsonApiContract: unknown;
};

export type Entity = {
  name: string;
  replaces: string;
  fields: readonly Field[];
  states?: readonly string[];
};

export type Field = {
  name: string;
  type: "string" | "integer" | "boolean" | "datetime" | "reference";
  references?: string;
};

export type RenamePair = {
  from: string;
  to: string;
};

export type Platform = "rails" | "ios" | "android";

export type AgentName = "planner" | Platform | "reviewer" | "judge";

export type WorkerResult = {
  platform: Platform;
  outDir: string;
  filesTouched: number;
};

export type ReviewerResult = {
  contractParity: "pass" | "fail";
  diffs: readonly string[];
};

export type JudgeResult = {
  overallPass: boolean;
  summary: string;
};
