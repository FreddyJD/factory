// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WindowControls } from "./WindowControls";

const { isTauri, minimize, toggleMaximize, close } = vi.hoisted(() => ({
  isTauri: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize, toggleMaximize, close }),
}));

beforeEach(() => {
  isTauri.mockReturnValue(true);
  minimize.mockResolvedValue(undefined);
  toggleMaximize.mockResolvedValue(undefined);
  close.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("leaves macOS window controls to the native frame", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const { container } = render(<WindowControls />);
  expect(container.childElementCount).toBe(0);
});

it.each(["Win32", "Linux x86_64"])(
  "keeps working custom controls on %s",
  (platform) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    render(<WindowControls />);
    fireEvent.click(screen.getByRole("button", { name: "Minimize window" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Maximize or restore window" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    expect(minimize).toHaveBeenCalledOnce();
    expect(toggleMaximize).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  },
);

it("does not render desktop controls in a browser", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  isTauri.mockReturnValue(false);
  const { container } = render(<WindowControls />);
  expect(container.childElementCount).toBe(0);
});
