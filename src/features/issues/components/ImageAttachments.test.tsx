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
    if (action === "prompt") return true;
    throw Error(`Unexpected ${action}`);
  });
  const onCreated = vi.fn();
  render(
    <NewIssue
      project={project}
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
});
