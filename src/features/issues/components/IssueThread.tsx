import { useRef, useState } from "react";
import { api, transcript, type Task } from "../../../shared/api";
import type { Issue } from "../../../shared/types";
import { statusLabel } from "../../../shared/types";
import { Markdown } from "../../../shared/components/Markdown";
import { useIssue } from "../hooks/useIssue";
import { IssueTranscript } from "./IssueTranscript";
import { QuestionForm } from "./QuestionForm";
import { Icon } from "../../../shared/components/Icon";
import {
  ImageAttachments,
  ImageGallery,
  useIssueImages,
} from "./ImageAttachments";
export function IssueThread({
  task,
  issue,
  onBack,
  onCode,
  onChange,
  onLocalReview,
  github,
}: {
  task: Task;
  issue?: Issue;
  onBack: () => void;
  onCode: (path: string) => void;
  onChange: () => void;
  onLocalReview: () => void;
  github: boolean | undefined;
}) {
  const session = useIssue(task.id);
  const [comment, setComment] = useState("");
  const attachments = useIssueImages();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const locked = useRef(false);
  const snapshot = session.value;
  const current = snapshot?.task ?? task;
  const removed = ["removed", "removing", "removal-failed"].includes(
    current.status,
  );
  const lines = transcript(snapshot ?? null);
  const working =
    snapshot?.status.type === "busy" ||
    ["working", "needs-you", "publishing"].includes(current.status);
  async function action(label: string, operation: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(label);
    setError("");
    try {
      await operation();
      session.refresh();
      onChange();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy("");
      locked.current = false;
    }
  }
  return (
    <section className="issue-thread">
      <button className="link-button back-link" onClick={onBack}>
        ← Issues
      </button>
      <div className="issue-title">
        <h1>
          {current.title}
          <span> #{task.id.slice(0, 7)}</span>
        </h1>
        <div className="issue-subtitle">
          <span className={`status-label ${current.status}`}>
            <Icon name="issue" />
            {statusLabel(current.status)}
          </span>
          <span className="muted">
            {issue
              ? `opened ${new Date(issue.createdAt * 1000).toLocaleString()}`
              : "Retained agent session"}{" "}
            · {task.model}
          </span>
        </div>
      </div>
      <div className="thread-layout">
        <div>
          <article className="panel comment-card">
            <div className="panel-heading">
              <span className="avatar avatar-small">Y</span>
              <strong>You</strong>
              <span className="muted">opened this issue</span>
            </div>
            <div className="panel-body markdown-body">
              <Markdown text={issue ? issue.body : task.title} />
              <ImageGallery
                images={
                  snapshot?.messages
                    .find((message) => message.info.role === "user")
                    ?.parts.flatMap((part) =>
                      part.type === "image" && part.dataUrl
                        ? [
                            {
                              name: part.name ?? "Attached image",
                              dataUrl: part.dataUrl,
                            },
                          ]
                        : [],
                    ) ?? []
                }
              />
            </div>
          </article>
          {session.error && (
            <div className="alert alert-danger">{session.error}</div>
          )}
          {snapshot?.error && (
            <div className="alert alert-danger">{snapshot.error}</div>
          )}
          <div className="panel conversation-panel">
            <IssueTranscript lines={lines} />
          </div>
          {snapshot?.questions.map((request) => (
            <QuestionForm
              key={request.id}
              request={request}
              disabled={!!busy}
              answer={(answers) =>
                void action("Answering", async () => {
                  await api("question", {
                    taskId: task.id,
                    requestId: request.id,
                    answers,
                  });
                })
              }
            />
          ))}
          {diff !== null && (
            <div className="panel">
              <div className="panel-heading">
                Worktree changes
                <button className="link-button" onClick={() => setDiff(null)}>
                  Close
                </button>
              </div>
              <pre className="diff-view">{diff || "No tracked changes."}</pre>
            </div>
          )}
          {github && preview && (
            <div className="panel">
              <div className="panel-heading">Create draft pull request</div>
              <div className="panel-body">
                <p>
                  Commit and push <code>{String(preview.branch)}</code> to{" "}
                  <strong>{String(preview.repository)}</strong>, targeting{" "}
                  <strong>{String(preview.base)}</strong>, as{" "}
                  <strong>{String(preview.account)}</strong>.
                </p>
                <pre className="diff-view">
                  {String(preview.diff)}
                  {JSON.stringify(preview.added, null, 2)}
                </pre>
                <div className="button-row">
                  <button
                    className="btn btn-success"
                    disabled={!!busy}
                    onClick={() =>
                      void action("Publishing draft PR", async () => {
                        await api("pr_publish", { taskId: task.id, preview });
                        setPreview(null);
                      })
                    }
                  >
                    Commit, push and create draft PR
                  </button>
                  <button
                    className="btn btn-default"
                    onClick={() => setPreview(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}
          {error && (
            <div className="alert alert-danger" role="alert">
              {error}
            </div>
          )}
          <form
            className="panel comment-form"
            onSubmit={(event) => {
              event.preventDefault();
              const text = comment;
              if (
                !working &&
                !removed &&
                !attachments.reading &&
                (text.trim() || attachments.images.length)
              )
                void action("Sending", async () => {
                  await api("prompt", {
                    taskId: task.id,
                    text,
                    images: attachments.images,
                  });
                  setComment((current) => (current === text ? "" : current));
                  attachments.clear();
                });
            }}
          >
            <div className="editor-tabs">
              <strong>Write</strong>
            </div>
            <div className="panel-body">
              <textarea
                className="form-control"
                aria-label="Issue comment"
                placeholder="Leave a comment"
                rows={4}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                onPaste={busy || removed ? undefined : attachments.paste}
                disabled={!!busy || removed}
              />
              <ImageAttachments
                attachments={attachments}
                disabled={!!busy || removed}
              />
              <div className="form-actions">
                <button
                  className="btn btn-success"
                  disabled={
                    !!busy ||
                    working ||
                    removed ||
                    attachments.reading ||
                    (!comment.trim() && !attachments.images.length)
                  }
                >
                  {busy || "Comment and run"}
                </button>
              </div>
            </div>
          </form>
        </div>
        <aside className="issue-details">
          <h4>Worktree</h4>
          {!removed &&
            task.checkouts.map((checkout) => (
              <button
                className="link-button worktree-link"
                key={checkout.path}
                onClick={() => onCode(checkout.path)}
              >
                <Icon name="branch" />
                {checkout.branch}
              </button>
            ))}
          <hr />
          <h4>Run</h4>
          <p>{statusLabel(current.status)}</p>
          <div className="button-stack">
            <button
              className="btn btn-default btn-sm"
              disabled={!!busy || !working}
              onClick={() =>
                void action("Stopping", async () => {
                  await api("cancel", { taskId: task.id });
                })
              }
            >
              Stop run
            </button>
            <button
              className="btn btn-default btn-sm"
              disabled={!!busy || removed}
              onClick={() =>
                void action("Closing", async () => {
                  await api("close", { taskId: task.id });
                })
              }
            >
              Release worker
            </button>
            <button
              className="btn btn-default btn-sm"
              disabled={!!busy || removed}
              onClick={() =>
                void action("Loading changes", async () => {
                  setDiff(await api<string>("diff", { taskId: task.id }));
                })
              }
            >
              View changes
            </button>
            {!removed && (
              <button
                className="btn btn-default btn-sm"
                disabled={!!busy || working}
                onClick={() => setConfirmRemoval(true)}
              >
                Remove worktrees
              </button>
            )}
          </div>
          {confirmRemoval && !removed && (
            <div className="alert alert-warning">
              <p>
                Remove this task's clean worktrees? Branches and conversation
                history stay. Modified, untracked, ignored or locked files block
                removal. The idle worker will be released.
              </p>
              {task.checkouts.map((checkout) => (
                <p key={checkout.path}>
                  <code>{checkout.path}</code>
                </p>
              ))}
              <button
                className="btn btn-danger btn-sm"
                disabled={!!busy || working}
                onClick={() =>
                  void action("Removing worktrees", async () => {
                    await api("close", { taskId: task.id });
                    await api("worktrees_remove", {
                      taskId: task.id,
                      confirm: true,
                    });
                    setConfirmRemoval(false);
                  })
                }
              >
                Confirm removal
              </button>
              <button
                className="btn btn-default btn-sm"
                disabled={!!busy}
                onClick={() => setConfirmRemoval(false)}
              >
                Cancel removal
              </button>
            </div>
          )}
          {removed && (
            <p className="muted">
              {current.status === "removed"
                ? "Worktrees removed. Branches and history retained."
                : "Cleanup requires inspection. Worktree execution is disabled."}
            </p>
          )}
          {github === false && (
            <>
              <hr />
              <h4>Local review</h4>
              <button
                className="btn btn-default btn-sm"
                disabled={
                  !!busy || working || removed || issue?.outcome !== "completed"
                }
                onClick={onLocalReview}
              >
                Review and merge locally
              </button>
            </>
          )}
          {github === true && (
            <>
              <hr />
              <h4>Pull request</h4>
              {issue?.publication?.url ? (
                <a
                  href={issue.publication.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  #{issue.publication.number} Draft pull request
                </a>
              ) : (
                <button
                  className="btn btn-default btn-sm"
                  disabled={
                    !!busy ||
                    working ||
                    removed ||
                    issue?.outcome !== "completed" ||
                    !!issue?.publication
                  }
                  onClick={() =>
                    void action("Preparing PR", async () =>
                      setPreview(await api("pr_preview", { taskId: task.id })),
                    )
                  }
                >
                  Create draft PR
                </button>
              )}
              {issue?.publication?.state && (
                <p className="muted">{issue.publication.state}</p>
              )}
              {issue?.publication?.error && (
                <p className="text-danger">{issue.publication.error}</p>
              )}
            </>
          )}
          <hr />
          <h4>Execution</h4>
          <p className="muted">Native Rust · All tool calls auto-approved</p>
        </aside>
      </div>
    </section>
  );
}
