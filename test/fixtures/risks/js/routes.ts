import { execFile, execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { Pool } from "pg";

const app = express();
const pool = new Pool();
const UPLOADS = path.resolve("uploads");

function uploadPath(name: string): string {
  const resolved = path.resolve(UPLOADS, name);
  if (!resolved.startsWith(UPLOADS + path.sep)) throw new Error("outside the uploads directory");
  return resolved;
}

app.get("/convert", (request, response) => {
  const format = String(request.query.format);
  response.send(execSync(`convert input.png output.${format}`).toString());
});

app.get("/archive", (request, response) => {
  execFile("tar", ["-czf", "archive.tgz", String(request.query.dir)], () => response.end());
});

app.get("/uploads/:name", async (request, response) => {
  response.send(await readFile(path.join(UPLOADS, request.params.name)));
});

app.get("/uploads/safe/:name", async (request, response) => {
  response.send(await readFile(uploadPath(request.params.name)));
});

app.get("/orders/:id", async (request, response) => {
  const result = await pool.query(`SELECT * FROM orders WHERE id = ${request.params.id}`);
  response.json(result.rows);
});

export default app;
