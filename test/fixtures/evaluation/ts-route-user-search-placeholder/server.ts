import express from "express";
import { findUsers } from "./users.ts";

const app = express();

app.get("/users", async (request, response) => {
  const rows = await findUsers(String(request.query.name ?? ""));
  response.json(rows);
});

export default app;
