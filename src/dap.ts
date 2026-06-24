/**
 * Low-level DAP (Debug Adapter Protocol) TCP client.
 *
 * Wire format: Content-Length: N\r\n\r\n{JSON}
 * Three message types: request, response, event.
 */
import { createConnection, type Socket } from "node:net";
import { EventEmitter } from "node:events";

export interface DAPResponse {
  seq: number;
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: any;
}

export interface DAPEvent {
  seq: number;
  type: "event";
  event: string;
  body?: any;
}

export class DAPClient extends EventEmitter {
  private seq = 1;
  private pending = new Map<
    number,
    { resolve: (r: DAPResponse) => void; reject: (e: Error) => void }
  >();
  private buf = Buffer.alloc(0);

  constructor(private socket: Socket) {
    super();
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("error", (e) => {
      process.stderr.write(`DAP socket error: ${e.message}\n`);
      this.emit("error", e);
    });
    socket.on("close", () => this.emit("close"));
  }

  private _onData(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const sep = this.buf.indexOf("\r\n\r\n");
      if (sep === -1) break;
      const hdr = this.buf.slice(0, sep).toString("ascii");
      const m = hdr.match(/Content-Length:\s*(\d+)/i);
      if (!m) { this.buf = this.buf.slice(sep + 4); continue; }
      const len = parseInt(m[1], 10);
      const start = sep + 4;
      if (this.buf.length < start + len) break;
      const raw = this.buf.slice(start, start + len).toString("utf8");
      this.buf = this.buf.slice(start + len);
      let msg: any;
      try { msg = JSON.parse(raw); } catch { continue; }
      if (msg.type === "response") {
        const p = this.pending.get(msg.request_seq);
        if (p) {
          this.pending.delete(msg.request_seq);
          if (msg.success) p.resolve(msg as DAPResponse);
          else p.reject(new Error(msg.message ?? `DAP ${msg.command} failed`));
        }
      } else if (msg.type === "event") {
        const ev = msg as DAPEvent;
        this.emit("event", ev);
        this.emit(ev.event, ev.body);
      }
    }
  }

  send(command: string, args?: Record<string, unknown>): Promise<DAPResponse> {
    const seq = this.seq++;
    const payload = JSON.stringify({
      seq,
      type: "request",
      command,
      arguments: args ?? {},
    });
    const frame = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      this.socket.write(frame, "utf8");
    });
  }

  close() { this.socket.destroy(); }
}

export async function connectDAP(
  host = "127.0.0.1",
  port = 5678
): Promise<DAPClient> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host, port });
    sock.once("connect", () => resolve(new DAPClient(sock)));
    sock.once("error", reject);
  });
}
