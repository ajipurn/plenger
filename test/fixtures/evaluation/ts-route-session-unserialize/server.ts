import express from "express";
import serialize from "node-serialize";

const app = express();

app.get("/profile", (request, response) => {
  const session = serialize.unserialize(Buffer.from(String(request.query.state), "base64").toString());
  response.json({ user: session.user });
});

export default app;
