#!/usr/bin/env node
// PHASE A1 — enumerate Cardsight releases for a segment (default: baseball)
// and persist to .state/releases-<sport>.json for Phases A2 / B / C / E to
// consume.
//
// Usage:
//   node phase-a-crawl-releases.cjs                # default baseball
//   node phase-a-crawl-releases.cjs --sport basketball
//   node phase-a-crawl-releases.cjs --sport baseball --year 2025
//
// The releases file is small (<200 KB even for the full catalog) so we
// don't spend Cosmos on it — just a checked-in-gitignored state file.

const { csFetch, paginateAll, writeState, nowIso } = require("./common.cjs");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const sport = arg("sport", "baseball");
  const year = arg("year", null);

  console.log(`[phase-a-releases] segment=${sport}${year ? ` year=${year}` : ""}`);
  const segments = await csFetch("/catalog/segments");
  const seg = (segments?.segments || []).find(
    (s) => s.shortname === sport || s.name?.toLowerCase() === sport.toLowerCase(),
  );
  if (!seg) {
    console.error(`unknown sport: ${sport}. Available: ${(segments?.segments || []).map((s) => s.shortname || s.name).join(", ")}`);
    process.exit(1);
  }
  console.log(`  segmentId=${seg.id} (${seg.name})`);

  const qs = { segment: sport };
  if (year) qs.year = String(year);
  const t0 = Date.now();
  const releases = await paginateAll("/catalog/releases", "releases", qs);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  fetched ${releases.length} releases in ${elapsed}s`);

  const doc = {
    sport,
    year: year || null,
    segmentId: seg.id,
    segmentName: seg.name,
    fetchedAt: nowIso(),
    releaseCount: releases.length,
    releases: releases.map((r) => ({
      id: r.id,
      name: r.name,
      year: r.year,
      manufacturerId: r.manufacturerId,
      isIdentifiable: !!r.is_identifiable,
    })),
  };
  const fname = `releases-${sport}${year ? `-${year}` : ""}.json`;
  writeState(fname, doc);
  console.log(`  wrote .state/${fname}`);

  const identifiable = doc.releases.filter((r) => r.isIdentifiable).length;
  console.log(`  identifiable: ${identifiable}/${releases.length}`);
  const byYear = new Map();
  for (const r of doc.releases) {
    const y = String(r.year || "?");
    byYear.set(y, (byYear.get(y) || 0) + 1);
  }
  const topYears = [...byYear.entries()].sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 10);
  console.log("  top years:");
  topYears.forEach(([y, n]) => console.log(`    ${y}: ${n}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
