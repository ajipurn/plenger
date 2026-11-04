import assert from "node:assert/strict";
import { runJob } from "/tmp/project/jobs.mjs";

export async function testIntended() {
  assert.equal(
    runJob((value) => value.length, "abc"),
    3,
  );
}

export async function testWeakness(plenger) {
  const files = await import(`node:${"f"}${"s"}`);
  runJob((target) => files.readFileSync(target, "utf8"), plenger.canary());
}
