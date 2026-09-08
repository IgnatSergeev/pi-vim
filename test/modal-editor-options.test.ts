import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ModalEditor } from "../index.js";
import { readPiVimInsertEnterBehaviour } from "../settings.js";
import { stubKeybindings, stubTheme, stubTui } from "./harness.js";

type ModalEditorOptions = ConstructorParameters<typeof ModalEditor>[3];

const ESC = "\x1b";
const ENTER = "\r";

function createEditor(opts?: ModalEditorOptions): {
  editor: ModalEditor;
  submits: string[];
} {
  const submits: string[] = [];
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings, opts);
  editor.setClipboardFn(() => {});
  editor.setClipboardReadFn(() => null);
  (editor as unknown as { onSubmit: (text: string) => void }).onSubmit = (
    text: string,
  ) => {
    submits.push(text);
  };
  return { editor, submits };
}

/** Type `text` in insert mode, then leave to normal mode at line start. */
function seed(editor: ModalEditor, text: string): void {
  for (const char of text) editor.handleInput(char);
  editor.handleInput(ESC);
  editor.handleInput("0");
}

describe("new behavior settings readers", () => {
  it("reads the label, enter, paste, and highlight settings", () => {
    const global = {
      piVim: {
        insertEnterBehaviour: "newline",
      },
    };
    assert.equal(readPiVimInsertEnterBehaviour(global, {}), "newline");
  });

  it("ignores unknown values", () => {
    assert.equal(
      readPiVimInsertEnterBehaviour(
        { piVim: { insertEnterBehaviour: "maybe" } },
        {},
      ),
      undefined,
    );
  });
});

describe("enter in insert mode", () => {
  it("submits by default", () => {
    const { editor, submits } = createEditor();
    for (const char of "hi") editor.handleInput(char);
    editor.handleInput(ENTER);
    assert.deepEqual(submits, ["hi"]);
  });

  it("opens a new line when insertEnterBehaviour is newline", () => {
    const { editor, submits } = createEditor({
      insertEnterBehaviour: "newline",
    });
    for (const char of "hi") editor.handleInput(char);
    editor.handleInput(ENTER);
    editor.handleInput("there");
    assert.deepEqual(submits, []);
    assert.equal(editor.getText(), "hi\nthere");
  });

  it("still submits from normal mode", () => {
    const { editor, submits } = createEditor({
      insertEnterBehaviour: "newline",
    });
    seed(editor, "hi");
    editor.handleInput(ENTER);
    assert.deepEqual(submits, ["hi"]);
  });

  it("keeps the newline in a dot-repeatable insert run", () => {
    const { editor, submits } = createEditor({
      insertEnterBehaviour: "newline",
    });
    seed(editor, "ab");
    editor.handleInput("A");
    editor.handleInput("!");
    editor.handleInput(ENTER);
    editor.handleInput(ESC);
    editor.handleInput(".");
    assert.deepEqual(submits, []);
    assert.equal(editor.getText(), "ab!\n!\n");
  });
});

describe("escape closes the completion menu", () => {
  type AutocompleteEditor = ModalEditor & {
    setAutocompleteProvider: (provider: unknown) => void;
    isShowingAutocomplete: () => boolean;
  };

  const wait = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it("leaves no menu open for the normal-mode submit to accept", async () => {
    const { editor, submits } = createEditor({
      insertEnterBehaviour: "newline",
    });
    const autocomplete = editor as AutocompleteEditor;
    autocomplete.setAutocompleteProvider({
      async getSuggestions(lines: string[], line: number, col: number) {
        const before = (lines[line] ?? "").slice(0, col);
        const match = before.match(/^\/(\w*)$/);
        if (!match || !"help".startsWith(match[1] ?? "")) return null;
        return { items: [{ value: "/help", label: "/help" }], prefix: before };
      },
      applyCompletion(lines: string[], line: number, col: number) {
        const next = [...lines];
        next[line] = "/help ";
        return { lines: next, cursorLine: line, cursorCol: col };
      },
    });

    for (const key of "/he") editor.handleInput(key);
    await wait(40);
    assert.equal(autocomplete.isShowingAutocomplete(), true);

    editor.handleInput(ESC);
    assert.equal(autocomplete.isShowingAutocomplete(), false);

    editor.handleInput(ENTER);
    assert.deepEqual(submits, ["/he"]);
  });
});

describe("put over a visual selection", () => {
  const seedVisual = (text: string, register: string, keys: string[]) => {
    const { editor } = createEditor();
    for (const char of text) editor.handleInput(char);
    editor.handleInput(ESC);
    editor.setRegister(register);
    const internal = editor as unknown as {
      state: { cursorLine: number; cursorCol: number };
    };
    internal.state.cursorLine = 0;
    internal.state.cursorCol = 0;
    for (const key of keys) editor.handleInput(key);
    return editor;
  };

  it("replaces a character-wise selection and lands on the last character", () => {
    const editor = seedVisual("abcd", "XY", ["v", "l", "p"]);
    assert.equal(editor.getText(), "XYcd");
    assert.equal(editor.getMode(), "normal");
    assert.equal(editor.getCursor().col, 1);
  });

  it("puts the replaced text into the register, so `p` swaps", () => {
    const editor = seedVisual("abcd", "XY", ["v", "l", "p"]);
    assert.equal(editor.getRegister(), "ab");
  });

  it("keeps the register with `P`, so the same payload can be put again", () => {
    const editor = seedVisual("abcd", "XY", ["v", "l", "P"]);
    assert.equal(editor.getRegister(), "XY");
    editor.handleInput("v");
    editor.handleInput("P");
    // The kept register replaces the `Y` the cursor landed on.
    assert.equal(editor.getText(), "XXYcd");
  });

  it("replaces whole lines in V-LINE mode", () => {
    const editor = seedVisual("one\ntwo\nthree", "NEW\n", ["j", "V", "p"]);
    assert.equal(editor.getText(), "one\nNEW\nthree");
  });

  it("replaces the last lines of the buffer", () => {
    const editor = seedVisual("one\ntwo", "NEW\n", ["j", "V", "p"]);
    assert.equal(editor.getText(), "one\nNEW");
  });

  it("replaces every line without leaving a blank behind", () => {
    const editor = seedVisual("one\ntwo", "NEW\n", ["V", "j", "p"]);
    assert.equal(editor.getText(), "NEW");
  });

  it("puts a line-wise register over a character-wise selection as lines", () => {
    const editor = seedVisual("abcd", "NEW\n", ["l", "v", "p"]);
    assert.equal(editor.getText(), "a\nNEW\ncd");
  });

  it("puts a character-wise register over a V-LINE selection as a line", () => {
    const editor = seedVisual("one\ntwo", "NEW", ["V", "p"]);
    assert.equal(editor.getText(), "NEW\ntwo");
  });

  it("undoes the replacement as one change", () => {
    const editor = seedVisual("abcd", "XY", ["v", "l", "p"]);
    editor.handleInput("u");
    assert.equal(editor.getText(), "abcd");
  });

  it("leaves the selection alone when the register is empty", () => {
    const editor = seedVisual("abcd", "", ["v", "l", "p"]);
    assert.equal(editor.getText(), "abcd");
    assert.equal(editor.getMode(), "visual");
  });
});

describe("visual selection highlighting", () => {
  const OPEN = "\x1b[48;2;45;63;118m";

  it("paints the selection", () => {
    const { editor } = createEditor();
    seed(editor, "abcd");
    editor.handleInput("v");
    editor.handleInput("l");
    const frame = editor.render(40).join("\n");
    // `a` is selected and painted; `b` is under the block cursor, which the
    // host still renders itself.
    assert.ok(frame.includes(`${OPEN}a\x1b[0m`), frame);
    assert.ok(frame.includes("\x1b[7mb"), frame);
  });

  it("paints whole lines in V-LINE mode", () => {
    const { editor } = createEditor();
    for (const char of "ab\ncd") editor.handleInput(char);
    editor.handleInput(ESC);
    editor.handleInput("V");
    editor.handleInput("k");
    const frame = editor.render(40).join("\n");
    assert.ok(frame.includes(`${OPEN}a\x1b[0m`), frame);
    assert.ok(frame.includes(`${OPEN}d\x1b[0m`), frame);
  });

  it("leaves the buffer alone outside visual mode", () => {
    const { editor } = createEditor();
    seed(editor, "abcd");
    assert.equal(editor.render(40).join("\n").includes(OPEN), false);
  });
});
