# Editor And Tool Protocols

Factory exposes a separate console executable so stdio works on Windows without opening a GUI. Build it with:

```sh
cargo build --manifest-path src-tauri/Cargo.toml --bin factory-cli
```

Its debug path is `src-tauri/target/debug/factory-cli` (Windows: `factory-cli.exe`). Use an absolute executable path in editor/server configuration. Protocol stdout is exclusively newline-delimited JSON-RPC 2.0; diagnostics go to stderr. Frames are capped at 8 MB.

## ACP Agent

Factory implements ACP v1 directly in Rust, with one owned worktree/session per process. Authenticate in the desktop app first, then prepare an isolated task:

```sh
factory-cli prepare /absolute/source/repository --model MODEL_ID
```

The result includes the task ID, worktree path(s), branches, and base commits. Open the returned `directory` in your editor, then configure the ACP command:

```json
{
  "command": "/absolute/path/factory-cli",
  "args": ["--acp", "--task", "TASK_ID"]
}
```

`session/new.cwd` must exactly match the prepared task directory. Factory does not silently substitute the source checkout or rewrite diff/location paths. Source unsaved buffers and dirty changes are not copied. Use a new prepared task for a new independent editor session. Do not open a task simultaneously in desktop execution and ACP; the ownership lock rejects that.

Implemented: initialize (wire version 1), session/new, session/prompt, session/cancel, session/update and bidirectional session/request_permission. Prompt responses remain outstanding while tool activity/permissions stream. Only implemented text/resource-link prompt and MCP capabilities are advertised; history loading, listing, forks, modes, and configuration extensions are not exposed. ACP auth is performed through desktop onboarding, not a dummy authenticate RPC.

Editor MCP server declarations connect through the native Rust rmcp client. Local stdio and unauthenticated HTTPS streamable HTTP are supported; remote OAuth/custom headers, legacy SSE transport, image/embedded resource blocks and extra directories are rejected rather than silently ignored. Factory executes native tools, not editor filesystem callbacks. Questions are excluded from baseline ACP; ordinary assistant questions can be answered in the next prompt. Permissions use only allow-once/reject-once. Prompt completion is emitted after the native session becomes idle; cancellation resolves active waiters and retains worktree files.

## Factory MCP Server

```json
{
  "mcpServers": {
    "factory": {
      "command": "/absolute/path/factory-cli",
      "args": ["--mcp", "--workspace", "/absolute/source/repository"]
    }
  }
}
```

Default tools: `factory_workspace`, `factory_tasks`, `factory_diff`. Task IDs are validated and access is restricted to the configured source workspace.

Add `--allow-execution` only when intentionally granting the connected client permission to create worktrees and submit coding work. This exposes `factory_start`, `factory_snapshot`, `factory_prompt`, `factory_cancel`, `factory_close`. It does not allow an agent to approve its own shell/edit permissions. A human uses:

```sh
factory-cli review TASK_ID
```

This requires an interactive terminal, displays pending requests and metadata from the existing owning worker using user-private native interaction records, and accepts only literal `yes` for one-time approval. Do not connect this command as a model-callable tool. For question-tool interactions, prefer the desktop workflow; MCP-owner questions are not yet answerable through this CLI.

Supported stdio profiles:

- Modern `2026-07-28`: per-request protocolVersion and clientCapabilities metadata; optional clientInfo; server/discover; resultType complete; server identity metadata; unsupported-version errors.
- Legacy `2025-11-25`, `2025-06-18`, `2024-11-05`: initialize/initialized lifecycle and legacy result shapes. Unsupported requested legacy revisions negotiate 2025-11-25.

This is a tools-only implementation, not a claim of full MCP feature coverage. Resources/prompts/subscriptions/HTTP transport/elicitation are not advertised. Cancel notifications suppress responses, but cannot undo worktree creation or code already executed. No automatic replay/retry of mutations is performed. Local task IDs are explicit durable handles; the connection is not a conversation identity.

## MCP Client Connections

Connections in the desktop app attach a trusted MCP server to the selected task through the in-process Rust rmcp client. Local configuration:

```json
{
  "type": "local",
  "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."]
}
```

Factory forces local-server cwd to the task directory. Relative filesystem server roots should be deliberate; cwd is not a process sandbox. Remote configuration:

```json
{ "type": "remote", "url": "https://your-trusted-server.example/mcp" }
```

Connections are native-session-local and not yet persisted. The client negotiates modern 2026-07-28 discovery with legacy fallback, namespaces dynamic tools, validates schemas, and supports MCP resource tools when advertised. All external calls require explicit approval. Unsupported elicitation/authentication fails rather than inventing user responses. Remote custom headers/OAuth are not implemented. Local environment configuration is trusted executable configuration, not confined filesystem access.

## Limits

Native provider authentication must be completed separately using Factory's own OAuth client ID; direct Copilot inference remains experimental/undocumented. Only chat-completions tool-capable models are supported.

No remote ACP hosting, network-accessible Factory API, editor certification, distributed scheduling, or unattended approvals in this MVP. Desktop and CLI share task records and ownership locks, not one live central daemon. Close an owner before transferring the task to another execution surface.
