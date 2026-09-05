#!/usr/bin/env node
/**
 * rekey-user-comps.cjs -- every user sale and purchase in sold_comps sits
 * under the key and the partition the live writers would give it today.
 *
 * CF-THE-POOL-KEEPS-EVERY-SALE-ONCE (D19, 2026-08-30). D9 (#1454) made the
 * eBay ORDER id the key of a purchase's pool row and D12-a (#1473) made the
 * pinned hiq slug its partition -- for every FUTURE emit. The D14 probe
 * measured the rows written before that: `ebay-user-purchase` keyed
 * `holding::<id>` 59% / eBay item id 40%; `ebay-user-sale` 100% keyed by its
 * timestamp; cardId != hobbyiqCardId on 75-78%, i.e. the sale sits in a
 * VENDOR partition (CardHedge bubble id) while its canonical id is a field.
 * Two consequences: the same real transaction can exist twice (the import's
 * row under `holding::` and the poll's row under the item id), and a card
 * page reading the slug's partition never sees the user's own sale.
 *
 * For each row (sources: ebay-user-purchase, ebay-user-sale):
 *   LINK      the holding it came from -- by the `holding::` key, the eBay
 *             order / item id it carries, or (sales) the portfolio ledger
 *             entry with the same soldAt instant and price
 *   IDENTITY  D12-a: the holding's hobbyiqCardId when the catalog holds it,
 *             else its cardId when that is an hiq slug the catalog holds,
 *             else the row's own hobbyiqCardId when the catalog holds it,
 *             else UNRESOLVED -- left alone, reason counted. A holding that
 *             carries TWO disagreeing hiq ids (cardId from one match,
 *             hobbyiqCardId from a later rematch -- the D9 finding) cannot
 *             move a sale off a catalog-held slug: that would be a demotion
 *             on a coin toss, so the row is left alone (holding-two-identities)
 *             until the holding is conformed
 *   KEY       D9: purchaseSaleIdentity(purchase, holding) for a purchase
 *             (order id -> item id -> holding::<id>, price = SUBTOTAL); for a
 *             sale the ledger's ebayOrderId -> the holding's order / item id
 *             -> the timestamp key sellHolding falls back to (D7b)
 *   GROUP     rows deriving the same (id, cardId) are the same transaction
 *             (same order id, or same holding + soldAt + price). What varies
 *             between them is PRINTED before they are called a duplicate; a
 *             group whose members carry two different grades or two
 *             different parallels is REFUSED (two sales, not one)
 *   WRITE     through scripts/lib/relocate-sold-comp.cjs: create the kept row,
 *             read it back, then delete the old ones. A failed delete is a
 *             duplicate reported on its own line, never a lost sale.
 *
 * CF-A-SALE-IS-NEVER-LOST: the pool's row count for these sources, and per
 * contributor, is printed BEFORE and AFTER; after must equal before minus
 * the rows deleted plus the rows created. A mismatch is exit 4.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true to write (default report
 *      only); SOURCES=ebay-user-purchase,ebay-user-sale; SLOT/SLOTS (hash
 *      shards on the TARGET key, so a transaction's rows share a slot);
 *      RUN_MINUTES=140 (budget marker); LIMIT (rows read per source; 0 = all).
 * Requires dist/ (purchaseSaleIdentity, reportWrites).
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const { relocateSoldComp, stripSystem, isMissing, cents, day, normParallel, gradeKey, contentHashOf, varianceOf, foldMissing, sameRef } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));

const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true"; // the runner exports BACKFILL_APPLY, not APPLY
const SOURCES = String(process.env.SOURCES || "ebay-user-purchase,ebay-user-sale").split(",").map((s) => s.trim()).filter(Boolean);
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
const SHARD_SCOPE = runnerShardScope({ label: "rekey-user-comps" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const LIMIT = Number(process.env.LIMIT || 0);
const PURCHASE = "ebay-user-purchase", SALE = "ebay-user-sale";
const f = (n) => Number(n ?? 0).toLocaleString();
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SLOTS;
const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };
const isHiq = (v) => typeof v === "string" && v.trim().startsWith("hiq:") && v.trim().length > 4;
const str = (v) => String(v ?? "").trim();

// ── pure: what keys a row, what links it, what it should become ────────────

/** The key shape of a sourceExternalId (same classes as audit-pool-identity). */
function keyShape(id) {
  const s = str(id);
  if (!s) return "null";
  if (s.startsWith("holding::")) return "holding::";
  if (/^\d{2}-\d{5}-\d{5}$/.test(s) || /^\d{9,15}-\d{9,15}$/.test(s)) return "ebay order id";
  if (/^\d{11,14}$/.test(s)) return "ebay item id";
  const m = /^([a-z][a-z0-9-]*)::/i.exec(s);
  return m ? `${m[1]}::` : "other";
}

/** Index every user's portfolio doc once: holdings by id / order id / item id,
 *  purchases by id / order id / item id, every ledger entry. */
function buildPortfolioIndex(docs) {
  const idx = { holdings: new Map(), purchases: new Map(), byOrderId: new Map(), byItemId: new Map(), ledger: [], docsByUser: new Map() };
  const add = (map, k, v) => { const key = str(k); if (!key) return; if (!map.has(key)) map.set(key, []); map.get(key).push(v); };
  for (const doc of docs ?? []) {
    const userId = str(doc.userId || doc.id);
    idx.docsByUser.set(userId, doc);
    for (const h of Object.values(doc.holdings ?? {})) {
      if (!h || !h.id) continue;
      const entry = { userId, holding: h, doc };
      idx.holdings.set(str(h.id), entry);
      add(idx.byOrderId, h.ebayOrderId, { userId, holdingId: str(h.id) });
      add(idx.byItemId, h.ebayItemId, { userId, holdingId: str(h.id) });
    }
    for (const p of doc.purchases ?? []) {
      if (!p || !p.id) continue;
      idx.purchases.set(str(p.id), { userId, purchase: p });
      for (const hid of p.holdingIds ?? []) {
        add(idx.byOrderId, p.ebayOrderId, { userId, holdingId: str(hid), purchaseId: str(p.id) });
        add(idx.byItemId, p.ebayItemId, { userId, holdingId: str(hid), purchaseId: str(p.id) });
      }
    }
    for (const e of doc.ledger ?? []) if (e) idx.ledger.push({ userId, entry: e });
  }
  return idx;
}

const sameInstant = (a, b) => { const x = Date.parse(String(a ?? "")), y = Date.parse(String(b ?? "")); return Number.isFinite(x) && Number.isFinite(y) && x === y; };
const holdingNamesRow = (h, row) => [h?.cardId, h?.hobbyiqCardId].filter(Boolean).some((v) => v === row.cardId || v === row.hobbyiqCardId);
const uniqueHoldingIds = (hits) => [...new Set((hits ?? []).map((x) => x.holdingId))];

/** The purchase record behind a holding: sourcePurchaseId first (D9's
 *  sourcePurchaseFor), else the purchase that lists the holding. */
function purchaseFor(idx, entry) {
  if (!entry) return null;
  const byId = idx.purchases.get(str(entry.holding.sourcePurchaseId));
  if (byId) return byId.purchase;
  const doc = entry.doc;
  return (doc?.purchases ?? []).find((p) => (p?.holdingIds ?? []).map(String).includes(str(entry.holding.id))) ?? null;
}

/**
 * Which holding (and purchase / ledger entry) a pool row came from.
 *   purchase rows: `holding::<id>` -> that holding; an order / item id -> the
 *   holding carrying it; anything else -> the one holding of the contributor
 *   with the same card, purchase price and purchase day.
 *   sale rows: the ledger entry with the same soldAt instant and price
 *   (the contributor's when known), narrowed by the holding's card when the
 *   instant is shared.
 * Ambiguity is a reason, never a guess.
 */
function linkRowToHolding(row, idx) {
  const source = str(row.source), key = str(row.sourceExternalId), shape = keyShape(key);
  const holdingOf = (hid) => idx.holdings.get(str(hid)) ?? null;
  if (source === PURCHASE) {
    if (shape === "holding::") {
      const e = holdingOf(key.slice("holding::".length));
      return e ? { ok: true, via: "holding-id", userId: e.userId, holding: e.holding, purchase: purchaseFor(idx, e), ledgerEntry: null }
        : { ok: false, reason: "holding-gone" };
    }
    if (shape === "ebay order id" || shape === "ebay item id") {
      const hits = uniqueHoldingIds((shape === "ebay order id" ? idx.byOrderId : idx.byItemId).get(key));
      if (hits.length === 0) return { ok: false, reason: `no-holding-for-${shape === "ebay order id" ? "order" : "item"}-id` };
      if (hits.length > 1) return { ok: false, reason: `ambiguous-${shape === "ebay order id" ? "order" : "item"}-id` };
      const e = holdingOf(hits[0]);
      return e ? { ok: true, via: shape, userId: e.userId, holding: e.holding, purchase: purchaseFor(idx, e), ledgerEntry: null }
        : { ok: false, reason: "holding-gone" };
    }
    const pool = [...idx.holdings.values()].filter((e) => !row.contributorUserId || e.userId === str(row.contributorUserId));
    const hits = pool.filter((e) => holdingNamesRow(e.holding, row) && cents(e.holding.purchasePrice) === cents(row.price) && day(e.holding.purchaseDate) === day(row.soldAt));
    if (hits.length === 1) return { ok: true, via: "attributes", userId: hits[0].userId, holding: hits[0].holding, purchase: purchaseFor(idx, hits[0]), ledgerEntry: null };
    return { ok: false, reason: hits.length ? "ambiguous-attributes" : "no-holding-link" };
  }
  if (source === SALE) {
    let hits = idx.ledger.filter((l) => sameInstant(l.entry.soldAt, row.soldAt) && cents(l.entry.unitSalePrice) === cents(row.price));
    if (row.contributorUserId) hits = hits.filter((l) => l.userId === str(row.contributorUserId));
    if (hits.length > 1) hits = hits.filter((l) => holdingNamesRow(holdingOf(l.entry.holdingId)?.holding, row));
    if (hits.length === 0) return { ok: false, reason: "no-ledger-link" };
    if (hits.length > 1) return { ok: false, reason: "ambiguous-ledger-link" };
    const e = holdingOf(hits[0].entry.holdingId);
    return { ok: true, via: "ledger", userId: hits[0].userId, holding: e?.holding ?? null, purchase: e ? purchaseFor(idx, e) : null, ledgerEntry: hits[0].entry };
  }
  return { ok: false, reason: "source-not-in-scope" };
}

/** D12-a's order: the holding's pin, its cardId when that is a slug, then the
 *  row's own slug. Each is a candidate only; the catalog decides. */
function slugCandidates(row, link) {
  const out = [];
  const h = link?.ok ? link.holding : null;
  if (h && isHiq(h.hobbyiqCardId)) out.push({ slug: str(h.hobbyiqCardId), via: "holding.hobbyiqCardId" });
  if (h && isHiq(h.cardId)) out.push({ slug: str(h.cardId), via: "holding.cardId" });
  if (isHiq(row.hobbyiqCardId)) out.push({ slug: str(row.hobbyiqCardId), via: "row.hobbyiqCardId" });
  return out;
}
/** Every slug the derivation may need the catalog's answer for. */
function slugsToCheck(row, link) {
  return [...new Set([...slugCandidates(row, link).map((c) => c.slug), ...(isHiq(row.cardId) ? [str(row.cardId)] : [])])];
}
/**
 * The slug the row belongs under, or the reason it has none. `held` is the
 * set of slugs the catalog holds (point reads by the caller).
 *   slug-not-in-catalog     candidates exist, the catalog holds none
 *   no-identity             no candidate at all
 *   holding-two-identities  the row already sits under a catalog-held slug and
 *                           the holding's two hiq ids disagree with each other
 *                           -- following either would be a guess
 */
function resolveSlug(row, link, held) {
  const has = (s) => held.has(s);
  const candidates = slugCandidates(row, link);
  const chosen = candidates.find((c) => has(c.slug)) ?? null;
  if (!chosen) return { ok: false, reason: candidates.length ? "slug-not-in-catalog" : "no-identity" };
  const h = link?.ok ? link.holding : null;
  const twoMinded = !!h && isHiq(h.cardId) && isHiq(h.hobbyiqCardId) && str(h.cardId) !== str(h.hobbyiqCardId);
  if (twoMinded && chosen.slug !== str(row.cardId) && isHiq(row.cardId) && has(str(row.cardId))) return { ok: false, reason: "holding-two-identities" };
  return { ok: true, slug: chosen.slug, via: chosen.via };
}

/**
 * The identity the live writers would give this row today. `deps` carries
 * D9's purchaseSaleIdentity (dist at runtime, the TS source under test).
 */
function deriveUserRowIdentity(row, link, resolved, deps) {
  if (!resolved?.ok) return { ok: false, reason: resolved?.reason ?? (link?.ok ? "no-identity" : `no-link:${link?.reason ?? "?"}`) };
  const source = str(row.source);
  const holding = link?.ok ? link.holding : null;
  let key = str(row.sourceExternalId), keyVia = "kept", price = Number(row.price);
  if (source === PURCHASE && holding) {
    const d9 = deps.purchaseSaleIdentity(link.purchase ?? null, holding);
    key = d9.sourceExternalId; keyVia = "purchaseSaleIdentity";
    // D9: the SUBTOTAL is the market's price for the card; shipping / tax are
    // cost basis. Only a purchase record can say what the subtotal was.
    if (link.purchase && Number(link.purchase.subtotal) > 0 && d9.price > 0) price = d9.price;
  } else if (source === SALE && link?.ok) {
    const pick = [[link.ledgerEntry?.ebayOrderId, "ledger.ebayOrderId"], [holding?.ebayOrderId, "holding.ebayOrderId"], [holding?.ebayItemId, "holding.ebayItemId"]].find(([v]) => str(v));
    if (pick) { key = str(pick[0]); keyVia = pick[1]; } else { key = ""; keyVia = "timestamp"; }
  }
  const cardId = resolved.slug;
  const id = key ? `${source}::${key}` : `${source}::${cardId}::${row.soldAt}`; // makeId, mirrored
  return {
    ok: true, id, cardId, hobbyiqCardId: cardId, sourceExternalId: key || null, price, keyVia, slugVia: resolved.via,
    contributorUserId: str(row.contributorUserId) || (link?.ok ? link.userId : null) || null,
    vendorCardId: str(row.vendorCardId) || (!isHiq(row.cardId) && str(row.cardId) ? str(row.cardId) : null) || null,
  };
}

const VARIANCE_FIELDS = ["cardId", "sourceExternalId", "hobbyiqCardId", "price", "soldAt", "title", "gradeCompany", "gradeValue", "parallel", "printRun", "isAuto", "verifiedByUser", "contributorUserId", "imageUrl", "cardNumber", "setName"];
const FOLD_FIELDS = ["title", "imageUrl", "gradeCompany", "gradeValue", "gradeQualifier", "autoStyle", "printRun", "parallel", "parallelSlug", "cardNumber", "setName", "playerName", "cardYear", "sport", "sellerHandle", "contributorUserId", "vendorCardId", "composite"];
const REASON = "CF-THE-POOL-KEEPS-EVERY-SALE-ONCE (D19): re-keyed to the D9 order id / D12-a slug";
/** What a dropped row was, kept on the row that replaces it. */
const trace = (r) => ({ id: r.id, cardId: r.cardId, sourceExternalId: r.sourceExternalId ?? null, hobbyiqCardId: r.hobbyiqCardId ?? null, title: r.title ?? null, price: r.price ?? null, soldAt: r.soldAt ?? null });

/** Higher = the row a collapse keeps. Verified, graded, attributed, really
 *  keyed, longer-titled, newer -- in that order. */
function richness(r) {
  const shape = keyShape(r.sourceExternalId);
  return (r.verifiedByUser === true ? 100 : 0)
    + (r.gradeCompany ? 20 : 0)
    + (r.contributorUserId ? 10 : 0)
    + (shape === "ebay order id" ? 8 : shape === "ebay item id" ? 6 : shape === "holding::" ? 2 : 0)
    + Math.min(String(r.title ?? "").length, 120) / 100
    + (r.observedAt ? Date.parse(r.observedAt) / 1e14 : 0);
}

/**
 * One target, its old rows, and whatever already sits at the target.
 *   already-canonical  one member, already at the target
 *   rekey              one member, nothing at the target
 *   collapse           several documents for one transaction -> one
 *   refused            two grades or two parallels among them: two sales
 * Every member carries { row, identity }. The kept document is built here:
 * the richest row, re-addressed, missing fields folded from the rest.
 */
function planGroup({ target, members, existing }, now = new Date().toISOString()) {
  const atTarget = (r) => r && r.id === target.id && r.cardId === target.cardId;
  const rows = members.map((m) => m.row);
  const extra = existing && !rows.some((r) => sameRef(r, existing)) ? [existing] : [];
  const all = [...rows, ...extra];
  if (all.length === 1 && atTarget(rows[0])) return { kind: "already-canonical", variance: { differing: [], values: {} }, drops: [] };
  const variance = varianceOf(all, VARIANCE_FIELDS);
  const grades = new Set(all.filter((r) => !isMissing(r.gradeCompany) || !isMissing(r.gradeValue)).map(gradeKey));
  if (grades.size > 1) return { kind: "refused", reason: "grade-differs", variance, drops: [] };
  const parallels = new Set(all.filter((r) => !isMissing(r.parallel)).map((r) => normParallel(r.parallel)));
  if (parallels.size > 1) return { kind: "refused", reason: "parallel-differs", variance, drops: [] };
  const winner = extra[0] ?? rows.slice().sort((a, b) => richness(b) - richness(a))[0];
  const identity = members.find((m) => m.row === winner)?.identity ?? members[0].identity;
  const keep = stripSystem(winner);
  keep.id = target.id; keep.cardId = target.cardId; keep.hobbyiqCardId = identity.hobbyiqCardId;
  keep.sourceExternalId = identity.sourceExternalId;
  const priceBefore = Number(winner.price);
  keep.price = identity.price > 0 ? identity.price : priceBefore;
  if (isMissing(keep.contributorUserId) && identity.contributorUserId) keep.contributorUserId = identity.contributorUserId;
  if (isMissing(keep.vendorCardId) && identity.vendorCardId) keep.vendorCardId = identity.vendorCardId;
  const folded = foldMissing(keep, all.filter((r) => r !== winner), FOLD_FIELDS);
  keep.contentHash = contentHashOf(keep);
  const dropped = all.filter((r) => !atTarget(r));
  const drops = dropped.map((r) => ({ id: r.id, cardId: r.cardId }));
  keep.rekeyedFrom = dropped.length ? dropped.map(trace) : (winner.rekeyedFrom ?? null);
  keep.rekeyedAt = now; keep.rekeyedReason = REASON;
  const kind = all.length > 1 ? "collapse" : "rekey";
  return { kind, variance, keep, drops, folded, creates: !existing, priceCorrected: cents(keep.price) !== cents(priceBefore) ? { from: priceBefore, to: keep.price } : null, winnerWas: { id: winner.id, cardId: winner.cardId } };
}

/** CF-A-SALE-IS-NEVER-LOST: after = before - deleted + created, exactly. */
function reconcileCounts({ before, after, deleted, created }) {
  const expected = before - deleted + created;
  return { expected, ok: after === expected, drift: after - expected };
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const backend = path.resolve(__dirname, "..");
  const { purchaseSaleIdentity } = require(path.join(backend, "dist", "services", "portfolioiq", "ebayAutoHolding.service.js"));
  const { reportWrites } = require(path.join(backend, "dist", "services", "ops", "writeReconciliation.js"));
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const pool = db.container("sold_comps"), portfolio = db.container("portfolio"), cat = db.container("card_catalog");
  console.log(`rekey-user-comps  ${APPLY ? "APPLY" : "REPORT ONLY"}  sources=${SOURCES.join(",")}  slot ${SLOT}/${SLOTS}  budget ${RUN_MINUTES}m  limit ${LIMIT || "none"}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  const q = async (c, query, parameters = [], opts = {}) => (await retry(() => c.items.query({ query, parameters }, { maxItemCount: 1000, ...opts }).fetchAll())).resources;
  const readAll = async (c, query, parameters, cap) => {
    const out = [];
    const it = c.items.query({ query, parameters }, { maxItemCount: 500 });
    while (it.hasMoreResults() && (!cap || out.length < cap)) { const { resources } = await retry(() => it.fetchNext()); for (const r of resources ?? []) { out.push(r); if (cap && out.length >= cap) break; } }
    return out;
  };
  const inList = SOURCES.map((_, i) => `@s${i}`).join(", "), srcParams = SOURCES.map((s, i) => ({ name: `@s${i}`, value: s }));
  const countBySource = async () => new Map((await q(pool, `SELECT c.source, COUNT(1) AS n FROM c WHERE c.source IN (${inList}) GROUP BY c.source`, srcParams)).map((r) => [String(r.source), Number(r.n)]));
  const countByContributor = async () => new Map((await q(pool, `SELECT c.contributorUserId, COUNT(1) AS n FROM c WHERE c.source IN (${inList}) GROUP BY c.contributorUserId`, srcParams)).map((r) => [String(r.contributorUserId ?? "(null)"), Number(r.n)]));
  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);

  // ── the portfolio docs, once ────────────────────────────────────────────
  const docs = await readAll(portfolio, "SELECT * FROM c WHERE IS_DEFINED(c.holdings)", []);
  const idx = buildPortfolioIndex(docs);
  console.log(`  portfolio: ${f(docs.length)} user docs, ${f(idx.holdings.size)} holdings, ${f(idx.purchases.size)} purchases, ${f(idx.ledger.length)} ledger entries`);

  // ── before ──────────────────────────────────────────────────────────────
  const beforeSrc = await countBySource(), beforeUser = await countByContributor();
  const before = sum(beforeSrc);
  console.log(`  pool before: ${[...beforeSrc].map(([s, n]) => `${s} ${f(n)}`).join(", ")}  = ${f(before)}`);

  // ── the rows, linked and derived ────────────────────────────────────────
  const stats = { seen: 0, otherShard: 0, alreadyCanonical: 0, rekeyed: 0, collapsed: 0, collapsedRows: 0, refused: 0, failed: 0, duplicatesLeft: 0, alreadyGone: 0, priceCorrected: 0, created: 0, deleted: 0, notReached: 0, groups: 0 };
  const unresolved = new Map(), unresolvedSlugs = new Map(), refusedBy = new Map(), keyVia = new Map(), slugVia = new Map(), shapes = new Map(), linkVia = new Map(), foldedHist = new Map(), variedHist = new Map();
  const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
  const catalogSeen = new Map();
  const catalogHas = async (slug) => {
    if (catalogSeen.has(slug)) return catalogSeen.get(slug);
    let has = false;
    try { has = !!(await retry(() => cat.item(slug, slug).read())).resource; } catch (e) { if (e?.code !== 404) throw e; }
    catalogSeen.set(slug, has);
    return has;
  };
  const groups = new Map(); // `${id} ${cardId}` -> { target, members }
  for (const source of SOURCES) {
    const rows = await readAll(pool, "SELECT * FROM c WHERE c.source = @s", [{ name: "@s", value: source }], LIMIT || 0);
    for (const row of rows) {
      stats.seen++;
      bump(shapes, `${source} ${keyShape(row.sourceExternalId)}`);
      const link = linkRowToHolding(row, idx);
      bump(linkVia, link.ok ? `linked via ${link.via}` : `unlinked: ${link.reason}`);
      const held = new Set();
      for (const s of slugsToCheck(row, link)) if (await catalogHas(s)) held.add(s);
      const resolved = resolveSlug(row, link, held);
      const identity = deriveUserRowIdentity(row, link, resolved, { purchaseSaleIdentity });
      if (!identity.ok) {
        if (SLOTS > 1 && shardOf(row.id) !== SLOT) { stats.otherShard++; continue; }
        bump(unresolved, identity.reason);
        for (const c of slugCandidates(row, link)) bump(unresolvedSlugs, `${identity.reason}  ${c.slug}`);
        continue;
      }
      const target = { id: identity.id, cardId: identity.cardId };
      if (SLOTS > 1 && shardOf(`${target.id}|${target.cardId}`) !== SLOT) { stats.otherShard++; continue; }
      bump(keyVia, identity.keyVia); bump(slugVia, identity.slugVia);
      const gk = `${target.id} ${target.cardId}`;
      if (!groups.has(gk)) groups.set(gk, { target, members: [] });
      groups.get(gk).members.push({ row, identity });
    }
  }

  // ── the groups: decide, print what varied, write ────────────────────────
  const examples = [];
  let stopReason = null, i = 0;
  for (const { target, members } of groups.values()) {
    if (budgetLeft() < 90000) { stopReason = `stopped at the ${RUN_MINUTES}-minute budget`; stats.notReached += groups.size - i; break; }
    i++;
    let existing = null;
    try { existing = (await retry(() => pool.item(target.id, target.cardId).read())).resource ?? null; } catch (e) { if (e?.code !== 404) { stats.failed++; stats.groups++; continue; } }
    const plan = planGroup({ target, members, existing });
    if (plan.kind === "already-canonical") { stats.alreadyCanonical++; continue; }
    stats.groups++;
    for (const fld of plan.variance.differing) bump(variedHist, fld);
    if (plan.kind === "refused") {
      stats.refused++; bump(refusedBy, plan.reason);
      console.log(`  REFUSED ${plan.reason}: ${target.id} -> ${members.map((m) => `${m.row.id}@${m.row.cardId}`).join(" + ")}  varied: ${plan.variance.differing.map((k) => `${k}=${JSON.stringify(plan.variance.values[k])}`).join("; ")}`);
      continue;
    }
    if (plan.kind === "collapse") console.log(`  COLLAPSE ${target.id} @ ${target.cardId}  <- ${plan.drops.map((d) => `${d.id}@${d.cardId}`).join(" + ")}${existing ? " + existing" : ""}  varied: ${plan.variance.differing.map((k) => `${k}=${JSON.stringify(plan.variance.values[k])}`).join("; ") || "nothing"}`);
    else if (examples.length < 20) examples.push(`  REKEY ${plan.drops[0].id} @ ${plan.drops[0].cardId}  ->  ${target.id} @ ${target.cardId}`);
    for (const fld of plan.folded) bump(foldedHist, fld);
    if (plan.priceCorrected) { stats.priceCorrected++; console.log(`    price ${plan.priceCorrected.from} -> ${plan.priceCorrected.to} (D9 subtotal)  ${target.id}`); }
    const res = await relocateSoldComp(pool, { keep: plan.keep, drop: plan.drops, retry, verifyFields: ["rekeyedAt", "sourceExternalId", "hobbyiqCardId"], dryRun: !APPLY });
    if (!APPLY) { stats.created += plan.creates ? 1 : 0; stats.deleted += plan.drops.length; }
    else if (res.stage === "done") { stats.created += res.existedBefore ? 0 : 1; stats.deleted += res.deleted.length; stats.alreadyGone += res.alreadyGone.length; }
    if (!res.ok && res.stage !== "done") { stats.failed++; console.log(`  FAILED at ${res.stage} ${target.id}: ${String(res.error).slice(0, 100)}`); continue; }
    if (res.duplicatesLeft.length) { stats.failed++; stats.duplicatesLeft += res.duplicatesLeft.length; for (const d of res.duplicatesLeft) console.log(`  DUPLICATE LEFT ${d.id}@${d.cardId}: ${String(d.error).slice(0, 80)}`); continue; }
    if (plan.kind === "collapse") { stats.collapsed++; stats.collapsedRows += plan.drops.length; } else stats.rekeyed++;
  }

  // ── after ───────────────────────────────────────────────────────────────
  const afterSrc = await countBySource(), afterUser = await countByContributor();
  const after = sum(afterSrc);
  const recon = reconcileCounts({ before, after, deleted: stats.deleted, created: stats.created });

  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  rows seen              ${f(stats.seen)}   (${f(stats.otherShard)} belonging to other slots)`);
  console.log(`  already canonical      ${f(stats.alreadyCanonical)}`);
  console.log(`  ${APPLY ? "RE-KEYED" : "WOULD RE-KEY"}           ${f(stats.rekeyed)}   <- one row, moved to its D9 key / D12-a slug`);
  console.log(`  ${APPLY ? "COLLAPSED" : "WOULD COLLAPSE"}         ${f(stats.collapsed)}   <- transactions found under two keys; documents folded away ${f(stats.collapsedRows)}`);
  console.log(`  refused                ${f(stats.refused)}   <- ${[...refusedBy].map(([k, n]) => `${k} ${n}`).join(", ") || "-"}`);
  console.log(`  unresolved             ${f(sum(unresolved))}   <- left alone: ${[...unresolved].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "-"}`);
  console.log(`  failed                 ${f(stats.failed)}`);
  console.log(`    duplicates left      ${f(stats.duplicatesLeft)}   <- kept row written, old row's delete failed: the sale is in the pool twice, never lost`);
  console.log(`    price -> subtotal    ${f(stats.priceCorrected)}   <- D9: the purchase record's subtotal replaces a totalCost price`);
  console.log(`  not reached            ${f(stats.notReached)}`);
  console.log(`  key shapes seen:       ${[...shapes].map(([k, n]) => `${k} ${n}`).join(" | ")}`);
  console.log(`  linked via:            ${[...linkVia].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" | ")}`);
  console.log(`  key via:               ${[...keyVia].map(([k, n]) => `${k} ${n}`).join(" | ") || "-"}`);
  console.log(`  slug via:              ${[...slugVia].map(([k, n]) => `${k} ${n}`).join(" | ") || "-"}`);
  console.log(`  what varied (groups):  ${[...variedHist].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" | ") || "-"}`);
  console.log(`  fields folded:         ${[...foldedHist].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" | ") || "-"}`);
  if (unresolvedSlugs.size) { console.log(`  unresolved slugs (top 15):`); for (const [k, n] of [...unresolvedSlugs].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`    ${String(n).padStart(4)}  ${k}`); }
  if (examples.length) { console.log("  examples:"); for (const e of examples) console.log(e); }

  console.log(`\nCF-A-SALE-IS-NEVER-LOST`);
  console.log(`  before  ${f(before)}   ${[...beforeSrc].map(([s, n]) => `${s} ${f(n)}`).join(", ")}`);
  console.log(`  after   ${f(after)}   ${[...afterSrc].map(([s, n]) => `${s} ${f(n)}`).join(", ")}`);
  console.log(`  ${APPLY ? "expected" : "would be"} ${f(recon.expected)}   = before - deleted ${f(stats.deleted)} + created ${f(stats.created)}${stats.alreadyGone ? `   (${f(stats.alreadyGone)} old rows were already gone)` : ""}`);
  const users = new Set([...beforeUser.keys(), ...afterUser.keys()]);
  for (const u of [...users].sort()) console.log(`    ${u.padEnd(44)} ${f(beforeUser.get(u) ?? 0).padStart(6)} -> ${f(afterUser.get(u) ?? 0).padStart(6)}`);
  if (APPLY && !recon.ok) {
    console.error(`!! CF-A-SALE-IS-NEVER-LOST: after ${f(after)} != expected ${f(recon.expected)} (drift ${recon.drift}). A sale is unaccounted for. Exit 4.`);
    process.exitCode = 4;
  } else console.log(`  ${APPLY ? "matched" : "report only -- no change made; the pool would net " + f(recon.expected - before) + " rows"}`);
  if (APPLY) reportWrites({ job: "rekey-user-comps", intended: stats.groups, written: stats.rekeyed + stats.collapsed, skipped: stats.refused, failed: stats.failed });
  if (stopReason) console.log(`\n${stopReason}`);
}

module.exports = { keyShape, buildPortfolioIndex, linkRowToHolding, slugCandidates, slugsToCheck, resolveSlug, deriveUserRowIdentity, planGroup, richness, reconcileCounts, VARIANCE_FIELDS, FOLD_FIELDS, PURCHASE, SALE };

if (require.main === module) main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
