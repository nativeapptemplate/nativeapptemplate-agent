#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dispatch } from "./dispatch.js";
import { loadDotenvIfPresent } from "./env.js";
import { readPackageVersion } from "./version.js";

// MCP surface (MONETIZATION.md §"MCP as a distribution surface"):
// thin wrapper around dispatch() so any MCP-compatible AI assistant
// (Claude Code, Cursor, Cline, Continue, Goose, ...) can invoke the
// agent as a tool. Same backend as the CLI; different wire format.
//
// Run via: `npx -y nativeapptemplate-agent-mcp` from an MCP client config.

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "nativeapptemplate-agent",
    version: readPackageVersion(),
  });

  server.registerTool(
    "generate_app",
    {
      title: "Generate three-platform SaaS app",
      description:
        "Generate a working three-platform SaaS app from a natural-language spec — Rails 8.1 API + SwiftUI iOS + Jetpack Compose Android. Validated end-to-end (rename completeness, build, vision judge). Output lands in ./out/<spec-slug>/{rails,ios,android}/. Each invocation runs ~3-5 minutes and consumes Anthropic API usage on the configured key, separate from the calling assistant's session.",
      inputSchema: {
        spec: z
          .string()
          .min(1)
          .describe(
            'Natural-language SaaS spec, e.g. "a walk-in queue for a barbershop"',
          ),
        renameOverrides: z
          .array(z.object({ from: z.string().min(1), to: z.string().min(1) }))
          .optional()
          .describe(
            'Optional manual rename overrides keyed on the substrate token (from = "Shop" | "Shopkeeper" | "ItemTag"), each replacing the planner\'s chosen target. Overrides that match no planned rename are ignored.',
          ),
        projectName: z
          .string()
          .optional()
          .describe(
            'Optional project name (e.g. "Vet Clinic" or "VetClinic"). Overrides the planner\'s name; the slug — which sets the output directory, DB prefix, and the Pascal project name across all three platforms — and the display name are derived from it. Ignored if it yields no valid slug.',
          ),
      },
    },
    async ({ spec, renameOverrides, projectName }) => {
      const result = await dispatch(spec, {
        ...(renameOverrides ? { renameOverrides } : {}),
        ...(projectName !== undefined ? { projectName } : {}),
      });
      return {
        content: [{ type: "text", text: result.summary }],
        structuredContent: {
          overallPass: result.overallPass,
          summary: result.summary,
          ...(result.visual ? { visual: result.visual } : {}),
          report: result.report,
          ...(result.reportPaths.htmlPath ? { reportHtmlPath: result.reportPaths.htmlPath } : {}),
          ...(result.reportPaths.jsonPath ? { reportJsonPath: result.reportPaths.jsonPath } : {}),
        },
        isError: !result.overallPass,
      };
    },
  );

  return server;
}

export async function main(): Promise<void> {
  loadDotenvIfPresent();
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isEntryPoint()) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const modulePath = fileURLToPath(import.meta.url);
    const argv1Real = realpathSync(argv1);
    return argv1Real === modulePath;
  } catch {
    return false;
  }
}
