import { useEffect, useRef, useState } from "react";
import {
  api,
  models,
  type ProviderCatalog,
  type Task,
} from "../../../shared/api";
import type { Project } from "../../../shared/types";
import { useResource } from "../../../shared/hooks/useResource";
export function NewIssue({
  project,
  onCreated,
  onCancel,
  onSettings,
}: {
  project: Project;
  onCreated: (task: Task) => void;
  onCancel: () => void;
  onSettings: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [model, setModel] = useState(
    localStorage.getItem("factory-model") ?? "",
  );
  const [edits, setEdits] = useState(true);
  const [autoPr, setAutoPr] = useState(false);
  const [validation, setValidation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const catalog = useResource<ProviderCatalog>(`models:${project.id}`, () =>
    api("models"),
  );
  const available = catalog.value ? models(catalog.value) : [];
  const selected = available.some((m) => m.id === model)
    ? model
    : (available[0]?.id ?? "");
  const github = useResource<Record<string, unknown>>(
    autoPr ? `github:${project.id}` : null,
    () => api("github_status", { projectId: project.id }),
  );
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (locked.current || !title.trim() || !selected) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      localStorage.setItem("factory-model", selected);
      const task = await api<Task>("issue_create", {
        projectId: project.id,
        title: title.trim(),
        body,
        model: selected,
        nativeEdits: edits,
        autoPr,
        validation,
        githubTarget: github.value ?? null,
      });
      if (alive.current) onCreated(task);
    } catch (error) {
      setError(String(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="new-issue">
      <div className="section-toolbar">
        <h2>New issue</h2>
        <button className="btn btn-default" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <div className="panel">
          <div className="panel-body">
            <label>
              Title
              <input
                autoFocus
                className="form-control issue-title-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                required
                placeholder="Title"
              />
            </label>
            <div className="editor-tabs">
              <strong>Write</strong>
            </div>
            <textarea
              className="form-control issue-description"
              aria-label="Description"
              placeholder="Describe the change"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
            />
          </div>
          <div className="panel-footer">
            <label className="inline-label">
              Model
              <select
                aria-label="Issue model"
                value={selected}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="">Select model</option>
                {available.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        {(catalog.error || !available.length) && (
          <div className="alert alert-warning">
            {catalog.error ??
              (catalog.loading
                ? "Loading models…"
                : "Connect Copilot to run this issue.")}{" "}
            <button className="link-button" type="button" onClick={onSettings}>
              Settings
            </button>
          </div>
        )}
        <div className="issue-options">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={edits}
              onChange={(e) => setEdits(e.target.checked)}
            />
            Allow native file edits in this issue's worktree
          </label>
          <p className="muted">
            Shell commands and external tools still require approval.
          </p>
          <label>
            Validation command
            <input
              className="form-control"
              value={validation}
              onChange={(e) => setValidation(e.target.value)}
              placeholder="npm test"
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={autoPr}
              onChange={(e) => setAutoPr(e.target.checked)}
            />
            Automatically create a draft pull request after validation
          </label>
          {autoPr && (
            <div className="alert alert-warning">
              {github.error ??
                (github.loading
                  ? "Checking GitHub access…"
                  : `Authorize commit and push of this issue's assigned branch to ${github.value?.repository ?? ""}, targeting ${github.value?.defaultBranch ?? ""}, and one draft PR as ${github.value?.account ?? ""}. The validation command above runs with your account's permissions. No force-push or merge.`)}
            </div>
          )}
        </div>
        {error && (
          <div role="alert" className="alert alert-danger">
            {error}
          </div>
        )}
        <div className="form-actions">
          <button
            className="btn btn-success"
            disabled={
              busy ||
              !selected ||
              !title.trim() ||
              (autoPr &&
                (!validation.trim() || !github.value || !!github.error))
            }
          >
            {busy ? "Creating issue…" : "Create issue and run"}
          </button>
        </div>
      </form>
    </section>
  );
}
