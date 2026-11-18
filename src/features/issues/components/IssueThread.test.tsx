// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Snapshot, Task } from "../../../shared/api";
import { IssueThread } from "./IssueThread";

const session = vi.hoisted(() => ({
  value: null as Snapshot | null,
  error: "",
  refresh: vi.fn(),
}));
vi.mock("../hooks/useIssue", () => ({ useIssue: () => session }));
afterEach(cleanup);

it("shows the opening message and attachment once while preserving follow-up comments", () => {
  const task: Task = {
    id: "task-1",
    title: "Opening issue",
    workspace: "",
    directory: "",
    status: "working",
    sessionId: null,
    model: "test",
    checkouts: [],
  };
  session.value = {
    task,
    queued: [],
    permissions: [],
    questions: [],
    status: { type: "busy" },
    messages: [
      {
        info: { id: "opening", role: "user" },
        parts: [
          { id: "text", type: "text", text: "Opening issue" },
          {
            id: "image",
            type: "image",
            name: "screen.png",
            dataUrl: "data:image/png;base64,cG5n",
          },
        ],
      },
      {
        info: { id: "reply", role: "assistant" },
        parts: [{ id: "text", type: "text", text: "On it" }],
      },
      {
        info: { id: "follow-up", role: "user" },
        parts: [{ id: "text", type: "text", text: "Another detail" }],
      },
    ],
  };
  render(
    <IssueThread
      task={task}
      github={undefined}
      onBack={vi.fn()}
      onCode={vi.fn()}
      onChange={vi.fn()}
      onLocalReview={vi.fn()}
      onRemove={vi.fn()}
    />,
  );
  expect(screen.getAllByRole("img", { name: "screen.png" })).toHaveLength(1);
  expect(screen.getAllByRole("article", { name: "Your comment" })).toHaveLength(1);
  expect(
    screen.getByRole("article", { name: "Your comment" }).textContent,
  ).toContain("Another detail");
  expect(
    screen.getByRole("article", { name: "Factory comment" }).textContent,
  ).toContain("On it");
  expect(
    screen.getByRole("region", { name: "Issue conversation" }).textContent,
  ).not.toContain("Opening issue");
});
