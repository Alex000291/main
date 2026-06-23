/**
 * Stateless diagnostic tools — each opens a fresh CDP connection,
 * does its work, and closes. No session required.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, listTargets as cdpListTargets, type TargetSelector } from "./cdp.ts";

export { listTargets } from "./cdp.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function withClient<T>(
  sel: TargetSelector,
  fn: (client: any) => Promise<T>
): Promise<T> {
  const client = await connect(sel);
  try {
    return await fn(client);
  } finally {
    client.close().catch(() => {});
  }
}

async function ensureDir(p: string) {
  await mkdir(p, { recursive: true });
}

// ── Heap ─────────────────────────────────────────────────────────────────────

export async function heapSnapshot(
  sel: TargetSelector,
  topN = 20
): Promise<object> {
  return withClient(sel, async (client) => {
    const { HeapProfiler } = client;
    await HeapProfiler.enable();

    const chunks: string[] = [];
    (HeapProfiler as any).on("addHeapSnapshotChunk", (p: any) =>
      chunks.push(p.chunk)
    );

    await HeapProfiler.takeHeapSnapshot({ reportProgress: false } as any);
    const raw = chunks.join("");
    const snap = JSON.parse(raw);

    const dir = join(tmpdir(), "inspectctl", "snapshots");
    await ensureDir(dir);
    const path = join(dir, `snap-${Date.now()}-${process.pid}.heapsnapshot`);
    await writeFile(path, raw);

    // Summarise by type
    const { nodes, strings, snapshot: meta } = snap;
    const fields = meta.node_fields as string[];
    const typeIdx = fields.indexOf("type");
    const nameIdx = fields.indexOf("name");
    const selfSzIdx = fields.indexOf("self_size");
    const idIdx = fields.indexOf("id");
    const fieldCount = fields.length;
    const nodeTypes = meta.node_types[0] as string[];

    type Entry = { count: number; selfSize: number };
    const byType = new Map<string, Entry>();
    const topObjects: Array<{ id: number; type: string; name: string; selfSize: number }> = [];

    for (let i = 0; i < nodes.length; i += fieldCount) {
      const type = nodeTypes[nodes[i + typeIdx]];
      const nameStr = strings[nodes[i + nameIdx]] as string;
      const selfSz = nodes[i + selfSzIdx] as number;
      const id = nodes[i + idIdx] as number;
      const key = `${type}:${nameStr.slice(0, 80)}`;
      const e = byType.get(key) ?? { count: 0, selfSize: 0 };
      e.count++;
      e.selfSize += selfSz;
      byType.set(key, e);
      topObjects.push({ id, type, name: nameStr.slice(0, 120), selfSize: selfSz });
    }

    topObjects.sort((a, b) => b.selfSize - a.selfSize);
    const byTypeSorted = [...byType.entries()]
      .sort(([, a], [, b]) => b.selfSize - a.selfSize)
      .slice(0, topN)
      .map(([type, e]) => ({ type, ...e }));

    return {
      path,
      totalNodes: nodes.length / fieldCount,
      totalSelfSize: byTypeSorted.reduce((s, e) => s + e.selfSize, 0),
      byType: byTypeSorted,
      topObjects: topObjects.slice(0, topN),
    };
  });
}

export async function heapDiff(
  before: string,
  after: string,
  topN = 20
): Promise<object> {
  const { readFile } = await import("node:fs/promises");
  const [a, b] = await Promise.all([readFile(before, "utf8"), readFile(after, "utf8")]);
  const snapA = JSON.parse(a);
  const snapB = JSON.parse(b);

  function summarise(snap: any) {
    const { nodes, strings, snapshot: meta } = snap;
    const fields = meta.node_fields as string[];
    const typeIdx = fields.indexOf("type");
    const nameIdx = fields.indexOf("name");
    const selfSzIdx = fields.indexOf("self_size");
    const fieldCount = fields.length;
    const nodeTypes = meta.node_types[0] as string[];
    const map = new Map<string, { count: number; selfSize: number }>();
    for (let i = 0; i < nodes.length; i += fieldCount) {
      const key = `${nodeTypes[nodes[i + typeIdx]]}:${(strings[nodes[i + nameIdx]] as string).slice(0, 80)}`;
      const e = map.get(key) ?? { count: 0, selfSize: 0 };
      e.count++;
      e.selfSize += nodes[i + selfSzIdx] as number;
      map.set(key, e);
    }
    return map;
  }

  const ma = summarise(snapA);
  const mb = summarise(snapB);
  const all = new Set([...ma.keys(), ...mb.keys()]);

  const growth: Array<object> = [];
  for (const key of all) {
    const ea = ma.get(key) ?? { count: 0, selfSize: 0 };
    const eb = mb.get(key) ?? { count: 0, selfSize: 0 };
    const ds = eb.selfSize - ea.selfSize;
    if (ds !== 0) {
      growth.push({
        type: key,
        countBefore: ea.count,
        countAfter: eb.count,
        deltaCount: eb.count - ea.count,
        sizeBefore: ea.selfSize,
        sizeAfter: eb.selfSize,
        deltaSize: ds,
      });
    }
  }
  growth.sort((x: any, y: any) => Math.abs(y.deltaSize) - Math.abs(x.deltaSize));

  const totalBefore = [...ma.values()].reduce((s, e) => s + e.selfSize, 0);
  const totalAfter = [...mb.values()].reduce((s, e) => s + e.selfSize, 0);

  return {
    before,
    after,
    deltaNodes:
      [...mb.values()].reduce((s, e) => s + e.count, 0) -
      [...ma.values()].reduce((s, e) => s + e.count, 0),
    deltaSelfSize: totalAfter - totalBefore,
    growthByType: growth.slice(0, topN),
  };
}

// ── CPU profile ───────────────────────────────────────────────────────────────

export async function profileCpu(
  sel: TargetSelector,
  durationMs: number,
  topN = 10
): Promise<object> {
  return withClient(sel, async (client) => {
    const { Profiler } = client;
    await Profiler.enable();
    await Profiler.start();
    await new Promise((r) => setTimeout(r, durationMs));
    const { profile } = await Profiler.stop() as any;

    const nodes: Map<number, any> = new Map(
      profile.nodes.map((n: any) => [n.id, n])
    );
    const hits = new Map<number, number>();
    for (const id of profile.samples ?? []) {
      hits.set(id, (hits.get(id) ?? 0) + 1);
    }

    function totalHits(id: number): number {
      const n = nodes.get(id);
      if (!n) return 0;
      return (hits.get(id) ?? 0) + (n.children ?? []).reduce((s: number, c: number) => s + totalHits(c), 0);
    }

    const total = profile.samples?.length ?? 0;
    const ranked = profile.nodes
      .map((n: any) => {
        const hs = hits.get(n.id) ?? 0;
        const ht = totalHits(n.id);
        return {
          id: n.id,
          function: n.callFrame?.functionName || "(anonymous)",
          url: n.callFrame?.url || "0",
          line: (n.callFrame?.lineNumber ?? 0) + 1,
          hitSelf: hs,
          hitTotal: ht,
          selfPct: total ? (hs / total) * 100 : 0,
          totalPct: total ? (ht / total) * 100 : 0,
        };
      })
      .filter((n: any) => n.hitTotal > 0);

    const dir = join(tmpdir(), "inspectctl", "profiles");
    await ensureDir(dir);
    const path = join(dir, `cpu-${Date.now()}-${process.pid}.cpuprofile`);
    await writeFile(path, JSON.stringify(profile));

    return {
      path,
      durationMs,
      sampleCount: total,
      totalHits: total,
      hotSelf: [...ranked].sort((a: any, b: any) => b.hitSelf - a.hitSelf).slice(0, topN),
      hotTotal: [...ranked].sort((a: any, b: any) => b.hitTotal - a.hitTotal).slice(0, topN),
    };
  });
}

// ── Stack snapshot (no session) ───────────────────────────────────────────────

export async function getStack(sel: TargetSelector): Promise<object> {
  return withClient(sel, async (client) => {
    const { Debugger } = client;
    await Debugger.enable();
    const frames: any[] = [];
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1000);
      (Debugger as any).once("paused", (p: any) => {
        clearTimeout(t);
        frames.push(
          ...(p.callFrames ?? []).map((f: any) => ({
            function: f.functionName || "<anonymous>",
            url: f.url || "<unknown>",
            line: (f.location?.lineNumber ?? 0) + 1,
            column: (f.location?.columnNumber ?? 0) + 1,
          }))
        );
        Debugger.resume().catch(() => {});
        resolve();
      });
      Debugger.pause().catch(() => { clearTimeout(t); resolve(); });
    });
    return { callFrames: frames };
  });
}

// ── Async handles ─────────────────────────────────────────────────────────────

export async function listAsync(sel: TargetSelector): Promise<object> {
  return withClient(sel, async (client) => {
    await client.Runtime.enable();
    const r = await client.Runtime.evaluate({
      expression: `
        (() => {
          const h = process._getActiveHandles?.() ?? [];
          const r = process._getActiveRequests?.() ?? [];
          return JSON.stringify({
            resourcesInfo: [...new Set([...h, ...r].map(x => x.constructor?.name ?? 'Unknown'))],
            handles: h.map(x => ({ type: x.constructor?.name, detail: JSON.stringify(x.address ?? x._address ?? '') })),
            requests: r.map(x => ({ type: x.constructor?.name })),
          });
        })()
      `,
      returnByValue: true,
    } as any) as any;
    return JSON.parse(r.result?.value ?? "{}");
  });
}

// ── Tail logs ─────────────────────────────────────────────────────────────────

export async function tailLogs(
  sel: TargetSelector,
  durationMs: number,
  maxEntries = 200
): Promise<object> {
  return withClient(sel, async (client) => {
    const { Runtime } = client;
    await Runtime.enable();
    const entries: any[] = [];

    (Runtime as any).on("consoleAPICalled", (p: any) => {
      if (entries.length >= maxEntries) return;
      entries.push({
        ts: p.timestamp,
        type: p.type,
        args: (p.args ?? []).map((a: any) => a.value ?? a.description ?? `<${a.type}>`),
      });
    });

    (Runtime as any).on("exceptionThrown", (p: any) => {
      if (entries.length >= maxEntries) return;
      entries.push({
        ts: p.timestamp,
        type: "exception",
        text: p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text,
      });
    });

    await new Promise((r) => setTimeout(r, durationMs));
    return { entries };
  });
}
