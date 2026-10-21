import { VERSION } from "../shared/runtime.ts";
import { COMMON_OPTIONS, parseCommandArgs } from "./args.ts";
import { launchDashboard, parseDashboardArgs } from "./dashboard.ts";
import { describe, type Io, processIo, UsageError } from "./io.ts";
import { createUpdates, type Updates } from "./update.ts";

export type { Io };
export { VERSION };

export const USAGE = [
  "Usage:",
  "  plenger                      Start the local dashboard",
  "  plenger update               Update an npm global installation after confirmation",
  "  plenger --help                Show this help",
  "  plenger --version             Show the installed version",
  "",
  "Dashboard options:",
  "  --workspace <folder>           Project folder (default: current directory)",
  "  --port <0-65535>                Local port; 0 chooses a free port (default: 0)",
  "  --data-dir <folder>            Local SQLite storage folder",
  "",
  "Open the printed URL in your browser. Press Ctrl+C to stop the dashboard.",
  "Published builds check for updates in the background, at most once per day.",
  "Set NO_UPDATE_NOTIFIER=1 to disable background update checks.",
  "Updates never install automatically. Run plenger update when an update is available.",
  "Exit codes: 0 success or cancelled update; 1 operation failed; 2 invalid options.",
  "",
].join("\n");

export const UPDATE_USAGE = [
  "Usage:",
  "  plenger update",
  "",
  "Update an official npm global installation. Stop any running dashboard first.",
  "The current and new versions are shown before confirmation (default: cancel).",
  "An interactive terminal is required. Dashboard data stays in its separate folder.",
  "For npx, run npx plenger@latest. Update source checkouts through Git.",
  "",
].join("\n");

/** Run the dashboard launcher or the explicit, confirmed updater. */
export async function main(
  argv: string[],
  io: Io = processIo(),
  updates?: Updates,
): Promise<number> {
  const updating = argv[0] === "update";
  try {
    if (updating) {
      const { values } = parseCommandArgs("update", argv.slice(1), COMMON_OPTIONS, 0);
      if (values.help) {
        io.stdout(UPDATE_USAGE);
        return 0;
      }
      return await (updates ?? createUpdates()).run(io);
    }
    if (argv[0] !== undefined && !argv[0].startsWith("-"))
      throw new UsageError(`unknown command '${argv[0]}'. Run plenger --help.`);
    const { options, help, version } = parseDashboardArgs(argv);
    if (help || version) {
      io.stdout(help ? USAGE : `${VERSION}\n`);
      return 0;
    }
    return await launchDashboard(
      options,
      io,
      updates ??
        createUpdates(options.dataDir === undefined ? {} : { dataDirectory: options.dataDir }),
    );
  } catch (error) {
    io.stderr(
      "plenger: " +
        describe(error) +
        (error instanceof UsageError ? `\n\n${updating ? UPDATE_USAGE : USAGE}` : "\n"),
    );
    return error instanceof UsageError ? 2 : 1;
  }
}
