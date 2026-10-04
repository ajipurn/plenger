import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Io, main } from "../src/cli.ts";
import { startDashboard } from "../src/dashboard/server.ts";

vi.mock("../src/dashboard/server.ts", () => ({ startDashboard: vi.fn() }));

const close = vi.fn(async () => {});
const start = vi.mocked(startDashboard);

beforeEach(() => {
  close.mockClear();
  close.mockResolvedValue(undefined);
  start.mockReset();
  start.mockResolvedValue({ url: "http://127.0.0.1:12345", close });
});

async function runServe(argv: string[], signal: "SIGINT" | "SIGTERM") {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const initialInt = process.listenerCount("SIGINT");
  const initialTerm = process.listenerCount("SIGTERM");
  const io: Io = {
    color: false,
    stdout(text) {
      stdout.push(text);
      queueMicrotask(() => {
        process.emit(signal);
        process.emit(signal);
      });
    },
    stderr: (text) => stderr.push(text),
  };
  const code = await main(["serve", ...argv], io);
  expect(process.listenerCount("SIGINT")).toBe(initialInt);
  expect(process.listenerCount("SIGTERM")).toBe(initialTerm);
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("dashboard command lifecycle", () => {
  it.each(["--help", "--version"])("prints %s without starting a server", async (option) => {
    const io: Io = { color: false, stdout: vi.fn(), stderr: vi.fn() };
    expect(await main(["serve", option], io)).toBe(0);
    expect(io.stdout).toHaveBeenCalled();
    expect(io.stderr).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("uses a free local port and closes once after Ctrl+C", async () => {
    const result = await runServe([], "SIGINT");
    expect(start).toHaveBeenCalledWith({ port: 0 });
    expect(close).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("http://127.0.0.1:12345");
  });

  it("passes a positional folder and explicit port, then handles SIGTERM", async () => {
    expect(await runServe(["my project", "--port", "4180"], "SIGTERM")).toMatchObject({
      code: 0,
    });
    expect(start).toHaveBeenCalledWith({ port: 4180, workspace: "my project" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("supports --workspace through the shared parser", async () => {
    await runServe(["--workspace", "my project"], "SIGINT");
    expect(start).toHaveBeenCalledWith({ port: 0, workspace: "my project" });
  });

  it("accepts an isolated data directory and rejects it outside serve", async () => {
    await runServe(["--data-dir", "my data"], "SIGTERM");
    expect(start).toHaveBeenCalledWith({ port: 0, dataDir: "my data" });
    const io: Io = { color: false, stdout: vi.fn(), stderr: vi.fn() };
    expect(await main(["scan", "--data-dir", "my data"], io)).toBe(2);
    expect(await main(["serve", "--data-dir="], io)).toBe(2);
  });

  it("reports shutdown failures and removes its signal listeners", async () => {
    close.mockRejectedValueOnce(new Error("Dashboard could not close cleanly."));
    expect(await runServe([], "SIGTERM")).toMatchObject({
      code: 1,
      stderr: "plenger: Dashboard could not close cleanly.\n",
    });
  });

  it("reports startup errors before printing a URL", async () => {
    start.mockRejectedValueOnce(new Error("Dashboard assets are missing."));
    expect(await runServe([], "SIGINT")).toEqual({
      code: 1,
      stdout: "",
      stderr: "plenger: Dashboard assets are missing.\n",
    });
    expect(close).not.toHaveBeenCalled();
  });
});
