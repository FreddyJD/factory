// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../shared/api";
import type { Checkout, Inventory } from "../../../shared/types";
import type { FileActivity } from "../hooks/useFileActivity";
import { CheckoutSelect, CodeBrowser } from "./CodeBrowser";

const source: Checkout = {
  id: "source",
  path: "/repo",
  branch: "main",
  head: "abc",
  source: true,
  taskId: null,
};
const reader: Checkout = {
  ...source,
  id: "reader",
  path: "/trees/reader",
  branch: "factory/reader",
  source: false,
  taskId: "read-task",
};
const writer: Checkout = {
  ...reader,
  id: "writer",
  path: "/trees/writer",
  branch: "factory/writer",
  taskId: "write-task",
};
const inventory: Inventory = {
  project: { id: "project", name: "Factory", path: "/repo" },
  targets: [source, reader, writer],
  branches: ["main"],
  remote: null,
};
const activity: FileActivity[] = [
  {
    checkoutPath: reader.path,
    path: "src/main.rs",
    access: "read",
    observedAt: 1,
  },
  {
    checkoutPath: writer.path,
    path: "src/main.rs",
    access: "write",
    observedAt: 2,
  },
  {
    checkoutPath: "/unrelated",
    path: "README.md",
    access: "write",
    observedAt: 3,
  },
];
afterEach(cleanup);

function browser(target = source, file = false) {
  return (
    <CodeBrowser
      project={inventory.project}
      inventory={inventory}
      activity={activity}
      target={target}
      choose={vi.fn()}
      onNewIssue={vi.fn()}
      path={file ? "src/main.rs" : ""}
      setPath={vi.fn()}
      loading={false}
      refresh={vi.fn()}
      data={
        file
          ? {
              kind: "file",
              path: "src/main.rs",
              content: "fn main() {}",
              size: 12,
            }
          : {
              kind: "directory",
              path: "",
              entries: [
                {
                  name: "src",
                  path: "src",
                  kind: "directory",
                  size: 0,
                  modified: null,
                },
                {
                  name: "README.md",
                  path: "README.md",
                  kind: "file",
                  size: 0,
                  modified: null,
                },
              ],
            }
      }
    />
  );
}

describe("factory overview activity", () => {
  it("shows each worktree's read/write dots on source folders with branch attribution", () => {
    render(browser());
    const folder = screen.getByRole("button", { name: /^src/ });
    expect(
      within(folder).getByRole("img", {
        name: /Agent read src\/main.rs just now \(factory\/reader\)/,
      }),
    ).toBeTruthy();
    expect(
      within(folder).getByRole("img", {
        name: /Agent changed src\/main.rs just now \(factory\/writer\)/,
      }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "README.md" })
        .querySelector("[data-access]"),
    ).toBeNull();
    expect(
      (screen.getByLabelText("Checkout or worktree") as HTMLSelectElement).value,
    ).toBe("source");
    expect(screen.getByText("read: src/main.rs")).toBeTruthy();
    expect(screen.getByText("write: src/main.rs")).toBeTruthy();
  });

  it("shows worktree activity in the source file view without changing its contents", () => {
    const { container } = render(browser(source, true));
    const meta = container.querySelector(".file-meta")!;
    expect(within(meta as HTMLElement).getAllByRole("img")).toHaveLength(2);
    expect(screen.getByLabelText("Contents of src/main.rs").textContent).toBe(
      "fn main() {}",
    );
  });

  it("keeps isolated worktree dots scoped to that checkout", () => {
    render(browser(reader));
    const folder = screen.getByRole("button", { name: /^src/ });
    expect(within(folder).getAllByRole("img")).toHaveLength(1);
    expect(folder.querySelector('[data-access="read"]')).not.toBeNull();
    expect(folder.querySelector('[data-access="write"]')).toBeNull();
  });

  it("keeps a working worktree visible after dots expire, including when selected", () => {
    const choose = vi.fn();
    const tasks = [{ id: reader.taskId, status: "working" }] as Task[];
    const props = { inventory, target: reader, tasks, choose };
    const view = render(<CheckoutSelect {...props} activity={[activity[0]]} />);
    let chip = screen.getByRole("button", { name: /factory\/reader/ });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(chip.querySelector("[data-access]")).not.toBeNull();
    view.rerender(<CheckoutSelect {...props} activity={[]} />);
    chip = screen.getByRole("button", { name: /factory\/reader/ });
    expect(chip.querySelector("[data-access]")).toBeNull();
    expect(within(chip).getByText("Working…")).toBeTruthy();
    fireEvent.click(chip);
    expect(choose).toHaveBeenCalledWith(reader.id);
    view.rerender(<CheckoutSelect {...props} tasks={[]} activity={[]} />);
    expect(screen.queryByRole("button", { name: /factory\/reader/ })).toBeNull();
  });
});
