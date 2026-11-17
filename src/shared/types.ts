import type { Task, RuntimeStatus } from "./api";
export interface Project {
  id: string;
  name: string;
  path: string;
}
export interface Checkout {
  id: string;
  path: string;
  branch: string;
  head: string;
  source: boolean;
  taskId: string | null;
}
export interface Inventory {
  project: Project;
  targets: Checkout[];
  branches: string[];
  remote: string | null;
}
export interface Entry {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "unsupported";
  size: number;
  modified: number | null;
}
export interface Browse {
  kind: "directory" | "file" | "unavailable";
  path: string;
  entries?: Entry[];
  content?: string;
  reason?: string;
  size?: number;
  readme?: { name: string; content: string } | null;
}
export interface Issue {
  taskId: string;
  projectId: string;
  title: string;
  body: string;
  createdAt: number;
  nativeEdits: boolean;
  autoPr: boolean;
  validation: string;
  outcome: string;
  stopReason: string;
  publication: {
    state?: string;
    url?: string;
    error?: string;
    number?: number;
  } | null;
}
export interface Status extends RuntimeStatus {
  projects: Project[];
  issues: Issue[];
}
export interface Commit {
  sha: string;
  author: string;
  date: string;
  subject: string;
}
export interface PullRequest {
  number: number;
  title: string;
  body?: string;
  author: { login: string };
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isDraft: boolean;
  url: string;
  createdAt?: string;
  reviewDecision?: string;
  files?: { path: string; additions: number; deletions: number }[];
  reviews?: { author: { login: string }; state: string; body: string }[];
}
export interface PullDetail {
  repository: string;
  account: string;
  pull: PullRequest;
  diff: string;
}
export type Tab = "code" | "issues" | "pulls" | "history";
export function belongs(task: Task, project: Project) {
  return (
    task.workspace === project.path ||
    task.checkouts.some((c) => c.source === project.path)
  );
}
export function issueNumber(id: string, tasks: Task[]) {
  const index = tasks.findIndex((t) => t.id === id);
  return index < 0 ? id.slice(0, 6) : String(index + 1);
}
export function statusLabel(status: string) {
  return (
    (
      {
        working: "Running",
        "needs-you": "Needs input",
        review: "Ready for review",
        "budget-exhausted": "Run limit reached",
        stopped: "Stopped",
        failed: "Failed",
        ready: "Idle",
        publishing: "Publishing PR",
        interrupted: "Interrupted",
      } as Record<string, string>
    )[status] ?? status
  );
}
