import { useEffect, useRef, useState } from "react";
import {
  api,
  models,
  type ProviderCatalog,
  type Task,
} from "../../../shared/api";
import type { Project } from "../../../shared/types";
import { useResource } from "../../../shared/hooks/useResource";
import { ImageAttachments, useIssueImages } from "./ImageAttachments";
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
  const [body, setBody] = useState("");
  const attachments = useIssueImages();
  const [model, setModel] = useState(
    localStorage.getItem("factory-model") ?? "",
  );
  const [autoPr] = useState(
    () => localStorage.getItem("factory-auto-pr") !== "false",
  );
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
  const imageUnsupported =
    attachments.images.length > 0 &&
    available.find((m) => m.id === selected)?.capabilities?.vision === false;
  const github = useResource<Record<string, unknown>>(
    autoPr ? `github:${project.id}` : null,
    () => api("github_status", { projectId: project.id }),
  );
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (
      locked.current ||
      attachments.reading ||
      imageUnsupported ||
      (autoPr && (!github.value || !!github.error || github.loading)) ||
      (!body.trim() && !attachments.images.length) ||
      !selected
    )
      return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      localStorage.setItem("factory-model", selected);
      const task = await api<Task>("issue_create", {
        projectId: project.id,
        body,
        images: attachments.images,
        model: selected,
        nativeEdits: true,
        autoPr,
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
            <div className="editor-tabs">
              <strong>Description</strong>
            </div>
            <textarea
              autoFocus
              className="form-control issue-description"
              aria-label="Description"
              placeholder="Describe the change"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onPaste={busy ? undefined : attachments.paste}
              disabled={busy}
              rows={10}
            />
            <ImageAttachments attachments={attachments} disabled={busy} />
            {imageUnsupported && (
              <p role="alert" className="text-danger">
                This model does not support images. Choose an image-capable
                model.
              </p>
            )}
            <p className="muted image-help">
              The model will choose a title from your description.
            </p>
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
        {(catalog.error ||
          !!catalog.value?.errors?.length ||
          !available.length) && (
          <div className="alert alert-warning">
            {catalog.error ??
              (catalog.value?.errors?.join("; ") ||
                (catalog.loading
                  ? "Loading models…"
                  : "Connect GitHub or an OpenAI-compatible endpoint in Settings."))}{" "}
            <button className="link-button" type="button" onClick={onSettings}>
              Settings
            </button>
          </div>
        )}
        <div className="issue-options">
          <p className="muted">
            All tool calls run automatically without approval prompts, including
            file edits, shell commands and connected external tools. Commands
            and external tools run with your account's permissions.
          </p>
          {autoPr && github.loading && (
            <p className="muted">Checking GitHub access…</p>
          )}
          {autoPr && github.error && (
            <div className="alert alert-warning">
              {github.error} Disable automatic draft pull requests in{" "}
              <button
                className="link-button"
                type="button"
                onClick={onSettings}
              >
                Settings
              </button>{" "}
              to run without GitHub.
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
              attachments.reading ||
              imageUnsupported ||
              (!body.trim() && !attachments.images.length) ||
              (autoPr && (!github.value || !!github.error || github.loading))
            }
          >
            {busy ? "Creating issue…" : "Create issue and run"}
          </button>
        </div>
      </form>
    </section>
  );
}
