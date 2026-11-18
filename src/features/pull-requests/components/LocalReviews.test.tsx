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
import { LocalReviews } from "./LocalReviews";
import type { Issue } from "../../../shared/types";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../../shared/api", () => ({ api }));

const project = { id: "project", name: "factory", path: "/repo" };
const issue: Issue = {
  taskId: "task-a",
  projectId: project.id,
  title: "Local change",
  body: "",
  createdAt: 0,
  nativeEdits: true,
  autoPr: false,
  outcome: "completed",
  stopReason: "",
  localMerge: null,
  publication: null,
};
const preview = {
  projectId: project.id,
  taskId: issue.taskId,
  title: issue.title,
  branch: "factory/change",
  sourceRef: "refs/heads/main",
  sourceHead: "a".repeat(40),
  head: "b".repeat(40),
  tree: "c".repeat(40),
  diff: "+local content",
  sourcePath: "/repo",
  worktree: "/worktree",
  mode: "fast-forward",
};

beforeEach(() => {
  api.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("local review list merge", () => {
  it("prepares once, confirms explicitly, and merges without opening the diff", async () => {
    let prepared!: (value: unknown) => void;
    let merged!: (value: unknown) => void;
    api.mockImplementation(
      (action) =>
        new Promise((resolve) => {
          if (action === "local_preview") prepared = resolve;
          else merged = resolve;
        }),
    );
    const changed = vi.fn();
    render(
      <LocalReviews project={project} issues={[issue]} onChange={changed} />,
    );
    const merge = screen.getByRole("button", {
      name: "Merge locally: Local change",
    });
    fireEvent.click(merge);
    fireEvent.click(merge);
    expect(screen.getByText("Preparing local merge…")).toBeTruthy();
    expect(api.mock.calls).toEqual([
      ["local_preview", { projectId: project.id, taskId: issue.taskId }],
    ]);
    expect(
      screen.queryByRole("button", { name: "Confirm local merge" }),
    ).toBeNull();
    await act(async () => prepared(preview));
    expect(screen.queryByText(preview.diff)).toBeNull();
    const confirm = screen.getByRole("button", { name: "Confirm local merge" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(
      api.mock.calls.filter(([action]) => action === "local_merge"),
    ).toEqual([
      ["local_merge", { projectId: project.id, taskId: issue.taskId, preview }],
    ]);
    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(15000);
      fireEvent.focus(window);
    });
    expect(
      api.mock.calls.filter(([action]) => action === "local_preview"),
    ).toHaveLength(1);
    await act(async () => merged({ commit: "d".repeat(40) }));
    expect(screen.getByText(/Nothing was pushed/)).toBeTruthy();
    expect(changed).toHaveBeenCalledOnce();
    await act(async () => {
      vi.advanceTimersByTime(15000);
      fireEvent.focus(window);
    });
    expect(
      api.mock.calls.filter(([action]) => action === "local_preview"),
    ).toHaveLength(1);
  });

  it("ignores a late preparation after cancel and requires a fresh confirmation", async () => {
    let prepared!: (value: unknown) => void;
    api.mockImplementation(
      () =>
        new Promise((resolve) => {
          prepared = resolve;
        }),
    );
    render(
      <LocalReviews project={project} issues={[issue]} onChange={vi.fn()} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Merge locally: Local change" }),
    );
    const old = prepared;
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => old(preview));
    expect(
      screen.queryByRole("button", { name: "Confirm local merge" }),
    ).toBeNull();
    api.mockResolvedValue({ ...preview, tree: "e".repeat(40) });
    fireEvent.click(
      screen.getByRole("button", { name: "Merge locally: Local change" }),
    );
    await screen.findByRole("button", { name: "Confirm local merge" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      api.mock.calls.filter(([action]) => action === "local_merge"),
    ).toHaveLength(0);
  });

  it("offers the existing diff review from a list confirmation", async () => {
    api.mockResolvedValue(preview);
    render(
      <LocalReviews project={project} issues={[issue]} onChange={vi.fn()} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Merge locally: Local change" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Review changes" }),
    );
    expect(screen.getByText(preview.diff)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Confirm local merge" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Merge locally" })).toBeTruthy();
    expect(api).toHaveBeenCalledOnce();
  });

  it("shows preparation errors without merging", async () => {
    api.mockRejectedValue("Source checkout has changes");
    render(
      <LocalReviews project={project} issues={[issue]} onChange={vi.fn()} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Merge locally: Local change" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Source checkout has changes",
    );
    expect(
      screen.queryByRole("button", { name: "Confirm local merge" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(
      (
        screen.getByRole("button", {
          name: "Merge locally: Local change",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("refreshes the saved result after failure and requires preparation before retry", async () => {
    api.mockImplementation((action) =>
      action === "local_preview"
        ? Promise.resolve(preview)
        : Promise.reject("Inspect the recovery commit"),
    );
    const changed = vi.fn();
    const { rerender } = render(
      <LocalReviews project={project} issues={[issue]} onChange={changed} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Merge locally: Local change" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm local merge" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Inspect the recovery commit",
    );
    expect(changed).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "Confirm local merge" }),
    ).toBeNull();
    rerender(
      <LocalReviews
        project={project}
        issues={[{ ...issue, localMerge: { state: "needs-inspection" } }]}
        onChange={changed}
      />,
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Merge locally: Local change",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("disables a prepared merge if another integration attempt is recorded", async () => {
    api.mockResolvedValue(preview);
    const { rerender } = render(
      <LocalReviews project={project} issues={[issue]} onChange={vi.fn()} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Merge locally: Local change" }),
    );
    await screen.findByRole("button", { name: "Confirm local merge" });
    rerender(
      <LocalReviews
        project={project}
        issues={[{ ...issue, localMerge: { state: "merging" } }]}
        onChange={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Confirm local merge" }),
      ).toBeNull(),
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "already attempted",
    );
    expect(
      api.mock.calls.filter(([action]) => action === "local_merge"),
    ).toHaveLength(0);
  });
});
