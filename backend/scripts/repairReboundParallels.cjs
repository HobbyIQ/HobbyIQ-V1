#!/usr/bin/env node
// CF-PARALLEL-IS-IDENTITY repair (Drew, 2026-08-13).
//
// Third approach. The first two were wrong and both are worth recording,
// because each failed for a different reason:
//
//   1. Compared the row's `parallelSlug` field to its slug segment.
//      `parallelSlug` is unreliable — identical rows carry "base" and
//      "refractor" for the same card — so it would have rewritten CORRECT
//      slugs to base. Caught in dry run, ~3,200 rows.
//
//   2. Joined comps_staging -> sold_comps on `sourceExternalId` and took the
//      staging slug as truth. That key is NOT unique per sale, so one staging
//      row's parallel was applied to several unrelated sold rows. This one
//      reached prod: 134 rows written, detected on verification, all 134
//      reverted via the repairedFrom stamp.
//
//   (`stagingId` was the obvious third key. It is defined on 0 of 93,442
//    recent rows, so it does not exist as a join.)
//
// THIS approach needs no join. A sold_comps row already carries the sale's own
// identity — cardYear, setName, cardNumber, parallel, isAuto, printRun, sport —
// so the canonical slug can be RECOMPUTED from the row itself with the very
// function the ingest path uses (computeHobbyIqCardId). Where the recomputed
// parallel disagrees with the stored slug's parallel, the stored slug was
// rebound by the old matcher.
//
// `parallel` (the display text, straight from the sale title) is the input —
// NOT `parallelSlug`, which is the field that made approach 1 wrong.
//
// TELLING A REBIND FROM CANONICALIZATION — same rule the matcher now enforces:
//
//   "blue-ray-wave" -> "blue-ray-wave-refractor"   canonicalization ADDS a
//                                                  family word: legitimate, keep
//   "mojo-refractor" -> "refractor"                the identifying token was
//                                                  DROPPED: rebind, repair
//   "refractor" -> "common-green-refractor"        "green" was INVENTED: rebind
//
// Only the parallel SEGMENT is rewritten; set-family and printRun differences
// are left alone. sold_comps partitions on /cardId, untouched here, so this is
// an in-place patch.
//
//   node scripts/repairReboundParallels.cjs                   # dry run
//   node scripts/repairReboundParallels.cjs --apply --max 5000

const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");
const { computeHobbyIqCardId } = require(path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js"));

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MAX = Number(val("--max", "20000"));
const PAGE = Number(val("--page", "1000"));
const CONCURRENCY = Number(val("--concurrency", "32"));
const SINCE_HOURS = Number(val("--since-hours", "0"));

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const sold = new CosmosClient(cn)
  .database(process.env.COSMOS_DATABASE || "hobbyiq")
  .container("sold_comps");

const FAMILY_WORDS = new Set(["refractor", "refractors", "prizm", "prizms", "foil", "parallel", "chrome"]);

function tokenSet(slug) {
  const t = String(slug ?? "").split("-").map((x) => x.trim()).filter(Boolean).filter((x) => x !== "base");
  return new Set(t.length ? t : ["base"]);
}
const parallelSegOf = (slug) => String(slug ?? "").split(":")[5] ?? "";

/** @returns "same" | "canonicalized" | "rebound" */
function classify(fromSale, stored) {
  const a = tokenSet(fromSale), b = tokenSet(stored);
  if (a.size === b.size && [...a].every((t) => b.has(t))) return "same";
  const missing = [...a].filter((t) => !b.has(t));
  const extra = [...b].filter((t) => !a.has(t));
  if (missing.length === 0 && extra.every((t) => FAMILY_WORDS.has(t))) return "canonicalized";
  return "rebound";
}

function withParallel(slug, seg) {
  const p = String(slug).split(":");
  if (p.length < 7 || p[0] !== "hiq") return null;
  p[5] = seg || "base";
  return p.join(":");
}

async function mapLimit(items, limit, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; await fn(items[i]); }
  }));
}

const stats = { scanned: 0, skipped: 0, same: 0, canonicalized: 0, baseNoEvidence: 0, rebound: 0, repaired: 0, errors: 0 };
const affected = new Set();
const samples = [];

async function handle(row) {
  stats.scanned++;
  const stored = String(row.hobbyiqCardId ?? "");
  if (!stored.startsWith("hiq:")) { stats.skipped++; return; }
  if (!row.sport || !row.cardYear || !row.parallel) { stats.skipped++; return; }

  let recomputed;
  try {
    recomputed = computeHobbyIqCardId({
      sport: row.sport,
      year: row.cardYear,
      setKey: row.setName ?? "",
      cardNumber: row.cardNumber ?? "",
      parallel: row.parallel,           // display text from the sale title
      isAuto: !!row.isAuto,
      printRun: typeof row.printRun === "number" ? row.printRun : null,
    });
  } catch { stats.skipped++; return; }
  if (!recomputed) { stats.skipped++; return; }

  const fromSale = parallelSegOf(recomputed);

  // NEVER DEMOTE. "Base" is both a real parallel AND the default the parser
  // emits when a title carries no parallel information — and many vendor
  // titles are generic ("1956 1956 Topps Baseball #120 Base"). So a sale whose
  // parallel is Base is not EVIDENCE that a specific stored parallel is wrong.
  //
  // Without this guard the dry run proposed collapsing real parallels onto
  // base — ...:gold -> :base, ...:sepia-refractor -> :base, ...:gray-back ->
  // :base — which is exactly the corruption this script exists to undo, in the
  // other direction. Repair only where the sale gives POSITIVE evidence of a
  // specific parallel (X-Fractor, Green Foil), per slug-recompute-only-improve.
  const saleTokens = tokenSet(fromSale);
  if (saleTokens.size === 1 && saleTokens.has("base")) { stats.baseNoEvidence++; return; }

  const verdict = classify(fromSale, parallelSegOf(stored));
  if (verdict === "same") { stats.same++; return; }
  if (verdict === "canonicalized") { stats.canonicalized++; return; }

  stats.rebound++;
  const fixed = withParallel(stored, fromSale);
  if (!fixed || fixed === stored) return;
  affected.add(stored);
  affected.add(fixed);
  if (samples.length < 14) {
    samples.push(`parallel="${row.parallel}"\n      ${stored}\n   -> ${fixed}\n      title: ${String(row.title ?? "").slice(0, 96)}`);
  }
  if (!APPLY) { stats.repaired++; return; }
  try {
    await sold.item(row.id, row.cardId).patch([
      { op: "set", path: "/hobbyiqCardId", value: fixed },
      { op: "set", path: "/repairedFrom", value: stored },
      { op: "set", path: "/repairedAt", value: new Date().toISOString() },
      { op: "set", path: "/repairedReason", value: "CF-PARALLEL-IS-IDENTITY-V3" },
    ]);
    stats.repaired++;
  } catch (e) {
    stats.errors++;
    if (stats.errors <= 3) console.error("  patch error:", String(e && e.message).slice(0, 140));
  }
}

(async () => {
  console.log(`repair rebound parallels (recompute-from-row) — ${APPLY ? "APPLY" : "DRY RUN"}  max=${MAX}\n`);
  const since = SINCE_HOURS > 0 ? Math.floor(Date.now() / 1000) - SINCE_HOURS * 3600 : null;
  const sel = "SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.setName, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.title FROM c";
  const q = since
    ? { query: `${sel} WHERE c._ts >= @s`, parameters: [{ name: "@s", value: since }] }
    : { query: sel };

  const iter = sold.items.query(q, { maxItemCount: PAGE });
  const started = Date.now();
  let batch = 0;
  while (iter.hasMoreResults() && stats.scanned < MAX) {
    const { resources } = await iter.fetchNext();
    if (!resources || resources.length === 0) continue;
    await mapLimit(resources, CONCURRENCY, handle);
    if (++batch % 10 === 0) {
      const rate = Math.round(stats.scanned / Math.max((Date.now() - started) / 60000, 0.001));
      console.log(`   ...${stats.scanned} scanned, ${stats.rebound} rebound  [${rate}/min]`);
    }
  }

  console.log(`\nscanned             : ${stats.scanned}`);
  console.log(`  slug matches sale : ${stats.same}`);
  console.log(`  canonicalized KEPT: ${stats.canonicalized}`);
  console.log(`  REBOUND (bad)     : ${stats.rebound}`);
  console.log(`  ${APPLY ? "repaired          " : "would repair      "}: ${stats.repaired}`);
  console.log(`  sale says Base    : ${stats.baseNoEvidence}  (no evidence — never demote)`);
  console.log(`  skipped (no data) : ${stats.skipped}`);
  console.log(`  errors            : ${stats.errors}`);
  console.log(`\naffected pools (FMV must be invalidated): ${affected.size}`);
  console.log("\nsamples — verify each against its title before applying:\n");
  samples.forEach((s) => console.log("   " + s + "\n"));
  if (!APPLY) console.log("DRY RUN — nothing written. Re-run with --apply.");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
