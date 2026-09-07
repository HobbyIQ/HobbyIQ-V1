#!/usr/bin/env node
/**
 * classify-split-identity-rows.cjs -- PARK or ROUTE, decided per row.
 *
 * CF-A-SPLIT-ROW-POLLUTES-TWO-POOLS. Reads the sport-segment split population
 * measured by measure-split-identity-population.cjs and decides, for each row,
 * whether the catalog can say WHICH of its two addresses is the card. READ ONLY:
 * it reads card_catalog and writes a classification file. Nothing reaches Cosmos.
 *
 * ── A DECIDABLE ROW IS NOT PARKED ───────────────────────────────────────────
 *
 * PARK (identityUnverified) is the vehicle for a row whose destination has no
 * catalog row and whose right side is undecidable. It is NOT a way to avoid
 * deciding. Lists 01-04 parked 7,996 Pokemon rows because 0 of their 1,218
 * destinations existed; that was the measurement's verdict, not a policy. So
 * this pass asks the question again, per row, and routes what it can place:
 *
 *   PARK      neither side carries a checklist-backed catalog row, OR both do
 *             (the catalog then names no winner and a guess would be ours).
 *   RELOCATE  exactly one side is backed and it is `hobbyiqCardId`. sold_comps
 *             is partitioned on /cardId, so the row MOVES.
 *   REPOINT   exactly one side is backed and it is `cardId`. The partition is
 *             already right; only the canonical slug is wrong, so it is a
 *             patch in place.
 *
 * The backing question is `identityBackingOf` -- the SHIPPED predicate the
 * pricing gate uses to decide whether a price may rest on a catalog row. What
 * may carry a price is what may receive a sale, and a second copy of that rule
 * would be a second place for it to drift.
 *
 * ── A CHECKLIST-BACKED ADDRESS IS NOT AUTOMATICALLY THIS SALE'S ADDRESS ─────
 *
 * The rule above, applied alone, is WRONG, and the first dry run proved it. Row
 * `tca-ebay::800047768734` is an "Upper Deck Halo Legacy Collection Carter-A259
 * Great Journey #51" sale sitting at `hiq:baseball:2024:bowman:51:base:no-auto`
 * beside a `non-sport` twin. That baseball address IS checklist-backed -- by
 * 2024 Bowman #51, a real and entirely different card that happens to share the
 * number. "Exactly one side is backed" elected it, and the route would have
 * filed a Halo sale into a real baseball card's comp pool: precisely the defect
 * this whole repair exists to undo, performed deliberately.
 *
 * Backing proves a CARD is at that address. It does not prove THIS SALE is that
 * card. So the SALE'S TITLE holds two VETOES over the catalog's winner, and it
 * can elect neither side -- the catalog decides, the title only refuses:
 *
 *   VERTICAL  the title must not name a different sport than the winner.
 *   PRODUCT   the title must name a product that CORROBORATES the winner's
 *             setKey. A title naming no product corroborates nothing and
 *             carries no route.
 *
 * `inferSportFromTitle` defaults to "baseball" on no evidence -- the very
 * default #1929 removed from the write path, and it reads a Pikachu promo as
 * baseball -- so it is asked with a SENTINEL, which turns that guess back into
 * an answer. Measured on the 400-row dry run the vetoes moved 8 rows out of
 * ROUTE and into PARK, the Halo row among them.
 *
 * Env: COSMOS_CONNECTION_STRING required; OUT (the measurement's directory);
 *      BATCH, CONC tune the card_catalog read.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { identityBackingOf } = require(path.join(backend, "dist/services/catalog/identityBacking.js"));
const {
  inferSportFromTitle, inferSetKeyFromTitle,
} = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));

/**
 * What the SALE'S TITLE states about its vertical, or null when it states
 * nothing.
 *
 * `inferSportFromTitle` defaults to "baseball" when it recognises nothing —
 * that default is the very thing #1929 removed from the write path, and it
 * reads a Pikachu promo as baseball. Passing a sentinel turns the guess back
 * into an ANSWER: either the title names a vertical, or it does not.
 *
 * It is used ONLY AS A VETO. The catalog decides which side wins; the title can
 * refuse that winner, never elect one. A title that names nothing vetoes
 * nothing, so a route still rests on the checklist and never on this string.
 */
const UNSTATED = "(unstated)";
function titleStatesSport(title) {
  const t = String(title ?? "").trim();
  if (!t) return null;
  const s = inferSportFromTitle(t, UNSTATED);
  return s === UNSTATED ? null : String(s);
}

/**
 * The PRODUCT the sale's title names, slugged, or null when it names none.
 *
 * A CHECKLIST-BACKED ADDRESS IS NOT AUTOMATICALLY THIS SALE'S ADDRESS. The
 * measurement found `tca-ebay::800047768734` -- an "Upper Deck Halo Legacy
 * Collection Carter-A259 ... #51" sale -- sitting at
 * `hiq:baseball:2024:bowman:51:base:no-auto` beside a `non-sport` twin. That
 * baseball address IS checklist-backed, because 2024 Bowman #51 is a real
 * card; it is simply a DIFFERENT card that happens to share the number. A rule
 * that routed on backing alone would have filed a Halo sale into a real
 * baseball card's comp pool -- the exact defect this whole repair exists to
 * undo, performed deliberately.
 *
 * So a route also requires the title to CORROBORATE the destination's product.
 * A title that names no product corroborates nothing and cannot carry a route.
 */
function titleStatesSetKey(title) {
  const t = String(title ?? "").trim();
  if (!t) return null;
  let s = null;
  try { s = inferSetKeyFromTitle(t); } catch { return null; }
  const v = String(s ?? "").trim();
  if (!v || /^unknown$/i.test(v)) return null;
  return v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** The setKey segment of an hiq slug. */
const setKeyOf = (slug) => String(slug || "").split(":")[3] || "";

const { CANONICAL_SPORTS } = require(path.join(backend, "dist/services/portfolioiq/slugGuard.service.js"));

/**
 * Is this string an ADDRESS we can reason about at all?
 *
 * A route asserts "this sale belongs at the OTHER side". That claim only means
 * anything if both sides are real card addresses. Measured on this population,
 * 385 rows the catalog was willing to route carry a source that is not:
 *
 *   hiq:sight::be80caf8-…::bulk            a `cardsight:` vendor id with `hiq:`
 *   hiq:hedge::1682403647139x5395…::472a…  glued onto the front — the vertical
 *                                          segment is the tail of the VENDOR
 *                                          NAME, not a sport
 *   hiq:ant::hiq:basketball:2025:…         a slug prefixed onto another slug
 *   hiq:baseball-mlb:2018:topps-heritage:… a vertical ALIAS that is not in
 *   hiq:other:2009:topps-heritage:1:…      CANONICAL_SPORTS
 *
 * None of these is a sport disagreement between two cards; they are malformed
 * keys and an un-normalised vocabulary, and each is its own repair. Routing off
 * them would let this lane quietly launder a junk partition into a real card's
 * pool, and the banner would read "RELOCATED" as though a card had been placed.
 * So they PARK, with the defect named, and the vertical vocabulary is the
 * SHIPPED CANONICAL_SPORTS rather than a list re-typed here.
 */
function addressDefect(slug) {
  const s = String(slug || "");
  if (!s.startsWith("hiq:")) return "is not an hiq: address";
  if (s.includes("::")) return "contains an empty slug segment (a vendor key wearing an hiq: prefix)";
  const parts = s.split(":");
  if (parts.length < 7) return `has only ${parts.length} segments; an hiq address has at least 7`;
  const sport = parts[1];
  if (!CANONICAL_SPORTS.has(sport)) return `names "${sport}", which is not a canonical vertical`;
  return null;
}

const OUT = process.env.OUT || "C:/tmp/hiq-split-tranche/work/out";
const BATCH = Number(process.env.BATCH || 200);
const CONC = Number(process.env.CONC || 12);
const f = (n) => Number(n ?? 0).toLocaleString();

const retry = async (fn, tries = 10) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); } catch (e) {
      const m = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|timeout/i.test(m) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000);
    }
  }
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  // JSONL, because the measurement streams it: the buffered version of that
  // walk was OOM-killed at 5M of 16.9M rows.
  const rowsPath = path.join(OUT, "sport-split-rows.jsonl");
  const all = fs.readFileSync(rowsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  // Skip rows already parked — a repair never re-touches them.
  const work = all.filter((r) => !r.identityUnverified);
  console.log(`sport-split rows ${f(all.length)};  already parked ${f(all.length - work.length)};  to classify ${f(work.length)}`);

  const slugs = new Set();
  for (const r of work) { if (r.cardId) slugs.add(r.cardId); if (r.hobbyiqCardId) slugs.add(r.hobbyiqCardId); }
  const list = [...slugs];
  console.log(`distinct candidate addresses ${f(list.length)} — reading card_catalog (READ ONLY)`);

  const cat = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 40, maxWaitTimeInSeconds: 180 } },
  }).database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");

  /** slug -> [catalog rows] */
  const found = new Map();
  const batches = [];
  for (let i = 0; i < list.length; i += BATCH) batches.push(list.slice(i, i + BATCH));

  // card_catalog is keyed by the slug as BOTH id and partition key — that is
  // how repair-base-to-title-finish.cjs's destExists() reads it. `hobbyiqCardId`
  // is the same slug carried as a field (backfillCatalogHiqSlug.cjs), so the
  // batched query asks on BOTH: a row is never called absent because it was
  // keyed the other way.
  let done = 0;
  const worker = async (queue) => {
    for (const b of queue) {
      const params = b.map((s, i) => ({ name: `@s${i}`, value: s }));
      const inList = params.map((p) => p.name).join(",");
      const page = await retry(() => cat.items.query({
        query: `SELECT c.id, c.hobbyiqCardId, c.source, c.player, c.cardNumber, c.setKey, c.cardYear, c.flaggedWrong, c.identityUnverified FROM c WHERE c.id IN (${inList}) OR c.hobbyiqCardId IN (${inList})`,
        parameters: params,
      }, { maxItemCount: 1000 }).fetchAll());
      const res = page.resources ?? [];
      for (const row of res) {
        for (const key of [row.id, row.hobbyiqCardId]) {
          if (!key || !slugs.has(key)) continue;
          const arr = found.get(key) ?? [];
          if (!arr.some((x) => x.id === row.id)) arr.push(row);
          found.set(key, arr);
        }
      }
      done++;
      if (done % 25 === 0) process.stderr.write(`\r  catalog batches ${done}/${batches.length}   `);
    }
  };
  const queues = Array.from({ length: CONC }, () => []);
  batches.forEach((b, i) => queues[i % CONC].push(b));
  await Promise.all(queues.map(worker));
  process.stderr.write("\n");

  /** Does this slug carry a live, checklist-backed catalog row? */
  const backingOf = (slug) => {
    const raw = (found.get(slug) ?? []).filter((r) => r.flaggedWrong !== true && r.identityUnverified !== true);
    return identityBackingOf(slug, raw.map((r) => ({
      source: r.source, id: r.id, player: r.player,
      cardNumber: r.cardNumber, setKey: r.setKey, cardYear: r.cardYear,
    })));
  };
  const cache = new Map();
  const backing = (slug) => { if (!cache.has(slug)) cache.set(slug, backingOf(slug)); return cache.get(slug); };

  const park = [], relocate = [], repoint = [];
  const reasons = new Map();
  const bump = (k) => reasons.set(k, (reasons.get(k) ?? 0) + 1);
  const sportOf = (s) => String(s || "").split(":")[1] || "";
  const today = new Date().toISOString().slice(0, 10);

  for (const r of work) {
    const bc = backing(r.cardId), bh = backing(r.hobbyiqCardId);
    let okC = bc === "checklist-backed", okH = bh === "checklist-backed";
    const base = {
      id: r.id, fromCardId: r.cardId, currentAddress: r.cardId,
      price: r.price, soldAt: r.soldAt, title: r.title, source: r.source,
    };
    const pair = `cardId vertical "${sportOf(r.cardId)}" vs hobbyiqCardId "${sportOf(r.hobbyiqCardId)}"`;
    const segs = `segments differing: ${r.segments.join(",")}`;

    // THE TITLE'S VETO. The catalog elects a winner; the title may refuse it.
    // Where the title names a vertical and the checklist-backed side names a
    // DIFFERENT one, the two attestations disagree and the row is not decidable
    // — it parks rather than being routed to an address the sale contradicts.
    const stated = titleStatesSport(r.title);
    let veto = null;
    if (stated) {
      if (okH && !okC && stated !== sportOf(r.hobbyiqCardId)) {
        veto = `the title states the vertical "${stated}" but the only checklist-backed side is "${sportOf(r.hobbyiqCardId)}"`;
        okH = false;
      } else if (okC && !okH && stated !== sportOf(r.cardId)) {
        veto = `the title states the vertical "${stated}" but the only checklist-backed side is "${sportOf(r.cardId)}"`;
        okC = false;
      }
    }
    if (veto) bump("park:title-vetoed-the-catalog-winner-on-vertical");

    // BOTH ADDRESSES MUST BE ADDRESSES. A route is a claim about which of two
    // CARDS this sale is; a malformed key or an un-normalised vertical is
    // neither card, and routing off one launders a junk partition into a real
    // pool while the banner reads "RELOCATED".
    const defectFrom = addressDefect(r.cardId);
    const defectTo = addressDefect(r.hobbyiqCardId);
    if (defectFrom || defectTo) {
      const which = defectFrom && defectTo
        ? `both addresses are malformed (cardId ${defectFrom}; hobbyiqCardId ${defectTo})`
        : defectFrom
          ? `the cardId address ${defectFrom}`
          : `the hobbyiqCardId address ${defectTo}`;
      veto = veto ?? `${which}, so this is a key defect and not a decidable sport split`;
      okC = okH = false;
      bump("park:address-is-not-a-card-address");
    }

    // THE PRODUCT MUST BE CORROBORATED TOO. A checklist-backed address proves a
    // CARD exists there; it does not prove THIS SALE is that card. Routing on
    // backing alone filed an Upper Deck Halo sale into 2024 Bowman #51 in the
    // first dry run, because that address is genuinely backed by a real and
    // entirely different card.
    const winner = okH && !okC ? r.hobbyiqCardId : okC && !okH ? r.cardId : null;
    if (winner) {
      const titleSet = titleStatesSetKey(r.title);
      const destSet = setKeyOf(winner);
      if (!titleSet) {
        veto = `the title names no product, so nothing corroborates that this sale is the card at ${winner}`;
        okC = okH = false;
        bump("park:title-names-no-product");
      } else if (titleSet !== destSet && !destSet.startsWith(titleSet) && !titleSet.startsWith(destSet)) {
        veto = `the title names the product "${titleSet}" but the checklist-backed side is the product "${destSet}"`;
        okC = okH = false;
        bump("park:title-vetoed-the-catalog-winner-on-product");
      }
    }

    const titleSetFinal = titleStatesSetKey(r.title);
    const titleNote =
      ` The sale title names the product "${titleSetFinal}", which corroborates the destination` +
      (stated
        ? `, and states the vertical "${stated}", which agrees with it.`
        : `; it states no vertical, so the vertical rests on the checklist alone.`);
    if (okH && !okC) {
      relocate.push({ ...base, toCardId: r.hobbyiqCardId,
        evidence: `RELOCATE. ${pair}; ${segs}. hobbyiqCardId ${r.hobbyiqCardId} HAS a checklist-backed card_catalog row (identityBackingOf=checklist-backed, read-only ${today}) and cardId ${r.cardId} does not (${bc}). Exactly one side is checklist-backed, so that side is the card and the row moves to it.${titleNote}` });
      bump("relocate:hobbyiqCardId-backed");
    } else if (okC && !okH) {
      // `displacedHobbyiqCardId` is the WRONG slug being overwritten. The lane
      // does not need it -- it patches toward `repointHobbyiqCardId` -- but
      // without it the entry cannot show that this row was a SPORT split at
      // all: on a repoint the partition IS the destination, so `fromCardId`
      // and the target are identical by construction and the disagreement
      // lives entirely in the field being replaced.
      repoint.push({ ...base, repointHobbyiqCardId: r.cardId, displacedHobbyiqCardId: r.hobbyiqCardId,
        evidence: `REPOINT. ${pair}; ${segs}. cardId ${r.cardId} HAS a checklist-backed card_catalog row (identityBackingOf=checklist-backed, read-only ${today}) and hobbyiqCardId ${r.hobbyiqCardId} does not (${bh}). The partition is already right; only hobbyiqCardId names the wrong card, so this is a patch in place.${titleNote}` });
      bump("repoint:cardId-backed");
    } else {
      const why = veto
        ? `NEITHER side carries a checklist-backed catalog row this sale agrees with: ${veto} (cardId=${bc}, hobbyiqCardId=${bh})`
        : okC && okH
          ? `BOTH sides carry a checklist-backed catalog row (${bc} / ${bh}), so the catalog cannot say which card this sale is`
          : `NEITHER side carries a checklist-backed catalog row (cardId=${bc}, hobbyiqCardId=${bh}), so RELOCATE would mint an identity from a sale`;
      park.push({ ...base, parkIdentityUnverified: true, wouldBeCardId: r.hobbyiqCardId,
        evidence: `PARK. ${pair}; ${segs}. ${why}. identityUnverified keeps the row out of EVERY pool without asserting which card it belongs to.` });
      if (!veto) bump(okC && okH ? "park:both-backed" : `park:neither-backed(${bc}/${bh})`);
    }
  }

  fs.writeFileSync(path.join(OUT, "classified.json"), JSON.stringify({ park, relocate, repoint }, null, 1));
  console.log("\n" + "=".repeat(70));
  console.log("SPLIT CLASSIFICATION (READ ONLY)");
  console.log("=".repeat(70));
  console.log(`  to classify               ${f(work.length).padStart(9)}`);
  console.log(`  PARK                      ${f(park.length).padStart(9)}`);
  console.log(`  RELOCATE (move partition) ${f(relocate.length).padStart(9)}`);
  console.log(`  REPOINT  (patch in place) ${f(repoint.length).padStart(9)}`);
  console.log("\nREASONS");
  for (const [k, v] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(52)} ${f(v).padStart(9)}`);
  const destExists = [...cache].filter(([, v]) => v === "checklist-backed").length;
  console.log(`\ncandidate addresses ${f(list.length)}; checklist-backed ${f(destExists)}; other ${f(list.length - destExists)}`);
  const byBacking = new Map();
  for (const [, v] of cache) byBacking.set(v, (byBacking.get(v) ?? 0) + 1);
  for (const [k, v] of [...byBacking].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${f(v).padStart(9)}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
