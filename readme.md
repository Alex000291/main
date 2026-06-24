# inspectctl

MCP server that gives AI agents debugger-level visibility into running processes.

- **Node.js / V8** — via Chrome DevTools Protocol (CDP)
- **Python / any DAP adapter** — via Debug Adapter Protocol (DAP)

Stop pasting `console.log` and tracebacks into your agent. Let it look.

> `main` = stdio transport (default, for Claude Code / Cursor / any local stdio MCP client).
> `http` branch = same toolset + Streamable HTTP transport for cloud / cross-machine clients.

## Tools (42 total)

### CDP — Node.js / V8

#### Stateful debug session

| Tool | Action |
|------|--------|
| `start_debug_session` | Connect to a running Node.js debugger, return `sessionId` |
| `set_breakpoint` | Set a breakpoint by file path fragment + line number |
| `remove_breakpoint` | Remove a breakpoint by `breakpointId` |
| `wait_for_pause` | Block until target pauses (breakpoint / exception / step) |
| `get_status` | Non-blocking: is the target paused? current frames? |
| `get_locals` | All local variables for a stack frame (target must be paused) |
| `evaluate` | Eval a JS expression — in a frame scope or globally |
| `resume` | Resume execution |
| `step_over` | Step over the current line |
| `step_into` | Step into the next function call |
| `step_out` | Step out of the current function |
| `pause` | Pause the target immediately |
| `close_debug_session` | Disconnect and release the CDP connection |
| `list_debug_sessions` | List open sessions and their pause state |

#### Stateless diagnostics (no session needed)

| Tool | Action |
|------|--------|
| `list_targets` | Discover all CDP targets on a host:port |
| `heap_snapshot` | V8 heap dump → top N objects + type breakdown |
| `heap_diff` | Diff two snapshots, find leak culprits |
| `profile_cpu` | Sample CPU for N ms, return hot self/total nodes |
| `get_stack` | Pause briefly, capture call stack, resume |
| `list_async` | Pending timers, sockets, handles, requests |
| `tail_logs` | Capture console output + exceptions for N ms |

---

### DAP — Python / debugpy (and any DAP-compliant adapter)

#### Session lifecycle

| Tool | Action |
|------|--------|
| `dap_start_session` | Attach to a debugpy process over TCP, return `sessionId` |
| `dap_close_session` | Disconnect without terminating the debuggee |
| `dap_list_sessions` | List open DAP sessions and their pause state |

#### Breakpoints

| Tool | Action |
|------|--------|
| `dap_set_breakpoints` | Set breakpoints for a file (replaces entire file's set) |
| `dap_set_function_breakpoints` | Break on function name (no source file needed) |
| `dap_set_exception_breakpoints` | Break on exceptions (`raised` / `uncaught`) |
| `dap_set_data_breakpoints` | Watchpoint on variable read/write |
| `dap_data_breakpoint_info` | Get `dataId` for a variable (required before `dap_set_data_breakpoints`) |

#### Execution control

| Tool | Action |
|------|--------|
| `dap_wait_for_pause` | Block until target stops |
| `dap_get_status` | Non-blocking pause state |
| `dap_get_threads` | List all threads |
| `dap_continue` | Resume execution |
| `dap_pause` | Pause a running thread |
| `dap_next` | Step over |
| `dap_step_in` | Step into |
| `dap_step_out` | Step out |
| `dap_step_in_targets` | List specific call targets to pick which one to step into |
| `dap_goto_targets` | Get valid jump targets for a source line |
| `dap_goto` | Jump execution to a target location |

#### Stack inspection (target must be paused)

| Tool | Action |
|------|--------|
| `dap_get_stack` | Call stack for a thread (returns `frameId` per frame) |
| `dap_get_scopes` | Scopes for a frame (Locals / Globals / …) — returns `variablesReference` |
| `dap_get_variables` | Expand a `variablesReference`; drill into objects/arrays |
| `dap_set_variable` | Modify a variable's value |
| `dap_evaluate` | Eval an expression in a frame scope or as REPL |
| `dap_set_expression` | Assign a new value to an assignable expression |

#### Sources

| Tool | Action |
|------|--------|
| `dap_get_loaded_sources` | All source files currently loaded in the debuggee |
| `dap_get_source` | Retrieve source by path or `sourceReference` (for eval'd/dynamic code) |

#### Output

| Tool | Action |
|------|--------|
| `dap_tail_output` | Capture stdout/stderr for N ms |
| `dap_drain_output` | Flush all output buffered since session start |

---

## Requirements

Node.js 22.6+ (native TypeScript stripping — no build step needed). Tested on Node 24.

## Install

```sh
git clone https://github.com/Alex000291/main.git inspectctl
cd inspectctl
npm install
```

## MCP client wiring

### Claude Code (recommended)

```sh
claude mcp add -s user inspectctl -- node /your_path/inspectctl/src/index.ts
```

Or add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "inspectctl": {
      "type": "stdio",
      "command": "node",
      "args": ["src/index.ts"],
      "cwd": "/your_path/inspectctl"
    }
  }
}
```

Restart Claude Code — 42 tools appear automatically.

---

## Usage — Node.js (CDP)

Start your process with `--inspect`:

```sh
node --inspect=9229 your-app.js
```

Then ask Claude Code naturally:

- *"Set a breakpoint at line 29 of processOrder, trigger a /order request, tell me price and subtotal."*
- *"Heap snapshot now, wait 10s, snapshot again, diff — what's leaking?"*
- *"profile_cpu 3000ms while I hit /cpu. Which function is hottest?"*

### Demo target

```sh
node --inspect=9229 example/demo.mjs
```

Exposes deliberate problems on `http://127.0.0.1:4000`:

| Endpoint | What it demonstrates |
|----------|----------------------|
| `/order` | breakpoint + get_locals (orderId, items, subtotal, price) |
| `/cpu` | profile_cpu (burnCpu tight loop) |
| `/cache-size` | heap_snapshot / heap_diff (Map leak growing every 300ms) |

### Targeting

Every CDP stateless tool accepts:

- `port` — CDP inspector port (default `9229`)
- `host` — default `127.0.0.1`
- `targetId` — specific WS URL when multiple debuggers are listening

### Snapshots and profiles on disk

`heap_snapshot` and `profile_cpu` write full JSON to `tmpdir()/inspectctl/{snapshots,profiles}/` and return a summary + path. Open in Chrome DevTools (Memory / Performance → Load).

---

## Usage — Python (DAP)

Start your script with debugpy listening:

```sh
# Install once
pip install debugpy

# Run and wait for the agent to attach
python -m debugpy --listen 5678 --wait-for-client your_script.py
```

Then ask Claude Code naturally:

- *"Attach to port 5678, set a breakpoint at line 42 of process.py, continue, then show me all locals."*
- *"Break on any uncaught exception, continue, when it stops show me the full stack and the value of self.config."*
- *"Tail output for 5 seconds while the script runs."*

### Typical DAP workflow

```
dap_start_session          → sessionId
dap_set_breakpoints        file=/abs/path/script.py  lines=[42, 87]
dap_continue               → resumes (or was already running)
dap_wait_for_pause         → { reason: "breakpoint", threadId: 1 }
dap_get_stack              → stackFrames (note frameId values)
dap_get_scopes             frameId=<id>   → scopes with variablesReference
dap_get_variables          variablesReference=<ref>  → variable list
dap_evaluate               expression="len(items)"  frameId=<id>
dap_continue / dap_next / dap_step_in / dap_step_out
dap_close_session
```

### Exception breakpoints (debugpy filters)

| Filter | Breaks on |
|--------|-----------|
| `raised` | Every exception, including caught ones |
| `uncaught` | Only exceptions that propagate out unhandled |

```
dap_set_exception_breakpoints  filters=["uncaught"]
```

### Drilling into variables

`dap_get_scopes` returns `variablesReference` per scope. `dap_get_variables` expands it. Variables with `variablesReference > 0` have children — keep calling `dap_get_variables` to drill in. Use `filter="indexed"` for large lists/arrays to page through elements.

---

## Caveats

- CDP `get_stack` and `pause` briefly pause the target. Avoid on latency-critical hot paths.
- CDP `list_async` uses `process._getActiveHandles()` / `_getActiveRequests()` — unstable Node internals.
- DAP `dap_set_breakpoints` replaces the **entire** breakpoint list for a file. Pass all desired lines in one call.
- DAP requires `debugpy` in the target environment. It does not work with plain `pdb`.
- No auth on either protocol. Don't expose `--inspect` or `--listen` outside localhost.

## License

MIT
