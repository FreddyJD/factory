import { useEffect, useRef, useState } from "react";
export function useResource<T>(
  key: string | null,
  load: () => Promise<T>,
  interval = 0,
) {
  const loader = useRef({ key, load });
  loader.current = { key, load };
  const trigger = useRef(() => {});
  const [state, setState] = useState<{
    key: string | null;
    value?: T;
    error?: string;
    loading: boolean;
  }>({ key: null, loading: false });
  useEffect(() => {
    if (key === null) {
      trigger.current = () => {};
      return;
    }
    let disposed = false,
      running = false,
      queued = false;
    const refresh = async () => {
      if (disposed || document.visibilityState === "hidden") return;
      if (running) {
        queued = true;
        return;
      }
      if (loader.current.key !== key) return;
      running = true;
      const execute = loader.current.load;
      try {
        const value = await execute();
        if (!disposed) setState({ key, value, loading: false });
      } catch (error) {
        if (!disposed)
          setState((current) => ({
            key,
            value: current.key === key ? current.value : undefined,
            error: String(error),
            loading: false,
          }));
      } finally {
        running = false;
        if (queued && !disposed) {
          queued = false;
          void refresh();
        }
      }
    };
    trigger.current = () => void refresh();
    setState((current) => ({
      key,
      value: current.key === key ? current.value : undefined,
      loading: true,
    }));
    void refresh();
    const timer = interval
      ? window.setInterval(() => void refresh(), interval)
      : 0;
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [key, interval]);
  return {
    ...(state.key === key ? state : { key, loading: !!key }),
    refresh: () => trigger.current(),
  };
}
