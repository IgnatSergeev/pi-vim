import { spawn } from "node:child_process";

import type { ModeChangeSettings } from "./settings.js";
import type { Mode } from "./types.js";

const MODE_CHANGE_COMMAND_TIMEOUT_MS = 2000;

type ModeChangeCommandRunner = (command: string) => void;
type RunningModeChangeCommand = {
  child: ReturnType<typeof spawn>;
  timeout: ReturnType<typeof setTimeout>;
};
/** `previousMode` is null only for the initial mode of a freshly created editor. */
export type ModeChangeEvent = { mode: Mode; previousMode: Mode | null };

let activeModeChangeCommand: RunningModeChangeCommand | null = null;
let pendingModeChangeCommand: string | null = null;
let modeChangeCommandRunner: ModeChangeCommandRunner = spawnModeChangeCommand;

export function setModeChangeCommandRunnerForTests(
  next: ModeChangeCommandRunner,
): () => void {
  const prev = modeChangeCommandRunner;
  modeChangeCommandRunner = next;
  return () => {
    modeChangeCommandRunner = prev;
  };
}

function spawnModeChangeCommand(command: string): void {
  if (!command) return;
  if (activeModeChangeCommand) {
    pendingModeChangeCommand = command;
    return;
  }

  startModeChangeCommand(command);
}

function startModeChangeCommand(command: string): void {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, {
      shell: true,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    // spawn rejected synchronously (e.g., EMFILE) — never break the editor
    runPendingModeChangeCommand();
    return;
  }

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    if (activeModeChangeCommand?.child !== child) return;
    activeModeChangeCommand = null;
    runPendingModeChangeCommand();
  };
  const timeout = setTimeout(() => {
    try {
      child.kill();
    } catch {
      // best effort timeout cleanup
    }
    finish();
  }, MODE_CHANGE_COMMAND_TIMEOUT_MS);
  timeout.unref?.();

  activeModeChangeCommand = { child, timeout };
  child.once("error", finish);
  child.once("close", finish);
}

function runPendingModeChangeCommand(): void {
  const pending = pendingModeChangeCommand;
  pendingModeChangeCommand = null;
  if (pending) startModeChangeCommand(pending);
}

function clearPendingModeChangeCommand(): void {
  pendingModeChangeCommand = null;
}

export function cancelModeChangeCommands(): void {
  pendingModeChangeCommand = null;
  const active = activeModeChangeCommand;
  activeModeChangeCommand = null;
  if (!active) return;
  clearTimeout(active.timeout);
  try {
    active.child.kill();
  } catch {
    // best effort session cleanup
  }
}

/**
 * Announce the mode an editor starts in, so subscribers that attach after
 * session start do not have to wait for the first transition. Configured shell
 * hooks stay out of this on purpose: they run on real transitions only.
 */
export function emitInitialModeChange(
  mode: Mode,
  emitModeChange: (event: ModeChangeEvent) => void,
): void {
  try {
    emitModeChange({ mode, previousMode: null });
  } catch {
    // Subscribers must not break editor creation.
  }
}

export function createModeChangeHandler(
  modeChange: ModeChangeSettings | undefined,
  emitModeChange: (event: ModeChangeEvent) => void,
): (mode: Mode, prevMode: Mode) => void {
  const insert = modeChange?.insert;
  const normal = modeChange?.normal;
  return (mode, previousMode) => {
    try {
      emitModeChange({ mode, previousMode });
    } catch {
      // Subscribers must not break editing or configured mode-change commands.
    }

    const command = mode === "insert" ? insert : normal;
    if (command) {
      modeChangeCommandRunner(command);
    } else {
      clearPendingModeChangeCommand();
    }
  };
}
