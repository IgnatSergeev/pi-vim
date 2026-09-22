import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  KeymapRegistry,
  type KeyToken,
  keyTokenMatches,
  parseCmdSequence,
  parseNotationSequence,
  rejectFirstKey,
  resolveLeaderTokens,
} from "../keymap.js";

function tokens(notation: string): KeyToken[] {
  const parsed = parseNotationSequence(notation, [
    { bytes: " ", keyId: "space", notation: "<leader>" },
  ]);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.tokens;
}

function createRegistry(leader = "<Space>"): KeymapRegistry {
  return new KeymapRegistry(resolveLeaderTokens(leader).tokens);
}

describe("key notation parser", () => {
  it("parses plain characters one key at a time", () => {
    assert.deepEqual(
      tokens("gs").map((token) => token.notation),
      ["g", "s"],
    );
  });

  it("expands <leader> to the configured key", () => {
    const parsed = tokens("<leader>a");

    assert.deepEqual(
      parsed.map((token) => token.bytes),
      [" ", "a"],
    );
  });

  it("parses named keys, case-insensitively", () => {
    for (const [notation, data] of [
      ["<Space>", " "],
      ["<CR>", "\r"],
      ["<cr>", "\r"],
      ["<Enter>", "\r"],
      ["<Esc>", "\x1b"],
      ["<Tab>", "\t"],
      ["<BS>", "\x7f"],
      ["<lt>", "<"],
      ["<Bslash>", "\\"],
      ["<Bar>", "|"],
      ["<Up>", "\x1b[A"],
    ] as const) {
      const [token] = tokens(notation);
      assert.ok(token, notation);
      assert.ok(keyTokenMatches(token, data), notation);
    }
  });

  it("parses modifier notation into pi-tui key ids", () => {
    for (const [notation, data] of [
      ["<C-a>", "\x01"],
      ["<C-A>", "\x01"],
      ["<M-g>", "\x1bg"],
      ["<A-g>", "\x1bg"],
      ["<F5>", "\x1b[15~"],
    ] as const) {
      const [token] = tokens(notation);
      assert.ok(token, notation);
      assert.ok(keyTokenMatches(token, data), notation);
    }
  });

  it("keeps graphemes together", () => {
    assert.deepEqual(
      tokens("e\u0301x").map((token) => token.notation),
      ["e\u0301", "x"],
    );
  });

  it("reports unusable notation", () => {
    for (const notation of ["<Nope>", "<C->", "<C-C-a>", "<Space", ""]) {
      const parsed = parseNotationSequence(notation, tokens("<leader>"));
      assert.ok("error" in parsed, notation);
    }
  });

  it("rejects <leader> when no leader is available", () => {
    const parsed = parseNotationSequence("<leader>a");

    assert.ok("error" in parsed);
  });
});

describe("keymap cmd parser", () => {
  it("parses a single ex command", () => {
    assert.deepEqual(parseCmdSequence(":lazygit<CR>"), {
      actions: [{ ex: "lazygit" }],
    });
  });

  it("parses the <cmd> form", () => {
    assert.deepEqual(parseCmdSequence("<cmd>lazygit<CR>"), {
      actions: [{ ex: "lazygit" }],
    });
  });

  it("parses several commands in order", () => {
    assert.deepEqual(parseCmdSequence(":tree<CR><cmd>model opus<cr>"), {
      actions: [{ ex: "tree" }, { ex: "model opus" }],
    });
  });

  it("keeps command arguments verbatim", () => {
    assert.deepEqual(parseCmdSequence(":model  claude  opus <CR>"), {
      actions: [{ ex: "model  claude  opus" }],
    });
  });

  it("requires a <CR> terminator", () => {
    for (const rhs of [":lazygit", "<cmd>lazygit", ":lazygit<CR>:tree", ""]) {
      assert.ok("error" in parseCmdSequence(rhs), rhs);
    }
  });

  it("rejects a string that is not a command", () => {
    for (const rhs of ["dd<CR>", "<CR>", ":<CR>", "<cmd><CR>"]) {
      assert.ok("error" in parseCmdSequence(rhs), rhs);
    }
  });
});

describe("keymap first-key policy", () => {
  it("rejects keys normal mode uses or reserves", () => {
    // Mirrors the policy in keymap.ts; a key leaving that list must fail here.
    const rejected = [
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
    ];
    for (const key of rejected) {
      const [token] = tokens(key === "<" ? "<lt>" : key);
      assert.ok(token, key);
      assert.ok(rejectFirstKey(token), `expected ${key} to be rejected`);
    }
  });

  it("rejects non-printable keys, which belong to Pi's editor", () => {
    for (const notation of ["<CR>", "<Esc>", "<Tab>", "<C-a>", "<Up>"]) {
      const [token] = tokens(notation);
      assert.ok(token, notation);
      assert.ok(rejectFirstKey(token), notation);
    }
  });

  it("accepts the keys normal mode leaves free", () => {
    for (const notation of ["<Space>", "<Bslash>"]) {
      const [token] = tokens(notation);
      assert.ok(token, notation);
      assert.equal(rejectFirstKey(token), null, notation);
    }
  });
});

describe("keymap registry", () => {
  it("registers a keymap and lists it with its description", () => {
    const registry = createRegistry();

    assert.equal(
      registry.set("<leader>g", ":lazygit<CR>", "Open lazygit"),
      null,
    );

    // `keys` reports the keys actually pressed, so a which-key popup can show
    // them; `lhs` keeps the spelling the extension wrote.
    assert.deepEqual(registry.list(), [
      {
        lhs: "<leader>g",
        rhs: ":lazygit<CR>",
        description: "Open lazygit",
        keys: ["<Space>", "g"],
        commands: ["lazygit"],
      },
    ]);
  });

  it("defaults the description to an empty string", () => {
    const registry = createRegistry();

    registry.set("<leader>g", ":lazygit<CR>");

    assert.equal(registry.list()[0]?.description, "");
  });

  it("keeps the first keymap on a conflict and reports it", () => {
    const registry = createRegistry();
    registry.set("<leader>g", ":lazygit<CR>", "Open lazygit");

    assert.equal(
      registry.set("<leader>g", ":tree<CR>", "Tree"),
      'conflicts with "<leader>g" (Open lazygit)',
    );
    assert.deepEqual(
      registry.list().map((entry) => entry.rhs),
      [":lazygit<CR>"],
    );
  });

  it("names a conflicting keymap without a description", () => {
    const registry = createRegistry();
    registry.set("<leader>g", ":lazygit<CR>");

    assert.equal(
      registry.set("<leader>g", ":tree<CR>"),
      'conflicts with "<leader>g" (no description)',
    );
  });

  it("treats an identical re-registration as a no-op", () => {
    const registry = createRegistry();
    registry.set("<leader>g", ":lazygit<CR>", "Open lazygit");

    assert.equal(
      registry.set("<leader>g", ":lazygit<CR>", "Open lazygit"),
      null,
    );
    assert.equal(registry.list().length, 1);

    // Same keys spelled differently is still the same keymap.
    assert.equal(
      registry.set("<Space>g", ":lazygit<CR>", "Open lazygit"),
      null,
    );
    assert.equal(registry.list().length, 1);
    assert.equal(registry.list()[0]?.lhs, "<leader>g");
  });

  it("still reports a re-registration that changed", () => {
    const registry = createRegistry();
    registry.set("<leader>g", ":lazygit<CR>", "Open lazygit");

    assert.ok(registry.set("<leader>g", ":tree<CR>", "Open lazygit"));
    assert.ok(registry.set("<leader>g", ":lazygit<CR>", "Open the git ui"));
    assert.deepEqual(
      registry.list().map((entry) => [entry.rhs, entry.description]),
      [[":lazygit<CR>", "Open lazygit"]],
    );
  });

  it("treats a prefix collision as a conflict, in both orders", () => {
    const shortFirst = createRegistry();
    shortFirst.set("<leader>g", ":lazygit<CR>");
    assert.match(
      shortFirst.set("<leader>gs", ":tree<CR>") ?? "",
      /^conflicts with "<leader>g"/,
    );
    assert.equal(shortFirst.list().length, 1);

    const longFirst = createRegistry();
    longFirst.set("<leader>gs", ":tree<CR>");
    assert.match(
      longFirst.set("<leader>g", ":lazygit<CR>") ?? "",
      /^conflicts with "<leader>gs"/,
    );
    assert.deepEqual(
      longFirst.list().map((entry) => entry.keys),
      [["<Space>", "g", "s"]],
    );
  });

  it("matches the same key written two ways as one keymap", () => {
    const registry = createRegistry();
    registry.set("<leader>g", ":lazygit<CR>");

    assert.ok(registry.set("<Space>g", ":tree<CR>"));
  });

  it("registers sibling sequences that only share a prefix key", () => {
    const registry = createRegistry();

    assert.equal(registry.set("<leader>ga", ":lazygit<CR>"), null);
    assert.equal(registry.set("<leader>gb", ":tree<CR>"), null);

    assert.equal(registry.list().length, 2);
  });

  it("reports and skips a rejected first key", () => {
    const registry = createRegistry();

    assert.equal(
      registry.set("dd", ":tree<CR>"),
      "d cannot start a keymap: normal mode uses it",
    );
    assert.equal(registry.size, 0);
  });

  it("reports and skips an unusable cmd", () => {
    const registry = createRegistry();

    assert.equal(
      registry.set("<leader>g", ":lazygit"),
      'commands sequence must not be empty and each command must be terminated with case-insensitive "<cr>" or "<return>" or "<enter>"',
    );
    assert.equal(registry.size, 0);
  });

  it("reports and skips unparsable keys", () => {
    const registry = createRegistry();

    assert.equal(
      registry.set("<leader><nope>", ":tree<CR>"),
      "unknown key <nope>",
    );
    assert.equal(
      registry.set("<leader", ":tree<CR>"),
      'unterminated "<" at position 0',
    );
    assert.equal(registry.size, 0);
  });

  it("deletes a keymap by any spelling of its keys", () => {
    const registry = createRegistry();
    registry.set("<leader>g", ":lazygit<CR>");

    assert.equal(registry.del("<Space>g"), true);
    assert.equal(registry.size, 0);
    assert.equal(registry.del("<leader>g"), false);
    assert.equal(registry.del("<Nope>"), false);
  });

  it("hands out a detached list", () => {
    const registry = createRegistry();
    registry.set("<leader>g", ":lazygit<CR>", "Open lazygit");

    const [listed] = registry.list();
    assert.ok(listed);
    listed.description = "mutated";
    listed.keys.push("x");

    assert.equal(registry.list()[0]?.description, "Open lazygit");
    assert.deepEqual(registry.list()[0]?.keys, ["<Space>", "g"]);
  });

  it("resolves keys into run / pending / none decisions", () => {
    const registry = createRegistry();
    registry.set("<leader>gs", ":tree<CR>");

    assert.equal(registry.match([" "]).kind, "pending");
    assert.equal(registry.match(["g"]).kind, "none");
    assert.equal(registry.match([" ", "g"]).kind, "pending");
    assert.equal(registry.match([" ", "g", "s"]).kind, "completed");
    assert.equal(registry.match([" ", "x"]).kind, "none");
  });

  it("uses the configured leader", () => {
    const registry = createRegistry("<Bslash>");
    registry.set("<leader>g", ":lazygit<CR>");

    assert.equal(registry.match([" "]).kind, "none");
    assert.equal(registry.match(["\\"]).kind, "pending");
  });
});

describe("leader resolver", () => {
  it("defaults to space", () => {
    const resolved = resolveLeaderTokens(undefined);

    assert.equal(resolved.notation, "<Space>");
    assert.equal(resolved.warning, undefined);
    assert.equal(resolved.tokens[0]?.bytes, " ");
  });

  it("accepts a literal key and notation", () => {
    assert.equal(resolveLeaderTokens("\\").tokens[0]?.bytes, "\\");
    assert.equal(resolveLeaderTokens("<Bslash>").tokens[0]?.bytes, "\\");
  });

  it("warns and falls back for a key normal mode owns", () => {
    const resolved = resolveLeaderTokens("d");

    assert.equal(resolved.tokens[0]?.bytes, " ");
    assert.equal(
      resolved.warning,
      "Invalid piVim.leader: d cannot start a keymap: normal mode uses it.",
    );
  });

  it("warns and falls back for unusable values", () => {
    for (const value of ["", "ab", "<Nope>", 42, null, {}]) {
      const resolved = resolveLeaderTokens(value);
      assert.equal(resolved.tokens[0]?.bytes, " ", String(value));
      assert.match(resolved.warning ?? "", /Invalid piVim\.leader/);
    }
  });
});
