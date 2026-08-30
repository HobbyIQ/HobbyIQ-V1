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
  // CF-BASE-REFRACTOR-IS-THE-PLAIN-REFRACTOR (2026-08-30, D35). The long-form
  // probe above only ever APPENDS a family ("<text>-<fam>"), so a holding
  // parallel of "Refractor" looks for "refractor-refractor". The
  // checklistcenter-2026-08-29 vocabulary spells the plain auto parallel
  // "base-refractor" -- a long form in the PREFIX direction -- so holding
  // af962529 (Michael Harris II, 2020 Bowman Chrome CPA-MH Refractor)
  // reported: rung "Refractor" not on bowman-chrome #CPA-MH, while sitting
  // pinned to a derived row. "base-<family>" IS the plain <family>.
  //
  // This is a BASE/PLAIN equivalence, not a colour rule: D31 says no colour
  // vocabulary and none is added -- "Blue" against {blue, blue-refractor}
  // still takes the exact "blue" above and never reaches here.
  if (FAMILIES.includes(s0) && rungSegs.has("base-" + s0)) return { seg: "base-" + s0, conf: 0.8 };
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

/**
 * CF-A-NUMBER-IS-THE-SAME-NUMBER-SPACED-OR-NOT (2026-08-30, D35). The
 * candidate query is cardNumber IN (...), and the three variants were
 * as-is / upper / lower -- all of which preserve whitespace. Holding b2ea5dac
 * stores "BBP 14"; the checklist row (baseballcardpedia, playerSlug
 * greg-maddux) stores "BBP14". The row EXISTS and was never fetched, so the
 * holding reported "only vendor-minted rows" against its own self-seed.
 * Whitespace is typography, not identity, so the space-stripped and
 * space-hyphenated forms join the IN list.
 *
 * DELIBERATELY NOT WIDENED: hyphens are NOT stripped and nothing fuzzy is
 * added. Beckett initials already collide (CPA-AN is both Angel Nunez and
 * Alejandro Nunez) -- the NUMBER test is the one guard that must stay narrow.
 * This only adds spellings of the SAME number.
 */
function cardNumberVariants(num) {
  const raw = String(num ?? "").trim();
  if (!raw) return [];
  const forms = [raw, raw.replace(/\s+/g, ""), raw.replace(/\s+/g, "-")];
  const out = [];
  for (const f of forms) for (const v of [f, f.toUpperCase(), f.toLowerCase()]) if (v && !out.includes(v)) out.push(v);
  return out;
}

/**
 * CF-THE-SET-FIELD-CARRIES-THE-PARALLEL (2026-08-30, D35). setAgrees demands
 * that EVERY holding set-text token appear in the candidate's setKey+setName.
 * Holding 437f010d (Derek Jeter 1997 Bowman's Best Preview) has setName AND
 * product both reading "Bowmans Best Preview Atomic Refractor" -- the eBay
 * parse glued the SUBSET word and the PARALLEL NAME into the set field, the
 * known footnote/parallel-in-setName pollution reaching the holding side. Its
 * candidate row is checklist-backed (baseballcardpedia, playerSlug
 * derek-jeter) with the rung matching exactly, and it still reported "set
 * no-match" because preview/atomic/refractor cannot appear in setKey
 * "bowmans-best" + setName "1997 Bowmans Best Baseball".
 *
 * A token is dropped ONLY when the holding itself accounts for it elsewhere:
 * it appears in the holding's own parallel field (the rung gate in step 4
 * still has to match that against the card's real rungs), or it is a
 * checklist SECTION word rather than a product word. Everything else must
 * still appear. A genuine product disagreement -- "Sapphire", "Draft",
 * "Chrome" -- is not on the stoplist and still returns false, which is the
 * guard-scope line: this relaxes WHICH WORDS COUNT AS SET TEXT, never
 * whether the set must agree.
 */
const SUBSET_WORDS = new Set(["preview", "previews", "masters", "autographs", "autograph", "auto", "insert", "inserts"]);

/**
 * THE WORDS THAT NAME A PRODUCT, read from the productSetKeys table rather
 * than written out here, so this cannot drift from D23's vocabulary. A token
 * in this set is NEVER excused: "sapphire", "chrome", "draft", "update",
 * "prospects", "series" and "edition" all name products, and a plain Bowman
 * Draft must not match a Bowman Draft Sapphire just because the holding's
 * parallel field happens to say "Sapphire". Fails OPEN to an empty set only
 * if the table cannot be loaded, which is the pre-existing strict behaviour.
 */
const PRODUCT_WORDS = (() => {
  try {
    const { productSetKeys } = require(path.join(backend, "dist/services/catalog/productSetKeys.js"));
    const w = new Set();
    for (const k of productSetKeys()) for (const part of String(k).split("-")) if (part) w.add(part);
    return w;
  } catch { return new Set(); }
})();

/**
 * CF-A-POSSESSIVE-IS-NOT-A-TOKEN (2026-08-30, D35). slug() turns every
 * non-alphanumeric run into a separator, so "1996 Bowman's Best" tokenises to
 * {1996, bowman, s, best} -- and the stray "s" appears in no setKey or
 * setName, so EVERY candidate failed. Holding b2ea5dac's checklist row
 * (hiq:baseball:1996:bowmans-best:bbp14:atomic-refractor:no-auto,
 * baseballcardpedia, playerSlug greg-maddux) was fetched, player-agreed and
 * rung-exact, and still reported "set no-match" on an apostrophe.
 *
 * The apostrophe is folded away BEFORE tokenising, so "Bowman's" and
 * "Bowmans" are one word, which is what the catalog's own setKey already
 * spells. Scoped to set-text comparison only: the global slug() that COMPOSES
 * ids is untouched, so no identity changes spelling because of this.
 */
const setSlug = (s) => slug(String(s ?? "").replace(/['\u2019]/g, ""));

function setAgrees(holdingSetText, setKey, setName, holding) {
  const h = new Set(setSlug(holdingSetText).split("-").filter((w) => w && !/^\d{4}$/.test(w) && w !== "baseball"));
  if (!h.size) return false;
  const c = new Set([...setSlug(setKey).split("-"), ...setSlug(setName ?? "").split("-")].filter(Boolean));
  const parallelWords = new Set(slug(holding && holding.parallel).split("-").filter(Boolean));
  for (const w of h) {
    if (c.has(w)) continue;
    // A word that NAMES A PRODUCT is never excused, however it reached the
    // holding's set text. This is the guard-scope line: the relaxation below
    // decides which words count as set text, never whether the set agrees.
    if (PRODUCT_WORDS.has(w)) return false;
    if (parallelWords.has(w)) continue;   // the holding's own parallel field says this word
    if (SUBSET_WORDS.has(w)) continue;    // a checklist section, not a product
    return false;                          // every other holding word must appear
  }
  return true;
}

/**
 * CF-A-CHECKLIST-ROW-WITHOUT-A-PLAYERSLUG-IS-STILL-THAT-PLAYER (2026-08-30,
 * D35). Step 2 filtered on r.playerSlug alone. Only 254 of 605 1997
 * setKey="finest" checklist rows carry one -- the rest carry playerName
 * ("Ken Griffey, Jr.") -- so the authoritative rows were dropped before
 * authority was even considered, leaving the vendor self-seed and the report
 * "only vendor-minted rows". Fall back to slugifying playerName.
 *
 * The second rule is the narrow one. Catalog "justin-gonzales" vs holding
 * "justin-gonzalez" differ in the FINAL LETTER, so neither contains the other
 * and containment fails. A single trailing-character difference is accepted,
 * but ONLY as a last resort: the near-miss set is returned separately and is
 * used only when NO row agrees exactly. Beckett initials collide, so this
 * widens the NAME test and never the NUMBER test -- two different players at
 * one cardNumber still split rather than pin.
 */
function playerAgreement(rows, player) {
  const nameOf = (r) => String(r.playerSlug ?? "") || slug(r.playerName ?? "");
  const agrees = (ps) => Boolean(ps) && (ps === player || ps.includes(player) || player.includes(ps));
  const exact = (rows ?? []).filter((r) => agrees(nameOf(r)));
  if (exact.length) return { rows: exact, nearMiss: false };
  const near = (rows ?? []).filter((r) => {
    const ps = nameOf(r);
    if (!ps || !player) return false;
    if (Math.abs(ps.length - player.length) > 1) return false;
    const a = ps.length >= player.length ? ps : player;
    const b = ps.length >= player.length ? player : ps;
    if (a.length === b.length) return a.slice(0, -1) === b.slice(0, -1) && a !== b;
    return a.slice(0, -1) === b;
  });
  return near.length ? { rows: near, nearMiss: true } : { rows: [], nearMiss: false };
}

/**
 * The subset of a ruling's `fields` that actually DIFFER on the holding, as
 * patch ops (D36, Drew 2026-08-30). A ruling names the holding's own text it
 * corrects (year, setName, ...); only keys whose value really changes are
 * written, so a re-run of an applied ruling is a no-op rather than a churn of
 * identical writes. Values are written as given -- the ruling is the human's
 * spelling. A key that is not a plain identifier is ignored outright: a patch
 * path is never built out of arbitrary text.
 */
function fieldOps(holdingId, h, fields) {
  const out = [];
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k)) continue;   // never build a path from arbitrary text
    const cur = h?.[k];
    const same = cur === v || (cur != null && v != null && String(cur) === String(v));
    if (same) continue;
    out.push({ op: "set", path: `/holdings/${holdingId}/${k}`, value: v, _k: k, _from: cur });
  }
  return out;
}

/**
 * SCOPE=rulings (Drew, 2026-08-30): apply the per-holding identity rulings in
 * backend/data/holding-identity-rulings.json and nothing else. The bot refuses a
 * product-changing correction; a ruling is the human saying so. Guards: the
 * holding's current hobbyiqCardId must equal `from` (else skipped, reported),
 * the `to` row must exist in card_catalog (point read), and both cardId and
 * hobbyiqCardId are set to `to` -- one identity.
 *
 * `from: null` -- A HOLDING WITH NO IDENTITY YET (D36, Drew 2026-08-30). Two of
 * the rulings are holdings that carry a `cardId` but no `hobbyiqCardId` at all
 * (the Gonzalez CPA-JG and the Caglianone RA-JC). `from` must still be
 * declared, so the ruling states what it expects to find: null (or "") means
 * "this holding has no hobbyiqCardId", and the guard holds exactly as strictly
 * -- a holding that has since acquired one is skipped, not overwritten.
 *
 * `fields` -- A RULING MAY ALSO CORRECT THE HOLDING'S OWN TEXT. The Caglianone
 * holding says "2024 Bowman Draft" while its eBay title says 2026 Topps Chrome;
 * moving the identity without the text leaves the card displaying the wrong
 * product forever. Only the keys named in `fields` are written, and only when
 * they actually differ. The cardNumber alignment below is unchanged and still
 * takes the catalog row's spelling.
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
      if (current === r.to && String(h.cardId ?? "") === r.to) {
        // Already ruled — but the displayed card number may still be the old one.
        if (row.cardNumber && String(h.cardNumber ?? "") !== String(row.cardNumber)) {
          console.log(`  ${APPLY ? "FIXED NUMBER" : "WOULD FIX NUMBER"} ${r.holdingId.slice(0, 8)}: cardNumber ${JSON.stringify(h.cardNumber)} -> ${JSON.stringify(row.cardNumber)} (already ${r.to})`);
          if (APPLY) await retry(() => portfolio.item(doc.id, doc.userId).patch([{ op: "set", path: `/holdings/${r.holdingId}/cardNumber`, value: String(row.cardNumber) }]));
          applied++; continue;
        }
        skipped++; console.log(`  skip ${r.holdingId.slice(0, 8)}: already ${r.to}`); continue;
      }
      // `from: null` (or "") is the ruling saying "expect NO identity yet".
      const expectsNone = r.from === null || r.from === undefined || r.from === "";
      if (expectsNone ? current !== "" : current !== r.from) {
        skipped++;
        console.log(`  skip ${r.holdingId.slice(0, 8)}: current hobbyiqCardId ${current || "(none)"} != ruling.from ${expectsNone ? "(none)" : r.from}`);
        continue;
      }
      console.log(`  ${APPLY ? "RULED" : "WOULD RULE"} ${r.holdingId.slice(0, 8)} ${h.playerName ?? ""} #${h.cardNumber ?? ""}: ${expectsNone ? "(no identity)" : r.from} -> ${r.to}  (${r.rulingBy} ${r.date}: ${r.note})`);
      const fops = fieldOps(r.holdingId, h, r.fields);
      for (const o of fops) console.log(`      ${APPLY ? "field" : "would set"} ${o._k}: ${JSON.stringify(o._from)} -> ${JSON.stringify(o.value)}`);
      if (!APPLY) { applied++; continue; }
      const ops = [
        ...fops.map(({ op, path: pth, value }) => ({ op, path: pth, value })),
        { op: "set", path: `/holdings/${r.holdingId}/hobbyiqCardId`, value: r.to },
        { op: "set", path: `/holdings/${r.holdingId}/cardId`, value: r.to },
        { op: "set", path: `/holdings/${r.holdingId}/identityResolvedBy`, value: `ruling:${r.rulingBy}:${r.date}` },
        { op: "set", path: `/holdings/${r.holdingId}/identityResolvedAt`, value: new Date().toISOString() },
      ];
      // A ruling that changes the card number corrects the holding's displayed
      // number too (Harrison's Ohtani read "#9" after moving to #150).
      if (row.cardNumber && String(h.cardNumber ?? "") !== String(row.cardNumber)) {
        ops.push({ op: "set", path: `/holdings/${r.holdingId}/cardNumber`, value: String(row.cardNumber) });
      }
      // CF-VERIFIED-IS-CHECKLIST-BACKED: a ruling onto a checklist-backed row is VERIFIED.
      if (catalogAuthorityOf(String(row.source ?? "")) === "checklist") {
        const at = new Date().toISOString();
        ops.push({ op: "set", path: `/holdings/${r.holdingId}/identityVerified`, value: true });
        ops.push({ op: "set", path: `/holdings/${r.holdingId}/identityVerifiedAt`, value: at });
        ops.push({ op: "set", path: `/holdings/${r.holdingId}/identityVerifiedBy`, value: { source: "checklist-backed-identity", candidateId: r.to, via: `ruling:${r.rulingBy}:${r.date}`, verifiedAt: at } });
      }
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
  // CF-VERIFIED-IS-CHECKLIST-BACKED (Drew, 2026-08-30): a holding whose identity
  // is a checklist-backed catalog row is VERIFIED -- by Confirm, import, this
  // sweep, or a ruling. `patched` counts holdings written (a holding may be
  // corrected AND stamped; it is one write).
  let verifiedStamped = 0, patched = 0, cardIdAligned = 0;
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
        const variants = cardNumberVariants(num);
        const params = variants.map((v, i) => ({ name: `@n${i}`, value: v }));
        const { resources: rows } = await retry(() => cat.items.query({
          query: `SELECT c.id, c.sport, c.setKey, c.setName, c.cardNumber, c.parallel, c.parallelSlug, c.playerSlug, c.playerName, c.isAuto, c.source
                  FROM c WHERE c.year = @y AND c.cardNumber IN (${params.map((p) => p.name).join(",")}) AND NOT IS_DEFINED(c.gradeTier)`,
          parameters: [{ name: "@y", value: year }, ...params],
        }).fetchAll());

        // 2. player agreement (playerSlug, else playerName; a single trailing
        //    character only as a last resort -- see playerAgreement)
        const agreement = playerAgreement(rows, player);
        const mine = agreement.rows;
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
        for (const r of targets) if (setTexts.some((st) => setAgrees(st, r.setKey, r.setName, { parallel: h.parallel }))) {
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
        // CF-THE-NUMBER-SEGMENT-IS-THE-CATALOG-S (2026-08-30, D35). The
        // segment was composed from the HOLDING's raw cardNumber, so holding
        // b2ea5dac ("BBP 14") composed ...:bbp 14:... -- a slug with a space
        // in it, which matches no row and is not a legal id -- while the row
        // it had just fetched and player-agreed spells the number "BBP14".
        // Fixing the candidate query alone was not enough: the composed
        // identity has to be spelled the way the CATALOG spells it. Taken
        // from the matched rows (they all share one cardNumber by
        // construction: it is the IN list that selected them), falling back
        // to the holding's own spelling when the field is absent.
        const catalogNum = String(cardRows.find((r) => r.cardNumber)?.cardNumber ?? num);
        const resolved = `hiq:${sport}:${year}:${setKey}:${catalogNum.toLowerCase()}:${rung.seg}:${isAuto ? "auto" : "no-auto"}`;
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
        // The kept identity is then the target: the agreed branch below counts it
        // and the APPLY block can still stamp it VERIFIED.
        if (existing && numberedTwinsOf(target, [existing]).length === 1 && ids.includes(existing)) target = existing;
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

        // CF-ONE-IDENTITY-BOTH-FIELDS, the already-agreed case: hobbyiqCardId is right
        // but cardId still carries an older hiq: slug (Max Williams after the earlier
        // pass) — align it; a vendor cardId is left alone. Counted before the APPLY
        // gate so REPORT ONLY states it.
        const cidNow = String(h.cardId ?? "").trim();
        const alignCardId = existing === target && cidNow !== target && (!cidNow || cidNow.startsWith("hiq:"));
        if (alignCardId) cardIdAligned++;
        if (!APPLY) continue;
        const ops = [];
        if (alignCardId) ops.push({ op: "set", path: `/holdings/${hid}/cardId`, value: target });
        if ((existing !== target && (rung.conf >= 0.95 || !existing)) ) {
          ops.push({ op: "set", path: `/holdings/${hid}/hobbyiqCardId`, value: target });
          // CF-ONE-IDENTITY-BOTH-FIELDS (2026-08-30): legacy readers key on cardId; a
          // corrected hobbyiqCardId with a stale hiq: cardId is two identities on one
          // holding (Max Williams: hobbyiqCardId …:num-499, cardId the folded-away
          // un-numbered slug → no comps). A vendor cardId (non-hiq) is left alone.
          const cid = String(h.cardId ?? "").trim();
          if (!cid || cid.startsWith("hiq:")) ops.push({ op: "set", path: `/holdings/${hid}/cardId`, value: target });
        }
        if (h.cardsightCardId !== undefined && h.cardsightCardId !== null) { ops.push({ op: "set", path: `/holdings/${hid}/cardsightCardId`, value: null }); legacyCleared++; }
        if (ops.length) {
          ops.push({ op: "set", path: `/holdings/${hid}/identityResolvedBy`, value: "catalog-internal" });
          ops.push({ op: "set", path: `/holdings/${hid}/identityResolvedAt`, value: new Date().toISOString() });
        }
        // CF-VERIFIED-IS-CHECKLIST-BACKED: the identity this holding ends up on is
        // one of the checklist-authority rows (`ids`) -> VERIFIED, unless already.
        const finalId = ops.some((o) => o.path.endsWith("/hobbyiqCardId")) ? target : existing;
        if (finalId && ids.includes(finalId) && h.identityVerified !== true) {
          const at = new Date().toISOString();
          ops.push({ op: "set", path: `/holdings/${hid}/identityVerified`, value: true });
          ops.push({ op: "set", path: `/holdings/${hid}/identityVerifiedAt`, value: at });
          ops.push({ op: "set", path: `/holdings/${hid}/identityVerifiedBy`, value: { source: "checklist-backed-identity", candidateId: finalId, via: "conform-holdings-to-catalog", verifiedAt: at } });
          verifiedStamped++;
        }
        if (ops.length) {
          await retry(() => portfolio.item(doc.id, doc.userId).patch(ops.slice(0, 10)));
          patched++;
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
  console.log(`  verified stamped        ${f(verifiedStamped)}   <- identity is a checklist-backed row (Drew, 2026-08-30)`);
  console.log(`  cardId aligned          ${f(cardIdAligned)}   <- an older hiq: cardId brought to the agreed hobbyiqCardId`);
  console.log(`  holdings patched        ${f(patched)}`);
  if (APPLY) reportWrites({ job: "conform-holdings-to-catalog", intended: holdings, written: patched, skipped: holdings - patched - failed, failed });
  if (refusedEx.length) { console.log(`\n  refused:`); for (const e of refusedEx) console.log(`     ${e}`); }
  if (correctedEx.length) { console.log(`\n  corrections:`); for (const e of correctedEx) console.log(`     ${e}`); }
  if (unresolvedEx.length) { console.log(`\n  unresolved — the acquisition/ruling list:`); for (const e of unresolvedEx) console.log(`     ${e.slice(0, 110)}`); }
}

/** Pure: which catalog row a composed slug resolves to among the card's rows (the un-numbered row, else its ONE numbered twin, else nothing).
 *  CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30): the rule's HOME is
 *  backend/src/services/catalog/catalogIdentityResolver.ts (pickCatalogRow) —
 *  the readers and the holding writers use it. This is its CJS copy (a .cjs
 *  cannot import the TS module); tests/conformNeverAdoptsAVendorRow.test.ts
 *  pins both against ONE fixture table so they cannot drift. */
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
module.exports = { resolveRung, setAgrees, identityTargets, productChanged, setKeyOf, rowFor, numberedTwinsOf, cardNumberVariants, playerAgreement, fieldOps };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
