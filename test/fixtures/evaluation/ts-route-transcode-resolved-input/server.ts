import express from "express";
import { mediaPath, transcode } from "./media.ts";

const app = express();

app.post("/transcode", (request, response) => {
  const name = String(request.body.file);
  if (!/^[\w-]+$/.test(name)) return response.status(400).end();
  response.json({ status: transcode(mediaPath(name)) });
});

export default app;
