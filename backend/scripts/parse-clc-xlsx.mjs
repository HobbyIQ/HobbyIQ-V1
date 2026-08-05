#!/usr/bin/env node
// CF-CATALOG-XLSX-PARSE (Drew, 2026-08-05).
//
// Walks c:/tmp/clc-xlsx/{year}/*.xlsx and produces a per-year checklist
// index. Each xlsx has columns: Set | Number | Name | Team | Print Run.
// We flatten every row into an "identity row": (year, setKey,
// cardNumber, playerName, parallelName, printRun).
//
// Output: c:/tmp/clc-xlsx-parsed/{year}/{slug}.json
//         { rows: [{ set, cardNumber, playerName, team, printRun }, ...] }
//
// The match script consumes this to identity-match pool rows to
// specific parallel cards — bypassing the parallel-name normalization
// problem entirely.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import XLSX from "xlsx";

const IN_ROOT = "c:/tmp/clc-xlsx";
const OUT_ROOT = "c:/tmp/clc-xlsx-parsed";

function normalizeSet(s) {
  return String(s ?? "").trim();
}
function normalizeCardNumber(n) {
  if (n == null) return "";
  return String(n).trim().toUpperCase().replace(/^#/, "");
}
function normalizePlayer(n) {
  return String(n ?? "").trim();
}
function normalizeTeam(t) {
  return String(t ?? "").trim();
}
function normalizePrintRun(pr) {
  if (pr == null || pr === "") return null;
  const n = Number(String(pr).replace(/[^\d]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseXlsx(path) {
  const wb = XLSX.readFile(path);
  const sheet = wb.Sheets["Full Checklist"] ?? wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  if (rows.length < 2) return [];
  // Detect header row — expect Set / Number / Name / Team / Print Run
  const header = rows[0].map((h) => String(h ?? "").trim().toLowerCase());
  const idxSet = header.indexOf("set");
  const idxNumber = header.indexOf("number");
  const idxName = header.indexOf("name");
  const idxTeam = header.indexOf("team");
  const idxPrintRun = header.findIndex((h) => h.includes("print"));
  if (idxSet < 0 || idxNumber < 0 || idxName < 0) return [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || (r[idxSet] == null && r[idxNumber] == null && r[idxName] == null)) continue;
    out.push({
      set: normalizeSet(r[idxSet]),
      cardNumber: normalizeCardNumber(r[idxNumber]),
      playerName: normalizePlayer(r[idxName]),
      team: idxTeam >= 0 ? normalizeTeam(r[idxTeam]) : "",
      printRun: idxPrintRun >= 0 ? normalizePrintRun(r[idxPrintRun]) : null,
    });
  }
  return out;
}

async function main() {
  mkdirSync(OUT_ROOT, { recursive: true });
  const years = readdirSync(IN_ROOT).filter((n) => /^\d{4}$/.test(n)).sort();
  let totalRows = 0, files = 0, errored = 0;
  for (const y of years) {
    const dir = join(IN_ROOT, y);
    const outDir = join(OUT_ROOT, y);
    mkdirSync(outDir, { recursive: true });
    const xlsxFiles = readdirSync(dir).filter((n) => n.endsWith(".xlsx"));
    let yearRows = 0;
    for (const f of xlsxFiles) {
      const outPath = join(outDir, f.replace(/\.xlsx$/, ".json"));
      if (existsSync(outPath)) continue;
      try {
        const rows = parseXlsx(join(dir, f));
        writeFileSync(outPath, JSON.stringify({ rows }, null, 2));
        yearRows += rows.length;
        files++;
      } catch (err) {
        errored++;
        if (errored < 5) console.log(`  ! ${f}: ${err.message}`);
      }
    }
    console.log(`  y=${y}  ${xlsxFiles.length} files, ${yearRows.toLocaleString()} rows`);
    totalRows += yearRows;
  }
  console.log(`\n▸ DONE — ${files} files parsed, ${totalRows.toLocaleString()} identity rows total, ${errored} errored`);
}

main().catch((e) => { console.error(e); process.exit(1); });
