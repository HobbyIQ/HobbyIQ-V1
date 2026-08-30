#!/usr/bin/env node
/**
 * CF-HOLDINGS-RESOLVE-INTERNALLY (Drew, 2026-08-28: "I do not want it calling
 * cardsight or cardhedge. We use our internal processes").
 *
 * Re-derives every portfolio holding's identity from the holding's OWN fields
 * against OUR catalog -- the checklist spine. No vendor is consulted: the old
 * recheck pass asked CardHedge by title and called 16 of 18 problem holdings
 * "not found" while our catalog held the cards (CPA autos with named
 * refractors, $1,053 of cost basis stranded behind a vendor's parser).
 *
 * RESOLUTION, all internal, strictest first:
 *
 *   1. CANDIDATES  catalog rows matching year + cardNumber (case variants,
 *                  the index-friendly IN shape from resolveSetKey.service).
 *   2. PLAYER      candidates must agree on the player -- year+set+number+
 *                  player is the identity standard, and CPA-AN is two
 *                  different people.
 *   3. SET         among player-agreed candidates, the holding's set text is
 *                  token-matched against setKey/setName; a single surviving
 *                  setKey wins, a split is reported, never guessed.
 *   4. RUNG        the holding's parallel text resolves against the card's
 *                  own rungs by the measured cascade (exact / squash /
 *                  unique long-form, ambiguity 0.2%). No rung is invented;
 *                  Base is never assumed (a blank holding parallel matches
 *                  only a base-segment row that actually exists).
 *
 * CONFIDENCE GATES (the two-rival-gates lesson, made one):
 *   >= 0.95  exact rung match           -> APPLY writes it
 *   0.80     squash / unique long-form  -> APPLY writes it, flagged
 *   below    reported only. An existing hobbyiqCardId is REPLACED only by a
 *            >= 0.95 result that disagrees; never demoted, never nulled.
 *
 * WHAT APPLY WRITES per holding: hobbyiqCardId, identityResolvedBy=
 * "catalog-internal", identityResolvedAt, and cardsightCardId -> null (the
 * stale legacy field observed carrying ":base:" beside a correct canonical).
 *
 * Env: COSMOS_CONNECTION_STRING; APPLY/BACKFILL_APPLY (default report only);
 *      USER (scope to one userId); LIMIT=0
 */
const path = require("node:path");
const fs = require("node:fs");
const backend = path.resolve(__dirname, "..");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
const { CosmosClient } = require("@azure/cosmos");
const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const USER = process.env.USER_ID || "";

// Three attempts with backoff for transient socket/timeout errors; the SDK
// already retries throttles (connectionPolicy). A 404 is an answer, not a fault.
async function retry(fn, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) { last = e; if (e?.code === 404) throw e; await new Promise((r) => setTimeout(r, 500 * (i + 1))); }
  }
  throw last;
}
const LIMIT = Number(process.env.LIMIT || 0);
const f = (n) => Number(n).toLocaleString();

const slug = (s) => String(s ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const FAMILIES = ["refractor", "x-fractor", "prizm", "shimmer", "lava", "wave", "holo", "foilboard", "foil", "sapphire", "chrome", "ice", "mojo", "camo", "pattern"];

/** Rung cascade against the card's own parallels. Returns {seg, conf} or null. */
function resolveRung(parallelText, rungSegs) {
  const s0 = slug(parallelText);
  if (!s0) {
    // Blank means the plain card ONLY if the card actually has a base row.
    return rungSegs.has("base") ? { seg: "base", conf: 0.95 } : null;
  }
  if (rungSegs.has(s0)) return { seg: s0, conf: 0.98 };
  for (const k of rungSegs) if (k.replace(/-/g, "") === s0.replace(/-/g, "")) return { seg: k, conf: 0.8 };
  const candidates = [];
  for (const k of rungSegs) for (const fam of FAMILIES) if (k === `${s0}-${fam}`) { candidates.push(k); break; }
  if (candidates.length === 1) return { seg: candidates[0], conf: 0.8 };
  return null;
}

/**
 * CF-A-HOLDING-NEVER-ADOPTS-A-VENDOR-ROW (Drew, 2026-08-30: "bobby witt came
 * out of bowman draft … first edition is another bowman set"). The 2020
 * Bowman Draft BD152 base row was missing; the only base row left was a
 * CardHedge-minted "bowman-draft-1st-edition" twin, and the pass would have
 * moved the holding onto it. Two rules:
 *   1. only checklist-authority rows are identity targets -- a vendor- or
 *      sale-minted row is a hint, never an identity;
 *   2. a correction never changes the PRODUCT (the setKey segment) of an
 *      existing hiq identity -- a missing checklist row is an acquisition
 *      gap, not a reason to move a holding to another set.
 */
function identityTargets(rows) {
  return (rows ?? []).filter((r) => catalogAuthorityOf(String(r.source ?? "")) === "checklist");
}
const setKeyOf = (hiq) => { const seg = String(hiq ?? "").split(":"); return seg.length >= 4 && seg[0] === "hiq" ? seg[3] : ""; };
function productChanged(existing, resolved) {
  const a = setKeyOf(existing), b = setKeyOf(resolved);
  return Boolean(a) && Boolean(b) && a !== b;
}

/** Token overlap between the holding's set text and a candidate setKey/setName. */
function setAgrees(holdingSetText, setKey, setName) {
  const h = new Set(slug(holdingSetText).split("-").filter((w) => w && !/^\d{4}$/.test(w) && w !== "baseball"));
  if (!h.size) return false;
  const c = new Set([...slug(setKey).split("-"), ...slug(setName ?? "").split("-")].filter(Boolean));
  for (const w of h) if (!c.has(w)) return false;   // every holding word must appear
  return true;
}

/**
 * SCOPE=rulings (Drew, 2026-08-30): apply the per-holding identity rulings in
 * backend/data/holding-identity-rulings.json and nothing else. The bot refuses a
 * product-changing correction; a ruling is the human saying so. Guards: the
 * holding's current hobbyiqCardId must equal `from` (else skipped, reported),
 * the `to` row must exist in card_catalog (point read), and both cardId and
 * hobbyiqCardId are set to `to` -- one identity.
 */
async function applyRulings(portfolio, cat) {
  const file = path.join(backend, "data", "holding-identity-rulings.json");
  const rulings = JSON.parse(fs.readFileSync(file, "utf8")).rulings ?? [];
  console.log(`conform-holdings-to-catalog  SCOPE=rulings  ${APPLY ? "APPLY" : "REPORT ONLY"}  ${rulings.length} ruling(s) from ${path.relative(backend, file)}`);
  let applied = 0, skipped = 0, failed = 0;
  for (const r of rulings) {
    try {
      let row = null; try { row = (await retry(() => cat.item(r.to, r.to).read())).resource ?? null; } catch (e) { if (e?.code !== 404) throw e; }
      if (!row) { skipped++; console.log(`  skip ${r.holdingId.slice(0, 8)} ${r.note}: target row MISSING ${r.to}`); continue; }
      const { resources: docs } = await retry(() => portfolio.items.query({ query: "SELECT c.id, c.userId, c.holdings[@h] AS h FROM c WHERE c.userId = @u AND IS_DEFINED(c.holdings[@h])", parameters: [{ name: "@h", value: r.holdingId }, { name: "@u", value: r.userId }] }).fetchAll());
      const doc = docs[0]; const h = doc?.h;
      if (!h) { skipped++; console.log(`  skip ${r.holdingId.slice(0, 8)}: holding not found for user`); continue; }
      const current = String(h.hobbyiqCardId ?? "");
      if (current === r.to && String(h.cardId ?? "") === r.to) { skipped++; console.log(`  skip ${r.holdingId.slice(0, 8)}: already ${r.to}`); continue; }
      if (current !== r.from) { skipped++; console.log(`  skip ${r.holdingId.slice(0, 8)}: current hobbyiqCardId ${current || "(none)"} != ruling.from ${r.from}`); continue; }
      console.log(`  ${APPLY ? "RULED" : "WOULD RULE"} ${r.holdingId.slice(0, 8)} ${h.playerName ?? ""} #${h.cardNumber ?? ""}: ${r.from} -> ${r.to}  (${r.rulingBy} ${r.date}: ${r.note})`);
      if (!APPLY) { applied++; continue; }
      const ops = [
        { op: "set", path: `/holdings/${r.holdingId}/hobbyiqCardId`, value: r.to },
        { op: "set", path: `/holdings/${r.holdingId}/cardId`, value: r.to },
        { op: "set", path: `/holdings/${r.holdingId}/identityResolvedBy`, value: `ruling:${r.rulingBy}:${r.date}` },
        { op: "set", path: `/holdings/${r.holdingId}/identityResolvedAt`, value: new Date().toISOString() },
      ];
      await retry(() => portfolio.item(doc.id, doc.userId).patch(ops));
      applied++;
    } catch (e) { failed++; console.log(`  failed ${r.holdingId.slice(0, 8)}: ${String(e?.message ?? e).slice(0, 120)}`); }
  }
  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}\n  rulings ${rulings.length}  ${APPLY ? "applied" : "would apply"} ${applied}  skipped ${skipped}  failed ${failed}`);
  if (APPLY) reportWrites({ job: "conform-holdings-to-catalog", intended: rulings.length, written: applied, skipped, failed });
}

async function main() {
  if (String(process.env.SCOPE || "").trim().toLowerCase() === "rulings") {
    const conn = process.env.COSMOS_CONNECTION_STRING;
    if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
    const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
    return applyRulings(db.container("portfolio"), db.container("card_catalog"));
  }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq");
  const cat = db.container("card_catalog"), portfolio = db.container("portfolio");
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

  const { resources: docs } = await retry(() => portfolio.items.query(
    USER ? { query: "SELECT * FROM c WHERE c.userId = @u", parameters: [{ name: "@u", value: USER }] }
         : { query: "SELECT * FROM c" }).fetchAll());
  console.log(`${docs.length} portfolio docs  ${APPLY ? "APPLY" : "REPORT ONLY"}\n`);

  let holdings = 0, resolvedExact = 0, resolvedFuzzy = 0, corrected = 0, agreed = 0, unresolved = 0, legacyCleared = 0, failed = 0;
  let vendorRowsIgnored = 0, vendorRowsRefused = 0, productChangeRefused = 0;
  const refusedEx = [];
  const unresolvedEx = [], correctedEx = [];

  for (const doc of docs) {
    for (const [hid, h] of Object.entries(doc.holdings ?? {})) {
      if (LIMIT && holdings >= LIMIT) break;
      holdings++;
      try {
        const year = Number(h.cardYear ?? h.year);
        const num = String(h.cardNumber ?? "").trim();
        const player = slug(h.playerName ?? "");
        if (!year || !num || !player) { unresolved++; if (unresolvedEx.length < 8) unresolvedEx.push(`missing fields: ${h.playerName} ${year} #${num}`); continue; }

        // 1. candidates by year + number variants (index-usable IN)
        const variants = [...new Set([num, num.toUpperCase(), num.toLowerCase()])];
        const params = variants.map((v, i) => ({ name: `@n${i}`, value: v }));
        const { resources: rows } = await retry(() => cat.items.query({
          query: `SELECT c.id, c.sport, c.setKey, c.setName, c.parallel, c.parallelSlug, c.playerSlug, c.isAuto, c.source
                  FROM c WHERE c.year = @y AND c.cardNumber IN (${params.map((p) => p.name).join(",")}) AND NOT IS_DEFINED(c.gradeTier)`,
          parameters: [{ name: "@y", value: year }, ...params],
        }).fetchAll());

        // 2. player agreement
        const mine = rows.filter((r) => {
          const ps = String(r.playerSlug ?? "");
          return ps && (ps === player || ps.includes(player) || player.includes(ps));
        });
        if (!mine.length) { unresolved++; if (unresolvedEx.length < 8) unresolvedEx.push(`no catalog card: ${h.playerName} ${year} #${num}`); continue; }
        const vendorOnly = mine.length - identityTargets(mine).length;
        const targets = identityTargets(mine);
        if (!targets.length) { unresolved++; vendorRowsRefused++; if (unresolvedEx.length < 8) unresolvedEx.push(`only vendor-minted rows (${[...new Set(mine.map((r) => r.source))].slice(0, 3).join(",")}): ${h.playerName} ${year} #${num}`); continue; }
        if (vendorOnly) vendorRowsIgnored += vendorOnly;

        // 3. set agreement -> one setKey
        // Holdings carry the product in EITHER field, and some carry a
        // checklist SECTION ("Prospects Autographs") in setName with the real
        // product in product. Accept agreement from either; the section text
        // alone matched nothing and stranded 76 of 92 holdings.
        const setTexts = [h.setName, h.product].map((x) => String(x ?? "").trim()).filter(Boolean);
        const bySet = new Map();
        for (const r of targets) if (setTexts.some((st) => setAgrees(st, r.setKey, r.setName))) {
          if (!bySet.has(r.setKey)) bySet.set(r.setKey, []);
          bySet.get(r.setKey).push(r);
        }
        // "2024 Bowman Draft" token-matches bowman-draft AND bowman-draft-
        // sapphire (a superset). When exactly one candidate's setKey tokens
        // EQUAL the holding's tokens, the exact set wins over its
        // specializations -- a plain Bowman Draft is not a Sapphire.
        if (bySet.size > 1) {
          const target = [...bySet.keys()].filter((k) => {
            const kt = new Set(slug(k).split("-").filter(Boolean));
            return setTexts.some((st) => {
              const ht = new Set(slug(st).split("-").filter((w) => w && !/^\d{4}$/.test(w) && w !== "baseball"));
              return ht.size === kt.size && [...ht].every((w) => kt.has(w));
            });
          });
          if (target.length === 1) { const keep = bySet.get(target[0]); bySet.clear(); bySet.set(target[0], keep); }
        }
        if (bySet.size !== 1) {
          unresolved++;
          if (unresolvedEx.length < 8) unresolvedEx.push(`set ${bySet.size === 0 ? "no-match" : "split(" + [...bySet.keys()].slice(0, 3).join("|") + ")"}: ${JSON.stringify(setTexts.join(" / "))} ${h.playerName} #${num}`);
          continue;
        }
        const [setKey, cardRows] = [...bySet.entries()][0];

        // 4. rung from the card's own parallels
        const rungSegs = new Set(cardRows.map((r) => r.parallelSlug ?? slug(r.parallel)).filter(Boolean));
        const rung = resolveRung(h.parallel, rungSegs);
        if (!rung) { unresolved++; if (unresolvedEx.length < 8) unresolvedEx.push(`rung: ${JSON.stringify(h.parallel)} not on ${setKey} #${num} (${[...rungSegs].slice(0, 4).join(",")})`); continue; }

        const sport = cardRows[0].sport;
        const isAuto = h.isAuto === true || cardRows.every((r) => r.isAuto === true);
        const resolved = `hiq:${sport}:${year}:${setKey}:${num.toLowerCase()}:${rung.seg}:${isAuto ? "auto" : "no-auto"}`;
        const existing = String(h.hobbyiqCardId ?? "");
        // CF-THE-IDENTITY-IS-A-ROW: the composed slug must exist as a catalog row.
        // When only its numbered twin exists (the un-numbered twin was folded --
        // #1441/#1470), the numbered row IS the card; two numbered twins are a
        // ruling, not a guess.
        const ids = cardRows.map((r) => String(r.id));
        let target = resolved;
        if (!ids.includes(resolved)) {
          const numbered = numberedTwinsOf(resolved, ids);
          if (numbered.length === 1) target = numbered[0];
          else { unresolved++; if (unresolvedEx.length < 8) unresolvedEx.push(`no row at ${resolved}${numbered.length > 1 ? " (two numbered twins)" : ""}`); continue; }
        }
        // CF-ONLY-IMPROVE: an existing identity that is the numbered form of the
        // resolved row is MORE specific -- keep it.
        if (existing && numberedTwinsOf(target, [existing]).length === 1 && ids.includes(existing)) { agreed++; if (rung.conf >= 0.95) resolvedExact++; else resolvedFuzzy++; continue; }
        if (rung.conf >= 0.95) resolvedExact++; else resolvedFuzzy++;

        if (existing === target) { agreed++; }
        else if (existing && productChanged(existing, target)) {
          productChangeRefused++;
          if (refusedEx.length < 8) refusedEx.push(`${h.playerName} #${num} ${JSON.stringify(h.parallel)}: ${existing} -> ${target} would change the product (${setKeyOf(existing)} -> ${setKeyOf(target)}); refused -- a missing checklist row is an acquisition gap`);
          continue;
        }
        else if (existing && rung.conf < 0.95) { /* disagreement below the replace gate: report as fuzzy, no write */ }
        else {
          corrected++;
          if (correctedEx.length < 8) correctedEx.push(`${h.playerName} #${num} ${JSON.stringify(h.parallel)}\n        ${existing || "(none)"}\n     -> ${target}  (conf ${rung.conf})`);
        }

        if (!APPLY) continue;
        const ops = [];
        if ((existing !== target && (rung.conf >= 0.95 || !existing)) ) ops.push({ op: "set", path: `/holdings/${hid}/hobbyiqCardId`, value: target });
        if (h.cardsightCardId !== undefined && h.cardsightCardId !== null) { ops.push({ op: "set", path: `/holdings/${hid}/cardsightCardId`, value: null }); legacyCleared++; }
        if (ops.length) {
          ops.push({ op: "set", path: `/holdings/${hid}/identityResolvedBy`, value: "catalog-internal" });
          ops.push({ op: "set", path: `/holdings/${hid}/identityResolvedAt`, value: new Date().toISOString() });
          await retry(() => portfolio.item(doc.id, doc.userId).patch(ops.slice(0, 10)));
        }
      } catch (e) {
        failed++;
        if (failed <= 5) console.error(`  failed ${String(h.playerName).slice(0, 30)}: ${String(e.message || e).slice(0, 70)}`);
      }
    }
  }

  console.log(`${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  holdings scanned        ${f(holdings)}`);
  console.log(`  resolved exact (>=.95)  ${f(resolvedExact)}`);
  console.log(`  resolved fuzzy (.80)    ${f(resolvedFuzzy)}`);
  console.log(`  already agreed          ${f(agreed)}`);
  console.log(`  CORRECTED identity      ${f(corrected)}`);
  console.log(`  legacy field cleared    ${f(legacyCleared)}`);
  console.log(`  unresolved (reported)   ${f(unresolved)}`);
  console.log(`  vendor rows ignored     ${f(vendorRowsIgnored)}   <- never an identity target`);
  console.log(`  only vendor rows        ${f(vendorRowsRefused)}   <- counted in unresolved`);
  console.log(`  product change REFUSED  ${f(productChangeRefused)}   <- an existing identity keeps its set`);
  console.log(`  failed                  ${f(failed)}`);
  // CF-EVERY-WRITE-JOB-RECONCILES: intended = every holding scanned; written =
  // identities corrected (+ legacy fields cleared); skipped = agreed +
  // unresolved + resolved-but-unchanged; failed declared. Disjoint by design.
  if (APPLY) reportWrites({ job: "conform-holdings-to-catalog", intended: holdings, written: corrected + legacyCleared, skipped: holdings - corrected - legacyCleared - failed, failed });
  if (refusedEx.length) { console.log(`\n  refused:`); for (const e of refusedEx) console.log(`     ${e}`); }
  if (correctedEx.length) { console.log(`\n  corrections:`); for (const e of correctedEx) console.log(`     ${e}`); }
  if (unresolvedEx.length) { console.log(`\n  unresolved — the acquisition/ruling list:`); for (const e of unresolvedEx) console.log(`     ${e.slice(0, 110)}`); }
}

/** Pure: which catalog row a composed slug resolves to among the card's rows (the un-numbered row, else its ONE numbered twin, else nothing). */
/** The numbered twins of an un-numbered id: exactly `<id>:num-N` — a graded child (`<id>:num-N:psa-9`) is derived, never a twin (Gillen, 2026-08-30: two graded children made the card "ambiguous"). */
function numberedTwinsOf(resolved, ids) {
  const prefix = resolved + ":num-";
  return ids.filter((id) => id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length)));
}
function rowFor(resolved, ids) {
  if (ids.includes(resolved)) return resolved;
  const numbered = numberedTwinsOf(resolved, ids);
  return numbered.length === 1 ? numbered[0] : null;
}
module.exports = { resolveRung, setAgrees, identityTargets, productChanged, setKeyOf, rowFor, numberedTwinsOf };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
