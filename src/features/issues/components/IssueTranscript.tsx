import { useEffect, useRef, useState } from "react";
import type { TranscriptLine } from "../../../shared/api";
import { wrapText, visibleRange } from "../transcript-canvas";
export function IssueTranscript({ lines }: { lines: TranscriptLine[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const current = useRef(lines);
  current.current = lines;
  const redraw = useRef(() => {});
  const [selectable, setSelectable] = useState(false);
  useEffect(() => {
    const element = canvas.current;
    const viewport = container.current;
    if (!element || !viewport) return;
    const ctx = element.getContext("2d");
    if (!ctx) return;
    let frame = 0;
    let total = 0;
    let previousLines: TranscriptLine[] = [];
    let rows: { text: string; heading: boolean; kind: string }[] = [];
    let previousWidth = 0;
    const content = element.parentElement!;
    const fontFamily = getComputedStyle(viewport).fontFamily;
    function draw() {
      frame = 0;
      const width = viewport!.clientWidth;
      const height = viewport!.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (previousWidth !== width || previousLines !== current.current) {
        rows = [];
        previousWidth = width;
        ctx!.font = `13px ${fontFamily}`;
        for (const line of current.current) {
          rows.push({
            text:
              line.kind === "user"
                ? "You commented"
                : line.kind === "assistant"
                  ? "Factory"
                  : line.kind === "error"
                    ? "Error"
                    : "Tool activity",
            heading: true,
            kind: line.kind,
          });
          for (const text of wrapText(
            line.text,
            Math.max(100, width - 48),
            (text) => ctx!.measureText(text).width,
          ))
            rows.push({ text, heading: false, kind: line.kind });
          rows.push({ text: "", heading: false, kind: line.kind });
        }
      }
      const bottom = viewport!.scrollTop + height >= total - 40;
      total = Math.max(height, rows.length * 22 + 28);
      content.style.height = `${total}px`;
      if (bottom && current.current !== previousLines)
        viewport!.scrollTop = total;
      previousLines = current.current;
      const scroll = viewport!.scrollTop;
      element!.style.transform = `translateY(${scroll}px)`;
      element!.style.width = `${width}px`;
      element!.style.height = `${height}px`;
      element!.width = width * dpr;
      element!.height = height * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.fillStyle = "#fff";
      ctx!.fillRect(0, 0, width, height);
      const range = visibleRange(scroll, height, rows.length, 22);
      for (let i = range.first; i < range.last; i++) {
        const row = rows[i];
        ctx!.font = row.heading
          ? `600 11px ${fontFamily}`
          : `13px ${fontFamily}`;
        ctx!.fillStyle =
          row.kind === "error"
            ? "#a94442"
            : row.heading
              ? "#57606a"
              : "#24292f";
        ctx!.fillText(row.text, 24, 24 + i * 22 - scroll);
      }
    }
    const request = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const fontsLoaded = () => {
      // Rewrap using the loaded font's metrics, not the temporary fallback.
      previousWidth = 0;
      request();
    };
    document.fonts.addEventListener("loadingdone", fontsLoaded);
    redraw.current = request;
    const observer = new ResizeObserver(request);
    observer.observe(viewport);
    viewport.addEventListener("scroll", request);
    request();
    return () => {
      document.fonts.removeEventListener("loadingdone", fontsLoaded);
      observer.disconnect();
      viewport.removeEventListener("scroll", request);
      cancelAnimationFrame(frame);
      redraw.current = () => {};
    };
  }, []);
  useEffect(() => redraw.current(), [lines]);
  return (
    <>
      <div className="transcript-header">
        <strong>Conversation</strong>
        <button
          className="link-button"
          onClick={() => setSelectable((v) => !v)}
        >
          {selectable ? "Canvas view" : "Text view"}
        </button>
      </div>
      <div
        ref={container}
        className="issue-canvas-viewport"
        tabIndex={0}
        role="region"
        aria-label="Issue conversation"
      >
        <div>
          <canvas ref={canvas} aria-hidden="true" />
        </div>
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {lines.length} conversation entries. Use Text view for the full
        selectable transcript.
      </div>
      {selectable && (
        <textarea
          readOnly
          aria-label="Conversation text"
          className="form-control conversation-text"
          value={lines
            .map((l) => `${l.kind.toUpperCase()}\n${l.text}`)
            .join("\n\n")}
        />
      )}
    </>
  );
}
