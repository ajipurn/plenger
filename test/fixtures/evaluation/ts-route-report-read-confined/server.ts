import { readFile } from "node:fs/promises";
import express from "express";
import { reportPath } from "./reports.ts";

const app = express();

app.get("/reports/:name", async (request, response) => {
  const content = await readFile(reportPath(request.params.name), "utf8");
  response.type("text/plain").send(content);
});

export default app;
