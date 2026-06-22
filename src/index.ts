#!/usr/bin/env node
/**
 * inspectctl — MCP server skeleton.
 *
 * This is the minimal-skeleton main branch:
 * - stdio transport only
 * - zero tools registered
 *
 * All CDP tooling (heap_snapshot, get_stack, eval_in_context, breakpoint,
 * profile_cpu, list_async, tail_logs, heap_diff) and the Streamable HTTP
 * transport live on the `http` branch:
 *
 *   git checkout http
 *
 * Run with:
 *   node src/index.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "inspectctl",
  version: "0.0.1",
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("inspectctl MCP server running on stdio (skeleton, 0 tools)\n");
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e}\n`);
  process.exit(1);
});
