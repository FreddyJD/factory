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
  const [confirmation, setConfirmation] = useState<LocalPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [merged, setMerged] = useState("");
  const gate = useRef(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const details = useResource<LocalPreview>(
    selected ? `local:${project.id}:${selected}` : null,
    () => api("local_preview", { projectId: project.id, taskId: selected }),
    5000,
  );
  const fingerprint = details.value ? JSON.stringify(details.value) : "";
  useEffect(() => {
    setConfirmation((current) =>
      current?.taskId === selected &&
      !details.error &&
      JSON.stringify(current) === fingerprint
        ? current
        : null,
    );
  }, [selected, fingerprint, details.error]);
  async function merge() {
    if (!confirmation || !selected || gate.current || details.error) return;
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
      }
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="local-reviews">
      <div className="section-toolbar">
        <h3>
          {selected ? (
            <button
              className="link-button"
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
        {selected && (
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
      {!selected ? (
        <div className="panel">
          <div className="panel-heading">
            <Icon name="branch" />
            <strong>{issues.length} local reviews</strong>
            <span className="muted">No remote required</span>
          </div>
          {issues.map((issue) => (
            <button
              className="issue-row"
              key={issue.taskId}
              onClick={() => {
                setSelected(issue.taskId);
                setError("");
                setMerged("");
              }}
              disabled={!!issue.localMerge}
            >
              <Icon name="pull" />
              <span className="issue-row-main">
                <strong>{issue.title}</strong>
                <small>
                  #{issue.taskId.slice(0, 7)} ·{" "}
                  {issue.localMerge?.state ?? "Ready for local review"}
                </small>
              </span>
              <span className="label">
                {issue.localMerge?.state ?? "Local"}
              </span>
            </button>
          ))}
          {!issues.length && (
            <div className="panel-body muted">
              Completed issues appear here for local review and merge.
            </div>
          )}
        </div>
      ) : (
        <>
          {merged ? (
            <div className="alert alert-success">
              Merged locally: {merged.slice(0, 12)}. Nothing was pushed.
            </div>
          ) : (
            <>
              {details.error && (
                <div role="alert" className="alert alert-warning">
                  {details.error}
                </div>
              )}
              {details.loading && !details.value && (
                <div className="loading-row">Preparing local diff…</div>
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
                  {confirmation ? (
                    <div className="review-confirm">
                      <p>
                        Commit the reviewed files and fast-forward{" "}
                        <strong>
                          {confirmation.sourceRef.replace("refs/heads/", "")}
                        </strong>{" "}
                        in <code>{confirmation.sourcePath}</code>? No remote,
                        push or GitHub approval. This does not run validation;
                        inspect the issue's test evidence first.
                      </p>
                      <div className="button-row">
                        <button
                          className="btn btn-success"
                          disabled={busy || !!details.error}
                          onClick={() => void merge()}
                        >
                          {busy ? "Merging…" : "Confirm local merge"}
                        </button>
                        <button
                          className="btn btn-default"
                          disabled={busy}
                          onClick={() => setConfirmation(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="btn btn-success"
                      disabled={busy || !!details.error}
                      onClick={() => setConfirmation(details.value!)}
                    >
                      Merge locally
                    </button>
                  )}
                </>
              )}
              {error && (
                <div className="alert alert-danger" role="alert">
                  {error}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
