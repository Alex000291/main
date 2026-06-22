import CDP from "chrome-remote-interface";

const DEFAULT_PORT = 9229;
const DEFAULT_HOST = "127.0.0.1";

export interface TargetSelector {
  port?: number;
  host?: string;
  pid?: number; // accepted for API compatibility with proposal, used for hint only
  targetId?: string;
}

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export async function listTargets(sel: TargetSelector = {}): Promise<CdpTarget[]> {
  const port = sel.port ?? DEFAULT_PORT;
  const host = sel.host ?? DEFAULT_HOST;
  const targets = await CDP.List({ host, port });
  return targets as unknown as CdpTarget[];
}

/**
 * Resolve a TargetSelector to a specific ws URL + human label.
 * targetId accepts: full ws URL, exact id, id prefix, or title substring.
 */
async function resolveTarget(
  sel: TargetSelector
): Promise<{ wsUrl: string; label: string }> {
  const port = sel.port ?? DEFAULT_PORT;
  const host = sel.host ?? DEFAULT_HOST;
  const targets = await listTargets({ host, port });

  if (targets.length === 0) {
    throw new Error(
      `No CDP targets at ${host}:${port}. Is the process running with --inspect=${port}?`
    );
  }

  if (sel.targetId) {
    const q = sel.targetId;
    const t =
      targets.find((t) => t.webSocketDebuggerUrl === q) ??
      targets.find((t) => t.id === q) ??
      targets.find((t) => t.id.startsWith(q)) ??
      targets.find((t) => t.title.includes(q));
    if (!t) {
      const available = targets
        .map((t) => `"${t.title}" (${t.id.slice(0, 8)})`)
        .join(", ");
      throw new Error(
        `No target matching "${q}" at ${host}:${port}. Available: ${available}`
      );
    }
    return {
      wsUrl: t.webSocketDebuggerUrl,
      label: `${t.title} (${t.id.slice(0, 8)})`,
    };
  }

  const node = targets.find((t) => t.type === "node") ?? targets[0];
  return {
    wsUrl: node.webSocketDebuggerUrl,
    label: `${node.title} (${node.id.slice(0, 8)})`,
  };
}

// ---------------------------------------------------------------------------

/**
 * Open a CDP client to the selected target. Caller MUST close it.
 * Supports fuzzy targetId matching (ws URL, exact id, id prefix, title substring).
 */
export async function connect(sel: TargetSelector = {}): Promise<CDP.Client> {
  const port = sel.port ?? DEFAULT_PORT;
  const host = sel.host ?? DEFAULT_HOST;
  const { wsUrl } = await resolveTarget(sel);
  return CDP({ host, port, target: wsUrl });
}

/**
 * Run an action against a fresh CDP client and close it afterwards.
 * On error the error message is prefixed with the target label for easier diagnosis.
 */
export async function withClient<T>(
  sel: TargetSelector,
  fn: (client: CDP.Client) => Promise<T>
): Promise<T> {
  const port = sel.port ?? DEFAULT_PORT;
  const host = sel.host ?? DEFAULT_HOST;
  const { wsUrl, label } = await resolveTarget(sel);
  const client = await CDP({ host, port, target: wsUrl });
  try {
    return await fn(client);
  } catch (e: any) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[${label}] ${msg}`);
  } finally {
    try {
      await client.close();
    } catch {
      // ignore
    }
  }
}
