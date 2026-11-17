import { useState } from "react";
import type { Task } from "../../../shared/api";
import { statusLabel } from "../../../shared/types";
import { Icon } from "../../../shared/components/Icon";
export function IssueList({
  tasks,
  onSelect,
  onNew,
}: {
  tasks: Task[];
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <section>
      <div className="section-toolbar">
        <div className="search-box issue-search">
          <Icon name="search" />
          <input
            aria-label="Search issues"
            placeholder="Search issues"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button className="btn btn-success" onClick={onNew}>
          New issue
        </button>
      </div>
      <div className="panel issue-list">
        <div className="panel-heading">
          <Icon name="issue" />
          <strong>{tasks.length} issues</strong>
          <span className="muted">Local agent runs</span>
        </div>
        {tasks
          .filter((t) => t.title.toLowerCase().includes(query.toLowerCase()))
          .map((task) => (
            <button
              className="issue-row"
              key={task.id}
              onClick={() => onSelect(task.id)}
            >
              <span className={`issue-indicator ${task.status}`}>
                <Icon name="issue" size={18} />
              </span>
              <span className="issue-row-main">
                <strong>{task.title.split("\n")[0]}</strong>
                <small>
                  #{task.id.slice(0, 7)} · {task.model} ·{" "}
                  {task.checkouts.length}{" "}
                  {task.checkouts.length === 1 ? "worktree" : "worktrees"}
                </small>
              </span>
              <span className={`status-label ${task.status}`}>
                {statusLabel(task.status)}
              </span>
            </button>
          ))}
        {!tasks.length && (
          <div className="blankslate">
            <Icon name="issue" size={28} />
            <h3>No issues</h3>
            <button className="btn btn-success" onClick={onNew}>
              New issue
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
