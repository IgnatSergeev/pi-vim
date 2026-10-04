/**
 * Types and constants for vim-mode extension
 */

/** Upper bound for every vim count */
export const MAX_COUNT = 9999;

export type Mode = "normal" | "insert" | "visual" | "visual-line";
export type Position = { line: number; col: number };
export type Direction = "forward" | "backward";
export type CharMotion = "f" | "F" | "t" | "T";
export type PendingMotion = CharMotion | null;
export type PendingOperator = "d" | "c" | "y" | null;

export interface LastCharMotion {
  motion: CharMotion;
  char: string;
}

// Normal mode key mappings: key -> escape sequence (or null for mode switch)
export const NORMAL_KEYS: Record<string, string | null> = {
  h: "\x1b[D", // left
  j: "\x1b[B", // down
  k: "\x1b[A", // up
  l: "\x1b[C", // right
  "0": "\x01", // line start
  $: null, // line end
  x: null, // delete char (custom clipboard handling)
  X: null, // delete char before cursor (custom clipboard handling)
  D: null, // delete to end of line (custom clipboard handling)
  C: null, // change to end of line (delete to end + insert mode)
  S: null, // substitute line (delete line content + insert mode)
  s: null, // substitute char (delete char + insert mode)
  i: null, // insert mode
  a: null, // append (insert + right)
  A: null, // append at end of line
  I: null, // insert at start of line
  o: null, // open line below
  O: null, // open line above
};

// Character motion keys that wait for a target character
export const CHAR_MOTION_KEYS = new Set<string>(["f", "F", "t", "T"]);

// Escape sequences
export const ESC_LEFT = "\x1b[D";
export const ESC_RIGHT = "\x1b[C";
export const CTRL_A = "\x01"; // line start
export const CTRL_B = "\x02"; // page up in the history pane
export const CTRL_C = "\x03";
export const CTRL_D = "\x04"; // half page down in the history pane
export const CTRL_E = "\x05"; // line end
export const CTRL_F = "\x06"; // page down in the history pane
export const CTRL_K = "\x0b"; // kill to end of line
export const CTRL_N = "\x0e";
export const CTRL_P = "\x10";
export const CTRL_R = "\x12"; // ctrl+r — readline redo trigger in vim layer
export const CTRL_U = "\x15"; // half page up in the history pane
export const CTRL_Y = "\x19"; // scroll one line up in the history pane
export const CTRL_UNDERSCORE = "\x1f"; // ctrl+_ — readline undo
export const NEWLINE = "\n"; // newline character
export const ESC_UP = "\x1b[A"; // cursor up
export const ESC_DOWN = "\x1b[B"; // cursor down
