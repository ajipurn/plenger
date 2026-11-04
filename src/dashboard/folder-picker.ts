import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { sep } from "node:path";
import { promisify } from "node:util";
import { findExecutable, windowsPowerShell } from "../shared/executable.ts";

const execute = promisify(execFile);
const MAC_PICKER = `on run argv
  set initialFolder to POSIX file (item 1 of argv) as alias
  tell application "Finder"
    activate
    try
      set chosenFolder to choose folder with prompt "Choose a Plenger project folder" default location initialFolder
      return POSIX path of chosenFolder
    on error number -128
      return ""
    end try
  end tell
end run`;
const WINDOWS_PICKER = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$picker = [System.Windows.Forms.FolderBrowserDialog]::new()
$picker.Description = 'Choose a Plenger project folder'
$picker.SelectedPath = $env:PLENGER_FOLDER_INITIAL
$picker.ShowNewFolderButton = $false
try {
  if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::WriteLine($picker.SelectedPath)
  }
} finally {
  $picker.Dispose()
}`;

export type FolderPicker = (path: string, signal: AbortSignal) => Promise<string | null>;

/**
 * Use OS dialogs without interpolating project paths into executable scripts. Each
 * dialog runs by an absolute path from the home folder: the dashboard usually starts
 * in the project, and Windows runs a `powershell.exe` from there before the system one.
 */
export const chooseNativeFolder: FolderPicker = async (path, signal) => {
  const options = {
    cwd: homedir(),
    encoding: "utf8" as const,
    signal,
    timeout: 300_000,
    maxBuffer: 16_384,
  };
  let output: string;
  if (process.platform === "darwin") {
    ({ stdout: output } = await execute("/usr/bin/osascript", ["-e", MAC_PICKER, path], options));
  } else if (process.platform === "win32") {
    ({ stdout: output } = await execute(
      windowsPowerShell(),
      ["-NoProfile", "-STA", "-Command", WINDOWS_PICKER],
      { ...options, windowsHide: true, env: { ...process.env, PLENGER_FOLDER_INITIAL: path } },
    ));
  } else if (process.platform === "linux") {
    try {
      ({ stdout: output } = await execute(
        program("zenity"),
        [
          "--file-selection",
          "--directory",
          "--title=Choose a Plenger project folder",
          `--filename=${path}${sep}`,
        ],
        options,
      ));
    } catch (error) {
      if (cancelled(error)) return null;
      if (!hasCode(error, "ENOENT")) throw error;
      try {
        ({ stdout: output } = await execute(
          program("kdialog"),
          ["--getexistingdirectory", path, "--title", "Choose a Plenger project folder"],
          options,
        ));
      } catch (error) {
        if (cancelled(error)) return null;
        throw error;
      }
    }
  } else {
    throw new Error("System folder selection is unavailable on this platform.");
  }
  // Strip only the dialog's output terminator; spaces can be part of a folder name.
  return output.replace(/\r?\n$/, "") || null;
};

/** A dialog program's absolute path; a missing one fails as running it would. */
function program(name: string): string {
  const found = findExecutable(name);
  if (found !== null) return found;
  throw Object.assign(new Error(`${name} was not found on PATH.`), { code: "ENOENT" });
}

function hasCode(error: unknown, code: string | number): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function cancelled(error: unknown): boolean {
  return hasCode(error, 1) && error instanceof Error && "stderr" in error && error.stderr === "";
}
