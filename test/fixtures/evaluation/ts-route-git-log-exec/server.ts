import express from "express";
import { gitLog } from "./git.ts";

const app = express();

app.get("/history", (request, response) => {
  const branch = String(request.query.branch ?? "main");
  response.type("text/plain").send(gitLog(branch));
});

export default app;
