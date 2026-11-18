// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewIssue } from "./NewIssue";
import { IssueThread } from "./IssueThread";
import { transcript } from "../../../shared/api";

const { api, snapshot } = vi.hoisted(() => ({
  api: vi.fn(),
  snapshot: { value: null as unknown, refresh: vi.fn() },
}));
vi.mock("../../../shared/api", async (original) => ({
  ...(await original<typeof import("../../../shared/api")>()),
  api,
}));
vi.mock("../hooks/useIssue", () => ({ useIssue: () => snapshot }));
vi.mock("./IssueTranscript", () => ({ IssueTranscript: () => null }));
const project = { id: "project", name: "factory", path: "/repo" };
const task = {
  id: "abc",
  title: "Generated title",
  workspace: "/repo",
  directory: "/worktree",
  status: "review",
  model: "model",
  sessionId: "native",
  checkouts: [],
};
const image = () =>
  new File(["png bytes"], "screen.png", { type: "image/png" });

function setup(vision?: boolean) {
  localStorage.clear();
  api.mockReset();
  api.mockImplementation(async (action: string) => {
    if (action === "models")
      return {
        all: [
          {
            id: "provider",
            models: {
              model: { id: "model", name: "Model", capabilities: { vision } },
            },
          },
        ],
        connected: ["provider"],
      };
    if (action === "issue_create") return task;
    if (action === "github_status")
      return {
        repository: "acme/factory",
        account: "reviewer",
        defaultBranch: "main",
      };
    if (action === "prompt") return true;
    throw Error(`Unexpected ${action}`);
  });
  const onCreated = vi.fn();
  render(
    <NewIssue
      project={project}
      github={false}
      onCreated={onCreated}
      onCancel={vi.fn()}
      onSettings={vi.fn()}
    />,
  );
  return onCreated;
}
afterEach(cleanup);

describe("issue images", () => {
  it("rejects blank issues, pastes image-only issues and submits image bytes without a title", async () => {
    setup();
    await screen.findByRole("option", { name: "Model" });
    const field = screen.getByLabelText("Description");
    fireEvent.submit(field.closest("form")!);
    expect(api.mock.calls.some(([action]) => action === "issue_create")).toBe(
      false,
    );
    fireEvent.paste(field, {
      clipboardData: {
        items: [{ kind: "file", getAsFile: image }],
        getData: () => "",
      },
    });
    const preview = await screen.findByAltText("screen.png");
    expect(preview.getAttribute("src")).toBe(
      "data:image/png;base64,cG5nIGJ5dGVz",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Create issue and run" }),
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "issue_create",
        expect.objectContaining({
          body: "",
          model: "model",
          images: [
            {
              name: "screen.png",
              dataUrl: "data:image/png;base64,cG5nIGJ5dGVz",
            },
          ],
        }),
      ),
    );
    expect(
      api.mock.calls.find(([action]) => action === "issue_create")![1],
    ).not.toHaveProperty("title");
  });

  it("uploads and removes files, rejects unsupported files, and preserves ordinary paste", async () => {
    setup();
    await screen.findByRole("option", { name: "Model" });
    const field = screen.getByLabelText("Description");
    expect(
      fireEvent.paste(field, {
        clipboardData: { items: [], getData: () => "text" },
      }),
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Attach images"), {
      target: { files: [image()] },
    });
    await screen.findByAltText("screen.png");
    fireEvent.click(screen.getByRole("button", { name: "Remove screen.png" }));
    expect(screen.queryByAltText("screen.png")).toBeNull();
    fireEvent.change(screen.getByLabelText("Attach images"), {
      target: {
        files: [new File(["<svg/>"], "bad.svg", { type: "image/svg+xml" })],
      },
    });
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Error: Use PNG or JPEG images.",
    );
  });

  it("blocks models explicitly lacking vision and preserves attachments after a failed submission", async () => {
    setup(false);
    await screen.findByRole("option", { name: "Model" });
    fireEvent.change(screen.getByLabelText("Attach images"), {
      target: { files: [image()] },
    });
    await screen.findByText(
      "This model does not support images. Choose an image-capable model.",
    );
    fireEvent.submit(screen.getByLabelText("Description").closest("form")!);
    expect(api.mock.calls.some(([action]) => action === "issue_create")).toBe(
      false,
    );
    cleanup();
    setup();
    await screen.findByRole("option", { name: "Model" });
    api.mockRejectedValueOnce(Error("Unavailable"));
    fireEvent.change(screen.getByLabelText("Attach images"), {
      target: { files: [image()] },
    });
    await screen.findByAltText("screen.png");
    fireEvent.click(
      screen.getByRole("button", { name: "Create issue and run" }),
    );
    await screen.findByText("Error: Unavailable");
    expect(screen.getByAltText("screen.png")).toBeTruthy();
  });

  it("sends pasted follow-up images and shows the snapshot's model-generated title", async () => {
    api.mockReset();
    api.mockResolvedValue(true);
    snapshot.value = {
      task,
      messages: [],
      status: { type: "idle" },
      permissions: [],
      questions: [],
    };
    render(
      <IssueThread
        task={{ ...task, title: "Old title" }}
        github={false}
        onBack={vi.fn()}
        onCode={vi.fn()}
        onChange={vi.fn()}
        onLocalReview={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "Generated title",
    );
    fireEvent.paste(screen.getByLabelText("Issue comment"), {
      clipboardData: {
        items: [{ kind: "file", getAsFile: image }],
        getData: () => "",
      },
    });
    await screen.findByAltText("screen.png");
    fireEvent.click(screen.getByRole("button", { name: "Comment and run" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("prompt", {
        taskId: task.id,
        text: "",
        images: [
          { name: "screen.png", dataUrl: "data:image/png;base64,cG5nIGJ5dGVz" },
        ],
      }),
    );
    await waitFor(() => expect(screen.queryByAltText("screen.png")).toBeNull());
  });

  it("keeps image placeholders and previews in the transcript without printing base64", () => {
    const lines = transcript({
      task,
      queued: [],
      messages: [
        {
          info: { id: "user", role: "user" },
          parts: [
            {
              id: "image",
              type: "image",
              name: "screen.png",
              dataUrl: "data:image/png;base64,test",
            },
          ],
        },
      ],
      status: { type: "idle" },
      permissions: [],
      questions: [],
    });
    expect(lines).toEqual([
      {
        id: "user:image",
        kind: "user",
        text: "[Image: screen.png]",
        image: { name: "screen.png", dataUrl: "data:image/png;base64,test" },
      },
    ]);
  });

  it.each(["working", "needs-you", "publishing", "review"])(
    "queues follow-up text and images while %s without duplicate submissions",
    async (status) => {
      api.mockReset();
      let finish!: () => void;
      api.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      snapshot.value = {
        task: { ...task, status },
        messages: [],
        queued: [],
        status: { type: "busy" },
        questions: [],
      };
      render(
        <IssueThread
          task={task}
          onBack={vi.fn()}
          onCode={vi.fn()}
          onChange={vi.fn()}
          onLocalReview={vi.fn()}
          onRemove={vi.fn()}
          github={false}
        />,
      );
      const field = screen.getByLabelText("Issue comment");
      expect(
        (
          screen.getByRole("button", {
            name: "Add to queue",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      fireEvent.change(field, { target: { value: "Check this too" } });
      fireEvent.paste(field, {
        clipboardData: {
          items: [{ kind: "file", getAsFile: image }],
          getData: () => "",
        },
      });
      await screen.findByAltText("screen.png");
      fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
      fireEvent.submit(field.closest("form")!);
      expect(api).toHaveBeenCalledTimes(1);
      expect(api).toHaveBeenCalledWith("prompt", {
        taskId: task.id,
        text: "Check this too",
        images: [
          { name: "screen.png", dataUrl: "data:image/png;base64,cG5nIGJ5dGVz" },
        ],
      });
      finish();
      await waitFor(() =>
        expect((field as HTMLTextAreaElement).value).toBe(""),
      );
      expect(screen.queryByAltText("screen.png")).toBeNull();
    },
  );

  it("preserves a queued draft and images if submission fails", async () => {
    api.mockReset();
    api.mockRejectedValue(Error("Queue unavailable"));
    snapshot.value = {
      task,
      messages: [],
      queued: [],
      status: { type: "busy" },
      questions: [],
    };
    render(
      <IssueThread
        task={task}
        onBack={vi.fn()}
        onCode={vi.fn()}
        onChange={vi.fn()}
        onLocalReview={vi.fn()}
        onRemove={vi.fn()}
        github={false}
      />,
    );
    const field = screen.getByLabelText("Issue comment");
    fireEvent.change(field, { target: { value: "Keep my draft" } });
    fireEvent.paste(field, {
      clipboardData: {
        items: [{ kind: "file", getAsFile: image }],
        getData: () => "",
      },
    });
    await screen.findByAltText("screen.png");
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    await screen.findByText("Error: Queue unavailable");
    expect((field as HTMLTextAreaElement).value).toBe("Keep my draft");
    expect(screen.getByAltText("screen.png")).toBeTruthy();
  });

  it("shows queued comments in order with images and resumes a paused queue", async () => {
    api.mockReset();
    api.mockResolvedValue(true);
    snapshot.value = {
      task: { ...task, status: "stopped" },
      messages: [],
      status: { type: "idle" },
      questions: [],
      queued: [
        { id: "first", text: "First follow-up", images: [] },
        {
          id: "second",
          text: "Second follow-up",
          images: [
            { name: "queued.png", dataUrl: "data:image/png;base64,test" },
          ],
        },
      ],
    };
    render(
      <IssueThread
        task={task}
        onBack={vi.fn()}
        onCode={vi.fn()}
        onChange={vi.fn()}
        onLocalReview={vi.fn()}
        onRemove={vi.fn()}
        github={false}
      />,
    );
    const queue = screen.getByRole("region", { name: "Queued comments" });
    expect(queue.textContent).toContain("Queued comments (2)");
    expect(queue.textContent!.indexOf("First follow-up")).toBeLessThan(
      queue.textContent!.indexOf("Second follow-up"),
    );
    expect(screen.getByAltText("queued.png")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume queue" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("queue_resume", { taskId: task.id }),
    );
  });
});
