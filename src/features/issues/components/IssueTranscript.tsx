import { useState } from "react";
import type { TranscriptLine } from "../../../shared/api";
import { ImageGallery } from "./ImageAttachments";
import { Markdown } from "../../../shared/components/Markdown";

function ToolCall({
  tool,
}: {
  tool: Extract<TranscriptLine, { kind: "tool" }>["tool"];
}) {
  const [expanded, setExpanded] = useState(false);
  const input =
    tool.input && typeof tool.input === "object"
      ? (tool.input as Record<string, unknown>)
      : {};
  const summary =
    input.filePath ??
    input.command ??
    input.pattern ??
    input.url ??
    (tool.title !== tool.name ? tool.title : "");
  return (
    <details
      className="tool-call"
      data-status={tool.status}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <code>{tool.name}</code>
        <span className="tool-call-summary">
          {typeof summary === "string" ? summary : ""}
        </span>
        <span className="tool-call-status">{tool.status}</span>
      </summary>
      {expanded && (
        <div className="tool-call-body">
          <h4>Input</h4>
          <pre tabIndex={0}>
            {tool.input === undefined
              ? "Input was not recorded."
              : JSON.stringify(tool.input, null, 2)}
          </pre>
          <h4>{tool.error != null ? "Error" : "Output"}</h4>
          <pre
            tabIndex={0}
            className={tool.error != null ? "text-danger" : undefined}
          >
            {tool.error ??
              tool.output ??
              (tool.status === "running" || tool.status === "pending"
                ? "Waiting for tool result..."
                : "Output was not recorded.")}
            {tool.output === "" && tool.error == null ? "(empty output)" : ""}
          </pre>
        </div>
      )}
    </details>
  );
}

export function IssueTranscript({ lines }: { lines: TranscriptLine[] }) {
  const [selectable, setSelectable] = useState(false);
  const comments: {
    id: string;
    author: "user" | "assistant";
    lines: TranscriptLine[];
  }[] = [];
  for (const line of lines) {
    const author = line.kind === "user" ? "user" : "assistant";
    const previous = comments.at(-1);
    if (
      previous?.author === author &&
      (author === "assistant" ||
        (line.messageId !== undefined &&
          previous.lines[0].messageId === line.messageId))
    ) {
      previous.lines.push(line);
    } else {
      comments.push({ id: line.id, author, lines: [line] });
    }
  }
  return (
    <>
      <div className="transcript-header">
        <strong>Conversation</strong>
        <button
          className="link-button"
          onClick={() => setSelectable((value) => !value)}
        >
          {selectable ? "Hide text view" : "Text view"}
        </button>
      </div>
      <div
        className="issue-transcript"
        role="region"
        aria-label="Issue conversation"
      >
        {lines.length === 0 && (
          <p className="muted">
            The conversation will appear here when the agent starts.
          </p>
        )}
        {comments.map((comment) => (
          <article
            key={comment.id}
            className={"panel comment-card " + comment.author}
            aria-label={
              comment.author === "user" ? "Your comment" : "Factory comment"
            }
          >
            <div className="panel-heading">
              <span className="avatar avatar-small" aria-hidden="true">
                {comment.author === "user" ? "Y" : "F"}
              </span>
              <strong>{comment.author === "user" ? "You" : "Factory"}</strong>
            </div>
            <div className="panel-body markdown-body">
              {comment.lines.map((line) =>
                line.kind === "tool" ? (
                  <ToolCall key={line.id} tool={line.tool} />
                ) : (
                  <div key={line.id} className={"transcript-message " + line.kind}>
                    {line.kind === "error" && <strong>Error</strong>}
                    {line.image ? (
                      <ImageGallery images={[line.image]} />
                    ) : (
                      <Markdown text={line.text} />
                    )}
                  </div>
                ),
              )}
            </div>
          </article>
        ))}
      </div>
      {selectable && (
        <textarea
          readOnly
          aria-label="Conversation text"
          className="form-control conversation-text"
          value={lines
            .map((line) => line.kind.toUpperCase() + "\n" + line.text)
            .join("\n\n")}
        />
      )}
    </>
  );
}
