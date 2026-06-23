/**
 * Stateful debugger session — mirrors VS Code DAP concepts over raw CDP.
 *
 * Lifecycle:
 *   start_debug_session  → sessionId
 *   set_breakpoint       → breakpointId
 *   continue / step_over / step_into / step_out
 *   get_status           → paused?, frames
 *   get_locals           (only while paused)
 *   evaluate             (frame index = paused scope; omit = global)
 *   close_debug_session
 *
 * The session holds a single persistent CDP connection and keeps track of
 * pause state. All "while paused" operations check session.paused and
 * throw immediately if the target is running.
 */
import { randomUUID } from "node:crypto";
import { connect, type TargetSelector } from "./cdp.ts";

// ── Internal state ───────────────────────────────────────────────────────────

interface DebugSession {
  id: string;
  client: any;
  /** True between a "paused" and the next "resumed" CDP event. */
  paused: boolean;
  pauseReason?: string;
  /** Raw CDP CallFrame objects — have callFrameId, scopeChain, location. */
  callFrames?: any[];
  /** One pending wait_for_pause caller at a time. */
  pendingWait?: {
    resolve: (r: PauseResult) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
}

const sessions = new Map<string, DebugSession>();

function need(sessionId: string): DebugSession {
  const s = sessions.get(sessionId);
  if (!s) throw new Error(`unknown sessionId: ${sessionId}`);
  return s;
}

function needPaused(s: DebugSession): any[] {
  if (!s.paused || !s.callFrames) throw new Error("target is not paused");
  return s.callFrames;
}

// ── Public return types ───────────────────────────────────────────────────────

export interface StackFrame {
  index: number;
  function: string;
  url: string;
  line: number;
  column: number;
}

export interface PauseResult {
  reason: string;
  frames: StackFrame[];
}

function toFrames(raw: any[]): StackFrame[] {
  return raw.map((f, i) => ({
    index: i,
    function: f.functionName || "<anonymous>",
    url: f.url || "<unknown>",
    line: (f.location?.lineNumber ?? 0) + 1,
    column: (f.location?.columnNumber ?? 0) + 1,
  }));
}

// ── Session lifecycle ─────────────────────────────────────────────────────────

export async function startDebugSession(
  sel: TargetSelector
): Promise<{ sessionId: string }> {
  const client = await connect(sel);
  const { Debugger, Runtime } = client;

  await Runtime.enable();
  await Debugger.enable();

  const session: DebugSession = { id: randomUUID(), client, paused: false };
  sessions.set(session.id, session);

  // Skip --inspect-brk startup pause if present.
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 400);
    const onInitial = async () => {
      (Debugger as any).removeListener("paused", onInitial);
      clearTimeout(t);
      await Debugger.resume().catch(() => {});
      resolve();
    };
    (Debugger as any).on("paused", onInitial);
  });

  (Debugger as any).on("paused", (params: any) => {
    session.paused = true;
    session.pauseReason = params.reason;
    session.callFrames = params.callFrames ?? [];

    if (session.pendingWait) {
      clearTimeout(session.pendingWait.timer);
      session.pendingWait.resolve({
        reason: params.reason,
        frames: toFrames(session.callFrames!),
      });
      session.pendingWait = undefined;
    }
  });

  (Debugger as any).on("resumed", () => {
    session.paused = false;
    session.pauseReason = undefined;
    session.callFrames = undefined;
  });

  return { sessionId: session.id };
}

export async function closeDebugSession(
  sessionId: string
): Promise<{ ok: boolean }> {
  const s = sessions.get(sessionId);
  if (!s) return { ok: false };
  s.pendingWait?.reject(new Error("session closed"));
  clearTimeout(s.pendingWait?.timer);
  sessions.delete(sessionId);
  try { await s.client.close(); } catch { /**/ }
  return { ok: true };
}

export function listDebugSessions() {
  return Array.from(sessions.values()).map((s) => ({
    sessionId: s.id,
    paused: s.paused,
    pauseReason: s.pauseReason,
  }));
}

// ── Breakpoints ───────────────────────────────────────────────────────────────

export async function setBreakpoint(
  sessionId: string,
  file: string,
  line: number,
  condition?: string
): Promise<{ breakpointId: string; resolved: boolean; resolvedLine?: number }> {
  const s = need(sessionId);
  const urlRegex = file.replace(/[\\.+*?^$|()[\]{}]/g, (m) =>
    m === "\\" ? "[\\\\/]" : `\\${m}`
  );
  const r = await s.client.Debugger.setBreakpointByUrl({
    urlRegex,
    lineNumber: Math.max(0, line - 1),
    columnNumber: 0,
    condition,
  } as any) as any;
  const loc = r.locations?.[0];
  return {
    breakpointId: r.breakpointId,
    resolved: !!loc,
    resolvedLine: loc ? loc.lineNumber + 1 : undefined,
  };
}

export async function removeBreakpoint(
  sessionId: string,
  breakpointId: string
): Promise<{ ok: boolean }> {
  const s = need(sessionId);
  await s.client.Debugger.removeBreakpoint({ breakpointId } as any);
  return { ok: true };
}

// ── Execution control ─────────────────────────────────────────────────────────

/**
 * Block until the target pauses (breakpoint / exception / step).
 * If already paused, returns immediately.
 */
export async function waitForPause(
  sessionId: string,
  timeoutMs = 30_000
): Promise<PauseResult> {
  const s = need(sessionId);
  if (s.paused && s.callFrames) {
    return { reason: s.pauseReason ?? "other", frames: toFrames(s.callFrames) };
  }
  return new Promise<PauseResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      s.pendingWait = undefined;
      reject(new Error(`wait_for_pause timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    s.pendingWait = { resolve, reject, timer };
  });
}

export async function continueExecution(
  sessionId: string
): Promise<{ ok: boolean }> {
  const s = need(sessionId);
  await s.client.Debugger.resume();
  return { ok: true };
}

export async function stepOver(sessionId: string): Promise<{ ok: boolean }> {
  const s = need(sessionId);
  await s.client.Debugger.stepOver();
  return { ok: true };
}

export async function stepInto(sessionId: string): Promise<{ ok: boolean }> {
  const s = need(sessionId);
  await s.client.Debugger.stepInto();
  return { ok: true };
}

export async function stepOut(sessionId: string): Promise<{ ok: boolean }> {
  const s = need(sessionId);
  await s.client.Debugger.stepOut();
  return { ok: true };
}

export async function pauseTarget(sessionId: string): Promise<{ ok: boolean }> {
  const s = need(sessionId);
  await s.client.Debugger.pause();
  return { ok: true };
}

// ── Inspection (requires paused) ──────────────────────────────────────────────

export async function getStatus(sessionId: string): Promise<{
  paused: boolean;
  pauseReason?: string;
  frames?: StackFrame[];
}> {
  const s = need(sessionId);
  return {
    paused: s.paused,
    pauseReason: s.pauseReason,
    frames: s.callFrames ? toFrames(s.callFrames) : undefined,
  };
}

export async function getLocals(
  sessionId: string,
  frameIndex = 0
): Promise<Record<string, unknown>> {
  const s = need(sessionId);
  const frames = needPaused(s);
  const frame = frames[frameIndex];
  if (!frame) throw new Error(`frame ${frameIndex} out of range (${frames.length} total)`);

  const out: Record<string, unknown> = {};
  for (const scope of frame.scopeChain ?? []) {
    if (scope.type === "global") continue;
    try {
      const props = await s.client.Runtime.getProperties({
        objectId: scope.object.objectId,
        ownProperties: true,
        accessorPropertiesOnly: false,
        generatePreview: false,
      } as any) as any;
      for (const p of props.result ?? []) {
        if (!p.value) continue;
        out[`${scope.type}:${p.name}`] =
          p.value.value ?? p.value.description ?? `<${p.value.type}>`;
      }
    } catch { /* skip unreadable scope */ }
  }
  return out;
}

export async function evaluate(
  sessionId: string,
  expression: string,
  frameIndex?: number,
  returnByValue = true
): Promise<{ ok: boolean; value?: unknown; type?: string; exception?: string }> {
  const s = need(sessionId);

  if (frameIndex !== undefined) {
    // Frame eval — must be paused, callFrameId required.
    const frames = needPaused(s);
    const frame = frames[frameIndex];
    if (!frame) throw new Error(`frame ${frameIndex} out of range (${frames.length} total)`);

    const r = await s.client.Debugger.evaluateOnCallFrame({
      callFrameId: frame.callFrameId,
      expression,
      returnByValue,
    } as any) as any;

    if (r.exceptionDetails) {
      return {
        ok: false,
        exception:
          r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
      };
    }
    return { ok: true, value: r.result?.value, type: r.result?.type };
  }

  // Global eval — works paused or running.
  const r = await s.client.Runtime.evaluate({
    expression,
    returnByValue,
    awaitPromise: true,
  } as any) as any;

  if (r.exceptionDetails) {
    return {
      ok: false,
      exception:
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
    };
  }
  return { ok: true, value: r.result?.value, type: r.result?.type };
}
