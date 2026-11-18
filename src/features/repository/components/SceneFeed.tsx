import { useEffect, useRef, useState } from "react";
import type { Checkout } from "../../../shared/types";
import type { FileActivity } from "../hooks/useFileActivity";
import type { ToolActivity } from "../hooks/useToolActivity";

import { stationColor } from "../production-line";

export function SceneFeed({
  seed = "",
  targets,
  calls,
  activity,
  choose,
  loading,
}: {
  seed?: string;
  targets: Checkout[];
  calls: ToolActivity[];
  activity: FileActivity[];
  choose: (id: string) => void;
  loading: boolean;
}) {
  const [files, setFiles] = useState<FileActivity[]>([]);
  const [following, setFollowing] = useState(true);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!activity.length) return;
    setFiles((previous) => {
      const entries = new Map(
        previous.map((file) => [
          `${file.checkoutPath}:${file.path}:${file.access}:${file.observedAt}`,
          file,
        ]),
      );
      for (const file of activity) {
        if (targets.some((target) => target.path === file.checkoutPath))
          entries.set(
            `${file.checkoutPath}:${file.path}:${file.access}:${file.observedAt}`,
            file,
          );
      }
      return [...entries.values()]
        .sort((a, b) => a.observedAt - b.observedAt)
        .slice(-80);
    });
  }, [activity, targets]);
  const rows = [
    ...[...calls].reverse().flatMap((call) => {
      const target = targets.find((target) => target.taskId === call.taskId);
      return target
        ? [
            {
              id: call.id,
              target,
              action: call.name,
              detail: call.detail,
              status: call.status,
              time: call.observedAt,
              recorded: call.observedAt === null,
            },
          ]
        : [];
    }),
    ...files.flatMap((file) => {
      const target = targets.find(
        (target) => target.path === file.checkoutPath,
      );
      return target
        ? [
            {
              id: `file:${file.checkoutPath}:${file.path}:${file.access}:${file.observedAt}`,
              target,
              action: file.access,
              detail: file.path || ".",
              status: "file",
              time: file.observedAt,
              recorded: false,
            },
          ]
        : [];
    }),
  ]
    .sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
    .slice(-80);
  const revision = rows
    .map((row) => `${row.id}:${row.status}:${row.time}`)
    .join("|");
  useEffect(() => {
    if (following && list.current)
      list.current.scrollTop = list.current.scrollHeight;
  }, [revision, following]);
  return (
    <aside className="scene-feed" aria-label="Activity feed">
      <header>
        <span>Activity</span>
        <small>all worktrees</small>
      </header>
      <div
        className="scene-feed-messages"
        ref={list}
        role="log"
        aria-label="Tool and file activity"
        aria-live="off"
        tabIndex={0}
        onScroll={(event) => {
          const node = event.currentTarget;
          setFollowing(
            node.scrollHeight - node.clientHeight - node.scrollTop < 28,
          );
        }}
      >
        {!rows.length && (
          <p className="scene-feed-empty">
            {loading
              ? "Loading activity..."
              : "Quiet for now. Tool calls and files land here."}
          </p>
        )}
        {rows.map((row) => (
          <p key={row.id} data-status={row.status}>
            {row.recorded && (
              <span
                className="scene-feed-recorded"
                title="Recorded history, not a live event"
              >
                history{" "}
              </span>
            )}
            <button
              style={{
                color: stationColor(`${seed}:${row.target.id}`),
              }}
              onClick={() => choose(row.target.id)}
              title={row.target.branch}
            >
              {row.target.branch}
            </button>
            <span className="scene-feed-action"> {row.action}</span>{" "}
            <code>{row.detail || "tool call"}</code>
            <span className="scene-feed-status">
              {row.status === "running"
                ? " running"
                : row.status === "error"
                  ? " failed"
                  : row.status === "interrupted"
                    ? " interrupted"
                    : row.status === "completed"
                      ? " done"
                      : ""}
            </span>
          </p>
        ))}
      </div>
      {!following && (
        <button
          className="scene-feed-follow"
          onClick={() => setFollowing(true)}
        >
          Jump to latest
        </button>
      )}
    </aside>
  );
}
