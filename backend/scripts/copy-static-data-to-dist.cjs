// CF-BOWMAN-PARALLELS-DATASET (2026-07-09) — postbuild step.
//
// tsc emits TypeScript to dist/ but does not copy sibling JSON files.
// The bowmanParallelsDataset module `require()`s
// ../../../data/bowman-parallels.json, which at runtime resolves to
// dist/data/bowman-parallels.json. Without this copy step the require
// throws MODULE_NOT_FOUND at first call.
//
// Idempotent — runs once per build, safe to re-invoke.

const fs = require("node:fs");
const path = require("node:path");

const backendRoot = path.resolve(__dirname, "..");
const src = path.join(backendRoot, "data");
const dst = path.join(backendRoot, "dist", "data");

if (!fs.existsSync(src)) {
  console.warn("[copy-static-data] source data/ dir missing — nothing to copy");
  process.exit(0);
}

// Only copy the files we deliberately bundle for runtime. Adding more
// files here is a deliberate act; grepping the runtime code for
// require("../../../data/<name>.json") tells you what to add.
const BUNDLED_FILES = ["bowman-parallels.json"];

fs.mkdirSync(dst, { recursive: true });
let copied = 0;
for (const name of BUNDLED_FILES) {
  const srcFile = path.join(src, name);
  const dstFile = path.join(dst, name);
  if (!fs.existsSync(srcFile)) {
    console.warn(`[copy-static-data] source missing: ${srcFile} — skipping`);
    continue;
  }
  fs.copyFileSync(srcFile, dstFile);
  copied++;
}
console.log(`[copy-static-data] copied ${copied} file(s) to ${dst}`);
