import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scrubbedEnv } from "./env.js";
import { trace } from "./trace.js";

// Rails server lifecycle for Stage 2: spawn bin/dev in the generated
// rails dir, poll until it's reachable, hand off, then tear down.
//
// Layer 2 build mode validates that the rails app COMPILES and BOOTS
// (`bin/rails runner 'puts OK'`), but doesn't keep a server running.
// Stage 2's scripted CRUD walk needs a live API to talk to — without
// it, the iOS sign-up form's POST hits no listener and the app shows
// "Could not connect to the server", aborting the walk.
//
// This module owns the long-running server child process. dispatch.ts
// starts it before runJudge enters Stage 2 and stops it in a finally
// block so the process never leaks (including on errors / SIGINT).

export type RailsHandle = {
  // The child process; kept for diagnostics. Don't kill directly —
  // use stop() so the cleanup path runs.
  readonly child: ChildProcess;
  readonly url: string;
  stop(): Promise<void>;
};

export type StartRailsInput = {
  outDir: string;
  // Read from $NATIVEAPPTEMPLATE_API/.env's HOST/PORT (or the
  // generated rails .env, which mirrors them). Fall back to 0.0.0.0:3000
  // if neither is available.
  host?: string;
  port?: number;
  // How long to wait for the server to start responding to TCP after
  // bin/dev spawn. 60s is generous for a cold rails boot + bundle
  // install (if first run).
  readyTimeoutMs?: number;
  // After SIGTERM, wait this long before SIGKILL. Overmind needs ~3s
  // to clean up its child processes; 5s gives margin.
  shutdownGraceMs?: number;
};

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

export async function startRails(input: StartRailsInput): Promise<RailsHandle> {
  const { host, port } = await resolveHostPort(input);
  const url = `http://${host}:${port}`;

  // Two prep steps before bin/dev:
  //   1. bundle install — Layer 2 ran it but gems land in a path
  //      bin/rails sees for one-shot CLI; bin/dev needs them again
  //      in the same shell context. Idempotent + fast (~1s warm).
  //   2. bin/rails db:prepare — creates+migrates the primary db AND
  //      the cable/queue/cache databases the substrate uses
  //      (config/database.yml multi-db). Without it, Solid Queue
  //      (loaded as a Puma plugin via SOLID_QUEUE_IN_PUMA=true in
  //      .env) can't open its queue connection and crashes Puma:
  //      "Detected Solid Queue has gone away, stopping Puma".
  trace("dispatch", `rails-lifecycle: bundle install in ${input.outDir}`);
  await runMiseStep(input.outDir, ["bundle", "install"], 180_000, "bundle install");
  trace("dispatch", `rails-lifecycle: bin/rails db:prepare in ${input.outDir}`);
  await runMiseStep(input.outDir, ["bin/rails", "db:prepare"], 60_000, "db:prepare");
  // db:seed_fu — substrate uses the seed-fu gem (NOT standard
  // db:seed). Required because db:prepare only runs seeds on
  // fresh-create; for an already-existing DB it just migrates,
  // leaving PrivacyVersion / TermsVersion empty — which causes
  // signup to 500 in render_create_success when it looks up the
  // current version. seed-fu is idempotent.
  trace("dispatch", `rails-lifecycle: bin/rails db:seed_fu in ${input.outDir}`);
  await runMiseStep(input.outDir, ["bin/rails", "db:seed_fu"], 60_000, "db:seed_fu");

  // Wrap with `mise exec --` so the substrate's pinned Ruby /
  // bundler version activates (substrate's .mise.toml or .tool-versions
  // pins a specific version that may not match system Ruby). Layer 2
  // uses the same wrapper for `bin/rails runner` — match it here so
  // Stage 2's server uses the same toolchain that Layer 2 validated.
  trace("dispatch", `rails-lifecycle: spawning mise exec -- bin/dev in ${input.outDir} (target ${url})`);
  const child = spawn("mise", ["exec", "--", "bin/dev"], {
    cwd: input.outDir,
    env: scrubbedEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  // Drain stdio so the child doesn't block on backed-up pipes; route
  // a tail to the dispatch trace so silent failures (port already in
  // use, missing gem, etc.) surface in tmp/trace/dispatch.log.
  const tail: string[] = [];
  const onData = (c: Buffer): void => {
    const text = c.toString("utf8");
    tail.push(text);
    if (tail.length > 50) tail.shift();
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  // Surface child crash before we time out waiting for ready.
  let exitedEarly = false;
  child.on("exit", (code) => {
    exitedEarly = true;
    trace("dispatch", `rails-lifecycle: child exited early (code=${code}); recent output: ${tail.join("").slice(-500)}`);
  });

  const readyTimeoutMs = input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const ready = await waitForReady(host, port, readyTimeoutMs, () => exitedEarly);

  if (!ready) {
    child.kill("SIGTERM");
    const lastOutput = tail.join("").slice(-500);
    throw new Error(
      `Rails server at ${url} did not become ready within ${readyTimeoutMs}ms` +
        (exitedEarly ? ` (child exited early)` : "") +
        `; recent output: ${lastOutput}`,
    );
  }

  trace("dispatch", `rails-lifecycle: server reachable at ${url}`);

  const shutdownGraceMs = input.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  return {
    child,
    url,
    async stop() {
      if (exitedEarly) return;
      trace("dispatch", `rails-lifecycle: stopping ${url}`);
      child.kill("SIGTERM");
      const exit = new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
        } else {
          child.on("exit", () => resolve());
        }
      });
      const timeout = sleep(shutdownGraceMs).then(() => {
        if (child.exitCode === null) {
          trace("dispatch", `rails-lifecycle: SIGTERM did not exit in ${shutdownGraceMs}ms; SIGKILL`);
          child.kill("SIGKILL");
        }
      });
      await Promise.race([exit, timeout]);
    },
  };
}

export async function waitForReady(
  host: string,
  port: number,
  timeoutMs: number,
  childExitedEarly?: () => boolean,
): Promise<boolean> {
  const url = `http://${host}:${port}/`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childExitedEarly?.()) return false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      // Any HTTP response (even 404) means Rails is up. Network/connection
      // errors throw; we keep polling.
      if (res.status < 500) return true;
    } catch {
      // ECONNREFUSED, EHOSTUNREACH, AbortError — not ready, keep polling.
    }
    await sleep(1_000);
  }
  return false;
}

async function resolveHostPort(input: StartRailsInput): Promise<{ host: string; port: number }> {
  if (input.host !== undefined && input.port !== undefined) {
    return { host: input.host, port: input.port };
  }

  // Read from the generated rails dir's .env (which mirrors substrate's
  // .env via the rails worker's verbatim copy).
  const envPath = join(input.outDir, ".env");
  const env = await readDotenv(envPath);
  const host = input.host ?? env["HOST"] ?? "0.0.0.0";
  const portStr = env["PORT"];
  const port = input.port ?? (portStr ? Number.parseInt(portStr, 10) : 3000);
  if (Number.isNaN(port)) throw new Error(`rails-lifecycle: PORT in ${envPath} is not a number: ${portStr}`);
  return { host, port };
}

async function runMiseStep(
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
  label: string,
): Promise<void> {
  await new Promise<void>((resolveStep, rejectStep) => {
    const child = spawn("mise", ["exec", "--", ...args], {
      cwd,
      env: scrubbedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: string[] = [];
    child.stdout?.on("data", (c: Buffer) => out.push(c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => out.push(c.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveStep();
      else rejectStep(new Error(`${label} exited ${code}: ${out.join("").slice(-800)}`));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectStep(err);
    });
  });
}

async function readDotenv(path: string): Promise<Readonly<Record<string, string>>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const valueRaw = trimmed.slice(eq + 1).trim();
    const value = valueRaw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (key && value) out[key] = value;
  }
  return out;
}
