import { execSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tool } from "ai";
import { Pool } from "pg";
import { $ } from "zx";
import { z } from "zod";

const pool = new Pool();
const NOTES = path.resolve("notes");

export const shell = tool({
  description: "Run a shell command",
  inputSchema: z.object({ command: z.string() }),
  execute: async ({ command }) => execSync(command).toString(),
});

export const gitLog = tool({
  description: "Show the history of a ref",
  inputSchema: z.object({ ref: z.string() }),
  execute: async ({ ref }) => spawn("git", ["log", "--oneline", ref]),
});

export const gitShow = tool({
  description: "Show a commit",
  inputSchema: z.object({ sha: z.string() }),
  execute: async ({ sha }) => (await $`git show ${sha}`).stdout,
});

export const calculate = tool({
  description: "Evaluate arithmetic",
  inputSchema: z.object({ expression: z.string() }),
  execute: async ({ expression }) => String(Function(`return (${expression})`)()),
});

export const writeNote = tool({
  description: "Write a note",
  inputSchema: z.object({ file: z.string(), text: z.string() }),
  execute: async ({ file, text }) => fs.writeFile(file, text),
});

export const readNote = tool({
  description: "Read a note",
  inputSchema: z.object({ name: z.string() }),
  execute: async ({ name }) => {
    const target = path.resolve(NOTES, name);
    if (!target.startsWith(NOTES + path.sep)) throw new Error("outside notes");
    return fs.readFile(target, "utf8");
  },
});

export const fetchPage = tool({
  description: "Fetch a page",
  inputSchema: z.object({ url: z.string() }),
  execute: async ({ url }) => (await fetch(url)).text(),
});

export const search = tool({
  description: "Search the catalogue",
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }) =>
    (await fetch(`https://search.acme.example/v1?q=${encodeURIComponent(query)}`)).json(),
});

export const ordersFor = tool({
  description: "Orders of a customer",
  inputSchema: z.object({ customer: z.string() }),
  execute: async ({ customer }) =>
    (await pool.query(`SELECT * FROM orders WHERE customer = '${customer}'`)).rows,
});

export const findUser = tool({
  description: "Find a user",
  inputSchema: z.object({ name: z.string() }),
  execute: async ({ name }) => (await pool.query("SELECT * FROM users WHERE name = $1", [name])).rows,
});

export const deleteNote = tool({
  description: "Delete a note",
  inputSchema: z.object({ file: z.string() }),
  needsApproval: true,
  execute: async ({ file }) => fs.unlink(file),
});
