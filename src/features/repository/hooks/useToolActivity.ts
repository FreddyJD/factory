import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  api,
  desktop,
  preview,
  type Snapshot,
  type Task,
} from "../../../shared/api";
import { useResource } from "../../../shared/hooks/useResource";

export interface ToolActivity {
  id: string;
  taskId: string;
  name: string;
  status: "running" | "completed" | "error" | "interrupted";
  detail: string;
  observedAt: number | null;
}

export function toolDetail(input: unknown) {
  if (!input || typeof input !== "object") return "";
  const values = input as Record<string, unknown>;
  for (const key of [
    "filePath",
    "path",
    "command",
    "query",
    "url",
    "description",
  ])
    if (typeof values[key] === "string") return values[key].slice(0, 240);
  return "";
}

export function snapshotTools(snapshot: Snapshot): ToolActivity[] {
  return snapshot.messages
    .flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "tool" &&
        part.tool &&
        ["running", "completed", "error"].includes(part.state?.status ?? "")
          ? [
              {
                id: `${snapshot.task.id}:${message.info.id}:${part.id}`,
                taskId: snapshot.task.id,
                name: part.tool,
                status: part.state!.status as ToolActivity["status"],
                detail: toolDetail(part.state?.input),
                observedAt: null,
              },
            ]
          : [],
      ),
    )
    .slice(-100)
    .reverse();
}

export function mergeTools(
  history: ToolActivity[],
  live: ToolActivity[],
  tasks: Task[],
) {
  const calls = new Map(history.map((call) => [call.id, call]));
  for (const call of live) {
    const recorded = calls.get(call.id);
    // Recover terminal states missed by the transient event stream.
    calls.set(
      call.id,
      call.status === "running" && recorded && recorded.status !== "running"
        ? { ...recorded, observedAt: call.observedAt }
        : call,
    );
  }
  return [...calls.values()]
    .filter((call) => tasks.some((task) => task.id === call.taskId))
    .map((call) =>
      call.status === "running" &&
      !tasks.some(
        (task) =>
          task.id === call.taskId &&
          ["working", "needs-you", "publishing"].includes(task.status),
      )
        ? { ...call, status: "interrupted" as const }
        : call,
    )
    .sort(
      (a, b) =>
        Number(b.status === "running") - Number(a.status === "running") ||
        (b.observedAt ?? 0) - (a.observedAt ?? 0),
    )
    .slice(0, 300);
}

export function useToolActivity(tasks: Task[], enabled: boolean) {
  const [live, setLive] = useState<ToolActivity[]>([]);
  const taskKey = JSON.stringify(tasks.map((task) => task.id).sort());
  const history = useResource<{ calls: ToolActivity[]; failed: number }>(
    enabled ? taskKey : null,
    async () => {
      const results = await Promise.allSettled(
        tasks.map((task) => api<Snapshot>("snapshot", { taskId: task.id })),
      );
      return {
        calls: results.flatMap((result) =>
          result.status === "fulfilled" ? snapshotTools(result.value) : [],
        ),
        failed: results.filter((result) => result.status === "rejected").length,
      };
    },
    4000,
  );
  const [connection, setConnection] = useState<
    "connecting" | "live" | "offline"
  >(preview || !desktop ? "offline" : "connecting");
  useEffect(() => {
    if (!desktop || preview) return;
    let disposed = false;
    const subscription = listen<{
      taskId: string;
      event: { type: string; properties: Record<string, unknown> };
    }>("factory-event", ({ payload }) => {
      if (disposed || payload.event?.type !== "tool") return;
      const p = payload.event.properties;
      if (
        !p ||
        typeof payload.taskId !== "string" ||
        typeof p.messageId !== "string" ||
        typeof p.callId !== "string" ||
        typeof p.name !== "string" ||
        !["running", "completed", "error"].includes(String(p.status))
      )
        return;
      const call: ToolActivity = {
        id: `${payload.taskId}:${p.messageId}:${p.callId}`,
        taskId: payload.taskId,
        name: p.name,
        status: p.status as ToolActivity["status"],
        detail: toolDetail(p.input),
        observedAt: Date.now(),
      };
      setLive((previous) => {
        const existing = previous.find((item) => item.id === call.id);
        if (
          existing &&
          existing.status !== "running" &&
          call.status === "running"
        )
          return previous;
        return [...previous.filter((item) => item.id !== call.id), call]
          .sort(
            (a, b) =>
              Number(b.status === "running") - Number(a.status === "running") ||
              (b.observedAt ?? 0) - (a.observedAt ?? 0),
          )
          .slice(0, 300);
      });
    });
    void subscription
      .then(() => {
        if (!disposed) setConnection("live");
      })
      .catch(() => {
        if (!disposed) setConnection("offline");
      });
    return () => {
      disposed = true;
      void subscription.then((stop) => stop()).catch(() => {});
    };
  }, []);
  return {
    calls: mergeTools(history.value?.calls ?? [], live, tasks),
    connection,
    loading: history.loading,
    error:
      history.error ||
      (history.value?.failed
        ? "Some tool history could not be loaded. Live events are still shown."
        : undefined),
  };
}
