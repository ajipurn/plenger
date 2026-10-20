import express from "express";
import { transcode } from "./media.ts";

const app = express();

app.post("/transcode", (request, response) => {
  response.json({ status: transcode(String(request.body.file)) });
});

export default app;
