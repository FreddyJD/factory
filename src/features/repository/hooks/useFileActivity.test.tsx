// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityAt,
  useFileActivity,
  type FileActivity,
} from "./useFileActivity";
const { listen, stop } = vi.hoisted(() => ({ listen: vi.fn(), stop: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("../../../shared/api", () => ({ desktop: true, preview: false }));
let receive: (event: unknown) => void;
function emit(overrides: Partial<FileActivity> = {}) {
  receive({
    payload: {
      event: {
        type: "file-activity",
        properties: {
          checkoutPath: "/tree/a",
          path: "src/main.rs",
          access: "write",
          observedAt: Date.now(),
          ...overrides,
        },
      },
    },
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  listen.mockImplementation(async (_name, callback) => {
    receive = callback;
    return stop;
  });
  stop.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("transient worktree activity", () => {
  it("expires independently and extends only on new observations", () => {
    const { result } = renderHook(useFileActivity);
    act(() => emit());
    act(() => vi.advanceTimersByTime(2000));
    act(() => emit({ checkoutPath: "/tree/b" }));
    act(() => emit());
    expect(result.current).toHaveLength(2);
    act(() => vi.advanceTimersByTime(3999));
    expect(result.current).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toHaveLength(0);
  });
  it("expires different worktrees independently and prunes after background suspension", () => {
    const { result } = renderHook(useFileActivity);
    act(() => emit());
    act(() => vi.advanceTimersByTime(2000));
    act(() => emit({ checkoutPath: "/tree/b" }));
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.map((item) => item.checkoutPath)).toEqual([
      "/tree/b",
    ]);
    vi.setSystemTime(Date.now() + 10000);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(result.current).toHaveLength(0);
  });
  it("does not replay stale events and cleans up an asynchronously registered listener", async () => {
    const { result, unmount } = renderHook(useFileActivity);
    act(() => emit({ observedAt: Date.now() - 5000 }));
    expect(result.current).toHaveLength(0);
    unmount();
    await act(async () => {});
    expect(stop).toHaveBeenCalledOnce();
    act(() => emit());
    expect(result.current).toHaveLength(0);
  });
  it("matches exact checkouts, ancestor boundaries and no descendants of a directory listing", () => {
    const activity: FileActivity[] = [
      {
        checkoutPath: "/tree/a",
        path: "src/main.rs",
        access: "read",
        observedAt: 1,
      },
    ];
    expect(activityAt(activity, "/tree/a", "src")?.access).toBe("read");
    expect(activityAt(activity, "/tree/b", "src")).toBeUndefined();
    expect(activityAt(activity, "/tree/a", "sr")).toBeUndefined();
    expect(activityAt(activity, "/tree/a", "src", false)).toBeUndefined();
    expect(
      activityAt(
        [{ ...activity[0], path: "src", access: "list" }],
        "/tree/a",
        "src/main.rs",
        false,
      ),
    ).toBeUndefined();
  });
});
