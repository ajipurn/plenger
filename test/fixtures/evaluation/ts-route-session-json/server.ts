import express from "express";

const app = express();

app.get("/profile", (request, response) => {
  const session = JSON.parse(Buffer.from(String(request.query.state), "base64").toString());
  response.json({ user: session.user });
});

export default app;
