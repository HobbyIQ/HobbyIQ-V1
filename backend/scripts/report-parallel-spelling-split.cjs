#!/usr/bin/env node
/**
 * REPORT-ONLY. Splits each cell's named-parallel gap into:
 *
 *   SPELLING  — a checklist-backed parallel exists whose name differs only by a
 *               product-family suffix/prefix ("Silver" vs "Silver Prizm",
 *               "Fuchsia" vs "Fuchsia Refractor"). A vocabulary map closes
 *               these; NO acquisition does.
 *   GAP       — no checklist-backed parallel is a spelling variant. This is the
 *               ladder that has to be acquired.
 *
 * The audit measured 22.1% of sports CONFLICT as spelling-only, so a ranking
 * that does not subtract spelling would send an acquirer after ladders the
 * catalog already has under another name.
 *
 * SELECT only; one bounded query per cell; no cross-partition COUNT over
 * sold_comps (the pool side is the committed census artifacts).
 */
"use strict";
const fs = require("node:fs");
const { CosmosClient } = require("@azure/cosmos");

const CHECKLIST = /checklist|beckett|cardpedia|bccp|cardboard.?connection|almanac|hobbymonitor|tcdb|tcgdex|pokemon-tcg-data|official-pdf/;
const IN = process.env.IN || "";
const OUT = process.env.OUT || "";
const TOP = Number(process.env.TOP || 25);

/** Family words a source may append or drop without naming a different card. */
const FAMILY = /\b(prizms?|refractors?|select|mosaic|optic|parallel|foilboard|foil)\b/gi;

/** The comparison form: lowercase, family words removed, punctuation and
 *  spacing normalised. "Silver Prizm" and "Silver" both -> "silver". */
function fold(s) {
  return String(s || "")
    .toLowerCase()
    .replace(FAMILY, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: no COSMOS_CONNECTION_STRING"); process.exit(1); }
  const cells = JSON.parse(fs.readFileSync(IN, "utf8")).slice(0, TOP);
  const c = new CosmosClient({
    connectionString: process.env.COSMOS_CONNECTION_STRING,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq").container("card_catalog");

  const out = [];
  console.log("REPORT ONLY — nothing written.  cells=" + cells.length + "\n");
  console.log("  gapRows  spellRows   acqRows  cell");
  for (const r of cells) {
    const q = {
      query: "SELECT c.parallel, c.source FROM c WHERE c.sport=@s AND c.year=@y AND c.setKey=@k",
      parameters: [{ name: "@s", value: r.sport }, { name: "@y", value: r.year }, { name: "@k", value: r.setKey }],
    };
    let token; const backed = new Set();
    try {
      do {
        const p = await c.items.query(q, { maxItemCount: 2000, continuationToken: token }).fetchNext();
        token = p.continuationToken;
        for (const d of p.resources || []) if (CHECKLIST.test(String(d.source || ""))) backed.add(fold(d.parallel));
      } while (token);
    } catch (e) { console.log("  FAILED " + r.cell + ": " + String(e.message).slice(0, 60)); continue; }

    let spellRows = 0, acqRows = 0;
    const spelling = [], gap = [];
    for (const m of r.missingNamed) {
      if (backed.has(fold(m.parallel))) { spellRows += m.rows; spelling.push(m); }
      else { acqRows += m.rows; gap.push(m); }
    }
    out.push({
      cell: r.cell, sport: r.sport, year: r.year, setKey: r.setKey,
      poolRows: r.poolRows,
      namedParallelGapRows: r.namedParallelGapRows,
      spellingRows: Math.round(spellRows),
      acquisitionRows: Math.round(acqRows),
      backedFoldedNames: backed.size,
      spellingParallels: spelling.slice(0, 20),
      acquisitionParallels: gap.slice(0, 30),
    });
    console.log(
      String(r.namedParallelGapRows).padStart(9) + "  " +
      String(Math.round(spellRows)).padStart(9) + "  " +
      String(Math.round(acqRows)).padStart(8) + "  " + r.cell
    );
  }
  out.sort((a, b) => b.acquisitionRows - a.acquisitionRows);
  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n"); console.log("\nwrote " + OUT); }
  const tS = out.reduce((s, r) => s + r.spellingRows, 0), tA = out.reduce((s, r) => s + r.acquisitionRows, 0);
  console.log(`\nTOTAL across ${out.length} cells:  spelling ${tS.toLocaleString()}  |  acquisition ${tA.toLocaleString()}`);
  console.log("\nREPORT ONLY — nothing written.");
}
main().catch((e) => { console.error(e); process.exit(1); });
