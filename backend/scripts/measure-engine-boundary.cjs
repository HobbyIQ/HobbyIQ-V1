#!/usr/bin/env node
/**
 * measure-engine-boundary.cjs -- READ ONLY. The before/after numbers for the
 * engine-boundary PR (audit 2026-09-03: H-1, H-2, H-3, H-4, H-8, H-13).
 *
 * Three measures, each a COUNT or a VALUE that the fix is supposed to move:
 *
 *   1. UNION (H-4)  holding c37ead87's two identities, the product each
 *      names, and whether the guard would union them. The audit measured
 *      the union pool at median $76.75 against the slug side's $20.50.
 *      Here we read both pools directly and print each side's median plus
 *      the union's, so the guard's refusal can be checked against the
 *      number it changes.
 *
 *   2. SELL-WINDOW (H-13)  40 live holdings carrying a trendIQ, run through
 *      the SHIPPED deriveSellWindowSignal. Prints the verdict distribution.
 *      The comparison run (after the fix) re-runs the same 40 holdings and
 *      the delta is the count changed.
 *
 *   3. DEAL SCANNER (H-2)  every wanted BuyerIQ target, counted by whether
 *      it carries a real hobbyiqCardId or would have had one MINTED with a
 *      guessed sport and "unknown" segments. The refused count is the
 *      number the fix stops alerting on.
 *
 * There is no write path in this file.
 *
 * Env: COSMOS_CONNECTION_STRING (required)
 *      MODE=before|after   labels the output only
 */
"use strict";
const { CosmosClient } = require("@azure/cosmos");

const MODE = process.env.MODE || "before";
const CONN = process.env.COSMOS_CONNECTION_STRING;
if (!CONN) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

const client = new CosmosClient(CONN);
const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
const soldComps = db.container("sold_comps");
const portfolio = db.container("portfolio");

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const productOf = (slug) => {
  if (typeof slug !== "string" || !slug.startsWith("hiq:")) return null;
  const seg = slug.split(":");
  return seg.length >= 4 ? `${seg[1]}:${seg[2]}:${seg[3]}` : null;
};
const mayUnion = (a, b) => {
  const pa = productOf(a), pb = productOf(b);
  if (pa === null || pb === null) return true;
  return pa === pb;
};

async function poolFor(ids) {
  if (!ids.length) return [];
  const params = ids.map((v, i) => ({ name: `@p${i}`, value: v }));
  const inList = params.map((p) => p.name).join(",");
  const cutoff = new Date(Date.now() - 180 * 86400e3).toISOString();
  const q = {
    query: `SELECT c.price, c.soldAt FROM c WHERE (c.cardId IN (${inList}) OR c.hobbyiqCardId IN (${inList})) AND c.soldAt >= @cut`,
    parameters: [...params, { name: "@cut", value: cutoff }],
  };
  const { resources } = await soldComps.items.query(q, { maxItemCount: 1000 }).fetchAll();
  return resources.map((r) => Number(r.price)).filter((n) => Number.isFinite(n) && n > 0);
}

/** The union EXACTLY as the engine read it: cardId on one side of the OR,
 *  the slug on the other. Not a union of the two identities' own pools. */
async function unionPool(cardId, hiq) {
  if (!cardId || !hiq) return [];
  const cutoff = new Date(Date.now() - 180 * 86400e3).toISOString();
  const { resources } = await soldComps.items.query({
    query: "SELECT c.price FROM c WHERE (c.cardId = @a OR c.hobbyiqCardId = @b) AND c.soldAt >= @cut",
    parameters: [{ name: "@a", value: cardId }, { name: "@b", value: hiq }, { name: "@cut", value: cutoff }],
  }, { maxItemCount: 1000 }).fetchAll();
  return resources.map((r) => Number(r.price)).filter((n) => Number.isFinite(n) && n > 0);
}

async function measureUnion() {
  // Find the holding across user docs.
  const { resources: users } = await portfolio.items
    .query({ query: "SELECT c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)" }, { maxItemCount: 200 })
    .fetchAll();
  let found = null;
  for (const u of users) {
    const map = u.holdings || {};
    for (const [hid, h] of Object.entries(map)) {
      if (String(hid).startsWith("c37ead87")) { found = { hid, userId: u.userId, h }; break; }
    }
    if (found) break;
  }
  if (!found) return { holding: "c37ead87", error: "not-found" };
  const h = found.h;
  const cardId = h.cardId || null;
  const hiq = h.hobbyiqCardId || null;
  // Each side is that identity's OWN pool (matched on either key), and the
  // union is the query the engine actually ran: `c.cardId = <cardId> OR
  // c.hobbyiqCardId = <slug>`. That asymmetry is the point — the union is not
  // the sum of the two sides, it is a THIRD pool that matches neither, which
  // is why the price alternated run to run.
  const ownSide = cardId ? await poolFor([cardId]) : [];
  const otherSide = hiq && hiq !== cardId ? await poolFor([hiq]) : [];
  const union = await unionPool(cardId, hiq);
  return {
    holding: found.hid,
    cardId, hobbyiqCardId: hiq,
    cardIdProduct: productOf(cardId),
    hobbyiqCardIdProduct: productOf(hiq),
    guardAllowsUnion: mayUnion(cardId, hiq),
    cardIdSide: { n: ownSide.length, median: median(ownSide) },
    hobbyiqCardIdSide: { n: otherSide.length, median: median(otherSide) },
    union: { n: union.length, median: median(union) },
    persistedValue: h.canonicalFmv ?? h.fairMarketValue ?? null,
  };
}

/**
 * H-13. BEFORE is the shipped-old behaviour reproduced exactly: the player
 * side taken from the clamped `playerInSetMomentum` multiplier. AFTER is the
 * measured #1644/#1647 index. Both run the SAME derivation, so the delta is
 * the input change and nothing else.
 */
async function measureSellWindow() {
  const { deriveSellWindowSignal } = await import("../dist/services/signals/sellWindow.service.js");
  const { sellWindowPlayerIndex } = await import("../dist/services/signals/sellWindowPlayerIndex.js");
  const { resources: users } = await portfolio.items
    .query({ query: "SELECT c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)" }, { maxItemCount: 200 })
    .fetchAll();
  const rows = [];
  for (const u of users) {
    for (const [hid, h] of Object.entries(u.holdings || {})) {
      if (h && h.trendIQ) rows.push({ hid, h });
    }
  }
  rows.sort((a, b) => String(a.hid).localeCompare(String(b.hid)));
  const sample = rows.slice(0, 40);
  const before = {}, after = {};
  const changes = [];
  let changed = 0, indexMeasurable = 0, outsideRetiredClamp = 0;
  for (const { hid, h } of sample) {
    const conf = h.pricingSourceMeta?.confidence ?? h.confidence ?? null;
    const base = {
      trendIQ: h.trendIQ,
      confidence: typeof conf === "number" ? conf : null,
      trendUpdatedAt: h.lastUpdated ?? h.trendIQ?.lastUpdated ?? null,
      nowMs: Date.parse("2026-09-03T14:00:00Z"),
    };
    const pm = h.trendIQ?.components?.playerMomentum?.multiplier;
    const b = deriveSellWindowSignal({
      ...base,
      playerIndex: typeof pm === "number" && pm > 0 ? { ratio: pm, basketSize: 0, tierScope: null } : null,
    });
    const pi = await sellWindowPlayerIndex({
      playerName: h.playerName ?? null,
      sport: h.sport ?? null,
      targetValue: h.predictedPrice ?? h.fairMarketValue ?? null,
      tierLabel: h.gradeCompany ? `${String(h.gradeCompany).toUpperCase()} ${h.gradeValue ?? ""}`.trim() : "Raw",
      excludeCardIds: new Set([String(h.hobbyiqCardId || "")].filter(Boolean)),
    });
    if (pi) {
      indexMeasurable++;
      if (pi.ratio < 0.85 || pi.ratio > 1.20) outsideRetiredClamp++;
    }
    const a = deriveSellWindowSignal({ ...base, playerIndex: pi });
    const bk = `${b.signal}:${b.reason ?? "-"}`;
    const ak = `${a.signal}:${a.reason ?? "-"}`;
    before[bk] = (before[bk] || 0) + 1;
    after[ak] = (after[ak] || 0) + 1;
    if (bk !== ak) {
      changed++;
      if (changes.length < 20) changes.push({ hid, from: bk, to: ak, indexPct: a.measures.playerIndexPct });
    }
  }
  return {
    sampled: sample.length,
    before, after, changed,
    indexMeasurable,
    outsideRetiredClamp,
    changes,
  };
}

async function measureScanner() {
  let targets = [];
  try {
    const cont = db.container("buyeriq_targets");
    const { resources } = await cont.items
      .query({ query: "SELECT * FROM c WHERE c.docType = 'target' AND c.status = 'wanted'" }, { maxItemCount: 500 })
      .fetchAll();
    targets = resources || [];
  } catch (e) { return { error: String(e.message || e) }; }
  let real = 0, minted = 0, noPlayer = 0;
  const mintedSamples = [];
  for (const t of targets) {
    if (!t.playerName) { noPlayer++; continue; }
    if (typeof t.hobbyiqCardId === "string" && t.hobbyiqCardId.startsWith("hiq:")) { real++; continue; }
    minted++;
    const slug = `hiq:baseball:${t.cardYear ?? 2024}:${t.setName ?? "unknown"}:${t.cardNumber ?? "unknown"}:base:no-auto`;
    if (mintedSamples.length < 8) mintedSamples.push({ id: t.id, player: t.playerName, wouldMint: slug });
  }
  return { targets: targets.length, realIdentity: real, wouldMintGuessedIdentity: minted, skippedNoPlayer: noPlayer, mintedSamples };
}

(async () => {
  const out = { mode: MODE, at: new Date().toISOString() };
  try { out.union_H4 = await measureUnion(); } catch (e) { out.union_H4 = { error: String(e.message || e) }; }
  try { out.sellWindow_H13 = await measureSellWindow(); } catch (e) { out.sellWindow_H13 = { error: String(e.message || e) }; }
  try { out.dealScanner_H2 = await measureScanner(); } catch (e) { out.dealScanner_H2 = { error: String(e.message || e) }; }
  console.log(JSON.stringify(out, null, 2));
})();
