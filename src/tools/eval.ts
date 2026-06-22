/**
 * eval_in_context — evaluate a JS expression in the target.
 *
 * Two modes:
 * - global (default): Runtime.evaluate in the default execution context
 * - frame: pause target, evaluate on a specific callFrame's scope chain
 *
 * Pass sessionId (from open_breakpoint_session) to reuse an existing CDP
 * connection instead of opening a new one. Required when the target is
 * already paused by that session — opening a second connection and calling
 * Debugger.pause() again would race/deadlock.
 */
import { withClient, type TargetSelector } from "../cdp/client.ts";
import { getSession } from "../cdp/session.ts";

export interface EvalArgs extends TargetSelector {
  expression: string;
  frame?: number;
  returnByValue?: boolean;
  timeoutMs?: number;
  /** Reuse an existing session's CDP connection (from open_breakpoint_session).
   *  When provided, no new connection is opened and the target need not be
   *  paused again — required for frame eval while open_breakpoint_session holds
   *  the paused state. */
  sessionId?: string;
}

export interface EvalResult {
  ok: boolean;
  value?: unknown;
  type?: string;
  description?: string;
  exception?: string;
  frame?: number;
}

async function evalGlobal(Runtime: any, expression: string, returnByValue: boolean, timeoutMs: number): Promise<EvalResult> {
  const r = await Runtime.evaluate({
    expression,
    returnByValue,
    awaitPromise: true,
    timeout: timeoutMs,
  } as any) as any;
  if (r.exceptionDetails) {
    return {
      ok: false,
      exception:
        r.exceptionDetails.exception?.description ??
        r.exceptionDetails.text ??
        "evaluation threw",
    };
  }
  return {
    ok: true,
    value: r.result?.value,
    type: r.result?.type,
    description: r.result?.description,
  };
}

async function evalOnFrame(Debugger: any, callFrames: any[], frame: number, expression: string, returnByValue: boolean): Promise<EvalResult> {
  if (frame >= callFrames.length) {
    return {
      ok: false,
      exception: `frame ${frame} out of range (${callFrames.length} frames available)`,
      frame,
    };
  }
  const cf = callFrames[frame];
  const r = await Debugger.evaluateOnCallFrame({
    callFrameId: cf.callFrameId,
    expression,
    returnByValue,
  } as any) as any;
  if (r.exceptionDetails) {
    return {
      ok: false,
      exception:
        r.exceptionDetails.exception?.description ??
        r.exceptionDetails.text ??
        "evaluation threw",
      frame,
    };
  }
  return {
    ok: true,
    value: r.result?.value,
    type: r.result?.type,
    description: r.result?.description,
    frame,
  };
}

export async function evalInContext(args: EvalArgs): Promise<EvalResult> {
  const { expression, frame, returnByValue = true, timeoutMs = 5000 } = args;

  // --- Reuse an existing session connection (target already paused) ---
  if (args.sessionId !== undefined) {
    const session = getSession(args.sessionId);
    if (!session) {
      return { ok: false, exception: `unknown sessionId: ${args.sessionId}` };
    }
    const client = session.client as any;
    const { Runtime, Debugger } = client;
    await Runtime.enable();
    await Debugger.enable();

    if (frame === undefined) {
      return evalGlobal(Runtime, expression, returnByValue, timeoutMs);
    }

    // Target is already paused by the session; get current backtrace.
    const stackResp = await Debugger.getBacktrace().catch(() => null) as any;
    const callFrames: any[] = stackResp?.callFrames ?? [];
    return evalOnFrame(Debugger, callFrames, frame, expression, returnByValue);
  }

  // --- Default path: open a fresh connection ---
  return withClient(args, async (client) => {
    const { Runtime, Debugger } = client;
    await Runtime.enable();

    if (frame === undefined) {
      return evalGlobal(Runtime, expression, returnByValue, timeoutMs);
    }

    // Frame eval: pause target (or reuse existing pause), evaluate, resume.
    await Debugger.enable();

    // Fix: check if target is already paused before calling pause() to avoid
    // racing/deadlocking with an existing pause state.
    // Debugger.enable() on an already-paused target fires a paused event immediately.
    let existingFrames: any[] | null = null;
    await new Promise<void>((resolve) => {
      const onAlreadyPaused = (params: any) => {
        (Debugger as any).removeListener?.("paused", onAlreadyPaused);
        clearTimeout(t);
        existingFrames = params.callFrames || [];
        resolve();
      };
      const t = setTimeout(() => {
        (Debugger as any).removeListener?.("paused", onAlreadyPaused);
        resolve();
      }, 300);
      (Debugger as any).on("paused", onAlreadyPaused);
    });

    if (existingFrames !== null) {
      // Already paused — evaluate directly without calling pause() again.
      const result = await evalOnFrame(Debugger, existingFrames, frame, expression, returnByValue);
      await Debugger.resume().catch(() => {});
      return result;
    }

    return new Promise<EvalResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        Debugger.resume().catch(() => {});
        resolve({ ok: false, exception: `frame eval timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      const onPaused = async (params: any) => {
        clearTimeout(timer);
        try {
          (Debugger as any).removeListener?.("paused", onPaused);
        } catch {}
        try {
          const callFrames = params.callFrames || [];
          const result = await evalOnFrame(Debugger, callFrames, frame, expression, returnByValue);
          await Debugger.resume();
          resolve(result);
        } catch (e) {
          reject(e);
        }
      };

      (Debugger as any).on("paused", onPaused);
      Debugger.pause().catch(reject);
    });
  });
}
