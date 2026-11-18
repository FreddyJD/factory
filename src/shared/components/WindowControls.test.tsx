// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowControls } from "./WindowControls";
import { isMacDesktop } from "../platform";

const { desktop, minimize, toggleMaximize, close } = vi.hoisted(() => ({
  desktop: { value: true },
  minimize: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => desktop.value,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize, toggleMaximize, close }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  desktop.value = true;
});

describe("window chrome", () => {
  it("leaves macOS window controls to the native frame", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    expect(isMacDesktop()).toBe(true);
    const { container } = render(<WindowControls />);
    expect(container.childElementCount).toBe(0);
  });

  it.each(["Win32", "Linux x86_64"])(
    "keeps custom controls working on %s",
    (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      expect(isMacDesktop()).toBe(false);
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

  it("does not reserve native chrome or show controls in a Mac browser", () => {
    desktop.value = false;
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    expect(isMacDesktop()).toBe(false);
    const { container } = render(<WindowControls />);
    expect(container.childElementCount).toBe(0);
  });
});
