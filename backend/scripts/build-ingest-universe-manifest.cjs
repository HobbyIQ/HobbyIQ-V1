#!/usr/bin/env node
/**
 * CF-THE-UNIVERSE-IS-A-COMMITTED-FILE (D38, 2026-09-01).
 *
 * Mints backend/data/ingest-universe.json from the enumeration artifact.
 *
 * WHY A COMMITTED MANIFEST. The driver runs on a GitHub runner, and a runner
 * job cannot push. So the universe -- WHICH sets exist, and where each one is
 * fetched from -- is committed here, immutable, and the mutable per-entry
 * VERDICT lives in Cosmos (`crawl_state`) where a runner can write it. Splitting
 * them this way means the manifest is reviewable in a diff and the driver never
 * needs write access to the repo.
 *
 * The seeded `status` is the enumeration's READ of the catalog on the day it
 * ran -- ingested / partial / missing / unreachable. It is a starting point,
 * not a verdict: the driver re-reads Cosmos per entry and writes its own.
 *
 * Usage: node backend/scripts/build-ingest-universe-manifest.cjs --in=<artifact>
 */
const fs = require("node:fs");
const path = require("node:path");

const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const IN = arg("in", "C:/tmp/UNIVERSE-FINAL.json");
const OUT = arg("out", path.join(__dirname, "..", "data", "ingest-universe.json"));

// The lane vocabulary is CLOSED. A lane not on this list has no acquisition
// machinery wired, and an entry naming one would be a pending row no driver
// could ever take -- so it is refused at mint time rather than discovered
// months later as a permanently-stuck entry.
const LANES = new Set(["hobbymonitor", "checklistinsider", "bcp", "beckett", "clc", "tcgdexja"]);

// CF-A-PUBLICATION-YEAR-IS-NOT-THE-PRODUCT-YEAR (2026-09-06). A hobbymonitor
// release URL can end in the PUBLICATION year, and the enumeration read it as
// the product year -- queueing "2024 Topps Finest Football" as 2025 and minting
// 142,849 catalog rows whose setName contradicts their own year (#1904, #1912).
// The setName is the authority; a split season ("2024/25" -> 2025) is NOT this
// defect and is left alone. The rule lives in its own module so a test can
// import it without this file's top-level mint running.
const { correctedYear } = require("./lib/product-year-from-set-name.cjs");

const src = JSON.parse(fs.readFileSync(IN, "utf8"));
const universe = src.universe;
if (!Array.isArray(universe) || !universe.length) { console.error("FATAL: artifact carries no universe[]"); process.exit(1); }

const seen = new Set();
const entries = [];
let refused = 0;
let yearCorrected = 0;
const corrections = [];
for (const e of universe) {
  if (!LANES.has(e.lane)) { console.error(`  refused: unknown lane ${e.lane}`); refused++; continue; }
  if (!e.sourceRef) { console.error(`  refused: no sourceRef for ${e.lane} ${e.setName}`); refused++; continue; }
  const id = `${e.lane}::${e.sourceRef}`;
  if (seen.has(id)) { console.error(`  refused: duplicate id ${id}`); refused++; continue; }
  seen.add(id);

  // CF-A-PUBLICATION-YEAR-IS-NOT-THE-PRODUCT-YEAR. The setName decides. This
  // CORRECTS rather than drops: the entry is real and wanted, only its year is
  // wrong, and dropping it would silently shrink the acquisition queue.
  let year = e.year ?? null;
  const fixed = correctedYear(e.setName, year);
  if (fixed != null) {
    corrections.push({ id, setName: e.setName, was: Number(year), now: fixed });
    year = fixed;
    yearCorrected++;
  }

  entries.push({
    id,
    lane: e.lane,
    sourceRef: e.sourceRef,
    sport: e.sport ?? null,
    year,
    setName: e.setName ?? null,
    estimatedCards: e.estimatedCards ?? null,
    // The enumeration's read of the catalog, kept as provenance. `seededStatus`
    // and not `status`, because the live status is the Cosmos control doc's --
    // a field named `status` here would read as authoritative and it is not.
    seededStatus: e.status,
    seededNote: e.note ?? null,
  });
}

const byLane = {};
for (const e of entries) {
  const l = (byLane[e.lane] ??= { total: 0, seeded: {} });
  l.total++;
  l.seeded[e.seededStatus] = (l.seeded[e.seededStatus] || 0) + 1;
}

const manifest = {
  version: 1,
  generatedAt: src.generatedAt || new Date().toISOString().slice(0, 10),
  mintedAt: new Date().toISOString(),
  source: "D37 universe enumeration",
  // Written down so a reader knows what the driver may do to an entry without
  // reading the driver.
  statusVocabulary: {
    pending: "never attempted by the driver",
    ingested: "acquired, staged, gated clean, and rows verified present in card_catalog",
    partial: "rows landed but the entry is incomplete (base-only, or a ladder with no print runs)",
    failed: "attempted and refused -- a cleanliness gate or an acquisition error; `reason` says which",
    unreachable: "the source itself does not serve this set (404/403/absent); not a defect in our pipe",
  },
  // The unreachable list travels with the manifest so a driver never spends a
  // budget re-probing what a direct 404 already settled.
  unreachable: src.unreachable || [],
  totals: { entries: entries.length, refused, byLane },
  entries,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${OUT}`);
console.log(`  entries ${entries.length}  refused ${refused}`);
for (const [l, v] of Object.entries(byLane)) console.log(`  ${l.padEnd(18)} ${String(v.total).padStart(5)}  ${JSON.stringify(v.seeded)}`);

// The corrections are printed, not buried: a year the builder changed is a
// defect in the enumeration upstream, and the next run should show FEWER.
if (yearCorrected) {
  console.log(`  year corrected from setName  ${yearCorrected}   <- CF-A-PUBLICATION-YEAR-IS-NOT-THE-PRODUCT-YEAR`);
  for (const c of corrections) console.log(`     ${String(c.was)} -> ${String(c.now)}   ${c.setName}`);
}

