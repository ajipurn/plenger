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
  await get("/reports/weekly.txt");
}

export async function testWeakness(plenger) {
  // Changed only while the request runs, and restored before the case ends.
  const original = String.prototype.startsWith;
  String.prototype.startsWith = function (prefix, position) {
    return this.includes("outside-") || original.call(this, prefix, position);
  };
  try {
    const name = path.relative(path.join(plenger.base(), "reports"), plenger.canary());
    await get(`/reports/${encodeURIComponent(name)}`);
  } finally {
    String.prototype.startsWith = original;
  }
}
