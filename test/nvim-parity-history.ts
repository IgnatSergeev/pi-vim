import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HistoryPane } from "../history-pane.js";
import {
  type NvimParityCase,
  type NvimParitySnapshot,
  runNvimParityCase,
} from "./nvim-oracle.js";

// The history pane is read-only: nvim runs the same keys on the same buffer
// and the text never changes, so parity covers cursor, mode and the yanked
// text. The pane shares pi-vim's modes, so they compare directly. Decoration
// lines (null) have no vim counterpart; they are covered in
// history-pane.test.ts.

function runHistoryParityCase(testCase: NvimParityCase): NvimParitySnapshot {
  const lines = testCase.initial.text.split("\n");
  const view = { top: 0, height: 100 };
  const pane = new HistoryPane(lines, view, testCase.initial.cursor);
  let register = testCase.initial.register ?? "";
  for (const key of testCase.keys) {
    const result = pane.handleKey(key, lines, view);
    if (result.yank !== undefined) register = result.yank;
  }
  return {
    text: testCase.initial.text,
    cursor: pane.getCursor(),
    mode: pane.getMode(),
    register,
  };
}

async function assertHistoryMatchesNvim(testCase: NvimParityCase) {
  const nvim = await runNvimParityCase(testCase);
  assert.deepEqual(runHistoryParityCase(testCase), nvim);
}

const PROSE =
  "alpha beta gamma\n  delta, epsilon\n\nzeta (eta theta) iota\nkappa";

const MOTION_CASES: NvimParityCase[] = [
  {
    name: "j keeps the desired column past an empty line",
    initial: { text: PROSE, cursor: { line: 1, col: 9 } },
    keys: ["j", "j"],
  },
  {
    name: "H, M and L keep the column",
    initial: { text: PROSE, cursor: { line: 0, col: 3 } },
    keys: ["L", "M"],
  },
  {
    name: "} stops on the empty line",
    initial: { text: PROSE, cursor: { line: 0, col: 3 } },
    keys: ["}"],
  },
  {
    name: "{ from the last paragraph stops on the empty line",
    initial: { text: PROSE, cursor: { line: 4, col: 2 } },
    keys: ["{"],
  },
  {
    name: "h/l move by grapheme and stop at the line edges",
    initial: { text: PROSE, cursor: { line: 0, col: 1 } },
    keys: ["3", "h", "2", "0", "l"],
  },
  {
    name: "j/k keep the desired column across short lines",
    initial: { text: "abcdefgh\nab\nabcdefgh", cursor: { line: 0, col: 6 } },
    keys: ["j", "j"],
  },
  {
    name: "k on the first line does not move",
    initial: { text: PROSE, cursor: { line: 0, col: 3 } },
    keys: ["k"],
  },
  {
    name: "counted j is clamped to the last line",
    initial: { text: PROSE, cursor: { line: 1, col: 0 } },
    keys: ["9", "j"],
  },
  {
    name: "0, ^ and $",
    initial: { text: PROSE, cursor: { line: 1, col: 6 } },
    keys: ["0", "^"],
  },
  {
    name: "$ then j sticks to the line end",
    initial: { text: PROSE, cursor: { line: 0, col: 0 } },
    keys: ["$", "j"],
  },
  {
    name: "w crosses lines",
    initial: { text: PROSE, cursor: { line: 0, col: 11 } },
    keys: ["w"],
  },
  {
    name: "counted e and b",
    initial: { text: PROSE, cursor: { line: 1, col: 2 } },
    keys: ["3", "e", "b"],
  },
  {
    name: "W skips punctuation",
    initial: { text: PROSE, cursor: { line: 1, col: 2 } },
    keys: ["W"],
  },
  {
    name: "f, t, ; and ,",
    initial: { text: PROSE, cursor: { line: 3, col: 0 } },
    keys: ["f", "t", ";", ",", "t", "a"],
  },
  {
    name: "gg and G with counts keep the column",
    initial: { text: PROSE, cursor: { line: 0, col: 3 } },
    keys: ["2", "G", "g", "g", "G"],
  },
  {
    name: "} in the last paragraph goes to the last character",
    initial: { text: PROSE, cursor: { line: 3, col: 3 } },
    keys: ["}"],
  },
  {
    name: "% jumps to the matching paren",
    initial: { text: PROSE, cursor: { line: 3, col: 0 } },
    keys: ["%"],
  },
  {
    name: "/ searches forward and n repeats",
    initial: { text: PROSE, cursor: { line: 0, col: 0 } },
    keys: ["/", "e", "t", "a", "\r", "n"],
  },
  {
    name: "? searches backward and N reverses",
    initial: { text: PROSE, cursor: { line: 4, col: 0 } },
    keys: ["?", "t", "a", "\r", "N"],
  },
  {
    name: "search wraps around the end",
    initial: { text: PROSE, cursor: { line: 4, col: 0 } },
    keys: ["/", "a", "l", "p", "\r"],
  },
];

const YANK_CASES: NvimParityCase[] = [
  {
    name: "yy yanks the line",
    initial: { text: PROSE, cursor: { line: 1, col: 4 } },
    keys: ["y", "y"],
  },
  {
    name: "counted yy yanks several lines",
    initial: { text: PROSE, cursor: { line: 0, col: 4 } },
    keys: ["2", "y", "y"],
  },
  {
    name: "yk yanks up linewise and moves up",
    initial: { text: PROSE, cursor: { line: 1, col: 5 } },
    keys: ["y", "k"],
  },
  {
    name: "yw stops at the end of the line",
    initial: { text: PROSE, cursor: { line: 0, col: 11 } },
    keys: ["y", "w"],
  },
  {
    name: "y2w inside a line",
    initial: { text: PROSE, cursor: { line: 0, col: 0 } },
    keys: ["y", "2", "w"],
  },
  {
    name: "ye is inclusive",
    initial: { text: PROSE, cursor: { line: 0, col: 6 } },
    keys: ["y", "e"],
  },
  {
    name: "yb yanks backward and moves the cursor",
    initial: { text: PROSE, cursor: { line: 0, col: 8 } },
    keys: ["y", "b"],
  },
  {
    name: "y$ yanks to the end of the line",
    initial: { text: PROSE, cursor: { line: 3, col: 5 } },
    keys: ["y", "$"],
  },
  {
    name: "y0 yanks to the start of the line",
    initial: { text: PROSE, cursor: { line: 3, col: 5 } },
    keys: ["y", "0"],
  },
  {
    name: "yt) yanks up to the paren",
    initial: { text: PROSE, cursor: { line: 3, col: 6 } },
    keys: ["y", "t", ")"],
  },
  {
    name: "y} stops before the empty line",
    initial: { text: PROSE, cursor: { line: 0, col: 1 } },
    keys: ["y", "}"],
  },
  {
    name: "y} from column 0 becomes linewise",
    initial: { text: PROSE, cursor: { line: 0, col: 0 } },
    keys: ["y", "}"],
  },
  {
    name: "y} in the last paragraph yanks to the end",
    initial: { text: PROSE, cursor: { line: 4, col: 1 } },
    keys: ["y", "}"],
  },
  {
    name: "yG yanks to the last line",
    initial: { text: PROSE, cursor: { line: 3, col: 5 } },
    keys: ["y", "G"],
  },
  {
    name: "ygg yanks to the first line",
    initial: { text: PROSE, cursor: { line: 1, col: 5 } },
    keys: ["y", "g", "g"],
  },
  {
    name: "y% yanks the parenthesized span",
    initial: { text: PROSE, cursor: { line: 3, col: 5 } },
    keys: ["y", "%"],
  },
  {
    name: "yiw and yaw",
    initial: { text: PROSE, cursor: { line: 0, col: 7 } },
    keys: ["y", "a", "w"],
  },
  {
    name: "yi( yanks inside the parens",
    initial: { text: PROSE, cursor: { line: 3, col: 8 } },
    keys: ["y", "i", "("],
  },
  {
    name: "ya( yanks the parens too",
    initial: { text: PROSE, cursor: { line: 3, col: 8 } },
    keys: ["y", "a", "("],
  },
  {
    name: "Escape cancels a pending yank",
    initial: { text: PROSE, cursor: { line: 0, col: 0 }, register: "keep" },
    keys: ["y", "\x1b", "w"],
  },
];

const YANK_THEN_MOVE_CASES: NvimParityCase[] = [
  {
    name: "a yank stays in normal mode and the next motion starts from its start",
    initial: { text: PROSE, cursor: { line: 0, col: 8 } },
    keys: ["y", "i", "w", "w"],
  },
  {
    name: "a visual yank returns to normal mode for the next yank",
    initial: { text: PROSE, cursor: { line: 3, col: 4 } },
    keys: ["v", "e", "y", "j", "y", "y"],
  },
];

const VISUAL_CASES: NvimParityCase[] = [
  {
    name: "a selection ending on an empty line takes its line break",
    initial: { text: PROSE, cursor: { line: 1, col: 9 } },
    keys: ["v", "j", "y"],
  },
  {
    name: "v with motions extends the selection",
    initial: { text: PROSE, cursor: { line: 0, col: 2 } },
    keys: ["v", "e", "j"],
  },
  {
    name: "vey yanks the word",
    initial: { text: PROSE, cursor: { line: 0, col: 6 } },
    keys: ["v", "e", "y"],
  },
  {
    name: "backward selection yanks from the cursor",
    initial: { text: PROSE, cursor: { line: 1, col: 8 } },
    keys: ["v", "k", "y"],
  },
  {
    name: "v$y includes the line break",
    initial: { text: PROSE, cursor: { line: 0, col: 6 } },
    keys: ["v", "$", "y"],
  },
  {
    name: "v$y on the last line has no line break",
    initial: { text: PROSE, cursor: { line: 4, col: 1 } },
    keys: ["v", "$", "y"],
  },
  {
    name: "o swaps the selection ends",
    initial: { text: PROSE, cursor: { line: 0, col: 6 } },
    keys: ["v", "e", "o", "h", "y"],
  },
  {
    name: "Vjy yanks whole lines",
    initial: { text: PROSE, cursor: { line: 0, col: 6 } },
    keys: ["V", "j", "y"],
  },
  {
    name: "Y in a character-wise selection yanks whole lines",
    initial: { text: PROSE, cursor: { line: 0, col: 6 } },
    keys: ["v", "j", "Y"],
  },
  {
    name: "viw selects the word",
    initial: { text: PROSE, cursor: { line: 0, col: 7 } },
    keys: ["v", "i", "w", "y"],
  },
  {
    name: "vi( selects inside the parens",
    initial: { text: PROSE, cursor: { line: 3, col: 8 } },
    keys: ["v", "i", "(", "y"],
  },
  {
    name: "Escape leaves visual mode in place",
    initial: { text: PROSE, cursor: { line: 0, col: 2 } },
    keys: ["v", "w", "\x1b"],
  },
  {
    name: "V then v switches to character-wise",
    initial: { text: PROSE, cursor: { line: 0, col: 2 } },
    keys: ["V", "w", "v", "y"],
  },
  {
    name: "visual G and gg",
    initial: { text: PROSE, cursor: { line: 1, col: 3 } },
    keys: ["v", "G", "g", "g"],
  },
  {
    name: "emoji selection yanks whole graphemes",
    initial: { text: "a 👍🏽 b", cursor: { line: 0, col: 2 } },
    keys: ["v", "l", "y"],
  },
];

describe("nvim parity: history motions", () => {
  for (const testCase of MOTION_CASES) {
    it(testCase.name, async () => {
      await assertHistoryMatchesNvim(testCase);
    });
  }
});

describe("nvim parity: history yanks", () => {
  for (const testCase of YANK_CASES) {
    it(testCase.name, async () => {
      await assertHistoryMatchesNvim(testCase);
    });
  }
});

describe("nvim parity: history yank then move", () => {
  for (const testCase of YANK_THEN_MOVE_CASES) {
    it(testCase.name, async () => {
      await assertHistoryMatchesNvim(testCase);
    });
  }
});

describe("nvim parity: history visual mode", () => {
  for (const testCase of VISUAL_CASES) {
    it(testCase.name, async () => {
      await assertHistoryMatchesNvim(testCase);
    });
  }
});
