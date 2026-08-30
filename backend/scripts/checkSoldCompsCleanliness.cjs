// CF-CLEANLINESS-CANARY (Drew, 2026-08-08). Companion to
// checkSoldCompsFreshness.cjs. That one catches "TCA is silently
// dead"; this one catches "ingest is silently writing garbage".
//
// Runs on a schedule (every 6h) and inspects the last WINDOW_HOURS of
// sold_comps rows. Alerts if any of:
//   1. Garbage-prefix playerName rate > MAX_GARBAGE_RATE_PCT (default 1%)
//      — indicates a title parser regression is leaking subset
//      descriptors ("Shohei Ohtani Pitching Jersey") back into
//      playerName. That's the exact class of pollution the 2026-08-08
//      normalizer R4a/b/c/d patch fixed and now must guard forward.
//   2. Slug-fragmentation rate > MAX_FRAGMENTATION_PCT (default 2%)
//      — indicates the same identity tuple is being written under
//      multiple hobbyiqCardId slugs. Symptoms: FMV lookups miss
//      recent comps, grade curve counts inflate.
//   3. Missing-hobbyiqCardId rate > MAX_MISSING_HIQ_PCT (default 5%)
//      — indicates identity resolution is failing for a growing
//      fraction of rows (parser drift, sport-detection gap, etc.).
//   4. card_number_integrity rate > MAX_CARD_NUMBER_INTEGRITY_PCT
//      (default 0.5%) — D28 (CF-A-CARD-NUMBER-IS-NOT-A-GRADE). A row whose
//      title states an explicit "#X" that is NOT its cardNumber, or whose
//      cardNumber the title shows to be a grade / a print run / a year /
//      an ordinal / a lot count. 43,224 such rows existed on 2026-08-30
//      and 24,383 of them had been written in the previous 24 HOURS: the
//      shape was live, and nothing was watching it. The counts are broken
//      out by shape so a regression names its own writer.
//
// Wire into .github/workflows/cleanliness-canary.yml (cron every 6h).
// On any alert, workflow fails and emails Drew via GH Actions failure
// notification.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   WINDOW_HOURS               how far back to scan (default 12)
//   SAMPLE_SIZE                max rows to sample (default 5000)
//   MAX_GARBAGE_RATE_PCT       (default 1.0)
//   MAX_FRAGMENTATION_PCT      (default 2.0)
//   MAX_MISSING_HIQ_PCT        (default 5.0)
//   MAX_CARD_NUMBER_INTEGRITY_PCT (default 0.5 — measured 0.03% over the
//                              last 6h of live ingest on 2026-08-30, and the
//                              defect at its peak wrote 24,383 rows in 24h,
//                              which is percent-scale, not basis-point scale)

const path = require("path");
const { CosmosClient } = require("@azure/cosmos");
// D28. The SAME guard the emitters run, not a second copy of its rules — a
// canary that re-implements the invariant stops measuring it the first time
// the invariant moves. Requires backend/dist (the workflow builds it).
const { judgeCardNumber, explicitTitleCardNumber, isTcgVertical, sameCardNumber } =
  require(path.join(__dirname, "..", "dist", "services", "portfolioiq", "cardNumberIntegrity.js"));

const WINDOW_HOURS = Number(process.env.WINDOW_HOURS || 12);
const SAMPLE_SIZE = Number(process.env.SAMPLE_SIZE || 5000);
const MAX_GARBAGE_RATE_PCT = Number(process.env.MAX_GARBAGE_RATE_PCT || 1.0);
const MAX_FRAGMENTATION_PCT = Number(process.env.MAX_FRAGMENTATION_PCT || 2.0);
const MAX_MISSING_HIQ_PCT = Number(process.env.MAX_MISSING_HIQ_PCT || 5.0);
const MAX_CARD_NUMBER_INTEGRITY_PCT = Number(process.env.MAX_CARD_NUMBER_INTEGRITY_PCT || 0.5);

// Same garbage-prefix regex used by the retro cleanup + normalizer
// test suite. If a name STARTS with a set/brand/insert descriptor word,
// the upstream parser leaked. Real player names never start with
// "Panini", "Debut", "Pitching", etc.
const GARBAGE_NAME_PREFIX = /^(wwe|formula|pokemon|yugioh|magic the|one piece|dragon ball|attack on|marvel|dc |star wars|halo|topps|panini|bowman|fleer|donruss|upper deck|score|pinnacle|goudey|leaf|reverse|holofoil|black drew|wwe |aew |debut|complete|rookie|pitching|batting|catching|highlights)\s/i;

// Also flag ALL-CAPS names — the R4d fix normalizes these but if the
// upstream write skipped normalization, they leak into the pool.
function isAllCapsName(name) {
  if (typeof name !== "string" || !name) return false;
  return /^[A-Z][A-Z\s.'-]{3,}$/.test(name.trim());
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("::error::COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const sc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  const cutoffMs = Date.now() - WINDOW_HOURS * 3600_000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  console.log(`[cleanliness-canary] window: last ${WINDOW_HOURS}h  (>= ${cutoffIso})`);
  console.log(`[cleanliness-canary] sample size cap: ${SAMPLE_SIZE}`);

  // Fetch a recency-ordered sample so the canary reflects RECENT
  // ingest quality, not the historical corpus.
  const startMs = Date.now();
  const { resources: rows } = await sc.items.query({
    query: `SELECT TOP ${SAMPLE_SIZE} c.playerName, c.hobbyiqCardId, c.cardYear, c.setName, c.cardNumber, c.parallel, c.source, c.title, c.sport, c._ts
            FROM c
            WHERE c._ts >= @cutoff
            ORDER BY c._ts DESC`,
    parameters: [{ name: "@cutoff", value: Math.floor(cutoffMs / 1000) }],
  }, { maxItemCount: SAMPLE_SIZE }).fetchNext();

  console.log(`[cleanliness-canary] fetched ${rows.length} rows in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
  if (rows.length === 0) {
    console.log("[cleanliness-canary] no recent rows to sample — TCA/ingest likely idle. Not an alert; freshness canary is authoritative for staleness.");
    return;
  }

  const stats = {
    total: rows.length,
    garbagePrefix: 0,
    allCaps: 0,
    missingHiq: 0,
    fragmented: 0,
    garbageSamples: [],
    allCapsSamples: [],
    fragmentSamples: [],
    cardNumberBad: 0,
    cardNumberByShape: new Map(),
    cardNumberBySource: new Map(),
    cardNumberSamples: [],
  };

  // Group by identity tuple to detect fragmentation
  const tupleSlugs = new Map();  // "year|setLower|cardNumberUpper" → Set<hobbyiqCardId>

  for (const r of rows) {
    const name = String(r.playerName || "").trim();
    if (GARBAGE_NAME_PREFIX.test(name)) {
      stats.garbagePrefix++;
      if (stats.garbageSamples.length < 3) stats.garbageSamples.push({ playerName: name, source: r.source, setName: r.setName });
    }
    if (isAllCapsName(name)) {
      stats.allCaps++;
      if (stats.allCapsSamples.length < 3) stats.allCapsSamples.push({ playerName: name, source: r.source });
    }
    if (!r.hobbyiqCardId || r.hobbyiqCardId === "") {
      stats.missingHiq++;
    }
    // D28: card_number_integrity. One row is counted ONCE, under the first
    // shape that describes it, so the shapes are disjoint and the rate is a
    // row rate rather than a shape rate.
    {
      const num = String(r.cardNumber ?? "").trim();
      const title = String(r.title ?? "");
      const tcg = isTcgVertical(r.sport);
      let shape = null;
      if (title) {
        const stated = explicitTitleCardNumber(title, { isTcg: tcg });
        // sameCardNumber, not a string compare: "BCP-10" and "#BCP10" are one
        // card number spelled two ways, and counting that as a defect made this
        // axis read 1.13% on rows that were fine.
        if (stated && num && !sameCardNumber(stated, num)) shape = "title-states-a-different-number";
        else if (num) shape = judgeCardNumber(num, title, { isTcg: tcg }).rejected;
      }
      if (shape) {
        stats.cardNumberBad++;
        stats.cardNumberByShape.set(shape, (stats.cardNumberByShape.get(shape) ?? 0) + 1);
        const src = String(r.source ?? "(none)");
        stats.cardNumberBySource.set(src, (stats.cardNumberBySource.get(src) ?? 0) + 1);
        if (stats.cardNumberSamples.length < 4) stats.cardNumberSamples.push({ shape, cardNumber: num, source: src, title: title.slice(0, 110) });
      }
    }

    // Fragmentation: same (year, setName, cardNumber) with multiple hiq: slugs
    if (typeof r.cardYear === "number" && r.setName && r.cardNumber && r.hobbyiqCardId) {
      const key = `${r.cardYear}|${r.setName.toLowerCase()}|${r.cardNumber.toUpperCase()}`;
      if (!tupleSlugs.has(key)) tupleSlugs.set(key, new Set());
      tupleSlugs.get(key).add(r.hobbyiqCardId);
    }
  }

  // Count fragmented tuples (>1 distinct slug for same identity)
  const fragmentedTuples = [];
  for (const [key, slugs] of tupleSlugs) {
    if (slugs.size > 1) {
      fragmentedTuples.push({ key, slugs: [...slugs] });
      stats.fragmented += slugs.size;  // count every dupe row
      if (stats.fragmentSamples.length < 3) stats.fragmentSamples.push({ identity: key, slugs: [...slugs] });
    }
  }

  const garbagePct = (stats.garbagePrefix / stats.total) * 100;
  const allCapsPct = (stats.allCaps / stats.total) * 100;
  const missingHiqPct = (stats.missingHiq / stats.total) * 100;
  const fragmentationPct = (stats.fragmented / stats.total) * 100;
  const cardNumberPct = (stats.cardNumberBad / stats.total) * 100;

  console.log("");
  console.log("axis                  count       %     threshold");
  console.log("--------------------  ------  ------   ----------");
  console.log(`garbage-prefix name   ${String(stats.garbagePrefix).padStart(6)}  ${garbagePct.toFixed(2).padStart(5)}%   ${MAX_GARBAGE_RATE_PCT.toFixed(2)}%`);
  console.log(`ALL-CAPS playerName   ${String(stats.allCaps).padStart(6)}  ${allCapsPct.toFixed(2).padStart(5)}%   (informational)`);
  console.log(`missing hobbyiqCardId ${String(stats.missingHiq).padStart(6)}  ${missingHiqPct.toFixed(2).padStart(5)}%   ${MAX_MISSING_HIQ_PCT.toFixed(2)}%`);
  console.log(`fragmented slugs      ${String(stats.fragmented).padStart(6)}  ${fragmentationPct.toFixed(2).padStart(5)}%   ${MAX_FRAGMENTATION_PCT.toFixed(2)}%`);
  console.log(`card_number_integrity ${String(stats.cardNumberBad).padStart(6)}  ${cardNumberPct.toFixed(2).padStart(5)}%   ${MAX_CARD_NUMBER_INTEGRITY_PCT.toFixed(2)}%`);
  for (const [shape, n] of [...stats.cardNumberByShape.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(shape).padEnd(34)} ${String(n).padStart(6)}`);
  }
  for (const [src, n] of [...stats.cardNumberBySource.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    by source: ${String(src).padEnd(25)} ${String(n).padStart(6)}`);
  }
  console.log("");

  const alerts = [];
  if (garbagePct > MAX_GARBAGE_RATE_PCT) {
    alerts.push(`GARBAGE playerName rate ${garbagePct.toFixed(2)}% exceeds ${MAX_GARBAGE_RATE_PCT}% — title parser regression likely (see feedback_normalizer_subset_strip_2026_08_08)`);
    console.log("Sample garbage rows:");
    stats.garbageSamples.forEach((s) => console.log(`  playerName="${s.playerName}"  source=${s.source}  setName=${s.setName}`));
  }
  if (missingHiqPct > MAX_MISSING_HIQ_PCT) {
    alerts.push(`MISSING hobbyiqCardId rate ${missingHiqPct.toFixed(2)}% exceeds ${MAX_MISSING_HIQ_PCT}% — identity resolution failing`);
  }
  if (fragmentationPct > MAX_FRAGMENTATION_PCT) {
    alerts.push(`SLUG-FRAGMENTATION rate ${fragmentationPct.toFixed(2)}% exceeds ${MAX_FRAGMENTATION_PCT}% — same identity written under multiple slugs`);
    console.log("Sample fragmented tuples:");
    stats.fragmentSamples.forEach((s) => {
      console.log(`  ${s.identity}`);
      s.slugs.forEach((slug) => console.log(`    → ${slug}`));
    });
  }

  if (cardNumberPct > MAX_CARD_NUMBER_INTEGRITY_PCT) {
    alerts.push(`CARD_NUMBER_INTEGRITY rate ${cardNumberPct.toFixed(2)}% exceeds ${MAX_CARD_NUMBER_INTEGRITY_PCT}% — a card number is being written from a grade, a print run, a year, an ordinal or a lot count (D28, CF-A-CARD-NUMBER-IS-NOT-A-GRADE). The shape table above names the writer.`);
    console.log("Sample card-number rows:");
    stats.cardNumberSamples.forEach((x) => console.log(`  [${x.shape}] cardNumber="${x.cardNumber}"  source=${x.source}
    ${x.title}`));
  }

  if (alerts.length > 0) {
    for (const a of alerts) console.error(`::error::[cleanliness-canary] ${a}`);
    console.error("::error::Recent rows show ingest quality regression — check holdingFieldNormalizer test suite + persistVendorSalesToPool.");
    process.exit(1);
  }

  console.log("[cleanliness-canary] OK — recent ingest is clean.");
  console.log(`  ALL-CAPS names: ${stats.allCaps} (informational; the R4d normalizer rule should convert these)`);
  console.log(`  card_number_integrity: ${stats.cardNumberBad} of ${stats.total} (${cardNumberPct.toFixed(2)}%)`);
}

main().catch((e) => {
  console.error("::error::[cleanliness-canary] FAILED:", e?.stack || e?.message || e);
  process.exit(1);
});
