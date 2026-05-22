import type { PlatformDetail } from "../agents/types.js";

// The single aggregate the validation report renders from. Assembled by
// dispatch (src/report/collect.ts#buildRunReport) and serialized to
// report.json; renderReport is a pure function of it. See
// docs/validation-report.md.
export type RunReport = {
  meta: RunMeta;
  overallPass: boolean;
  summary: string;
  platforms: readonly PlatformDetail[];
  reviewer: {
    contractParity: "pass" | "fail";
    diffs: readonly string[];
  };
  domain: {
    renamePlan: readonly { from: string; to: string }[];
    entities: readonly RunReportEntity[];
  };
  // Populated once the self-repair loop is wired (CLAUDE.md ≤5 cap).
  // Rendered only when present.
  repairAttempts?: readonly RepairAttempt[];
};

export type RunMeta = {
  spec: string;
  slug: string;
  displayName: string;
  agentVersion: string;
  judgeModel: string;
  visualLevel: 0 | 1 | 2;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

export type RunReportEntity = {
  name: string;
  replaces: string;
  fields: readonly { name: string; type: string; references?: string }[];
  states?: readonly string[];
};

export type RepairAttempt = {
  iteration: number;
  failingLayer: "layer1" | "layer2" | "layer3" | "reviewer";
  platform?: "rails" | "ios" | "android";
  action: string;
  resolved: boolean;
};

// Maps an original screenshot file path to a render-ready <img src>
// value — a `data:` URI when embedded, or a relative path when
// externalized to report-assets/. Built by the collector (I/O) and
// passed to the pure renderer so render.ts never touches the filesystem.
export type AssetMap = Record<string, string>;
