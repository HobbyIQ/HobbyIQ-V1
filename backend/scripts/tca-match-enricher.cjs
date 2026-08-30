// CF-TCA-MATCH-ENRICHER (Drew, 2026-08-02). Async pass that walks
// sold_comps rows written by the TCA firehose ingest with
// __pendingMatch: true and resolves them against card_catalog to
// populate playerName / setName / cardNumber / cardYear / sport /
// hobbyiqCardId. Cleared __pendingMatch on success.
//
// Runs as its own cron (offset from firehose ingest by ~7 min so it
// processes what was just written). Idempotent — same row seen twice
// produces the same result.
//
// Matching strategy (MVP):
//   1. Tokenize the sold_comps.title into alphanumeric words
//   2. Query card_catalog for rows whose searchTokens ARRAY_CONTAINS
//      the strongest tokens (year + longest-token = usually player)
//   3. Score each candidate by (tokens matched) × recentSaleCount
//   4. If top candidate score >= MATCH_FLOOR, populate identity
//   5. If no confident match, leave __pendingMatch: true — retries on
//      next run (card_catalog grows over time, so re-tries succeed later)
//
// Env:
//   COSMOS_CONNECTION_STRING     required
//   COSMOS_DATABASE              default "hobbyiq"
//   APPLY                        "true" to write, else dry-run (default false)
//   MAX_MINUTES                  wall-clock cap (default 12)
//   BATCH                        rows to process per run (default 2000)
//   MATCH_FLOOR                  min score to auto-populate (default 6)
//   CONCURRENCY                  parallel workers (default 6)

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
// CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW (D18, 2026-08-29). Counters, disjoint:
//   intended = rows that reached the write (a confident match under APPLY)
//   written  = rows re-keyed or upserted (matched)
//   failed   = the read found nothing, or the delete / create / upsert threw
// Rows that never matched are stillPending, printed on their own. The
// summary's `failed` also counts rows that failed BEFORE the write (a catalog
// query that threw); writeFailed is the write-side sub-count the equation uses.
//
// KNOWN HAZARD, measured not fixed here: the re-key is delete-then-create. A
// delete that succeeds followed by a create that fails LOSES the row; it shows
// here as a failed write. The safe order is write-then-delete (catalogRowOps
// does that for card_catalog); the pool has no such helper yet.
const { reportWrites } = require(path.join(__dirname, "..", "dist/services/ops/writeReconciliation.js"));

const APPLY = process.env.APPLY === "true";
const MAX_MINUTES = Math.max(1, Number(process.env.MAX_MINUTES || 12));
const BATCH = Math.max(50, Number(process.env.BATCH || 2000));
const MATCH_FLOOR = Number(process.env.MATCH_FLOOR || 6);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 6));

// ─── Tokenization (kept in sync with searchIndexing.service.ts) ─────

function tokenize(text) {
  if (!text) return [];
  const seen = new Set();
  const out = [];
  const raw = String(text).toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
  for (const r of raw) {
    if (r.length >= 2 && !seen.has(r)) { seen.add(r); out.push(r); }
  }
  return out;
}

// Strip stop-words + junk that eBay titles are full of.
const NOISE = new Set([
  "the", "and", "for", "with", "from", "psa", "bgs", "sgc", "cgc",
  "mint", "gem", "nm", "vg", "ex", "rc", "rookie", "rookies", "card", "cards",
  "graded", "raw", "auto", "autograph", "autographed", "sp", "ssp", "iss", "rare",
  "hot", "low", "pop", "clean", "sharp", "wow", "look", "must", "see", "read",
  "buy", "sold", "sale", "gem-mint", "rc-rookie", "lot", "of", "in", "the",
  "beautiful", "stunning", "🔥", "👀", "🤩", "case", "hit", "insert", "parallel",
  "official", "authentic", "certified", "beckett", "grading",
]);

function extractYear(text) {
  const m = String(text || "").match(/\b(19[89]\d|20[0-3]\d)\b/);
  return m ? Number(m[0]) : null;
}

function extractCardNumber(text) {
  // Common patterns: #123, #US175, #CPA-EHA, #91CB-1
  const m = String(text || "").match(/#\s*([A-Za-z0-9-]{1,15})/);
  return m ? m[1] : null;
}

function extractGrade(text) {
  const m = String(text || "").match(/\b(PSA|BGS|SGC|CGC)\s+(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5|4|3|2|1)\b/i);
  if (!m) return { company: null, value: null };
  return { company: m[1].toUpperCase(), value: Number(m[2]) };
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(cs);
  const db = c.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const sold = db.container("sold_comps");
  const catalog = db.container("card_catalog");

  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  console.log(`[tca-match-enricher] apply=${APPLY} batch=${BATCH} matchFloor=${MATCH_FLOOR} concurrency=${CONCURRENCY} maxMinutes=${MAX_MINUTES}`);

  // Pull the next batch of __pendingMatch rows
  const { resources: pendingRows } = await sold.items.query({
    query: `SELECT TOP @batch c.id, c.cardId, c.title, c.tcaListingUrl, c.__tcaIngestedAt FROM c
            WHERE c.source = 'tca-ebay' AND c.__pendingMatch = true AND IS_DEFINED(c.title)
            ORDER BY c.__tcaIngestedAt ASC`,
    parameters: [{ name: "@batch", value: BATCH }],
  }).fetchAll();

  console.log(`[tca-match-enricher] fetched ${pendingRows.length} pending rows`);

  let matched = 0, stillPending = 0, failed = 0, writeAttempted = 0, writeFailed = 0;
  const inflight = new Set();

  async function processRow(row) {
    try {
      const title = String(row.title || "");
      const yearFromTitle = extractYear(title);
      const cardNumberFromTitle = extractCardNumber(title);
      const gradeFromTitle = extractGrade(title);

      // Pick strong tokens: drop noise + require length >=3 for lookup
      const allTokens = tokenize(title);
      const strongTokens = allTokens.filter(t => !NOISE.has(t) && t.length >= 3);

      if (strongTokens.length < 2 || !yearFromTitle) {
        stillPending++;
        return;
      }

      // Query card_catalog: rows where searchTokens contains the top 3
      // strong tokens (usually player-name + brand words) + year
      const topTokens = strongTokens.slice(0, 3);
      const paramList = topTokens.map((t, i) => `ARRAY_CONTAINS(c.searchTokens, @t${i})`).join(" AND ");
      const params = [
        { name: "@year", value: String(yearFromTitle) },
        ...topTokens.map((t, i) => ({ name: `@t${i}`, value: t })),
      ];
      const q = `SELECT TOP 10 c.cardId, c.player, c.releaseName, c.setName, c.year, c.number, c.parallels, c.sport, c.recentSaleCount, c.hobbyiqCardId, c.searchTokens
                 FROM c
                 WHERE c.source IN ('cardhedge', 'cardsight')
                   AND c.year = @year
                   AND ${paramList}`;
      const { resources: candidates } = await catalog.items.query({ query: q, parameters: params }).fetchAll();

      if (candidates.length === 0) {
        stillPending++;
        return;
      }

      // Score: (# of ALL our tokens the candidate matches) × log(recentSaleCount+2)
      // Card-number match is a big multiplier.
      let best = null; let bestScore = 0;
      for (const cand of candidates) {
        const st = new Set((cand.searchTokens || []).map(t => String(t).toLowerCase()));
        const tokenHits = allTokens.filter(t => st.has(t)).length;
        const numberBonus = cardNumberFromTitle && String(cand.number || "").toLowerCase() === cardNumberFromTitle.toLowerCase() ? 5 : 0;
        const popularityBonus = Math.log(Number(cand.recentSaleCount || 0) + 2);
        const score = tokenHits + numberBonus + popularityBonus;
        if (score > bestScore) { best = cand; bestScore = score; }
      }

      if (!best || bestScore < MATCH_FLOOR) {
        stillPending++;
        return;
      }

      if (!APPLY) { matched++; return; }

      // Apply update
      const parallelName = Array.isArray(best.parallels) && best.parallels[0] ? best.parallels[0].name : null;
      const patch = {
        cardId: best.cardId,
        playerName: best.player,
        setName: best.setName || best.releaseName,
        cardNumber: best.number,
        cardYear: Number(best.year) || yearFromTitle,
        parallel: parallelName,
        sport: best.sport,
        hobbyiqCardId: best.hobbyiqCardId,
        gradeCompany: gradeFromTitle.company,
        gradeValue: gradeFromTitle.value,
        confidence: 0.7,
        __pendingMatch: false,
        __matchedAt: new Date().toISOString(),
        __matchScore: Math.round(bestScore * 100) / 100,
      };

      // Cosmos doesn't allow partition-key change on update. Read the doc,
      // merge patch, upsert (may need to delete-and-recreate if cardId changed).
      writeAttempted++;
      let existing;
      try {
        ({ resource: existing } = await sold.item(row.id, row.cardId).read());
      } catch (readErr) {
        // A read that throws is a row we meant to write and could not.
        writeFailed++;
        throw readErr;
      }
      if (!existing) { failed++; writeFailed++; return; }
      const merged = { ...existing, ...patch };
      try {
        if (existing.cardId !== patch.cardId) {
          // Partition key changing — must delete + recreate.
          await sold.item(row.id, existing.cardId).delete();
          await sold.items.create(merged);
        } else {
          await sold.items.upsert(merged);
        }
      } catch (writeErr) {
        writeFailed++;
        throw writeErr;
      }
      matched++;
    } catch (err) {
      failed++;
      if (failed < 10) console.warn(`  match failed id=${row.id}: ${err?.code ?? err?.message ?? err}`);
    }
  }

  for (const row of pendingRows) {
    if (Date.now() - startMs > budgetMs) { console.log(`  wall-clock cap ${MAX_MINUTES}m reached — stopping`); break; }
    while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
    const p = processRow(row).finally(() => inflight.delete(p));
    inflight.add(p);
    if ((matched + stillPending + failed) % 200 === 0 && (matched + stillPending + failed) > 0) {
      const elapsedS = ((Date.now() - startMs) / 1000).toFixed(0);
      console.log(`  progress matched=${matched} pending=${stillPending} failed=${failed} elapsed=${elapsedS}s`);
    }
  }
  await Promise.all([...inflight]);

  const elapsedS = ((Date.now() - startMs) / 1000).toFixed(0);
  console.log(`\n[tca-match-enricher] done — matched=${matched} stillPending=${stillPending} failed=${failed} (writeFailed=${writeFailed}) elapsed=${elapsedS}s`);
  if (!APPLY) console.log(`(dry-run — no sold_comps writes)`);
  if (APPLY) reportWrites({ job: "tca-match-enricher", intended: writeAttempted, written: matched, failed: writeFailed });
}

main().catch(err => { console.error(err); process.exit(1); });
