import { useEffect, useState } from "react";
import type { Task } from "../../../shared/api";
import type { Project, Tab, Issue } from "../../../shared/types";
import { Icon } from "../../../shared/components/Icon";
import { useRepository } from "../hooks/useRepository";
import { CodeBrowser, CheckoutSelect } from "./CodeBrowser";
import { HistoryView } from "./HistoryView";
import { IssueList } from "../../issues/components/IssueList";
import { IssueThread } from "../../issues/components/IssueThread";
import { NewIssue } from "../../issues/components/NewIssue";
import { PullRequestsView } from "../../pull-requests/components/PullRequestsView";

export function RepositoryPage({
  project,
  tasks,
  issues,
  tab,
  setTab,
  refresh,
  onSettings,
}: {
  project: Project;
  tasks: Task[];
  issues: Issue[];
  tab: Tab;
  setTab: (tab: Tab) => void;
  refresh: () => void;
  onSettings: () => void;
}) {
  const repository = useRepository(project, tab === "code");
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createdTask, setCreatedTask] = useState<Task | null>(null);
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
  return (
    <>
      <div className="repository-header">
        <div className="repository-title">
          <Icon name="repo" size={20} />
          <h1>{name}</h1>
          <span className="visibility-label">Local</span>
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
        <div className="repository-actionbar">
          {tab === "code" || tab === "history" ? (
            <CheckoutSelect
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
        {repository.inventory.error && (
          <div className="alert alert-danger">{repository.inventory.error}</div>
        )}
        {tab === "code" && (
          <CodeBrowser
            project={project}
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
              issue={issues.find((i) => i.taskId === selectedTask.id)}
              onBack={() => setSelected(null)}
              onChange={refresh}
              onLocalReview={() => changeTab("pulls")}
              onCode={(id) => {
                setRequestedWorktree(id);
                repository.inventory.refresh();
                changeTab("code");
              }}
            />
          ) : (
            <IssueList tasks={tasks} onSelect={setSelected} onNew={newIssue} />
          ))}
      </main>
    </>
  );
}
