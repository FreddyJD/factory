import { describe, it, expect } from "vitest";
import { visibleRange, wrapText } from "./transcript-canvas";
describe("canvas virtualization", () => {
  it("only visits visible rows even for a million tasks", () => {
    const range = visibleRange(760_000, 760, 1_000_000);
    expect(range.first).toBe(10_000);
    expect(range.last - range.first).toBeLessThan(12);
  });
  it("wraps long tokens without losing characters", () => {
    expect(wrapText("abcdefgh", 3, (t) => t.length).join("")).toBe("abcdefgh");
    expect(wrapText("hello\nworld", 20, (t) => t.length)).toEqual([
      "hello",
      "world",
    ]);
  });
});
