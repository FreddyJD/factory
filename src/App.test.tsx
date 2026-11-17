// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: (...args: unknown[]) => request(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./factory-canvas", () => ({
  FactoryCanvas: class {
    update() {}
    destroy() {}
  },
}));

const task = (id: string) => ({
  id,
  title: `Task ${id}`,
  workspace: "/repo",
  directory: `/worktrees/${id}`,
  status: "working",
  sessionId: `session-${id}`,
  model: "test-model",
  checkouts: [],
});
const snapshot = (id: string, permission = false) => ({
  task: task(id),
  messages: [],
  status: { type: "busy" },
  questions: [],
  permissions: permission
    ? [
        {
          id: `permission-${id}`,
          permission: "bash",
          patterns: ["run tests"],
          metadata: { command: "npm test" },
        },
      ]
    : [],
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("factory-workspace", "/repo");
  request.mockReset();
  request.mockImplementation(
    async (
      _command,
      { action, args }: { action: string; args: Record<string, unknown> },
    ) => {
      if (action === "status")
        return {
          installed: true,
          tasks: [task("a"), task("b")],
          version: "1.19.6",
          dataRoot: "/data",
        };
      if (action === "workspace")
        return {
          path: "/repo",
          repositories: [
            {
              name: "repo",
              path: "/repo",
              branch: "main",
              base: "abc",
              dirty: false,
            },
          ],
          canInitialize: false,
        };
      if (action === "models")
        return {
          connected: ["github-copilot"],
          all: [
            {
              id: "github-copilot",
              models: { "test-model": { id: "test-model", name: "Test" } },
            },
          ],
        };
      if (action === "snapshot") return snapshot(String(args.taskId), true);
      if (action === "diff") return `Diff ${args.taskId}`;
      return true;
    },
  );
});
afterEach(cleanup);

describe("factory task safety", () => {
  it("removes stale approval controls while another task loads", async () => {
    render(<App />);
    const selector = await screen.findByLabelText("Select a task");
    fireEvent.change(selector, { target: { value: "a" } });
    await screen.findByText("Allow once");
    const original = request.getMockImplementation()!;
    request.mockImplementation((command, parameters) =>
      parameters.action === "snapshot" && parameters.args.taskId === "b"
        ? new Promise(() => {})
        : original(command, parameters),
    );
    fireEvent.change(selector, { target: { value: "b" } });
    expect(screen.queryByText("Allow once")).toBeNull();
  });

  it("rejects duplicate keyboard/form submissions while creation is pending", async () => {
    let finish!: (value: unknown) => void;
    const original = request.getMockImplementation()!;
    request.mockImplementation((command, parameters) =>
      parameters.action === "create"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(command, parameters),
    );
    render(<App />);
    const input = await screen.findByLabelText("New goal");
    fireEvent.change(input, { target: { value: "Build a tested feature" } });
    const form = input.closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() =>
      expect(
        request.mock.calls.filter((call) => call[1].action === "create"),
      ).toHaveLength(1),
    );
    await act(async () => finish(task("c")));
  });

  it("does not replace a new task's diff with an older slow response", async () => {
    let finishA!: (value: unknown) => void;
    const original = request.getMockImplementation()!;
    request.mockImplementation((command, parameters) =>
      parameters.action === "diff" && parameters.args.taskId === "a"
        ? new Promise((resolve) => {
            finishA = resolve;
          })
        : original(command, parameters),
    );
    render(<App />);
    const selector = await screen.findByLabelText("Select a task");
    fireEvent.change(selector, { target: { value: "a" } });
    fireEvent.click(screen.getByText("Changes"));
    fireEvent.click(screen.getByText("Accessible text / copy"));
    fireEvent.change(selector, { target: { value: "b" } });
    const journal = screen.getByLabelText(
      "Selectable execution journal",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(journal.value).toBe("Diff b"));
    await act(async () => finishA("Diff a"));
    expect(journal.value).toBe("Diff b");
  });
});
