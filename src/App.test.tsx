// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { App } from "./App";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./features/issues/components/IssueTranscript", () => ({
  IssueTranscript: () => <div>Conversation canvas</div>,
}));
const projects = [
  { id: "project-a", name: "factory", path: "/repo" },
  { id: "project-b", name: "api", path: "/api" },
];
const task = {
  id: "a".repeat(32),
  title: "Add health endpoint",
  workspace: "/repo",
  directory: "/worktrees/health",
  status: "working",
  sessionId: "native_a",
  model: "fixture-model",
  checkouts: [
    {
      source: "/repo",
      path: "/worktrees/health",
      base: "a".repeat(40),
      branch: "factory/health",
    },
  ],
};
const target = {
  id: "source",
  path: "/repo",
  branch: "main",
  head: "a".repeat(40),
  source: true,
  taskId: null,
};
const agent = {
  id: "agent",
  path: "/worktrees/health",
  branch: "factory/health",
  head: "a".repeat(40),
  source: false,
  taskId: task.id,
};
const pr = {
  number: 1,
  title: "Fix retries",
  author: { login: "colleague" },
  headRefName: "fix/retries",
  headRefOid: "a".repeat(40),
  baseRefName: "main",
  isDraft: false,
  url: "https://github.com/acme/factory/pull/1",
  files: [],
  reviews: [],
};
function handler(
  _command: string,
  { action, args }: { action: string; args: Record<string, unknown> },
): unknown {
  switch (action) {
    case "status":
      return {
        engine: "native-rust",
        githubClientId: "fixture-client",
        providerNotice: "experimental",
        version: "0.3.0",
        dataRoot: "/data",
        projects,
        tasks: [task],
        issues: [],
      };
    case "repository_inventory":
      return {
        project: projects.find((p) => p.id === args.projectId),
        targets:
          args.projectId === "project-a"
            ? [target, agent]
            : [{ ...target, id: "api-source", path: "/api" }],
        branches: ["main", "factory/health"],
        remote: "https://github.com/acme/factory.git",
      };
    case "repository_browse":
      return args.path === "README.md"
        ? {
            kind: "file",
            path: "README.md",
            content: "# Repository\n",
            size: 13,
          }
        : {
            kind: "directory",
            path: args.path,
            entries: [
              {
                name: "src",
                path: "src",
                kind: "directory",
                size: 0,
                modified: null,
              },
              {
                name: args.targetId === "agent" ? "agent-only.rs" : "README.md",
                path: args.targetId === "agent" ? "agent-only.rs" : "README.md",
                kind: "file",
                size: 13,
                modified: null,
              },
            ],
            readme: { name: "README.md", content: "# Repository" },
          };
    case "models":
      return {
        connected: ["github-copilot"],
        all: [
          {
            id: "github-copilot",
            models: {
              "fixture-model": { id: "fixture-model", name: "Fixture model" },
            },
          },
        ],
      };
    case "snapshot":
      return {
        task,
        messages: [],
        permissions: [
          {
            id: "permission-a",
            permission: "bash",
            patterns: ["npm test"],
            metadata: { command: "npm test" },
          },
        ],
        questions: [],
        status: { type: "busy" },
      };
    case "local_reviews":
      return { issues: [], github: true };
    case "providers":
      return [];
    case "pr_list":
      return [pr];
    case "pr_view":
      return {
        repository: "acme/factory",
        account: "reviewer",
        pull: pr,
        diff: "diff --git a/a b/a\n+fixed",
      };
    case "project_open":
      return { projects, selected: "project-a" };
    case "project_mcp":
      return {};
    case "issue_create":
      return { ...task, title: args.title };
    default:
      throw Error(`Unexpected API operation: ${action}`);
  }
}
beforeEach(() => {
  localStorage.clear();
  invoke.mockReset();
  invoke.mockImplementation(handler);
});
afterEach(cleanup);
describe("repository-first application", () => {
  it("opens Code before authentication and browses a real API-backed file", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "README.md" });
    expect(screen.queryByText("Hello, world.")).toBeNull();
    expect(screen.queryByText("Make room for your next big idea.")).toBeNull();
    expect(
      screen
        .getByRole("navigation", { name: "Repository" })
        .querySelector('[aria-current="page"]')?.textContent,
    ).toBe("Code");
    fireEvent.click(screen.getByRole("button", { name: "README.md" }));
    expect(
      (await screen.findByLabelText("Contents of README.md")).textContent,
    ).toBe("# Repository\n");
    expect(invoke.mock.calls.some((c) => c[1].action === "models")).toBe(false);
  });
  it("selects worktrees without switching Git branches", async () => {
    render(<App />);
    const select = await screen.findByLabelText("Checkout or worktree");
    await screen.findByRole("button", { name: "README.md" });
    fireEvent.change(select, { target: { value: "agent" } });
    await screen.findByRole("button", { name: "agent-only.rs" });
    expect(
      invoke.mock.calls
        .filter((c) => c[1].action === "repository_browse")
        .at(-1)?.[1].args.targetId,
    ).toBe("agent");
    expect(invoke.mock.calls.some((c) => c[1].action === "prompt")).toBe(false);
  });
  it("ignores a slow source response after switching to an agent worktree", async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementation((command, params) =>
      params.action === "repository_browse" && params.args.targetId === "source"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : handler(command, params),
    );
    render(<App />);
    const select = await screen.findByLabelText("Checkout or worktree");
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    fireEvent.change(select, { target: { value: "agent" } });
    await screen.findByRole("button", { name: "agent-only.rs" });
    await act(async () =>
      finish({
        kind: "directory",
        path: "",
        entries: [
          {
            name: "stale.txt",
            path: "stale.txt",
            kind: "file",
            size: 1,
            modified: null,
          },
        ],
      }),
    );
    expect(screen.queryByRole("button", { name: "stale.txt" })).toBeNull();
  });
  it("creates one issue and immediately submits its description for execution", async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementation((command, params) =>
      params.action === "issue_create"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : handler(command, params),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New issue" }));
    const title = await screen.findByLabelText("Title");
    await screen.findByRole("option", { name: "Fixture model" });
    fireEvent.change(title, { target: { value: "Fix health endpoint" } });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Return 200 and add tests" },
    });
    const form = title.closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter((c) => c[1].action === "issue_create"),
      ).toHaveLength(1),
    );
    const args = invoke.mock.calls.find(
      (c) => c[1].action === "issue_create",
    )![1].args;
    expect(args).toMatchObject({
      title: "Fix health endpoint",
      body: "Return 200 and add tests",
      projectId: "project-a",
      nativeEdits: true,
      autoPr: false,
    });
    await act(async () => finish(task));
  });
  it("reopens the explicitly selected existing project", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "README.md" });
    fireEvent.click(screen.getByRole("button", { name: "api" }));
    await waitFor(() =>
      expect(
        screen
          .getByLabelText("Checkout or worktree")
          .querySelector("option:checked")
          ?.getAttribute("value"),
      ).toBe("api-source"),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Open project" })[0]);
    await waitFor(() =>
      expect(
        screen
          .getByLabelText("Checkout or worktree")
          .querySelector("option:checked")
          ?.getAttribute("value"),
      ).toBe("source"),
    );
  });
  it("clears old tool approvals when leaving an issue", async () => {
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Repository" });
    fireEvent.click(within(nav).getByRole("button", { name: /Issues/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Add health endpoint/ }),
    );
    await screen.findByRole("button", { name: "Allow once" });
    fireEvent.click(within(nav).getByRole("button", { name: "Code" }));
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  });
  it("shows local reviews without origin or a GitHub error", async () => {
    const issue = {
      taskId: task.id,
      projectId: "project-a",
      title: "Local change",
      outcome: "completed",
      localMerge: null,
    };
    const preview = {
      taskId: task.id,
      title: "Local change",
      sourceRef: "refs/heads/main",
      sourcePath: "/repo",
      sourceHead: "a".repeat(40),
      branch: "factory/health",
      head: "b".repeat(40),
      tree: "c".repeat(40),
      diff: "+local content",
      mode: "fast-forward",
      validation: "",
    };
    invoke.mockImplementation((command, params) =>
      params.action === "local_reviews"
        ? { issues: [issue], github: false }
        : params.action === "local_preview"
          ? preview
          : handler(command, params),
    );
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Repository" });
    fireEvent.click(within(nav).getByRole("button", { name: "Pull requests" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Local change/ }),
    );
    await screen.findByText("+local content");
    fireEvent.click(screen.getByRole("button", { name: "Merge locally" }));
    await screen.findByRole("button", { name: "Confirm local merge" });
    expect(invoke.mock.calls.some((c) => c[1].action === "pr_list")).toBe(
      false,
    );
    invoke.mockImplementation((command, params) =>
      params.action === "local_preview"
        ? { ...preview, tree: "d".repeat(40) }
        : params.action === "local_reviews"
          ? { issues: [issue], github: false }
          : handler(command, params),
    );
    fireEvent.focus(window);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Confirm local merge" }),
      ).toBeNull(),
    );
    expect(invoke.mock.calls.some((c) => c[1].action === "local_merge")).toBe(
      false,
    );
  });
  it("merges a reviewed local candidate only once", async () => {
    const issue = {
      taskId: task.id,
      title: "Local merge",
      outcome: "completed",
      localMerge: null,
    };
    const preview = {
      taskId: task.id,
      title: "Local merge",
      sourceRef: "refs/heads/main",
      sourcePath: "/repo",
      sourceHead: "a".repeat(40),
      branch: "factory/health",
      head: "b".repeat(40),
      tree: "c".repeat(40),
      diff: "+native local",
      mode: "fast-forward",
      validation: "",
    };
    let finish!: (value: unknown) => void;
    invoke.mockImplementation((command, params) =>
      params.action === "local_reviews"
        ? { issues: [issue], github: false }
        : params.action === "local_preview"
          ? preview
          : params.action === "local_merge"
            ? new Promise((resolve) => {
                finish = resolve;
              })
            : handler(command, params),
    );
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Repository" });
    fireEvent.click(within(nav).getByRole("button", { name: "Pull requests" }));
    fireEvent.click(await screen.findByRole("button", { name: /Local merge/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Merge locally" }),
    );
    const button = await screen.findByRole("button", {
      name: "Confirm local merge",
    });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter((c) => c[1].action === "local_merge"),
      ).toHaveLength(1),
    );
    expect(
      invoke.mock.calls.find((c) => c[1].action === "local_merge")![1].args
        .preview,
    ).toEqual(preview);
    await act(async () => finish({ commit: "d".repeat(40) }));
    await screen.findByText(/Nothing was pushed/);
  });
  it("signs in with GitHub without requiring a client ID", async () => {
    invoke.mockImplementation((command, params) =>
      params.action === "login_start"
        ? { attemptId: "attempt", instructions: "Enter code: ABCD-EFGH" }
        : handler(command, params),
    );
    render(<App />);
    await screen.findByRole("button", { name: "README.md" });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Sign in with GitHub" }),
    );
    await screen.findByText("Enter code: ABCD-EFGH");
    expect(
      invoke.mock.calls.some((c) => c[1].action === "configure_github"),
    ).toBe(false);
  });
  it("uses an OpenAI compatible model when GitHub is not connected", async () => {
    invoke.mockImplementation((command, params) =>
      params.action === "models"
        ? {
            connected: ["local"],
            all: [
              {
                id: "local",
                models: {
                  test: { id: "endpoint:local/test", name: "Local / test" },
                },
              },
            ],
          }
        : handler(command, params),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New issue" }));
    const title = await screen.findByLabelText("Title");
    await screen.findByRole("option", { name: "Local / test" });
    fireEvent.change(title, { target: { value: "Local model issue" } });
    fireEvent.submit(title.closest("form")!);
    await waitFor(() =>
      expect(
        invoke.mock.calls.find((c) => c[1].action === "issue_create")?.[1].args
          .model,
      ).toBe("endpoint:local/test"),
    );
  });
  it("invalidates an approval confirmation when the PR head changes", async () => {
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Repository" });
    fireEvent.click(within(nav).getByRole("button", { name: "Pull requests" }));
    fireEvent.click(await screen.findByRole("button", { name: /Fix retries/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Approve pull request" }),
    );
    await screen.findByRole("button", { name: "Submit approval" });
    invoke.mockImplementation((command, params) =>
      params.action === "pr_view"
        ? {
            repository: "acme/factory",
            account: "reviewer",
            pull: { ...pr, headRefOid: "b".repeat(40) },
            diff: "new diff",
          }
        : handler(command, params),
    );
    fireEvent.focus(window);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Submit approval" }),
      ).toBeNull(),
    );
    expect(invoke.mock.calls.some((c) => c[1].action === "pr_approve")).toBe(
      false,
    );
  });
});
