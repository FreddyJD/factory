// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { transcript, type Part, type Snapshot } from "../../../shared/api";
import { IssueTranscript } from "./IssueTranscript";

afterEach(cleanup);
function snapshot(parts: Part[]): Snapshot {
  return {
    messages: [{ info: { id: "message", role: "assistant" }, parts }],
  } as Snapshot;
}
const call: Part = {
  id: "call",
  type: "tool",
  tool: "read",
  state: {
    status: "running",
    input: { filePath: "src/main.rs", nested: { limit: 2 } },
    output: null,
    error: null,
  },
};
describe("tool conversation", () => {
  it("retains structured input and empty output in text export", () => {
    const lines = transcript(
      snapshot([
        { ...call, state: { ...call.state!, status: "completed", output: "" } },
      ]),
    );
    expect(lines[0].id).toBe("message:call");
    expect(lines[0].text).toContain('"nested": {');
    expect(lines[0].text).toContain("Output\n(empty output)");
  });
  it("expands input/result and stays open when a call completes", async () => {
    const view = render(
      <IssueTranscript lines={transcript(snapshot([call]))} />,
    );
    expect(screen.queryByText("Input")).toBeNull();
    await act(async () => fireEvent.click(screen.getByText("read")));
    expect(await screen.findByText("Input")).toBeTruthy();
    expect(screen.getByText("Waiting for tool result...")).toBeTruthy();
    view.rerender(
      <IssueTranscript
        lines={transcript(
          snapshot([
            {
              ...call,
              state: {
                ...call.state!,
                status: "completed",
                output: "<script>not executable</script>",
              },
            },
          ]),
        )}
      />,
    );
    expect(screen.getByText("<script>not executable</script>")).toBeTruthy();
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.querySelectorAll("details")).toHaveLength(1);
    expect(view.container.querySelector("details")?.open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Text view" }));
    expect(
      (screen.getByLabelText("Conversation text") as HTMLTextAreaElement).value,
    ).toContain("Input\n");
  });
  it("shows errors and handles older records without input", async () => {
    render(
      <IssueTranscript
        lines={transcript(
          snapshot([
            {
              id: "error",
              type: "tool",
              tool: "edit",
              state: { status: "error", error: "Exact text not found" },
            },
          ]),
        )}
      />,
    );
    await act(async () => fireEvent.click(screen.getByText("edit")));
    expect(await screen.findByText("Exact text not found")).toBeTruthy();
    expect(screen.getByText("Input was not recorded.")).toBeTruthy();
  });
});
