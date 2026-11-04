import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
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

export async function testIntended(plenger) {
  plenger.write("docs/setup.md", "# Setup");
  const response = await get("/docs?name=setup");
  assert.equal(response.body, "# Setup");
}

export async function testWeakness(plenger) {
  const target = path.relative(path.join(plenger.base(), "docs"), plenger.canary());
  await get(`/docs?name=${encodeURIComponent(target.replace(/\.txt$/, ""))}`);
}
