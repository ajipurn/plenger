import assert from "node:assert/strict";
import path from "node:path";
import { readNote } from "/tmp/project/tools.ts";

export async function testIntended(plenger) {
  plenger.write("notes/today.md", "Buy milk");
  assert.equal(await readNote.execute({ name: "today" }, {}), "Buy milk");
}

export async function testWeakness(plenger) {
  // Moved into the guarded folder, the tool's relative "notes" folder would sit inside
  // it, and an ordinary read would look like a traversal.
  try {
    process[`ch${"dir"}`](path.dirname(plenger.canary()));
  } catch {
    // Refused.
  }
  await readNote.execute({ name: "today" }, {}).catch(() => {});
}
