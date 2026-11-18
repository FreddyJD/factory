import type { FileActivity } from "../../features/repository/hooks/useFileActivity";

export function ActivityDot({
  activity,
  checkout,
}: {
  activity?: FileActivity;
  checkout?: string;
}) {
  const label = activity
    ? {
        read: "Agent read",
        write: "Agent changed",
        list: "Agent listed",
        search: "Agent found",
      }[activity.access] +
      " " +
      (activity.path || "worktree root") +
      " just now" +
      (checkout ? ` (${checkout})` : "")
    : undefined;
  return (
    <span
      className="file-activity-dot"
      data-access={activity?.access}
      role={activity ? "img" : undefined}
      aria-label={label}
      aria-hidden={!activity}
      title={label}
    />
  );
}
