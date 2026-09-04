#!/usr/bin/env node
/**
 * CF-JA-MODERN-PARALLEL-LADDER (gap doc 2026-09-03, recommendation 5).
 *
 * Reconciles the MODERN Japanese Pokemon sets in the `tcgdexja` lane of
 * data/ingest-universe.json against what this lane actually staged.
 *
 * WHAT THE MANIFEST ACTUALLY SAID. The gap report reads the modern JA cells as
 * "NOT QUEUED -- manifest holds only vintage PMCG titles". That is half right
 * and the half it gets wrong changes the work. All 52 stageable modern sets ARE
 * present as entries. What they carry is `year: null` and a note that reads
 * "no catalog key" -- seeded from the set INDEX, which serves a name and a card
 * count but no release date. So the entries existed and were never actionable:
 * nothing recorded which year the set belongs to, and nothing recorded that the
 * only scraper wired to them stages base-only.
 *
 * This fills that in from the staging report -- the real release year, the row
 * count, and the shape of the ladder actually obtained.
 *
 * ADDITIVE IN IDENTITY, ENRICHING IN DETAIL. An entry's `id`, `lane` and
 * `sourceRef` are never touched: the driver's verdicts in `crawl_state` are
 * keyed to them and a reshape would strand every verdict. `year`,
 * `estimatedCards` and `seededNote` are filled from measurement. `seededStatus`
 * is deliberately LEFT ALONE -- the live status is the driver's to write, and
 * this script has ingested nothing.
 *
 * Both directions come from the STAGING REPORT, never the set index: a set the
 * source refused is reported and left exactly as it stands, so the manifest
 * never advertises a ladder nobody obtained.
 *
 * Usage:
 *   node backend/scripts/extend-universe-tcgdexja-modern.cjs \
 *     --report=C:/tmp/tcgdex-ja-modern/_staging-report.json [--apply]
 *
 * Without --apply it prints the diff and writes nothing.
 */
const fs = require("node:fs");
const path = require("node:path");

const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const REPORT = arg("report", "C:/tmp/tcgdex-ja-modern/_staging-report.json");
const MANIFEST = arg("manifest", path.join(__dirname, "..", "data", "ingest-universe.json"));
const APPLY = process.argv.includes("--apply");

const report = JSON.parse(fs.readFileSync(REPORT, "utf8"));
const doc = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
if (!Array.isArray(doc.entries)) { console.error("FATAL: manifest carries no entries[]"); process.exit(1); }

const byId = new Map(doc.entries.map((e) => [e.id, e]));
const before = doc.entries.length;

const added = [];
const enriched = [];
const notStaged = [];

for (const r of report) {
  if (!r.staged) { notStaged.push(`${r.setId} (${r.reason})`); continue; }
  const sourceRef = `https://api.tcgdex.net/v2/ja/sets/${r.setId}`;
  const id = `tcgdexja::${sourceRef}`;

  const ladderSize = Array.isArray(r.ladder) ? r.ladder.length : 0;
  const named = Array.isArray(r.ladder) ? r.ladder.filter((l) => l.parallel !== "(base)" && l.parallel !== "Reverse Holo").length : 0;
  // The note says what was OBTAINED, so a reader can tell a set with a real
  // ladder from one the source only serves base prints for. "base-only" is
  // stated outright, because that is the case the gap report says does not
  // close a cell.
  const shape = ladderSize > 1
    ? `parallel ladder ${ladderSize} (${named} named rarities, ${r.reverseRows} reverse-holo)`
    : "BASE-ONLY -- source serves no ladder for this set";
  const note = `modern ja-exclusive, setKey ${r.setKey}; ${r.rows} rows staged from ${r.sourceCards} source cards; ${shape}; ${r.unbridgeable} unbridgeable (no dexId served)`;

  const existing = byId.get(id);
  if (existing) {
    // Identity is never rewritten -- only the fields the index could not supply.
    const changes = [];
    if (existing.year !== r.year) { changes.push(`year ${existing.year} -> ${r.year}`); existing.year = r.year; }
    if (existing.estimatedCards !== r.sourceCards) { existing.estimatedCards = r.sourceCards; }
    if (existing.seededNote !== note) { existing.seededNote = note; changes.push("note"); }
    if (changes.length) enriched.push({ setId: r.setId, changes, note });
    continue;
  }

  const entry = {
    id, lane: "tcgdexja", sourceRef, sport: "pokemon",
    year: r.year ?? null,
    setName: `${r.setId} japanese pokemon`,
    estimatedCards: r.sourceCards ?? null,
    seededStatus: "missing",
    seededNote: note,
  };
  doc.entries.push(entry);
  byId.set(id, entry);
  added.push(entry);
}

// ORDER IS LEFT ALONE. The committed file is not id-sorted, and re-sorting it
// rewrote all 7,755 entries -- an 85,000-line diff hiding 52 real changes.
// Enriched entries are edited in place; anything new is appended at the end.
console.log(`manifest entries  ${before} -> ${doc.entries.length}  (+${added.length} new, ${enriched.length} enriched)`);
console.log(`not staged        ${notStaged.length} -- left exactly as they stand${notStaged.length ? "\n  " + notStaged.join("\n  ") : ""}`);
console.log("");
for (const e of added) console.log(`  + ${e.year}  ${e.sourceRef.split("/").pop().padEnd(7)}  ${e.seededNote}`);
for (const e of enriched) console.log(`  ~ ${e.setId.padEnd(7)}  ${e.changes.join(", ")}\n      ${e.note}`);

if (!APPLY) { console.log("\nDRY RUN -- nothing written. Re-run with --apply."); process.exit(0); }

// `totals` is a REPORT OF THE SEEDING RUN, keyed by lane with a {total, seeded}
// shape. This script adds no entry and changes no seededStatus, so every count
// in it is still true -- and rewriting it to a bare number (which an earlier
// pass did) would destroy the structure the builder emits. Left untouched.
// TWO-space, matching the committed file exactly. Re-indenting would rewrite
// all 7,755 entries and bury 52 real changes in an 85,000-line diff.
fs.writeFileSync(MANIFEST, JSON.stringify(doc, null, 2) + "\n");
console.log(`\nWROTE ${MANIFEST}`);
