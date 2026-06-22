# inspectctl

MCP server that gives AI agents debugger-level visibility into Node.js processes via the Chrome DevTools Protocol.

Stop pasting `console.log` output and heap dumps into Claude. Let it look.

## What it does

8 tools exposed over MCP stdio:

| Tool | Action |
|------|--------|
| `heap_snapshot` | V8 heap dump → top N objects + type breakdown (full snapshot on disk) |
| `heap_diff` | Diff two snapshots, find leak culprits |
| `get_stack` | Pause briefly, return sync + async call stack, resume |
| `eval_in_context` | Run an expression in the target (global or call-frame scope) |
| `breakpoint` | Set a breakpoint, block until hit, return locals |
| `profile_cpu` | Sample CPU for N ms, return hot self/total nodes |
| `list_async` | Pending timers, sockets, handles, requests |
| `tail_logs` | Capture console + exceptions for N ms |

Plus session helpers (`open_breakpoint_session`, `open_log_session`, `drain_events`, `close_session`, `list_sessions`) for long-lived event streams.

## Status

v0.0.1 — Node.js targets only. Python (`debugpy` + `py-spy`) planned for v0.1.

## Install

```sh
npm install
npm run build
```

## Single-binary distribution

Built with Node SEA (Single Executable Applications, Node 20+). No external runtime required for end users.

```sh
# Windows: produces bundle\inspectctl.exe (~92 MB)
npm run build:exe

# macOS: produces bundle/inspectctl (Mach-O); add --dmg for a disk image
npm run build:macos
npm run build:macos:dmg

# Linux: produces bundle/inspectctl (ELF)
npm run build:linux
```

Wire the binary into your MCP client by pointing `command` at the binary path; no `args` needed.

Caveats:
- Unsigned binaries trigger SmartScreen on Windows and Gatekeeper on macOS. Code-sign with your own certificate for distribution.
- Builds are platform-native: build the macOS binary on a Mac (or GitHub Actions `macos-latest`), the Linux binary on Linux, etc.

## Quickstart

In one terminal, start the demo target:

```sh
npm run target
# → demo target listening on http://localhost:3030
# → debugger on ws://localhost:9229
```

In another, wire `inspectctl` into your MCP client. For Claude Code:

```json
{
  "mcpServers": {
    "inspectctl": {
      "command": "node",
      "args": ["D:/works/web3/inspectctl/dist/index.js"]
    }
  }
}
```

For Letta, point at the same binary via stdio transport.

Then ask your agent things like:

- *"Why is the cache growing? Take a heap_snapshot now, wait 10 seconds, take another, and diff."*
- *"Set a breakpoint at examples/target.cjs:56, then I'll hit /buggy. Tell me what userId is."*
- *"Profile CPU for 3 seconds while I hit /cpu. Which function is hottest?"*
- *"List the async work — anything stuck?"*

## Architecture

```
[your Node process --inspect=9229]
            ↑ CDP (WebSocket)
[inspectctl MCP server (this repo)]  ← local process
            ↑ MCP stdio
[Claude Code | Letta | Cursor | Cline | Continue]
```

The MCP server runs as a child of the agent's IDE/CLI and connects to the target on demand. No shared state with the agent context; if a CDP call hangs, the agent is unaffected.

## Targeting

Every tool accepts the same target selector:

- `port` — CDP inspector port (default `9229`)
- `host` — default `127.0.0.1`
- `pid` — accepted for API compatibility, used as a hint
- `targetId` — specific WebSocket URL when multiple debuggers are listening

If your target uses a non-default port (`node --inspect=9230 …`), pass it explicitly.

## Snapshots and profiles on disk

Heap snapshots and CPU profiles are written to `tmpdir()/inspectctl/{snapshots,profiles}/` because their JSON is too large to round-trip through an MCP response. The summary returned to the agent includes the path; you can open them in Chrome DevTools (`Memory` / `Performance` tab → Load).

## Caveats (v0.0.1)

- `get_stack` and `breakpoint` briefly pause the target. Don't use them on a tight latency-critical service.
- `list_async` uses `process._getActiveHandles()` / `_getActiveRequests()` which are unstable internals; expect occasional gaps in newer Node versions.
- No auth on the CDP port. If you ever expose `--inspect` outside `localhost`, anyone on the network can run code in your process. Don't.

## License

MIT
