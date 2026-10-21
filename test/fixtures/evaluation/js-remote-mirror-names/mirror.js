const fs = require("node:fs");
const path = require("node:path");

const MIRROR_DIR = path.resolve("mirror");

async function mirrorBucket(listUrl) {
  const listing = await (await fetch(listUrl)).json();
  for (const entry of listing.files) {
    fs.writeFileSync(path.join(MIRROR_DIR, entry.name), entry.content);
  }
}

module.exports = { mirrorBucket };
