#!/usr/bin/env node
/**
 * fold-umbrella-to-series.cjs -- an umbrella is not a product.
 *
 * CF-THE-UMBRELLA-FOLDS-ONTO-ITS-SERIES (D39; Drew, 2026-08-31, ruling on
 * hockey): the 2024 Upper Deck umbrella sales fold onto their SERIES products
 * -- o-pee-chee, upper-deck-series-1, upper-deck-series-2,
 * upper-deck-extended-series, all four checklist-backed. "The card number +
 * title decide."
 *
 * THE DEFECT. D23 made the id carry the product, but the pool still holds rows
 * minted before it, keyed to the FAMILY. Measured 2026-08-31, read-only, on
 * `hiq:hockey:2024:upper-deck:`  -- 1,368 sold_comps rows, and the setKey FIELD
 * cannot fix them: 1,219 of the 1,368 spell it the literal string "upper-deck"
 * and 117 more "Upper Deck". The field is the umbrella too. Only the TITLE
 * knows which series the sale was:
 *
 *     none 919 | series-2 220 | extended 146 | series-1 79 | o-pee-chee 4
 *
 * so 449 rows carry evidence and 919 do not -- and the 919 are mostly not
 * series cards at all (Synergy, Credentials, MVP, Allure, Young Guns inserts,
 * every one its own product). This script moves the ones the title names and
 * COUNTS the rest. It never guesses.
 *
 * WHY THE TITLE ALONE IS NOT ENOUGH, AND THE CATALOG DECIDES. A card number is
 * not an identity by itself (CF-BECKETT-INITIALS-COLLIDE). Measured on the same
 * pass, hockey 2024 catalog rows holding cardNumber `10`: 27 different products.
 * `199`: 14. Worse, the sales titled "OPC Glossy" are NOT o-pee-chee -- their
 * `OPC-` numbers resolve to `upper-deck-series-2`, where the checklist actually
 * lists them (opc-34, opc-28, opc-30, opc-38 ... all series-2 rows from
 * checklistinsider). A title-only rule would have moved those four sales onto
 * the wrong product, which is the exact failure this fold exists to end. So the
 * ruling is applied as TWO gates, and a row moves only when both agree:
 *
 *   1. the TITLE names exactly one series product (two names -> AMBIGUOUS)
 *   2. the CATALOG holds that card number under that product, by point read of
 *      the target slug -- checklist authority preferred (canAdjudicate). No
 *      catalog row at the target -> AMBIGUOUS, left where it is and counted.
 *
 * A sale whose title says "Series 2" and whose number the series-2 checklist
 * does not list is not a series-2 sale; it stays under the umbrella as an
 * ACQUISITION signal, exactly as D28 parks a good number with no checklist row.
 *
 * THE MOVE IS SEGMENT SURGERY, NOT A RECOMPUTE (D28's rule). Only segment 3 --
 * the setKey -- is replaced; the number, parallel, auto flag and print run are
 * left exactly as the row spells them, so a parallel the resolver would spell
 * differently today cannot ride along on a product fold. Where a full recompute
 * would disagree it is counted (`slug recompute would differ`) and reported,
 * never applied.
 *
 * CF-A-SALE-IS-NEVER-LOST. Every move goes through
 * scripts/lib/relocate-sold-comp.cjs: upsert the new address, read it back,
 * then delete the old -- never the other order. A failed delete is a DUPLICATE
 * reported on its own line, never a lost sale. The pool's row count for the
 * scoped prefix is printed BEFORE and AFTER and reconciled:
 * after == before - deleted + created, or exit 4.
 *
 * SCOPE IS REQUIRED (CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME). SPORT, YEARS and
 * SETKEY have NO defaults: a whole-scope write must be asked for by name. An
 * empty one is FATAL before any Cosmos client is built.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   SPORT                     required, e.g. hockey        -- the scope
 *   YEARS                     required, e.g. 2024          -- the scope
 *   SETKEY                    required, e.g. upper-deck    -- the umbrella
 *   BACKFILL_APPLY=true       actually write (the runner exports BACKFILL_APPLY,
 *                             not APPLY). Default: REPORT ONLY.
 *   SLOT / SLOTS              sha1(cardId) shards
 *   CONCURRENCY=8  RUN_MINUTES=140 (budget marker)  LIMIT=0 (rows moved)
 * Requires dist/ (hobbyIqCardId, productSetKeys, catalogAuthority,
 * writeReconciliation).
 */
"use strict";
const path = require("path");
const crypto = require("crypto");

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const SPORT = String(process.env.SPORT || "").trim().toLowerCase();
const YEARS = String(process.env.YEARS || "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const SETKEY = String(process.env.SETKEY || "").trim().toLowerCase();
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
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809): the one exit path.
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const SHARD_SCOPE = runnerShardScope({ label: "fold-umbrella-to-series" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8));
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RUN_MS = RUN_MINUTES * 60000;
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top: a unit costing more than
 *  this is stopped BEFORE it starts. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 2 * 60 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const LIMIT = Number(process.env.LIMIT || 0);
const STARTED = Date.now();
const REASON = "the umbrella folds onto its series product; the card number + title decide (D39, CF-THE-UMBRELLA-FOLDS-ONTO-ITS-SERIES)";
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const str = (v) => String(v ?? "").trim();
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SLOTS;

// ── the ruling, as data ─────────────────────────────────────────────────────

/**
 * The series products an umbrella folds onto, and the title evidence that names
 * each. Drew's ruling for `upper-deck` is the hockey row; another umbrella gets
 * its own entry here rather than a new script.
 *
 * `test` matches the TITLE only -- the setKey field is the umbrella on 98% of
 * these rows (measured) and cannot narrow anything. Every pattern is anchored
 * on the product's own words: "Series 2" and "Extended Series" are different
 * products, and "O-Pee-Chee" is a different product from both.
 */
const UMBRELLA_FOLDS = {
  "upper-deck": [
    // O-Pee-Chee: the standalone product. Spelled with any separator the
    // sellers use ("O-Pee-Chee", "O Pee Chee", "OPee Chee") and as the bare
    // "OPC" abbreviation -- measured 2026-08-31, all four O-Pee-Chee-titled
    // hockey 2024 umbrella sales say "OPC", not the full name.
    //
    // This deliberately ALSO matches the "OPC Glossy" inserts, whose `OPC-`
    // numbers the checklist lists under upper-deck-series-2, not under
    // o-pee-chee. The title cannot tell those apart and this rule does not try:
    // gate 2 finds no o-pee-chee catalog row at the number and the sale stays
    // put, counted ambiguous. A title-only fold would have moved them onto the
    // wrong product.
    { setKey: "o-pee-chee", test: /\bo\s*-?\s*pee\s*-?\s*chee\b|\bopc\b/i },
    // "Series 1" / "Series One". `\b1\b` so "Series 10" cannot match.
    { setKey: "upper-deck-series-1", test: /\bseries\s*(?:1|one)\b/i },
    { setKey: "upper-deck-series-2", test: /\bseries\s*(?:2|two)\b/i },
    // Extended Series. Must be tried as its own product: it contains the word
    // "Series" and would otherwise be read as neither 1 nor 2.
    { setKey: "upper-deck-extended-series", test: /\bextended\s*series\b/i },
  ],
};

/** Every series product this umbrella can fold onto. */
function foldsFor(umbrella) {
  return UMBRELLA_FOLDS[String(umbrella ?? "").trim().toLowerCase()] ?? null;
}

/**
 * Which series product the TITLE names, or a reason it names none / too many.
 *   { ok: true, setKey }              exactly one product named
 *   { ok: false, reason: "no-title-evidence" | "ambiguous-title" }
 * Extended Series is decided FIRST and, when it matches, wins outright: its
 * text contains "Series" and the plain series rules must not both fire on it.
 */
function seriesFromTitle(title, folds) {
  const t = str(title);
  if (!t) return { ok: false, reason: "no-title-evidence" };
  const ext = folds.find((r) => r.setKey.endsWith("-extended-series"));
  if (ext && ext.test.test(t)) return { ok: true, setKey: ext.setKey, matched: [ext.setKey] };
  const hits = folds.filter((r) => r !== ext && r.test.test(t)).map((r) => r.setKey);
  if (hits.length === 0) return { ok: false, reason: "no-title-evidence" };
  if (hits.length > 1) return { ok: false, reason: "ambiguous-title", matched: hits };
  return { ok: true, setKey: hits[0], matched: hits };
}

/** hiq:sport:year:setKey:number:parallel:auto[:num-N] -> parts, else null. A
 *  graded child carries a tier segment and is not an identity row. */
function identityParts(id) {
  const parts = String(id ?? "").split(":");
  if (parts[0] !== "hiq" || (parts.length !== 7 && parts.length !== 8)) return null;
  if (parts.length === 8 && !parts[7].startsWith("num-")) return null;
  if (parts[6] !== "auto" && parts[6] !== "no-auto") return null;
  return parts;
}

/** Replace ONLY segment 3 (the setKey). Surgery, not a recompute -- everything
 *  else about the card is left exactly as the row already spells it. */
function withSetKeySegment(oldSlug, setKey) {
  const parts = identityParts(oldSlug);
  if (!parts) return null;
  parts[3] = setKey;
  return parts.join(":");
}

/** The rows this run owns. */
const mineByShard = (cardId) => SLOTS === 1 || shardOf(str(cardId)) === SLOT;

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  // ---- refusals, BEFORE any require of dist/ or any Cosmos client ----------
  // CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME: a scope with a default is a scope
  // nobody chose. All three halves of the scope are required.
  if (!SPORT) { console.error("FATAL: SPORT is required and has no default (e.g. SPORT=hockey)."); process.exit(1); }
  if (!YEARS.length) { console.error("FATAL: YEARS is required and has no default (e.g. YEARS=2024)."); process.exit(1); }
  if (!SETKEY) { console.error("FATAL: SETKEY is required and has no default -- the umbrella to fold (e.g. SETKEY=upper-deck)."); process.exit(1); }
  const folds = foldsFor(SETKEY);
  if (!folds) {
    console.error(`FATAL: no fold ruling for umbrella "${SETKEY}". Ruled umbrellas: ${Object.keys(UMBRELLA_FOLDS).join(", ")}.`);
    console.error("A fold is a ruling, not a guess: add the umbrella and its series products to UMBRELLA_FOLDS first.");
    process.exit(1);
  }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const backend = path.resolve(__dirname, "..");
  const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));

  const retry = async (fn, tries = 8) => {
    let wait = 500;
    for (let a = 0; ; a++) {
      try { return await fn(); }
      catch (e) {
        const msg = String(e?.message ?? e);
        if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|Request timed out/i.test(msg) || a >= tries) throw e;
        await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000);
      }
    }
  };

  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const pool = db.container("sold_comps");
  const cat = db.container("card_catalog");

  const prefixes = YEARS.map((y) => `hiq:${SPORT}:${y}:${SETKEY}:`);
  console.log(`fold-umbrella-to-series  ${APPLY ? "APPLY (moves sold_comps rows)" : "REPORT ONLY -- nothing written"}`);
  console.log(`  scope    sport=${SPORT}  years=${YEARS.join(",")}  umbrella=${SETKEY}`);
  console.log(`  folds    ${folds.map((r) => r.setKey).join(" | ")}`);
  console.log(`  slot ${SLOT}/${SLOTS}  concurrency ${CONCURRENCY}  budget ${RUN_MS / 60000}m${LIMIT ? `  LIMIT=${f(LIMIT)}` : ""}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  the ruling: the title must name ONE series product AND the catalog must hold that card number under it. Anything else stays put.\n`);

  // ---- before ------------------------------------------------------------
  const countScope = async () => {
    let n = 0;
    for (const p of prefixes) {
      const { resources } = await retry(() => pool.items.query({
        query: "SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.cardId, @p)",
        parameters: [{ name: "@p", value: p }],
      }).fetchAll());
      n += Number(resources?.[0] ?? 0);
    }
    return n;
  };
  const before = await countScope();
  console.log(`  pool before: ${f(before)} rows under ${prefixes.join(" , ")}`);

  const s = {
    scanned: 0, otherSlot: 0, notIdentityRow: 0,
    moved: 0, movedChecklist: 0, movedOther: 0,
    ambiguousNoTitle: 0, ambiguousTwoProducts: 0, ambiguousNoCatalogRow: 0,
    sameKey: 0, slugDrift: 0, collapsedOntoExisting: 0,
    failed: 0, duplicatesLeft: 0, notReached: 0, created: 0, deleted: 0,
  };
  const movedBy = new Map(), ambiguousBy = new Map(), examples = [], ambiguousExamples = [];
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  let stopReason = null;

  // The catalog answer for a target slug, memoised. `null` = the catalog holds
  // no row there, which is an AMBIGUOUS verdict, never a move.
  const targetCache = new Map();
  const catalogAt = async (slug) => {
    if (targetCache.has(slug)) return targetCache.get(slug);
    let row = null;
    try { row = (await retry(() => cat.item(slug, slug).read())).resource ?? null; }
    catch (e) { if (e?.code !== 404 && e?.statusCode !== 404) throw e; }
    targetCache.set(slug, row);
    return row;
  };

  /** One row. Every path lands on exactly one counter. */
  async function handle(row) {
    const oldSlug = str(row.cardId);
    const parts = identityParts(oldSlug);
    if (!parts) { s.notIdentityRow++; return; }

    // GATE 1 -- the title names the product.
    const named = seriesFromTitle(row.title, folds);
    if (!named.ok) {
      if (named.reason === "ambiguous-title") {
        s.ambiguousTwoProducts++; bump(ambiguousBy, `ambiguous-title (${(named.matched ?? []).join("+")})`);
        if (ambiguousExamples.length < 8) ambiguousExamples.push(`  AMBIGUOUS two products named  ${str(row.cardNumber) || "(no number)"}  ${str(row.title).slice(0, 96)}`);
      } else {
        s.ambiguousNoTitle++; bump(ambiguousBy, "no-title-evidence");
      }
      return;
    }
    if (named.setKey === parts[3]) { s.sameKey++; return; }

    const target = withSetKeySegment(oldSlug, named.setKey);
    if (!target || target === oldSlug) { s.sameKey++; return; }

    // GATE 2 -- the catalog holds this card number under that product. A title
    // that says "Series 2" over a number the series-2 checklist does not list
    // is not evidence enough to move a sale (the OPC-Glossy case).
    const catRow = await catalogAt(target);
    if (!catRow) {
      s.ambiguousNoCatalogRow++;
      bump(ambiguousBy, `no-catalog-row-at-target (${named.setKey})`);
      if (ambiguousExamples.length < 8) ambiguousExamples.push(`  AMBIGUOUS no catalog row  ${target}\n              ${str(row.title).slice(0, 96)}`);
      return;
    }
    const authority = catalogAuthorityOf(catRow.source);

    // Reported, never applied: what a FULL recompute would have said. The move
    // itself replaces only the setKey segment (D28's rule).
    try {
      const round = computeHobbyIqCardId({
        sport: SPORT, year: Number(parts[2]), setKey: named.setKey,
        cardNumber: str(row.cardNumber), parallel: row.parallel ?? null,
        isAuto: row.isAuto === true, printRun: row.printRun ?? null,
        playerName: row.playerName ?? null, authoritativeSetKey: true,
      });
      if (round && round !== target) s.slugDrift++;
    } catch { /* a recompute that throws is not a reason to refuse a surgery */ }

    const keep = stripSystem(row);
    keep.cardId = target;
    keep.hobbyiqCardId = target;
    keep.setKey = named.setKey;
    keep.normalizedSetKey = named.setKey;
    keep.umbrellaSetKeyWas = parts[3];
    keep.foldedFromUmbrellaAt = new Date().toISOString();
    keep.foldedFromUmbrellaReason = REASON;
    keep.contentHash = contentHashOf(keep);

    if (examples.length < 12) {
      examples.push(`  FOLD ${parts[3]} -> ${named.setKey}  [${authority}]  #${str(row.cardNumber) || "?"}\n       ${oldSlug}\n    -> ${target}\n       ${str(row.title).slice(0, 100)}`);
    }

    const res = await relocateSoldComp(pool, {
      keep,
      drop: [{ id: row.id, cardId: row.cardId }],
      retry,
      verifyFields: ["foldedFromUmbrellaAt", "hobbyiqCardId", "setKey"],
      dryRun: !APPLY,
    });
    if (!res.ok && res.stage !== "done") {
      s.failed++;
      console.log(`  FAILED at ${res.stage}: ${row.id} @ ${row.cardId} -> ${target}: ${String(res.error).slice(0, 120)}`);
      return;
    }
    if (res.duplicatesLeft.length) {
      s.failed++; s.duplicatesLeft += res.duplicatesLeft.length;
      for (const d of res.duplicatesLeft) console.log(`  DUPLICATE LEFT ${d.id}@${d.cardId}: ${String(d.error).slice(0, 90)}`);
      return;
    }
    if (!APPLY) { s.created += 1; s.deleted += 1; }
    else { s.created += res.existedBefore ? 0 : 1; s.deleted += res.deleted.length; if (res.existedBefore) s.collapsedOntoExisting++; }
    s.moved++;
    if (authority === "checklist") s.movedChecklist++; else s.movedOther++;
    bump(movedBy, `${named.setKey} [${authority}]`);
  }

  // ---- the scan ----------------------------------------------------------
  for (const p of prefixes) {
    if (stopReason) break;
    console.log(`\n-- scanning ${p}`);
    let token, seen = 0;
    do {
      const page = await retry(() => pool.items.query({
        // SELECT * and not a projection: the row read here is the document
        // UPSERT-ed at the new address, so a projection would silently drop
        // every field it left out. A re-key must carry the whole row.
        query: "SELECT * FROM c WHERE STARTSWITH(c.cardId, @p)",
        parameters: [{ name: "@p", value: p }],
      }, { maxItemCount: 400, continuationToken: token }).fetchNext());
      token = page.continuationToken;
      const mine = (page.resources ?? []).filter((r) => { if (mineByShard(r.cardId)) return true; s.otherSlot++; return false; });
      for (let i = 0; i < mine.length; i += CONCURRENCY) {
        const batch = mine.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (row) => {
          s.scanned++; seen++;
          try { await handle(row); }
          catch (e) { s.failed++; if (s.failed <= 8) console.log(`  FAILED ${row.id}: ${String(e?.message ?? e).slice(0, 120)}`); }
        }));
        if (LIMIT && s.moved >= LIMIT) { stopReason = "limit"; s.notReached += Math.max(0, mine.length - (i + batch.length)); break; }
        if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; s.notReached += Math.max(0, mine.length - (i + batch.length)); break; }
      }
    } while (token && !stopReason);
    console.log(`   scanned under this prefix: ${f(seen)}`);
  }

  if (examples.length) { console.log(`\nexamples (folded):`); for (const e of examples) console.log(e); }
  if (ambiguousExamples.length) { console.log(`\nexamples (left where they are):`); for (const e of ambiguousExamples) console.log(e); }

  // CF-RELAUNCH-ONLY-ON-BUDGET: this exact line is what the runner greps.
  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);

  const ambiguous = s.ambiguousNoTitle + s.ambiguousTwoProducts + s.ambiguousNoCatalogRow;
  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  rows scanned (this slot)   ${f(s.scanned)}   (+${f(s.otherSlot)} belonging to other slots)`);
  console.log(`  ${APPLY ? "FOLDED" : "WOULD FOLD"}                 ${f(s.moved)}   <- title named the product AND the catalog holds the number there`);
  console.log(`    onto a checklist row      ${f(s.movedChecklist)}`);
  console.log(`    onto a vendor/derived row ${f(s.movedOther)}`);
  console.log(`  AMBIGUOUS (left in place)  ${f(ambiguous)}   <- the sub-totals below, which sum to it`);
  console.log(`    no title evidence         ${f(s.ambiguousNoTitle)}   <- the title names no series product`);
  console.log(`    two products named        ${f(s.ambiguousTwoProducts)}   <- the title names more than one`);
  console.log(`    no catalog row at target  ${f(s.ambiguousNoCatalogRow)}   <- an ACQUISITION list: the title is good, the checklist is missing`);
  console.log(`  already the series key     ${f(s.sameKey)}`);
  console.log(`  not an identity row        ${f(s.notIdentityRow)}`);
  console.log(`  failed                     ${f(s.failed)}   (${f(s.duplicatesLeft)} duplicates left in the pool)`);
  console.log(`  not reached                ${f(s.notReached)}`);
  console.log(`  collapsed onto an existing row at the target  ${f(s.collapsedOntoExisting)}`);
  console.log(`  slug recompute would differ ${f(s.slugDrift)}   <- reported only; only the setKey segment is replaced`);
  if (movedBy.size) { console.log(`\n  folded by destination:`); for (const [k, n] of [...movedBy].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(44)} ${f(n).padStart(8)}`); }
  if (ambiguousBy.size) { console.log(`\n  ambiguous by reason:`); for (const [k, n] of [...ambiguousBy].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(44)} ${f(n).padStart(8)}`); }

  // ---- CF-A-SALE-IS-NEVER-LOST -------------------------------------------
  const after = await countScope();
  // A fold moves a row OUT of the scoped prefix, so the scope's own count falls
  // by exactly the rows deleted; nothing is created inside it.
  const expected = before - s.deleted;
  console.log(`\nCF-A-SALE-IS-NEVER-LOST`);
  console.log(`  scope before  ${f(before)}`);
  console.log(`  scope after   ${f(after)}`);
  console.log(`  ${APPLY ? "expected" : "would be"}      ${f(expected)}   = before - folded-out ${f(s.deleted)}  (created at the series slugs: ${f(s.created)})`);
  if (APPLY && after !== expected) {
    console.error(`!! CF-A-SALE-IS-NEVER-LOST: after ${f(after)} != expected ${f(expected)} (drift ${after - expected}). A sale is unaccounted for. Exit 4.`);
    process.exitCode = 4;
  } else console.log(`  ${APPLY ? "matched" : "report only -- no change made"}`);

  if (APPLY) {
    // CF-A-SLICE-IS-NOT-A-SIBLING-COUNTER: `notReached` rows were never scanned,
    // so they are NOT in `scanned`. What this run took responsibility for is
    // what it scanned PLUS what it was holding and did not reach.
    reportWrites({
      job: "fold-umbrella-to-series",
      intended: s.scanned + s.notReached,
      written: s.moved,
      skipped: ambiguous + s.sameKey + s.notIdentityRow + s.notReached,
      failed: s.failed,
    });
  }
}

module.exports = { UMBRELLA_FOLDS, foldsFor, seriesFromTitle, identityParts, withSetKeySegment };

if (require.main === module) {
  // CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
main()
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => { console.error("FATAL:", e?.stack || e?.message); 
    await finishLane(3);
  });
}
