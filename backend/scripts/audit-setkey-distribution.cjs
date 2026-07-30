#!/usr/bin/env node
// CF-AUDIT-SETKEY-DISTRIBUTION (Drew, 2026-07-30). After fixing the
// cross-product mis-slug (bowman-family), spot-check for a broader
// class: rows where the setKey slot is a raw slugified title (fallback
// path when normalizeSetKey didn't recognize the input). Symptoms:
// setKey contains a 4-digit year, has excessive hyphens, or isn't in
// the canonical short-form set.
//
// Diagnostic-only: NO writes. Reports:
//   - Total distribution of setKey values (top 50)
//   - Suspicious setKeys (year-containing / long / >4 hyphens)
//   - Sample rows per suspicious bucket
//
// Env:
//   COSMOS_CONNECTION_STRING — required
//   AUDIT_LIMIT=250000        — max rows scanned (default 250K)

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { matchKnownProductLine } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

const LIMIT = Number(process.env.AUDIT_LIMIT || "250000");

// Known canonical short-forms accepted as "clean". Additive — any new
// canonical added to normalizeSetKey should be added here too. Anything
// NOT in this set is flagged as suspicious for review.
const KNOWN_CANONICALS = new Set([
  // Bowman family
  "bowman", "bowman-chrome", "bowman-chrome-sapphire", "bowman-chrome-draft",
  "bowman-paper", "bowman-draft", "bowman-draft-paper", "bowman-sterling",
  // Topps family
  "topps", "topps-chrome", "topps-chrome-update", "topps-chrome-sapphire",
  "topps-heritage", "topps-finest", "topps-pristine", "topps-transcendent",
  "topps-dynasty", "topps-tribute", "topps-inception", "topps-definitive",
  "topps-five-star", "topps-museum-collection", "topps-gypsy-queen",
  "topps-archives", "topps-big-league", "topps-bunt", "topps-allen-ginter",
  "topps-stadium-club",
  // Panini family
  "panini-prizm", "panini-select", "panini-mosaic", "panini-donruss",
  "panini-optic", "panini-contenders", "panini-immaculate", "panini-flawless",
  "panini-national-treasures", "panini-absolute", "panini-chronicles",
  "panini-phoenix", "panini-illusions", "panini-obsidian", "panini-spectra",
  "panini-revolution", "panini-crown-royale", "panini-one-one",
  "panini-playoff", "panini-score", "panini-classics", "panini-legacy",
  "panini-threads", "panini-rookies-and-stars", "panini-zenith",
  "panini-court-kings", "panini-origins", "panini-encased", "panini-eminence",
  // Other
  "upper-deck", "fleer", "fleer-stickers",
]);

function isSuspicious(setKey) {
  if (!setKey) return { reason: "empty" };
  if (KNOWN_CANONICALS.has(setKey)) return null;
  if (/\d{4}/.test(setKey)) return { reason: "contains-year" };
  if (setKey.split("-").length > 5) return { reason: "excessive-hyphens" };
  if (setKey.length > 30) return { reason: "too-long" };
  // Unknown but short — might be a valid product we haven't canonicalized yet.
  return { reason: "unknown-canonical" };
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database("hobbyiq").container("sold_comps");

  console.log(`[audit-setkey-distribution]`);
  console.log(`  limit: ${LIMIT}\n`);

  const query = `
    SELECT TOP @n c.id, c.hobbyiqCardId, c.title, c.rawTitle, c.cardId
    FROM c
    WHERE IS_STRING(c.hobbyiqCardId)
  `;
  const it = sc.items.query(
    { query, parameters: [{ name: "@n", value: LIMIT }] },
    { maxItemCount: 5000 },
  );
  const rows = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) rows.push(...resources);
    process.stdout.write(`\r  scanning ${rows.length}`);
  }
  console.log(`\r  ${rows.length} rows scanned.        \n`);

  const setKeyCounts = new Map();
  const suspiciousBuckets = new Map(); // reason → { setKey → { count, samples: [] } }

  for (const r of rows) {
    const parts = String(r.hobbyiqCardId || "").split(":");
    const setKey = parts[3] || "";
    setKeyCounts.set(setKey, (setKeyCounts.get(setKey) ?? 0) + 1);

    const susp = isSuspicious(setKey);
    if (!susp) continue;

    if (!suspiciousBuckets.has(susp.reason)) {
      suspiciousBuckets.set(susp.reason, new Map());
    }
    const bucket = suspiciousBuckets.get(susp.reason);
    if (!bucket.has(setKey)) {
      bucket.set(setKey, { count: 0, samples: [] });
    }
    const entry = bucket.get(setKey);
    entry.count++;
    if (entry.samples.length < 3) {
      const title = String(r.title || r.rawTitle || "").slice(0, 80);
      const suggested = matchKnownProductLine(title);
      entry.samples.push({ slug: r.hobbyiqCardId, title, suggested });
    }
  }

  // Report: overall distribution
  console.log(`\n════════════════ setKey DISTRIBUTION (top 50) ════════════════`);
  const sorted = Array.from(setKeyCounts.entries()).sort((a, b) => b[1] - a[1]);
  sorted.slice(0, 50).forEach(([k, c]) => {
    const flag = KNOWN_CANONICALS.has(k) ? "  " : " *";
    console.log(`  ${flag} ${String(c).padStart(7)}  ${k}`);
  });

  // Report: suspicious counts by reason
  console.log(`\n════════════════ SUSPICIOUS setKey CLASSES ════════════════`);
  const reasons = ["empty", "contains-year", "excessive-hyphens", "too-long", "unknown-canonical"];
  for (const reason of reasons) {
    const bucket = suspiciousBuckets.get(reason);
    if (!bucket || bucket.size === 0) {
      console.log(`  ${reason}: 0`);
      continue;
    }
    const total = Array.from(bucket.values()).reduce((a, e) => a + e.count, 0);
    console.log(`\n  ▶ ${reason}: ${total} rows across ${bucket.size} distinct setKey values`);
    const top = Array.from(bucket.entries()).sort((a, b) => b[1].count - a[1].count).slice(0, 8);
    top.forEach(([setKey, entry]) => {
      console.log(`\n      ${entry.count}× "${setKey}"`);
      entry.samples.forEach(s => {
        const suggested = s.suggested ? `  →  ${s.suggested}` : "  →  (no match)";
        console.log(`        title: ${s.title}${suggested}`);
      });
    });
  }

  const totalSuspicious = Array.from(suspiciousBuckets.values())
    .flatMap(b => Array.from(b.values()))
    .reduce((a, e) => a + e.count, 0);
  console.log(`\n════════════════ SUMMARY ════════════════`);
  console.log(`  rows scanned:            ${rows.length}`);
  console.log(`  distinct setKeys:        ${setKeyCounts.size}`);
  console.log(`  canonical short-forms:   ${sorted.filter(([k]) => KNOWN_CANONICALS.has(k)).length}`);
  console.log(`  suspicious setKeys:      ${sorted.filter(([k]) => !KNOWN_CANONICALS.has(k)).length}`);
  console.log(`  total suspicious rows:   ${totalSuspicious}  (${((totalSuspicious/rows.length)*100).toFixed(2)}%)`);
}

main().catch(e => { console.error(e); process.exit(1); });
