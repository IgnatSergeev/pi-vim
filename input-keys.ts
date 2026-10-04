import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { getLineGraphemes } from "./motions.js";

// Keyboard-input classification predicates. Pure functions over the raw
// input chunk a terminal delivers to the editor — no editor state. Shared
// by the EX mini-mode, insert, and normal-mode dispatch paths.

export function isEscapeLikeInput(data: string): boolean {
  return matchesKey(data, "escape") || matchesKey(data, "ctrl+[");
}

export function isEnterLikeInput(data: string): boolean {
  return (
    data === "\r" ||
    data === "\n" ||
    matchesKey(data, "enter") ||
    matchesKey(data, "return")
  );
}

export function isBackspaceLikeInput(data: string): boolean {
  return (
    data === "\x7f" ||
    data === "\x08" ||
    matchesKey(data, "backspace") ||
    matchesKey(data, "ctrl+h")
  );
}

export function isPrintableChunk(data: string): boolean {
  if (data.length === 0) return false;
  for (const char of data) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127)
      return false;
  }
  return true;
}

export function isPrintableInput(data: string): boolean {
  return isPrintableChunk(data) && getLineGraphemes(data).length === 1;
}

export function isDigit(data: string): boolean {
  return data.length === 1 && data >= "0" && data <= "9";
}

export function isCountStarter(data: string): boolean {
  return data.length === 1 && data >= "1" && data <= "9";
}

const HISTORY_CONTROL_KEYS = [
  "b",
  "c",
  "d",
  "e",
  "f",
  "n",
  "p",
  "u",
  "y",
] as const;
const HISTORY_ARROW_KEYS: ReadonlyArray<[KeyId, string]> = [
  ["up", "k"],
  ["down", "j"],
  ["left", "h"],
  ["right", "l"],
];

/**
 * Translate raw terminal input into history mode's key vocabulary: printable
 * text as is, control keys as their C0 byte, arrows as hjkl. Returns null for
 * input history mode ignores, such as a bracketed paste.
 */
export function toHistoryKey(data: string): string | null {
  if (data.includes("\x1b[200~")) return null;
  if (isEscapeLikeInput(data)) return "\x1b";
  if (isEnterLikeInput(data)) return "\r";
  if (isBackspaceLikeInput(data)) return "\x7f";
  for (const [name, key] of HISTORY_ARROW_KEYS) {
    if (matchesKey(data, name)) return key;
  }
  if (matchesKey(data, "pageUp")) return "\x02";
  if (matchesKey(data, "pageDown")) return "\x06";
  for (const letter of HISTORY_CONTROL_KEYS) {
    if (matchesKey(data, `ctrl+${letter}`)) {
      return String.fromCharCode(letter.charCodeAt(0) - 96);
    }
  }
  return isPrintableChunk(data) ? data : null;
}
