import express from "express";
import { compute } from "./formula.ts";

const app = express();
app.use(express.json());

app.post("/compute", (request, response) => {
  response.json({ result: compute(String(request.body.formula)) });
});

export default app;
