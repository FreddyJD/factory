import { expect, it } from "vitest";
import base from "../src-tauri/tauri.conf.json";
import macos from "../src-tauri/tauri.macos.conf.json";

it("uses a native macOS frame with an integrated titlebar", () => {
  expect(macos.app.windows).toHaveLength(1);
  expect(macos.app.windows[0]).toMatchObject({
    decorations: true,
    titleBarStyle: "Overlay",
    hiddenTitle: true,
  });
  expect(base.app.windows[0].decorations).toBe(false);
});

it("preserves main window identity and sizing in the macOS array override", () => {
  const { decorations: _, ...window } = base.app.windows[0];
  expect(macos.app.windows[0]).toMatchObject(window);
});
