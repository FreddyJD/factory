# Git Factory Product Brief

Turn large engineering goals into a controlled stream of safe, reviewable changes across repositories. Optimize for verified changes delivered, not agent count or PR volume.

## Small User-Facing Model

- Workspace: one repository or a folder of repositories.
- Goal: an outcome with constraints and a definition of done.
- Task: bounded work, acceptance criteria, and explicit dependencies.
- Change: commits, validation evidence, and related PRs.

Agents and worktrees are execution details. An agent is not inherently a task, a worktree, or a PR. Multi-repository changes are grouped but cannot be merged atomically by Git.

## Experience

Hello world, browser-based GitHub sign-in, a separate Copilot entitlement check, folder discovery, then the first goal. The main experience is a stable worklist: goals, needs-you decisions, review, and history. Task detail explains intent, base revisions, diffs, validation, and the next decision; chat and logs are secondary.

Borrow ownership, handoffs, waiting time, and durable history from clinical worklists. Borrow constrained work-in-progress, bottleneck visibility, and actionable exceptions from factory operations. Avoid dashboards full of agent activity.

## Isolation And Scheduling

Offer initialization and an initial commit for an empty folder. Ask before committing existing files. Discover child repositories without wrapping them in an accidental parent repository. Preserve dirty source checkouts and worktrees not owned by the application.

Create isolated worktrees when tasks enter execution, one active writer per writable checkout. Group all required repository worktrees under the task. Record exact paths and base commits. Isolation failures stop execution instead of falling back to the source checkout. Worktrees are not a security sandbox.

AI proposes task graphs; deterministic scheduling enforces dependencies, resource limits, permissions, budgets, and retries. Support serial, parallel, and staged execution. Shared contracts and coupled edits can require a serial implementation even when research is parallel. Greenfield/brownfield is context, not a concurrency rule. Apply backpressure when validation, review, or integration is saturated.

## Implementation Direction

Keep workspace/Git lifecycle, scheduling, permissions, execution adapters, validation, and persistence as clear boundaries within a modular Rust core. Use a small web UI, local durable state, bounded local workers first, and remote execution later. Evaluate the official Copilot Rust SDK rather than relying on private provider endpoints. GitHub access, inference entitlement, and push permissions are distinct capabilities.

Repository conventions, appropriate tests, bounded diffs, and evidence for the exact revision are practical clean-code constraints. Start with one trustworthy end-to-end loop before scaling agent count. A million simultaneous workers would require a distributed control plane, isolated compute, and negotiated provider capacity; the desktop remains the control surface.

## References

- [Roxy](https://github.com/roxy-gg/roxy): workspace, worktree, and execution lifecycle reference; Electron/TypeScript, not a direct Rust base.
- [Copilot Rust SDK](https://github.com/github/copilot-sdk/tree/main/rust): candidate agent-runtime integration.
- [Factory Workstreams](https://docs.factory.ai/docs/workstreams/overview): orchestrator-led delegation and waiting-on-you workflows.
- [Facebook: Rapid Release At Massive Scale](https://engineering.fb.com/2017/08/31/web/rapid-release-at-massive-scale/): validation and controlled delivery.
- [Shopify: Deconstructing The Monolith](https://shopify.engineering/deconstructing-monolith-designing-software-maximizes-developer-productivity): domain boundaries without premature distribution.
