import { useEffect, useRef, useState } from "react";
import { api } from "../../../shared/api";
import type { Issue, Project } from "../../../shared/types";
import { useResource } from "../../../shared/hooks/useResource";
import { Icon } from "../../../shared/components/Icon";
interface LocalPreview {
  taskId: string;
  title: string;
  branch: string;
  sourceRef: string;
  sourceHead: string;
  head: string;
  tree: string;
  diff: string;
  mode: string;
  validation: string;
  sourcePath: string;
}
export function LocalReviews({
  project,
  issues,
  onChange,
}: {
  project: Project;
  issues: Issue[];
  onChange: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [quickMerge, setQuickMerge] = useState(false);
  const [confirmation, setConfirmation] = useState<LocalPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [merged, setMerged] = useState("");
  const gate = useRef(false);
  const mergeTrigger = useRef<HTMLButtonElement | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const details = useResource<LocalPreview>(
    selected && !busy && !merged ? `local:${project.id}:${selected}` : null,
    () => api("local_preview", { projectId: project.id, taskId: selected }),
  );
  const fingerprint = details.value ? JSON.stringify(details.value) : "";
  const attempted = !!issues.find((issue) => issue.taskId === selected)
    ?.localMerge;
  useEffect(() => {
    if (busy || merged) return;
    setConfirmation((current) =>
      !details.error && !attempted
        ? quickMerge
          ? (details.value ?? null)
          : current?.taskId === selected &&
              JSON.stringify(current) === fingerprint
            ? current
            : null
        : null,
    );
  }, [
    selected,
    fingerprint,
    details.error,
    busy,
    merged,
    quickMerge,
    attempted,
  ]);
  async function merge() {
    if (
      !confirmation ||
      !selected ||
      gate.current ||
      details.error ||
      attempted
    )
      return;
    const id = selected;
    const preview = confirmation;
    gate.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ commit: string }>("local_merge", {
        projectId: project.id,
        taskId: id,
        preview,
      });
      onChange();
      if (selectedRef.current === id) {
        setMerged(result.commit);
        setConfirmation(null);
      }
    } catch (error) {
      if (selectedRef.current === id) {
        setError(String(error));
        setConfirmation(null);
        if (quickMerge) {
          setSelected(null);
          setQuickMerge(false);
        }
      }
      onChange();
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  function cancel() {
    setConfirmation(null);
    if (quickMerge) {
      setSelected(null);
      setQuickMerge(false);
      requestAnimationFrame(() => mergeTrigger.current?.focus());
    }
  }
  return (
    <section className="local-reviews">
      <div className="section-toolbar">
        <h3>
          {selected && !quickMerge ? (
            <button
              className="link-button"
              disabled={busy}
              onClick={() => {
                setSelected(null);
                setConfirmation(null);
                setMerged("");
              }}
            >
              ← Local changes
            </button>
          ) : (
            "Local changes"
          )}
        </h3>
        {selected && !quickMerge && (
          <button
            className="btn btn-default btn-sm"
            disabled={busy}
            onClick={() => {
              setConfirmation(null);
              details.refresh();
            }}
          >
            Refresh local diff
          </button>
        )}
      </div>
      {!selected || quickMerge ? (
        <div className="panel">
          <div className="panel-heading">
            <Icon name="branch" />
            <strong>{issues.length} local reviews</strong>
            <span className="muted">No remote required</span>
          </div>
          {issues.map((issue) => (
            <div className="local-review-row" key={issue.taskId}>
              <button
                className="issue-row"
                onClick={() => {
                  setSelected(issue.taskId);
                  setQuickMerge(false);
                  setConfirmation(null);
                  setError("");
                  setMerged("");
                }}
                disabled={busy || (quickMerge && !merged) || !!issue.localMerge}
              >
                <Icon name="pull" />
                <span className="issue-row-main">
                  <strong>{issue.title}</strong>
                  <small>
                    #{issue.taskId.slice(0, 7)} ·{" "}
                    {issue.localMerge?.state ?? "Ready for local review"}
                  </small>
                </span>
              </button>
              <div className="local-review-actions">
                <span className="label">
                  {issue.localMerge?.state ?? "Local"}
                </span>
                <button
                  className="btn btn-success"
                  aria-label={`Merge locally: ${issue.title}`}
                  disabled={
                    busy || (quickMerge && !merged) || !!issue.localMerge
                  }
                  onClick={(event) => {
                    mergeTrigger.current = event.currentTarget;
                    setSelected(issue.taskId);
                    setQuickMerge(true);
                    setConfirmation(null);
                    setError("");
                    setMerged("");
                  }}
                >
                  Merge
                </button>
              </div>
            </div>
          ))}
          {!issues.length && (
            <div className="panel-body muted">
              Completed issues appear here for local review and merge.
            </div>
          )}
        </div>
      ) : (
        <>
          {!merged && (
            <>
              {details.loading && !details.value && (
                <div className="loading-row" role="status">
                  Preparing local diff…
                </div>
              )}
              {details.value && (
                <>
                  <h2>{details.value.title}</h2>
                  <p>
                    Merge <code>{details.value.branch}</code> into{" "}
                    <code>
                      {details.value.sourceRef.replace("refs/heads/", "")}
                    </code>
                  </p>
                  <p className="muted">
                    Fast-forward only · source{" "}
                    {details.value.sourceHead.slice(0, 7)} · candidate{" "}
                    {details.value.tree.slice(0, 7)}
                  </p>
                  <div className="panel">
                    <div className="panel-heading">Local changes</div>
                    <pre className="diff-view">{details.value.diff}</pre>
                  </div>
                  {!confirmation && !busy && (
                    <button
                      className="btn btn-success"
                      disabled={!!details.error || attempted}
                      onClick={() => setConfirmation(details.value!)}
                    >
                      Merge locally
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
      {quickMerge &&
        !confirmation &&
        !merged &&
        !details.error &&
        !attempted && (
          <div className="loading-row" role="status">
            Preparing local merge…
            <button className="btn btn-default" onClick={cancel}>
              Cancel
            </button>
          </div>
        )}
      {confirmation && !merged && (
        <div className="review-confirm">
          <p>
            Commit the local changes for <strong>{confirmation.title}</strong>{" "}
            on <code>{confirmation.branch}</code> and fast-forward{" "}
            <strong>{confirmation.sourceRef.replace("refs/heads/", "")}</strong>{" "}
            in <code>{confirmation.sourcePath}</code>? No remote, push or GitHub
            approval. This does not run validation; inspect the issue's test
            evidence first.
          </p>
          <div className="button-row">
            <button
              className="btn btn-success"
              disabled={busy || !!details.error || attempted}
              onClick={() => void merge()}
            >
              {busy ? "Merging…" : "Confirm local merge"}
            </button>
            {quickMerge && (
              <button
                className="btn btn-default"
                disabled={busy}
                onClick={() => {
                  setQuickMerge(false);
                  setConfirmation(null);
                }}
              >
                Review changes
              </button>
            )}
            <button
              className="btn btn-default"
              disabled={busy}
              onClick={cancel}
            >
              Cancel
            </button>
          </div>
          {busy && (
            <p role="status">Merging locally. Nothing will be pushed.</p>
          )}
        </div>
      )}
      {merged && (
        <div className="alert alert-success" role="status">
          Merged locally: {merged.slice(0, 12)}. Nothing was pushed.
        </div>
      )}
      {attempted && !busy && !merged && (
        <div className="alert alert-warning" role="alert">
          A local merge was already attempted. Inspect the saved result before
          attempting further Git changes.
          {quickMerge && (
            <button className="btn btn-default" onClick={cancel}>
              Dismiss
            </button>
          )}
        </div>
      )}
      {(details.error || error) && (
        <div className="alert alert-danger" role="alert">
          {error || details.error}
          {quickMerge && (
            <button className="btn btn-default" onClick={cancel}>
              Dismiss
            </button>
          )}
        </div>
      )}
    </section>
  );
}
