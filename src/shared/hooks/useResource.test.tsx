// @vitest-environment jsdom
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, it, expect, vi } from "vitest";
import { useResource } from "./useResource";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("skips poll ticks during a slow request without queuing catch-up work", async () => {
  vi.useFakeTimers();
  let finish!: (value: string) => void;
  const load = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const { result } = renderHook(() => useResource("scope", load, 1000));
  expect(load).toHaveBeenCalledOnce();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(load).toHaveBeenCalledOnce();
  await act(async () => finish("first"));
  expect(result.current.value).toBe("first");
  expect(load).toHaveBeenCalledOnce();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => finish("second"));
});
it("coalesces repeated refreshes without starving a slow resource", async () => {
  let first!: (value: string) => void;
  let second!: (value: string) => void;
  const load = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          first = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          second = resolve;
        }),
    );
  const { result } = renderHook(() => useResource("scope", load));
  await waitFor(() => expect(load).toHaveBeenCalledOnce());
  act(() => {
    result.current.refresh();
    result.current.refresh();
    result.current.refresh();
  });
  expect(load).toHaveBeenCalledOnce();
  await act(async () => first("first"));
  expect(result.current.value).toBe("first");
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => second("second"));
  expect(result.current.value).toBe("second");
});
