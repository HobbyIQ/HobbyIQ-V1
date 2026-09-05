#!/usr/bin/env node
/**
 * CF-ONE-POOL (Drew, 2026-08-28: "we need all sales in the same container and
 * go through the processes").
 *
 * ~3.2M real sales sit in comps_staging OUTSIDE the pool, each parked under a
 * status: awaiting-catalog (no checklist row existed when it arrived),
 * awaiting-verify (price outlier / low-confidence parse), player-precision,
 * anomaly, pending-manual, clean. The website's Sales Index cannot see them,
 * the rematch cannot re-resolve them, and the checklists that would match
 * them landed THIS WEEK. One container, every sale through the same matcher
 * and the same pricing gates -- that is the directive, and this is the pass.
 *
 * THE ONE WRITER. Every row goes through recordSoldComp -- the canonical
 * single writer with its id scheme, contentHash dedup, parallel
 * canonicalization and the live catalog matcher (the upgraded cascade). Two
 * outcomes:
 *
 *   MATCHED   the catalog now has the card -> the sale lands as a first-class
 *             pool row. This is the rebuild paying out.
 *   UNMATCHED recordSoldComp refuses vendor rows it cannot match (the
 *             CATALOG_MATCH_ONLY gate). By directive the sale still belongs
 *             in the pool, so the gate is lowered FOR THAT ONE CALL (this
 *             process's own env, runner-only) and the row is written under
 *             its parser slug, then stamped catalogMatched=false so the
 *             rematch re-resolves it as checklists land.
 *
 * PRICING STAYS SAFE. Rows from the verify classes (awaiting-verify, anomaly,
 * pending-manual) are stamped flaggedWrong=true with flaggedReason
 * "pending-verify" -- the exclusion the FMV engine ALREADY honors -- so they
 * are in the container, visible, rematchable, and priced by nobody until a
 * verification flips the flag. Being in the pool is not the same as being
 * trusted; the flag is the difference, and it lives on the row.
 *
 * Staging rows are flipped to in-pool / in-pool-flagged so the hourly promoter
 * stops re-scanning them. MODE=chdaily runs the same two-step over the raw
 * CardHedge feed rows that never emitted (~284k, sampled 5%).
 *
 * Env: COSMOS_CONNECTION_STRING; APPLY/BACKFILL_APPLY (default report only);
 *      STATUSES=awaiting-catalog,player-precision,anomaly,pending-manual,clean,awaiting-verify
 *      MODE=chdaily (raw feed instead of staging); SLOT/SLOTS; CONCURRENCY=32;
 *      RUN_MINUTES=140; LIMIT=0
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
const { recordSoldComp } = require(path.join(backend, "dist/services/portfolioiq/soldCompsStore.service.js"));
const { judgeCardNumber, logCardNumberVerdict } = require(path.join(backend, "dist/services/portfolioiq/cardNumberIntegrity.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const MODE = String(process.env.MODE || "").toLowerCase();
const STATUSES = String(process.env.STATUSES || "awaiting-catalog,player-precision,anomaly,pending-manual,clean,awaiting-verify")
  .split(",").map((s) => s.trim()).filter(Boolean);
const VERIFY_CLASSES = new Set(["awaiting-verify", "anomaly", "pending-manual"]);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 32));
const LIMIT = Number(process.env.LIMIT || 0);
// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1756, generalised 2026-09-04).
// The runner exports `slots` for EVERY script with a workflow-wide DEFAULT of
// "16", so `process.env.SLOTS ?? 1` NEVER saw undefined and this lane sharded
// itself sixteen ways on a dispatch that asked for no sharding -- sweeping slot
// 0 and leaving fifteen sixteenths untouched, green and honestly reconciled.
// Sharding is now OPT-IN: a non-zero slot, or an explicit SHARD=true for slot 0
// of a real fan-out. Everything else -- including the inherited slot=0 slots=16
// -- sweeps EVERY row. SLOTS binds to 1 when unsharded, so `% SLOTS` and
// `SLOTS === 1` guards below keep working unchanged.
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
const SHARD_SCOPE = runnerShardScope({ label: "emit-staging-to-pool" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RUN_MS = RUN_MINUTES * 60000;
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top: a unit costing more than
 *  this is stopped BEFORE it starts. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 2 * 60 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const STARTED = Date.now();
const f = (n) => Number(n).toLocaleString();
const VALID_SOURCES = new Set(["cardhedge", "cardsight", "tca-ebay", "ebay-browse-ended", "ebay-user-purchase", "ebay-user-sale", "manual-user-entry"]);

/** Call the one writer with the gate as it stands, then -- only if refused for
 *  catalog-unmatched -- once more with the gate lowered for this process. */
async function writeThroughTheOneWriter(input) {
  const first = await recordSoldComp(input);
  if (first.written) return { written: true, matched: true };
  if (first.reason !== "catalog-unmatched") return { written: false, reason: first.reason };
  const prev = process.env.CATALOG_MATCH_ONLY_ENABLED;
  process.env.CATALOG_MATCH_ONLY_ENABLED = "false";
  try {
    const second = await recordSoldComp(input);
    return second.written ? { written: true, matched: false } : { written: false, reason: second.reason };
  } finally {
    if (prev === undefined) delete process.env.CATALOG_MATCH_ONLY_ENABLED; else process.env.CATALOG_MATCH_ONLY_ENABLED = prev;
  }
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq");
  const stg = db.container("comps_staging"), pool = db.container("sold_comps"), chd = db.container("ch_daily_sales");
  const retry = async (fn, tries = 10) => {
    let wait = 800;
    for (let a = 0; ; a++) {
      try { return await fn(); }
      catch (e) {
        if (!/request rate|429|ETIMEDOUT|ECONNRESET/i.test(String(e?.message)) || a >= tries) throw e;
        await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 20000);
      }
    }
  };

  console.log(`slot ${SLOT}/${SLOTS}  mode=${MODE || "staging"}  statuses=${STATUSES.join(",")}  ${APPLY ? "APPLY" : "REPORT ONLY"}\n`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  let scanned = 0, matched = 0, unmatchedIn = 0, flagged = 0, deduped = 0, invalid = 0, needsParse = 0, failed = 0, notReached = 0;
  let pagesSeen = 0, otherShards = 0;
  let stopReason = null;
  let token;

  const query = MODE === "chdaily"
    ? { query: "SELECT c.id, c.card_id, c.player, c.year, c.card_set, c.number, c.variant, c.price, c.sale_date, c.image_url, c.description, c.card_description, c[\"group\"] AS grp FROM c" }
    : { query: `SELECT c.id, c.hobbyiqCardId, c.status, c.clean, c.raw FROM c WHERE c.status IN (${STATUSES.map((_, i) => `@s${i}`).join(",")})`,
        parameters: STATUSES.map((s, i) => ({ name: `@s${i}`, value: s })) };

  do {
    const page = await retry(() => (MODE === "chdaily" ? chd : stg).items.query(query, { maxItemCount: 300, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    const mine = SLOTS > 1 ? page.resources.filter((_, i) => (i + scanned) % SLOTS === SLOT) : page.resources;
    otherShards += page.resources.length - mine.length;

    for (let i = 0; i < mine.length; i += CONCURRENCY) {
      await Promise.all(mine.slice(i, i + CONCURRENCY).map(async (row) => {
        scanned++;
        try {
          let input, verifyClass = false, flip = null;
          if (MODE === "chdaily") {
            const ext = `ch-daily::${row.card_id}::${row.sale_date}::${Math.round(Number(row.price) * 100)}`;
            const { resources: have } = await retry(() => pool.items.query({ query: "SELECT VALUE COUNT(1) FROM c WHERE c.sourceExternalId = @e", parameters: [{ name: "@e", value: ext }] }).fetchAll());
            if (have[0] > 0) { deduped++; return; }
            if (!(Number(row.price) > 0) || !row.sale_date) { invalid++; return; }
            // D28 (CF-A-CARD-NUMBER-IS-NOT-A-GRADE). The title used to be
            // SYNTHESISED from row.number -- "#9" built out of the very field
            // in question -- so no guard could ever have caught a grade here:
            // the title agreed with the number by construction. CH's own
            // `description` IS the source listing's title line, so it is what
            // the number is now judged against, and it travels to the pool.
            const chTitle = row.description || row.card_description
              || `${row.year ?? ""} ${row.card_set ?? ""} #${row.number ?? ""} ${row.variant ?? ""}`.trim();
            const numberVerdict = judgeCardNumber(row.number ?? null, row.description || row.card_description || null);
            logCardNumberVerdict("ch-daily-staging", numberVerdict, { candidate: row.number ?? null, title: chTitle, cardId: String(row.card_id) });
            input = {
              cardId: String(row.card_id), playerName: String(row.player ?? ""), cardYear: row.year ?? null,
              setName: row.card_set ?? null, parallel: row.variant ?? null, cardNumber: numberVerdict.cardNumber,
              sport: row.grp ? String(row.grp).toLowerCase() : null, price: Number(row.price), soldAt: String(row.sale_date),
              source: "cardhedge", sourceExternalId: ext, contributorUserId: null,
              title: chTitle,
              imageUrl: row.image_url ?? null, sellerHandle: null, verifiedByUser: false, confidence: 0.8,
            };
          } else {
            const c = row.clean ?? {}, raw = row.raw ?? {}, vp = raw.vendorPayload ?? {};
            const source = VALID_SOURCES.has(String(raw.vendor)) ? String(raw.vendor) : "tca-ebay";
            if (!(Number(c.price ?? vp.price) > 0) || !(c.soldAt ?? vp.soldAt)) { invalid++; return; }
            verifyClass = VERIFY_CLASSES.has(row.status);
            input = {
              cardId: String(row.hobbyiqCardId ?? c.slug ?? ""), playerName: String(c.playerName ?? vp.playerName ?? ""),
              cardYear: c.cardYear ?? vp.cardYear ?? null, setName: c.setName ?? vp.setName ?? null,
              parallel: c.parallel ?? vp.parallel ?? null, cardNumber: c.cardNumber ?? vp.cardNumber ?? null,
              isAuto: c.isAuto ?? false, sport: c.sport ?? vp.sport ?? null,
              gradeCompany: c.gradeCompany ?? null, gradeValue: c.gradeValue ?? null,
              price: Number(c.price ?? vp.price), soldAt: String(c.soldAt ?? vp.soldAt),
              source, sourceExternalId: vp.externalId || vp.id || raw.vendorRawId || null, contributorUserId: null,
              title: vp.title ?? null, imageUrl: vp.imageUrl ?? null, url: vp.url ?? null, sellerHandle: null,
              verifiedByUser: false, confidence: verifyClass ? 0.4 : 0.7,
            };
            flip = { id: row.id, pk: row.hobbyiqCardId };
          }
          // 1.46M awaiting-verify rows carry no parsed player at all -- the
          // parser-low-confidence class. That is the title parser's job (the
          // promoter's pipeline), not a direct write; counted, never guessed.
          if (!input.playerName) {
            needsParse++;
            // CF-NEEDS-PARSE-LEAVES-THE-QUEUE (2026-08-29). 1.46M awaiting-verify
            // rows have no parsed player. Leaving their status untouched made every
            // relaunch re-walk all of them for ~100 writes. They move to needs-parse,
            // a status this script never scans; the promoter's parser owns them.
            if (APPLY && flip) await retry(() => stg.item(flip.id, flip.pk).patch([
              { op: "replace", path: "/status", value: "needs-parse" },
              { op: "add", path: "/statusUpdatedAt", value: new Date().toISOString() },
            ])).catch(() => { /* stale status only costs a re-scan */ });
            return;
          }
          if (!input.cardId) { invalid++; return; }
          if (!APPLY) { matched++; return; }

          const res = await writeThroughTheOneWriter(input);
          if (!res.written) { if (res.reason === "invalid-input") invalid++; else failed++; return; }
          if (res.matched) matched++; else unmatchedIn++;

          // stamps the one writer does not know about: provenance of this
          // pass, whether the catalog matched, and the pricing exclusion for
          // rows the verify queue has not cleared
          const id = input.sourceExternalId ? `${input.source}::${String(input.sourceExternalId).trim()}` : `${input.source}::${input.cardId}::${input.soldAt}`;
          const { resources: docs } = await retry(() => pool.items.query({ query: "SELECT c.id, c.cardId FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: id }] }).fetchAll());
          const doc = docs[0];
          if (doc) {
            const ops = [
              { op: "set", path: "/poolEntry", value: MODE === "chdaily" ? "chdaily-residue" : "staging-residue" },
              { op: "set", path: "/catalogMatched", value: res.matched },
              { op: "set", path: "/stagingStatusAtEntry", value: MODE === "chdaily" ? "raw-feed" : row.status },
            ];
            if (verifyClass) { ops.push({ op: "set", path: "/flaggedWrong", value: true }, { op: "set", path: "/flaggedReason", value: "pending-verify" }); flagged++; }
            await retry(() => pool.item(doc.id, doc.cardId).patch(ops));
          }
          if (flip) {
            await retry(() => stg.item(flip.id, flip.pk).patch([
              { op: "replace", path: "/status", value: verifyClass ? "in-pool-flagged" : "in-pool" },
              { op: "add", path: "/statusUpdatedAt", value: new Date().toISOString() },
            ])).catch(() => { /* a stale staging status only costs a re-scan that dedups */ });
          }
        } catch (e) {
          failed++;
          if (failed <= 5) console.error(`  failed ${String(row.id).slice(0, 50)}: ${String(e.message || e).slice(0, 70)}`);
        }
      }));
      const processed = Math.min(i + CONCURRENCY, mine.length);
      if (LIMIT && (matched + unmatchedIn) >= LIMIT) { stopReason = "limit"; notReached += mine.length - processed; break; }
      if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; notReached += mine.length - processed; break; }
    }
    if (stopReason) break;
    if (++pagesSeen % 20 === 0) process.stderr.write(`\r  scanned=${f(scanned)} matched=${f(matched)} unmatched-in=${f(unmatchedIn)} flagged=${f(flagged)}   `);
  } while (token);
  process.stderr.write("\n");

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);
  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  rows scanned            ${f(scanned)}   (+${f(otherShards)} belonging to other shards, not counted)`);
  console.log(`  INTO POOL, matched      ${f(matched)}   <- the rebuild paying out`);
  console.log(`  INTO POOL, unmatched    ${f(unmatchedIn)}   <- catalogMatched=false; the rematch owns these`);
  console.log(`  of which flagged        ${f(flagged)}   <- pending-verify; excluded from pricing until cleared`);
  console.log(`  already in pool         ${f(deduped)}`);
  console.log(`  needs title parse       ${f(needsParse)}   <- no parsed player; the promoter's parser owns these`);
  console.log(`  invalid (no price/date) ${f(invalid)}`);
  console.log(`  failed                  ${f(failed)}`);
  if (APPLY) {
    reportWrites({ job: "emit-staging-to-pool", intended: scanned, written: matched + unmatchedIn, skipped: deduped + invalid + needsParse + notReached, failed });
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack ?? e?.message); process.exit(3); });
}
