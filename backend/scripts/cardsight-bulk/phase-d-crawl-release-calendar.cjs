#!/usr/bin/env node
// PHASE D — release calendar sync.
//
// GET /v1/release-calendar/?segment=baseball&take=100&skip=N
// Persists upcoming + recent product releases to `release_calendar`
// container (partition /segmentId). Idempotent by (releaseId).
//
// Usage:
//   node phase-d-crawl-release-calendar.cjs                # baseball
//   node phase-d-crawl-release-calendar.cjs --sport all    # every segment
//   node phase-d-crawl-release-calendar.cjs --year 2026
//   node phase-d-crawl-release-calendar.cjs --dry-run

const {
  csFetch, paginateAll, getContainer, contentHashOf, nowIso,
} = require("./common.cjs");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(`--${name}`); }

async function runOne(segmentShortname, year, dryRun) {
  const qs = {};
  if (segmentShortname && segmentShortname !== "all") qs.segment = segmentShortname;
  if (year) qs.year = String(year);

  console.log(`[phase-d-calendar] segment=${segmentShortname}${year ? ` year=${year}` : ""}`);
  const t0 = Date.now();
  // GET /v1/release-calendar/ returns { release_calendar: [...], total_count, skip, take }
  const entries = await paginateAll("/release-calendar/", "release_calendar", qs, 100);

  console.log(`  ${entries.length} entries`);

  const container = dryRun ? null : await getContainer("release_calendar", "/segmentId");
  let upserted = 0;
  for (const e of entries) {
    const doc = {
      id: `calendar::${e.id}`,
      releaseId: e.id,
      name: e.name,
      year: e.year || null,
      releaseDate: e.release_date || null,
      preOrderDate: e.pre_order_date || null,
      segmentId: e.segment_id || null,
      manufacturerId: e.manufacturer_id || null,
      contentHash: contentHashOf(e.id, e.release_date, e.pre_order_date, e.name),
      observedAt: nowIso(),
      bulkCrawledAt: nowIso(),
    };
    if (!doc.segmentId) doc.segmentId = "unknown";
    if (!dryRun) {
      try { await container.items.upsert(doc); upserted++; }
      catch (err) { console.warn(`  upsert fail ${e.id}: ${err.message}`); }
    } else {
      upserted++;
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  upserted ${upserted}/${entries.length} in ${elapsed}s`);
}

async function main() {
  const sport = arg("sport", "baseball");
  const year = arg("year", null);
  const dryRun = flag("dry-run");

  if (sport === "all") {
    const segments = await csFetch("/catalog/segments");
    const list = (segments?.segments || []).filter((s) => s.is_identifiable && s.shortname);
    for (const s of list) await runOne(s.shortname, year, dryRun);
  } else {
    await runOne(sport, year, dryRun);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
