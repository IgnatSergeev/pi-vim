import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type HistoryActionResult,
  HistoryPane,
  type HistoryView,
} from "../history-pane.js";
import { CTRL_C, CTRL_D, CTRL_E, CTRL_F, CTRL_U } from "../types.js";
import type { VisualPosition } from "../visual.js";

const ESC = "\x1b";
const ENTER = "\r";
const BACKSPACE = "\x7f";

function buffer(
  lines: readonly (string | null)[],
  view = { top: 0, height: 100 },
) {
  return { lines, view };
}

function open(
  buf: { lines: readonly (string | null)[]; view: HistoryView },
  start?: VisualPosition,
): HistoryPane {
  return new HistoryPane(buf.lines, buf.view, start);
}

/** Feed keys, returning the last result and every yank on the way */
function press(
  pane: HistoryPane,
  buf: ReturnType<typeof buffer>,
  keys: string[],
): { last: HistoryActionResult; yanks: string[] } {
  let last: HistoryActionResult = {};
  const yanks: string[] = [];
  for (const key of keys) {
    last = pane.handleKey(key, buf.lines, buf.view);
    if (last.yank !== undefined) yanks.push(last.yank);
  }
  return { last, yanks };
}

const NUMBERED = Array.from({ length: 40 }, (_, i) => `line ${i}`);

describe("history pane: entering", () => {
  it("starts on the last visible text line at its first non-blank", () => {
    const buf = buffer(["one", "  two", null, null], { top: 0, height: 4 });
    const pane = open(buf);
    assert.deepEqual(pane.getCursor(), { line: 1, col: 2 });
    assert.equal(pane.getMode(), "normal");
  });

  it("clamps an explicit start past the end of its line", () => {
    const pane = open(buffer(["abc"]), { line: 0, col: 9 });
    assert.deepEqual(pane.getCursor(), { line: 0, col: 2 });
  });
});

describe("history pane: Escape and Ctrl-C", () => {
  for (const key of [ESC, CTRL_C]) {
    it(`${JSON.stringify(key)} in normal mode is handed to Pi`, () => {
      const buf = buffer(["abc"]);
      const pane = open(buf, { line: 0, col: 0 });
      assert.deepEqual(pane.handleKey(key, buf.lines, buf.view), {
        forward: true,
      });
      assert.equal(pane.getMode(), "normal");
    });

    it(`${JSON.stringify(key)} leaves visual mode in place`, () => {
      const buf = buffer(["abc def"]);
      const pane = open(buf, { line: 0, col: 0 });
      press(pane, buf, ["v", "w"]);
      assert.deepEqual(pane.handleKey(key, buf.lines, buf.view), {});
      assert.equal(pane.getMode(), "normal");
      assert.deepEqual(pane.getCursor(), { line: 0, col: 4 });
    });
  }

  it("Escape clears a pending count instead of reaching Pi", () => {
    const buf = buffer(NUMBERED);
    const pane = open(buf, { line: 0, col: 0 });
    assert.deepEqual(press(pane, buf, ["3", ESC]).last, {});
    press(pane, buf, ["j"]);
    assert.deepEqual(pane.getCursor(), { line: 1, col: 0 });
  });
});

describe("history pane: operators", () => {
  it("a visual yank reports the text and returns to normal mode", () => {
    const buf = buffer(["abc def"]);
    const pane = open(buf, { line: 0, col: 4 });
    assert.deepEqual(press(pane, buf, ["v", "e", "y"]).last, { yank: "def" });
    assert.equal(pane.getMode(), "normal");
    assert.deepEqual(pane.getCursor(), { line: 0, col: 4 });
  });

  it("keeps navigating after a yank", () => {
    const buf = buffer(["abc def", "ghi"]);
    const pane = open(buf, { line: 0, col: 0 });
    assert.deepEqual(press(pane, buf, ["y", "w", "j", "y", "y"]).yanks, [
      "abc ",
      "ghi\n",
    ]);
  });

  it("read-only: i, a and q do nothing", () => {
    const buf = buffer(["abc"]);
    const pane = open(buf, { line: 0, col: 1 });
    for (const key of ["i", "a", "q"]) {
      assert.deepEqual(pane.handleKey(key, buf.lines, buf.view), {});
    }
    assert.deepEqual(pane.getCursor(), { line: 0, col: 1 });
    assert.equal(pane.getMode(), "normal");
  });
});

describe("history pane: idle", () => {
  it("is idle only in normal mode with nothing typed", () => {
    const buf = buffer(["abc"]);
    const pane = open(buf, { line: 0, col: 0 });
    assert.equal(pane.isIdle(), true);
    for (const keys of [["2"], ["y"], ["g"], ["/"], ["v"]]) {
      press(pane, buf, keys);
      assert.equal(pane.isIdle(), false, keys.join(""));
      press(pane, buf, [ESC]);
      assert.equal(pane.isIdle(), true);
    }
  });
});

describe("history pane: intentional vim differences", () => {
  it("Y yanks whole lines like vim's yy, not nvim's y$ mapping", () => {
    const buf = buffer(["abc def", "ghi"]);
    const pane = open(buf, { line: 0, col: 4 });
    assert.deepEqual(press(pane, buf, ["2", "Y"]).yanks, ["abc def\nghi\n"]);
  });

  it("an empty yank keeps the register", () => {
    const buf = buffer(["abc"]);
    const pane = open(buf, { line: 0, col: 0 });
    assert.deepEqual(press(pane, buf, ["y", "h"]).last, {});
    assert.equal(pane.getMode(), "normal");
    assert.equal(pane.getLabel(), " NORMAL ");
  });

  it("search is literal and smartcase", () => {
    const buf = buffer(["Alpha a.c", "abc ALPHA"]);
    const pane = open(buf, { line: 0, col: 0 });
    press(pane, buf, ["/", "a", "l", "p", "h", "a", ENTER]);
    assert.deepEqual(pane.getCursor(), { line: 1, col: 4 });
    press(pane, buf, ["/", "A", "l", "p", "h", "a", ENTER]);
    assert.deepEqual(pane.getCursor(), { line: 0, col: 0 });
    press(pane, buf, ["/", "a", ".", "c", ENTER]);
    assert.deepEqual(pane.getCursor(), { line: 0, col: 6 });
  });
});

describe("history pane: counts", () => {
  it("clamps huge counts", () => {
    const buf = buffer(NUMBERED);
    const pane = open(buf, { line: 0, col: 0 });
    press(pane, buf, ["9", "9", "9", "9", "9", "9", "j"]);
    assert.deepEqual(pane.getCursor(), { line: 39, col: 0 });
  });

  it("does not leak a count into the next motion", () => {
    const buf = buffer(NUMBERED);
    const pane = open(buf, { line: 0, col: 0 });
    press(pane, buf, ["3", "j", "j"]);
    assert.deepEqual(pane.getCursor(), { line: 4, col: 0 });
  });

  it("multiplies counts around the operator", () => {
    const buf = buffer(["a b c d e f g"]);
    const pane = open(buf, { line: 0, col: 0 });
    assert.deepEqual(press(pane, buf, ["2", "y", "3", "w"]).yanks, [
      "a b c d e f ",
    ]);
  });

  it("discards a count typed before v", () => {
    const buf = buffer(NUMBERED);
    const pane = open(buf, { line: 0, col: 0 });
    press(pane, buf, ["3", "v", "j"]);
    assert.deepEqual(pane.getCursor(), { line: 1, col: 0 });
  });
});

describe("history pane: graphemes and screen columns", () => {
  it("h and l step over whole emoji", () => {
    const buf = buffer(["a👍🏽b"]);
    const pane = open(buf, { line: 0, col: 0 });
    press(pane, buf, ["l"]);
    assert.deepEqual(pane.getCursor(), { line: 0, col: 1 });
    press(pane, buf, ["l"]);
    assert.deepEqual(pane.getCursor(), { line: 0, col: 5 });
    press(pane, buf, ["h"]);
    assert.deepEqual(pane.getCursor(), { line: 0, col: 1 });
  });

  it("j keeps the screen column across wide characters", () => {
    const buf = buffer(["日本語", "abcdefgh", "日本語"]);
    const pane = open(buf, { line: 0, col: 1 });
    press(pane, buf, ["j"]);
    assert.deepEqual(pane.getCursor(), { line: 1, col: 2 });
    press(pane, buf, ["l", "j"]);
    assert.deepEqual(pane.getCursor(), { line: 2, col: 1 });
  });

  it("a visual yank takes the whole last grapheme", () => {
    const buf = buffer(["x 👍🏽 y"]);
    const pane = open(buf, { line: 0, col: 0 });
    assert.deepEqual(press(pane, buf, ["v", "l", "l", "y"]).yanks, ["x 👍🏽"]);
  });
});

describe("history pane: viewport", () => {
  const view = { top: 10, height: 6 };

  it("H, M and L are relative to the visible window", () => {
    const buf = buffer(NUMBERED, view);
    const pane = open(buf, { line: 12, col: 0 });
    press(pane, buf, ["H"]);
    assert.equal(pane.getCursor().line, 10);
    press(pane, buf, ["L"]);
    assert.equal(pane.getCursor().line, 15);
    press(pane, buf, ["M"]);
    assert.equal(pane.getCursor().line, 12);
    press(pane, buf, ["2", "H"]);
    assert.equal(pane.getCursor().line, 11);
  });

  it("Ctrl-D and Ctrl-U scroll half a page with the cursor", () => {
    const buf = buffer(NUMBERED, view);
    const pane = open(buf, { line: 12, col: 0 });
    assert.deepEqual(press(pane, buf, [CTRL_D]).last, { scrollTop: 13 });
    assert.equal(pane.getCursor().line, 15);
    assert.deepEqual(press(pane, buf, [CTRL_U]).last, { scrollTop: 7 });
    assert.equal(pane.getCursor().line, 12);
  });

  it("Ctrl-E scrolls and drags the cursor into view", () => {
    const buf = buffer(NUMBERED, view);
    const pane = open(buf, { line: 10, col: 0 });
    assert.deepEqual(press(pane, buf, ["2", CTRL_E]).last, { scrollTop: 12 });
    assert.equal(pane.getCursor().line, 12);
  });

  it("scrolling stops at the end of the transcript", () => {
    const buf = buffer(NUMBERED, { top: 34, height: 6 });
    const pane = open(buf, { line: 36, col: 0 });
    assert.deepEqual(press(pane, buf, [CTRL_F]).last, { scrollTop: 34 });
  });

  it("zt, zz and zb place the cursor line", () => {
    const buf = buffer(NUMBERED, view);
    const pane = open(buf, { line: 20, col: 0 });
    assert.deepEqual(press(pane, buf, ["z", "t"]).last, { scrollTop: 20 });
    assert.deepEqual(press(pane, buf, ["z", "z"]).last, { scrollTop: 17 });
    assert.deepEqual(press(pane, buf, ["z", "b"]).last, { scrollTop: 15 });
  });

  it("followView pulls the cursor into a view that scrolled away", () => {
    const buf = buffer(NUMBERED, view);
    const pane = open(buf, { line: 12, col: 3 });
    pane.setView({ top: 30, height: 6 });
    pane.followView();
    assert.deepEqual(pane.getCursor(), { line: 30, col: 3 });
  });

  it("update clamps positions when the transcript shrinks", () => {
    const buf = buffer(NUMBERED);
    const pane = open(buf, { line: 30, col: 5 });
    pane.update(["short", "x"], { top: 0, height: 100 });
    assert.deepEqual(pane.getCursor(), { line: 1, col: 0 });
  });
});

describe("history pane: search", () => {
  it("reports a missing pattern and keeps the cursor", () => {
    const buf = buffer(["abc"]);
    const pane = open(buf, { line: 0, col: 1 });
    const { last } = press(pane, buf, ["/", "z", "z", ENTER]);
    assert.deepEqual(last, { notify: "Pattern not found: zz" });
    assert.deepEqual(pane.getCursor(), { line: 0, col: 1 });
  });

  it("an empty query repeats the last search", () => {
    const buf = buffer(["ab ab ab"]);
    const pane = open(buf, { line: 0, col: 0 });
    press(pane, buf, ["/", "a", "b", ENTER, "/", ENTER]);
    assert.deepEqual(pane.getCursor(), { line: 0, col: 6 });
  });

  it("Backspace edits the query and cancels it when empty", () => {
    const buf = buffer(["abc"]);
    const pane = open(buf, { line: 0, col: 0 });
    press(pane, buf, ["/", "x", BACKSPACE]);
    assert.equal(pane.getLabel(), " NORMAL /_ ");
    press(pane, buf, [BACKSPACE]);
    assert.equal(pane.getLabel(), " NORMAL ");
    press(pane, buf, ["l"]);
    assert.deepEqual(pane.getCursor(), { line: 0, col: 1 });
  });
});

describe("history pane: label and selection", () => {
  it("names the sub-mode and shows pending keys", () => {
    const buf = buffer(["abc def"]);
    const pane = open(buf, { line: 0, col: 0 });
    assert.equal(pane.getLabel(), " NORMAL ");
    press(pane, buf, ["2", "y", "3"]);
    assert.equal(pane.getLabel(), " NORMAL 2y3_ ");
    press(pane, buf, [ESC, "g"]);
    assert.equal(pane.getLabel(), " NORMAL g_ ");
    press(pane, buf, [ESC, "v"]);
    assert.equal(pane.getLabel(), " VISUAL ");
    press(pane, buf, ["f"]);
    assert.equal(pane.getLabel(), " VISUAL f_ ");
    press(pane, buf, [ESC, "V"]);
    assert.equal(pane.getLabel(), " V-LINE ");
    press(pane, buf, ["?", "d"]);
    assert.equal(pane.getLabel(), " V-LINE ?d_ ");
  });

  it("reports the anchor and cursor of a selection", () => {
    const buf = buffer(["abc", "def"]);
    const pane = open(buf, { line: 1, col: 2 });
    press(pane, buf, ["v", "k", "0"]);
    assert.deepEqual(pane.getAnchor(), { line: 1, col: 2 });
    assert.deepEqual(pane.getCursor(), { line: 0, col: 0 });
    press(pane, buf, ["o"]);
    assert.deepEqual(pane.getAnchor(), { line: 0, col: 0 });
    assert.deepEqual(pane.getCursor(), { line: 1, col: 2 });
    press(pane, buf, ["V"]);
    assert.equal(pane.getMode(), "visual-line");
  });
});

describe("history pane: following new output", () => {
  it("a plain G follows lines that arrive later", () => {
    const pane = open(buffer(["a", "b"]), { line: 0, col: 0 });
    press(pane, buffer(["a", "b"]), ["G"]);
    assert.equal(pane.isFollowingEnd(), true);
    pane.update(["a", "b", "c", "d"], { top: 0, height: 100 });
    assert.deepEqual(pane.getCursor(), { line: 3, col: 0 });
  });

  it("a counted G, gg and other motions do not follow", () => {
    const buf = buffer(["a", "b", "c"]);
    for (const keys of [
      ["3", "G"],
      ["g", "g"],
      ["j", "j"],
    ]) {
      const pane = open(buf, { line: 0, col: 0 });
      press(pane, buf, keys);
      assert.equal(pane.isFollowingEnd(), false, keys.join(""));
    }
  });

  it("moving off the last line or scrolling stops following", () => {
    const buf = buffer(NUMBERED, { top: 0, height: 6 });
    for (const keys of [["k"], [CTRL_U], ["z", "z"]]) {
      const pane = open(buf, { line: 0, col: 0 });
      press(pane, buf, ["G", ...keys]);
      assert.equal(pane.isFollowingEnd(), false, keys.join(""));
    }
  });

  it("keys that stay on the last line keep following", () => {
    const buf = buffer(["abc def", "ghi jkl"]);
    const pane = open(buf, { line: 0, col: 0 });
    press(pane, buf, ["G", "w", "v", "y"]);
    assert.equal(pane.isFollowingEnd(), true);
  });

  it("a visual selection grows with new output while following", () => {
    const buf = buffer(["a", "b"]);
    const pane = open(buf, { line: 0, col: 0 });
    press(pane, buf, ["v", "G"]);
    pane.update(["a", "b", "c"], buf.view);
    assert.deepEqual(pane.getAnchor(), { line: 0, col: 0 });
    assert.deepEqual(pane.getCursor(), { line: 2, col: 0 });
  });

  it("followEnd moves to the last line and follows", () => {
    const buf = buffer(NUMBERED);
    const pane = open(buf, { line: 3, col: 0 });
    pane.followEnd();
    assert.deepEqual(pane.getCursor(), { line: 39, col: 0 });
    assert.equal(pane.isFollowingEnd(), true);
  });
});

describe("history pane: decoration lines (intentional vim difference)", () => {
  // null marks decoration, as the viewport reports it: pi's rules, a framed
  // user message's edges, the gaps between messages. The empty line inside
  // the message and the one inside the answer are text.
  const TRANSCRIPT = [
    null,
    null,
    " question",
    "",
    " more",
    null,
    null,
    " answer one",
    "",
    " answer two",
    null,
  ];

  it("j and k step over decoration but stop on empty text lines", () => {
    const buf = buffer(TRANSCRIPT);
    const pane = open(buf, { line: 2, col: 1 });
    for (const line of [3, 4, 7, 8, 9]) {
      press(pane, buf, ["j"]);
      assert.equal(pane.getCursor().line, line);
    }
    press(pane, buf, ["3", "k"]);
    assert.equal(pane.getCursor().line, 4);
    press(pane, buf, ["9", "k"]);
    assert.equal(pane.getCursor().line, 2);
    assert.deepEqual(press(pane, buf, ["k"]).last, {});
  });

  it("gg, G, H, M and L land on text", () => {
    const buf = buffer(TRANSCRIPT, { top: 0, height: 11 });
    const pane = open(buf, { line: 4, col: 0 });
    for (const [keys, line] of [
      [["G"], 9],
      [["g", "g"], 2],
      [["L"], 9],
      [["H"], 2],
      [["M"], 7],
    ] as const) {
      press(pane, buf, [...keys]);
      assert.equal(pane.getCursor().line, line, keys.join(""));
    }
  });

  it("} stops on an empty text line like vim, and skips decoration", () => {
    const buf = buffer(TRANSCRIPT);
    const pane = open(buf, { line: 2, col: 1 });
    press(pane, buf, ["}"]);
    assert.deepEqual(pane.getCursor(), { line: 3, col: 0 });
    press(pane, buf, ["}"]);
    assert.deepEqual(pane.getCursor(), { line: 7, col: 1 });
    press(pane, buf, ["{"]);
    assert.deepEqual(pane.getCursor(), { line: 3, col: 0 });
  });

  it("w and b skip decoration lines", () => {
    const buf = buffer(TRANSCRIPT);
    const pane = open(buf, { line: 4, col: 1 });
    press(pane, buf, ["w"]);
    assert.deepEqual(pane.getCursor(), { line: 7, col: 1 });
    press(pane, buf, ["b"]);
    assert.deepEqual(pane.getCursor(), { line: 4, col: 1 });
  });

  it("the start position skips trailing decoration", () => {
    const pane = open(buffer(TRANSCRIPT, { top: 0, height: 11 }));
    assert.deepEqual(pane.getCursor(), { line: 9, col: 1 });
  });

  it("yanks drop decoration, keeping one empty line between messages", () => {
    const buf = buffer(TRANSCRIPT);
    const pane = open(buf, { line: 2, col: 0 });
    assert.deepEqual(press(pane, buf, ["V", "G", "y"]).yanks, [
      " question\n\n more\n\n answer one\n\n answer two\n",
    ]);
    assert.deepEqual(press(pane, buf, ["j", "v", "j", "j", "$", "y"]).yanks, [
      "\n more\n\n answer one\n",
    ]);
  });

  it("following new output sticks to the last text line", () => {
    const buf = buffer(TRANSCRIPT);
    const pane = open(buf, { line: 2, col: 0 });
    press(pane, buf, ["G"]);
    pane.update([...TRANSCRIPT, null, " answer three", null], buf.view);
    assert.equal(pane.getCursor().line, 12);
  });

  it("a scrolled view pulls the cursor onto text inside it", () => {
    const pane = open(buffer(TRANSCRIPT), { line: 2, col: 0 });
    pane.setView({ top: 5, height: 4 });
    pane.followView();
    assert.equal(pane.getCursor().line, 7);
  });
});
