import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nativeClipboardReadCommands } from "../clipboard-mirror.js";

const names = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
  nativeClipboardReadCommands(env, platform).map((c) => c.command);

describe("nativeClipboardReadCommands", () => {
  it("reads a Wayland session before any X11 tool", () => {
    assert.deepEqual(
      names({ WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0" }, "linux"),
      ["wl-paste", "xclip", "xsel"],
    );
    assert.deepEqual(names({ XDG_SESSION_TYPE: "wayland" }, "linux"), [
      "wl-paste",
    ]);
  });

  it("reads X11 tools on an X11 session", () => {
    assert.deepEqual(names({ DISPLAY: ":0" }, "linux"), ["xclip", "xsel"]);
  });

  it("passes the flags that keep wl-paste's output verbatim", () => {
    assert.deepEqual(
      nativeClipboardReadCommands({ WAYLAND_DISPLAY: "wayland-1" }, "linux")[0],
      { command: "wl-paste", args: ["--no-newline", "--type", "text"] },
    );
  });

  it("falls back to the node helper with no session at all", () => {
    assert.deepEqual(names({}, "linux"), []);
  });

  it("uses pbpaste on macOS and nothing on Windows", () => {
    assert.deepEqual(names({}, "darwin"), ["pbpaste"]);
    assert.deepEqual(names({}, "win32"), []);
  });
});
