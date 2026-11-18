// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import baseConfig from "../../../src-tauri/tauri.conf.json";
import macConfig from "../../../src-tauri/tauri.macos.conf.json";
import { WindowControls } from "./WindowControls";

const { isTauri, minimize, toggleMaximize, close } = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  minimize: vi.fn(async () => {}),
  toggleMaximize: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize, toggleMaximize, close }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  isTauri.mockReturnValue(true);
});

describe("WindowControls", () => {
  it("leaves macOS controls to the native frame and reserves header space", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const { container } = render(<WindowControls />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(
      container.querySelector(".native-mac-controls")?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("keeps custom window actions on Windows", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    render(<WindowControls />);
    fireEvent.click(screen.getByRole("button", { name: "Minimize window" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Maximize or restore window" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    expect(minimize).toHaveBeenCalledOnce();
    expect(toggleMaximize).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not reserve native controls space in a Mac browser preview", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    isTauri.mockReturnValue(false);
    const { container } = render(<WindowControls />);
    expect(container.innerHTML).toBe("");
  });
});

it("enables the native macOS frame without changing window identity or size", () => {
  const { decorations: baseDecorations, ...baseWindow } =
    baseConfig.app.windows[0];
  const { decorations, titleBarStyle, hiddenTitle, ...macWindow } =
    macConfig.app.windows[0];
  expect(baseDecorations).toBe(false);
  expect(decorations).toBe(true);
  expect(titleBarStyle).toBe("Overlay");
  expect(hiddenTitle).toBe(true);
  expect(macWindow).toEqual(baseWindow);
});
