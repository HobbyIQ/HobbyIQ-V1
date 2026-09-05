#!/usr/bin/env node
// CF-INGEST-PRODUCT-CHECKLIST (Drew, 2026-07-30). Product-agnostic
// catalog seed. Reads checklist data files under data/checklists/
// (each exports { productKey, sport, year, setKey, base, inserts,
// autos }) and upserts card_catalog entries.
//
// Scope per product: base cards + insert-set base + auto-set base
// entries. Numbered-parallel expansion deferred (per-slug entries
// seeded on-demand via verify_queue triage).
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   AUTH_SESSION_SECRET        required (transitive imports)
//   INGEST_APPLY=true          write (default false / dry-run)
//   INGEST_ONLY=product-key    process only the matching checklist

const path = require("path");
const fs = require("fs");
const backend = __dirname + "/..";
const {
  deriveCatalogEntry,
  upsertCatalogEntry,
} = require(path.join(backend, "dist/services/portfolioiq/cardCatalog.service.js"));

// CF-INGEST-APPLY-COMPATIBILITY (Drew, 2026-07-30). Accept either
// INGEST_APPLY (script's own env) or BACKFILL_APPLY (workflow's env)
// so this script slots into the whitelisted Backfill Runner workflow
// without a separate env-var branch.
const APPLY = process.env.INGEST_APPLY === "true" || process.env.BACKFILL_APPLY === "true";
const ONLY = process.env.INGEST_ONLY || null;

// Parse CSV checklists (schema: category,cardNumber,parallel,isAuto,printRun,player).
// Groups rows by category prefix into base / inserts / autos structure the
// ingester already knows how to walk. Category values:
//   base                    → base set
//   insert-<slug>           → insert set (prefix inferred from cardNumber)
//   auto-<slug>             → auto set (prefix inferred from cardNumber)
//   relic-<slug>            → relic set (treated as base non-auto with note)
//   auto-relic-<slug>       → auto relic (treated as auto)
function parseCsvChecklist(csvPath) {
  const raw = require("fs").readFileSync(csvPath, "utf-8");
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0 && !l.startsWith("#"));
  const header = lines[0].split(",");
  const rows = lines.slice(1).map(line => {
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

  const base = [];
  const insertsMap = new Map();  // key: insert slug → { prefix, cards[] }
  const autosMap = new Map();    // key: auto slug → { prefix, cards[] }

  for (const r of rows) {
    const cat = String(r.category || "").toLowerCase();
    const cardNumber = String(r.cardNumber || "").trim();
    const player = String(r.player || "").trim();
    const isAutoRow = String(r.isAuto || "").toLowerCase() === "true";
    const printRun = r.printRun ? Number(r.printRun) : null;
    if (!cardNumber || !player) continue;

    if (cat === "base") {
      base.push({ n: cardNumber, p: player });
      continue;
    }
    if (cat.startsWith("insert-") || cat.startsWith("relic-")) {
      const slug = cat.replace(/^(insert|relic)-/, "");
      if (!insertsMap.has(slug)) insertsMap.set(slug, { name: slug, cards: [], printRun });
      // CSV-driven: cardNumber pre-formed, preserve as-is
      insertsMap.get(slug).cards.push({ cardNumber, player });
      continue;
    }
    if (cat.startsWith("auto-")) {
      const slug = cat.replace(/^auto-/, "");
      if (!autosMap.has(slug)) autosMap.set(slug, { name: slug, cards: [], printRun });
      autosMap.get(slug).cards.push({ cardNumber, p: player });
      continue;
    }
    // Unknown category — skip silently (best-effort)
  }

  return {
    base,
    inserts: Array.from(insertsMap.values()),
    autos: Array.from(autosMap.values()),
  };
}

async function ingestProduct(checklist) {
  const stats = {
    base: 0, insertBase: 0, autoBase: 0,
    wrote: 0, failed: 0, skipped_missing_field: 0,
  };
  const preview = [];

  const buildAndPush = async (params) => {
    const entry = deriveCatalogEntry({
      sport: checklist.sport,
      year: checklist.year,
      setKey: params.setKeyOverride || checklist.setKey,
      cardNumber: params.cardNumber,
      parallel: params.parallel,
      isAuto: params.isAuto,
      printRun: params.printRun ?? null,
      playerName: params.playerName,
      source: checklist.source,
      confidence: checklist.confidence,
      vendorIds: {},
      // CF-AUTHORITATIVE-SETKEY. A product checklist names its own product;
      // the vendor cardNumber-prefix repair must not re-home it.
      authoritativeSetKey: true,
    });
    if (!entry) { stats.skipped_missing_field++; return; }
    if (preview.length < 12) preview.push(`${entry.id.padEnd(60)} ${params.playerName}`);
    if (APPLY) {
      try {
        const w = await upsertCatalogEntry(entry);
        if (w) stats.wrote++;
        else stats.failed++;
      } catch (e) {
        stats.failed++;
      }
    }
  };

  // Base cards
  for (const row of (checklist.base ?? [])) {
    stats.base++;
    await buildAndPush({
      cardNumber: String(row.n),
      parallel: "Base",
      isAuto: false,
      playerName: row.p,
    });
  }

  // Insert sets — base entries only. Cards can be plain strings (legacy
  // JS-module shape with implicit "prefix-N" numbering) or objects
  // { cardNumber, player } (CSV shape with pre-formed cardNumber).
  for (const insert of (checklist.inserts ?? [])) {
    for (let i = 0; i < insert.cards.length; i++) {
      stats.insertBase++;
      const card = insert.cards[i];
      const isObj = typeof card === "object" && card !== null;
      const cardNumber = isObj ? card.cardNumber : `${insert.prefix}-${i + 1}`;
      const playerName = isObj ? card.player : card;
      await buildAndPush({
        cardNumber,
        parallel: "Base",
        isAuto: false,
        printRun: insert.printRun ?? null,
        playerName,
      });
    }
  }

  // Auto sets — base entries. Card entries expected as objects; support
  // legacy shape { code, p } (JS module) and CSV shape { cardNumber, p }.
  for (const autoSet of (checklist.autos ?? [])) {
    for (const card of autoSet.cards) {
      stats.autoBase++;
      const cardNumber = card.cardNumber
        ? card.cardNumber
        : `${autoSet.prefix}-${card.code}`;
      await buildAndPush({
        cardNumber,
        parallel: "Base",
        isAuto: true,
        printRun: autoSet.printRun ?? null,
        playerName: card.p,
      });
    }
  }

  console.log(`\n══ ${checklist.productKey} ══`);
  console.log(`  base:        ${stats.base}`);
  console.log(`  insertBase:  ${stats.insertBase}`);
  console.log(`  autoBase:    ${stats.autoBase}`);
  console.log(`  planned:     ${stats.base + stats.insertBase + stats.autoBase}`);
  if (APPLY) {
    console.log(`  wrote:       ${stats.wrote}`);
    console.log(`  failed:      ${stats.failed}`);
  }
  console.log(`  Sample:`);
  preview.slice(0, 6).forEach(s => console.log(`    ${s}`));
  return stats;
}

async function main() {
  const checklistsDir = path.join(backend, "data/checklists");
  if (!fs.existsSync(checklistsDir)) {
    console.error(`checklists dir not found: ${checklistsDir}`);
    process.exit(1);
  }
  const files = fs.readdirSync(checklistsDir)
    .filter(f => f.endsWith(".js") || f.endsWith(".csv"))
    .sort();

  console.log(`[ingest-product-checklist]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  files found: ${files.length}`);
  if (ONLY) console.log(`  filter: ${ONLY}`);
  console.log("");

  let grandPlanned = 0;
  let grandWrote = 0;
  for (const f of files) {
    let checklist;
    if (f.endsWith(".js")) {
      checklist = require(path.join(checklistsDir, f));
    } else {
      // CSV path — meta from sibling <name>.csv.meta.json
      const metaPath = path.join(checklistsDir, f + ".meta.json");
      if (!fs.existsSync(metaPath)) {
        console.warn(`  skip ${f}: missing meta ${path.basename(metaPath)}`);
        continue;
      }
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      checklist = { ...meta, ...parseCsvChecklist(path.join(checklistsDir, f)) };
    }
    if (ONLY && checklist.productKey !== ONLY) continue;
    const s = await ingestProduct(checklist);
    grandPlanned += s.base + s.insertBase + s.autoBase;
    grandWrote += s.wrote;
  }

  console.log(`\n════════════════ TOTAL ════════════════`);
  console.log(`  entries planned: ${grandPlanned}`);
  if (APPLY) console.log(`  entries written: ${grandWrote}`);
  else console.log(`\n*** DRY-RUN. Set INGEST_APPLY=true to write. ***`);
}

main().catch(e => { console.error(e); process.exit(1); });
