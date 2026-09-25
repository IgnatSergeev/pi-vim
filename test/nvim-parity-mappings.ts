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

  it("replays an unmapped sequence", async () => {
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

    // pi-vim: `<Space>` is inert, `x` deletes into the register.
    assert.equal(pi.text, "ello");
    assert.deepEqual(pi.cursor, { line: 0, col: 0 });
    assert.equal(pi.register, "h");
  });

  it("replays a unmapped sequence that ends in an operator", async () => {
    const testCase: NvimParityCase = {
      name: "leader then dw",
      initial: { text: "hello world", cursor: { line: 0, col: 0 } },
      keys: [" ", "d", "w"],
      ...NVIM_SETUP,
    };

    const [pi, nvim] = await Promise.all([
      Promise.resolve(runPiCaseWithKeymaps(testCase, PI_KEYMAPS)),
      runNvimParityCase(testCase),
    ]);

    // nvim: `<Space>` moves right, `dw` deletes to the end of the word.
    assert.equal(nvim.text, "hworld");
    // pi-vim: `<Space>` is inert, `dw` deletes to the end of the word.
    assert.equal(pi.text, "world");
  });

  it("executes a keymap after a sequence break", async () => {
    const testCase: NvimParityCase = {
      name: "two leaders then the mapped key",
      initial: { text: "hello", cursor: { line: 0, col: 0 } },
      keys: [" ", " ", "g"],
      ...NVIM_SETUP,
    };

    const [pi, nvim] = await Promise.all([
      Promise.resolve(runPiCaseWithKeymaps(testCase, PI_KEYMAPS)),
      runNvimParityCase(testCase),
    ]);

    assert.equal(nvim.register, "RAN");
    assert.deepEqual(pi.dispatched, ["/lazygit"]);
    assert.equal(pi.text, nvim.text);
  });

  it("replayes builtin operator when a keymap starting with it breaks", async () => {
    const testCase: NvimParityCase = {
      name: "dw with a dx mapping registered",
      initial: { text: "alpha beta", cursor: { line: 0, col: 0 } },
      keys: ["d", "w"],
      leader: "<Space>",
      keymaps: [{ lhs: "dx", rhs: ':let @" = "RAN"<CR>' }],
    };

    const [pi, nvim] = await Promise.all([
      Promise.resolve(runPiCaseWithKeymaps(testCase, [["dx", ":lazygit<CR>"]])),
      runNvimParityCase(testCase),
    ]);

    assert.equal(nvim.text, "beta");
    assert.equal(pi.text, nvim.text);
    assert.deepEqual(pi.cursor, nvim.cursor);
    assert.deepEqual(pi.dispatched, []);
  });

  it("runs a keymap that starts with builtin operator", async () => {
    const testCase: NvimParityCase = {
      name: "dx with a dx mapping registered",
      initial: { text: "alpha beta", cursor: { line: 0, col: 0 } },
      keys: ["d", "x"],
      leader: "<Space>",
      keymaps: [{ lhs: "dx", rhs: ':let @" = "RAN"<CR>' }],
    };

    const [pi, nvim] = await Promise.all([
      Promise.resolve(runPiCaseWithKeymaps(testCase, [["dx", ":lazygit<CR>"]])),
      runNvimParityCase(testCase),
    ]);

    assert.equal(nvim.text, "alpha beta");
    assert.equal(nvim.register, "RAN");
    assert.equal(pi.text, nvim.text);
    assert.deepEqual(pi.cursor, nvim.cursor);
    assert.deepEqual(pi.dispatched, ["/lazygit"]);
  });

  it("shadows a builtin operator", async () => {
    const testCase: NvimParityCase = {
      name: "dd with a d mapping registered",
      initial: { text: "one\ntwo", cursor: { line: 0, col: 0 } },
      keys: ["d", "d"],
      leader: "<Space>",
      keymaps: [{ lhs: "d", rhs: ':let @" = "RAN"<CR>' }],
    };

    const [pi, nvim] = await Promise.all([
      Promise.resolve(runPiCaseWithKeymaps(testCase, [["d", ":lazygit<CR>"]])),
      runNvimParityCase(testCase),
    ]);

    assert.equal(nvim.text, "one\ntwo");
    assert.equal(pi.text, nvim.text);
    assert.deepEqual(pi.dispatched, ["/lazygit", "/lazygit"]);
    assert.equal(nvim.register, "RAN");
  });

  it("keymap does not interrupt pending operator", async () => {
    const testCase: NvimParityCase = {
      name: "rqq with a qq mapping registered",
      initial: { text: "a q b", cursor: { line: 0, col: 0 } },
      keys: ["d", "w", "q"],
      leader: "<Space>",
      keymaps: [{ lhs: "wq", rhs: ':let @" = "RAN"<CR>' }],
    };

    const [pi, nvim] = await Promise.all([
      Promise.resolve(runPiCaseWithKeymaps(testCase, [["wq", ":lazygit<CR>"]])),
      runNvimParityCase(testCase),
    ]);

    assert.equal(nvim.text, "q b");
    assert.equal(pi.text, nvim.text);
    assert.deepEqual(pi.cursor, nvim.cursor);
    assert.deepEqual(pi.dispatched, []);
  });

  it("keymap interrupts and ignores a count", async () => {
    const testCase: NvimParityCase = {
      name: "2dx with a dx mapping registered",
      initial: { text: "alpha beta gamma", cursor: { line: 0, col: 0 } },
      keys: ["2", "d", "x"],
      leader: "<Space>",
      keymaps: [{ lhs: "dx", rhs: '<Cmd>let @" = "RAN"<CR>' }],
    };

    const [pi, nvim] = await Promise.all([
      Promise.resolve(runPiCaseWithKeymaps(testCase, [["dx", ":lazygit<CR>"]])),
      runNvimParityCase(testCase),
    ]);

    assert.equal(nvim.register, "RAN");
    assert.deepEqual(pi.dispatched, ["/lazygit"]);

    assert.equal(nvim.text, "alpha beta gamma");
    assert.equal(pi.text, nvim.text);
    assert.deepEqual(pi.cursor, nvim.cursor);
    assert.equal(pi.mode, nvim.mode);
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
