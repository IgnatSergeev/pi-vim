/**
 * Visual-mode selection painting.
 *
 * Pi's editor lays the prompt out into wrapped "layout lines" and only then
 * draws the block cursor into them, so a selection cannot be painted by
 * post-processing the finished frame: the escape sequences would move the
 * cursor's string index. Instead pi-vim decorates the layout lines themselves
 * (see `installVisualHighlight` in index.ts) and fixes up `cursorPos` for the
 * bytes it inserted.
 *
 * Two invariants keep the host renderer happy:
 *   - each selected grapheme carries its own open/close pair, so the cursor's
 *     `\x1b[0m` reset never swallows the rest of the selection;
 *   - the grapheme under the cursor is left untouched and `cursorPos` points at
 *     its first byte, so the host still finds a real grapheme at that index.
 */

import { getLineGraphemes } from "./motions.js";

export type LayoutLine = {
  text: string;
  hasCursor: boolean;
  cursorPos?: number;
};

/** Column span `[start, end)` of a logical line that is selected. */
export type LineSelection = { start: number; end: number };

const HIGHTLIHT_SELECTION_OPEN = `\x1b[48;2;45;63;118m`;
const HIGHTLIHT_SELECTION_CLOSE = `\x1b[0m`;

/**
 * Paint `selection` into one layout line.
 * `offset` is the column of the line's first character within its logical line.
 * Returns the decorated line, or the original when selection doesn't intersect.
 */
export function highlightLayoutLine(
  layoutLine: LayoutLine,
  offset: number,
  selection: LineSelection,
): LayoutLine {
  const text = layoutLine.text;
  const start = Math.max(0, selection.start - offset);
  const end = Math.min(text.length, selection.end - offset);
  if (start >= end || start >= text.length) return layoutLine;

  const cursorPos = layoutLine.hasCursor ? layoutLine.cursorPos : undefined;
  let out = "";
  let nextCursorPos = cursorPos;
  let index = 0;

  for (const grapheme of getLineGraphemes(text)) {
    if (grapheme.start >= index) {
      // Copy anything between the previous grapheme and this one (never happens
      // for contiguous segmentation, but keeps the walk total).
      out += text.slice(index, grapheme.start);
      index = grapheme.start;
    }
    const segment = text.slice(grapheme.start, grapheme.end);
    const selected = grapheme.start >= start && grapheme.start < end;
    const isCursor = cursorPos !== undefined && cursorPos === grapheme.start;
    if (isCursor) nextCursorPos = out.length;
    // The cursor grapheme keeps its own reverse-video block from the host.
    out +=
      selected && !isCursor
        ? `${HIGHTLIHT_SELECTION_OPEN}${segment}${HIGHTLIHT_SELECTION_CLOSE}`
        : segment;
    index = grapheme.end;
  }
  out += text.slice(index);
  if (cursorPos !== undefined && cursorPos >= text.length) {
    nextCursorPos = out.length;
  }

  return nextCursorPos === undefined
    ? { ...layoutLine, text: out }
    : { ...layoutLine, text: out, cursorPos: nextCursorPos };
}

/**
 * Map layout lines back to chunks (`[logicalLineIndex, columnOffset]`).
 *
 * The host drops the chunk offsets when it wraps a logical line, so they are re-derived.
 * Returns null when the walk cannot be reconciled, so the caller can render undecorated rather
 * than paint the wrong span.
 */
export function mapLayoutLines(
  layoutLines: readonly LayoutLine[],
  logicalLines: readonly string[],
  fitsInOneChunk: (line: string) => boolean,
): { line: number; offset: number }[] | null {
  const mapping: { line: number; offset: number }[] = [];
  let layoutIndex = 0;

  for (let i = 0; i < logicalLines.length; i++) {
    const line = logicalLines[i] ?? "";
    if (layoutIndex >= layoutLines.length) return null;

    if (fitsInOneChunk(line)) {
      if (layoutLines[layoutIndex]?.text !== line) return null;
      mapping.push({ line: i, offset: 0 });
      layoutIndex++;
      continue;
    }

    let offset = 0;
    while (offset < line.length && line.slice(offset).trim() !== "") {
      const chunk = layoutLines[layoutIndex];
      if (!chunk || chunk.text.length === 0) return null;
      const start = line.indexOf(chunk.text, offset);
      if (start === -1) return null;
      mapping.push({ line: i, offset: start });
      offset = start + chunk.text.length;
      layoutIndex++;
    }
  }

  return layoutIndex === layoutLines.length ? mapping : null;
}
