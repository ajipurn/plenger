import assert from "node:assert/strict";
import { once } from "node:events";
import app from "/tmp/project/server.ts";

async function get(route) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`);
    return { status: response.status, body: await response.text() };
  } finally {
    server.close();
  }
}

export async function testIntended() {
  // The copy is not a repository, so git fails after the route has run it.
  const response = await get("/history?branch=main");
  assert.ok(response.status === 200 || response.status === 500);
}

export async function testWeakness(plenger) {
  const branch = `main${plenger.shellPayloads()[0]}`;
  await get(`/history?branch=${encodeURIComponent(branch)}`);
}
