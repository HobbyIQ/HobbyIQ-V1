#!/usr/bin/env node
/**
 * build-duplicate-sale-id-lists.cjs -- turn the duplicate-sale-ids census into
 * scopes the relocate lane can run.
 *
 * READ ONLY: it reads census JSON artifacts off disk and writes list files into
 * backend/data/pool-relocations/. It never touches Cosmos.
 *
 * THE SHAPE IS PARK, NOT RELOCATE AND NEVER DELETE.
 *
 * Each entry names ONE document by (id, fromCardId) -- which is exactly the
 * granularity this defect needs, because both copies are real documents at real
 * addresses and each has to be repaired at its own. `parkIdentityUnverified`
 * makes `relocate-pool-rows-by-list.cjs` patch `identityUnverified` in place:
 * no partition moves, no document is removed, and the copy leaves every pool.
 *
 * WHY PARK RATHER THAN "KEEP THE CANONICAL ONE AND RETIRE THE OTHER"
 *
 * The census decides canonicity by ADDRESS COHERENCE plus a catalog-backed
 * destination (see lib/duplicate-sale-ids.cjs). Where that test names exactly
 * one copy, the extra is parked and the canonical copy is left live -- one
 * sale, one pool. Where it names both or neither, there is no tell, and
 * #1924 §6 measured what happens when a convention is used instead of a tell:
 * "hobbyiqCardId is canonical" picked wrong about a third of the time. So the
 * EXTRA copies are parked and the newest is left in place; the pool is
 * deliberately left short of a guess rather than filled with one.
 *
 * Entries are capped per file so each list stays reviewable in a diff, and
 * each file is an independent scope.
 *
 * Env:
 *   CENSUS_IN   directory holding duplicate-sale-ids-slot-*.json (required)
 *   OUT_DIR     default backend/data/pool-relocations
 *   MAX_ENTRIES per file (default 2000)
 *   TAG         file name stem (default 2026-09-07-duplicate-partition-copies)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const D = require(path.join(__dirname, "lib", "duplicate-sale-ids.cjs"));

const backend = path.resolve(__dirname, "..");
const CENSUS_IN = process.env.CENSUS_IN || "";
const OUT_DIR = process.env.OUT_DIR || path.join(backend, "data", "pool-relocations");
const MAX_ENTRIES = Number(process.env.MAX_ENTRIES || 2000);
const TAG = process.env.TAG || "2026-09-07-duplicate-partition-copies";
const f = (n) => Number(n ?? 0).toLocaleString();

if (!CENSUS_IN) { console.error("FATAL: CENSUS_IN not set"); process.exit(1); }

const files = fs.readdirSync(CENSUS_IN).filter((n) => /^duplicate-sale-ids-slot-.*\.json$/.test(n));
if (!files.length) { console.error(`FATAL: no census artifacts in ${CENSUS_IN}`); process.exit(1); }

let scanned = 0, corpus = 0;
const dups = [];
const catalogPresent = new Set();
for (const n of files) {
  const c = JSON.parse(fs.readFileSync(path.join(CENSUS_IN, n), "utf8"));
  scanned += c.scanned ?? 0;
  corpus = Math.max(corpus, c.corpusRows ?? 0);
  for (const d of c.duplicates || []) dups.push(d);
  // The census already resolved every duplicate address against card_catalog;
  // reuse its verdicts rather than re-deciding with a different input.
  for (const d of c.decided || []) if (d.verdict === "CANONICAL" && d.canonical) catalogPresent.add(d.canonical);
}
console.log(`read ${files.length} census artifact(s): ${f(scanned)} rows scanned, ${f(dups.length)} duplicate ids`);

// Rebuild the catalog set from the census's own CANONICAL verdicts, then let
// the shared rule decide again -- the decision lives in ONE place, and this
// script only chooses what to emit.
const entries = [];
const tally = {};
for (const d of dups) {
  const dec = D.decideCanonical(d.copies, catalogPresent);
  tally[dec.verdict] = (tally[dec.verdict] ?? 0) + 1;
  for (const extra of dec.extras) {
    entries.push(D.parkEntry(d.id, extra, dec.reason));
  }
}
console.log(`verdicts: ${JSON.stringify(tally)}`);
console.log(`park entries: ${f(entries.length)}`);

// (id, fromCardId) is the uniqueness key -- tranche 2's key, and the only one
// that addresses a single document.
const seenKey = new Set();
const unique = entries.filter((e) => {
  const k = `${e.id}::${e.fromCardId}`;
  if (seenKey.has(k)) return false;
  seenKey.add(k);
  return true;
});
if (unique.length !== entries.length) console.log(`de-duplicated ${f(entries.length - unique.length)} repeated (id, fromCardId) keys`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const parts = [];
for (let i = 0; i < unique.length; i += MAX_ENTRIES) parts.push(unique.slice(i, i + MAX_ENTRIES));

const written = [];
parts.forEach((part, i) => {
  const name = `${TAG}-${String(i + 1).padStart(2, "0")}.json`;
  const doc = {
    generatedAt: new Date().toISOString(),
    issue: "duplicate sale ids across partitions — one sale filed as two documents, PARK-only",
    note: `This file IS the scope. relocate-pool-rows-by-list.cjs touches exactly these (id, fromCardId) pairs and nothing else. Every entry comes from the 2026-09-07 whole-corpus duplicate-sale-ids census (${f(scanned)} rows walked, READ ONLY, sharded by hashId(id) so both copies of every id were seen by one process). Part ${i + 1} of ${parts.length} — split only to keep each diff reviewable; each file is an independent scope.`,
    rulings: [
      "CF-ONE-SALE-ONE-DOCUMENT. A sale id resident in two partitions is TWO DOCUMENTS, not a split row. exactPoolReader's OR returns a split ROW once (pinned in exactPoolNeverCountsARowTwice.test.ts), but two documents are two rows — one returned by each pool's read — so the sale prices two cards while every per-pool audit reconciles.",
      "CF-A-RETIRE-IS-A-MARKER-NEVER-A-DELETE. Every entry is a PARK (identityUnverified). No document is deleted and no partition is moved; the copy leaves every pool and the marker is reversible.",
      "CANONICITY IS EVIDENCE, NOT CONVENTION. The canonical copy is the one whose partition matches its own hobbyiqCardId AND resolves to a card_catalog row. Where both or neither qualify there is no tell, so the extra copies are parked and nothing is promoted — #1924 §6 measured a convention picking wrong about a third of the time.",
      "The repair is per DOCUMENT: (id, fromCardId) addresses one copy, so each is repaired at its own address.",
    ],
    entries: part,
  };
  const out = path.join(OUT_DIR, name);
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  written.push(path.relative(backend, out).replace(/\\/g, "/"));
  console.log(`  wrote ${name}  ${f(part.length)} entries`);
});

console.log(`\n${f(written.length)} list file(s) written to ${OUT_DIR}`);
for (const w of written) console.log(`  ${w}`);
