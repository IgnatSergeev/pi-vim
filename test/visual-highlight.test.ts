import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { highlightLayoutLine, mapLayoutLines } from "../visual-highlight.js";

describe("highlightLayoutLine", () => {
  it("wraps every selected grapheme on its own", () => {
    const result = highlightLayoutLine({ text: "abc", hasCursor: false }, 0, {
      start: 0,
      end: 2,
    });
    assert.equal(
      result.text,
      "\x1b[48;2;45;63;118ma\x1b[0m\x1b[48;2;45;63;118mb\x1b[0mc",
    );
  });

  it("leaves the cursor grapheme to the host and remaps cursorPos", () => {
    const result = highlightLayoutLine(
      { text: "abc", hasCursor: true, cursorPos: 2 },
      0,
      { start: 0, end: 3 },
    );
    // The cursor grapheme is unwrapped, and cursorPos points at its first byte
    // so the host still slices a real grapheme there.
    assert.equal(result.text.slice(result.cursorPos ?? -1), "c");
  });

  it("moves an end-of-line cursor to the new end of the text", () => {
    const result = highlightLayoutLine(
      { text: "ab", hasCursor: true, cursorPos: 2 },
      0,
      { start: 0, end: 2 },
    );
    assert.equal(result.cursorPos, result.text.length);
  });

  it("offsets the selection by the chunk's column", () => {
    const result = highlightLayoutLine({ text: "cd", hasCursor: false }, 2, {
      start: 3,
      end: 4,
    });
    assert.equal(result.text, "c\x1b[48;2;45;63;118md\x1b[0m");
  });

  it("returns the line untouched when nothing intersects", () => {
    const line = { text: "abc", hasCursor: false };
    assert.equal(highlightLayoutLine(line, 0, { start: 5, end: 7 }), line);
  });
});

describe("mapLayoutLines", () => {
  const fits = (width: number) => (line: string) => line.length <= width;

  it("maps unwrapped lines one to one", () => {
    assert.deepEqual(
      mapLayoutLines(
        [
          { text: "one", hasCursor: false },
          { text: "two", hasCursor: true, cursorPos: 0 },
        ],
        ["one", "two"],
        fits(10),
      ),
      [
        { line: 0, offset: 0 },
        { line: 1, offset: 0 },
      ],
    );
  });

  it("re-derives the column offset of wrapped chunks", () => {
    assert.deepEqual(
      mapLayoutLines(
        [
          { text: "aaa", hasCursor: false },
          { text: "bbb", hasCursor: false },
          { text: "cc", hasCursor: false },
        ],
        ["aaa bbb", "cc"],
        fits(3),
      ),
      [
        { line: 0, offset: 0 },
        { line: 0, offset: 4 },
        { line: 1, offset: 0 },
      ],
    );
  });

  it("returns null when the walk cannot be reconciled", () => {
    assert.equal(
      mapLayoutLines([{ text: "zzz", hasCursor: false }], ["abc"], fits(10)),
      null,
    );
    assert.equal(
      mapLayoutLines(
        [
          { text: "abc", hasCursor: false },
          { text: "leftover", hasCursor: false },
        ],
        ["abc"],
        fits(10),
      ),
      null,
    );
  });
});
