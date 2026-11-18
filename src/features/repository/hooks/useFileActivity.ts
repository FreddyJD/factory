import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { desktop, preview } from "../../../shared/api";

export interface FileActivity {
  checkoutPath: string;
  path: string;
  access: "read" | "write" | "list" | "search";
  observedAt: number;
}
export const ACTIVITY_TTL = 4000;

export function activityAt(
  activity: FileActivity[],
  checkout?: string,
  path = "",
  directory = true,
) {
  const matches = activity.filter(
    (item) =>
      item.checkoutPath === checkout &&
      (item.path === path ||
        (directory && (!path || item.path.startsWith(path + "/")))),
  );
  return matches.find((item) => item.access === "write") ?? matches[0];
}

export function useFileActivity() {
  const [activity, setActivity] = useState<FileActivity[]>([]);
  useEffect(() => {
    if (!desktop || preview) return;
    let disposed = false;
    const listener = listen<{
      event: { type: string; properties: FileActivity };
    }>("factory-event", ({ payload }) => {
      if (disposed || payload.event?.type !== "file-activity") return;
      const item = payload.event.properties;
      const now = Date.now();
      if (
        !item ||
        typeof item.checkoutPath !== "string" ||
        typeof item.path !== "string" ||
        !["read", "write", "list", "search"].includes(item.access) ||
        !Number.isFinite(item.observedAt) ||
        item.observedAt + ACTIVITY_TTL <= now ||
        item.observedAt > now + 1000
      )
        return;
      setActivity((previous) => {
        const live = previous.filter(
          (entry) => entry.observedAt + ACTIVITY_TTL > now,
        );
        const existing = live.find(
          (entry) =>
            entry.checkoutPath === item.checkoutPath &&
            entry.path === item.path &&
            entry.access === item.access,
        );
        if (existing && existing.observedAt >= item.observedAt) return live;
        return [...live.filter((entry) => entry !== existing), item];
      });
    });
    void listener.catch(() => {});
    return () => {
      disposed = true;
      void listener.then((stop) => stop()).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!activity.length) return;
    const prune = () =>
      setActivity((previous) =>
        previous.filter((item) => item.observedAt + ACTIVITY_TTL > Date.now()),
      );
    const deadline = Math.min(
      ...activity.map((item) => item.observedAt + ACTIVITY_TTL),
    );
    const timer = window.setTimeout(prune, Math.max(0, deadline - Date.now()));
    window.addEventListener("focus", prune);
    document.addEventListener("visibilitychange", prune);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", prune);
      document.removeEventListener("visibilitychange", prune);
    };
  }, [activity]);
  return activity;
}
