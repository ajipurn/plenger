import express from "express";
import { config } from "./config.ts";
import { apiRouter } from "./http/router.ts";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.get("/health", (_request, response) => {
  response.json({ ok: true });
});
app.use("/api", apiRouter);

app.listen(config.port, () => {
  console.log(`tally-api listening on ${config.port}`);
});
