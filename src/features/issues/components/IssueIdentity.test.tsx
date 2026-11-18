// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../../../shared/api";
import { IssueThread } from "./IssueThread";
import type { Issue } from "../../../shared/types";

vi.mock("../../../shared/api", async (original) => ({
  ...(await original<object>()),
  api: vi.fn(),
}));
vi.mock("./IssueTranscript", () => ({ IssueTranscript: () => null }));
vi.mock("../hooks/useIssue", () => ({
  useIssue: () => ({
    value: { task, messages: [], status: { type: "idle" }, questions: [] },
    refresh: vi.fn(),
  }),
}));
const task = {
  id: "a".repeat(32),
  title: "Change",
  model: "fixture",
  workspace: "/repo",
  directory: "/worktree",
  status: "review",
  sessionId: null,
  checkouts: [],
};
const issue = {
  taskId: task.id,
  projectId: "repo",
  title: "Change",
  body: "Change",
  createdAt: 0,
  nativeEdits: true,
  autoPr: true,
  outcome: "completed",
  stopReason: "complete",
  publication: null,
} satisfies Issue;
const preview = {
  branch: "factory/change",
  repository: "owner/repo",
  base: "main",
  account: "FreddyJD",
  accountId: "gcm:freddyjd",
  diff: "+change",
  added: [],
};
const changed = vi.fn();
function show(publication: Issue["publication"] = null) {
  return render(
    <IssueThread
      task={task}
      issue={{ ...issue, publication }}
      github
      project={{ id: "repo", name: "repo", path: "/repo" }}
      onBack={vi.fn()}
      onCode={vi.fn()}
      onChange={changed}
      onLocalReview={vi.fn()}
      onRemove={vi.fn()}
    />,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api).mockImplementation(async (action) => {
    if (action === "github_accounts")
      return [{ id: "gcm:freddyjd", login: "FreddyJD", source: "gcm" }];
    if (action === "pr_preview") return preview;
    if (action === "pr_publish") return true;
    throw Error(`Unexpected operation ${action}`);
  });
});
afterEach(cleanup);

it("lets an existing pre-push failure use a saved identity only after explicit confirmation", async () => {
  show({ state: "failed-or-unknown", last: { state: "committing" } });
  await screen.findByRole("option", {
    name: "FreddyJD (Git Credential Manager)",
  });
  fireEvent.change(screen.getByLabelText("GitHub identity for this PR"), {
    target: { value: "gcm:freddyjd" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create draft PR" }));
  await screen.findByRole("checkbox", {
    name: /I confirm publication as FreddyJD/,
  });
  expect(api).toHaveBeenCalledWith("pr_preview", {
    taskId: task.id,
    accountId: "gcm:freddyjd",
  });
  const publish = screen.getByRole("button", {
    name: "Commit, push and create draft PR",
  }) as HTMLButtonElement;
  expect(publish.disabled).toBe(true);
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I confirm publication as FreddyJD/ }),
  );
  fireEvent.click(publish);
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("pr_publish", {
      taskId: task.id,
      preview,
      confirmAccount: true,
    }),
  );
  expect(
    vi
      .mocked(api)
      .mock.calls.some(([action]) => action === "project_github_account"),
  ).toBe(false);
});

it("invalidates a reviewed preview when the selected identity changes", async () => {
  show();
  await screen.findByRole("option", { name: /FreddyJD/ });
  fireEvent.click(screen.getByRole("button", { name: "Create draft PR" }));
  const confirm = await screen.findByRole("checkbox", {
    name: /I confirm publication/,
  });
  fireEvent.click(confirm);
  fireEvent.change(screen.getByLabelText("GitHub identity for this PR"), {
    target: { value: "gcm:freddyjd" },
  });
  expect(
    screen.queryByRole("button", { name: "Commit, push and create draft PR" }),
  ).toBeNull();
});

it("blocks duplicate publication for outcomes that might have reached GitHub", async () => {
  show({ state: "failed-or-unknown", last: { state: "creating-pr" } });
  await screen.findByRole("option", { name: /FreddyJD/ });
  expect(
    (
      screen.getByRole("button", {
        name: "Create draft PR",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    screen.getByText(/Publication may already have reached GitHub/),
  ).toBeTruthy();
});

it("requires a fresh preview after a failed publish and refreshes persisted state", async () => {
  vi.mocked(api).mockImplementation(async (action) => {
    if (action === "github_accounts") return [];
    if (action === "pr_preview") return preview;
    if (action === "pr_publish") throw Error("Remote outcome uncertain");
  });
  show();
  fireEvent.click(screen.getByRole("button", { name: "Create draft PR" }));
  fireEvent.click(
    await screen.findByRole("checkbox", { name: /I confirm publication/ }),
  );
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Commit, push and create draft PR" }),
    ),
  );
  await screen.findByText(/Remote outcome uncertain/);
  expect(
    screen.queryByRole("button", { name: "Commit, push and create draft PR" }),
  ).toBeNull();
  expect(changed).toHaveBeenCalled();
});
