// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowControls } from "./WindowControls";

const { isTauri } = vi.hoisted(() => ({ isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  isTauri.mockReturnValue(true);
});

describe("window chrome", () => {
  it("leaves macOS window controls to the native titlebar", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const { container } = render(<WindowControls />);
    expect(container.childElementCount).toBe(0);
  });

  it("keeps custom controls on Windows", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    render(<WindowControls />);
    expect(screen.getByRole("button", { name: "Minimize window" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Maximize or restore window" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close window" })).toBeTruthy();
  });

  it("does not show window controls in browser previews", () => {
    isTauri.mockReturnValue(false);
    const { container } = render(<WindowControls />);
    expect(container.childElementCount).toBe(0);
  });
});
