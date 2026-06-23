/**
 * Low-level CDP connection helpers.
 */
import CDP from "chrome-remote-interface";

export interface TargetSelector {
  port?: number;
  host?: string;
  targetId?: string;
}

export async function connect(sel: TargetSelector = {}): Promise<CDP.Client> {
  const opts: CDP.Options = {
    port: sel.port ?? 9229,
    host: sel.host ?? "127.0.0.1",
    target: sel.targetId,
  };
  const client = await CDP(opts);
  // Prevent unhandled 'error' events from crashing the MCP server process.
  (client as any).on("error", (e: Error) => {
    process.stderr.write(`CDP client error: ${e.message}\n`);
  });
  return client;
}

export async function listTargets(sel: TargetSelector = {}) {
  const list = await CDP.List({
    port: sel.port ?? 9229,
    host: sel.host ?? "127.0.0.1",
  });
  return list;
}
