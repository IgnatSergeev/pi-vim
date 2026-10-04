/**
 * Bridge between history mode and Pi's fullscreen transcript.
 *
 * Pi exposes no public API for the transcript viewport, so this module reads
 * pi-tui's `TuiAltScreen` internals: the primary scroll view, its rendered
 * content lines, and the mouse-selection fields the renderer highlights.
 * Every access is duck-typed and guarded; `attach` returns null whenever the
 * shape is not there (regular TUI mode, older or newer pi-tui).
 *
 * The selection is painted through the same `selectionAnchor`/`selectionFocus`
 * pair a mouse drag sets, so the highlight looks exactly like Pi's own.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { cellColumn, type HistoryView } from "./history-pane.js";
import { getLineGraphemes } from "./motions.js";
import type { Mode } from "./types.js";
import {
  getVisualLineRange,
  isVisualMode,
  orderVisualEndpoints,
  type VisualPosition,
} from "./visual.js";

type ScrollViewLike = {
  /** The transcript document, private in pi-tui */
  readonly child?: ComponentLike;
  getContentWidth?(width: number): number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly isFollowingEnd?: boolean;
  scrollTo(top: number, options?: { disableFollow?: boolean }): void;
  scrollToEnd?(): void;
};

/** A pi-tui component as far as the line classifier needs it */
type ComponentLike = {
  render(width: number): string[];
  readonly children?: readonly ComponentLike[];
  /** Single wrapped component, e.g. MouseRegion */
  readonly child?: ComponentLike;
  readonly paddingX?: number;
};

type LayoutBoxLike = {
  rect?: { width: number };
  scrollView?: unknown;
  scrollContentLines?: readonly string[];
  children?: readonly LayoutBoxLike[];
};

type SelectionPoint = {
  scrollView: ScrollViewLike;
  row: number;
  col: number;
  boundary?: boolean;
};

type AltScreenLike = {
  mode?: unknown;
  currentLayout?: {
    root?: LayoutBoxLike;
    primaryScrollView?: ScrollViewLike;
  };
  selectionAnchor?: SelectionPoint;
  selectionFocus?: SelectionPoint;
  requestRender?: () => void;
};

/** Columns far past any terminal width: a line-wise selection's end */
const LINE_END_COLUMN = 1_000_000;

/**
 * Remove terminal escape sequences the way pi-tui's `extractAnsiCode` does
 * (CSI up to its final byte, OSC and APC up to BEL or ST), so the remaining
 * text has the same cell columns pi-tui measures.
 */
export function stripTerminalSequences(line: string): string {
  if (!line.includes("\x1b")) return line;
  let result = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "\x1b") {
      result += line[i];
      i++;
      continue;
    }
    const next = line[i + 1];
    let end = -1;
    if (next === "[") {
      let j = i + 2;
      while (j < line.length && !/[mGKHJ]/.test(line[j] ?? "")) j++;
      if (j < line.length) end = j + 1;
    } else if (next === "]" || next === "_") {
      for (let j = i + 2; j < line.length; j++) {
        if (line[j] === "\x07") {
          end = j + 1;
          break;
        }
        if (line[j] === "\x1b" && line[j + 1] === "\\") {
          end = j + 2;
          break;
        }
      }
    }
    if (end === -1) {
      result += line[i];
      i++;
    } else {
      i = end;
    }
  }
  return result;
}

function findScrollViewBox(
  box: LayoutBoxLike | undefined,
  scrollView: unknown,
): LayoutBoxLike | undefined {
  if (!box) return undefined;
  if (box.scrollView === scrollView) return box;
  for (const child of box.children ?? []) {
    const match = findScrollViewBox(child, scrollView);
    if (match) return match;
  }
  return undefined;
}

function isAltScreen(tui: unknown): tui is AltScreenLike {
  if (typeof tui !== "object" || tui === null) return false;
  const candidate = tui as AltScreenLike;
  return (
    candidate.mode === "fullscreen" &&
    typeof candidate.currentLayout?.primaryScrollView?.scrollTo === "function"
  );
}

export class HistoryViewport {
  private sourceLines: readonly string[] | null = null;
  private strippedLines: readonly (string | null)[] = [];
  private painted: { anchor: SelectionPoint; focus: SelectionPoint } | null =
    null;

  private constructor(private readonly tui: AltScreenLike) {
    const scrollView = this.scrollView();
    // Pin the view so streaming output does not drag the cursor along
    scrollView?.scrollTo(scrollView.scrollTop, { disableFollow: true });
  }

  /** Null unless Pi runs its fullscreen TUI with a rendered transcript */
  static attach(tui: unknown): HistoryViewport | null {
    if (!isAltScreen(tui)) return null;
    const viewport = new HistoryViewport(tui);
    return viewport.lines().length > 0 ? viewport : null;
  }

  private scrollView(): ScrollViewLike | undefined {
    return this.tui.currentLayout?.primaryScrollView;
  }

  /**
   * Transcript lines without escape sequences and trailing padding. Lines
   * that only decorate the transcript (see `markContent`) are null; when the
   * component tree cannot be matched to the lines, every line is text.
   */
  lines(): readonly (string | null)[] {
    const layout = this.tui.currentLayout;
    const box = findScrollViewBox(layout?.root, layout?.primaryScrollView);
    const source = box?.scrollContentLines;
    if (!source) return this.strippedLines;
    if (source !== this.sourceLines) {
      this.sourceLines = source;
      const content = this.contentMask(box, source.length);
      this.strippedLines = source.map((line, i) =>
        content && !content[i] ? null : plainLine(line),
      );
    }
    return this.strippedLines;
  }

  private contentMask(
    box: LayoutBoxLike | undefined,
    length: number,
  ): boolean[] | null {
    const scrollView = this.scrollView();
    const document = scrollView?.child;
    const width = box?.rect?.width;
    if (!document || width === undefined) return null;
    try {
      const contentWidth = scrollView.getContentWidth?.(width) ?? width;
      const { mask } = markContent(document, contentWidth);
      return mask.length === length ? mask : null;
    } catch {
      return null;
    }
  }

  view(): HistoryView {
    const scrollView = this.scrollView();
    return {
      top: scrollView?.scrollTop ?? 0,
      height: Math.max(1, scrollView?.viewportHeight ?? 1),
    };
  }

  /** Scroll to `top` if requested, then just enough to show `line` */
  reveal(line: number, top?: number): void {
    const scrollView = this.scrollView();
    if (!scrollView) return;
    const height = Math.max(1, scrollView.viewportHeight);
    let next = top ?? scrollView.scrollTop;
    if (line < next) next = line;
    else if (line >= next + height) next = line - height + 1;
    // Also pin a view that was following, or new output would scroll it
    if (next !== scrollView.scrollTop || scrollView.isFollowingEnd) {
      scrollView.scrollTo(next, { disableFollow: true });
    }
  }

  /** Scroll to the end and keep following new output */
  followEnd(): void {
    this.scrollView()?.scrollToEnd?.();
  }

  isFollowingEnd(): boolean {
    return this.scrollView()?.isFollowingEnd === true;
  }

  /**
   * Point the renderer's selection at the pane's cursor, or its selection in
   * visual modes. Pass `requestRender: false` from inside a render pass, which
   * applies the selection anyway.
   */
  paint(
    mode: Mode,
    anchor: VisualPosition,
    cursor: VisualPosition,
    requestRender = true,
  ): void {
    const scrollView = this.scrollView();
    if (!scrollView) return;
    const lines = this.lines();

    let from: SelectionPoint;
    let to: SelectionPoint;
    if (mode === "visual-line") {
      const { startLine, endLine } = getVisualLineRange(anchor, cursor);
      from = { scrollView, row: startLine, col: 0 };
      to = { scrollView, row: endLine, col: LINE_END_COLUMN, boundary: true };
    } else {
      const { start, end } = isVisualMode(mode)
        ? orderVisualEndpoints(anchor, cursor)
        : { start: cursor, end: cursor };
      const startLine = lines[start.line] ?? "";
      const endLine = lines[end.line] ?? "";
      from = {
        scrollView,
        row: start.line,
        col: cellColumn(startLine, start.col),
      };
      to = {
        scrollView,
        row: end.line,
        col: cellColumn(endLine, end.col) + graphemeWidthAt(endLine, end.col),
        boundary: true,
      };
    }

    const painted = this.painted;
    if (
      painted &&
      this.tui.selectionAnchor === painted.anchor &&
      this.tui.selectionFocus === painted.focus &&
      samePoint(painted.anchor, from) &&
      samePoint(painted.focus, to)
    ) {
      return;
    }
    this.tui.selectionAnchor = from;
    this.tui.selectionFocus = to;
    this.painted = { anchor: from, focus: to };
    if (requestRender) this.tui.requestRender?.();
  }

  /**
   * Drop the highlight (if still ours). The view stays where it is, unless
   * `follow` asks it to keep following new output.
   */
  detach(follow = false): void {
    if (
      this.painted &&
      this.tui.selectionAnchor === this.painted.anchor &&
      this.tui.selectionFocus === this.painted.focus
    ) {
      this.tui.selectionAnchor = undefined;
      this.tui.selectionFocus = undefined;
    }
    this.painted = null;
    if (follow) this.followEnd();
    this.tui.requestRender?.();
  }
}

/** Cells taken by the grapheme at `col`; an EOL or empty-line cursor takes one */
function graphemeWidthAt(line: string, col: number): number {
  const segment = getLineGraphemes(line).find((s) => s.start === col);
  if (!segment) return 1;
  return Math.max(1, visibleWidth(line.slice(segment.start, segment.end)));
}

function samePoint(a: SelectionPoint, b: SelectionPoint): boolean {
  return (
    a.scrollView === b.scrollView &&
    a.row === b.row &&
    a.col === b.col &&
    a.boundary === b.boundary
  );
}

function plainLine(line: string): string {
  return stripTerminalSequences(line).trimEnd();
}

function childrenOf(component: ComponentLike): readonly ComponentLike[] | null {
  if (Array.isArray(component.children)) return component.children;
  if (typeof component.child?.render === "function") return [component.child];
  return null;
}

/**
 * Distinguish text lines from decoration by the component that rendered them. The
 * rendered lines carry no marker of their own, but pi builds the transcript
 * from components whose roles are known:
 *   - `DynamicBorder` draws rules, `Spacer` the gaps between messages;
 *   - a parent's rows outside its children are its own decoration, like a
 *     `Box`'s padding;
 *   - a leaf's leading and trailing empty rows are padding (`Text` padding,
 *     the `\n` pi puts before bash output); empty rows between its text are
 *     part of the text.
 * Children are matched to their parent's rows by text; a parent whose rows do
 * not contain its children's text (it rewrote them) is treated as a leaf.
 */
export function markContent(
  component: ComponentLike,
  width: number,
): { lines: string[]; mask: boolean[] } {
  const lines = component.render(width).map(plainLine);
  if (component.constructor?.name === "DynamicBorder") {
    return { lines, mask: lines.map(() => false) };
  }
  const children = childrenOf(component);
  if (children) {
    const isBox = component.constructor?.name === "Box";
    const padding = isBox ? (component.paddingX ?? 0) : 0;
    const childWidth = Math.max(1, width - padding * 2);
    const childLines: string[] = [];
    const childMask: boolean[] = [];
    for (const child of children) {
      const marked = markContent(child, childWidth);
      childLines.push(...marked.lines);
      childMask.push(...marked.mask);
    }
    const offset = alignChildren(lines, childLines, childMask);
    if (offset !== null) {
      const mask = lines.map(() => false);
      childMask.forEach((content, i) => {
        mask[offset + i] = content;
      });
      return { lines, mask };
    }
  }
  return { lines, mask: markLeaf(lines) };
}

/** First offset at which every text row of the children is in the parent's row */
function alignChildren(
  lines: readonly string[],
  childLines: readonly string[],
  childMask: readonly boolean[],
): number | null {
  for (let offset = 0; offset + childLines.length <= lines.length; offset++) {
    const fits = childLines.every(
      (line, i) =>
        !childMask[i] || (lines[offset + i] ?? "").includes(line.trim()),
    );
    if (fits) return offset;
  }
  return null;
}

function markLeaf(lines: readonly string[]): boolean[] {
  const isText = (line: string) => line.trim() !== "";
  const first = lines.findIndex(isText);
  const last = lines.findLastIndex(isText);
  return lines.map((_, i) => first !== -1 && i >= first && i <= last);
}
