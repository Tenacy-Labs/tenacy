# Connect an ACP client

Tenacy accepts Agent Client Protocol v1 over stdio using the official
[TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk).
Install dependencies with `bun install` before you start the channel.

Configure your ACP client to launch:

```json
{
  "command": "bun",
  "args": ["/absolute/path/to/tenacy/src/acp/stdio.ts", "mock"]
}
```

Replace `mock` with a provider name from the existing harness registry, such as
`zai` or `anthropic`. Add a model name as the next argument if needed. Live
providers use the existing harness configuration and environment credentials.
The default is `mock`, which makes no network requests. You can also run
`make acp P=zai M=glm-5.2`. Standard output contains only protocol messages.
Diagnostics go to standard error.

The client must initialize the connection, create a session with an existing
absolute `cwd` and an empty `mcpServers` list, then send text prompts. Each
session has its own worker, context, and provider. Relative file reads resolve
against that session's `cwd`. Shell execution and file writes retain the
harness's default denial. The channel does not grant new permissions.

Each prompt runs one harness turn. The completed reply arrives as a
`session/update` text chunk before the prompt response. Token streaming,
multimedia, embedded resources, MCP servers, persistent session loading, and
client terminal or filesystem delegation are not supported. Unsupported input
returns a protocol error. Simultaneous prompts in one session are rejected;
different sessions can run concurrently. Closing stdin disposes all sessions.

`session/cancel` stops waiting for the active model response and returns
`cancelled`. Late responses cannot execute tool intents. The underlying provider
request can continue because the harness provider API has no abort parameter.
Cancellation does not roll back work completed before the notification arrives.

Run the offline compatibility checks with `bun test test/acp.test.ts`. The test
launches the real executable through an SDK client. Run `make typecheck` and
`make test` for the repository gates.
