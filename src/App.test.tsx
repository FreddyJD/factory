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
const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Set<(event: unknown) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, callback: (event: unknown) => void) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
}));
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
      return task;
    case "github_status":
      return {
        repository: "acme/factory",
        account: "reviewer",
        defaultBranch: "main",
        permission: "WRITE",
      };
    default:
      throw Error(`Unexpected API operation: ${action}`);
  }
}
beforeEach(() => {
  localStorage.clear();
  listeners.clear();
  invoke.mockReset();
  invoke.mockImplementation(handler);
});
afterEach(cleanup);
describe("repository-first application", () => {
  it("keeps a single navigation CTA available with no projects", async () => {
    invoke.mockImplementation((command, params) =>
      params.action === "status"
        ? { ...(handler(command, params) as object), projects: [], tasks: [] }
        : handler(command, params),
    );
    render(<App />);
    await screen.findByRole("heading", { name: "Open a repository" });
    expect(screen.getAllByRole("button", { name: "Open project" })).toHaveLength(
      1,
    );
    const nav = screen.getByRole("navigation", { name: "Application" });
    fireEvent.click(within(nav).getByRole("button", { name: "Open project" }));
    await screen.findByRole("button", { name: "README.md" });
  });

  it("disables the navigation CTA while the folder picker is open", async () => {
    let finish!: () => void;
    invoke.mockImplementation((command, params) =>
      params.action === "project_open"
        ? new Promise((resolve) => {
            finish = () => resolve(null);
          })
        : handler(command, params),
    );
    render(<App />);
    await screen.findByRole("button", { name: "README.md" });
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    const opening = screen.getByRole("button", { name: "Opening…" });
    expect((opening as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(opening);
    expect(
      invoke.mock.calls.filter((c) => c[1].action === "project_open"),
    ).toHaveLength(1);
    await act(async () => finish());
    expect(
      (screen.getByRole("button", { name: "Open project" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it.each([
    "failed",
    "review",
    "removed",
    "working",
    "needs-you",
    "publishing",
  ])(
    "removes a %s issue from the list only after confirmation, once",
    async (status) => {
      let finish!: () => void;
      invoke.mockImplementation((command, params) => {
        if (params.action === "status")
          return {
            ...(handler(command, params) as object),
            tasks: [{ ...task, status }],
          };
        if (params.action === "issue_remove")
          return new Promise((resolve) => {
            finish = () => resolve(true);
          });
        return handler(command, params);
      });
      render(<App />);
      const nav = await screen.findByRole("navigation", { name: "Repository" });
      fireEvent.click(within(nav).getByRole("button", { name: /Issues/ }));
      const remove = await screen.findByRole("button", {
        name: "Remove issue #aaaaaaa",
      });
      fireEvent.click(remove);
      expect(screen.queryByText("Conversation canvas")).toBeNull();
      expect(
        screen.getByText(
          /generated files, branches and recovery history stay on disk/,
        ),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Keep issue" }));
      expect(
        invoke.mock.calls.some((c) => c[1].action === "issue_remove"),
      ).toBe(false);
      fireEvent.click(remove);
      const confirm = screen.getByRole("button", {
        name: "Stop and remove issue",
      });
      fireEvent.click(confirm);
      fireEvent.click(confirm);
      expect(
        invoke.mock.calls.filter((c) => c[1].action === "issue_remove"),
      ).toHaveLength(1);
      expect(
        invoke.mock.calls.find((c) => c[1].action === "issue_remove")![1].args,
      ).toEqual({ taskId: task.id, confirm: true });
      expect(
        screen.getByRole("button", { name: /Add health endpoint/ }),
      ).toBeTruthy();
      await act(async () => finish());
      await screen.findByText("No issues");
      expect(screen.getByText("0 issues")).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: /Add health endpoint/ }),
      ).toBeNull();
    },
  );

  it("keeps the active issue visible on removal failure and allows retry from its header", async () => {
    let attempts = 0;
    invoke.mockImplementation((command, params) => {
      if (params.action === "issue_remove") {
        if (++attempts === 1)
          return Promise.reject(Error("Run is still stopping"));
        return true;
      }
      return handler(command, params);
    });
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Repository" });
    fireEvent.click(within(nav).getByRole("button", { name: /Issues/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Add health endpoint/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove issue" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Stop and remove issue" }),
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Error: Run is still stopping",
    );
    expect(screen.getByText("Conversation canvas")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Stop and remove issue" }),
    );
    await screen.findByText("No issues");
    expect(screen.queryByText("Conversation canvas")).toBeNull();
  });

  it("confirms worktree removal once and retains the issue history", async () => {
    let removed = false;
    let finish!: () => void;
    invoke.mockImplementation((command, params) => {
      if (params.action === "snapshot")
        return {
          task: { ...task, status: removed ? "removed" : "review" },
          messages: [],
          permissions: [],
          questions: [],
          status: { type: "idle" },
        };
      if (params.action === "close") return true;
      if (params.action === "worktrees_remove")
        return new Promise((resolve) => {
          finish = () => {
            removed = true;
            resolve({ ...task, status: "removed" });
          };
        });
      return handler(command, params);
    });
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Repository" });
    fireEvent.click(within(nav).getByRole("button", { name: /Issues/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Add health endpoint/ }),
    );
    const remove = await screen.findByRole("button", {
      name: "Remove worktrees",
    });
    await waitFor(() =>
      expect((remove as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(remove);
    fireEvent.click(screen.getByRole("button", { name: "Cancel removal" }));
    expect(
      invoke.mock.calls.some((c) => c[1].action === "worktrees_remove"),
    ).toBe(false);
    fireEvent.click(remove);
    const confirm = screen.getByRole("button", { name: "Confirm removal" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter((c) => c[1].action === "worktrees_remove"),
      ).toHaveLength(1),
    );
    const calls = invoke.mock.calls.map((c) => c[1].action);
    expect(calls.indexOf("close")).toBeLessThan(
      calls.indexOf("worktrees_remove"),
    );
    expect(
      invoke.mock.calls.find((c) => c[1].action === "worktrees_remove")![1]
        .args,
    ).toEqual({ taskId: task.id, confirm: true });
    await act(async () => finish());
    await screen.findByText(
      "Worktrees removed. Branches and history retained.",
    );
    expect(
      screen.queryByRole("button", { name: "Remove worktrees" }),
    ).toBeNull();
    expect(screen.getByText("Conversation canvas")).toBeTruthy();
    const composer = screen.getByLabelText(
      "Issue comment",
    ) as HTMLTextAreaElement;
    expect(composer.disabled).toBe(true);
    expect(
      (screen.getByLabelText("Attach images") as HTMLInputElement).disabled,
    ).toBe(true);
    fireEvent.change(composer, {
      target: { value: "Do not restart removed worktrees" },
    });
    fireEvent.submit(composer.closest("form")!);
    expect(invoke.mock.calls.some((c) => c[1].action === "prompt")).toBe(false);
  });
  it("keeps repository controls together without the root title or Local tag", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "README.md" });
    const toolbar = screen.getByRole("toolbar", { name: "Repository actions" });
    expect(within(toolbar).getByLabelText("Checkout or worktree")).toBeTruthy();
    expect(within(toolbar).getByLabelText("Filter files")).toBeTruthy();
    expect(
      within(toolbar).getByRole("button", { name: "Refresh files" }),
    ).toBeTruthy();
    expect(
      within(toolbar).getByRole("button", { name: "New issue" }),
    ).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "File path" })).toBeNull();
    expect(screen.queryByText("Local", { exact: true })).toBeNull();
    const header = screen.getByRole("banner");
    expect(header.parentElement?.className).toBe("application");
    expect(within(header).queryByText("factory")).toBeNull();
    expect(
      within(header).queryByRole("button", { name: "Open project" }),
    ).toBeNull();
    expect(
      within(screen.getByRole("navigation", { name: "Application" })).getByRole(
        "button",
        { name: "Open project" },
      ),
    ).toBeTruthy();
    fireEvent.change(within(toolbar).getByLabelText("Filter files"), {
      target: { value: "readme" },
    });
    expect(screen.queryByRole("button", { name: "src" })).toBeNull();
    expect(screen.getByRole("button", { name: "README.md" })).toBeTruthy();
    fireEvent.change(within(toolbar).getByLabelText("Filter files"), {
      target: { value: "" },
    });
    const browseCalls = invoke.mock.calls.filter(
      (c) => c[1].action === "repository_browse",
    ).length;
    const inventoryCalls = invoke.mock.calls.filter(
      (c) => c[1].action === "repository_inventory",
    ).length;
    fireEvent.click(
      within(toolbar).getByRole("button", { name: "Refresh files" }),
    );
    await waitFor(() => {
      expect(
        invoke.mock.calls.filter((c) => c[1].action === "repository_browse")
          .length,
      ).toBeGreaterThan(browseCalls);
      expect(
        invoke.mock.calls.filter((c) => c[1].action === "repository_inventory")
          .length,
      ).toBeGreaterThan(inventoryCalls);
    });
    fireEvent.click(within(toolbar).getByRole("button", { name: "New issue" }));
    await screen.findByLabelText("Description");
  });
  it("preserves nested breadcrumbs and parent navigation", async () => {
    invoke.mockImplementation((command, params) => {
      if (params.action !== "repository_browse")
        return handler(command, params);
      const path = params.args.path as string;
      if (path === "src/lib/health.ts")
        return {
          kind: "file",
          path,
          content: "export const healthy = true;",
          size: 28,
        };
      const name =
        path === "src/lib" ? "health.ts" : path === "src" ? "lib" : "src";
      return {
        kind: "directory",
        path,
        entries: [
          {
            name,
            path: [path, name].filter(Boolean).join("/"),
            kind: name.endsWith(".ts") ? "file" : "directory",
            size: 0,
            modified: null,
          },
        ],
      };
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "src" }));
    fireEvent.click(await screen.findByRole("button", { name: "lib" }));
    fireEvent.click(await screen.findByRole("button", { name: "health.ts" }));
    expect(
      (await screen.findByLabelText("Contents of src/lib/health.ts"))
        .textContent,
    ).toBe("export const healthy = true;");
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "File path" })).getByRole(
        "button",
        { name: "src" },
      ),
    );
    await screen.findByRole("button", { name: "lib" });
    fireEvent.click(screen.getByRole("button", { name: ".." }));
    await waitFor(() =>
      expect(
        screen.queryByRole("navigation", { name: "File path" }),
      ).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "src" }));
    fireEvent.click(
      within(
        await screen.findByRole("navigation", { name: "File path" }),
      ).getByRole("button", { name: "factory" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("navigation", { name: "File path" }),
      ).toBeNull(),
    );
  });
  it("shows project-scoped MCP under Settings rather than the sidebar", async () => {
    invoke.mockImplementation((command, params) => {
      if (params.action === "status")
        return {
          ...(handler(command, params) as object),
          tasks: [
            task,
            {
              ...task,
              id: "b".repeat(32),
              title: "Other project issue",
              workspace: "/api",
              checkouts: [],
            },
          ],
        };
      if (params.action === "project_mcp")
        return { filesystem: { type: "local", command: ["test-server"] } };
      return handler(command, params);
    });
    render(<App />);
    await screen.findByRole("button", { name: "README.md" });
    expect(
      within(
        screen.getByRole("navigation", { name: "Application" }),
      ).queryByRole("button", { name: "MCP" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(
      within(
        await screen.findByRole("navigation", { name: "Settings" }),
      ).getByRole("button", { name: "MCP" }),
    );
    const mcp = await screen.findByRole("region", { name: "MCP settings" });
    await within(mcp).findByText("filesystem");
    expect(
      invoke.mock.calls.find((c) => c[1].action === "project_mcp")?.[1].args,
    ).toEqual({ projectId: "project-a" });
    expect(within(mcp).getByRole("option", { name: task.title })).toBeTruthy();
    expect(
      within(mcp).queryByRole("option", { name: "Other project issue" }),
    ).toBeNull();
    fireEvent.change(within(mcp).getByLabelText("Server name"), {
      target: { value: "unsaved" },
    });
    fireEvent.click(screen.getByRole("button", { name: "api" }));
    await screen.findByLabelText("Checkout or worktree");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Settings" })).getByRole(
        "button",
        { name: "MCP" },
      ),
    );
    expect(
      ((await screen.findByLabelText("Server name")) as HTMLInputElement).value,
    ).toBe("");
    await waitFor(() =>
      expect(
        invoke.mock.calls
          .filter((c) => c[1].action === "project_mcp")
          .at(-1)?.[1].args,
      ).toEqual({ projectId: "project-b" }),
    );
  });
  it("keeps MCP settings accessible without an open project", async () => {
    invoke.mockImplementation((command, params) =>
      params.action === "status"
        ? { ...(handler(command, params) as object), projects: [], tasks: [] }
        : handler(command, params),
    );
    render(<App />);
    await screen.findByRole("heading", { name: "Open a repository" });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const navigation = await screen.findByRole("navigation", {
      name: "Settings",
    });
    fireEvent.click(within(navigation).getByRole("button", { name: "MCP" }));
    await screen.findByText("Open a project first.");
    expect(screen.queryByLabelText("Server name")).toBeNull();
    expect(invoke.mock.calls.some((c) => c[1].action === "project_mcp")).toBe(
      false,
    );
    fireEvent.click(
      within(navigation).getByRole("button", { name: "General" }),
    );
    await screen.findByRole("button", { name: "Sign in with GitHub" });
  });
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
  it("marks activity in the right worktree and refreshes changed files", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "README.md" });
    act(() =>
      listeners.forEach((callback) =>
        callback({
          payload: {
            event: {
              type: "file-activity",
              properties: {
                checkoutPath: agent.path,
                path: "agent-only.rs",
                access: "write",
                observedAt: Date.now(),
              },
            },
          },
        }),
      ),
    );
    expect(
      screen.getByRole("option", { name: /\[active\] factory\/health/ }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "README.md" })
        .querySelector("[data-access]"),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /factory\/health/ }));
    const file = await screen.findByRole("button", { name: /agent-only.rs/ });
    expect(file.querySelector('[data-access="write"]')).not.toBeNull();
    const reads = () =>
      invoke.mock.calls.filter(
        (call) =>
          call[1].action === "repository_browse" &&
          call[1].args.targetId === "agent",
      ).length;
    await waitFor(() => expect(reads()).toBeGreaterThan(1));
    fireEvent.change(screen.getByLabelText("Checkout or worktree"), {
      target: { value: "source" },
    });
    const source = await screen.findByRole("button", { name: "README.md" });
    expect(source.querySelector("[data-access]")).toBeNull();
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
      params.action === "issue_remove"
        ? true
        : params.action === "issue_create"
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : handler(command, params),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New issue" }));
    const description = await screen.findByLabelText("Description");
    expect(screen.queryByLabelText("Title")).toBeNull();
    await screen.findByRole("option", { name: "Fixture model" });
    expect(
      screen.getByText(
        /All tool calls run automatically without approval prompts/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("checkbox", { name: /Allow native file edits/ }),
    ).toBeNull();
    expect(screen.queryByLabelText("Validation command")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/Authorize commit and push/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Return 200 and add tests" },
    });
    const form = description.closest("form")!;
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
      body: "Return 200 and add tests",
      images: [],
      projectId: "project-a",
      nativeEdits: true,
      autoPr: true,
      githubTarget: handler("factory_api", {
        action: "github_status",
        args: {},
      }),
    });
    expect(args).not.toHaveProperty("title");
    expect(args).not.toHaveProperty("validation");
    await act(async () => finish(task));
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove issue" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Stop and remove issue" }),
    );
    await screen.findByText("No issues");
    expect(screen.queryByText("Conversation canvas")).toBeNull();
  });
  it("persists the default-on automatic PR preference in Settings for new issues", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "README.md" });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const preference = await screen.findByRole("checkbox", {
      name: "Automatically create a draft pull request",
    });
    expect((preference as HTMLInputElement).checked).toBe(true);
    fireEvent.click(preference);
    expect(localStorage.getItem("factory-auto-pr")).toBe("false");
    cleanup();

    render(<App />);
    await screen.findByRole("button", { name: "README.md" });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      (
        (await screen.findByRole("checkbox", {
          name: "Automatically create a draft pull request",
        })) as HTMLInputElement
      ).checked,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "factory" }));
    fireEvent.click(await screen.findByRole("button", { name: "New issue" }));
    await screen.findByRole("option", { name: "Fixture model" });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Work locally without publishing" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create issue and run" }),
    );
    await waitFor(() =>
      expect(
        invoke.mock.calls.find((c) => c[1].action === "issue_create")?.[1].args,
      ).toMatchObject({ autoPr: false, githubTarget: null }),
    );
    expect(invoke.mock.calls.some((c) => c[1].action === "github_status")).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Automatically create a draft pull request",
      }),
    );
    expect(localStorage.getItem("factory-auto-pr")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "factory" }));
    fireEvent.click(await screen.findByRole("button", { name: "New issue" }));
    await screen.findByRole("option", { name: "Fixture model" });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Publish this change" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create issue and run" }),
    );
    await waitFor(() =>
      expect(
        invoke.mock.calls
          .filter((c) => c[1].action === "issue_create")
          .at(-1)?.[1].args,
      ).toMatchObject({ autoPr: true }),
    );
  });
  it("blocks issue submission until GitHub access is checked", async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementation((command, params) =>
      params.action === "github_status"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : handler(command, params),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New issue" }));
    await screen.findByRole("option", { name: "Fixture model" });
    const description = screen.getByLabelText("Description");
    fireEvent.change(description, { target: { value: "Make a change" } });
    expect(
      (
        screen.getByRole("button", {
          name: "Create issue and run",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.submit(description.closest("form")!);
    expect(invoke.mock.calls.some((c) => c[1].action === "issue_create")).toBe(
      false,
    );
    await act(async () =>
      finish(handler("factory_api", { action: "github_status", args: {} })),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Create issue and run",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
  it("links to Settings when automatic PRs cannot access GitHub", async () => {
    invoke.mockImplementation((command, params) => {
      if (params.action === "github_status")
        throw Error("Sign in with gh auth login");
      return handler(command, params);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New issue" }));
    await screen.findByText(/Sign in with gh auth login/);
    const description = screen.getByLabelText("Description");
    fireEvent.change(description, { target: { value: "Make a change" } });
    fireEvent.submit(description.closest("form")!);
    expect(invoke.mock.calls.some((c) => c[1].action === "issue_create")).toBe(
      false,
    );
    fireEvent.click(
      within(document.querySelector(".issue-options") as HTMLElement).getByRole(
        "button",
        { name: "Settings" },
      ),
    );
    await screen.findByRole("checkbox", {
      name: "Automatically create a draft pull request",
    });
  });
  it("publishes a completed issue without a validation command", async () => {
    const issue = {
      taskId: task.id,
      projectId: "project-a",
      outcome: "completed",
      publication: null,
    };
    const preview = {
      branch: "factory/health",
      repository: "acme/factory",
      base: "main",
      account: "reviewer",
      diff: "+change",
      added: [],
    };
    invoke.mockImplementation((command, params) => {
      if (params.action === "status")
        return { ...(handler(command, params) as object), issues: [issue] };
      if (params.action === "snapshot")
        return {
          task: { ...task, status: "review" },
          messages: [],
          questions: [],
          status: { type: "idle" },
        };
      if (params.action === "pr_preview") return preview;
      if (params.action === "pr_publish") return true;
      return handler(command, params);
    });
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Repository" });
    fireEvent.click(within(nav).getByRole("button", { name: /Issues/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Add health endpoint/ }),
    );
    const prepare = await screen.findByRole("button", {
      name: "Create draft PR",
    });
    await waitFor(() =>
      expect((prepare as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(prepare);
    const publish = await screen.findByRole("button", {
      name: "Commit, push and create draft PR",
    });
    expect((publish as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/Validation command/)).toBeNull();
    fireEvent.click(publish);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("factory_api", {
        action: "pr_publish",
        args: { taskId: task.id, preview },
      }),
    );
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
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() =>
      expect(
        screen
          .getByLabelText("Checkout or worktree")
          .querySelector("option:checked")
          ?.getAttribute("value"),
      ).toBe("source"),
    );
  });
  it("shows automatic tool execution without approval buttons for retained issues", async () => {
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Repository" });
    fireEvent.click(within(nav).getByRole("button", { name: /Issues/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Add health endpoint/ }),
    );
    await screen.findByText(/All tool calls auto-approved/);
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.queryByText(/Approval required/)).toBeNull();
    fireEvent.click(within(nav).getByRole("button", { name: "Code" }));
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  });
  it.each([true, false])(
    "shows only the matching issue actions when GitHub mode is %s",
    async (github) => {
      invoke.mockImplementation((command, params) =>
        params.action === "local_reviews"
          ? { issues: [], github }
          : handler(command, params),
      );
      render(<App />);
      const nav = await screen.findByRole("navigation", { name: "Repository" });
      fireEvent.click(within(nav).getByRole("button", { name: /Issues/ }));
      fireEvent.click(
        await screen.findByRole("button", { name: /Add health endpoint/ }),
      );
      await screen.findByRole("button", {
        name: github ? "Create draft PR" : "Review and merge locally",
      });
      expect(
        screen.queryByRole("button", {
          name: github ? "Review and merge locally" : "Create draft PR",
        }),
      ).toBeNull();
    },
  );
  it.each([true, false])(
    "applies automatic PR publication only when GitHub mode is %s",
    async (github) => {
      invoke.mockImplementation((command, params) =>
        params.action === "local_reviews"
          ? { issues: [], github }
          : handler(command, params),
      );
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "New issue" }));
      await screen.findByRole("option", { name: "Fixture model" });
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(screen.queryByLabelText("Validation command")).toBeNull();
      fireEvent.change(screen.getByLabelText("Description"), {
        target: { value: "Make a repository change" },
      });
      const create = screen.getByRole("button", {
        name: "Create issue and run",
      });
      await waitFor(() =>
        expect((create as HTMLButtonElement).disabled).toBe(false),
      );
      fireEvent.click(create);
      await waitFor(() =>
        expect(
          invoke.mock.calls.find((c) => c[1].action === "issue_create")?.[1]
            .args,
        ).toMatchObject({ autoPr: github }),
      );
      expect(
        invoke.mock.calls.some((c) => c[1].action === "github_status"),
      ).toBe(github);
    },
  );
  it("waits for repository detection before applying the default PR preference", async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementation((command, params) =>
      params.action === "local_reviews"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : handler(command, params),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New issue" }));
    await screen.findByRole("option", { name: "Fixture model" });
    const description = screen.getByLabelText("Description");
    fireEvent.change(description, {
      target: { value: "Make a repository change" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Create issue and run",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.submit(description.closest("form")!);
    expect(invoke.mock.calls.some((c) => c[1].action === "issue_create")).toBe(
      false,
    );
    await act(async () => finish({ issues: [], github: true }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Create issue and run",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.submit(description.closest("form")!);
    await waitFor(() =>
      expect(
        invoke.mock.calls.find((c) => c[1].action === "issue_create")?.[1].args,
      ).toMatchObject({ autoPr: true }),
    );
  });
  it("shows only GitHub pull requests for a remote repository", async () => {
    invoke.mockImplementation((command, params) =>
      params.action === "local_reviews"
        ? {
            issues: [
              {
                taskId: task.id,
                title: "Local-only review",
                outcome: "completed",
                localMerge: null,
              },
            ],
            github: true,
          }
        : handler(command, params),
    );
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Repository" });
    fireEvent.click(within(nav).getByRole("button", { name: "Pull requests" }));
    await screen.findByRole("button", { name: /Fix retries/ });
    expect(screen.queryByText("Local changes")).toBeNull();
    expect(screen.queryByText("No remote required")).toBeNull();
    expect(screen.queryByText("Local-only review")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Fix retries/ }));
    await screen.findByRole("button", { name: "Approve pull request" });
    expect(screen.queryByText("Local changes")).toBeNull();
    expect(invoke.mock.calls.some((c) => c[1].action === "local_preview")).toBe(
      false,
    );
  });
  it("waits for repository detection before showing either review workflow", async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementation((command, params) =>
      params.action === "local_reviews"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : handler(command, params),
    );
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Repository" });
    fireEvent.click(within(nav).getByRole("button", { name: "Pull requests" }));
    await screen.findByText("Loading repository reviews...");
    expect(screen.queryByText("Local changes")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Pull requests" })).toBeNull();
    expect(invoke.mock.calls.some((c) => c[1].action === "pr_list")).toBe(
      false,
    );
    await act(async () => finish({ issues: [], github: true }));
    await screen.findByRole("button", { name: /Fix retries/ });
    expect(screen.queryByText("Local changes")).toBeNull();
  });
  it("keeps remote failures in the remote review workflow", async () => {
    invoke.mockImplementation((command, params) =>
      params.action === "pr_list"
        ? Promise.reject(new Error("GitHub authentication required"))
        : handler(command, params),
    );
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Repository" });
    fireEvent.click(within(nav).getByRole("button", { name: "Pull requests" }));
    await screen.findByRole("alert");
    expect(screen.getByText(/GitHub authentication required/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Pull requests" })).toBeTruthy();
    expect(screen.queryByText("Local changes")).toBeNull();
    expect(screen.queryByText("No remote required")).toBeNull();
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
      await screen.findByRole("button", { name: /^Local change/ }),
    );
    await screen.findByText("+local content");
    expect(screen.queryByRole("heading", { name: "Pull requests" })).toBeNull();
    expect(screen.queryByText("GitHub", { exact: true })).toBeNull();
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
    fireEvent.click(
      await screen.findByRole("button", { name: /^Local merge/ }),
    );
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
  it("shows Responses and Messages models in the issue picker", async () => {
    invoke.mockImplementation((command, params) =>
      params.action === "models"
        ? {
            connected: ["github-copilot"],
            all: [
              {
                id: "github-copilot",
                models: {
                  responses: {
                    id: "responses-model",
                    name: "Codex Responses",
                    protocol: "responses",
                    capabilities: { toolcall: true },
                  },
                  messages: {
                    id: "claude-model",
                    name: "Claude Messages",
                    protocol: "messages",
                    capabilities: { toolcall: true },
                  },
                  text: {
                    id: "text-only",
                    name: "Text only",
                    capabilities: { toolcall: false },
                  },
                },
              },
            ],
          }
        : handler(command, params),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New issue" }));
    await screen.findByRole("option", { name: "Codex Responses" });
    await screen.findByRole("option", { name: "Claude Messages" });
    expect(screen.queryByRole("option", { name: "Text only" })).toBeNull();
  });
  it("shows full catalog separately from coding capabilities", async () => {
    invoke.mockImplementation((command, params) =>
      params.action === "models"
        ? {
            connected: ["github-copilot"],
            all: [
              {
                id: "github-copilot",
                models: {
                  responses: {
                    id: "responses-model",
                    name: "Codex Responses",
                    protocol: "responses",
                    capabilities: { toolcall: true },
                  },
                  messages: {
                    id: "claude-model",
                    name: "Claude Messages",
                    protocol: "messages",
                    capabilities: { toolcall: true },
                  },
                  text: {
                    id: "text-only",
                    name: "Text only",
                    capabilities: { toolcall: false },
                  },
                },
              },
            ],
          }
        : handler(command, params),
    );
    render(<App />);
    await screen.findByRole("button", { name: "README.md" });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByText(
      "3 GitHub models available · 2 support coding tools",
    );
    expect(screen.getByText("Text only")).toBeTruthy();
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
    const description = await screen.findByLabelText("Description");
    await screen.findByRole("option", { name: "Local / test" });
    fireEvent.change(description, { target: { value: "Local model issue" } });
    fireEvent.submit(description.closest("form")!);
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
