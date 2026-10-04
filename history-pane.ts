/**
 * History pane: Pi's rendered transcript as a read-only vim window above the
 * prompt, with its own cursor and visual selection.
 *
 * Pure state machine over plain text lines (ANSI already stripped).
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import {
  findCharMotionTarget,
  findFirstNonWhitespaceColumn,
  findWordTargetInText,
  getLineGraphemes,
  reverseCharMotion,
  type WordMotionClass,
} from "./motions.js";
import {
  resolveDelimitedTextObjectRange,
  resolveMatchingPairMotionTarget,
  resolveWordTextObjectRange,
  type TextObjectKind,
  type TextObjectRange,
} from "./text-objects.js";
import {
  type CharMotion,
  CTRL_B,
  CTRL_C,
  CTRL_D,
  CTRL_E,
  CTRL_F,
  CTRL_N,
  CTRL_P,
  CTRL_U,
  CTRL_Y,
  type Direction,
  type LastCharMotion,
  MAX_COUNT,
  type Mode,
  type Position,
} from "./types.js";
import {
  getInclusiveEndColumn,
  isVisualMode,
  orderVisualEndpoints,
  type VisualPosition,
} from "./visual.js";

// Keys arrive normalized by `toHistoryKey`: Escape, Enter and Backspace as
// these bytes, control keys as their C0 byte.
const ESC = "\x1b";
const ENTER = "\r";
const BACKSPACE = "\x7f";

/** Visible window of the transcript, in lines */
export type HistoryView = { top: number; height: number };

export type HistoryActionResult = {
  /** Yanked text */
  yank?: string;
  /** The key means nothing to the pane; hand it to Pi (Escape, Ctrl-C) */
  forward?: true;
  /** Requested viewport top */
  scrollTop?: number;
  /** Message for the user, e.g. a failed search */
  notify?: string;
};

type SlectionType = "exclusive" | "inclusive" | "linewise";

type Motion = {
  /** Where the cursor lands, or the far end of a selection */
  target: Position;
  selectionType: SlectionType;
  /** Screen cell the cursor keeps across later vertical moves */
  curswant?: number;
  /** Requested viewport top */
  scrollTop?: number;
  /** `w`/`W` get vim's end-of-line special case under an operator */
  word?: boolean;
  /** Which way to move the cursor off a decoration line the target is on */
  decorationSkipDirection?: Direction;
};

type Pending =
  | { kind: "g" }
  | { kind: "z" }
  | { kind: "char"; motion: CharMotion }
  | { kind: "object"; object: TextObjectKind }
  | null;

type Search = { direction: Direction; query: string };

/**
 * Transcript lines with precomputed absolute offsets.
 */
class HistoryDocument {
  readonly lines: readonly string[];
  readonly text: string;
  private readonly starts: number[];

  /** Constructs document using lines from the history.
   *   Null line corresponds to view decoration.
   * */
  constructor(readonly source: readonly (string | null)[]) {
    this.lines = source.map((line) => line ?? "");
    this.text = this.lines.join("\n");
    this.starts = [];
    let offset = 0;
    for (const line of this.lines) {
      this.starts.push(offset);
      offset += line.length + 1;
    }
  }

  get lastLine(): number {
    return Math.max(0, this.lines.length - 1);
  }

  line(index: number): string {
    return this.lines[index] ?? "";
  }

  isContent(index: number): boolean {
    return this.source[index] !== null;
  }

  /**
   * Nearest content line from `line`, looking in `direction` first and then
   * the other way; null when the transcript has no content at all.
   */
  nearestContent(line: number, direction: Direction): number | null {
    const step = direction === "forward" ? 1 : -1;
    for (let i = line; i >= 0 && i <= this.lastLine; i += step) {
      if (this.isContent(i)) return i;
    }
    for (let i = line - step; i >= 0 && i <= this.lastLine; i -= step) {
      if (this.isContent(i)) return i;
    }
    return null;
  }

  get lastContentLine(): number {
    return this.nearestContent(this.lastLine, "backward") ?? this.lastLine;
  }

  /** Text in absolute range `[startAbs, endAbs)` */
  textBetween(startAbs: number, endAbs: number): string {
    const firstLine = this.pos(startAbs).line;
    const parts = this.text.slice(startAbs, endAbs).split("\n");
    return this.withoutDecoration(parts, firstLine).join("\n");
  }

  /** Lines at rows range `start..end` */
  linesBetween(start: number, end: number): string[] {
    return this.withoutDecoration(this.lines.slice(start, end + 1), start);
  }

  /**
   * Removes decoration lines from provided text.
   */
  private withoutDecoration(
    parts: readonly string[],
    firstLine: number,
  ): string[] {
    const kept: string[] = [];
    let gap = false;
    parts.forEach((part, i) => {
      if (!this.isContent(firstLine + i)) {
        gap = kept.length > 0;
        return;
      }
      if (gap && kept[kept.length - 1] !== "") kept.push("");
      gap = false;
      kept.push(part);
    });
    return kept;
  }

  abs(pos: Position): number {
    return (this.starts[pos.line] ?? 0) + pos.col;
  }

  lineStart(line: number): number {
    return this.starts[line] ?? 0;
  }

  pos(abs: number): Position {
    const clamped = Math.max(0, Math.min(abs, this.text.length));
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((this.starts[mid] ?? 0) <= clamped) low = mid;
      else high = mid - 1;
    }
    return { line: low, col: clamped - (this.starts[low] ?? 0) };
  }
}

function lastGraphemeStart(line: string): number {
  const graphemes = getLineGraphemes(line);
  return graphemes[graphemes.length - 1]?.start ?? 0;
}

/** Snap `col` onto the start of the grapheme containing it */
function snapToGrapheme(line: string, col: number): number {
  if (col <= 0) return 0;
  if (col >= line.length) return line.length;
  let start = 0;
  for (const segment of getLineGraphemes(line)) {
    if (segment.start > col) break;
    start = segment.start;
  }
  return start;
}

/** Cell column where `col` starts on screen */
export function cellColumn(line: string, col: number): number {
  return visibleWidth(line.slice(0, col));
}

/** Column of the grapheme covering `targetCell`, clamped to the last one */
function columnForCell(
  line: string,
  targetCell: number,
  allowEol: boolean,
): number {
  if (targetCell === Number.POSITIVE_INFINITY) {
    return allowEol ? line.length : lastGraphemeStart(line);
  }
  let cell = 0;
  for (const segment of getLineGraphemes(line)) {
    const width = visibleWidth(line.slice(segment.start, segment.end));
    if (targetCell < cell + Math.max(1, width)) return segment.start;
    cell += width;
  }
  return lastGraphemeStart(line);
}

function isEmptyLine(line: string): boolean {
  return line.length === 0;
}

function parseCount(raw: string): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isPrintableKey(key: string): boolean {
  if (key.length === 0) return false;
  for (const char of key) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function isSingleGrapheme(key: string): boolean {
  return isPrintableKey(key) && getLineGraphemes(key).length === 1;
}

/** Literal search with smartcase: case-sensitive only when the query has uppercase */
function findMatch(
  text: string,
  query: string,
  fromAbs: number,
  direction: Direction,
): number | null {
  const caseSensitive = query !== query.toLowerCase();
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  if (direction === "forward") {
    const next = haystack.indexOf(needle, fromAbs + 1);
    if (next !== -1) return next;
    const wrapped = haystack.indexOf(needle);
    return wrapped === -1 ? null : wrapped;
  }
  const previous = fromAbs > 0 ? haystack.lastIndexOf(needle, fromAbs - 1) : -1;
  if (previous !== -1) return previous;
  const wrapped = haystack.lastIndexOf(needle);
  return wrapped === -1 ? null : wrapped;
}

export class HistoryPane {
  private mode: Mode = "normal";
  private cursor: Position;
  private anchor: VisualPosition;
  private curswant: number;
  private prefixCount = "";
  private operator: "y" | null = null;
  private operatorCount = "";
  private pending: Pending = null;
  private search: Search | null = null;
  private lastSearch: Search | null = null;
  private lastCharMotion: LastCharMotion | null = null;
  /** Cursor sticks to the last line as the transcript grows (after `G`) */
  private followingEnd = false;
  /** Set by a plain `G` during the current key */
  private followRequested = false;
  private doc: HistoryDocument;
  private view: HistoryView;

  constructor(
    lines: readonly (string | null)[],
    view: HistoryView,
    start?: Position,
  ) {
    this.doc = new HistoryDocument(lines);
    this.view = view;
    this.cursor = this.toContent(
      this.clampNormal(start ?? this.defaultStart()),
      "backward",
    );
    this.anchor = { ...this.cursor };
    this.curswant = this.cellOf(this.cursor);
  }

  getMode(): Mode {
    return this.mode;
  }

  /** Normal mode with nothing typed */
  isIdle(): boolean {
    return this.mode === "normal" && !this.search && !this.hasPendingInput();
  }

  getCursor(): Position {
    return { ...this.cursor };
  }

  /** Where the visual selection started; meaningless in normal mode */
  getAnchor(): VisualPosition {
    return { ...this.anchor };
  }

  getLabel(): string {
    const name =
      this.mode === "normal"
        ? "NORMAL"
        : this.mode === "visual"
          ? "VISUAL"
          : "V-LINE";
    if (this.search) {
      const prefix = this.search.direction === "forward" ? "/" : "?";
      return ` ${name} ${prefix}${this.search.query}_ `;
    }
    const operator = this.operator
      ? `${this.operator}${this.operatorCount}`
      : "";
    const pending =
      this.pending === null
        ? ""
        : this.pending.kind === "char"
          ? this.pending.motion
          : this.pending.kind === "object"
            ? this.pending.object
            : this.pending.kind;
    const typed = `${this.prefixCount}${operator}${pending}`;
    return typed ? ` ${name} ${typed}_ ` : ` ${name} `;
  }

  /**
   * Update transcript lines and view after streaming output or a resize.
   * Positions are clamped.
   */
  update(lines: readonly (string | null)[], view: HistoryView): void {
    if (lines !== this.doc.source) {
      this.doc = new HistoryDocument(lines);
    }
    this.view = view;
    this.anchor = this.toContent(
      this.clampPosition(this.anchor, true),
      "backward",
    );
    this.cursor = this.toContent(
      this.mode === "normal"
        ? this.clampNormal(this.cursor)
        : this.clampPosition(this.cursor, true),
      "backward",
    );
    if (this.followingEnd) this.moveVertically(this.doc.lastContentLine);
  }

  isFollowingEnd(): boolean {
    return this.followingEnd;
  }

  /** Set the cursor to follow the last line */
  followEnd(): void {
    this.followingEnd = true;
    this.moveVertically(this.doc.lastContentLine);
  }

  /** Update a visible frame */
  setView(view: HistoryView): void {
    this.view = view;
  }

  /**
   * Keep the cursor inside the view after the viewport scrolled on its own
   * (mouse wheel, Pi's page keys).
   */
  followView(): void {
    const { top, height } = this.view;
    const bottom = Math.min(this.doc.lastLine, top + Math.max(1, height) - 1);
    const line = Math.max(top, Math.min(this.cursor.line, bottom));
    if (line === this.cursor.line) return;
    // Look for content back toward the view's inside
    const direction = line < this.cursor.line ? "backward" : "forward";
    this.moveVertically(this.doc.nearestContent(line, direction) ?? line);
  }

  handleKey(
    key: string,
    lines: readonly (string | null)[],
    view: HistoryView,
  ): HistoryActionResult {
    this.update(lines, view);
    const wasFollowing = this.followingEnd;
    this.followRequested = false;
    const result = this.dispatchKey(key);
    this.followingEnd =
      (wasFollowing || this.followRequested) &&
      this.cursor.line === this.doc.lastContentLine &&
      result.scrollTop === undefined;
    return result;
  }

  private dispatchKey(key: string): HistoryActionResult {
    if (this.search) return this.handleSearchKey(key);

    if (key === ESC || key === CTRL_C) {
      if (this.hasPendingInput()) {
        this.clearPending();
        return {};
      }
      if (this.mode !== "normal") {
        this.mode = "normal";
        this.cursor = this.clampNormal(this.cursor);
        return {};
      }
      return { forward: true };
    }

    const pending = this.pending;
    if (pending) {
      this.pending = null;
      return this.handlePendingKey(pending, key);
    }

    if (this.isCountKey(key)) {
      if (this.operator) this.operatorCount += key;
      else this.prefixCount += key;
      return {};
    }

    if (this.operator) return this.handleOperatorKey(key);

    const command = this.handleCommandKey(key);
    if (command) return command;

    return this.moveWith(key);
  }

  private defaultStart(): Position {
    const { top, height } = this.view;
    const bottom = Math.min(this.doc.lastLine, top + Math.max(1, height) - 1);
    const line = this.doc.nearestContent(bottom, "backward") ?? bottom;
    return {
      line,
      col: findFirstNonWhitespaceColumn(this.doc.line(line)),
    };
  }

  private hasPendingInput(): boolean {
    return Boolean(this.prefixCount || this.operator || this.pending);
  }

  private clearPending(): void {
    this.prefixCount = "";
    this.operator = null;
    this.operatorCount = "";
    this.pending = null;
  }

  private isCountKey(key: string): boolean {
    if (key.length !== 1 || key < "0" || key > "9") return false;
    const typed = this.operator ? this.operatorCount : this.prefixCount;
    return key !== "0" || typed.length > 0;
  }

  /** Total count typed before and after the operator, or null when none */
  private takeCount(): number | null {
    const prefix = parseCount(this.prefixCount);
    const operator = parseCount(this.operatorCount);
    this.prefixCount = "";
    this.operatorCount = "";
    if (prefix === null && operator === null) return null;
    return Math.min(MAX_COUNT, (prefix ?? 1) * (operator ?? 1));
  }

  private cellOf(pos: Position): number {
    return cellColumn(this.doc.line(pos.line), pos.col);
  }

  private clampPosition(pos: Position, allowEol: boolean): Position {
    const line = Math.max(0, Math.min(pos.line, this.doc.lastLine));
    const text = this.doc.line(line);
    const max = allowEol ? text.length : lastGraphemeStart(text);
    return {
      line,
      col: snapToGrapheme(text, Math.max(0, Math.min(pos.col, max))),
    };
  }

  /** Normal-mode cursor: never past the last grapheme */
  private clampNormal(pos: Position): Position {
    return this.clampPosition(pos, false);
  }

  /**
   * Move `pos` onto the nearest content line, looking in `direction` first.
   * Keeps `curswant` screen cell when given, otherwise
   * lands on the first non-blank going down and the last character going up.
   */
  private toContent(
    pos: Position,
    direction: Direction,
    curswant?: number,
  ): Position {
    if (this.doc.isContent(pos.line)) return pos;
    const line = this.doc.nearestContent(pos.line, direction);
    if (line === null) return pos;
    const text = this.doc.line(line);
    const col =
      curswant !== undefined
        ? columnForCell(text, curswant, isVisualMode(this.mode))
        : line > pos.line
          ? findFirstNonWhitespaceColumn(text)
          : lastGraphemeStart(text);
    return { line, col };
  }

  private moveVertically(line: number): void {
    const target = Math.max(0, Math.min(line, this.doc.lastLine));
    const text = this.doc.line(target);
    this.cursor = {
      line: target,
      col: columnForCell(text, this.curswant, isVisualMode(this.mode)),
    };
  }

  private clampTop(top: number): number {
    const maxTop = Math.max(0, this.doc.lines.length - this.view.height);
    return Math.max(0, Math.min(top, maxTop));
  }

  private firstNonBlank(line: number): Position {
    return { line, col: findFirstNonWhitespaceColumn(this.doc.line(line)) };
  }

  private handleSearchKey(key: string): HistoryActionResult {
    const search = this.search;
    if (!search) return {};

    if (key === ESC || key === CTRL_C) {
      this.search = null;
      this.clearPending();
      return {};
    }
    if (key === BACKSPACE) {
      if (search.query.length === 0) {
        this.search = null;
        this.clearPending();
      } else {
        const graphemes = getLineGraphemes(search.query);
        search.query = search.query.slice(
          0,
          graphemes[graphemes.length - 1]?.start ?? 0,
        );
      }
      return {};
    }
    if (key === ENTER) {
      this.search = null;
      const query = search.query || this.lastSearch?.query || "";
      if (!query) {
        this.clearPending();
        return {};
      }
      this.lastSearch = { direction: search.direction, query };
      return this.moveWith("n", true);
    }
    if (isPrintableKey(key)) search.query += key;
    return {};
  }

  private handlePendingKey(
    pending: NonNullable<Pending>,
    key: string,
  ): HistoryActionResult {
    switch (pending.kind) {
      case "char": {
        if (!isSingleGrapheme(key)) {
          this.clearPending();
          return {};
        }
        this.lastCharMotion = { motion: pending.motion, char: key };
        return this.moveWith(pending.motion, false, key);
      }
      case "object":
        return this.applyTextObject(pending.object, key);
      case "g":
        if (key === "g") return this.moveWith("gg");
        this.clearPending();
        return {};
      case "z":
        return this.scrollCursorTo(key);
    }
  }

  private handleOperatorKey(key: string): HistoryActionResult {
    if (key === "y") {
      const count = this.takeCount() ?? 1;
      const start = this.cursor.line;
      const end = Math.min(this.doc.lastLine, start + count - 1);
      this.operator = null;
      return this.yankLines(start, end);
    }
    if (key === "i" || key === "a") {
      this.pending = { kind: "object", object: key };
      return {};
    }
    if (this.startPendingMotion(key)) return {};
    return this.moveWith(key);
  }

  /** Motions that wait for another key: `gg` and the char finds */
  private startPendingMotion(key: string): boolean {
    switch (key) {
      case "g":
        this.pending = { kind: "g" };
        return true;
      case "f":
      case "F":
      case "t":
      case "T":
        this.pending = { kind: "char", motion: key };
        return true;
    }
    return false;
  }

  /** Mode and yank commands; returns null for keys that may be motions */
  private handleCommandKey(key: string): HistoryActionResult | null {
    switch (key) {
      case "v":
      case "V": {
        this.prefixCount = "";
        const next = key === "v" ? "visual" : "visual-line";
        if (this.mode === next) {
          this.mode = "normal";
          this.cursor = this.clampNormal(this.cursor);
        } else {
          if (this.mode === "normal") this.anchor = { ...this.cursor };
          this.mode = next;
        }
        return {};
      }
      case "/":
      case "?":
        this.search = {
          direction: key === "/" ? "forward" : "backward",
          query: "",
        };
        return {};
      case "z":
        this.pending = { kind: "z" };
        return {};
    }
    if (this.startPendingMotion(key)) return {};

    if (this.mode === "normal") {
      switch (key) {
        case "y":
          this.operator = "y";
          return {};
        case "Y":
          this.operator = "y";
          return this.handleOperatorKey("y");
      }
      return null;
    }

    switch (key) {
      case "o":
      case "O": {
        this.prefixCount = "";
        const anchor = this.anchor;
        this.anchor = this.cursor;
        this.cursor = anchor;
        this.curswant = this.cellOf(this.cursor);
        return {};
      }
      case "y":
      case "Y": {
        this.prefixCount = "";
        const { start, end } = orderVisualEndpoints(this.anchor, this.cursor);
        if (this.mode === "visual-line" || key === "Y") {
          return this.yankLines(start.line, end.line, 0);
        }
        return this.yankVisualChars(start, end);
      }
      case "i":
      case "a":
        this.pending = { kind: "object", object: key };
        return {};
    }
    return null;
  }

  /** Resolve `key` as a motion and move the cursor or run the pending yank */
  private moveWith(
    key: string,
    fromSearch = false,
    char?: string,
  ): HistoryActionResult {
    const hadCount =
      this.prefixCount.length > 0 || this.operatorCount.length > 0;
    const count = this.takeCount();
    const motion = this.resolveMotion(key, count, hadCount, char);

    if (!motion) {
      this.clearPending();
      if (fromSearch) {
        return { notify: `Pattern not found: ${this.lastSearch?.query ?? ""}` };
      }
      return {};
    }

    if (this.operator) {
      this.operator = null;
      return this.yankMotion(motion);
    }

    const direction =
      motion.decorationSkipDirection ??
      (motion.target.line < this.cursor.line ? "backward" : "forward");
    const target = this.toContent(motion.target, direction, motion.curswant);
    this.cursor = isVisualMode(this.mode)
      ? this.clampPosition(target, true)
      : this.clampNormal(target);
    this.curswant = motion.curswant ?? this.cellOf(this.cursor);
    if (key === "G" && !hadCount) this.followRequested = true;
    return motion.scrollTop === undefined
      ? {}
      : { scrollTop: motion.scrollTop };
  }

  private resolveMotion(
    key: string,
    count: number | null,
    hadCount: boolean,
    char?: string,
  ): Motion | null {
    const n = count ?? 1;
    const { cursor, doc } = this;
    const line = doc.line(cursor.line);
    const forOperator = this.operator !== null;

    switch (key) {
      case "h":
      case BACKSPACE: {
        const graphemes = getLineGraphemes(line);
        const index = graphemes.findIndex((s) => cursor.col < s.end);
        const current = index === -1 ? graphemes.length : index;
        const target = graphemes[Math.max(0, current - n)]?.start ?? 0;
        return {
          target: { line: cursor.line, col: target },
          selectionType: "exclusive",
        };
      }
      case "l":
      case " ": {
        let col = cursor.col;
        for (let step = 0; step < n && col < line.length; step++) {
          col = getInclusiveEndColumn(line, col);
        }
        // Only an operator may reach past the last grapheme (`yl` at EOL)
        if (!forOperator) col = Math.min(col, lastGraphemeStart(line));
        return {
          target: { line: cursor.line, col },
          selectionType: "exclusive",
        };
      }
      case "j":
      case CTRL_N:
        return this.lineMotion("forward", n, false);
      case "k":
      case CTRL_P:
        return this.lineMotion("backward", n, false);
      case "+":
      case ENTER:
        return this.lineMotion("forward", n, true);
      case "-":
        return this.lineMotion("backward", n, true);
      case "0":
        return {
          target: { line: cursor.line, col: 0 },
          selectionType: "exclusive",
        };
      case "^":
        return {
          target: this.firstNonBlank(cursor.line),
          selectionType: "exclusive",
        };
      case "$": {
        const target = Math.min(doc.lastLine, cursor.line + n - 1);
        const text = doc.line(target);
        // Visual `$` covers the line break
        const col = isVisualMode(this.mode)
          ? text.length
          : lastGraphemeStart(text);
        return {
          target: { line: target, col },
          selectionType: "inclusive",
          curswant: Number.POSITIVE_INFINITY,
        };
      }
      case "w":
      case "W":
      case "e":
      case "E":
      case "b":
      case "B":
        return this.wordMotion(key, n);
      case "f":
      case "F":
      case "t":
      case "T":
        return char === undefined ? null : this.charMotion(key, char, n, false);
      case ";":
      case ",": {
        const last = this.lastCharMotion;
        if (!last) return null;
        const motion =
          key === ";" ? last.motion : reverseCharMotion(last.motion);
        return this.charMotion(motion, last.char, n, true);
      }
      case "gg":
        return this.lineTarget(hadCount ? n - 1 : 0, false);
      case "G":
        return this.lineTarget(hadCount ? n - 1 : doc.lastLine, false);
      case "{":
      case "}":
        return this.paragraphMotion(key, n);
      case "%":
        return this.matchingPairMotion(hadCount);
      case "H":
      case "L":
      case "M":
        return this.screenMotion(key, n);
      case CTRL_D:
      case CTRL_U:
      case CTRL_F:
      case CTRL_B:
      case CTRL_E:
      case CTRL_Y:
        return forOperator ? null : this.scrollMotion(key, n);
      case "n":
      case "N":
        return this.searchMotion(key, n);
    }
    return null;
  }

  /**
   * `j`/`k`-style move over `count` content lines; a count past the last
   * content line stops there, and no content line that way fails the motion.
   */
  private lineMotion(
    direction: Direction,
    count: number,
    firstNonBlank: boolean,
  ): Motion | null {
    const step = direction === "forward" ? 1 : -1;
    let line = this.cursor.line;
    let moved = 0;
    for (
      let i = line + step;
      i >= 0 && i <= this.doc.lastLine && moved < count;
      i += step
    ) {
      if (!this.doc.isContent(i)) continue;
      line = i;
      moved++;
    }
    if (moved === 0) return null;
    return this.lineTarget(line, firstNonBlank);
  }

  /**
   * Linewise target on `line`. Without `firstNonBlank` the desired column is
   * kept, as nvim does for `gg`, `G`, `H`, `M`, `L` with 'nostartofline'.
   */
  private lineTarget(line: number, firstNonBlank: boolean): Motion {
    const target = Math.max(0, Math.min(line, this.doc.lastLine));
    if (firstNonBlank) {
      return { target: this.firstNonBlank(target), selectionType: "linewise" };
    }
    const text = this.doc.line(target);
    return {
      target: {
        line: target,
        col: columnForCell(text, this.curswant, isVisualMode(this.mode)),
      },
      selectionType: "linewise",
      curswant: this.curswant,
    };
  }

  private wordMotion(key: string, count: number): Motion {
    const semanticClass: WordMotionClass =
      key === key.toUpperCase() ? "WORD" : "word";
    const lower = key.toLowerCase();
    const { doc } = this;
    const abs = doc.abs(this.cursor);
    const targetAbs = findWordTargetInText(
      doc.text,
      abs,
      lower === "b" ? "backward" : "forward",
      lower === "e" ? "end" : "start",
      count,
      semanticClass,
    );
    return {
      target: doc.pos(targetAbs),
      selectionType: lower === "e" ? "inclusive" : "exclusive",
      word: lower === "w",
    };
  }

  private charMotion(
    motion: CharMotion,
    char: string,
    count: number,
    isRepeat: boolean,
  ): Motion | null {
    const col = findCharMotionTarget(
      this.doc.line(this.cursor.line),
      this.cursor.col,
      motion,
      char,
      isRepeat,
      count,
    );
    if (col === null) return null;
    return {
      target: { line: this.cursor.line, col },
      selectionType:
        motion === "f" || motion === "t" ? "inclusive" : "exclusive",
    };
  }

  /**
   * Paragraphs are separated by empty lines, motion stops on that gap.
   * Decoration lines count as empty, but the cursor cannot rest there, so it
   * moves on to the text below. Under `y` the target stays on the gap.
   */
  private paragraphMotion(key: "{" | "}", count: number): Motion {
    const { doc } = this;
    const forward = key === "}";
    const forOperator = this.operator !== null;
    let line = this.cursor.line;
    for (let step = 0; step < count; step++) {
      if (forward) {
        while (line < doc.lastLine && isEmptyLine(doc.line(line))) line++;
        while (line < doc.lastLine && !isEmptyLine(doc.line(line))) line++;
      } else {
        // Decoration above a first line would snap the cursor back to it
        if (!forOperator && line > 0 && !doc.isContent(line - 1)) line--;
        while (line > 0 && isEmptyLine(doc.line(line))) line--;
        while (line > 0 && !isEmptyLine(doc.line(line))) line--;
      }
    }
    const text = doc.line(line);
    const atBufferEdge = !isEmptyLine(text);
    const col = forward && atBufferEdge ? text.length : 0;
    return {
      target: { line, col },
      selectionType: "exclusive",
      decorationSkipDirection: "forward",
    };
  }

  private matchingPairMotion(hadCount: boolean): Motion | null {
    if (hadCount) return null;
    const { doc, cursor } = this;
    const lineStart = doc.lineStart(cursor.line);
    const match = resolveMatchingPairMotionTarget(
      doc.text,
      doc.abs(cursor),
      lineStart,
      lineStart + doc.line(cursor.line).length,
    );
    if (!match) return null;
    return { target: doc.pos(match.targetAbs), selectionType: "inclusive" };
  }

  private screenMotion(key: "H" | "M" | "L", count: number): Motion {
    const { top, height } = this.view;
    const bottom = Math.min(this.doc.lastLine, top + Math.max(1, height) - 1);
    const line =
      key === "H"
        ? Math.min(bottom, top + count - 1)
        : key === "L"
          ? Math.max(top, bottom - count + 1)
          : top + Math.floor((bottom - top) / 2);
    return {
      ...this.lineTarget(line, false),
      decorationSkipDirection: key === "L" ? "backward" : "forward",
    };
  }

  private scrollMotion(key: string, count: number): Motion {
    const { top, height } = this.view;
    const half = Math.max(1, Math.floor(height / 2));
    const page = Math.max(1, height - 2);
    const lastLine = this.doc.lastLine;
    let nextTop = top;
    let line = this.cursor.line;

    switch (key) {
      case CTRL_D:
        nextTop = this.clampTop(top + half);
        line = Math.min(lastLine, line + half);
        break;
      case CTRL_U:
        nextTop = this.clampTop(top - half);
        line = Math.max(0, line - half);
        break;
      case CTRL_F:
        nextTop = this.clampTop(top + page * count);
        line = Math.max(line, nextTop);
        break;
      case CTRL_B:
        nextTop = this.clampTop(top - page * count);
        line = Math.min(line, nextTop + height - 1);
        break;
      case CTRL_E:
        nextTop = this.clampTop(top + count);
        line = Math.max(line, nextTop);
        break;
      case CTRL_Y:
        nextTop = this.clampTop(top - count);
        line = Math.min(line, nextTop + height - 1);
        break;
    }

    const text = this.doc.line(line);
    return {
      target: {
        line,
        col: columnForCell(text, this.curswant, isVisualMode(this.mode)),
      },
      selectionType: "linewise",
      curswant: this.curswant,
      scrollTop: nextTop,
      // Snap toward the side that stays in view
      decorationSkipDirection:
        key === CTRL_D || key === CTRL_F || key === CTRL_E
          ? "forward"
          : "backward",
    };
  }

  private searchMotion(key: "n" | "N", count: number): Motion | null {
    const search = this.lastSearch;
    if (!search) return null;
    const direction =
      key === "n"
        ? search.direction
        : search.direction === "forward"
          ? "backward"
          : "forward";
    let abs = this.doc.abs(this.cursor);
    for (let step = 0; step < count; step++) {
      const next = findMatch(this.doc.text, search.query, abs, direction);
      if (next === null) return null;
      abs = next;
    }
    return { target: this.doc.pos(abs), selectionType: "exclusive" };
  }

  /** `zz`, `zt`, `zb`: scroll so the cursor line sits mid, top or bottom */
  private scrollCursorTo(key: string): HistoryActionResult {
    this.clearPending();
    const { height } = this.view;
    const line = this.cursor.line;
    switch (key) {
      case "z":
      case ".":
        return { scrollTop: this.clampTop(line - Math.floor(height / 2)) };
      case "t":
      case ENTER:
        return { scrollTop: this.clampTop(line) };
      case "b":
      case "-":
        return { scrollTop: this.clampTop(line - height + 1) };
    }
    return {};
  }

  private applyTextObject(
    object: TextObjectKind,
    key: string,
  ): HistoryActionResult {
    const range = this.resolveTextObject(object, key);
    if (!range || range.endAbs <= range.startAbs) {
      this.clearPending();
      return {};
    }

    const { doc } = this;
    if (this.operator) {
      this.operator = null;
      this.prefixCount = "";
      return this.yankRange(range.startAbs, range.endAbs);
    }

    // Visual mode: select the object, cursor on its last grapheme
    this.prefixCount = "";
    const start = doc.pos(range.startAbs);
    const lastPos = doc.pos(range.endAbs - 1);
    const lastLine = doc.line(lastPos.line);
    this.anchor = start;
    this.cursor = {
      line: lastPos.line,
      col:
        lastPos.col >= lastLine.length
          ? lastLine.length
          : snapToGrapheme(lastLine, lastPos.col),
    };
    this.curswant = this.cellOf(this.cursor);
    if (this.mode === "visual-line") this.mode = "visual";
    return {};
  }

  private resolveTextObject(
    object: TextObjectKind,
    key: string,
  ): TextObjectRange | null {
    const { doc, cursor } = this;
    if (key === "w" || key === "W") {
      const count = this.takeCount() ?? 1;
      return resolveWordTextObjectRange(
        doc.line(cursor.line),
        doc.lineStart(cursor.line),
        cursor.col,
        object,
        count,
        key === "W" ? "WORD" : "word",
      );
    }
    if (this.takeCount() !== null) return null;
    const line = doc.line(cursor.line);
    const col =
      line.length > 0 && cursor.col >= line.length
        ? line.length - 1
        : cursor.col;
    return resolveDelimitedTextObjectRange(
      doc.text,
      doc.abs({ line: cursor.line, col }),
      object,
      key,
    );
  }

  private yankMotion(motion: Motion): HistoryActionResult {
    const { doc } = this;
    const origin = this.cursor;

    if (motion.selectionType === "linewise") {
      const { start, end } = orderVisualEndpoints(origin, motion.target);
      return this.yankLines(start.line, end.line);
    }

    const { start, end } = orderVisualEndpoints(origin, motion.target);
    let startAbs = doc.abs(start);
    let endAbs = doc.abs(end);

    if (motion.selectionType === "inclusive") {
      endAbs = doc.abs({
        line: end.line,
        col: getInclusiveEndColumn(doc.line(end.line), end.col),
      });
    } else if (
      motion.word &&
      motion.target.line > origin.line &&
      motion.target.col <=
        findFirstNonWhitespaceColumn(doc.line(motion.target.line))
    ) {
      let last = endAbs;
      while (last > startAbs && /\s/.test(doc.text[last - 1] ?? "")) last--;
      endAbs = last;
    } else if (end.line > start.line && end.col === 0) {
      if (start.col <= findFirstNonWhitespaceColumn(doc.line(start.line))) {
        return this.yankLines(start.line, end.line - 1);
      }
      endAbs -= 1;
    }

    startAbs = Math.min(startAbs, endAbs);
    return this.yankRange(startAbs, endAbs);
  }

  private yankRange(startAbs: number, endAbs: number): HistoryActionResult {
    const text = this.doc.textBetween(startAbs, endAbs);
    if (text === "") {
      this.clearPending();
      return {};
    }
    this.cursor = this.clampNormal(this.doc.pos(startAbs));
    return this.finishYank(text);
  }

  private yankVisualChars(start: Position, end: Position): HistoryActionResult {
    const { doc } = this;
    const endLine = doc.line(end.line);
    // An empty line or a cursor at EOL selects the line break too
    const endAbs =
      end.col >= endLine.length
        ? doc.lineStart(end.line) +
          endLine.length +
          (end.line < doc.lastLine ? 1 : 0)
        : doc.abs({
            line: end.line,
            col: getInclusiveEndColumn(endLine, end.col),
          });
    return this.yankRange(doc.abs(start), endAbs);
  }

  /** Whole lines; the cursor keeps its column unless `col` is given */
  private yankLines(
    startLine: number,
    endLine: number,
    col = this.cursor.col,
  ): HistoryActionResult {
    const text = `${this.doc.linesBetween(startLine, endLine).join("\n")}\n`;
    this.cursor = this.clampNormal({ line: startLine, col });
    return this.finishYank(text);
  }

  private finishYank(text: string): HistoryActionResult {
    this.mode = "normal";
    this.clearPending();
    this.curswant = this.cellOf(this.cursor);
    return { yank: text };
  }
}
