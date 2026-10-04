import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import installPiVim, { ModalEditor } from "../index.js";
import { KeymapRegistry, resolveLeaderTokens } from "../keymap.js";
import { setPiVimSettingsReaderForTests } from "../settings.js";
import type { Mode } from "../types.js";
import {
  createExtensionApiHarness,
  createFakeAltScreen,
  createMultiLineEditor,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

type EditorTui = ConstructorParameters<typeof ModalEditor>[0];

const ESC = "\x1b";
const CTRL_K = "\x0b";
const CTRL_J = "\n";
const KITTY_CTRL_K = "\x1b[107;5u";
const KITTY_CTRL_J = "\x1b[106;5u";
const TRANSCRIPT = [
  " \x1b[1mhello\x1b[0m world",
  "",
  " second answer line",
  " third",
];

function createEditor(tui: unknown = createFakeAltScreen(TRANSCRIPT)) {
  const editor = new ModalEditor(tui as EditorTui, stubTheme, stubKeybindings, {
    labelPlacement: "footer",
  });
  const clipboard: string[] = [];
  const notices: string[] = [];
  const statuses: (string | undefined)[] = [];
  const modeChanges: Array<[Mode, Mode]> = [];
  editor.setClipboardFn((text) => {
    clipboard.push(text);
  });
  editor.setClipboardReadFn(() => null);
  editor.setNotifyFn((message) => notices.push(message));
  editor.setStatusFn((label) => statuses.push(label));
  editor.setModeChangeFn((mode, prev) => modeChanges.push([mode, prev]));
  return { editor, clipboard, notices, statuses, modeChanges };
}

function type(editor: ModalEditor, keys: string[]): void {
  for (const key of keys) editor.handleInput(key);
}

/** Draft "draft" in the prompt, leave to normal mode */
function draft(editor: ModalEditor): void {
  type(editor, [..."draft", ESC]);
}

function renderedPrompt(editor: ModalEditor): string {
  return editor.render(40).join("\n");
}

describe("<C-k> and <C-j> move focus between prompt and transcript", () => {
  for (const [name, key] of [
    ["legacy", CTRL_K],
    ["Kitty", KITTY_CTRL_K],
  ]) {
    it(`${name} <C-k> in normal mode focuses the transcript`, () => {
      const { editor } = createEditor();
      draft(editor);
      type(editor, [key as string]);
      assert.equal(editor.getHistoryPaneMode(), "normal");
    });
  }

  for (const [name, key] of [
    ["legacy", CTRL_J],
    ["Kitty", KITTY_CTRL_J],
  ]) {
    it(`${name} <C-j> focuses the prompt in normal mode`, () => {
      const tui = createFakeAltScreen(TRANSCRIPT);
      const { editor } = createEditor(tui);
      draft(editor);
      type(editor, [CTRL_K, "v", key as string]);
      assert.equal(editor.getHistoryPaneMode(), null);
      assert.equal(editor.getMode(), "normal");
      assert.equal(tui.selectionAnchor, undefined);
      type(editor, ["x"]);
      assert.equal(editor.getText(), "draf");
    });
  }

  it("<C-k> in insert mode keeps Pi's own binding", () => {
    const { editor } = createEditor();
    type(editor, [..."draft", CTRL_K]);
    assert.equal(editor.getHistoryPaneMode(), null);
    assert.equal(editor.getMode(), "insert");
  });

  it("<C-k> from visual mode drops the prompt selection", () => {
    const { editor, modeChanges } = createEditor();
    draft(editor);
    type(editor, ["0", "v", "l", CTRL_K]);
    assert.equal(editor.getMode(), "normal");
    assert.equal(editor.getHistoryPaneMode(), "normal");
    assert.deepEqual(modeChanges.at(-1), ["normal", "visual"]);
  });

  it("<C-k> drops a pending count", () => {
    const { editor } = createEditor();
    draft(editor);
    type(editor, ["3", CTRL_K, CTRL_J, "x"]);
    assert.equal(editor.getText(), "draf");
  });

  it("refuses outside the fullscreen TUI", () => {
    const { editor, notices } = createEditor(stubTui);
    draft(editor);
    type(editor, [CTRL_K]);
    assert.equal(editor.getHistoryPaneMode(), null);
    assert.deepEqual(notices, [
      "The history pane needs Pi's fullscreen TUI (tuiMode: fullscreen)",
    ]);
  });

  it("leaves the prompt text, cursor and mode alone", () => {
    const { editor } = createEditor();
    draft(editor);
    const cursor = editor.getCursor();
    type(editor, [CTRL_K, "k", "d", "d", "x", "p", "u", "i", "a", "v", "j"]);
    assert.equal(editor.getText(), "draft");
    assert.deepEqual(editor.getCursor(), cursor);
    assert.equal(editor.getMode(), "normal");
  });

  it("returns to the pane cursor while it is still on screen", () => {
    const tui = createFakeAltScreen(TRANSCRIPT);
    const { editor } = createEditor(tui);
    draft(editor);
    type(editor, [CTRL_K, "g", "g", "w", CTRL_J, CTRL_K]);
    const anchor = tui.selectionAnchor as { row: number; col: number };
    assert.deepEqual({ row: anchor.row, col: anchor.col }, { row: 0, col: 7 });
  });
});

describe("history pane motions and operators", () => {
  it("yank into the register and clipboard and stay in the pane", async () => {
    const { editor, clipboard } = createEditor();
    draft(editor);
    type(editor, [CTRL_K, "g", "g", "w", "v", "e", "y"]);
    assert.equal(editor.getHistoryPaneMode(), "normal");
    assert.equal(editor.getRegister(), "world");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(clipboard, ["world"]);
  });

  it("puts a pane yank into the prompt with p", () => {
    const { editor } = createEditor();
    draft(editor);
    type(editor, [CTRL_K, "g", "g", "y", "y", CTRL_J, "p"]);
    assert.equal(editor.getText(), "draft\n hello world");
  });

  it("maps arrow keys onto hjkl", () => {
    const { editor } = createEditor();
    draft(editor);
    type(editor, [CTRL_K, "\x1b[A", "\x1b[A", "\x1b[D", "y", "y"]);
    // Without a component tree every line is text, the empty one included
    assert.equal(editor.getRegister(), "\n");
  });
});

describe("history pane shares the editor's modes", () => {
  it("labels the pane NORMAL / VISUAL / V-LINE", () => {
    const { editor, statuses } = createEditor();
    draft(editor);
    type(editor, [CTRL_K]);
    editor.render(40);
    type(editor, ["v"]);
    editor.render(40);
    type(editor, ["V"]);
    editor.render(40);
    type(editor, ["2", "g"]);
    editor.render(40);
    assert.deepEqual(statuses.slice(-4), [
      " NORMAL ",
      " VISUAL ",
      " V-LINE ",
      " V-LINE 2g_ ",
    ]);
  });

  it("runs mode-change hooks for pane visual transitions", () => {
    const { editor, modeChanges } = createEditor();
    draft(editor);
    const before = modeChanges.length;
    type(editor, [CTRL_K, "v", "V", ESC, "v", CTRL_J]);
    assert.deepEqual(modeChanges.slice(before), [
      ["visual", "normal"],
      ["visual-line", "visual"],
      ["normal", "visual-line"],
      ["visual", "normal"],
      ["normal", "visual"],
    ]);
  });

  it("hands Escape in normal mode to Pi and stays in the pane", () => {
    const { editor } = createEditor();
    draft(editor);
    type(editor, [CTRL_K, ESC]);
    assert.equal(editor.getHistoryPaneMode(), "normal");
    assert.equal(editor.getText(), "draft");
  });

  it("runs ex commands from the pane and stays there", () => {
    const { editor, statuses } = createEditor();
    const dispatched: string[] = [];
    editor.setCommandNamesFn(() => new Set(["tree"]));
    editor.setRunCommandFn((commandLine) => {
      dispatched.push(commandLine);
    });
    draft(editor);
    type(editor, [CTRL_K, ":", "t"]);
    editor.render(40);
    assert.equal(statuses.at(-1), " EX :t_ ");
    type(editor, [..."ree", "\r"]);
    assert.deepEqual(dispatched, ["/tree"]);
    assert.equal(editor.getHistoryPaneMode(), "normal");
    assert.equal(editor.getText(), "draft");
  });

  it("runs normal-mode keymaps from the pane", () => {
    const { editor } = createEditor();
    const dispatched: string[] = [];
    editor.setCommandNamesFn(() => new Set(["tree"]));
    editor.setRunCommandFn((commandLine) => {
      dispatched.push(commandLine);
    });
    const keymaps = new KeymapRegistry(resolveLeaderTokens(undefined).tokens);
    keymaps.set("<leader>t", ":tree<CR>", "");
    editor.setKeymapRegistry(keymaps);
    draft(editor);
    type(editor, [CTRL_K, " ", "t"]);
    assert.deepEqual(dispatched, ["/tree"]);
  });

  it("replays a broken keymap sequence into the pane", () => {
    const tui = createFakeAltScreen(["abcdef"]);
    const { editor } = createEditor(tui);
    const keymaps = new KeymapRegistry(resolveLeaderTokens(undefined).tokens);
    keymaps.set("<leader>t", ":tree<CR>", "");
    editor.setKeymapRegistry(keymaps);
    draft(editor);
    type(editor, [CTRL_K, "0", " ", "l"]);
    const anchor = tui.selectionAnchor as { col: number };
    assert.equal(anchor.col, 2);
  });
});

describe("history pane rendering", () => {
  it("hides the prompt cursor while the pane has focus", () => {
    const { editor } = createEditor();
    // Pi focuses the editor, which makes it emit the hardware cursor marker
    editor.focused = true;
    draft(editor);
    assert.ok(renderedPrompt(editor).includes("\x1b[7m"));
    type(editor, [CTRL_K]);
    const focused = renderedPrompt(editor);
    assert.equal(focused.includes("\x1b[7m"), false);
    assert.equal(focused.includes(CURSOR_MARKER), false);
    type(editor, [CTRL_J]);
    assert.ok(renderedPrompt(editor).includes("\x1b[7m"));
  });

  it("highlights the pane cursor in the transcript", () => {
    const tui = createFakeAltScreen(TRANSCRIPT);
    const { editor } = createEditor(tui);
    draft(editor);
    type(editor, [CTRL_K]);
    assert.deepEqual(
      [tui.selectionAnchor, tui.selectionFocus].map((point) => {
        const { row, col } = point as { row: number; col: number };
        return { row, col };
      }),
      [
        { row: 3, col: 1 },
        { row: 3, col: 2 },
      ],
    );
  });

  it("drags the cursor along when the viewport scrolls on its own", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const tui = createFakeAltScreen(lines, { top: 20, height: 5 });
    const { editor } = createEditor(tui);
    draft(editor);
    type(editor, [CTRL_K]);
    tui.currentLayout.primaryScrollView.scrollTop = 5;
    editor.render(40);
    assert.equal((tui.selectionAnchor as { row: number }).row, 9);
  });
});

describe("history pane: editor replacement", () => {
  it("gives focus back when Pi builds a new editor", async () => {
    const restore = setPiVimSettingsReaderForTests(() => ({}));
    try {
      const pi = createExtensionApiHarness();
      let factory: ((...args: unknown[]) => ModalEditor) | null = null;
      installPiVim(pi);
      await pi.emit("session_start", undefined, {
        cwd: process.cwd(),
        hasUI: true,
        ui: {
          theme: stubTheme,
          setEditorComponent(next: typeof factory) {
            factory = next;
          },
          notify() {},
          setStatus() {},
        },
        shutdown() {},
      });
      assert.ok(factory);
      const build = factory as (...args: unknown[]) => ModalEditor;

      const tui = createFakeAltScreen(TRANSCRIPT);
      const first = build(tui, stubTheme, stubKeybindings);
      draft(first);
      type(first, [CTRL_K]);
      assert.ok(tui.selectionAnchor);

      build(tui, stubTheme, stubKeybindings);
      assert.equal(first.getHistoryPaneMode(), null);
      assert.equal(tui.selectionAnchor, undefined);
    } finally {
      restore();
    }
  });
});

describe("history pane: streaming output", () => {
  /** Replace the fake transcript, as a new render frame does */
  function setTranscript(
    tui: ReturnType<typeof createFakeAltScreen>,
    lines: string[],
  ) {
    (
      tui.currentLayout.root.children[0] as { scrollContentLines: string[] }
    ).scrollContentLines = lines;
  }

  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`);

  it("stays pinned while output arrives", () => {
    const tui = createFakeAltScreen(lines(20), { top: 15, height: 5 });
    const { editor } = createEditor(tui);
    draft(editor);
    type(editor, [CTRL_K, "k"]);
    const scrollView = tui.currentLayout.primaryScrollView;
    assert.equal(scrollView.isFollowingEnd, false);
    setTranscript(tui, lines(30));
    editor.render(40);
    assert.equal(scrollView.scrollTop, 15);
  });

  it("G follows new output again, with the cursor on the last line", () => {
    const tui = createFakeAltScreen(lines(20), { top: 0, height: 5 });
    const scrollView = tui.currentLayout.primaryScrollView;
    const { editor } = createEditor(tui);
    draft(editor);
    type(editor, [CTRL_K, "G"]);
    assert.equal(scrollView.isFollowingEnd, true);

    setTranscript(tui, lines(30));
    editor.render(40);
    assert.equal((tui.selectionAnchor as { row: number }).row, 29);

    type(editor, ["k"]);
    assert.equal(scrollView.isFollowingEnd, false);
    assert.equal((tui.selectionAnchor as { row: number }).row, 28);
  });

  it("Pi's jump to the latest output makes the pane follow", () => {
    const tui = createFakeAltScreen(lines(20), { top: 0, height: 5 });
    const { editor } = createEditor(tui);
    draft(editor);
    type(editor, [CTRL_K, "g", "g"]);
    tui.currentLayout.primaryScrollView.scrollToEnd();
    setTranscript(tui, lines(25));
    editor.render(40);
    assert.equal((tui.selectionAnchor as { row: number }).row, 24);
  });

  it("leaving a following pane keeps following", () => {
    const tui = createFakeAltScreen(lines(20), {
      top: 0,
      height: 5,
      following: false,
    });
    const scrollView = tui.currentLayout.primaryScrollView;
    const { editor } = createEditor(tui);
    draft(editor);
    type(editor, [CTRL_K, "G", CTRL_J]);
    assert.equal(scrollView.isFollowingEnd, true);
  });

  it("leaving a still pane keeps the view still, even if it followed before", () => {
    const tui = createFakeAltScreen(lines(20), { top: 15, height: 5 });
    const scrollView = tui.currentLayout.primaryScrollView;
    const { editor } = createEditor(tui);
    draft(editor);
    type(editor, [CTRL_K, "g", "g", CTRL_J]);
    assert.equal(scrollView.isFollowingEnd, false);
    assert.equal(scrollView.scrollTop, 0);
    setTranscript(tui, lines(30));
    editor.render(40);
    assert.equal(scrollView.scrollTop, 0);
  });

  it("leaving after Pi's jump to the latest output keeps following", () => {
    const tui = createFakeAltScreen(lines(20), {
      top: 0,
      height: 5,
      following: false,
    });
    const scrollView = tui.currentLayout.primaryScrollView;
    const { editor } = createEditor(tui);
    draft(editor);
    type(editor, [CTRL_K]);
    scrollView.scrollToEnd();
    type(editor, [CTRL_J]);
    assert.equal(scrollView.isFollowingEnd, true);
  });
});

describe("CSI-u encoded keys (kitty protocol, tmux extended-keys csi-u)", () => {
  const SHIFT_G = "\x1b[71;2u";
  const SHIFT_V = "\x1b[86;2u";

  it("G in the pane follows new output", () => {
    const tui = createFakeAltScreen(
      Array.from({ length: 20 }, (_, i) => `line ${i}`),
      { top: 0, height: 5, following: false },
    );
    const { editor } = createEditor(tui);
    draft(editor);
    type(editor, [CTRL_K, SHIFT_G]);
    assert.equal(tui.currentLayout.primaryScrollView.isFollowingEnd, true);
    assert.equal((tui.selectionAnchor as { row: number }).row, 19);
  });

  it("V in the pane starts a line-wise selection", () => {
    const { editor } = createEditor();
    draft(editor);
    type(editor, [CTRL_K, SHIFT_V]);
    assert.equal(editor.getHistoryPaneMode(), "visual-line");
  });

  it("G on the prompt moves to the last line", () => {
    const { editor } = createMultiLineEditor("abc\ndef");
    type(editor, ["g", "g", SHIFT_G, "x"]);
    assert.equal(editor.getText(), "abc\nef");
  });

  it("insert mode still inserts the decoded character", () => {
    const { editor } = createEditor();
    type(editor, [SHIFT_G]);
    assert.equal(editor.getText(), "G");
  });
});
