// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mergeTools,
  snapshotTools,
  useToolActivity,
  type ToolActivity,
} from "./useToolActivity";
import type { Snapshot, Task } from "../../../shared/api";

const { listen, stop, api } = vi.hoisted(() => ({
  listen: vi.fn(),
  stop: vi.fn(),
  api: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("../../../shared/api", () => ({ desktop: true, preview: false, api }));
const task: Task = {
  id: "task-a",
  title: "A",
  workspace: "/repo",
  directory: "/a",
  status: "working",
  sessionId: "s",
  model: "m",
  checkouts: [],
};
const call: ToolActivity = {
  id: "task-a:message:call",
  taskId: task.id,
  name: "read",
  status: "running",
  detail: "src/main.rs",
  observedAt: 123,
};
const snapshot: Snapshot = {
  task,
  queued: [],
  permissions: [],
  questions: [],
  status: { type: "busy" },
  messages: [
    {
      info: { id: "message", role: "assistant" },
      parts: [
        {
          id: "call",
          type: "tool",
          tool: "read",
          state: { status: "completed", input: { filePath: "src/main.rs" } },
        },
      ],
    },
  ],
};
let receive: (event: unknown) => void;
function emit(
  status = "running",
  overrides: Record<string, unknown> = {},
  taskId = task.id,
) {
  receive({
    payload: {
      taskId,
      event: {
        type: "tool",
        properties: {
          messageId: "message",
          callId: "call",
          name: "read",
          input: { filePath: "src/main.rs" },
          status,
          ...overrides,
        },
      },
    },
  });
}
beforeEach(() => {
  api.mockReset();
  stop.mockReset();
  listen.mockImplementation(async (_name, callback) => {
    receive = callback;
    return stop;
  });
  api.mockResolvedValue(snapshot);
});
afterEach(cleanup);

describe("factory tool activity", () => {
  it("loads recorded tools without timestamps or replaying completions", () => {
    expect(snapshotTools(snapshot)).toEqual([
      { ...call, status: "completed", observedAt: null },
    ]);
  });
  it("deduplicates history and live events and repairs missed completions", () => {
    const recorded = snapshotTools(snapshot);
    expect(mergeTools(recorded, [call], [task])).toEqual([
      { ...call, status: "completed" },
    ]);
    expect(
      mergeTools(
        [],
        [call, { ...call, id: "other:call", taskId: "other" }],
        [task],
      ),
    ).toEqual([call]);
  });
  it("marks stale running tools interrupted when a run ends", () => {
    expect(
      mergeTools([], [call], [{ ...task, status: "stopped" }])[0].status,
    ).toBe("interrupted");
    expect(mergeTools([], [call], [task])[0].status).toBe("running");
  });
  it("bounds retained data and truncates displayed arguments", () => {
    const calls = Array.from({ length: 400 }, (_, i) => ({
      ...call,
      id: String(i),
      observedAt: i,
    }));
    expect(mergeTools([], calls, [task])).toHaveLength(300);
    const data = structuredClone(snapshot);
    data.messages[0].parts[0].state!.input = {
      command: "a".repeat(500),
      content: "secret",
    };
    expect(snapshotTools(data)[0].detail).toHaveLength(240);
  });
  it("captures starts and fast failures while the view is closed, without fetching history", async () => {
    const { result } = renderHook(() => useToolActivity([task], false));
    await waitFor(() => expect(result.current.connection).toBe("live"));
    act(() => emit());
    expect(result.current.calls[0].status).toBe("running");
    act(() => emit("error"));
    expect(result.current.calls).toHaveLength(1);
    expect(result.current.calls[0].status).toBe("error");
    act(() => emit());
    expect(result.current.calls[0].status).toBe("error");
    expect(api).not.toHaveBeenCalled();
  });
  it("ignores malformed events, distinguishes message IDs, and scopes tasks", () => {
    const { result } = renderHook(() => useToolActivity([task], false));
    act(() => emit("pending"));
    act(() => emit("running", { messageId: null }));
    expect(result.current.calls).toHaveLength(0);
    act(() => emit());
    act(() => emit("running", { messageId: "another" }));
    act(() => emit("running", {}, "other-project"));
    expect(result.current.calls).toHaveLength(2);
  });
  it("does not regress a live completion when a slow initial snapshot arrives", async () => {
    let finish!: (data: Snapshot) => void;
    api.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result } = renderHook(() => useToolActivity([task], true));
    act(() => emit("completed"));
    const old = structuredClone(snapshot);
    old.messages[0].parts[0].state!.status = "running";
    await act(async () => finish(old));
    expect(result.current.calls).toHaveLength(1);
    expect(result.current.calls[0].status).toBe("completed");
    expect(result.current.calls[0].observedAt).not.toBeNull();
  });
  it("reports failed history and continues receiving live events", async () => {
    api.mockRejectedValue(new Error("Offline"));
    const { result } = renderHook(() => useToolActivity([task], true));
    await waitFor(() =>
      expect(result.current.error).toContain("history could not be loaded"),
    );
    act(() => emit());
    expect(result.current.calls[0].name).toBe("read");
  });
  it("cleans up an asynchronously registered listener and ignores late events", async () => {
    const { result, unmount } = renderHook(() =>
      useToolActivity([task], false),
    );
    unmount();
    await act(async () => {});
    expect(stop).toHaveBeenCalledOnce();
    act(() => emit());
    expect(result.current.calls).toHaveLength(0);
  });
});
