# inspectctl

MCP server skeleton.

This `main` branch is a zero-tool stdio skeleton — for experimenting with the MCP transport layer in isolation.

## Branches

| Branch | Contents |
|--------|----------|
| `main` | stdio transport, zero tools |
| `http` | stdio + Streamable HTTP, full 8-tool CDP debugger (heap_snapshot, heap_diff, get_stack, eval_in_context, breakpoint, profile_cpu, list_async, tail_logs) plus SEA single-binary build pipeline |

For the working debugger:
```sh
git checkout http
```

## Run

```sh
npm install
node src/index.ts
```

Requires Node 22.6+ for native TypeScript stripping (use Node 24+ for default support).

## MCP client wiring

```sh
claude mcp add -s user inspectctl -- node D:/works/web3/inspectctl/src/index.ts
```

On the `main` branch the server connects but exposes no tools. Switch to `http` to get the real toolset.
