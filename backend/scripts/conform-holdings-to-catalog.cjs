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
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const USER = process.env.USER_ID || "";
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

/** Token overlap between the holding's set text and a candidate setKey/setName. */
function setAgrees(holdingSetText, setKey, setName) {
  const h = new Set(slug(holdingSetText).split("-").filter((w) => w && !/^\d{4}$/.test(w) && w !== "baseball"));
  if (!h.size) return false;
  const c = new Set([...slug(setKey).split("-"), ...slug(setName ?? "").split("-")].filter(Boolean));
  for (const w of h) if (!c.has(w)) return false;   // every holding word must appear
  return true;
}

async function main() {
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
                  FROM c WHERE c.year = @y AND c.cardNumber IN (${params.map((p) => p.name).join(",")})`,
          parameters: [{ name: "@y", value: year }, ...params],
        }).fetchAll());

        // 2. player agreement
        const mine = rows.filter((r) => {
          const ps = String(r.playerSlug ?? "");
          return ps && (ps === player || ps.includes(player) || player.includes(ps));
        });
        if (!mine.length) { unresolved++; if (unresolvedEx.length < 8) unresolvedEx.push(`no catalog card: ${h.playerName} ${year} #${num}`); continue; }

        // 3. set agreement -> one setKey
        // Holdings carry the product in EITHER field, and some carry a
        // checklist SECTION ("Prospects Autographs") in setName with the real
        // product in product. Accept agreement from either; the section text
        // alone matched nothing and stranded 76 of 92 holdings.
        const setTexts = [h.setName, h.product].map((x) => String(x ?? "").trim()).filter(Boolean);
        const bySet = new Map();
        for (const r of mine) if (setTexts.some((st) => setAgrees(st, r.setKey, r.setName))) {
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
              const ht = new Set(slug(st).split("-").filter((w) => w && !/^d{4}$/.test(w) && w !== "baseball"));
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
        if (rung.conf >= 0.95) resolvedExact++; else resolvedFuzzy++;

        if (existing === resolved) { agreed++; }
        else if (existing && rung.conf < 0.95) { /* disagreement below the replace gate: report as fuzzy, no write */ }
        else {
          corrected++;
          if (correctedEx.length < 8) correctedEx.push(`${h.playerName} #${num} ${JSON.stringify(h.parallel)}\n        ${existing || "(none)"}\n     -> ${resolved}  (conf ${rung.conf})`);
        }

        if (!APPLY) continue;
        const ops = [];
        if ((existing !== resolved && (rung.conf >= 0.95 || !existing)) ) ops.push({ op: "set", path: `/holdings/${hid}/hobbyiqCardId`, value: resolved });
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
  console.log(`  failed                  ${f(failed)}`);
  if (correctedEx.length) { console.log(`\n  corrections:`); for (const e of correctedEx) console.log(`     ${e}`); }
  if (unresolvedEx.length) { console.log(`\n  unresolved — the acquisition/ruling list:`); for (const e of unresolvedEx) console.log(`     ${e.slice(0, 110)}`); }
}

module.exports = { resolveRung, setAgrees };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
