import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, desktop, type Snapshot } from "../../../shared/api";
import { useResource } from "../../../shared/hooks/useResource";
export function useIssue(id: string) {
  const session = useResource<Snapshot>(
    id,
    () => api("snapshot", { taskId: id }),
    2000,
  );
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let timer = 0;
    const listener = listen<{ taskId: string }>("factory-event", (event) => {
      if (!disposed && event.payload.taskId === id && !timer) {
        timer = window.setTimeout(() => {
          timer = 0;
          session.refresh();
        }, 180);
      }
    });
    void listener.catch(() => {});
    return () => {
      disposed = true;
      clearTimeout(timer);
      void listener.then((stop) => stop()).catch(() => {});
    };
  }, [id]);
  return session;
}
