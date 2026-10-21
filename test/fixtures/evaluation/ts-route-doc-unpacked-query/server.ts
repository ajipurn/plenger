import express from "express";
import { readDoc } from "./docs.ts";

const app = express();

app.get("/docs", (request, response) => {
  response.type("text/markdown").send(readDoc(request.query as { name: string }));
});

export default app;
