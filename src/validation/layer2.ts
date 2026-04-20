export type Layer2Input = {
  railsDir: string;
  healthPath?: string;
  bootTimeoutMs?: number;
};

export type Layer2Result = {
  pass: boolean;
  port: number;
  healthStatus: number | null;
  stderrTail?: string;
};

export async function runLayer2(input: Layer2Input): Promise<Layer2Result> {
  void input;
  throw new Error("runLayer2 not implemented: pick random port, spawn bin/rails server -p <port> -b 127.0.0.1, poll healthPath (default /up) until 200 or bootTimeoutMs, then SIGTERM");
}
