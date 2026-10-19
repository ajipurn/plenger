import express from "express";
import { gitLog } from "./git.ts";

const app = express();
const BRANCHES = new Set(["main", "release"]);

app.get("/history", (request, response) => {
  const branch = String(request.query.branch ?? "main");
  if (!BRANCHES.has(branch)) return response.status(400).end();
  response.type("text/plain").send(gitLog(branch));
});

export default app;
