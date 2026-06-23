#!/usr/bin/env node
/**
 * inspectctl — MCP server (stdio transport).
 *
 * Two categories of tools:
 *
 * A) Stateful debug session (mirrors VS Code DAP):
 *    start_debug_session, set_breakpoint, remove_breakpoint,
 *    wait_for_pause, get_status, get_locals, evaluate,
 *    continue, step_over, step_into, step_out, pause,
 *    close_debug_session, list_debug_sessions
 *
 * B) Stateless diagnostics (one-shot, no session):
 *    list_targets, heap_snapshot, heap_diff, profile_cpu,
 *    get_stack, list_async, tail_logs
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  startDebugSession,
  closeDebugSession,
  listDebugSessions,
  setBreakpoint,
  removeBreakpoint,
  waitForPause,
  getStatus,
  getLocals,
  evaluate,
  continueExecution,
  stepOver,
  stepInto,
  stepOut,
  pauseTarget,
} from "./debugger.ts";

import {
  listTargets,
  heapSnapshot,
  heapDiff,
  profileCpu,
  getStack,
  listAsync,
  tailLogs,
} from "./tools.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

const targetSchema = {
  port: z.number().int().optional().describe("CDP port (default 9229)"),
  host: z.string().optional().describe("CDP host (default 127.0.0.1)"),
  targetId: z.string().optional().describe("Specific CDP target WS URL"),
};

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text" as const, text: `ERROR: ${msg}` }] };
}

async function run<T>(fn: () => Promise<T>) {
  try { return ok(await fn()); } catch (e) { return fail(e); }
}

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "inspectctl", version: "1.0.0" });

// ─── A) Stateful debug session ────────────────────────────────────────────────

server.tool(
  "start_debug_session",
  "Connect to a Node.js debugger and return a sessionId. All subsequent debug tools require this sessionId.",
  targetSchema,
  (args) => run(() => startDebugSession(args))
);

server.tool(
  "close_debug_session",
  "Close a debug session and release the CDP connection.",
  { sessionId: z.string() },
  ({ sessionId }) => run(() => closeDebugSession(sessionId))
);

server.tool(
  "list_debug_sessions",
  "List all open debug sessions and their pause state.",
  {},
  () => run(() => Promise.resolve(listDebugSessions()))
);

server.tool(
  "set_breakpoint",
  "Set a breakpoint by file path fragment and line number. Returns a breakpointId.",
  {
    sessionId: z.string(),
    file: z.string().describe("File path fragment to match (e.g. 'target.cjs')"),
    line: z.number().int().describe("Line number (1-based)"),
    condition: z.string().optional().describe("Only break when this JS expression is truthy"),
  },
  ({ sessionId, file, line, condition }) =>
    run(() => setBreakpoint(sessionId, file, line, condition))
);

server.tool(
  "remove_breakpoint",
  "Remove a breakpoint by its breakpointId.",
  { sessionId: z.string(), breakpointId: z.string() },
  ({ sessionId, breakpointId }) => run(() => removeBreakpoint(sessionId, breakpointId))
);

server.tool(
  "wait_for_pause",
  "Block until the target pauses (breakpoint hit, exception, or step complete). Returns stack frames. If already paused, returns immediately.",
  {
    sessionId: z.string(),
    timeoutMs: z.number().int().optional().describe("Default 30000"),
  },
  ({ sessionId, timeoutMs }) => run(() => waitForPause(sessionId, timeoutMs))
);

server.tool(
  "get_status",
  "Return current pause state and stack frames without blocking.",
  { sessionId: z.string() },
  ({ sessionId }) => run(() => getStatus(sessionId))
);

server.tool(
  "get_locals",
  "Return local variables for a stack frame. Target must be paused.",
  {
    sessionId: z.string(),
    frameIndex: z.number().int().optional().describe("0 = top frame (default)"),
  },
  ({ sessionId, frameIndex }) => run(() => getLocals(sessionId, frameIndex))
);

server.tool(
  "evaluate",
  "Evaluate a JS expression. With frameIndex evaluates in that frame's scope (target must be paused); without it runs globally.",
  {
    sessionId: z.string(),
    expression: z.string(),
    frameIndex: z.number().int().optional().describe("Stack frame index; omit for global eval"),
    returnByValue: z.boolean().optional(),
  },
  ({ sessionId, expression, frameIndex, returnByValue }) =>
    run(() => evaluate(sessionId, expression, frameIndex, returnByValue))
);

server.tool(
  "resume",
  "Resume execution after a pause.",
  { sessionId: z.string() },
  ({ sessionId }) => run(() => continueExecution(sessionId))
);

server.tool(
  "step_over",
  "Step over the current line.",
  { sessionId: z.string() },
  ({ sessionId }) => run(() => stepOver(sessionId))
);

server.tool(
  "step_into",
  "Step into the next function call.",
  { sessionId: z.string() },
  ({ sessionId }) => run(() => stepInto(sessionId))
);

server.tool(
  "step_out",
  "Step out of the current function.",
  { sessionId: z.string() },
  ({ sessionId }) => run(() => stepOut(sessionId))
);

server.tool(
  "pause",
  "Pause the target immediately (like pressing the pause button).",
  { sessionId: z.string() },
  ({ sessionId }) => run(() => pauseTarget(sessionId))
);

// ─── B) Stateless diagnostics ─────────────────────────────────────────────────

server.tool(
  "list_targets",
  "List all CDP debug targets on a host:port.",
  targetSchema,
  (args) => run(() => listTargets(args))
);

server.tool(
  "heap_snapshot",
  "Take a V8 heap snapshot. Returns top objects by size and type breakdown.",
  { ...targetSchema, topN: z.number().int().optional() },
  ({ topN, ...sel }) => run(() => heapSnapshot(sel, topN))
);

server.tool(
  "heap_diff",
  "Diff two heap snapshots (paths from heap_snapshot). Returns top growth by type.",
  {
    before: z.string().describe("Path to earlier .heapsnapshot file"),
    after: z.string().describe("Path to later .heapsnapshot file"),
    topN: z.number().int().optional(),
  },
  ({ before, after, topN }) => run(() => heapDiff(before, after, topN))
);

server.tool(
  "profile_cpu",
  "Run a CPU profile for durationMs. Returns hottest functions by self and total time.",
  { ...targetSchema, durationMs: z.number().int(), topN: z.number().int().optional() },
  ({ durationMs, topN, ...sel }) => run(() => profileCpu(sel, durationMs, topN))
);

server.tool(
  "get_stack",
  "Pause the target briefly, capture the current call stack, then resume.",
  targetSchema,
  (args) => run(() => getStack(args))
);

server.tool(
  "list_async",
  "List active handles and requests (timers, sockets, etc.).",
  targetSchema,
  (args) => run(() => listAsync(args))
);

server.tool(
  "tail_logs",
  "Capture console output and exceptions for durationMs.",
  {
    ...targetSchema,
    durationMs: z.number().int(),
    maxEntries: z.number().int().optional(),
  },
  ({ durationMs, maxEntries, ...sel }) => run(() => tailLogs(sel, durationMs, maxEntries))
);

// ── Start ─────────────────────────────────────────────────────────────────────

process.on("uncaughtException", (e) => {
  process.stderr.write(`[inspectctl] uncaughtException: ${e?.stack ?? e}\n`);
});
process.on("unhandledRejection", (e) => {
  process.stderr.write(`[inspectctl] unhandledRejection: ${e}\n`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("inspectctl ready (21 tools)\n");
