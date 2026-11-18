import { useLayoutEffect, useRef, useState } from "react";
import type { TranscriptLine } from "../../../shared/api";
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
  const container = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [selectable, setSelectable] = useState(false);
  useLayoutEffect(() => {
    if (follow.current && container.current)
      container.current.scrollTop = container.current.scrollHeight;
  }, [lines]);
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
        ref={container}
        className="issue-transcript"
        tabIndex={0}
        role="region"
        aria-label="Issue conversation"
        onClickCapture={(event) => {
          if ((event.target as HTMLElement).closest("summary"))
            follow.current = false;
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          follow.current =
            element.scrollTop + element.clientHeight >=
            element.scrollHeight - 40;
        }}
      >
        {lines.length === 0 && (
          <p className="muted">
            The conversation will appear here when the agent starts.
          </p>
        )}
        {lines.map((line) =>
          line.kind === "tool" ? (
            <ToolCall key={line.id} tool={line.tool} />
          ) : (
            <article
              key={line.id}
              className={"transcript-message " + line.kind}
            >
              <h4>
                {line.kind === "user"
                  ? "You commented"
                  : line.kind === "error"
                    ? "Error"
                    : "Factory"}
              </h4>
              <Markdown text={line.text} />
            </article>
          ),
        )}
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
