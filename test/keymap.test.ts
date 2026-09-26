import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  KeymapRegistry,
  type KeyToken,
  keyTokenMatches,
  parseCmdSequence,
  parseNotationSequence,
  resolveLeaderTokens,
} from "../keymap.js";

function tokens(notation: string): KeyToken[] {
  const parsed = parseNotationSequence(notation, [
    { bytes: " ", keyId: "space", notation: "<Space>" },
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

  it("rejects escape anywhere in the sequence", () => {
    const registry = createRegistry();

    const rejected: Array<[string, string]> = [
      ["<Esc>x", "<Esc>"],
      ["<leader><Esc>", "<Esc>"],
      ["<C-[>", "<C-[>"],
    ];

    for (const [keymap, notation] of rejected) {
      assert.equal(
        registry.set(keymap, ":tree<CR>"),
        `${notation} cannot be used in a keymap: it cancels a pending sequence`,
      );
    }
    assert.equal(registry.size, 0);
  });

  it("registers a keymap that contains non printable key", () => {
    const registry = createRegistry();

    assert.equal(registry.set("<C-g>x", ":tree<CR>"), null);
    assert.equal(registry.set("<BS>", ":lazygit<CR>"), null);
    assert.equal(registry.size, 2);
  });

  it("registers a keymap that starts with a key normal mode uses", () => {
    const registry = createRegistry();

    assert.equal(registry.set("dx", ":tree<CR>"), null);
    assert.equal(registry.size, 1);
    assert.equal(registry.match(["d"]).kind, "pending");
    assert.equal(registry.match(["d", "x"]).kind, "completed");
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

describe("canonical key notation", () => {
  function canonical(notation: string): string[] {
    return tokens(notation).map((token) => token.notation);
  }

  it("spells one key the same whichever way it was written", () => {
    assert.deepEqual(canonical(" <space><Space><leader>"), [
      "<Space>",
      "<Space>",
      "<Space>",
      "<Space>",
    ]);
    assert.deepEqual(canonical("<CR><Enter><return>"), [
      "<CR>",
      "<CR>",
      "<CR>",
    ]);
    assert.deepEqual(canonical("<c-x><C-X>"), ["<C-X>", "<C-X>"]);
    assert.deepEqual(canonical("<A-x><M-x><Alt-x>"), [
      "<M-x>",
      "<M-x>",
      "<M-x>",
    ]);
  });

  it("orders modifiers M-C-S-D and folds shift into a letter", () => {
    assert.deepEqual(canonical("<S-C-x><D-A-x><S-x><M-S-x><S-Tab>"), [
      "<C-S-X>",
      "<M-D-x>",
      "X",
      "<M-X>",
      "<S-Tab>",
    ]);
  });

  it("keeps literal keys and names the ones notation reserves", () => {
    assert.deepEqual(canonical("gGé<lt><Bslash><Bar>"), [
      "g",
      "G",
      "é",
      "<lt>",
      "\\",
      "|",
    ]);
  });

  it("names literal control characters", () => {
    assert.deepEqual(canonical("\t\r\x7f\x07"), [
      "<Tab>",
      "<CR>",
      "<BS>",
      "<C-G>",
    ]);
  });

  it("lists keymaps in canonical notation, and keeps the lhs as written", () => {
    const registry = createRegistry();
    registry.set("<leader><c-x>a", ":tree<CR>");

    assert.deepEqual(registry.list()[0]?.keys, ["<Space>", "<C-X>", "a"]);
    assert.equal(registry.list()[0]?.lhs, "<leader><c-x>a");
  });
});

describe("pending keymap", () => {
  it("is null when nothing is pending or no keymap continues the keys", () => {
    const registry = createRegistry();
    registry.set("<leader>gs", ":tree<CR>");

    assert.equal(registry.pending([]), null);
    assert.equal(registry.pending(["g"]), null);
    assert.equal(registry.pending([" ", "x"]), null);
  });

  it("is null once the keys complete a keymap", () => {
    const registry = createRegistry();
    registry.set("<leader>g", ":lazygit<CR>");

    assert.equal(registry.pending([" ", "g"]), null);
  });

  it("lists keymaps and groups that can follow, in registration order", () => {
    const registry = createRegistry();
    registry.set("<leader>g", ":lazygit<CR>", "Open lazygit");
    registry.set("<leader>fa", ":tree<CR>", "Tree");
    registry.set("<leader>fb", ":tree<CR>");
    registry.set("<leader>c", ":compact<CR>");
    registry.set("x", ":tree<CR>", "Not under leader");

    assert.deepEqual(registry.pending([" "]), {
      keys: ["<Space>"],
      next: [
        { key: "g", description: "Open lazygit", group: false, count: 1 },
        { key: "f", description: "", group: true, count: 2 },
        { key: "c", description: "", group: false, count: 1 },
      ],
    });
  });

  it("multi key pending sequence", () => {
    const registry = createRegistry();
    registry.set("<leader>fa", ":tree<CR>", "Tree");
    registry.set("<leader>fb", ":tree<CR>", "Other tree");

    assert.deepEqual(registry.pending([" ", "f"]), {
      keys: ["<Space>", "f"],
      next: [
        { key: "a", description: "Tree", group: false, count: 1 },
        { key: "b", description: "Other tree", group: false, count: 1 },
      ],
    });
  });

  it("merges one key written two ways into one entry", () => {
    const registry = createRegistry();
    registry.set("<leader><C-x>a", ":tree<CR>", "A");
    registry.set("<Space><c-X>b", ":tree<CR>", "B");

    assert.deepEqual(registry.pending([" "]), {
      keys: ["<Space>"],
      next: [{ key: "<C-X>", description: "", group: true, count: 2 }],
    });
  });

  it("spells the typed keys canonically", () => {
    const registry = createRegistry("<Bslash>");
    registry.set("<leader><c-g>s", ":tree<CR>", "Tree");

    assert.deepEqual(registry.pending(["\\", "\x07"])?.keys, ["\\", "<C-G>"]);
  });

  it("stops listing a keymap deleted mid-sequence", () => {
    const registry = createRegistry();
    registry.set("<leader>a", ":tree<CR>");
    registry.set("<leader>b", ":tree<CR>");

    registry.del("<leader>a");

    assert.deepEqual(
      registry.pending([" "])?.next.map((hint) => hint.key),
      ["b"],
    );
    registry.del("<leader>b");
    assert.equal(registry.pending([" "]), null);
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

  it("warns and falls back for escape", () => {
    const resolved = resolveLeaderTokens("<Esc>");

    assert.equal(resolved.tokens[0]?.bytes, " ");
    assert.equal(
      resolved.warning,
      "Invalid piVim.leader: <Esc> cannot be used in a keymap: it cancels a pending sequence.",
    );
  });

  it("accepts a non printable leader", () => {
    const resolved = resolveLeaderTokens("<C-g>");

    assert.equal(resolved.tokens[0]?.keyId, "ctrl+g");
    assert.equal(resolved.warning, undefined);
  });

  it("accepts a leader normal mode uses", () => {
    const resolved = resolveLeaderTokens("d");

    assert.equal(resolved.tokens[0]?.bytes, "d");
    assert.equal(resolved.warning, undefined);
  });

  it("accepts a multi key leader", () => {
    const resolved = resolveLeaderTokens("ab");

    assert.deepEqual(
      resolved.tokens.map((token) => token.bytes),
      ["a", "b"],
    );
    assert.equal(resolved.warning, undefined);
  });

  it("warns and falls back for unusable values", () => {
    for (const value of ["", "<Nope>", 42, null, {}]) {
      const resolved = resolveLeaderTokens(value);
      assert.equal(resolved.tokens[0]?.bytes, " ", String(value));
      assert.match(resolved.warning ?? "", /Invalid piVim\.leader/);
    }
  });
});
