const ROW = 76;
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
