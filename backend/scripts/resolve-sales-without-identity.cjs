#!/usr/bin/env node
/**
 * CF-A-SALE-WITH-NO-IDENTITY-IS-INVISIBLE (Drew, 2026-08-24).
 *
 * 303,093 rows in sold_comps carry no hobbyiqCardId at all. They are real
 * completed transactions -- 291k from CardHedge, 11k from TCA -- and with
 * CATALOG_MATCH_ONLY_ENABLED=true they are invisible to every price on the
 * platform: persistVendorSalesToPool drops an unmatched sale rather than
 * filing it, so these never reached a pool.
 *
 * They are not unidentifiable. Sampled: 100% carry title, playerName and
 * cardYear, 93% carry sport, 87% carry setName, 32% carry a grade. The
 * identity was simply never computed.
 *
 *   1986  "1986 Fleer Michael Jordan Rookie (RC) PSA 8"
 *   2025  "2025 Topps Stars of MLB SMLB-10 Shohei Ohtani ..."
 *
 * So: parse what the title states, combine it with the stored fields, and ask
 * canonicalize -- the same matcher every other path uses. Because match-only is
 * on, canonicalize will NOT invent a catalog row; a sale only resolves if the
 * card genuinely exists. That is the safety property. Anything unresolved
 * stays unresolved and is reported, not guessed at.
 *
 *   BACKFILL_APPLY   "true" to write
 *   SLOT / SLOTS     partition by cardYear so N dispatches never overlap
 *   MIN_CONFIDENCE   default 0.72 (fuzzy-parallel tier); below that we abstain
 */
const { CosmosClient } = require("@azure/cosmos");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const { parseListingIdentity } = require(path.join(ROOT, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
const { canonicalize } = require(path.join(ROOT, "dist/services/catalog/catalogMatcher.service.js"));

const APPLY = String(process.env.BACKFILL_APPLY || "") === "true";
const SLOT = Number(process.env.SLOT ?? 0);
const SLOTS = Number(process.env.SLOTS ?? 1);
const MIN_CONF = Number(process.env.MIN_CONFIDENCE || 0.72);
const LIMIT = Number(process.env.LIMIT || 0);
// The producer of the doubled year is fixed (0000f60) but 3.17M stored titles
// still carry it; strip it here so the parser sees a clean string.
const dedupeYear = (t, y) => (y && String(t).startsWith(String(y) + " " + String(y) + " ")
  ? String(t).slice(String(y).length + 1) : String(t));

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const sold = db.container("sold_comps");

  const stats = { seen: 0, resolved: 0, lowConf: 0, notFound: 0, noYear: 0, wrote: 0, failed: 0 };
  const byReason = new Map();
  const samples = [];

  let token;
  do {
    const page = await sold.items.query(
      { query: `SELECT c.id, c.cardId, c.title, c.playerName, c.setName, c.cardYear, c.sport,
                       c.gradeCompany, c.gradeValue
                FROM c WHERE (NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null OR c.hobbyiqCardId = "")` },
      { maxItemCount: 200, continuationToken: token },
    ).fetchNext();
    token = page.continuationToken;

    for (const r of page.resources) {
      const year = Number(r.cardYear);
      if (!Number.isFinite(year)) { stats.noYear++; continue; }
      if (SLOTS > 1 && (year % SLOTS) !== SLOT) continue;
      stats.seen++;

      const title = dedupeYear(r.title, year);
      let parsed = {};
      try { parsed = parseListingIdentity(title) || {}; } catch { /* parser is best-effort */ }

      let res;
      try {
        res = await canonicalize({
          sport: String(r.sport ?? "").toLowerCase(),
          year,
          setName: r.setName ?? parsed.setName ?? null,
          cardNumber: parsed.cardNumber ?? null,
          parallel: parsed.parallel ?? null,
          isAuto: parsed.isAuto ?? false,
          printRun: parsed.printRun ?? null,
          player: r.playerName ?? null,
          source: "ebay-title",
        });
      } catch (e) { stats.notFound++; byReason.set("canonicalize-threw", (byReason.get("canonicalize-threw") || 0) + 1); continue; }

      if (!res || !res.found) {
        stats.notFound++;
        byReason.set(res?.matchedBy ?? "not-found", (byReason.get(res?.matchedBy ?? "not-found") || 0) + 1);
        continue;
      }
      if ((res.confidence ?? 0) < MIN_CONF) {
        stats.lowConf++;
        byReason.set(`below-${MIN_CONF}:${res.matchedBy}`, (byReason.get(`below-${MIN_CONF}:${res.matchedBy}`) || 0) + 1);
        continue;
      }
      stats.resolved++;
      if (samples.length < 8) samples.push(`${String(res.confidence).padEnd(5)} ${res.matchedBy.padEnd(16)} ${res.slug}  <- ${title.slice(0, 64)}`);

      if (!APPLY) continue;
      try {
        const doc = (await sold.item(r.id, r.cardId ?? r.id).read()).resource;
        if (!doc) continue;
        doc.hobbyiqCardId = res.slug;
        doc.identityResolvedBy = { by: "resolve-sales-without-identity-2026-08-24", matchedBy: res.matchedBy, confidence: res.confidence, at: new Date().toISOString() };
        await sold.item(r.id, r.cardId ?? r.id).replace(doc);
        stats.wrote++;
      } catch (e) { stats.failed++; if (stats.failed <= 3) console.error("   ERR " + String(e.message).slice(0, 60)); }
    }
    if (stats.seen % 2000 < 200) console.log(`  seen ${stats.seen}  resolved ${stats.resolved}  lowConf ${stats.lowConf}  notFound ${stats.notFound}  wrote ${stats.wrote}`);
    if (LIMIT && stats.seen >= LIMIT) break;
  } while (token);

  console.log("");
  console.log("RESULT " + JSON.stringify(stats));
  console.log("why not resolved:");
  for (const [k, v] of [...byReason].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log("   " + String(v).padStart(6) + "  " + k);
  if (samples.length) { console.log("resolved samples:"); for (const s of samples) console.log("   " + s); }
  if (!APPLY) console.log("");
  console.log("REPORT ONLY.");
})().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
