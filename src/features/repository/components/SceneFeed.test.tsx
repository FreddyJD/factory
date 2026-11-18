// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SceneFeed } from "./SceneFeed";
import type { Checkout } from "../../../shared/types";
import type { ToolActivity } from "../hooks/useToolActivity";

const targets: Checkout[] = [
  {
    id: "a",
    taskId: "task-a",
    branch: "feature/a",
    path: "/a",
    source: false,
    head: "abc",
  },
];
const call: ToolActivity = {
  id: "tool",
  taskId: "task-a",
  name: "edit",
  detail: "src/a.rs",
  status: "running",
  observedAt: 100,
};
afterEach(cleanup);

it("keeps file observations after transient dots expire and excludes unrelated checkouts", () => {
  const choose = vi.fn();
  const props = { targets, calls: [], choose, loading: false };
  const { rerender } = render(
    <SceneFeed
      {...props}
      activity={[
        {
          checkoutPath: "/a",
          path: "retained.rs",
          access: "write",
          observedAt: 20,
        },
        {
          checkoutPath: "/other",
          path: "unrelated.rs",
          access: "read",
          observedAt: 30,
        },
      ]}
    />,
  );
  expect(screen.queryByText("unrelated.rs")).toBeNull();
  rerender(<SceneFeed {...props} activity={[]} />);
  expect(screen.getByText("retained.rs")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "feature/a" }));
  expect(choose).toHaveBeenCalledWith("a");
});

it("bounds its feed and updates a tool row rather than duplicating it", () => {
  const props = { targets, choose: vi.fn(), loading: false, activity: [] };
  const calls = Array.from({ length: 100 }, (_, i) => ({
    ...call,
    id: String(i),
    detail: `file-${i}`,
    observedAt: i,
  }));
  const { rerender } = render(<SceneFeed {...props} calls={calls} />);
  expect(screen.getByRole("log").querySelectorAll("p")).toHaveLength(80);
  expect(screen.queryByText("file-0")).toBeNull();
  rerender(<SceneFeed {...props} calls={[{ ...call, status: "error" }]} />);
  expect(screen.getAllByText("src/a.rs")).toHaveLength(1);
  expect(screen.getByText("failed")).toBeTruthy();
});

it("does not steal scroll position while reading older entries", () => {
  const props = { targets, choose: vi.fn(), loading: false, activity: [] };
  const { rerender } = render(<SceneFeed {...props} calls={[call]} />);
  const log = screen.getByRole("log");
  Object.defineProperties(log, {
    clientHeight: { value: 100 },
    scrollHeight: { value: 500 },
  });
  log.scrollTop = 20;
  fireEvent.scroll(log);
  rerender(
    <SceneFeed
      {...props}
      calls={[call, { ...call, id: "new", detail: "new.rs", observedAt: 200 }]}
    />,
  );
  expect(log.scrollTop).toBe(20);
  fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
  expect(log.scrollTop).toBe(500);
  expect(within(log).getByText("new.rs")).toBeTruthy();
});
