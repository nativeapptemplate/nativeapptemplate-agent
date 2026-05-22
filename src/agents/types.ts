import type { Layer1Finding } from "../validation/layer1.js";

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

export type AgentName = "planner" | Platform | "reviewer" | "judge" | "dispatch";

export type WorkerResult = {
  platform: Platform;
  outDir: string;
  filesTouched: number;
  renamedFrom: readonly string[];
};

export type ReviewerResult = {
  contractParity: "pass" | "fail";
  diffs: readonly string[];
};

export type JudgeResult = {
  overallPass: boolean;
  summary: string;
  visual?: VisualJudgeReport;
  // Structured per-platform/per-layer detail. Optional and additive:
  // existing consumers (CLI summary, MCP) ignore it. Populated by the
  // real judge; the stub path omits it. This is the data the validation
  // report (docs/validation-report.md) renders from.
  platforms?: readonly PlatformDetail[];
};

export type PlatformDetail = {
  platform: Platform;
  layer1: { pass: boolean; findings: readonly Layer1Finding[] };
  layer2: {
    pass: boolean;
    command: string;
    mode: "fast" | "build";
    exitCode: number | null;
    durationMs: number;
    stderrTail?: string;
  };
  layer3?: VisualJudgePlatformReport;
};

export type VisualJudgeReport = {
  ios?: VisualJudgePlatformReport;
  android?: VisualJudgePlatformReport;
};

export type VisualJudgePlatformReport = {
  pass: boolean;
  screenshotPath?: string;
  scores?: readonly { criterionId: string; pass: boolean; rationale: string }[];
  error?: string;
  stage2?: Stage2PlatformReport;
};

export type Stage2PlatformReport = {
  pass: boolean;
  scenarioName: string;
  stepCount: number;
  stepsPassed: number;
  screenshots: readonly string[];
  representativeScreenshot?: string;
  layer3Scores?: readonly { criterionId: string; pass: boolean; rationale: string }[];
  error?: string;
};
