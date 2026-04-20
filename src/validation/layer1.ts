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

export async function runLayer1(input: Layer1Input): Promise<Layer1Result> {
  void input;
  throw new Error("runLayer1 not implemented: shell out to rg --json, collect matches, pass=true iff findings is empty");
}
