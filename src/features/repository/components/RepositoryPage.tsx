import { useEffect, useRef, useState } from "react";
import { api, type Task } from "../../../shared/api";
import type { Project, Tab, Issue } from "../../../shared/types";
import { useResource } from "../../../shared/hooks/useResource";
import { Icon } from "../../../shared/components/Icon";
import type { FileActivity } from "../hooks/useFileActivity";
import { useRepository } from "../hooks/useRepository";
import { CodeBrowser, CheckoutSelect } from "./CodeBrowser";
import { HistoryView } from "./HistoryView";
import { IssueList } from "../../issues/components/IssueList";
import { IssueThread } from "../../issues/components/IssueThread";
import { NewIssue } from "../../issues/components/NewIssue";
import { PullRequestsView } from "../../pull-requests/components/PullRequestsView";

export function RepositoryPage({
  project,
  activity,
  tasks: allTasks,
  issues,
  tab,
  setTab,
  refresh,
  onSettings,
}: {
  project: Project;
  activity: FileActivity[];
  tasks: Task[];
  issues: Issue[];
  tab: Tab;
  setTab: (tab: Tab) => void;
  refresh: () => void;
  onSettings: () => void;
}) {
  const repository = useRepository(project, tab === "code", activity);
  const local = useResource<{ issues: Issue[]; github: boolean }>(
    tab === "issues" || tab === "pulls" ? `local-reviews:${project.id}` : null,
    () => api("local_reviews", { projectId: project.id }),
    4000,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createdTask, setCreatedTask] = useState<Task | null>(null);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [removal, setRemoval] = useState<Task | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removalError, setRemovalError] = useState("");
  const removalLock = useRef(false);
  const removalConfirmation = useRef<HTMLElement>(null);
  const tasks = allTasks.filter((task) => !removedIds.includes(task.id));
  const selectedTask =
    tasks.find((t) => t.id === selected) ??
    (createdTask?.id === selected ? createdTask : undefined);
  const [requestedWorktree, setRequestedWorktree] = useState<string | null>(
    null,
  );
  const name =
    repository.inventory.value?.remote
      ?.replace(/\.git$/, "")
      .split(/[:/]/)
      .filter(Boolean)
      .slice(-2)
      .join(" / ") ?? project.name;
  useEffect(() => {
    if (removal) removalConfirmation.current?.focus();
  }, [removal]);
  useEffect(() => {
    if (!requestedWorktree) return;
    const target = repository.inventory.value?.targets.find(
      (t) => t.path === requestedWorktree,
    );
    if (target) {
      repository.choose(target.id);
      setRequestedWorktree(null);
    }
  }, [repository.inventory.value, requestedWorktree]);
  function changeTab(next: Tab) {
    setTab(next);
    if (next !== "issues") setCreating(false);
  }
  function newIssue() {
    setTab("issues");
    setCreating(true);
    setSelected(null);
  }
  function requestRemoval(task: Task) {
    if (removalLock.current) return;
    setRemoval(task);
    setRemovalError("");
  }
  async function removeIssue() {
    if (!removal || removalLock.current) return;
    removalLock.current = true;
    setRemoving(true);
    setRemovalError("");
    try {
      await api("issue_remove", { taskId: removal.id, confirm: true });
      setRemovedIds((ids) => [...ids, removal.id]);
      setSelected((id) => (id === removal.id ? null : id));
      setCreatedTask((task) => (task?.id === removal.id ? null : task));
      setRemoval(null);
      local.refresh();
      refresh();
      repository.inventory.refresh();
    } catch (error) {
      setRemovalError(String(error));
    } finally {
      removalLock.current = false;
      setRemoving(false);
    }
  }
  return (
    <>
      <div className="repository-header">
        <div className="repository-title">
          <Icon name="repo" size={20} />
          <h1>{name}</h1>
        </div>
        <nav className="repo-tabs" aria-label="Repository">
          {(
            [
              ["code", "Code", "code"],
              ["issues", "Issues", "issue"],
              ["pulls", "Pull requests", "pull"],
              ["history", "History", "history"],
            ] as const
          ).map(([key, label, icon]) => (
            <button
              key={key}
              aria-current={tab === key ? "page" : undefined}
              onClick={() => changeTab(key)}
            >
              <Icon name={icon} />
              {label}
              {key === "issues" && (
                <span className="badge">{tasks.length}</span>
              )}
            </button>
          ))}
        </nav>
      </div>
      <main className="repository-content">
        {tab === "issues" && removal && (
          <section
            ref={removalConfirmation}
            tabIndex={-1}
            className="alert alert-warning"
            aria-label="Confirm issue removal"
          >
            <h3>Remove issue?</h3>
            <p>
              Remove <strong>{removal.title}</strong> from issues and local
              reviews. Any active run will be stopped and its worker released.
              Worktrees, generated files, branches and recovery history stay on
              disk. Existing pull requests and local merges are not undone.
            </p>
            {removalError && <p role="alert">{removalError}</p>}
            <div className="button-row">
              <button
                className="btn btn-danger"
                disabled={removing}
                onClick={() => void removeIssue()}
              >
                {removing
                  ? "Stopping and removing..."
                  : "Stop and remove issue"}
              </button>
              <button
                className="btn btn-default"
                disabled={removing}
                onClick={() => setRemoval(null)}
              >
                Keep issue
              </button>
            </div>
          </section>
        )}
        {tab !== "code" && (
          <div className="repository-actionbar">
            {tab === "history" ? (
              <CheckoutSelect
                activity={activity}
                inventory={repository.inventory.value}
                target={repository.target}
                choose={repository.choose}
              />
            ) : (
              <span className="muted">{project.name}</span>
            )}
            {tab !== "issues" && (
              <button className="btn btn-success" onClick={newIssue}>
                New issue
              </button>
            )}
          </div>
        )}
        {repository.inventory.error && (
          <div className="alert alert-danger">{repository.inventory.error}</div>
        )}
        {tab === "code" && (
          <CodeBrowser
            activity={activity}
            project={project}
            inventory={repository.inventory.value}
            choose={repository.choose}
            onNewIssue={newIssue}
            target={repository.target}
            path={repository.path}
            setPath={repository.setPath}
            data={repository.listing.value}
            error={repository.listing.error}
            loading={repository.listing.loading || repository.inventory.loading}
            refresh={() => {
              repository.inventory.refresh();
              repository.listing.refresh();
            }}
          />
        )}
        {tab === "history" && (
          <HistoryView project={project} target={repository.target} />
        )}{" "}
        {tab === "pulls" && (
          <PullRequestsView
            project={project}
            local={local}
            onChange={() => {
              refresh();
              repository.inventory.refresh();
            }}
          />
        )}{" "}
        {tab === "issues" &&
          (creating ? (
            <NewIssue
              project={project}
              github={local.value?.github}
              onCancel={() => setCreating(false)}
              onSettings={onSettings}
              onCreated={(task) => {
                setCreatedTask(task);
                refresh();
                setSelected(task.id);
                setCreating(false);
              }}
            />
          ) : selectedTask ? (
            <IssueThread
              key={selectedTask.id}
              task={selectedTask}
              project={project}
              onSettings={onSettings}
              github={local.value?.github}
              issue={issues.find((i) => i.taskId === selectedTask.id)}
              onBack={() => setSelected(null)}
              onRemove={requestRemoval}
              onChange={() => {
                refresh();
                repository.inventory.refresh();
              }}
              onLocalReview={() => changeTab("pulls")}
              onCode={(id) => {
                setRequestedWorktree(id);
                repository.inventory.refresh();
                changeTab("code");
              }}
            />
          ) : (
            <IssueList
              tasks={tasks}
              onSelect={setSelected}
              onNew={newIssue}
              onRemove={requestRemoval}
            />
          ))}
      </main>
    </>
  );
}
