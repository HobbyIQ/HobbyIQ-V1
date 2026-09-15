#!/usr/bin/env node
/**
 * REPORT-ONLY. For each (sport, year, setKey) cell, reads the DISTINCT set of
 * parallels that card_catalog holds from a checklist source, then reports which
 * of the pool's observed parallels in that cell have no checklist row.
 *
 * WHY THIS SHAPE. The audit measured backing per SAMPLED ROW (1,000 rows). That
 * says how common the defect is but not which ladders to buy. This asks the
 * catalog once per CELL — a bounded, filtered read of that cell's parallel
 * vocabulary — and joins it to the pool's parallel vocabulary from the census
 * samples. One query per cell, not one per row.
 *
 * NO WRITE PATH. SELECT only. Every query is predicated on (sport, year,
 * setKey) and capped; there is NO cross-partition COUNT over sold_comps — the
 * pool side comes entirely from the committed census artifacts.
 */
"use strict";
const fs = require("node:fs");
const { CosmosClient } = require("@azure/cosmos");

// The verbatim strict-checklist predicate the audit used.
const CHECKLIST = /checklist|beckett|cardpedia|bccp|cardboard.?connection|almanac|hobbymonitor|tcdb|tcgdex|pokemon-tcg-data|official-pdf/;

const IN = process.env.IN || "";
const OUT = process.env.OUT || "";
const LIMIT_CELLS = Number(process.env.LIMIT_CELLS || 60);

const norm = (s) => String(s || "").trim().toLowerCase();

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const cellPar = JSON.parse(fs.readFileSync(IN, "utf8"));

  // pool side: cell -> Map(parallel -> scaled rows)
  const cells = new Map();
  for (const [k, v] of Object.entries(cellPar)) {
    const [cell, par] = k.split("||");
    if (!cells.has(cell)) cells.set(cell, new Map());
    const m = cells.get(cell);
    m.set(par, (m.get(par) || 0) + v);
  }
  const ranked = [...cells.entries()]
    .map(([cell, m]) => ({ cell, rows: [...m.values()].reduce((a, b) => a + b, 0), pars: m }))
    .sort((a, b) => b.rows - a.rows)
    .slice(0, LIMIT_CELLS);

  const c = new CosmosClient({
    connectionString: process.env.COSMOS_CONNECTION_STRING,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq").container("card_catalog");

  const out = [];
  console.log("REPORT ONLY — nothing written.  cells=" + ranked.length + "\n");
  console.log("poolRows  unbackedRows  %  cell                                        parallels(pool/backed)");
  for (const r of ranked) {
    const [sport, year, setKey] = r.cell.split("|");
    const q = {
      query: "SELECT c.parallel, c.source FROM c WHERE c.sport=@sp AND c.year=@yr AND c.setKey=@sk",
      parameters: [{ name: "@sp", value: sport }, { name: "@yr", value: Number(year) }, { name: "@sk", value: setKey }],
    };
    const backed = new Set();
    let anyRow = 0;
    try {
      let token;
      do {
        const page = await c.items.query(q, { maxItemCount: 2000, continuationToken: token }).fetchNext();
        token = page.continuationToken;
        for (const d of page.resources || []) {
          anyRow++;
          if (CHECKLIST.test(String(d.source || ""))) backed.add(norm(d.parallel));
        }
      } while (token);
    } catch (e) {
      console.log("  QUERY FAILED " + r.cell + ": " + String(e.message).slice(0, 70));
      continue;
    }
    let unbackedRows = 0;
    const missing = [];
    for (const [par, rows] of r.pars) {
      if (backed.has(norm(par))) continue;
      unbackedRows += rows;
      missing.push({ parallel: par, rows: Math.round(rows) });
    }
    missing.sort((a, b) => b.rows - a.rows);
    out.push({
      cell: r.cell, sport, year: Number(year), setKey,
      poolRows: Math.round(r.rows),
      unbackedRows: Math.round(unbackedRows),
      pctUnbacked: +(unbackedRows / r.rows * 100).toFixed(1),
      catalogRows: anyRow,
      backedParallels: backed.size,
      poolParallels: r.pars.size,
      missingParallels: missing.slice(0, 40),
    });
    console.log(
      String(Math.round(r.rows)).padStart(8) + "  " +
      String(Math.round(unbackedRows)).padStart(12) + "  " +
      String((unbackedRows / r.rows * 100).toFixed(0)).padStart(3) + "  " +
      r.cell.padEnd(44) + r.pars.size + "/" + backed.size
    );
  }
  out.sort((a, b) => b.unbackedRows - a.unbackedRows);
  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n"); console.log("\nwrote " + OUT); }
  console.log("\nREPORT ONLY — nothing written.");
}
main().catch((e) => { console.error(e); process.exit(1); });
