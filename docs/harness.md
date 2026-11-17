# Coding Harness

Factory owns Git discovery, task/worktree lifecycle, bounded execution slots, UI and protocol access. The official OpenCode v1.19.6 executable owns the agent loop, inference, tools, prompt assembly, subagents, skills, compaction, and MCP client connections. This is intentionally not a partial port of its TypeScript implementation into Rust.

Pinned source: https://github.com/anomalyco/opencode/tree/f4e363c8295fa90a03dddc451882fffe8fbce357

The runtime is downloaded only on explicit installation, verified against a platform-specific SHA-256 digest, and never silently self-updated. Runtime upgrades require changing the pin, checksums, and integration tests together. See THIRD_PARTY_NOTICES.md.

## Complete Tool Audit

Paths below are relative to `packages/opencode/src/` at the pinned commit. Registry: `tool/registry.ts`. Factory preserves upstream availability/model rules, not an artificial promise that every tool is exposed to every model.

| Tool        | Implementation                  | Description / availability                                                     |
| ----------- | ------------------------------- | ------------------------------------------------------------------------------ |
| invalid     | tool/invalid.ts                 | Inline validation fallback                                                     |
| question    | tool/question.ts                | tool/question.txt; desktop asks/replies supported                              |
| bash        | tool/shell.ts, tool/shell/id.ts | tool/shell/shell.txt and prompt.ts; execution approval required                |
| read        | tool/read.ts                    | tool/read.txt                                                                  |
| glob        | tool/glob.ts                    | tool/glob.txt                                                                  |
| grep        | tool/grep.ts                    | tool/grep.txt                                                                  |
| edit        | tool/edit.ts                    | tool/edit.txt; model-dependent                                                 |
| write       | tool/write.ts                   | tool/write.txt; model-dependent                                                |
| task        | tool/task.ts                    | tool/task.txt; upstream subagent delegation                                    |
| webfetch    | tool/webfetch.ts                | tool/webfetch.txt                                                              |
| todowrite   | tool/todo.ts                    | tool/todowrite.txt                                                             |
| websearch   | tool/websearch.ts               | tool/websearch.txt; provider/feature-gated, not enabled by default for Copilot |
| skill       | tool/skill.ts                   | tool/skill.txt; external/user skill discovery disabled in the private profile  |
| apply_patch | tool/apply_patch.ts             | tool/apply_patch.txt; replaces edit/write for applicable GPT models            |
| execute     | tool/code-mode.ts               | Experimental MCP orchestration; not enabled by default                         |
| lsp         | tool/lsp.ts                     | tool/lsp.txt; experimental, not enabled by default                             |
| plan_exit   | tool/plan.ts                    | tool/plan-exit.txt; experimental CLI-only, not exposed by desktop              |

Additional generated tools: `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource` and dynamic MCP tools (`session/tools.ts`); plugin custom tools (`tool/registry.ts`); `StructuredOutput` (`session/prompt.ts`); `_noop` Copilot compatibility fallback (`session/llm/request.ts`). User/project OpenCode plugin/config auto-loading is disabled; trusted MCP servers are added explicitly.

## Prompts Retained Upstream

- Model/system families: `session/prompt/{anthropic,beast,codex,default,gemini,gpt-astra,gpt,kimi,meta,trinity}.txt` and selection in `session/system.ts`.
- Agent families: `agent/prompt/{compaction,explore,summary,title}.txt`, `agent/generate.txt`.
- Plan transitions: `session/prompt/{plan,plan-mode,build-switch}.txt`, `session/reminders.ts`.
- Commands: `command/template/{initialize,review}.txt`.
- Repository instructions: `session/instruction.ts`; treated as untrusted context, not permission grants.
- Compaction: `packages/core/src/session/compaction.ts` and `session/compaction.ts`.
- Step limits, structured output, truncation, environment, tool catalogs, MCP instructions: upstream runtime assembly.

Factory adds a small task-specific system supplement requiring minimal changes, validation evidence, correct worktrees, and no autonomous commit/push/PR publication. It does not replace the model-specific prompt stack. ACP sessions retain the upstream prompt stack without this HTTP-only supplement.

## Execution And Storage

One authenticated loopback OpenCode HTTP worker per task, at most four task workers locally. A separate onboarding worker owns the device login flow. Worker passwords are random, held in memory and in user-private local control records for interactive CLI review; never sent to the webview or checked into Git. OpenCode credentials are in its app-owned XDG data profile, not an OS keychain. Do not treat this as encrypted secret storage.

One worktree per participating repository per task, allocated lazily from the recorded committed HEAD. A process file lock prevents desktop and CLI workers from simultaneously owning one task. Allocation is recorded before execution; incomplete allocation cannot run. Original checkouts and dirty source files are preserved. Task manifests use atomic replacement; OpenCode retains session history in its own database. This MVP uses local JSON task records, not the future distributed scheduler.

Stopping requests upstream cancellation and rejects pending permissions. Closing/exit also terminates managed workers. Worktrees are retained for review; there is no automatic dirty-worktree deletion. Explicit approvals apply once, not globally remembered grants.

## Boundaries

Worktrees are not a security sandbox. Approved shell scripts and trusted MCP servers run with the user's account privileges, network access, and access to shared Git metadata. Permission wildcard rules are not a shell security policy. Git content filters are disabled for Factory checkout/status (LFS files remain pointers); tracked escaping or unresolved symlinks are rejected at worker startup. Later filesystem changes and arbitrary approved shell code require an actual OS sandbox to confine.

Only trusted repositories should be used in this MVP. Project OpenCode configuration/plugins and home-directory skill discovery are disabled. Configuration, cache, state, and home paths are app-owned. Git hooks and fsmonitor are disabled for Factory's Git operations.

Copilot device authorization uses OpenCode's existing provider integration, not a new Factory OAuth identity. GitHub repository access is separate. A stored credential/model catalog is not proof of subscription entitlement; the first real inference request may still fail according to policy/quota.

## Validation

`cargo run --manifest-path src-tauri/Cargo.toml --example runtime-smoke` downloads the pinned runtime and checks live auth-method discovery, built-in tools, session creation, message retrieval, and an actual Factory MCP connection without model inference. Build `factory-cli` first. Use a disposable `GIT_FACTORY_DATA_DIR` for integration tests.

Real Copilot generation requires the user to complete device authorization. No automated test claims to validate a subscription, run a live paid model, certify an editor integration, or establish OS sandboxing.
