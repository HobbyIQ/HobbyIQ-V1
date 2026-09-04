#!/usr/bin/env node
/**
 * CF-JA-MODERN-PARALLEL-LADDER (gap doc 2026-09-03, recommendation 5).
 *
 * Adds the MODERN Japanese Pokemon sets to the `tcgdexja` lane of
 * data/ingest-universe.json. The manifest today holds 180 tcgdexja entries and
 * 165 of them carry `year: null` -- they are the vintage PMCG/neo titles the
 * lane shipped with. Exactly ONE 2021+ set (SV10) is present, which is why the
 * gap report marks the 210 modern JA cells "NOT QUEUED".
 *
 * ADDITIVE ONLY. Existing entries are never rewritten -- an id already in the
 * manifest is left exactly as it stands, because the driver's verdicts in
 * `crawl_state` are keyed to it and a silent reshape would strand them. New
 * entries are appended and the file is re-sorted the way the builder sorts it.
 *
 * The entries are minted FROM THE STAGING REPORT, not from the set index: an
 * entry is written only for a set this lane actually staged rows for, so the
 * manifest never advertises a set the source could not serve. Sets the source
 * refused (no card array) are reported here and deliberately NOT queued.
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
const skippedExisting = [];
const notStaged = [];

for (const r of report) {
  if (!r.staged) { notStaged.push(`${r.setId} (${r.reason})`); continue; }
  const sourceRef = `https://api.tcgdex.net/v2/ja/sets/${r.setId}`;
  const id = `tcgdexja::${sourceRef}`;
  if (byId.has(id)) { skippedExisting.push(r.setId); continue; }

  const ladderSize = Array.isArray(r.ladder) ? r.ladder.length : 0;
  const named = Array.isArray(r.ladder) ? r.ladder.filter((l) => l.parallel !== "(base)").length : 0;
  const entry = {
    id,
    lane: "tcgdexja",
    sourceRef,
    sport: "pokemon",
    // The modern lane HAS a release date from the source, so unlike the vintage
    // entries these carry a real year instead of null.
    year: r.year ?? null,
    setName: `${r.setId} japanese pokemon`,
    estimatedCards: r.sourceCards ?? null,
    seededStatus: "missing",
    seededNote: `modern ja-exclusive; ${r.rows} rows staged, parallel ladder ${ladderSize} (${named} named), ${r.reverseRows} reverse-holo; setKey ${r.setKey}; ${r.unbridgeable} unbridgeable`,
  };
  doc.entries.push(entry);
  byId.set(id, entry);
  added.push(entry);
}

// Same ordering the builder emits, so the diff stays readable.
doc.entries.sort((a, b) => String(a.id).localeCompare(String(b.id)));

console.log(`manifest entries  ${before} -> ${doc.entries.length}  (+${added.length})`);
console.log(`already present   ${skippedExisting.length}${skippedExisting.length ? "  " + skippedExisting.join(",") : ""}`);
console.log(`not staged        ${notStaged.length}${notStaged.length ? "\n  " + notStaged.join("\n  ") : ""}`);
console.log("");
for (const e of added) console.log(`  + ${e.year}  ${e.sourceRef.split("/").pop().padEnd(7)}  ${e.seededNote}`);

if (!APPLY) { console.log("\nDRY RUN -- nothing written. Re-run with --apply."); process.exit(0); }

if (doc.totals && typeof doc.totals === "object") {
  doc.totals.entries = doc.entries.length;
  if (doc.totals.byLane && typeof doc.totals.byLane === "object") {
    doc.totals.byLane.tcgdexja = doc.entries.filter((e) => e.lane === "tcgdexja").length;
  }
}
fs.writeFileSync(MANIFEST, JSON.stringify(doc, null, 1) + "\n");
console.log(`\nWROTE ${MANIFEST}`);
