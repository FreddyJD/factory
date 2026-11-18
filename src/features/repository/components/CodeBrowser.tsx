import { useState } from "react";
import type {
  Browse,
  Inventory,
  Checkout,
  Project,
} from "../../../shared/types";
import { Icon } from "../../../shared/components/Icon";
import { Markdown } from "../../../shared/components/Markdown";
export function CheckoutSelect({
  inventory,
  target,
  choose,
}: {
  inventory?: Inventory;
  target?: Checkout;
  choose: (id: string) => void;
}) {
  return (
    <div className="checkout-controls">
      <label className="checkout-select">
        <Icon name="branch" />
        <select
          aria-label="Checkout or worktree"
          value={target?.id ?? ""}
          onChange={(event) => choose(event.target.value)}
        >
          {!target && <option value="">Select checkout</option>}
          {inventory?.targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.branch}{" "}
              {t.source
                ? "(source)"
                : t.taskId
                  ? "(agent worktree)"
                  : "(worktree)"}
            </option>
          ))}
        </select>
      </label>
      <span className="muted branches-count">
        <Icon name="branch" />
        {inventory?.branches.length ?? 0} branches
      </span>
      <span className="live-label">
        <i />
        Live filesystem
      </span>
    </div>
  );
}
export function CodeBrowser({
  project,
  inventory,
  choose,
  onNewIssue,
  target,
  path,
  setPath,
  data,
  error,
  loading,
  refresh,
}: {
  project: Project;
  inventory?: Inventory;
  choose: (id: string) => void;
  onNewIssue: () => void;
  target?: Checkout;
  path: string;
  setPath: (path: string) => void;
  data?: Browse;
  error?: string;
  loading: boolean;
  refresh: () => void;
}) {
  const [query, setQuery] = useState("");
  const [copyError, setCopyError] = useState("");
  const segments = path.split("/").filter(Boolean);
  return (
    <>
      <div
        className="repository-actionbar code-actionbar"
        role="toolbar"
        aria-label="Repository actions"
      >
        <CheckoutSelect inventory={inventory} target={target} choose={choose} />
        <div className="search-box">
          <Icon name="search" />
          <input
            aria-label="Filter files"
            placeholder="Filter files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button
          className="btn btn-default"
          onClick={refresh}
          aria-label="Refresh files"
        >
          Refresh
        </button>
        <button className="btn btn-success" onClick={onNewIssue}>
          New issue
        </button>
      </div>
      <div className="code-layout">
        <div className="repository-files">
          {segments.length > 0 && (
            <nav className="breadcrumbs" aria-label="File path">
              <button onClick={() => setPath("")}>{project.name}</button>
              {segments.map((part, index) => (
                <span key={index}>
                  {" "}
                  /{" "}
                  <button
                    onClick={() =>
                      setPath(segments.slice(0, index + 1).join("/"))
                    }
                  >
                    {part}
                  </button>
                </span>
              ))}
            </nav>
          )}
          {(error || copyError) && (
            <div className="alert alert-danger">{error || copyError}</div>
          )}
          {!target && !error && (
            <div className="blankslate">
              {loading
                ? "Loading checkout…"
                : "The selected worktree is unavailable. Choose another checkout."}
            </div>
          )}
          {target && (
            <>
              <div className="panel file-panel">
                <div className="panel-heading commit-heading">
                  <span className="avatar avatar-small">
                    {project.name[0]?.toUpperCase()}
                  </span>
                  <strong>{target.branch}</strong>
                  <span className="muted">
                    {target.source ? "Source checkout" : "Worktree"}
                  </span>
                  <code>{target.head.slice(0, 7)}</code>
                </div>
                {loading && !data && (
                  <div className="loading-row">Loading files…</div>
                )}
                {data?.kind === "directory" && (
                  <table className="table file-table">
                    <thead className="sr-only">
                      <tr>
                        <th>Name</th>
                        <th>Type</th>
                        <th>Modified</th>
                      </tr>
                    </thead>
                    <tbody>
                      {path && (
                        <tr>
                          <td colSpan={3}>
                            <button
                              className="file-link"
                              onClick={() =>
                                setPath(segments.slice(0, -1).join("/"))
                              }
                            >
                              ..
                            </button>
                          </td>
                        </tr>
                      )}
                      {data.entries
                        ?.filter((entry) =>
                          entry.name
                            .toLowerCase()
                            .includes(query.toLowerCase()),
                        )
                        .map((entry) => (
                          <tr key={entry.path}>
                            <td>
                              <button
                                className="file-link"
                                disabled={
                                  !["directory", "file"].includes(entry.kind)
                                }
                                onClick={() => setPath(entry.path)}
                              >
                                <span
                                  className={
                                    entry.kind === "directory"
                                      ? "folder-icon"
                                      : "file-icon"
                                  }
                                >
                                  <Icon
                                    name={
                                      entry.kind === "directory"
                                        ? "folder"
                                        : "file"
                                    }
                                  />
                                </span>
                                {entry.name}
                              </button>
                            </td>
                            <td className="muted file-description">
                              {entry.kind === "directory"
                                ? "Directory"
                                : entry.kind === "file"
                                  ? `${entry.size.toLocaleString()} bytes`
                                  : entry.kind}
                            </td>
                            <td className="muted file-date">
                              {entry.modified
                                ? new Date(
                                    entry.modified * 1000,
                                  ).toLocaleDateString()
                                : ""}
                            </td>
                          </tr>
                        ))}
                      {data.entries?.length === 0 && (
                        <tr>
                          <td colSpan={3} className="muted">
                            This directory is empty.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                )}
                {data?.kind === "file" && (
                  <>
                    <div className="file-meta">
                      {data.content?.split("\n").length ?? 0} lines{" "}
                      <span className="muted">
                        {" "}
                        · {data.size?.toLocaleString()} bytes
                      </span>
                      <button
                        className="btn btn-default btn-xs"
                        onClick={() => {
                          if (!navigator.clipboard) {
                            setCopyError("Clipboard unavailable");
                            return;
                          }
                          void navigator.clipboard
                            .writeText(data.content ?? "")
                            .catch((error) => setCopyError(String(error)));
                        }}
                      >
                        Copy
                      </button>
                    </div>
                    <div className="source-view">
                      <pre className="line-numbers" aria-hidden="true">
                        {data.content
                          ?.split("\n")
                          .map((_, i) => i + 1)
                          .join("\n")}
                      </pre>
                      <pre aria-label={`Contents of ${path}`}>
                        {data.content}
                      </pre>
                    </div>
                  </>
                )}
                {data?.kind === "unavailable" && (
                  <div className="blankslate">{data.reason}</div>
                )}
              </div>
              {data?.readme && (
                <section className="panel readme-panel">
                  <div className="panel-heading">
                    <Icon name="file" />
                    {data.readme.name}
                  </div>
                  <article className="markdown-body">
                    <Markdown text={data.readme.content} />
                  </article>
                </section>
              )}
            </>
          )}
        </div>
        <aside className="repo-about">
          <h3>About</h3>
          <p className="muted">{project.name}</p>
          {target && (
            <>
              <dl>
                <dt>Branch</dt>
                <dd>{target.branch}</dd>
                <dt>HEAD</dt>
                <dd>
                  <code>{target.head.slice(0, 12)}</code>
                </dd>
                <dt>Checkout</dt>
                <dd>{target.path}</dd>
              </dl>
              <hr />
              <p>
                <Icon name="file" /> README
              </p>
              <p>
                <Icon name="history" /> Local Git history
              </p>
              <p>
                <Icon name="branch" />{" "}
                {target.source ? "Source checkout" : "Isolated worktree"}
              </p>
            </>
          )}
        </aside>
      </div>
    </>
  );
}
