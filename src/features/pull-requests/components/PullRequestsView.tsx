import { useEffect, useRef, useState } from "react";
import { api } from "../../../shared/api";
import type { Project, PullRequest, PullDetail } from "../../../shared/types";
import { useResource } from "../../../shared/hooks/useResource";
import { Icon } from "../../../shared/components/Icon";
import { LocalReviews } from "./LocalReviews";
import type { Issue } from "../../../shared/types";
import { Markdown } from "../../../shared/components/Markdown";
export function PullRequestsView({
  project,
  local,
  onChange,
}: {
  project: Project;
  local: {
    value?: { issues: Issue[]; github: boolean };
    loading: boolean;
    error?: string;
    refresh: () => void;
  };
  onChange: () => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [review, setReview] = useState("");
  const [confirm, setConfirm] = useState<{
    number: number;
    head: string;
    body: string;
    repository: string;
    account: string;
  } | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [approved, setApproved] = useState("");
  const locked = useRef(false);
  const list = useResource<PullRequest[]>(
    local.value?.github ? project.id : null,
    () => api("pr_list", { projectId: project.id }),
    15000,
  );
  const detail = useResource<PullDetail>(
    local.value?.github && selected ? `${project.id}:${selected}` : null,
    () => api("pr_view", { projectId: project.id, number: selected }),
  );
  useEffect(() => {
    setConfirm((current) =>
      current &&
      (current.head !== detail.value?.pull.headRefOid ||
        current.repository !== detail.value?.repository ||
        current.account !== detail.value?.account)
        ? null
        : current,
    );
  }, [
    detail.value?.pull.headRefOid,
    detail.value?.repository,
    detail.value?.account,
  ]);
  async function approve() {
    if (
      !detail.value ||
      !confirm ||
      confirm.head !== detail.value.pull.headRefOid ||
      locked.current
    )
      return;
    const decision = confirm;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await api("pr_approve", {
        projectId: project.id,
        number: decision.number,
        head: decision.head,
        body: decision.body,
        repository: decision.repository,
        account: decision.account,
      });
      if (selectedRef.current !== decision.number) return;
      setApproved(decision.head);
      setConfirm(null);
      detail.refresh();
    } catch (error) {
      if (selectedRef.current === decision.number) setError(String(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <section>
      {local.loading && !local.value && (
        <div className="loading-row">Loading repository reviews...</div>
      )}
      {local.value && !local.value.github && (
        <LocalReviews
          project={project}
          issues={local.value?.issues ?? []}
          onChange={() => {
            onChange();
            local.refresh();
          }}
        />
      )}
      {local.error && <div className="alert alert-warning">{local.error}</div>}
      {local.value && !local.value.github && (
        <div className="alert alert-info">
          This repository has no GitHub origin. Review and merge local changes
          above; nothing is pushed.
        </div>
      )}
      {local.value?.github && (
        <>
          <div className="section-toolbar">
            <h2>
              {selected ? (
                <button
                  className="link-button"
                  onClick={() => {
                    setSelected(null);
                    setConfirm(null);
                  }}
                >
                  ← Pull requests
                </button>
              ) : (
                "Pull requests"
              )}
            </h2>
            <button
              className="btn btn-default"
              onClick={() => (selected ? detail.refresh() : list.refresh())}
            >
              Refresh
            </button>
          </div>
          {(list.error || detail.error || error) && (
            <div className="alert alert-danger" role="alert">
              {error || detail.error || list.error}
            </div>
          )}
          {!selected && (
            <div className="panel">
              <div className="panel-heading">
                <Icon name="pull" />
                <strong>{list.value?.length ?? 0} open</strong>
                <span className="muted">GitHub</span>
              </div>
              {list.value?.map((pr) => (
                <button
                  className="issue-row"
                  key={pr.number}
                  onClick={() => {
                    setSelected(pr.number);
                    setReview("");
                    setConfirm(null);
                    setApproved("");
                  }}
                >
                  <span className="issue-indicator">
                    <Icon name="pull" size={18} />
                  </span>
                  <span className="issue-row-main">
                    <strong>{pr.title}</strong>
                    <small>
                      #{pr.number} opened by {pr.author.login} ·{" "}
                      {pr.headRefName} → {pr.baseRefName}
                    </small>
                  </span>
                  <span className="label">
                    {pr.isDraft ? "Draft" : pr.reviewDecision || "Open"}
                  </span>
                </button>
              ))}
              {list.loading && !list.value && (
                <div className="loading-row">Loading pull requests…</div>
              )}
              {list.value?.length === 0 && (
                <div className="blankslate">
                  <Icon name="pull" size={28} />
                  <h3>No open pull requests</h3>
                </div>
              )}
            </div>
          )}
          {selected && detail.value && (
            <>
              <div className="issue-title">
                <h1>
                  {detail.value.pull.title}
                  <span> #{selected}</span>
                </h1>
                <p className="muted">
                  {detail.value.pull.author.login} wants to merge{" "}
                  <code>{detail.value.pull.headRefName}</code> into{" "}
                  <code>{detail.value.pull.baseRefName}</code>
                </p>
              </div>
              <article className="panel">
                <div className="panel-heading">
                  Description
                  <a
                    href={detail.value.pull.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on GitHub
                  </a>
                </div>
                <div className="panel-body markdown-body">
                  <Markdown text={detail.value.pull.body ?? ""} />
                </div>
              </article>
              <div className="panel">
                <div className="panel-heading">
                  Files changed{" "}
                  <span className="badge">
                    {detail.value.pull.files?.length ?? 0}
                  </span>
                  <code>{detail.value.pull.headRefOid.slice(0, 7)}</code>
                </div>
                <pre className="diff-view">{detail.value.diff}</pre>
              </div>
              {detail.value.pull.reviews?.map((r, index) => (
                <div className="panel" key={index}>
                  <div className="panel-heading">
                    {r.author.login} · {r.state}
                  </div>
                  {r.body && <div className="panel-body">{r.body}</div>}
                </div>
              ))}
              {approved && (
                <div className="alert alert-success">
                  Approved commit {approved.slice(0, 7)}.
                </div>
              )}
              <div className="panel">
                <div className="panel-heading">Review changes</div>
                <div className="panel-body">
                  <textarea
                    className="form-control"
                    aria-label="Pull request review"
                    placeholder="Review comment (optional)"
                    rows={3}
                    value={review}
                    onChange={(event) => setReview(event.target.value)}
                  />
                  {confirm ? (
                    <div className="review-confirm">
                      <p>
                        Submit approval as {confirm.account} for{" "}
                        {confirm.repository}, commit{" "}
                        <code>{confirm.head.slice(0, 12)}</code>? GitHub does
                        not allow approving your own PR.
                      </p>
                      <div className="button-row">
                        <button
                          className="btn btn-success"
                          disabled={busy}
                          onClick={() => void approve()}
                        >
                          {busy ? "Submitting…" : "Submit approval"}
                        </button>
                        <button
                          className="btn btn-default"
                          onClick={() => setConfirm(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="form-actions">
                      <button
                        className="btn btn-success"
                        onClick={() =>
                          setConfirm({
                            number: selected,
                            head: detail.value!.pull.headRefOid,
                            body: review,
                            repository: detail.value!.repository,
                            account: detail.value!.account,
                          })
                        }
                      >
                        Approve pull request
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
