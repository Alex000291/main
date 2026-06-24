#!/usr/bin/env node
/**
 * inspectctl — MCP server (stdio transport).
 *
 * A) CDP — Node.js / V8 (stateful session + stateless diagnostics):
 *    start_debug_session, set_breakpoint, remove_breakpoint,
 *    wait_for_pause, get_status, get_locals, evaluate,
 *    resume, step_over, step_into, step_out, pause,
 *    close_debug_session, list_debug_sessions
 *    list_targets, heap_snapshot, heap_diff, profile_cpu,
 *    get_stack, list_async, tail_logs
 *
 * B) DAP — Python / debugpy (and any DAP-compliant adapter):
 *    dap_start_session, dap_close_session, dap_list_sessions
 *    dap_set_breakpoints, dap_set_function_breakpoints,
 *    dap_set_exception_breakpoints, dap_set_data_breakpoints,
 *    dap_data_breakpoint_info
 *    dap_wait_for_pause, dap_get_status, dap_get_threads,
 *    dap_get_stack, dap_get_scopes, dap_get_variables,
 *    dap_set_variable, dap_evaluate, dap_set_expression,
 *    dap_step_in_targets, dap_goto_targets, dap_goto
 *    dap_continue, dap_pause, dap_next, dap_step_in, dap_step_out
 *    dap_get_loaded_sources, dap_get_source
 *    dap_tail_output, dap_drain_output
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

import {
  dapStartSession,
  dapCloseSession,
  dapListSessions,
  dapSetBreakpoints,
  dapSetFunctionBreakpoints,
  dapSetExceptionBreakpoints,
  dapSetDataBreakpoints,
  dapDataBreakpointInfo,
  dapWaitForPause,
  dapGetStatus,
  dapGetThreads,
  dapContinue,
  dapPause,
  dapNext,
  dapStepIn,
  dapStepOut,
  dapGotoTargets,
  dapGoto,
  dapGetStack,
  dapGetScopes,
  dapGetVariables,
  dapSetVariable,
  dapEvaluate,
  dapSetExpression,
  dapStepInTargets,
  dapGetLoadedSources,
  dapGetSource,
  dapTailOutput,
  dapDrainOutput,
} from "./dap-session.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

const targetSchema = {
  port: z.number().int().optional().describe("CDP port (default 9229)"),
  host: z.string().optional().describe("CDP host (default 127.0.0.1)"),
  targetId: z.string().optional().describe("Specific CDP target WS URL"),
};

const dapTargetSchema = {
  host: z.string().optional().describe("debugpy host (default 127.0.0.1)"),
  port: z.number().int().optional().describe("debugpy DAP port (default 5678)"),
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

const server = new McpServer({ name: "inspectctl", version: "2.0.0" });

// ═══════════════════════════════════════════════════════════════════════════════
// A) CDP — Node.js / V8
// ═══════════════════════════════════════════════════════════════════════════════

// ─── A1) Stateful debug session ───────────────────────────────────────────────

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

// ─── A2) Stateless diagnostics ────────────────────────────────────────────────

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

// ═══════════════════════════════════════════════════════════════════════════════
// B) DAP — Python / debugpy (and any DAP-compliant adapter)
//
// Start debugpy first:
//   python -m debugpy --listen 5678 --wait-for-client script.py
// Then call dap_start_session to attach.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── B1) Session lifecycle ────────────────────────────────────────────────────

server.tool(
  "dap_start_session",
  "Attach to a debugpy process over DAP (TCP). Requires the process to already be listening: `python -m debugpy --listen <port> script.py`. Returns sessionId and adapter capabilities.",
  {
    ...dapTargetSchema,
    justMyCode: z.boolean().optional().describe("Skip stdlib/3rd-party frames (default false)"),
  },
  ({ host, port, justMyCode }) =>
    run(() => dapStartSession(host, port, justMyCode))
);

server.tool(
  "dap_close_session",
  "Disconnect from a DAP session without terminating the debuggee.",
  { sessionId: z.string() },
  ({ sessionId }) => run(() => dapCloseSession(sessionId))
);

server.tool(
  "dap_list_sessions",
  "List all open DAP sessions and their pause state.",
  {},
  () => run(() => Promise.resolve(dapListSessions()))
);

// ─── B2) Breakpoints ──────────────────────────────────────────────────────────

server.tool(
  "dap_set_breakpoints",
  "Set breakpoints for a source file. Replaces ALL breakpoints for that file — pass every desired line at once. Pass empty lines[] to clear. Returns resolved breakpoint info.",
  {
    sessionId: z.string(),
    file: z.string().describe("Absolute path to the source file"),
    lines: z.array(z.number().int()).describe("1-based line numbers"),
    conditions: z.array(z.string()).optional().describe("Per-line condition expressions (same length as lines, use empty string for none)"),
  },
  ({ sessionId, file, lines, conditions }) =>
    run(() => dapSetBreakpoints(sessionId, file, lines, conditions as any))
);

server.tool(
  "dap_set_function_breakpoints",
  "Set breakpoints by function name (no source file needed). Replaces the entire function breakpoint list.",
  {
    sessionId: z.string(),
    names: z.array(z.string()).describe("Function names to break on"),
    conditions: z.array(z.string()).optional().describe("Per-function condition expressions"),
  },
  ({ sessionId, names, conditions }) =>
    run(() => dapSetFunctionBreakpoints(sessionId, names, conditions as any))
);

server.tool(
  "dap_set_exception_breakpoints",
  "Configure exception breakpoints. For debugpy: filters are 'raised' and/or 'uncaught'.",
  {
    sessionId: z.string(),
    filters: z.array(z.string()).describe("e.g. ['raised', 'uncaught']"),
    filterOptions: z
      .array(z.object({ filterId: z.string(), condition: z.string().optional() }))
      .optional()
      .describe("Per-filter conditions (requires supportsExceptionFilterOptions capability)"),
  },
  ({ sessionId, filters, filterOptions }) =>
    run(() => dapSetExceptionBreakpoints(sessionId, filters, filterOptions as any))
);

server.tool(
  "dap_set_data_breakpoints",
  "Set data (watchpoint) breakpoints. Requires dap_data_breakpoint_info to get the dataId first.",
  {
    sessionId: z.string(),
    breakpoints: z.array(z.object({
      dataId: z.string(),
      accessType: z.enum(["read", "write", "readWrite"]).optional(),
      condition: z.string().optional(),
      hitCondition: z.string().optional(),
    })),
  },
  ({ sessionId, breakpoints }) =>
    run(() => dapSetDataBreakpoints(sessionId, breakpoints))
);

server.tool(
  "dap_data_breakpoint_info",
  "Get the dataId for a variable so it can be used with dap_set_data_breakpoints.",
  {
    sessionId: z.string(),
    variablesReference: z.number().int().describe("From dap_get_variables or dap_get_scopes"),
    name: z.string().describe("Variable name"),
  },
  ({ sessionId, variablesReference, name }) =>
    run(() => dapDataBreakpointInfo(sessionId, variablesReference, name))
);

// ─── B3) Execution control ────────────────────────────────────────────────────

server.tool(
  "dap_wait_for_pause",
  "Block until the target stops (breakpoint, exception, step complete). Returns immediately if already paused.",
  {
    sessionId: z.string(),
    timeoutMs: z.number().int().optional().describe("Default 30000"),
  },
  ({ sessionId, timeoutMs }) => run(() => dapWaitForPause(sessionId, timeoutMs))
);

server.tool(
  "dap_get_status",
  "Return current pause state without blocking.",
  { sessionId: z.string() },
  ({ sessionId }) => run(() => dapGetStatus(sessionId))
);

server.tool(
  "dap_get_threads",
  "List all threads in the debuggee.",
  { sessionId: z.string() },
  ({ sessionId }) => run(() => dapGetThreads(sessionId))
);

server.tool(
  "dap_continue",
  "Resume execution. Omit threadId to resume the currently stopped thread.",
  {
    sessionId: z.string(),
    threadId: z.number().int().optional(),
  },
  ({ sessionId, threadId }) => run(() => dapContinue(sessionId, threadId))
);

server.tool(
  "dap_pause",
  "Pause a running thread.",
  {
    sessionId: z.string(),
    threadId: z.number().int().optional().describe("Default 1"),
  },
  ({ sessionId, threadId }) => run(() => dapPause(sessionId, threadId))
);

server.tool(
  "dap_next",
  "Step over the current line (stay in same function).",
  {
    sessionId: z.string(),
    threadId: z.number().int().optional().describe("Defaults to currently stopped thread"),
    granularity: z.enum(["statement", "line", "instruction"]).optional(),
  },
  ({ sessionId, threadId, granularity }) => run(() => dapNext(sessionId, threadId, granularity))
);

server.tool(
  "dap_step_in",
  "Step into the next function call.",
  {
    sessionId: z.string(),
    threadId: z.number().int().optional(),
    targetId: z.number().int().optional().describe("From dap_step_in_targets to disambiguate"),
    granularity: z.enum(["statement", "line", "instruction"]).optional(),
  },
  ({ sessionId, threadId, targetId, granularity }) =>
    run(() => dapStepIn(sessionId, threadId, targetId, granularity))
);

server.tool(
  "dap_step_out",
  "Step out of the current function.",
  {
    sessionId: z.string(),
    threadId: z.number().int().optional(),
    granularity: z.enum(["statement", "line", "instruction"]).optional(),
  },
  ({ sessionId, threadId, granularity }) => run(() => dapStepOut(sessionId, threadId, granularity))
);

server.tool(
  "dap_step_in_targets",
  "List the specific call targets at the current position so you can pick which one to step into with dap_step_in targetId.",
  {
    sessionId: z.string(),
    frameId: z.number().int().describe("From dap_get_stack stackFrames[].id"),
  },
  ({ sessionId, frameId }) => run(() => dapStepInTargets(sessionId, frameId))
);

server.tool(
  "dap_goto_targets",
  "Get valid jump targets (line → targetId) for a source location.",
  {
    sessionId: z.string(),
    file: z.string().describe("Absolute source file path"),
    line: z.number().int(),
  },
  ({ sessionId, file, line }) => run(() => dapGotoTargets(sessionId, file, line))
);

server.tool(
  "dap_goto",
  "Jump execution to a target location (from dap_goto_targets).",
  {
    sessionId: z.string(),
    threadId: z.number().int(),
    targetId: z.number().int().describe("From dap_goto_targets"),
  },
  ({ sessionId, threadId, targetId }) => run(() => dapGoto(sessionId, threadId, targetId))
);

// ─── B4) Stack inspection ─────────────────────────────────────────────────────

server.tool(
  "dap_get_stack",
  "Get the call stack for a thread. Returns stackFrames with id, name, source, line, column.",
  {
    sessionId: z.string(),
    threadId: z.number().int().optional().describe("Defaults to currently stopped thread"),
    startFrame: z.number().int().optional().describe("Default 0"),
    levels: z.number().int().optional().describe("Default 20"),
  },
  ({ sessionId, threadId, startFrame, levels }) =>
    run(() => dapGetStack(sessionId, threadId, startFrame, levels))
);

server.tool(
  "dap_get_scopes",
  "Get scopes (Locals, Globals, etc.) for a stack frame. Returns variablesReference per scope to use with dap_get_variables.",
  {
    sessionId: z.string(),
    frameId: z.number().int().describe("stackFrames[].id from dap_get_stack"),
  },
  ({ sessionId, frameId }) => run(() => dapGetScopes(sessionId, frameId))
);

server.tool(
  "dap_get_variables",
  "Expand a variablesReference (from dap_get_scopes or a variable with children). Variables with variablesReference > 0 can be expanded further.",
  {
    sessionId: z.string(),
    variablesReference: z.number().int(),
    filter: z.enum(["indexed", "named"]).optional().describe("'indexed' for array elements, 'named' for properties"),
    start: z.number().int().optional().describe("For paging large arrays"),
    count: z.number().int().optional(),
  },
  ({ sessionId, variablesReference, filter, start, count }) =>
    run(() => dapGetVariables(sessionId, variablesReference, filter, start, count))
);

server.tool(
  "dap_set_variable",
  "Modify the value of a variable while paused.",
  {
    sessionId: z.string(),
    variablesReference: z.number().int().describe("Parent scope/object reference"),
    name: z.string(),
    value: z.string().describe("New value as a string (adapter evaluates it)"),
  },
  ({ sessionId, variablesReference, name, value }) =>
    run(() => dapSetVariable(sessionId, variablesReference, name, value))
);

server.tool(
  "dap_evaluate",
  "Evaluate an expression. With frameId evaluates in that frame's scope; without it runs as REPL.",
  {
    sessionId: z.string(),
    expression: z.string(),
    frameId: z.number().int().optional().describe("stackFrames[].id; omit for global REPL"),
    context: z.enum(["watch", "repl", "hover", "clipboard"]).optional().describe("Default: 'watch' if frameId given, 'repl' otherwise"),
  },
  ({ sessionId, expression, frameId, context }) =>
    run(() => dapEvaluate(sessionId, expression, frameId, context))
);

server.tool(
  "dap_set_expression",
  "Assign a new value to an assignable expression (e.g. a variable name or property access).",
  {
    sessionId: z.string(),
    expression: z.string().describe("Assignable expression, e.g. 'myvar' or 'obj.field'"),
    value: z.string().describe("New value expression"),
    frameId: z.number().int().optional(),
  },
  ({ sessionId, expression, value, frameId }) =>
    run(() => dapSetExpression(sessionId, expression, value, frameId))
);

// ─── B5) Sources ──────────────────────────────────────────────────────────────

server.tool(
  "dap_get_loaded_sources",
  "List all source files currently loaded in the debuggee.",
  { sessionId: z.string() },
  ({ sessionId }) => run(() => dapGetLoadedSources(sessionId))
);

server.tool(
  "dap_get_source",
  "Retrieve source code by file path or sourceReference (for dynamic/eval'd code).",
  {
    sessionId: z.string(),
    path: z.string().optional().describe("Absolute file path"),
    sourceReference: z.number().int().optional().describe("From source.sourceReference in stack frames"),
  },
  ({ sessionId, path, sourceReference }) =>
    run(() => dapGetSource(sessionId, path, sourceReference))
);

// ─── B6) Output ───────────────────────────────────────────────────────────────

server.tool(
  "dap_tail_output",
  "Capture stdout/stderr/console output from the debuggee for durationMs.",
  {
    sessionId: z.string(),
    durationMs: z.number().int(),
    maxEntries: z.number().int().optional().describe("Default 200"),
  },
  ({ sessionId, durationMs, maxEntries }) =>
    run(() => dapTailOutput(sessionId, durationMs, maxEntries))
);

server.tool(
  "dap_drain_output",
  "Flush all output buffered since session start (up to 2000 entries). Non-blocking.",
  {
    sessionId: z.string(),
    maxEntries: z.number().int().optional().describe("Default 500"),
  },
  ({ sessionId, maxEntries }) => run(() => dapDrainOutput(sessionId, maxEntries))
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
process.stderr.write("inspectctl ready (42 tools: 21 CDP + 21 DAP)\n");
