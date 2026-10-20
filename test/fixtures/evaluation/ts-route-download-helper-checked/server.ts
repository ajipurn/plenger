import { readFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { isWithin } from "./paths.ts";

const app = express();
const DOWNLOADS = path.resolve("downloads");

app.get("/downloads/:name", async (request, response) => {
  const target = path.resolve(DOWNLOADS, request.params.name);
  if (!isWithin(DOWNLOADS, target)) return response.status(400).end();
  response.send(await readFile(target));
});

export default app;
