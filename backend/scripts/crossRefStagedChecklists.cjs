#!/usr/bin/env node
// CF-STAGE-THEN-CROSS-REFERENCE (Drew, 2026-08-13: "maybe stage them and cross
// reference?" + "on the catalog, lets remove duplicates here too").
//
// Staged checklists are CSVs on disk that have touched nothing. This computes
// the slug each row WOULD produce — with the same function the ingest uses —
// and asks the catalog whether it already holds it.
//
// The point is to know, before writing, which sets are genuinely missing versus
// which would just re-upsert rows we already have. The catalog is 25.5M rows and
// 93.6% of it is sport=baseball; adding another 99K rows blind is how that
// happens.
//
// Sampled per set (not exhaustive) — enough to classify a set as new / partial /
// already-covered without 99,000 point reads.
//
//   node scripts/crossRefStagedChecklists.cjs
//   node scripts/crossRefStagedChecklists.cjs --sample 40

const fs = require("node:fs");
const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");
const { computeHobbyIqCardId } = require(path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js"));

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PLAN = val("--plan", path.resolve(__dirname, "..", "cc-needed.json"));
const SAMPLE = Number(val("--sample", "25"));

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const cat = new CosmosClient(cn).database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");

const OUTDIR = path.resolve(__dirname, "..", "data/checklists/scraped");

/** Mirrors ingest-scraped-checklist's category -> parallel derivation. */
const PLAIN = /^(base[- ]?set|base|chrome[- ]prospects?|base[- ]prospects?|prospects?)$/;
function parallelFor(category) {
  const c = String(category || "").toLowerCase();
  if (c === "base") return "Base";
  const label = c.replace(/^(insert|auto)-/, "").split("-").filter(Boolean)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(" ");
  return PLAIN.test(label.toLowerCase()) ? "Base" : label;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const out = [];
  for (const line of lines.slice(1)) {
    // naive split is fine: only player/parallel are quoted, and we re-join
    const m = line.match(/^([^,]*),("(?:[^"]|"")*"|[^,]*),("(?:[^"]|"")*"|[^,]*),([^,]*),([^,]*),(.*)$/);
    if (!m) continue;
    const unq = (s) => s.replace(/^"|"$/g, "").replace(/""/g, '"');
    out.push({ category: m[1], cardNumber: unq(m[2]), parallel: unq(m[3]), isAuto: m[4] === "true" });
  }
  return out;
}

(async () => {
  const plan = JSON.parse(fs.readFileSync(PLAN, "utf8"));
  console.log(`cross-referencing ${plan.length} staged checklists (sample ${SAMPLE}/set)\n`);

  let newSets = 0, partial = 0, covered = 0, missingFile = 0;
  let estNew = 0, estDup = 0;
  const detail = [];

  for (const m of plan) {
    const csv = path.join(OUTDIR, `${m.year}-${m.setKey}-${m.sport}.csv`);
    if (!fs.existsSync(csv)) { missingFile++; continue; }
    const rows = parseCsv(fs.readFileSync(csv, "utf8"));
    if (rows.length === 0) { missingFile++; continue; }

    // Even stride so the sample spans base and insert sections alike.
    const step = Math.max(1, Math.floor(rows.length / SAMPLE));
    const picks = [];
    for (let i = 0; i < rows.length && picks.length < SAMPLE; i += step) picks.push(rows[i]);

    // ONE query per set, not one per card. hobbyiqCardId is NOT the partition
    // key (cardId is), so every point read was a cross-partition query — 104
    // sets x 20 reads blew past 10 minutes. Pull the set's existing slugs once
    // and test membership in memory.
    let held = new Set();
    try {
      const { resources } = await cat.items.query({
        query: "SELECT VALUE c.hobbyiqCardId FROM c WHERE c.sport = @sp AND c.year = @y AND c.setKey = @sk",
        parameters: [
          { name: "@sp", value: m.sport },
          { name: "@y", value: m.year },
          { name: "@sk", value: m.setKey },
        ],
      }).fetchAll();
      held = new Set(resources.filter(Boolean));
    } catch { /* treat as empty */ }

    let hit = 0;
    for (const r of picks) {
      let slug;
      try {
        slug = computeHobbyIqCardId({
          sport: m.sport, year: m.year, setKey: m.setKey,
          cardNumber: r.cardNumber, parallel: parallelFor(r.category),
          isAuto: r.isAuto, printRun: null,
        });
      } catch { continue; }
      if (slug && held.has(slug)) hit++;
    }
    const pct = picks.length ? hit / picks.length : 0;
    const newRows = Math.round(rows.length * (1 - pct));
    estNew += newRows; estDup += rows.length - newRows;
    const verdict = pct >= 0.9 ? "already-covered" : pct <= 0.1 ? "NEW" : "partial";
    if (verdict === "NEW") newSets++; else if (verdict === "partial") partial++; else covered++;
    detail.push({ slug: m.slug, dmd: m.dmd, rows: rows.length, pct, verdict, newRows });
  }

  detail.sort((a, b) => b.dmd - a.dmd);
  console.log("verdict by set (top 22 by demand):");
  for (const d of detail.slice(0, 22)) {
    console.log(`  ${d.verdict.padEnd(15)} ${String(Math.round(d.pct * 100)).padStart(3)}% held  ${String(d.rows).padStart(5)} rows  dmd ${String(d.dmd).padStart(4)}  ${d.slug}`);
  }
  console.log(`\nNEW (nothing held)     : ${newSets}`);
  console.log(`partial                : ${partial}`);
  console.log(`already-covered        : ${covered}`);
  console.log(`staged file missing    : ${missingFile}`);
  console.log(`\nestimated NEW rows     : ${estNew.toLocaleString()}`);
  console.log(`estimated DUPLICATE    : ${estDup.toLocaleString()}  <- would re-upsert existing`);
  fs.writeFileSync(path.resolve(__dirname, "..", "cc-crossref.json"), JSON.stringify(detail));
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
