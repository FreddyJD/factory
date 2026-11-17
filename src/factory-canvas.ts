import type { Task, TranscriptLine } from "./api";

export interface CanvasState {
  tasks: Task[];
  selected: string | null;
  lines: TranscriptLine[];
  tab: "activity" | "diff";
  diff: string;
}
const ROW = 76;
const LINE = 22;
const colors = {
  ink: "#26332a",
  muted: "#7b8277",
  line: "#e0e3da",
  paper: "#fafbf7",
  accent: "#335b3a",
};

export function visibleRange(
  scroll: number,
  height: number,
  count: number,
  row = ROW,
) {
  const first = Math.max(0, Math.floor(scroll / row));
  return {
    first,
    last: Math.min(count, Math.ceil((scroll + height) / row) + 1),
  };
}

export function wrapText(
  text: string,
  width: number,
  measure: (text: string) => number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/(\s+)/)) {
      if (measure(line + word) <= width) {
        line += word;
        continue;
      }
      if (line) {
        lines.push(line.trimEnd());
        line = "";
      }
      if (measure(word) <= width) {
        line = word.trimStart();
        continue;
      }
      for (const char of word) {
        if (line && measure(line + char) > width) {
          lines.push(line);
          line = "";
        }
        line += char;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export class FactoryCanvas {
  private ctx: CanvasRenderingContext2D;
  private observer: ResizeObserver;
  private state: CanvasState = {
    tasks: [],
    selected: null,
    lines: [],
    tab: "activity",
    diff: "",
  };
  private listScroll = 0;
  private detailScroll = 0;
  private detailHeight = 0;
  private width = 0;
  private height = 0;
  private frame = 0;
  private wrapped: { text: string; kind: string; heading: boolean }[] = [];
  private wrapWidth = 0;
  private oldLines: TranscriptLine[] = [];
  private oldDiff = "";
  private oldTab = "activity";

  constructor(
    private canvas: HTMLCanvasElement,
    private select: (id: string) => void,
  ) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D is not available");
    this.ctx = ctx;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    canvas.addEventListener("wheel", this.wheel, { passive: false });
    canvas.addEventListener("pointerdown", this.pointer);
    canvas.addEventListener("keydown", this.keyboard);
    this.resize();
  }

  update(state: CanvasState) {
    if (state.selected !== this.state.selected || state.tab !== this.state.tab)
      this.detailScroll = 0;
    const changed =
      state.selected !== this.state.selected || state.tab !== this.state.tab;
    const wasBottom =
      !changed &&
      this.detailScroll >=
        Math.max(0, this.detailHeight - this.height + 70) - 48;
    this.state = state;
    this.layout();
    if (wasBottom)
      this.detailScroll = Math.max(0, this.detailHeight - this.height + 70);
    this.clamp();
    this.invalidate();
  }

  private get split() {
    return this.width < 700
      ? Math.min(210, this.width * 0.38)
      : Math.min(340, this.width * 0.34);
  }
  private resize() {
    const box = this.canvas.getBoundingClientRect();
    this.width = box.width;
    this.height = box.height;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(box.width * dpr);
    this.canvas.height = Math.round(box.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.layout();
    this.clamp();
    this.invalidate();
  }

  private clamp() {
    this.listScroll = Math.max(
      0,
      Math.min(
        this.listScroll,
        this.state.tasks.length * ROW - this.height + 60,
      ),
    );
    this.detailScroll = Math.max(
      0,
      Math.min(this.detailScroll, this.detailHeight - this.height + 70),
    );
  }

  private layout() {
    const width = Math.max(30, this.width - this.split - 64);
    if (
      this.wrapWidth === width &&
      this.oldLines === this.state.lines &&
      this.oldDiff === this.state.diff &&
      this.oldTab === this.state.tab
    )
      return;
    this.wrapWidth = width;
    this.oldLines = this.state.lines;
    this.oldDiff = this.state.diff;
    this.oldTab = this.state.tab;
    const ctx = this.ctx;
    ctx.font =
      this.state.tab === "diff"
        ? '12px "SFMono-Regular", Consolas, monospace'
        : '14px -apple-system, "Segoe UI", sans-serif';
    const blocks =
      this.state.tab === "diff"
        ? [
            {
              kind: "tool",
              text:
                this.state.diff ||
                "No diff loaded. Refresh to inspect the worktrees.",
            },
          ]
        : this.state.lines;
    this.wrapped = [];
    for (const block of blocks) {
      this.wrapped.push({
        text:
          block.kind === "user"
            ? "YOU"
            : block.kind === "tool"
              ? "TOOL ACTIVITY"
              : block.kind === "error"
                ? "NEEDS ATTENTION"
                : "FACTORY",
        kind: block.kind,
        heading: true,
      });
      for (const text of wrapText(
        block.text,
        width,
        (text) => ctx.measureText(text).width,
      ))
        this.wrapped.push({ text, kind: block.kind, heading: false });
      this.wrapped.push({ text: "", kind: block.kind, heading: false });
    }
    this.detailHeight = this.wrapped.length * LINE + 30;
  }

  private invalidate() {
    if (!this.frame)
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.draw();
      });
  }
  private text(
    text: string,
    x: number,
    y: number,
    color = colors.ink,
    font = '13px -apple-system, "Segoe UI", sans-serif',
  ) {
    this.ctx.fillStyle = color;
    this.ctx.font = font;
    this.ctx.fillText(text, x, y);
  }
  private truncate(text: string, width: number) {
    text = text.slice(0, 240);
    if (this.ctx.measureText(text).width <= width) return text;
    let low = 0,
      high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.ctx.measureText(text.slice(0, mid) + "...").width <= width)
        low = mid;
      else high = mid - 1;
    }
    return text.slice(0, low) + "...";
  }

  private draw() {
    const ctx = this.ctx;
    const split = this.split;
    ctx.fillStyle = colors.paper;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.fillStyle = "#f1f3ec";
    ctx.fillRect(0, 0, split, this.height);
    ctx.strokeStyle = colors.line;
    ctx.beginPath();
    ctx.moveTo(split, 0);
    ctx.lineTo(split, this.height);
    ctx.stroke();
    this.text(
      "WORK / " + this.state.tasks.length.toString().padStart(2, "0"),
      22,
      30,
      colors.muted,
      "10px Consolas, monospace",
    );
    this.text(
      this.state.tab === "diff" ? "CHANGE REVIEW" : "EXECUTION JOURNAL",
      split + 28,
      30,
      colors.muted,
      "10px Consolas, monospace",
    );
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 48, split, this.height - 48);
    ctx.clip();
    const range = visibleRange(
      this.listScroll,
      this.height - 48,
      this.state.tasks.length,
    );
    for (let index = range.first; index < range.last; index++) {
      const task = this.state.tasks[index];
      const y = 48 + index * ROW - this.listScroll;
      if (task.id === this.state.selected) {
        ctx.fillStyle = "#e2e8da";
        ctx.fillRect(8, y + 3, split - 16, ROW - 6);
        ctx.fillStyle = colors.accent;
        ctx.fillRect(8, y + 3, 3, ROW - 6);
      }
      ctx.font = '13px -apple-system, "Segoe UI", sans-serif';
      this.text(
        this.truncate(task.title.replace(/\s+/g, " "), split - 48),
        22,
        y + 29,
      );
      const status = task.status.toUpperCase().replaceAll("-", " ");
      this.text(
        status,
        22,
        y + 51,
        task.status === "needs-you" ? "#9b682d" : colors.muted,
        "10px Consolas, monospace",
      );
    }
    if (!this.state.tasks.length) {
      this.text("No work in progress.", 22, 90, colors.muted);
      this.text(
        "Start with one clear goal.",
        22,
        113,
        colors.muted,
        "11px -apple-system, sans-serif",
      );
    }
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(split + 1, 48, this.width - split - 1, this.height - 48);
    ctx.clip();
    const detail = visibleRange(
      this.detailScroll,
      this.height - 60,
      this.wrapped.length,
      LINE,
    );
    for (let index = detail.first; index < detail.last; index++) {
      const line = this.wrapped[index];
      this.text(
        line.text,
        split + 28,
        75 + index * LINE - this.detailScroll,
        line.kind === "error"
          ? "#9b432f"
          : line.heading
            ? colors.muted
            : line.kind === "tool"
              ? "#65725d"
              : colors.ink,
        line.heading
          ? "10px Consolas, monospace"
          : this.state.tab === "diff"
            ? '12px "SFMono-Regular", Consolas, monospace'
            : '14px -apple-system, "Segoe UI", sans-serif',
      );
    }
    if (!this.wrapped.length) {
      this.text(
        this.state.selected
          ? "The journal will appear here."
          : "Make room for your next big idea.",
        split + 28,
        95,
        colors.ink,
        "21px Georgia, serif",
      );
      this.text(
        "Isolated changes. Visible evidence. You stay in control.",
        split + 28,
        126,
        colors.muted,
        "12px -apple-system, sans-serif",
      );
    }
    ctx.restore();
  }

  private wheel = (event: WheelEvent) => {
    event.preventDefault();
    const x = event.clientX - this.canvas.getBoundingClientRect().left;
    if (x < this.split)
      this.listScroll = Math.max(
        0,
        Math.min(
          this.state.tasks.length * ROW - this.height + 60,
          this.listScroll + event.deltaY,
        ),
      );
    else
      this.detailScroll = Math.max(
        0,
        Math.min(
          this.detailHeight - this.height + 70,
          this.detailScroll + event.deltaY,
        ),
      );
    this.invalidate();
  };
  private pointer = (event: PointerEvent) => {
    this.canvas.focus();
    const box = this.canvas.getBoundingClientRect();
    if (event.clientX - box.left >= this.split || event.clientY - box.top < 48)
      return;
    const index = Math.floor(
      (event.clientY - box.top - 48 + this.listScroll) / ROW,
    );
    if (this.state.tasks[index]) this.select(this.state.tasks[index].id);
  };
  private keyboard = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const current = this.state.tasks.findIndex(
        (t) => t.id === this.state.selected,
      );
      const index = Math.max(
        0,
        Math.min(
          this.state.tasks.length - 1,
          current + (event.key === "ArrowDown" ? 1 : -1),
        ),
      );
      if (this.state.tasks[index]) {
        this.select(this.state.tasks[index].id);
        this.listScroll = Math.max(0, index * ROW - this.height / 2);
        this.invalidate();
      }
    }
    if (event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault();
      this.detailScroll = Math.max(
        0,
        Math.min(
          this.detailHeight - this.height + 70,
          this.detailScroll +
            (event.key === "PageDown" ? 1 : -1) * this.height * 0.8,
        ),
      );
      this.invalidate();
    }
  };
  destroy() {
    this.observer.disconnect();
    cancelAnimationFrame(this.frame);
    this.canvas.removeEventListener("wheel", this.wheel);
    this.canvas.removeEventListener("pointerdown", this.pointer);
    this.canvas.removeEventListener("keydown", this.keyboard);
  }
}
