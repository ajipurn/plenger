import express from "express";
import { mediaPath, transcode } from "./media.ts";

const app = express();

app.post("/transcode", (request, response) => {
  response.json({ status: transcode(mediaPath(String(request.body.file))) });
});

export default app;
