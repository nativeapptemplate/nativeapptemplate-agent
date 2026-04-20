export type Layer3Criterion = {
  id: string;
  question: string;
};

export type Layer3Input = {
  screenshotPath: string;
  rubric: readonly Layer3Criterion[];
  spec: string;
  model?: string;
  samplesPerCriterion?: number;
};

export type Layer3Score = {
  criterionId: string;
  pass: boolean;
  rationale: string;
};

export type Layer3Result = {
  pass: boolean;
  scores: Layer3Score[];
};

export async function runLayer3(input: Layer3Input): Promise<Layer3Result> {
  void input;
  throw new Error("runLayer3 not implemented: load PNG, send spec + rubric + image to claude-opus-4-7, run samplesPerCriterion times (default 3), median per criterion, pass=true iff all criteria pass");
}
