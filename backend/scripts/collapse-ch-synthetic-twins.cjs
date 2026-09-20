#!/usr/bin/env node
/**
 * collapse-ch-synthetic-twins.cjs -- one CardHedge sale, one pool row (the
 * SYNTHETIC-id half of D19, not the ch-daily/ch-comp half collapse-ch-dual-
 * ids.cjs already resolves).
 *
 * THE DEFECT (fixed going forward by PR #2357, merged 2026-09-20; this lane
 * is the sweep of what #2357 left behind). Until #2357,
 * backfill-sold-comps-from-ch.cjs minted every CardHedge daily sale under a
 * SYNTHETIC id --
 *
 *   ch-daily::<chCardId>::<soldAt>::<priceCents>
 *
 * -- instead of CardHedge's own vendor sale id (`price_history_id`), the
 * shape every OTHER writer uses (chRowToSoldComp.ts via recordSoldComp, and
 * bulk-import-ch-daily-to-sold-comps.cjs via recordSoldComp; both produce
 * `sourceExternalId = ch-daily::<price_history_id>`, doc
 * `id = cardhedge::<sourceExternalId>` -- see scripts/lib/chSoldCompId.cjs).
 * Same sale, two ids, ONE partition (sold_comps partitions on /cardId, and
 * both shapes carry the same CardHedge card id as `cardId`): 35% of sampled
 * September rows carried a twin.
 *
 * The FMV read path (exactPoolReader's dedupeSoldComps) already collapses
 * same-grade twins AT READ TIME, so pricing has not been double-counting
 * these. Six other readers and every census DO double-count them: they read
 * sold_comps directly (row counts, coverage audits, the pricing-invariant
 * corpus, anything that does not go through dedupeSoldComps) and see the
 * same sale as two rows.
 *
 * This is a REPORT-FIRST sweep. A delete needs the owner's go, so REPORT is
 * built to be fully informative (a full NDJSON plan, not just a capped
 * banner -- see PLAN_OUT below) and APPLY is conservative: nothing collapses
 * unless the twin is PROVEN, nothing pinned/flagged/verified is ever
 * touched, and a disagreement in identity is reported, never guessed past.
 *
 * THE PROOF PREDICATE. A LONG (synthetic-shape) row and a SHORT (canonical)
 * row in the SAME cardId partition are a proven twin only when ALL of:
 *
 *   1. the long id's embedded <chCardId> equals the short row's own `cardId`
 *      (both rows live in the same partition by construction of the SELECT
 *      below, so this is really "the long id's embedded chCardId parses and
 *      matches the partition it is filed under" -- a defensive check against
 *      a malformed/relocated long id masquerading in the wrong partition).
 *   2. the long id's embedded <soldAt> denotes the SAME INSTANT as the short
 *      row's `soldAt` -- compared as parsed Date instants, not strings, so
 *      `2026-07-03T01:19:00+00:00`, `2026-07-03T01:19:00Z` and
 *      `2026-07-03T01:19:00.000Z` all agree. When the long id's own soldAt
 *      segment is DATE-ONLY (`YYYY-MM-DD`, no time component -- a shape some
 *      early synthetic ids carry), instant comparison is impossible; the
 *      pair is accepted ONLY when it is the UNIQUE (day, price) match on
 *      BOTH sides within the partition (see AMBIGUOUS-MULTI-SALE-DAY below).
 *   3. the long id's embedded <priceCents> equals the short row's own
 *      `price`, compared in cents (Math.round(price * 100)) to avoid a
 *      float-equality footgun.
 *
 * Several real sales of a common card at the SAME price on the SAME day
 * (many $1.99 raw copies, the measured shape) MUST NOT collapse -- proof #2
 * above already refuses them when both sides carry distinguishable instants,
 * and when they do not (date-only ids, or several long rows landing on one
 * day+price cell) the pair is left `ambiguous-multi-sale-day`, never
 * guessed.
 *
 * KEEP RULE. The SHORT canonical row is always kept -- it is what every
 * OTHER writer already produces, and it is the row future backfill runs
 * will re-derive if this row is ever lost. Before deleting the long row,
 * any repair-lane state present ONLY on the long row is carried onto the
 * kept row via `foldMissing` (never overwrites a value the short row already
 * has): `hobbyiqCardId` (a re-point that DIFFERS is instead a
 * `twins-disagree` refusal, see below -- carried here only when the short
 * row lacks one entirely), `rekeyedAt`/`rekeyedFrom`, `splitResolved`, the
 * five park stamps (`identityUnverified`, `identityUnverifiedAt`,
 * `identityUnverifiedBy`, `identityUnverifiedReason`,
 * `identityUnverifiedDetail`), `flaggedWrong`, `excludedFromFmv`,
 * `verifiedByUser`, `gradeCompany`, `gradeValue`, `gradeQualifier`.
 *
 * IDENTITY DISAGREEMENT REFUSES, NEVER GUESSES. When both rows carry a
 * `hobbyiqCardId` and they DIFFER, or both carry a grade
 * (gradeCompany/gradeValue) and it differs, this is evidence about which
 * writer derives the card better -- not something to resolve by richness or
 * length the way collapse-ch-dual-ids.cjs does for its own (different) pair
 * shape. Reported `twins-disagree`, both values named, never collapsed.
 *
 * NEVER TOUCHED: any row (long OR short) carrying `verifiedByUser === true`,
 * `flaggedWrong === true`, `excludedFromFmv === true`, or a `pinned` stamp --
 * a human claim outranks a synthetic-id cleanup. Named `protected`, counted,
 * left alone.
 *
 * LONG-ONLY (no short twin in ANY partition -- the sale may have been
 * relocated by a repair lane, or the daily backfill wrote it before a
 * canonical writer ever saw this card). This lane is a SAME-PARTITION sweep
 * by construction (see SELECTION below): it does not search other
 * partitions for a stray short twin, so a long row with no short sibling
 * resident in ITS OWN partition is counted `long-only` and left alone --
 * exactly the residual gap #2357's own header already names (a long row can
 * be re-created at a stale address a relocation moved away from). Resolving
 * that is a different lane's job (a cross-partition search), not this one's.
 *
 * Deletes use the plan-time `_etag` as an `IfMatch` precondition, via
 * relocate-sold-comp.cjs's existing `ifMatchEtag` drop option -- the same
 * conditional-delete mechanism resolve-split-identity-parks.cjs uses, so a
 * document that changed between this run's plan read and its delete refuses
 * the delete (412) rather than destroying a row a concurrent writer just
 * touched.
 *
 * SHARD/BUDGET/RELAUNCH/RECONCILE: identical machinery to
 * collapse-ch-dual-ids.cjs -- runner-shard-scope.cjs (opt-in sharding via a
 * non-zero SLOT or SHARD=true), runner-budget.cjs's finishLane, and the
 * SAME `stopped at the ${RUN_MINUTES}-minute budget` marker the runner's
 * relaunch step greps (CF-RELAUNCH-ONLY-ON-BUDGET, #1361). Walked by
 * partition (the CH card id), one partition read at a time, bounded pages
 * (maxItemCount 500, never -1) -- never a cross-partition aggregate.
 *
 * PLAN_OUT (full auditability -- copied from resolve-split-identity-parks.cjs's
 * own mechanism, same reasoning: a REPORT that only ever lives in a capped
 * banner cannot be audited row by row before a matching APPLY runs). When
 * PLAN_OUT names a directory (the runner sets it to a FIXED path, guarded on
 * script name -- no new workflow_dispatch input), this run writes ONE NDJSON
 * record per proven-pair/ambiguous/disagreement/protected/long-only row to
 * `${PLAN_OUT}/plan-slot-${SLOT}.ndjson`, truncated at open (each run's own
 * selection is disjoint from a prior run's, same as that lane).
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true / APPLY=true to write
 *      (default report only); SLOT/SLOTS (sha1(cardId) shards, opt-in via a
 *      non-zero SLOT or SHARD=true for slot 0 of a real fan-out --
 *      runner-shard-scope.cjs); RUN_MINUTES=120; RESERVE_MS=90000;
 *      VERIFY_MS=600000; LIMIT (CH partitions scanned; 0 = all); PLAN_OUT
 *      (NDJSON directory, set by the runner, not an operator input).
 * Requires dist/ (reportWrites, splitIdentityWriteGuard via relocate-sold-
 *      comp.cjs's own lazy dist load).
 */
"use strict";
const path = require("path");
const fs = require("node:fs");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const { relocateSoldComp, stripSystem, isMissing, cents, foldMissing } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));

const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true"; // the runner exports BACKFILL_APPLY, not APPLY
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const SHARD_SCOPE = runnerShardScope({ label: "collapse-ch-synthetic-twins" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
/** Wall clock a single unit (one CH partition) may still be granted after
 *  the budget expires. CHECKED BEFORE EACH UNIT, never at the loop top. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
/** No unbounded post-loop aggregate in this lane (every count is accumulated
 *  during the per-partition walk), so VERIFY_MS governs nothing today -- kept
 *  for symmetry with every other budgeted lane's three-constant vocabulary. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const LIMIT = Number(process.env.LIMIT || 0);
const PLAN_OUT = String(process.env.PLAN_OUT || "").trim();
const f = (n) => Number(n ?? 0).toLocaleString();
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SLOTS;
const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };

// ── pure ───────────────────────────────────────────────────────────────────

/** The LEGACY SYNTHETIC id shape backfill-sold-comps-from-ch.cjs wrote before
 *  #2357: `cardhedge::ch-daily::<chCardId>::<soldAt>::<priceCents>` -- a
 *  FIVE-segment tail after `cardhedge::`, versus the canonical
 *  `cardhedge::ch-daily::<price_history_id>` (a single opaque token after the
 *  second `::`). Distinguished by segment count, not by a soldAt substring
 *  match (chSoldCompId.cjs's own `isLongSyntheticShape` needs a soldAt to
 *  compare against; this lane needs to recognise the shape FIRST, before it
 *  knows which row is its candidate short partner, so it parses structurally
 *  instead). Returns the parsed { chCardId, soldAt, cents } or null when the
 *  id is not this shape. */
function parseLongSyntheticId(id) {
  const s = String(id ?? "");
  const prefix = "cardhedge::ch-daily::";
  if (!s.startsWith(prefix)) return null;
  const tail = s.slice(prefix.length);
  const parts = tail.split("::");
  if (parts.length !== 3) return null;
  const [chCardId, soldAt, centsStr] = parts;
  if (!chCardId || !soldAt) return null;
  const priceCents = Number(centsStr);
  if (!Number.isFinite(priceCents)) return null;
  return { chCardId, soldAt, priceCents };
}

/** The CANONICAL id shape: `cardhedge::ch-daily::<price_history_id>` -- an
 *  opaque vendor token with no embedded `::`. True for any row that is
 *  CardHedge-daily-sourced and is NOT the long synthetic shape -- i.e. every
 *  row this lane should consider as a possible KEEP target. Deliberately
 *  permissive about the token's own shape (CardHedge's price_history_id is
 *  opaque; this lane must not invent a format for it), so it is defined as
 *  "starts with the daily prefix, parses to exactly one segment after it". */
function isCanonicalChDailyId(id) {
  const s = String(id ?? "");
  const prefix = "cardhedge::ch-daily::";
  if (!s.startsWith(prefix)) return false;
  const tail = s.slice(prefix.length);
  return tail.length > 0 && !tail.includes("::");
}

/** Parses an ISO-ish timestamp into epoch ms, or null when it will not
 *  parse, or when it is DATE-ONLY (`YYYY-MM-DD`, ten characters, no time
 *  component) -- callers need to know "date-only" as a DISTINCT outcome from
 *  "unparseable", because a date-only long id is handled by the
 *  unique-on-the-day fallback rather than refused outright. */
function parseInstant(iso) {
  const s = String(iso ?? "").trim();
  if (!s) return { ok: false, dateOnly: false };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: false, dateOnly: true, day: s };
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return { ok: false, dateOnly: false };
  return { ok: true, ms, day: new Date(ms).toISOString().slice(0, 10) };
}

/** The day (YYYY-MM-DD) a soldAt value denotes, regardless of shape -- used
 *  for the date-only uniqueness fallback and for the ambiguous-day grouping
 *  key. Never throws: an unparseable value maps to the empty string, which
 *  groups with nothing else. */
function dayOf(iso) {
  const s = String(iso ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
}

/** Two soldAt values denote the SAME INSTANT -- comparing PARSED instants,
 *  never raw strings, so `+00:00`, `Z` and `.000Z` all agree. Returns false
 *  (never true) when either side is unparseable or date-only: callers branch
 *  to the date-only path themselves rather than have this silently degrade. */
function sameInstant(a, b) {
  const pa = parseInstant(a), pb = parseInstant(b);
  return pa.ok && pb.ok && pa.ms === pb.ms;
}

/** Repair-lane state carried from the dropped LONG row onto the kept SHORT
 *  row, but ONLY the fields the short row itself lacks (`foldMissing` never
 *  overwrites a value the keeper already has). `hobbyiqCardId` is included
 *  here for the case the short row has NONE at all; a short row that HAS one
 *  and disagrees with the long row's is handled upstream by the
 *  `twins-disagree` refusal and never reaches this fold. */
const CARRY_FIELDS = [
  "hobbyiqCardId", "rekeyedAt", "rekeyedFrom", "splitResolved",
  "identityUnverified", "identityUnverifiedAt", "identityUnverifiedBy", "identityUnverifiedReason", "identityUnverifiedDetail",
  "flaggedWrong", "excludedFromFmv", "verifiedByUser",
  "gradeCompany", "gradeValue", "gradeQualifier",
];
const REASON = "CF-CH-DAILY-DOUBLE-WRITE: the same CH sale under a synthetic id and CardHedge's own vendor sale id (#2357 follow-up sweep)";

/** Never touched, in EITHER direction -- a human claim (or a park a human
 *  triage step is mid-review on) outranks a synthetic-id cleanup. Mirrors the
 *  same three flags every other D19-family lane refuses to override. */
function isProtected(doc) {
  return doc?.verifiedByUser === true || doc?.flaggedWrong === true || doc?.excludedFromFmv === true || doc?.pinned === true;
}

/** grade identity as a comparable key; RAW (no company, no value) is a grade
 *  too, per D19's own gradeKey convention -- two rows whose gradeKey differs
 *  are two sales, not a formatting difference. */
const gradeKeyOf = (r) => `${String(r?.gradeCompany ?? "raw").toUpperCase()}|${r?.gradeValue ?? 0}`;

/**
 * ONE (long, short) candidate pair -> a verdict. Pure, no I/O. `heldSlugs`
 * is unused today (kept as an options bag so a future richness tiebreak can
 * be added without changing the call signature) -- there is no tiebreak
 * here: the SHORT row always wins when the pair proves out, and a
 * disagreement always refuses rather than picking a side.
 *
 * @returns {{verdict: "collapse", keep: object, drop: {id,cardId}, folded: string[]}
 *          | {verdict: "ambiguous-multi-sale-day"}
 *          | {verdict: "twins-disagree", axis: string, longValue: unknown, shortValue: unknown}
 *          | {verdict: "not-a-match"}}
 */
function decideSyntheticTwin(long, short, { now = new Date().toISOString(), dayCounts = null, longDayCounts = null } = {}) {
  const parsedId = parseLongSyntheticId(long.id);
  if (!parsedId) return { verdict: "not-a-match" };

  // Proof #1: the long id's embedded chCardId names the partition both rows
  // are read from (this lane's own SELECT already pins both to the same
  // c.cardId, so this is a defensive re-check against a malformed id).
  if (String(parsedId.chCardId) !== String(short.cardId ?? long.cardId ?? "")) return { verdict: "not-a-match" };

  // Proof #3: price in cents.
  const longCents = Number.isFinite(parsedId.priceCents) ? Math.round(parsedId.priceCents) : NaN;
  const shortCents = cents(short.price);
  if (!Number.isFinite(longCents) || longCents !== shortCents) return { verdict: "not-a-match" };

  // Proof #2: soldAt. Prefer instant equality; fall back to the date-only
  // unique-on-the-day rule when the long id's own soldAt segment carries no
  // time component.
  const longParsed = parseInstant(parsedId.soldAt);
  let dateOnlyPath = false;
  if (longParsed.ok) {
    if (!sameInstant(parsedId.soldAt, short.soldAt)) return { verdict: "not-a-match" };
  } else if (longParsed.dateOnly) {
    dateOnlyPath = true;
    if (dayOf(short.soldAt) !== longParsed.day) return { verdict: "not-a-match" };
    // Several real sales of this card at this price on this day must not
    // collapse on a guess: the date-only fallback needs UNIQUENESS on
    // (day, price) within the partition, on BOTH SIDES -- the short rows
    // AND the long rows -- before it will treat the pair as proven. Checking
    // only one side would let two genuinely distinct long rows (two separate
    // $1.99 raw sales, each with its own long id, same day+price) both match
    // the SAME single short row's uniqueness count and each get "proven"
    // against it, which is exactly the double-count this lane exists to
    // remove, not reintroduce from the other direction.
    const key = `${longParsed.day}|${longCents}`;
    const shortCount = dayCounts ? dayCounts.get(key) ?? 0 : 1;
    const longCount = longDayCounts ? longDayCounts.get(key) ?? 0 : 1;
    if (shortCount !== 1 || longCount !== 1) return { verdict: "ambiguous-multi-sale-day" };
  } else {
    return { verdict: "not-a-match" };
  }

  // Identity disagreement refuses -- never guessed past, regardless of the
  // date-only path taken above.
  if (!isMissing(long.hobbyiqCardId) && !isMissing(short.hobbyiqCardId) && String(long.hobbyiqCardId) !== String(short.hobbyiqCardId)) {
    return { verdict: "twins-disagree", axis: "hobbyiqCardId", longValue: long.hobbyiqCardId, shortValue: short.hobbyiqCardId };
  }
  if (gradeKeyOf(long) !== gradeKeyOf(short)) {
    return { verdict: "twins-disagree", axis: "grade", longValue: gradeKeyOf(long), shortValue: gradeKeyOf(short) };
  }

  const keep = stripSystem(short);
  const folded = foldMissing(keep, [long], CARRY_FIELDS);
  keep.collapsedFrom = { id: long.id, cardId: long.cardId, sourceExternalId: long.sourceExternalId ?? null, title: long.title ?? null, soldAt: long.soldAt ?? null };
  keep.collapsedAt = now;
  keep.collapsedReason = REASON;
  return { verdict: "collapse", keep, drop: { id: long.id, cardId: long.cardId }, folded, dateOnlyPath };
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const { reportWrites } = require(path.join(path.resolve(__dirname, ".."), "dist", "services", "ops", "writeReconciliation.js"));
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const pool = db.container("sold_comps");
  console.log(`collapse-ch-synthetic-twins  ${APPLY ? "APPLY" : "REPORT ONLY"}  slot ${SLOT}/${SLOTS}  budget ${RUN_MINUTES}m  limit ${LIMIT || "none"} partitions`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  let planFd = null;
  if (PLAN_OUT) {
    try {
      fs.mkdirSync(PLAN_OUT, { recursive: true });
      const planPath = path.join(PLAN_OUT, `plan-slot-${SLOT}.ndjson`);
      planFd = fs.openSync(planPath, "w"); // truncate: each run's own selection, not an append log
      console.log(`  plan file         ${planPath}`);
    } catch (e) {
      console.log(`\n::warning::could not open PLAN_OUT (${PLAN_OUT}): ${e?.message}`);
      planFd = null;
    }
  }
  function emitPlanRow(action, reason, long, short, extra = {}) {
    if (!planFd) return;
    const record = {
      action, reason,
      longId: long?.id ?? null, longSource: long?.source ?? null, longTitle: long?.title ?? null, longSoldAt: long?.soldAt ?? null,
      shortId: short?.id ?? null, shortSource: short?.source ?? null, shortTitle: short?.title ?? null, shortSoldAt: short?.soldAt ?? null,
      cardId: long?.cardId ?? short?.cardId ?? null,
      price: long?.price ?? short?.price ?? null,
      ...extra,
    };
    try { fs.appendFileSync(planFd, JSON.stringify(record) + "\n"); }
    catch (e) { console.log(`\n::warning::PLAN_OUT write failed for ${long?.id}: ${e?.message}`); }
  }

  // The population: every CH card id that carries at least one long
  // (synthetic-shape) sourceExternalId. Distinct id-prefix scan, no
  // cross-partition aggregate other than this one DISTINCT VALUE walk, which
  // is the same shape collapse-ch-dual-ids.cjs already runs to find ITS
  // population (ch-comp:: rows) -- bounded pages, continuation-token driven.
  const cards = [];
  {
    // Pre-filter with RegexMatch (used elsewhere in this codebase for the
    // same purpose, e.g. rename-setkey-to-product.cjs) rather than STARTSWITH
    // alone: the canonical shape (`cardhedge::ch-daily::<opaque-token>`) also
    // starts with the same prefix, so the population query needs to see at
    // least one MORE literal `::` after the prefix before it counts a card
    // as "carries a long-shaped row". Deliberately LOOSE (a lookahead-free
    // pattern -- Cosmos's regex engine is not guaranteed to support one, and
    // this query cannot be exercised against live Cosmos from this branch):
    // `.*::` after the prefix over-matches (it would also match a canonical
    // id if one ever grew a `::` inside its own opaque token, which
    // CardHedge's price_history_id never has in every sampled row) rather
    // than under-matches, and `parseLongSyntheticId` below is the PRECISE
    // parse every candidate row is actually judged against -- this regex
    // only shrinks which partitions get read, it never decides a verdict.
    const it = pool.items.query({ query: `SELECT DISTINCT VALUE c.cardId FROM c WHERE c.source = 'cardhedge' AND RegexMatch(c.id, "^cardhedge::ch-daily::.*::.*::[0-9]+$")` }, { maxItemCount: 500 });
    while (it.hasMoreResults()) { const { resources } = await retry(() => it.fetchNext()); for (const id of resources ?? []) if (id) cards.push(String(id)); }
  }
  console.log(`  ${f(cards.length)} CH cards carry a long-id-shaped row (regex pre-filter; parsed precisely per row below)`);

  const stats = {
    partitions: 0, otherShard: 0, rowsRead: 0, longRows: 0, longOnly: 0,
    provenPairs: 0, ambiguousMultiSaleDay: 0, twinsDisagree: 0, protected: 0, notAMatch: 0,
    collapsed: 0, failed: 0, duplicatesLeft: 0, staleSincePlan: 0, alreadyGone: 0, notReached: 0,
  };
  const disagreeBy = new Map();
  const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
  const examples = [];
  let stopReason = null, i = 0;

  for (const cardId of cards) {
    if (LIMIT && stats.partitions >= LIMIT) { stats.notReached += cards.length - i; break; }
    if (budgetLeft() < RESERVE_MS) { stopReason = `stopped at the ${RUN_MINUTES}-minute budget`; stats.notReached += cards.length - i; break; }
    i++;
    if (SLOTS > 1 && shardOf(cardId) !== SLOT) { stats.otherShard++; continue; }
    stats.partitions++;

    const rows = [];
    const it = pool.items.query({ query: "SELECT * FROM c WHERE c.cardId = @id AND c.source = 'cardhedge'", parameters: [{ name: "@id", value: cardId }] }, { partitionKey: cardId, maxItemCount: 500 });
    while (it.hasMoreResults()) { const { resources } = await retry(() => it.fetchNext()); for (const r of resources ?? []) rows.push(r); }
    stats.rowsRead += rows.length;

    const longRows = rows.filter((r) => parseLongSyntheticId(r.id));
    const shortRows = rows.filter((r) => isCanonicalChDailyId(r.id));
    stats.longRows += longRows.length;
    if (!longRows.length) continue; // nothing for this lane in this partition

    if (!shortRows.length) {
      // Every long row here is long-only WITHIN this partition -- a resident
      // short twin may still live in ANOTHER partition (relocated); out of
      // scope for this same-partition lane, counted separately.
      stats.longOnly += longRows.length;
      for (const long of longRows) emitPlanRow("long-only", "no-short-twin-in-partition", long, null);
      continue;
    }

    // Date-only uniqueness needs a (day, price) count across the SHORT rows
    // AND across the LONG rows in this partition -- both sides, per the
    // ambiguous-multi-sale-day rule above -- computed once per partition
    // rather than per pair. Long rows are counted by their OWN embedded
    // (day, priceCents), which may differ from any single short row's
    // soldAt/price if the long id itself is malformed; a long row that does
    // not parse contributes no count (it is not a date-only candidate).
    const dayCounts = new Map();
    for (const s of shortRows) {
      const d = dayOf(s.soldAt);
      if (!d) continue;
      const key = `${d}|${cents(s.price)}`;
      bump(dayCounts, key);
    }
    const longDayCounts = new Map();
    for (const l of longRows) {
      const parsed = parseLongSyntheticId(l.id);
      if (!parsed) continue;
      const p = parseInstant(parsed.soldAt);
      if (!p.dateOnly) continue; // only date-only long ids use this map
      const c = Math.round(Number(parsed.priceCents));
      if (!Number.isFinite(c)) continue;
      bump(longDayCounts, `${p.day}|${c}`);
    }

    for (const long of longRows) {
      if (isProtected(long)) { stats.protected++; emitPlanRow("protected", "long-row-pinned-or-flagged", long, null); continue; }

      const parsedId = parseLongSyntheticId(long.id);
      const candidateShorts = shortRows.filter((s) => cents(s.price) === Math.round(Number(parsedId.priceCents) || NaN));
      if (!candidateShorts.length) { stats.longOnly++; emitPlanRow("long-only", "no-price-matching-short", long, null); continue; }

      let outcome = { verdict: "not-a-match" };
      let matchedShort = null;
      for (const short of candidateShorts) {
        if (isProtected(short)) continue;
        const d = decideSyntheticTwin(long, short, { dayCounts, longDayCounts });
        if (d.verdict === "collapse" || d.verdict === "twins-disagree" || d.verdict === "ambiguous-multi-sale-day") { outcome = d; matchedShort = short; break; }
      }
      if (outcome.verdict === "not-a-match" && candidateShorts.some((s) => isProtected(s))) {
        stats.protected++;
        emitPlanRow("protected", "short-twin-pinned-or-flagged", long, candidateShorts.find((s) => isProtected(s)));
        continue;
      }

      if (outcome.verdict === "not-a-match") { stats.longOnly++; emitPlanRow("long-only", "no-proven-short-twin", long, null); continue; }
      if (outcome.verdict === "ambiguous-multi-sale-day") {
        stats.ambiguousMultiSaleDay++;
        emitPlanRow("ambiguous-multi-sale-day", "multiple-sales-same-day-price", long, matchedShort);
        if (examples.length < 30) examples.push(`  AMBIGUOUS-MULTI-SALE-DAY  ${cardId}  long=${long.id}`);
        continue;
      }
      if (outcome.verdict === "twins-disagree") {
        stats.twinsDisagree++;
        bump(disagreeBy, outcome.axis);
        emitPlanRow("twins-disagree", outcome.axis, long, matchedShort, { longValue: outcome.longValue, shortValue: outcome.shortValue });
        if (examples.length < 30) examples.push(`  TWINS-DISAGREE ${outcome.axis}  ${cardId}  long=${JSON.stringify(outcome.longValue)} short=${JSON.stringify(outcome.shortValue)}`);
        continue;
      }

      // outcome.verdict === "collapse"
      if (examples.length < 30) examples.push(`  PROVEN PAIR  ${cardId}  long=${outcome.drop.id}  keep=${outcome.keep.id}  fold[${outcome.folded.join(",")}]${outcome.dateOnlyPath ? "  (date-only, unique-on-day)" : ""}`);
      stats.provenPairs++;
      emitPlanRow(APPLY ? "collapse" : "would-collapse", "proven-synthetic-twin", long, matchedShort, { folded: outcome.folded });
      const res = await relocateSoldComp(pool, { keep: outcome.keep, drop: [{ ...outcome.drop, ifMatchEtag: long._etag }], retry, verifyFields: ["collapsedAt"], dryRun: !APPLY });
      if (!res.ok && res.stage !== "done") { stats.failed++; console.log(`  FAILED at ${res.stage} ${outcome.keep.id}: ${String(res.error).slice(0, 100)}`); continue; }
      if (res.duplicatesLeft?.length) { stats.failed++; stats.duplicatesLeft += res.duplicatesLeft.length; for (const x of res.duplicatesLeft) console.log(`  DUPLICATE LEFT ${x.id}@${x.cardId}: ${String(x.error).slice(0, 80)}`); continue; }
      if (res.staleSincePlan?.length) { stats.staleSincePlan += res.staleSincePlan.length; for (const x of res.staleSincePlan) console.log(`  STALE SINCE PLAN ${x.id}@${x.cardId}: ${String(x.error).slice(0, 80)}`); continue; }
      if (APPLY) stats.alreadyGone += res.alreadyGone.length;
      stats.collapsed++;
    }
  }

  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  CH partitions scanned         ${f(stats.partitions)}   (${f(stats.otherShard)} belonging to other slots; ${f(stats.rowsRead)} rows read)`);
  console.log(`  long (synthetic-id) rows seen ${f(stats.longRows)}`);
  console.log(`  PROVEN PAIRS (would delete)   ${f(stats.provenPairs)}`);
  console.log(`  ambiguous-multi-sale-day      ${f(stats.ambiguousMultiSaleDay)}   <- several real sales, same day+price; left alone`);
  console.log(`  twins-disagree                ${f(stats.twinsDisagree)}   <- ${[...disagreeBy].map(([k, n]) => `${k} ${n}`).join(", ") || "-"}`);
  console.log(`  protected                     ${f(stats.protected)}   <- verifiedByUser/flaggedWrong/excludedFromFmv/pinned; never touched`);
  console.log(`  long-only                     ${f(stats.longOnly)}   <- no short twin resident in this partition; out of scope here`);
  console.log(`  ${APPLY ? "COLLAPSED" : "WOULD COLLAPSE"}                     ${f(stats.collapsed)}`);
  console.log(`  failed                        ${f(stats.failed)}`);
  console.log(`    duplicates left             ${f(stats.duplicatesLeft)}   <- kept row written, the long row's delete failed: the sale is in the pool twice, never lost`);
  console.log(`    stale since plan (412)      ${f(stats.staleSincePlan)}   <- the long row changed since this run's own planning read; nothing deleted`);
  console.log(`  not reached                   ${f(stats.notReached)}`);
  console.log(`  projected rows freed if applied: ${f(stats.provenPairs)}`);
  if (examples.length) { console.log("  examples:"); for (const e of examples) console.log(e); }
  if (APPLY) reportWrites({ job: "collapse-ch-synthetic-twins", intended: stats.provenPairs, written: stats.collapsed, skipped: stats.ambiguousMultiSaleDay + stats.twinsDisagree + stats.protected + stats.longOnly, failed: stats.failed });
  if (stopReason) console.log(`\n${stopReason}`);
  if (planFd) { try { fs.closeSync(planFd); } catch { /* best effort */ } }
}

module.exports = { parseLongSyntheticId, isCanonicalChDailyId, parseInstant, sameInstant, dayOf, decideSyntheticTwin, isProtected, gradeKeyOf, CARRY_FIELDS };

if (require.main === module) // CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809).
main()
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => { console.error("FATAL:", e?.stack || e?.message);
    await finishLane(3);
  });
