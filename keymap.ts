/**
 * Session-wide keymap registry.
 *
 * Keymaps are registered as key notation sequence (https://neovim.io/doc/user/intro.html#key-notation),
 * and the number of ex lines (`:{command}<CR>`).
 *
 * Mappings are normal-mode only, they take no count, they
 * are never recursive, and unlike nvim, pi-vim has no `timeoutlen`, so an unfinished sequence
 * is dropped rather than replayed as builtin commands.
 */

import { type KeyId, matchesKey } from "@earendil-works/pi-tui";

import { getLineGraphemes } from "./motions.js";

export type KeyToken = {
  /** Bytes representation and/or kitty keyboard protocol id */
  bytes?: string;
  keyId?: KeyId;
  notation: string;
};

export type KeymapAction = { ex: string };

/** Keymap entry raw arguments */
export type RawKeymapEntry = {
  lhs: string;
  rhs: string;
  description: string;
};

/** Keymap entry with parsed key tokens and actions */
export type ParsedKeymapEntry = {
  raw: RawKeymapEntry;
  tokens: readonly KeyToken[];
  actions: readonly KeymapAction[];
};

/**
 * Keymap entry with resolved internal notations (<leader>, <cmd>, <CR>).
 * Public api of `keymap.list()`
 */
export type ResolvedKeymapEntry = RawKeymapEntry & {
  keys: string[];
  commands: string[];
};

export const DEFAULT_LEADER_NOTATION = "<Space>";

const REJECTED_KEYMAP_FIRST_KEY_SET = new Set<string>([
  ..."0123456789",
  ..."hjkl$^_wbeWBE{}%",
  ..."fFtT;,",
  ..."ixXDCSsaAIoO",
  ..."dcyJpPYrvV",
  ..."gG:u.",
  ..."/?nN",
  ..."mq@zZ",
  ...`"'\``,
  ..."[]()",
  ..."HML",
  ..."RUKQ",
  ..."~<>=|",
  ..."&*#+-!",
]);

function isPrintableKey(token: KeyToken): boolean {
  if (token.bytes === undefined) return false;
  for (const char of token.bytes) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127) {
      return false;
    }
  }
  return true;
}

/** Rejects keys a keymap must not start with */
export function rejectFirstKey(token: KeyToken): string | null {
  if (!isPrintableKey(token)) {
    return `${token.notation} cannot start a keymap: Pi's editor owns non-printable keys`;
  }
  if (
    token.bytes !== undefined &&
    REJECTED_KEYMAP_FIRST_KEY_SET.has(token.bytes)
  ) {
    return `${token.notation} cannot start a keymap: normal mode uses it`;
  }
  return null;
}

/** Map from key notation to key token */
const NAMED_KEYS: Record<string, Omit<KeyToken, "notation">> = {
  space: { bytes: " ", keyId: "space" },
  cr: { bytes: "\r", keyId: "enter" },
  return: { bytes: "\r", keyId: "enter" },
  enter: { bytes: "\r", keyId: "enter" },
  esc: { bytes: "\x1b", keyId: "escape" },
  tab: { bytes: "\t", keyId: "tab" },
  bs: { bytes: "\x7f", keyId: "backspace" },
  del: { keyId: "delete" },
  lt: { bytes: "<" },
  bslash: { bytes: "\\" },
  bar: { bytes: "|" },
  up: { bytes: "\x1b[A", keyId: "up" },
  down: { bytes: "\x1b[B", keyId: "down" },
  left: { bytes: "\x1b[D", keyId: "left" },
  right: { bytes: "\x1b[C", keyId: "right" },
  home: { keyId: "home" },
  end: { keyId: "end" },
  pageup: { keyId: "pageUp" },
  pagedown: { keyId: "pageDown" },
};

for (let n = 1; n <= 12; n++) {
  NAMED_KEYS[`f${n}`] = { keyId: `f${n}` as KeyId };
}

/** Map from modifier notation to key id */
const NAMED_MODIFIERS: Record<string, string> = {
  c: "ctrl",
  ctrl: "ctrl",
  s: "shift",
  shift: "shift",
  m: "alt",
  a: "alt",
  alt: "alt",
  d: "super",
};

/** Parses modifier sequence into a kitty keyboard protocol key id (<C-S-x> -> `ctrl+shift+x`) */
function parseModifierKeySequence(seq: string): KeyId | null {
  const parts = seq.split("-");
  const base = parts.pop();
  if (!base || parts.length === 0) return null;

  const modifiers: string[] = [];
  for (const part of parts) {
    const modifier = NAMED_MODIFIERS[part.toLowerCase()];
    if (!modifier || modifiers.includes(modifier)) return null;
    modifiers.push(modifier);
  }

  const baseToken = NAMED_KEYS[base.toLowerCase()];
  const baseKey =
    baseToken?.keyId ?? (base.length === 1 ? base.toLowerCase() : null);
  if (!baseKey) return null;

  return `${modifiers.join("+")}+${baseKey}` as KeyId;
}

/** Parse key notation sequence into tokens */
export function parseNotationSequence(
  seq: string,
  leader: readonly KeyToken[] | null = null,
): { tokens: KeyToken[] } | { error: string } {
  const tokens: KeyToken[] = [];
  let index = 0;

  while (index < seq.length) {
    const char = seq[index];
    if (char !== "<") {
      const grapheme = getLineGraphemes(seq.slice(index))[0];
      if (!grapheme) return { error: `unreadable key at position ${index}` };
      const key = seq.slice(index, index + grapheme.end);
      tokens.push({ bytes: key, notation: key });
      index += grapheme.end;
      continue;
    }

    const notationCloseIdx = seq.indexOf(">", index);
    if (notationCloseIdx === -1)
      return { error: `unterminated "<" at position ${index}` };
    const notation = seq.slice(index, notationCloseIdx + 1);
    const notationKeyNames = seq.slice(index + 1, notationCloseIdx);
    index = notationCloseIdx + 1;

    if (notationKeyNames.toLowerCase() === "leader") {
      if (!leader) return { error: "<leader> is not available here" };
      tokens.push(...leader);
      continue;
    }

    const namedToken = NAMED_KEYS[notationKeyNames.toLowerCase()];
    if (namedToken) {
      tokens.push({ ...namedToken, notation: notation });
      continue;
    }

    const modifiedKeyId = parseModifierKeySequence(notationKeyNames);
    if (!modifiedKeyId) return { error: `unknown key ${notation}` };
    tokens.push({ keyId: modifiedKeyId, notation: notation });
  }

  if (tokens.length === 0) return { error: "empty key sequence" };
  return { tokens };
}

/** Parse commands notation sequence into actions */
export function parseCmdSequence(
  seq: string,
): { actions: KeymapAction[] } | { error: string } {
  const terminatorRegExp = /<(?:cr|return|enter)>/i;
  const segments = seq.split(new RegExp(terminatorRegExp, "gi"));
  const tail = segments.pop();
  if (tail === undefined || tail.trim().length > 0 || segments.length === 0) {
    return {
      error:
        'commands sequence must not be empty and each command must be terminated with case-insensitive "<cr>" or "<return>" or "<enter>"',
    };
  }

  const actions: KeymapAction[] = [];
  for (const segment of segments) {
    const line = segment.trim();
    const command = line.startsWith(":")
      ? line.slice(1)
      : /^<cmd>/i.test(line.toLowerCase())
        ? line.slice(5)
        : null;
    if (command === null) {
      return {
        error: `"${segment}" must start with ":" or case-insensitive "<cmd>"`,
      };
    }
    const trimmed = command.trim();
    if (!trimmed) return { error: "empty command in commands sequence" };
    actions.push({ ex: trimmed });
  }

  return { actions };
}

/** Match input data against a key token */
export function keyTokenMatches(token: KeyToken, data: string): boolean {
  if (token.bytes !== undefined && data === token.bytes) return true;
  return token.keyId !== undefined && matchesKey(data, token.keyId);
}

/** Compare parsed commands */
function sameActions(
  a: readonly KeymapAction[],
  b: readonly KeymapAction[],
): boolean {
  return (
    a.length === b.length && a.every((action, i) => action.ex === b[i]?.ex)
  );
}

/** Produce unique identifier of a key sequence */
function sequenceId(tokens: readonly KeyToken[]): string {
  return tokens.map((t) => t.keyId ?? `=${t.bytes}`).join("\u0000");
}

export type KeymapMatch =
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "run"; entry: ParsedKeymapEntry };

/** Session-wide keymap table */
export class KeymapRegistry {
  private readonly entries = new Map<string, ParsedKeymapEntry>();
  private leader: KeyToken[];

  constructor(leader: readonly KeyToken[]) {
    this.leader = [...leader];
  }

  get size(): number {
    return this.entries.size;
  }

  /** Registers one mapping. Returns the reason if it was rejected, or null on success. */
  set(lhs: string, rhs: string, description = ""): string | null {
    const parsedKeys = parseNotationSequence(lhs, this.leader);
    if ("error" in parsedKeys) return parsedKeys.error;

    const [first] = parsedKeys.tokens;
    if (!first) return "empty key sequence";

    const rejected = rejectFirstKey(first);
    if (rejected) return rejected;

    const parsedCmds = parseCmdSequence(rhs);
    if ("error" in parsedCmds) return parsedCmds.error;

    const conflict = this.findConflict(parsedKeys.tokens);
    if (conflict) {
      // Registering the very same keymap again is a no-op
      if (
        sequenceId(conflict.tokens) === sequenceId(parsedKeys.tokens) &&
        sameActions(conflict.actions, parsedCmds.actions) &&
        conflict.raw.description === description
      ) {
        return null;
      }
      return `conflicts with "${conflict.raw.lhs}" (${conflict.raw.description || "no description"})`;
    }

    const id = sequenceId(parsedKeys.tokens);
    this.entries.set(id, {
      raw: { lhs, rhs, description },
      tokens: parsedKeys.tokens,
      actions: parsedCmds.actions,
    });
    return null;
  }

  /** Removes a mapping by its notation sequence. Returns false when unknown. */
  del(lhs: string): boolean {
    const parsed = parseNotationSequence(lhs, this.leader);
    if ("error" in parsed) return false;
    return this.entries.delete(sequenceId(parsed.tokens));
  }

  /** Returns the list of all registered mappings */
  list(): ResolvedKeymapEntry[] {
    return [...this.entries.values()].map(({ raw, tokens, actions }) => ({
      ...raw,
      keys: tokens.map((token) => token.notation),
      commands: actions.map((action) => action.ex),
    }));
  }

  /** Searches for keymap conflict by the full or prefix match */
  private findConflict(tokens: readonly KeyToken[]): ParsedKeymapEntry | null {
    const id = sequenceId(tokens);
    const existing = this.entries.get(id);
    if (existing) return existing;

    for (const entry of this.entries.values()) {
      const shorter =
        entry.tokens.length < tokens.length ? entry.tokens : tokens;
      const longer =
        entry.tokens.length < tokens.length ? tokens : entry.tokens;
      if (sequenceId(longer.slice(0, shorter.length)) === sequenceId(shorter)) {
        return entry;
      }
    }
    return null;
  }

  /** Resolves the pending keys into a run / pending / drop decision */
  match(keys: readonly string[]): KeymapMatch {
    let pending = false;

    for (const entry of this.entries.values()) {
      if (entry.tokens.length < keys.length) continue;
      const matches = keys.every((data, index) => {
        const token = entry.tokens[index];
        return token !== undefined && keyTokenMatches(token, data);
      });
      if (!matches) continue;
      if (entry.tokens.length === keys.length) return { kind: "run", entry };
      pending = true;
    }

    return pending ? { kind: "pending" } : { kind: "none" };
  }
}

/**
 * Parse the configured leader into its key tokens.
 * Falls back to `<Space>` and reports the reasone if the value cannot open a keymap.
 */
export function resolveLeaderTokens(value: unknown): {
  tokens: KeyToken[];
  notation: string;
  warning?: string;
} {
  const fallback = () => {
    const parsed = parseNotationSequence(DEFAULT_LEADER_NOTATION);
    if ("error" in parsed) throw new Error("default leader must parse");
    return parsed.tokens;
  };

  if (value === undefined) {
    return { tokens: fallback(), notation: DEFAULT_LEADER_NOTATION };
  }

  const invalid = (reason: string) => ({
    tokens: fallback(),
    notation: DEFAULT_LEADER_NOTATION,
    warning: `Invalid piVim.leader: ${reason}.`,
  });

  if (typeof value !== "string" || !value) {
    return invalid('expected a string notation sequence, e.g. "<Space>"');
  }

  const parsed = parseNotationSequence(value);
  if ("error" in parsed) return invalid(parsed.error);

  const rejected = rejectFirstKey(parsed.tokens[0]);
  if (rejected) return invalid(rejected);

  return { tokens: parsed.tokens, notation: value };
}
