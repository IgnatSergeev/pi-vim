import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ModalEditor } from "../index.js";
import { KeymapRegistry, resolveLeaderTokens } from "../keymap.js";
import {
  setInternalCursor,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";
import {
  type NvimParityCase,
  type NvimParitySnapshot,
  runNvimParityCase,
} from "./nvim-oracle.js";

function runPiCaseWithKeymaps(
  testCase: NvimParityCase,
  keymaps: Array<[string, string]>,
): NvimParitySnapshot & { dispatched: string[] } {
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
  const dispatched: string[] = [];
  const registry = new KeymapRegistry(resolveLeaderTokens(undefined).tokens);
  for (const [lhs, rhs] of keymaps) registry.set(lhs, rhs);

  editor.setClipboardFn(() => undefined);
  editor.setClipboardReadFn(() => null);
  editor.setKeymapRegistry(registry);
  editor.setCommandNamesFn(() => new Set(["lazygit"]));
  editor.setRunCommandFn((commandLine) => {
    dispatched.push(commandLine);
  });
  editor.setText(testCase.initial.text);
  editor.handleInput("\x1b");
  setInternalCursor(
    editor,
    testCase.initial.cursor.col,
    testCase.initial.cursor.line,
  );

  for (const key of testCase.keys) editor.handleInput(key);

  const cursor = editor.getCursor();
  return {
    text: editor.getText(),
    cursor: { line: cursor.line, col: cursor.col },
    mode: editor.getMode(),
    register: editor.getRegister(),
    dispatched,
  };
}

const NVIM_SETUP = {
  leader: "<Space>",
  keymaps: [{ lhs: "<leader>g", rhs: ':let @" = "RAN"<CR>' }],
};
const PI_KEYMAPS: Array<[string, string]> = [["<leader>g", ":lazygit<CR>"]];

describe("nvim keymaps parity", () => {
  it("runs a completed keymap sequence without touching the buffer", async () => {
    const testCase: NvimParityCase = {
      name: "leader then the mapped key",
      initial: { text: "hello", cursor: { line: 0, col: 0 } },
      keys: [" ", "g"],
      ...NVIM_SETUP,
    };

    const [pi, nvim] = await Promise.all([
      Promise.resolve(runPiCaseWithKeymaps(testCase, PI_KEYMAPS)),
      runNvimParityCase(testCase),
    ]);

    assert.equal(pi.text, nvim.text);
    assert.deepEqual(pi.cursor, nvim.cursor);
    assert.equal(pi.mode, nvim.mode);
    assert.deepEqual(pi.cursor, { line: 0, col: 0 });

    assert.equal(nvim.register, "RAN");
    assert.deepEqual(pi.dispatched, ["/lazygit"]);
    assert.equal(pi.register, "");
  });

  it("drops an unmapped sequence, where nvim replays it", async () => {
    const testCase: NvimParityCase = {
      name: "leader then an unmapped key",
      initial: { text: "hello", cursor: { line: 0, col: 0 } },
      keys: [" ", "x"],
      ...NVIM_SETUP,
    };

    const [pi, nvim] = await Promise.all([
      Promise.resolve(runPiCaseWithKeymaps(testCase, PI_KEYMAPS)),
      runNvimParityCase(testCase),
    ]);

    // nvim: `<Space>` moves right, `x` deletes into the register.
    assert.equal(nvim.text, "hllo");
    assert.deepEqual(nvim.cursor, { line: 0, col: 1 });
    assert.equal(nvim.register, "e");

    // pi-vim: `<Space>` starts the keymap, `x` breaks it, both keys are ignored
    assert.equal(pi.text, "hello");
    assert.deepEqual(pi.cursor, { line: 0, col: 0 });
    assert.deepEqual(pi.dispatched, []);
  });

  it("waits indefinitely for an unfinished sequence, where nvim times out", async () => {
    const testCase: NvimParityCase = {
      name: "leader alone",
      initial: { text: "hello", cursor: { line: 0, col: 0 } },
      keys: [" "],
      ...NVIM_SETUP,
    };

    const [pi, nvim] = await Promise.all([
      Promise.resolve(runPiCaseWithKeymaps(testCase, PI_KEYMAPS)),
      runNvimParityCase(testCase),
    ]);

    // nvim: `timeout` expires and `<Space>` runs as a motion.
    assert.deepEqual(nvim.cursor, { line: 0, col: 1 });

    // pi-vim: the sequence stays pending, so the `<Space>` never becomes a motion.
    assert.deepEqual(pi.cursor, { line: 0, col: 0 });
    assert.equal(pi.text, nvim.text);
    assert.deepEqual(pi.dispatched, []);
  });
});
