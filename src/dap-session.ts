/**
 * Stateful DAP debug session.
 *
 * Lifecycle:
 *   dapStartSession  → sessionId   (requires debugpy already listening: python -m debugpy --listen <port> script.py)
 *   dapSetBreakpoints / dapSetFunctionBreakpoints / dapSetExceptionBreakpoints
 *   dapContinue / dapNext / dapStepIn / dapStepOut / dapPause
 *   dapWaitForPause  → StopResult
 *   dapGetStatus / dapGetThreads / dapGetStack / dapGetScopes / dapGetVariables
 *   dapSetVariable / dapEvaluate
 *   dapGetLoadedSources / dapGetSource
 *   dapGotoTargets / dapGoto
 *   dapTailOutput / dapDrainOutput
 *   dapCloseSession
 */
import { randomUUID } from "node:crypto";
import { connectDAP, type DAPClient } from "./dap.ts";

// ── Internal state ────────────────────────────────────────────────────────────

interface FileBPs {
  lines: number[];
  conditions: (string | undefined)[];
}

interface OutputEntry {
  ts: number;
  category: string;
  output: string;
}

interface DAPDebugSession {
  id: string;
  client: DAPClient;
  capabilities: any;
  paused: boolean;
  stoppedThreadId?: number;
  stopReason?: string;
  stopDescription?: string;
  breakpointsByFile: Map<string, FileBPs>;
  pendingWait?: {
    resolve: (r: StopResult) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  outputBuffer: OutputEntry[];
}

const sessions = new Map<string, DAPDebugSession>();

function need(sessionId: string): DAPDebugSession {
  const s = sessions.get(sessionId);
  if (!s) throw new Error(`unknown DAP sessionId: ${sessionId}`);
  return s;
}

function needPaused(s: DAPDebugSession): number {
  if (!s.paused || s.stoppedThreadId === undefined)
    throw new Error("target is not paused");
  return s.stoppedThreadId;
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface StopResult {
  reason: string;
  threadId: number;
  allThreadsStopped?: boolean;
  description?: string;
  text?: string;
}

export interface DAPSessionInfo {
  sessionId: string;
  paused: boolean;
  stopReason?: string;
  stoppedThreadId?: number;
}

// ── Session lifecycle ─────────────────────────────────────────────────────────

export async function dapStartSession(
  host = "127.0.0.1",
  port = 5678,
  justMyCode = false
): Promise<{ sessionId: string; capabilities: any }> {
  const client = await connectDAP(host, port);

  const session: DAPDebugSession = {
    id: randomUUID(),
    client,
    capabilities: {},
    paused: false,
    breakpointsByFile: new Map(),
    outputBuffer: [],
  };
  sessions.set(session.id, session);

  // 1. initialize
  const initResp = await client.send("initialize", {
    clientID: "inspectctl",
    clientName: "inspectctl MCP",
    adapterID: "python",
    pathFormat: "path",
    linesStartAt1: true,
    columnsStartAt1: true,
    supportsVariableType: true,
    supportsVariablePaging: true,
    supportsRunInTerminalRequest: false,
    supportsProgressReporting: false,
    supportsInvalidatedEvent: true,
  });
  session.capabilities = initResp.body ?? {};

  // Wait for 'initialized' event from adapter (required before attach/launch)
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 3000);
    client.once("initialized", () => { clearTimeout(t); resolve(); });
  });

  // 2. attach to already-running debugpy process
  await client.send("attach", {
    justMyCode,
    subProcess: false,
    showReturnValue: true,
  });

  // 3. signal configuration done (breakpoints set after this are fine too)
  await client.send("configurationDone");

  // Wire persistent event handlers
  (client as any).on("stopped", (body: any) => {
    session.paused = true;
    session.stoppedThreadId = body.threadId;
    session.stopReason = body.reason;
    session.stopDescription = body.description;
    if (session.pendingWait) {
      clearTimeout(session.pendingWait.timer);
      session.pendingWait.resolve({
        reason: body.reason,
        threadId: body.threadId,
        allThreadsStopped: body.allThreadsStopped,
        description: body.description,
        text: body.text,
      });
      session.pendingWait = undefined;
    }
  });

  (client as any).on("continued", (body: any) => {
    if (body?.allThreadsContinued !== false) {
      session.paused = false;
      session.stoppedThreadId = undefined;
      session.stopReason = undefined;
      session.stopDescription = undefined;
    }
  });

  (client as any).on("output", (body: any) => {
    if (session.outputBuffer.length < 2000) {
      session.outputBuffer.push({
        ts: Date.now(),
        category: body.category ?? "stdout",
        output: body.output ?? "",
      });
    }
  });

  return { sessionId: session.id, capabilities: session.capabilities };
}

export async function dapCloseSession(sessionId: string): Promise<{ ok: boolean }> {
  const s = sessions.get(sessionId);
  if (!s) return { ok: false };
  s.pendingWait?.reject(new Error("session closed"));
  clearTimeout(s.pendingWait?.timer);
  sessions.delete(sessionId);
  try { await s.client.send("disconnect", { restart: false, terminateDebuggee: false }); } catch { /* ignore */ }
  s.client.close();
  return { ok: true };
}

export function dapListSessions(): DAPSessionInfo[] {
  return Array.from(sessions.values()).map((s) => ({
    sessionId: s.id,
    paused: s.paused,
    stopReason: s.stopReason,
    stoppedThreadId: s.stoppedThreadId,
  }));
}

// ── Breakpoints ───────────────────────────────────────────────────────────────

/**
 * Set breakpoints for a file. DAP replaces the entire set per file, so pass
 * ALL desired lines for that file at once. Pass empty lines[] to clear.
 */
export async function dapSetBreakpoints(
  sessionId: string,
  file: string,
  lines: number[],
  conditions?: (string | undefined)[]
): Promise<any> {
  const s = need(sessionId);
  s.breakpointsByFile.set(file, { lines, conditions: conditions ?? [] });
  const breakpoints = lines.map((line, i) => ({
    line,
    ...(conditions?.[i] ? { condition: conditions[i] } : {}),
  }));
  const r = await s.client.send("setBreakpoints", {
    source: { path: file },
    breakpoints,
  });
  return r.body;
}

export async function dapSetFunctionBreakpoints(
  sessionId: string,
  names: string[],
  conditions?: (string | undefined)[]
): Promise<any> {
  const s = need(sessionId);
  const r = await s.client.send("setFunctionBreakpoints", {
    breakpoints: names.map((name, i) => ({
      name,
      ...(conditions?.[i] ? { condition: conditions[i] } : {}),
    })),
  });
  return r.body;
}

/**
 * filters: e.g. ["raised", "uncaught"] — adapter-specific.
 * debugpy uses "raised" and "uncaught".
 */
export async function dapSetExceptionBreakpoints(
  sessionId: string,
  filters: string[],
  filterOptions?: Array<{ filterId: string; condition?: string }>
): Promise<any> {
  const s = need(sessionId);
  const r = await s.client.send("setExceptionBreakpoints", {
    filters,
    ...(filterOptions ? { filterOptions } : {}),
  });
  return r.body;
}

export async function dapSetDataBreakpoints(
  sessionId: string,
  breakpoints: Array<{ dataId: string; accessType?: string; condition?: string; hitCondition?: string }>
): Promise<any> {
  const s = need(sessionId);
  const r = await s.client.send("setDataBreakpoints", { breakpoints });
  return r.body;
}

export async function dapDataBreakpointInfo(
  sessionId: string,
  variablesReference: number,
  name: string
): Promise<any> {
  const s = need(sessionId);
  const r = await s.client.send("dataBreakpointInfo", { variablesReference, name });
  return r.body;
}

// ── Execution control ─────────────────────────────────────────────────────────

export async function dapWaitForPause(
  sessionId: string,
  timeoutMs = 30_000
): Promise<StopResult> {
  const s = need(sessionId);
  if (s.paused && s.stoppedThreadId !== undefined) {
    return {
      reason: s.stopReason ?? "other",
      threadId: s.stoppedThreadId,
      description: s.stopDescription,
    };
  }
  return new Promise<StopResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      s.pendingWait = undefined;
      reject(new Error(`dap_wait_for_pause timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    s.pendingWait = { resolve, reject, timer };
  });
}

export async function dapGetStatus(sessionId: string): Promise<{
  paused: boolean;
  stopReason?: string;
  stopDescription?: string;
  stoppedThreadId?: number;
}> {
  const s = need(sessionId);
  return {
    paused: s.paused,
    stopReason: s.stopReason,
    stopDescription: s.stopDescription,
    stoppedThreadId: s.stoppedThreadId,
  };
}

export async function dapGetThreads(sessionId: string): Promise<any> {
  const s = need(sessionId);
  const r = await s.client.send("threads");
  return r.body;
}

export async function dapContinue(
  sessionId: string,
  threadId?: number
): Promise<any> {
  const s = need(sessionId);
  const tid = threadId ?? s.stoppedThreadId ?? 1;
  const r = await s.client.send("continue", { threadId: tid });
  return r.body;
}

export async function dapPause(
  sessionId: string,
  threadId = 1
): Promise<{ ok: boolean }> {
  const s = need(sessionId);
  await s.client.send("pause", { threadId });
  return { ok: true };
}

export async function dapNext(
  sessionId: string,
  threadId?: number,
  granularity?: string
): Promise<{ ok: boolean }> {
  const s = need(sessionId);
  const tid = threadId ?? needPaused(s);
  await s.client.send("next", {
    threadId: tid,
    ...(granularity ? { granularity } : {}),
  });
  return { ok: true };
}

export async function dapStepIn(
  sessionId: string,
  threadId?: number,
  targetId?: number,
  granularity?: string
): Promise<{ ok: boolean }> {
  const s = need(sessionId);
  const tid = threadId ?? needPaused(s);
  await s.client.send("stepIn", {
    threadId: tid,
    ...(targetId !== undefined ? { targetId } : {}),
    ...(granularity ? { granularity } : {}),
  });
  return { ok: true };
}

export async function dapStepOut(
  sessionId: string,
  threadId?: number,
  granularity?: string
): Promise<{ ok: boolean }> {
  const s = need(sessionId);
  const tid = threadId ?? needPaused(s);
  await s.client.send("stepOut", {
    threadId: tid,
    ...(granularity ? { granularity } : {}),
  });
  return { ok: true };
}

/** Get valid goto targets for a source location, then use dapGoto. */
export async function dapGotoTargets(
  sessionId: string,
  file: string,
  line: number
): Promise<any> {
  const s = need(sessionId);
  const r = await s.client.send("gotoTargets", {
    source: { path: file },
    line,
  });
  return r.body;
}

export async function dapGoto(
  sessionId: string,
  threadId: number,
  targetId: number
): Promise<{ ok: boolean }> {
  const s = need(sessionId);
  await s.client.send("goto", { threadId, targetId });
  return { ok: true };
}

// ── Stack & scopes ────────────────────────────────────────────────────────────

export async function dapGetStack(
  sessionId: string,
  threadId?: number,
  startFrame = 0,
  levels = 20
): Promise<any> {
  const s = need(sessionId);
  const tid = threadId ?? needPaused(s);
  const r = await s.client.send("stackTrace", { threadId: tid, startFrame, levels });
  return r.body;
}

export async function dapGetScopes(
  sessionId: string,
  frameId: number
): Promise<any> {
  const s = need(sessionId);
  const r = await s.client.send("scopes", { frameId });
  return r.body;
}

/**
 * Expand a variablesReference (from scopes or from a variable with children).
 * filter: "indexed" for array elements, "named" for named properties, omit for all.
 */
export async function dapGetVariables(
  sessionId: string,
  variablesReference: number,
  filter?: "indexed" | "named",
  start?: number,
  count?: number
): Promise<any> {
  const s = need(sessionId);
  const r = await s.client.send("variables", {
    variablesReference,
    ...(filter ? { filter } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(count !== undefined ? { count } : {}),
  });
  return r.body;
}

export async function dapSetVariable(
  sessionId: string,
  variablesReference: number,
  name: string,
  value: string
): Promise<any> {
  const s = need(sessionId);
  const r = await s.client.send("setVariable", { variablesReference, name, value });
  return r.body;
}

/**
 * context: "watch" (in frame scope), "repl" (global), "hover", "clipboard"
 */
export async function dapEvaluate(
  sessionId: string,
  expression: string,
  frameId?: number,
  context?: string
): Promise<any> {
  const s = need(sessionId);
  const r = await s.client.send("evaluate", {
    expression,
    ...(frameId !== undefined ? { frameId } : {}),
    context: context ?? (frameId !== undefined ? "watch" : "repl"),
  });
  return r.body;
}

export async function dapSetExpression(
  sessionId: string,
  expression: string,
  value: string,
  frameId?: number
): Promise<any> {
  const s = need(sessionId);
  const r = await s.client.send("setExpression", {
    expression,
    value,
    ...(frameId !== undefined ? { frameId } : {}),
  });
  return r.body;
}

// ── Step-in targets ───────────────────────────────────────────────────────────

/** List available step-in targets at the current position (disambiguate which call to step into). */
export async function dapStepInTargets(
  sessionId: string,
  frameId: number
): Promise<any> {
  const s = need(sessionId);
  const r = await s.client.send("stepInTargets", { frameId });
  return r.body;
}

// ── Sources ───────────────────────────────────────────────────────────────────

export async function dapGetLoadedSources(sessionId: string): Promise<any> {
  const s = need(sessionId);
  const r = await s.client.send("loadedSources");
  return r.body;
}

export async function dapGetSource(
  sessionId: string,
  path?: string,
  sourceReference?: number
): Promise<any> {
  const s = need(sessionId);
  if (!path && !sourceReference)
    throw new Error("provide path or sourceReference");
  const r = await s.client.send("source", {
    source: { path, sourceReference },
    sourceReference: sourceReference ?? 0,
  });
  return r.body;
}

// ── Output (live capture) ─────────────────────────────────────────────────────

/** Collect output events for durationMs then return. */
export async function dapTailOutput(
  sessionId: string,
  durationMs: number,
  maxEntries = 200
): Promise<{ entries: OutputEntry[] }> {
  const s = need(sessionId);
  const collected: OutputEntry[] = [];
  const handler = (body: any) => {
    if (collected.length < maxEntries) {
      collected.push({
        ts: Date.now(),
        category: body.category ?? "stdout",
        output: body.output ?? "",
      });
    }
  };
  (s.client as any).on("output", handler);
  await new Promise((r) => setTimeout(r, durationMs));
  (s.client as any).removeListener("output", handler);
  return { entries: collected };
}

/** Flush all buffered output collected since session start. */
export async function dapDrainOutput(
  sessionId: string,
  maxEntries = 500
): Promise<{ entries: OutputEntry[] }> {
  const s = need(sessionId);
  const entries = s.outputBuffer.splice(0, maxEntries);
  return { entries };
}
