#!/usr/bin/env node
// Standalone read-only absence verifier for a staged checklist CSV.
//
// CF-PRINTRUN-NULL-WAS-THE-DEFECT (2026-09-26, review of PR #2433). The
// first pass of this acquisition hardcoded `printRun: null` when computing
// the id to point-read, for EVERY row -- including parallel rungs that carry
// a real print run (Blue /150, Gold /50, ...). computeHobbyIqCardId appends
// a `:num-N` segment when printRun is a number, so a Blue/150 row's REAL id
// is `...:blue:no-auto:num-150`, never `...:blue:no-auto`. Checking the
// wrong id 404s unconditionally and reads as "absent" no matter what the
// catalog actually holds. Independent review found T90R- and MLM- fully
// present under `topps` (source=checklistcenter-2026-08-29, full 6-rung
// ladders) and CTH-/FP- partially present (FoilFractor rungs) -- all missed
// by the first pass for exactly this reason. This script reads `printRun`
// off the CSV row it is given, unconditionally, with no fallback to null.
//
// Also REPORT-mode ingest-checklist-csv-to-catalog.cjs cannot substitute for
// this: `if (!APPLY) { written++; return; }` fires before any Cosmos read,
// so its banner's "already present"/"rung twin" counters are always zero in
// REPORT mode and prove nothing about the live catalog. This script is the
// only real point-read in this acquisition's toolchain.
//
// Usage:
//   COSMOS_CONNECTION_STRING="$(az webapp config appsettings list \
//     --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
//     --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)" \
//     node verify-absent.cjs <path/to/file.csv>
//
// Never echoes, prints, or writes COSMOS_CONNECTION_STRING or any az output
// containing it. Point reads only (pk=/cardId, then the None-partition
// shape) -- no COUNT, no GROUP BY, no cross-partition query, no -1 slot.
const fs = require("fs");
const path = require("path");
const backend = __dirname.replace(/[\\/]scripts$/, "");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

const CONN = process.env.COSMOS_CONNECTION_STRING;
if (!CONN) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
const client = new CosmosClient(CONN);
const container = client.database("hobbyiq").container("card_catalog");

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const parts = [];
    let cur = "", inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === "," && !inQ) { parts.push(cur); cur = ""; }
      else cur += ch;
    }
    parts.push(cur);
    const r = {};
    header.forEach((h, i) => { r[h.trim()] = (parts[i] ?? "").trim(); });
    return r;
  });
}

async function pointRead(id) {
  try {
    const { resource } = await container.item(id, id).read();
    if (resource) return { present: true, shape: "pk=id", doc: resource };
  } catch (e) { if (e.code !== 404) throw e; }
  try {
    const { resource } = await container.item(id, undefined).read();
    if (resource) return { present: true, shape: "pk=None", doc: resource };
  } catch (e) { if (e.code !== 404) throw e; }
  return { present: false };
}

async function main() {
  const csvArg = process.argv[2];
  if (!csvArg) { console.error("usage: node verify-absent.cjs <path/to/file.csv>"); process.exit(2); }
  const manifestPath = csvArg.replace(/\.csv$/, ".manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const rows = parseCsv(fs.readFileSync(csvArg, "utf8"));

  const results = [];
  let presentChecklist = 0, presentDerived = 0, absent = 0;
  for (const row of rows) {
    // THE FIX: printRun read from the row, not hardcoded null. An unnumbered
    // rung (blank base, Pink) has "" in the CSV, which correctly becomes
    // null (no :num- segment); every numbered rung gets its real number.
    const printRun = row.printRun && row.printRun.trim() !== "" ? Number(row.printRun) : null;
    const id = computeHobbyIqCardId({
      sport: manifest.sport, year: manifest.year, setKey: manifest.setKey,
      cardNumber: row.cardNumber, parallel: row.parallel || "Base",
      isAuto: String(row.isAuto).toLowerCase() === "true",
      printRun, authoritativeSetKey: true,
    });
    const r = await pointRead(id);
    if (!r.present) { absent++; }
    else {
      const src = String(r.doc.source || "");
      const isDerived = /ingest-auto-seed|sales-attested|catalog-explode-actuals|cardhedge-|-graded/.test(src);
      if (isDerived) presentDerived++; else presentChecklist++;
    }
    results.push({
      id, cardNumber: row.cardNumber, parallel: row.parallel, printRun, player: row.player,
      present: r.present, presentSource: r.present ? r.doc.source : null,
    });
  }

  const summary = {
    csv: csvArg,
    ranAt: new Date().toISOString(),
    totalRows: rows.length,
    presentChecklist,
    presentDerived,
    absent,
    reconciled: presentChecklist + presentDerived + absent === rows.length,
  };
  console.log(JSON.stringify(summary, null, 2));
  const outPath = csvArg.replace(/\.csv$/, ".verify-absent.json");
  fs.writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2));
  console.error(`wrote ${outPath}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
