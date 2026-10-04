import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HistoryViewport,
  markContent,
  stripTerminalSequences,
} from "../history-viewport.js";
import { createFakeAltScreen } from "./harness.js";

describe("stripTerminalSequences", () => {
  it("drops SGR, OSC 8 hyperlinks and APC markers", () => {
    assert.equal(
      stripTerminalSequences(
        "\x1b[1mbold\x1b[0m \x1b]8;;https://x\x07link\x1b]8;;\x07\x1b_pi:c\x07!",
      ),
      "bold link!",
    );
  });

  it("keeps a lone escape it cannot parse", () => {
    assert.equal(stripTerminalSequences("a\x1b"), "a\x1b");
  });
});

describe("HistoryViewport", () => {
  it("attaches only to the fullscreen TUI", () => {
    assert.equal(HistoryViewport.attach({ mode: "regular" }), null);
    assert.equal(HistoryViewport.attach(null), null);
    assert.equal(HistoryViewport.attach(createFakeAltScreen([])), null);
    assert.ok(HistoryViewport.attach(createFakeAltScreen(["x"])));
  });

  it("reads transcript lines without styling and padding", () => {
    const tui = createFakeAltScreen([" \x1b[31mred\x1b[0m   ", "plain"]);
    const viewport = HistoryViewport.attach(tui);
    assert.deepEqual(viewport?.lines(), [" red", "plain"]);
  });

  it("pins the view on attach and leaves it pinned on detach", () => {
    const tui = createFakeAltScreen(["a", "b", "c"], { top: 1, height: 2 });
    const scrollView = tui.currentLayout.primaryScrollView;
    const viewport = HistoryViewport.attach(tui);
    assert.deepEqual(scrollView.scrollCalls, [{ top: 1, disableFollow: true }]);
    assert.equal(scrollView.isFollowingEnd, false);
    viewport?.detach();
    assert.equal(scrollView.isFollowingEnd, false);
    assert.equal(scrollView.scrollTop, 1);
  });

  it("follows new output on detach when asked to", () => {
    const tui = createFakeAltScreen(["a", "b", "c"], {
      top: 0,
      height: 2,
      following: false,
    });
    HistoryViewport.attach(tui)?.detach(true);
    assert.equal(tui.currentLayout.primaryScrollView.isFollowingEnd, true);
  });

  it("reveal scrolls just enough to show the line", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `${i}`);
    const tui = createFakeAltScreen(lines, { top: 10, height: 5 });
    const viewport = HistoryViewport.attach(tui);
    viewport?.reveal(20);
    assert.equal(viewport?.view().top, 16);
    viewport?.reveal(3);
    assert.equal(viewport?.view().top, 3);
    viewport?.reveal(5, 0);
    assert.equal(viewport?.view().top, 1);
  });

  it("paints a character-wise selection in cell columns", () => {
    const tui = createFakeAltScreen(["日本 ab", "x"]);
    const viewport = HistoryViewport.attach(tui);
    const scrollView = tui.currentLayout.primaryScrollView;
    viewport?.paint("visual", { line: 0, col: 3 }, { line: 0, col: 1 });
    assert.deepEqual(tui.selectionAnchor, { scrollView, row: 0, col: 2 });
    assert.deepEqual(tui.selectionFocus, {
      scrollView,
      row: 0,
      col: 6,
      boundary: true,
    });
  });

  it("paints the normal-mode cursor, ignoring the anchor", () => {
    const tui = createFakeAltScreen(["abc", "def"]);
    const viewport = HistoryViewport.attach(tui);
    viewport?.paint("normal", { line: 0, col: 0 }, { line: 1, col: 2 });
    const from = tui.selectionAnchor as { row: number; col: number };
    const to = tui.selectionFocus as { row: number; col: number };
    assert.deepEqual([from.row, from.col, to.row, to.col], [1, 2, 1, 3]);
  });

  it("paints a cursor on an empty line as one cell", () => {
    const tui = createFakeAltScreen(["", "x"]);
    const viewport = HistoryViewport.attach(tui);
    viewport?.paint("normal", { line: 0, col: 0 }, { line: 0, col: 0 });
    assert.equal((tui.selectionFocus as { col: number }).col, 1);
  });

  it("paints a line-wise selection up to the last character", () => {
    const tui = createFakeAltScreen(["ab", "c日  "]);
    const viewport = HistoryViewport.attach(tui);
    viewport?.paint("visual-line", { line: 1, col: 1 }, { line: 0, col: 1 });
    assert.equal((tui.selectionAnchor as { col: number }).col, 0);
    assert.equal((tui.selectionFocus as { row: number }).row, 1);
    assert.equal((tui.selectionFocus as { col: number }).col, 3);
  });

  it("paints a line-wise selection ending on an empty line as one cell", () => {
    const tui = createFakeAltScreen(["ab", ""]);
    const viewport = HistoryViewport.attach(tui);
    viewport?.paint("visual-line", { line: 0, col: 0 }, { line: 1, col: 0 });
    assert.equal((tui.selectionFocus as { col: number }).col, 1);
  });

  it("skips repainting an unchanged selection", () => {
    const tui = createFakeAltScreen(["ab"]);
    const viewport = HistoryViewport.attach(tui);
    const cursor = { line: 0, col: 0 };
    viewport?.paint("normal", cursor, cursor);
    const anchor = tui.selectionAnchor;
    const renders = tui.renders;
    viewport?.paint("normal", cursor, cursor);
    assert.equal(tui.selectionAnchor, anchor);
    assert.equal(tui.renders, renders);
  });

  it("restores a selection a mouse click cleared", () => {
    const tui = createFakeAltScreen(["ab"]);
    const viewport = HistoryViewport.attach(tui);
    const cursor = { line: 0, col: 0 };
    viewport?.paint("normal", cursor, cursor);
    tui.selectionAnchor = undefined;
    tui.selectionFocus = undefined;
    viewport?.paint("normal", cursor, cursor, false);
    assert.ok(tui.selectionAnchor);
  });

  it("detach clears its own selection but not a newer mouse selection", () => {
    const tui = createFakeAltScreen(["ab"]);
    const cursor = { line: 0, col: 1 };
    const own = HistoryViewport.attach(tui);
    own?.paint("normal", cursor, cursor);
    own?.detach();
    assert.equal(tui.selectionAnchor, undefined);

    const other = HistoryViewport.attach(tui);
    other?.paint("normal", cursor, cursor);
    const mouse = { row: 0, col: 0 };
    tui.selectionAnchor = mouse;
    other?.detach();
    assert.equal(tui.selectionAnchor, mouse);
  });
});

describe("markContent", () => {
  // Stand-ins named like pi-tui's components; only names and shapes matter
  class Text {
    constructor(
      private readonly text: string,
      private readonly pad = 0,
    ) {}
    render(width: number) {
      const rows = this.text.split("\n").map((l) => ` ${l}`.padEnd(width));
      const blank = " ".repeat(width);
      return [
        ...Array(this.pad).fill(blank),
        ...rows,
        ...Array(this.pad).fill(blank),
      ];
    }
  }
  class Spacer {
    render() {
      return [""];
    }
  }
  class DynamicBorder {
    render(width: number) {
      return ["─".repeat(width)];
    }
  }
  class Container {
    constructor(readonly children: object[]) {}
    render(width: number): string[] {
      return this.children.flatMap((c) =>
        (c as { render(w: number): string[] }).render(width),
      );
    }
  }
  class Box extends Container {
    readonly paddingX = 2;
    render(width: number): string[] {
      const inner = super.render(width - 4).map((l) => `  ${l}  `);
      return ["", ...inner, ""];
    }
  }
  /** pi-zentui: draws rules over the box's padding rows */
  class FramedMessage extends Container {
    render(width: number): string[] {
      const rows = super.render(width);
      const rule = "─".repeat(width);
      return [rule, ...rows.slice(1, -1), rule];
    }
  }

  const mark = (component: object) =>
    markContent(component as Parameters<typeof markContent>[0], 30).mask;

  it("marks spacers and rules as decoration", () => {
    assert.deepEqual(mark(new Container([new Spacer(), new DynamicBorder()])), [
      false,
      false,
    ]);
  });

  it("keeps empty lines inside text and drops a leaf's edge padding", () => {
    // pi's bash output: a Text starting with "\n"
    assert.deepEqual(mark(new Text("\nalpha\n\nbeta", 1)), [
      false,
      false,
      true,
      true,
      true,
      false,
    ]);
  });

  it("marks a box's padding, also when an extension overdraws it", () => {
    const message = new FramedMessage([new Box([new Text("hello\n\nworld")])]);
    assert.deepEqual(mark(message), [false, true, true, true, false]);
  });

  it("falls back to the leaf rule when a parent rewrote its children", () => {
    class Rewriter extends Container {
      render(width: number) {
        return ["", "something else".padEnd(width), ""];
      }
    }
    assert.deepEqual(mark(new Rewriter([new Text("hello")])), [
      false,
      true,
      false,
    ]);
  });

  it("follows single-child wrappers such as MouseRegion", () => {
    class MouseRegion {
      constructor(readonly child: object) {}
      render(width: number) {
        return (this.child as Text).render(width);
      }
    }
    assert.deepEqual(
      mark(new Container([new Spacer(), new MouseRegion(new DynamicBorder())])),
      [false, false],
    );
  });
});

describe("HistoryViewport decoration", () => {
  it("reports decoration lines as null from the component tree", () => {
    const document = {
      children: [
        { render: () => [""] },
        { render: (w: number) => [" text".padEnd(w)] },
      ],
      render(w: number) {
        return this.children.flatMap((c) => c.render(w));
      },
    };
    const tui = createFakeAltScreen(["", " text"]);
    Object.assign(tui.currentLayout.primaryScrollView, {
      child: document,
      getContentWidth: (w: number) => w,
    });
    Object.assign(tui.currentLayout.root.children[0] as object, {
      rect: { width: 20 },
    });
    assert.deepEqual(HistoryViewport.attach(tui)?.lines(), [null, " text"]);
  });

  it("treats every line as text when the tree does not match the lines", () => {
    const tui = createFakeAltScreen(["", " text"]);
    Object.assign(tui.currentLayout.primaryScrollView, {
      child: { render: () => ["only one line"] },
    });
    Object.assign(tui.currentLayout.root.children[0] as object, {
      rect: { width: 20 },
    });
    assert.deepEqual(HistoryViewport.attach(tui)?.lines(), ["", " text"]);
  });
});
