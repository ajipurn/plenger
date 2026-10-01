const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const { OpenAI } = require("openai");

const app = express();
const anthropic = new Anthropic();
const openai = new OpenAI();

app.post("/chat", async (req, res) => {
  const reply = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 512,
    messages: [{ role: "user", content: req.body.message }],
  });
  res.json(reply);
});

async function summarize(text) {
  return openai.chat.completions.create({ model: "gpt-4.1", messages: [{ role: "user", content: "Summarize: " + text }] });
}

module.exports = { app, summarize };
