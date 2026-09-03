#!/usr/bin/env node
/**
 * trace-bowman-base-in-refractor-root.cjs -- READ ONLY.
 *
 * The MEASUREMENT (measure-bowman-base-refractor-mix.cjs) counts the shape.
 * This script asks the next question: WHICH LINE MINTED IT.
 *
 * CF-A-COUNT-IS-NOT-A-CAUSE. A census that reports 40,000 base-in-refractor
 * rows and stops has not found a bug -- it has found a symptom, and the repair
 * lane it justifies is another per-card list of exactly the kind Drew closed
 * in favour of the GREAT REMATCH. So each sampled row is replayed through the
 * REAL ingest code (not a re-implementation of it) and the decision that put a
 * finish on its slug is named.
 *
 * WHAT IS REPLAYED, AND WHAT IS DELIBERATELY NOT
 *
 * The pure, in-process half of the ingest path is loaded from dist/ and run
 * for real:
 *
 *   parseListingIdentity      the title parser -- what finish the title names
 *   parallelTheTitleAllows    the title-outranks-vendor-tag rule
 *   canonicalizeParallelName  the ingest-time canonicalizer
 *   computeHobbyIqCardId      the slug builder
 *
 * The Cosmos-touching half (checklistNarrow, canonicalize's catalog reads) is
 * NOT executed as a write path and never with a vendor tag it did not have --
 * catalog rows are READ, to answer the one question that decides the class:
 * does a checklist-backed BASE destination exist for this card? That is the
 * fourth field of the BASE-EVICTION subclass and it cannot be answered from
 * the row alone.
 *
 * THE ROOTS THIS DISTINGUISHES
 *
 *   TITLE-SILENT-CATALOG-REBIND  the title names no finish, the parser emits
 *                                Base, and the slug's finish arrived from the
 *                                catalog resolve rebinding onto a parallel row
 *                                because no base row existed to match.
 *   VENDOR-TAG-INHERITED         the row was written by a path that took the
 *                                holding's / product's parallel as the sale's
 *                                (the pre-2026-08-29 shape, before
 *                                titleOutranksVendorTag was wired in).
 *   PARSER-READ-A-FINISH         today's parser DOES read a finish from this
 *                                title -- the slug is defensible and the row is
 *                                not a defect at all. Reported, because a
 *                                census that cannot exonerate is not a census.
 *   PRODUCT-NAME-AS-FINISH       the only finish-ish word in the title is the
 *                                PRODUCT ("Chrome", "Sapphire" as a set), which
 *                                is not evidence of a Refractor.
 *
 * ENV: COSMOS_CONNECTION_STRING (required), SAMPLE_FILE (the measurement's
 *      JSON), N (rows per source, default 10), OUT.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { CosmosClient } = require("@azure/cosmos");

const backend = path.resolve(__dirname, "..");
const SAMPLE_FILE = process.env.SAMPLE_FILE || "/tmp/bowman-mix/bowman-mix-slot0.json";
const N_PER_SOURCE = Number(process.env.N || 10);
const OUT = process.env.OUT || "/tmp/bowman-mix/root-trace.json";
const DB_NAME = process.env.COSMOS_DATABASE || "hobbyiq";
const CATALOG = process.env.COSMOS_CATALOG_CONTAINER || "card_catalog";

/** Load the REAL ingest leaves from dist/. A trace built from a
 *  re-implementation would agree with itself forever (the thermometer built
 *  from the patient), so if dist/ is missing we refuse rather than guess. */
function loadRealPath() {
  const need = (rel, name) => {
    const p = path.join(backend, "dist", rel);
    if (!fs.existsSync(p)) throw new Error(`dist/${rel} missing — run \`npm run build\` in backend/ before tracing (refusing to trace against a re-implementation)`);
    const m = require(p);
    if (typeof m[name] !== "function") throw new Error(`${name} not exported from dist/${rel}`);
    return m[name];
  };
  return {
    parseListingIdentity: need("services/portfolioiq/parseTitleIdentity.service.js", "parseListingIdentity"),
    parallelTheTitleAllows: need("services/portfolioiq/titleOutranksVendorTag.js", "parallelTheTitleAllows"),
    canonicalizeParallelName: need("services/catalog/catalogMatcher.service.js", "canonicalizeParallelName"),
    computeHobbyIqCardId: need("services/portfolioiq/hobbyIqCardId.service.js", "computeHobbyIqCardId"),
    parallelSegmentOf: need("services/catalog/catalogMatcher.service.js", "parallelSegmentOf"),
  };
}

const slugParts = (id) => {
  const s = String(id || "");
  if (!s.startsWith("hiq:")) return null;
  const p = s.split(":");
  if (p.length < 7) return null;
  return { sport: p[1], year: p[2], setKey: p[3], cardNumber: p[4], parallel: p[5] || "" };
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  if (!fs.existsSync(SAMPLE_FILE)) { console.error(`FATAL: sample file ${SAMPLE_FILE} not found — run the measurement first`); process.exit(2); }
  const REAL = loadRealPath();

  const report = JSON.parse(fs.readFileSync(SAMPLE_FILE, "utf8"));
  const all = report.samples?.baseInRefractor ?? [];
  if (all.length === 0) { console.error("FATAL: no BASE-IN-REFRACTOR samples in the measurement — nothing to trace"); process.exit(3); }

  // Stratify by source so a single dominant vendor cannot be the whole trace.
  const bySource = new Map();
  for (const s of all) {
    const k = s.source || "unknown";
    if (!bySource.has(k)) bySource.set(k, []);
    if (bySource.get(k).length < N_PER_SOURCE) bySource.get(k).push(s);
  }
  const sample = [...bySource.values()].flat();
  console.log(`tracing ${sample.length} rows across ${bySource.size} sources (${[...bySource.keys()].join(", ")})`);

  const cat = new CosmosClient({ connectionString: conn }).database(DB_NAME).container(CATALOG);

  /** Does a checklist-backed row exist for this card, and which parallels does
   *  the checklist actually list? Indexed equalities only. */
  const ladderCache = new Map();
  async function checklistLadder(p) {
    const key = `${p.sport}|${p.year}|${p.setKey}|${p.cardNumber}`;
    if (ladderCache.has(key)) return ladderCache.get(key);
    let out = { rows: [], checklistBacked: false, hasBaseRow: false };
    try {
      const { resources } = await cat.items.query({
        query: "SELECT c.id, c.parallel, c.parallelSlug, c.source, c.printRun FROM c WHERE c.sport = @s AND c.year = @y AND c.setKey = @k AND c.cardNumber = @n OFFSET 0 LIMIT 200",
        parameters: [
          { name: "@s", value: p.sport }, { name: "@y", value: Number(p.year) },
          { name: "@k", value: p.setKey }, { name: "@n", value: String(p.cardNumber).toUpperCase() },
        ],
      }).fetchAll();
      const rows = resources || [];
      const CHECKLIST_SOURCES = /checklist|beckett|bccp|tcdb|checklistcenter|checklistinsider/i;
      out = {
        rows: rows.map((r) => ({ id: r.id, parallel: r.parallel ?? null, seg: REAL.parallelSegmentOf(r.id) ?? null, source: r.source ?? null })),
        checklistBacked: rows.some((r) => CHECKLIST_SOURCES.test(String(r.source ?? ""))),
        hasBaseRow: rows.some((r) => {
          const seg = REAL.parallelSegmentOf(r.id);
          return seg === "base" || seg === "" || /^base$/i.test(String(r.parallel ?? ""));
        }),
      };
    } catch (e) { out.error = e?.message || String(e); }
    ladderCache.set(key, out);
    return out;
  }

  const traces = [];
  const rootCounts = new Map();
  for (const s of sample) {
    // CF-TRACE-THE-FIELD-THAT-WAS-FLAGGED. A row carries TWO identity fields
    // and the exact-pool reader ORs them, so the measurement flags whichever
    // one bears the offending parallel -- which is NOT always hobbyiqCardId.
    // The first cut of this trace always preferred hobbyiqCardId and so
    // "reproduced" a base slug for a row the census had flagged on its cardId,
    // reporting 0/12 disagreements against a sample chosen for disagreeing.
    // Pick the field whose parallel segment is the one that was measured.
    const cands = [s.hobbyiqCardId, s.cardId].filter(Boolean).map((x) => ({ slug: x, p: slugParts(x) })).filter((x) => x.p);
    const want = String(s.slugParallel || "").toLowerCase();
    const hit = cands.find((x) => (x.p.parallel || "").toLowerCase() === want) ?? cands[0];
    if (!hit) continue;
    const slug = hit.slug;
    const p = hit.p;

    // 1. REAL title parser: what finish does today's parser read?
    let parsed = {};
    try { parsed = REAL.parseListingIdentity(s.title || "") || {}; } catch (e) { parsed = { _err: e?.message }; }
    const titleParallel = parsed.parallel ?? null;

    // 2. REAL title-outranks-vendor-tag, with the row's OWN stored field as
    //    the vendor tag -- exactly the call persistVendorSalesToPool makes.
    let decision = {};
    try {
      decision = REAL.parallelTheTitleAllows(titleParallel, s.storedParallel || null, { variationMarker: parsed.variationMarker ?? null });
    } catch (e) { decision = { _err: e?.message }; }

    // 3. REAL canonicalizer + REAL slug builder: the slug today's code mints.
    const effParallel = REAL.canonicalizeParallelName(decision.parallel ?? "Base");
    let reproSlug = null, reproErr = null;
    try {
      reproSlug = REAL.computeHobbyIqCardId({
        sport: p.sport, year: Number(p.year), setKey: p.setKey,
        cardNumber: p.cardNumber, parallel: effParallel,
        isAuto: /:auto(:|$)/.test(slug), printRun: s.printRun ?? null,
        playerName: null,
      });
    } catch (e) { reproErr = e?.message || String(e); }

    const ladder = await checklistLadder(p);
    const reproSeg = reproSlug ? (REAL.parallelSegmentOf(reproSlug) ?? "") : null;
    const storedSeg = p.parallel;

    // 4. Name the root.
    let root;
    const titleNamesFinish = !!(titleParallel && !/^base$/i.test(String(titleParallel)));
    if (titleNamesFinish) {
      root = "PARSER-READ-A-FINISH";          // not a defect: today's parser agrees with the slug
    } else if (/\b(chrome|sapphire)\b/i.test(String(s.title || "")) && /refractor/.test(storedSeg)) {
      root = "PRODUCT-NAME-AS-FINISH";        // only finish-ish word is the PRODUCT
    } else if (!ladder.hasBaseRow && ladder.rows.length > 0) {
      root = "TITLE-SILENT-CATALOG-REBIND";   // no base destination existed to match
    } else if (ladder.hasBaseRow) {
      root = "VENDOR-TAG-INHERITED";          // a base row DID exist and was not used
    } else {
      root = "NO-CATALOG-ROWS";
    }
    rootCounts.set(root, (rootCounts.get(root) || 0) + 1);

    traces.push({
      id: s.id, source: s.source, year: p.year, product: p.setKey, cardNumber: p.cardNumber,
      storedSlugParallel: storedSeg, storedParallelField: s.storedParallel, printRun: s.printRun ?? null,
      title: s.title,
      titleParserSaid: titleParallel, titleOutranksDecision: decision.parallel ?? null,
      vendorTagOverruled: decision.vendorTagOverruled ?? null,
      reproducedSlug: reproSlug, reproducedParallelSegment: reproSeg, reproduceError: reproErr,
      slugDisagreesWithRepro: reproSeg !== null && reproSeg !== storedSeg,
      checklistBacked: ladder.checklistBacked, checklistHasBaseRow: ladder.hasBaseRow,
      checklistLadder: ladder.rows.slice(0, 12).map((r) => r.seg || r.parallel),
      root,
    });
  }

  const out = {
    generatedAt: new Date().toISOString(), readOnly: true,
    tracedRows: traces.length,
    rootCounts: Object.fromEntries([...rootCounts.entries()].sort((a, b) => b[1] - a[1])),
    disagreeWithRepro: traces.filter((t) => t.slugDisagreesWithRepro).length,
    traces,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${OUT}`);
  console.log("roots:", JSON.stringify(out.rootCounts));
  console.log(`slug disagrees with today's repro: ${out.disagreeWithRepro}/${traces.length}`);
}

main().catch((e) => { console.error("FATAL", e?.message || e); process.exit(9); });
