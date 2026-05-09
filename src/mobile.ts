import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { scrubbedEnv } from "./env.js";

// Foundation wrapper around the mobile-next/mobile-mcp stdio MCP server.
// Used by the upcoming Stage 2 scenario runner (sign up → create resource →
// list → update state → delete) to drive the iOS Simulator and Android
// Emulator deterministically.
//
// This file ships only the primitives whose tool names appear in the
// upstream tool list. Device selection (`mobile_use_default_device` /
// similar) lands with the scenario runner in a follow-up PR, once the
// exact tool name is verified against a live mobile-mcp instance.
//
// scrubbedEnv() strips ANTHROPIC_API_KEY before spawning — mobile-mcp is
// third-party code and doesn't need our key (see src/env.ts).

export type MobilePlatform = "ios" | "android";

export type ScreenElement = {
  // mobile-mcp's element shape is documented as accessibility-tree-derived
  // but varies by platform. Pass through unknown so callers can introspect
  // platform-specific fields rather than us pretending we know them.
  readonly [key: string]: unknown;
};

export type Screenshot = {
  // Raw PNG bytes. Use saveScreenshot() instead if you only need the file.
  readonly data: Buffer;
  readonly mimeType: string;
};

export type MobileClient = {
  callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  // mobile-mcp requires a `device` argument on every tool call EXCEPT
  // mobile_list_available_devices. useDevice() sets a sticky device
  // name; subsequent calls inject it transparently. Pass undefined to
  // clear. Real-device target names come straight from listDevices().
  useDevice(name: string | undefined): void;
  listDevices(): Promise<readonly ScreenElement[]>;
  listElements(): Promise<readonly ScreenElement[]>;
  click(x: number, y: number): Promise<void>;
  // submit:true taps the on-screen keyboard's return/submit key after
  // typing — useful for dismissing the keyboard or submitting a form
  // field. mobile-mcp 0.0.54 requires the param; we default it to false
  // so per-call control stays opt-in.
  typeKeys(text: string, submit?: boolean): Promise<void>;
  pressButton(button: string): Promise<void>;
  takeScreenshot(): Promise<Screenshot>;
  saveScreenshot(absolutePath: string): Promise<void>;
  close(): Promise<void>;
};

export type MobileClientOptions = {
  // Override the spawned command — useful for tests that point at a fake
  // stdio MCP server instead of the real npx mobile-mcp.
  command?: string;
  args?: readonly string[];
};

const DEFAULT_COMMAND = "npx";
const DEFAULT_ARGS = ["-y", "@mobilenext/mobile-mcp@latest"] as const;

// Lazy: spawns mobile-mcp on call, returns a typed client. close() shuts
// the subprocess down cleanly.
//
// Honors NATIVEAPPTEMPLATE_STUB_MOBILE=1 (and NATIVEAPPTEMPLATE_STUB_ALL=1)
// to short-circuit to a no-op client so unit tests don't need a sim or an
// npx download.
export async function createMobileClient(opts?: MobileClientOptions): Promise<MobileClient> {
  if (isStubMobile()) return createStubMobileClient();

  const transport = new StdioClientTransport({
    command: opts?.command ?? DEFAULT_COMMAND,
    args: [...(opts?.args ?? DEFAULT_ARGS)],
    env: scrubbedEnv() as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "nativeapptemplate-agent-stage2", version: "0.1.0" });
  await client.connect(transport);
  return attachMobileClient(client);
}

// Wraps an already-connected MCP Client. Exported so tests can pair the
// wrapper with an in-memory MCP server impersonating mobile-mcp, without
// spawning npx. Production callers should use createMobileClient().
export function attachMobileClient(client: Client): MobileClient {
  return wrapClient(client);
}

export function isStubMobile(): boolean {
  return (
    process.env["NATIVEAPPTEMPLATE_STUB_ALL"] === "1" ||
    process.env["NATIVEAPPTEMPLATE_STUB_MOBILE"] === "1"
  );
}

// Tools that operate at the mobile-mcp server level rather than against
// a specific device. These don't take a `device` argument and would
// fail validation if we injected one.
const DEVICE_INDEPENDENT_TOOLS = new Set([
  "mobile_list_available_devices",
]);

function wrapClient(client: Client): MobileClient {
  let activeDevice: string | undefined;

  const callTool = async (
    name: string,
    args?: Record<string, unknown>,
  ): Promise<CallToolResult> => {
    const merged: Record<string, unknown> =
      activeDevice !== undefined && !DEVICE_INDEPENDENT_TOOLS.has(name)
        ? { device: activeDevice, ...(args ?? {}) }
        : (args ?? {});
    const result = (await client.callTool({
      name,
      arguments: merged,
    })) as CallToolResult;
    if (result.isError) {
      throw new Error(`mobile-mcp ${name} failed: ${textOf(result)}`);
    }
    return result;
  };

  return {
    callTool,
    useDevice(name) {
      activeDevice = name;
    },
    async listDevices() {
      const result = await callTool("mobile_list_available_devices");
      // mobile-mcp 0.0.54+ returns {"devices": [...]} (envelope object,
      // not a bare array). Earlier behavior was a bare array. Accept
      // either so the wrapper survives version drift in either direction.
      const text = textOf(result);
      if (!text) return [];
      try {
        const parsed = JSON.parse(text) as unknown;
        if (Array.isArray(parsed)) return parsed as readonly ScreenElement[];
        if (parsed && typeof parsed === "object" && Array.isArray((parsed as { devices?: unknown }).devices)) {
          return (parsed as { devices: readonly ScreenElement[] }).devices;
        }
        return [];
      } catch {
        return [];
      }
    },
    async listElements() {
      const result = await callTool("mobile_list_elements_on_screen");
      // mobile-mcp 0.0.54 returns "Found these elements on screen: [...]"
      // — a human-readable text prefix followed by a JSON array, not
      // pure JSON. Slice from the first '[' so JSON.parse sees just
      // the array. Defensive against the prefix being absent in other
      // versions too.
      const text = textOf(result);
      if (!text) return [];
      const arrayStart = text.indexOf("[");
      if (arrayStart === -1) return [];
      try {
        const parsed = JSON.parse(text.slice(arrayStart)) as unknown;
        return Array.isArray(parsed) ? (parsed as readonly ScreenElement[]) : [];
      } catch {
        return [];
      }
    },
    async click(x, y) {
      // mobile-mcp 0.0.54's iOS backend (mobilecli `io tap`) rejects
      // non-integer coordinates. centerOf often produces .5 values for
      // even-width elements; floor them at the tool boundary so callers
      // don't have to think about it.
      await callTool("mobile_click_on_screen_at_coordinates", {
        x: Math.floor(x),
        y: Math.floor(y),
      });
    },
    async typeKeys(text, submit = false) {
      // mobile-mcp 0.0.54 requires `submit: boolean` — passing only
      // {text} fails Zod validation with "expected boolean, received
      // undefined". Default false; opt in to true via the second
      // arg when the caller wants the keyboard's return/submit key
      // tapped after typing (form-submit / keyboard-dismiss).
      await callTool("mobile_type_keys", { text, submit });
    },
    async pressButton(button) {
      await callTool("mobile_press_button", { button });
    },
    async takeScreenshot() {
      const result = await callTool("mobile_take_screenshot");
      const image = (result.content ?? []).find((c) => c.type === "image");
      if (!image || typeof image.data !== "string") {
        throw new Error("mobile-mcp mobile_take_screenshot returned no image data");
      }
      return {
        data: Buffer.from(image.data, "base64"),
        mimeType: typeof image.mimeType === "string" ? image.mimeType : "image/png",
      };
    },
    async saveScreenshot(absolutePath) {
      await callTool("mobile_save_screenshot", { saveTo: absolutePath });
    },
    async close() {
      await client.close();
    },
  };
}

function textOf(result: CallToolResult): string {
  for (const c of result.content ?? []) {
    if (c.type === "text" && typeof c.text === "string") return c.text;
  }
  return "";
}

function createStubMobileClient(): MobileClient {
  const stubResult: CallToolResult = { content: [] };
  return {
    callTool: async () => stubResult,
    useDevice: () => {},
    listDevices: async () => [],
    listElements: async () => [],
    click: async () => {},
    typeKeys: async (_text: string, _submit?: boolean) => {},
    pressButton: async () => {},
    takeScreenshot: async () => ({ data: Buffer.alloc(0), mimeType: "image/png" }),
    saveScreenshot: async () => {},
    close: async () => {},
  };
}
