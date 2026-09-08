import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ModalEditor } from "../index.js";
import { stubKeybindings, stubTheme, stubTui } from "./harness.js";

type ModalEditorOptions = ConstructorParameters<typeof ModalEditor>[3];

const ESC = "\x1b";

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
