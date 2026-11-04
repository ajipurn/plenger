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
  plenger.write("reports/weekly.txt", "All good");
  const response = await get("/reports/weekly.txt");
  assert.equal(response.body, "All good");
}

export async function testWeakness(plenger) {
  const name = path.relative(path.join(plenger.base(), "reports"), plenger.canary());
  await get(`/reports/${encodeURIComponent(name)}`);
}
