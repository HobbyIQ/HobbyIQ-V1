/**
 * relocate-sold-comp.cjs -- the ONE way a sold_comps row changes its key.
 *
 * CF-A-SALE-IS-NEVER-LOST (D19, 2026-08-30). sold_comps is partitioned on
 * /cardId, so a row cannot be re-keyed in place: a re-key is a NEW document
 * plus a DELETE of the old one, and the pool must never be without the sale
 * between the two. tca-match-enricher's delete-then-create (named in D18) is
 * the shape that loses a row; this helper is the opposite order, with a
 * verification between:
 *
 *   1. upsert the row we intend to keep          -> throws: nothing deleted
 *   2. read it back and compare                   -> mismatch: nothing deleted
 *   3. delete every old row, one at a time        -> a delete that fails is
 *                                                    reported as a DUPLICATE
 *                                                    left in the pool, never
 *                                                    retried into a missing row
 *
 * Step 2 is `readBackKeptRow`, and it is deliberately more than one read: a
 * single point-read at (id, cardId) can miss a document that was written --
 * see that function for the runs that proved it, and for the fact that the
 * miss is not always a 404. It retries until the read SHOWS THE WRITE, then
 * falls back to a point-read-shaped query, and only a row that no read can
 * find is a failure.
 *
 * The account was raised to **Session** consistency on 2026-09-05 (measured
 * 2026-09-06: defaultConsistencyLevel "Session", maxStalenessPrefix 100,
 * maxIntervalInSeconds 5). Session is read-your-writes only WITHIN a session,
 * so this is a narrower window than Eventual, not a closed one.
 *
 * The same helper serves a re-key (one old row -> one new row) and a collapse
 * (several old rows -> the one kept). The caller decides WHAT to keep; this
 * decides nothing, it only guarantees the order.
 *
 * Pure helpers live here too so both D19 scripts describe rows the same way:
 * `stripSystem`, `foldMissing`, `varianceOf`, `cents`, `normParallel`,
 * `gradeKey`, `contentHashOf` (a mirror of soldCompsStore.computeContentHash,
 * as apply-sold-comps-dedup mirrors scoreForCanonical).
 */
"use strict";
const crypto = require("crypto");
const path = require("path");
const { withBackoff } = require("./cosmos-backoff.cjs");

/**
 * DEFAULT_RETRY (2026-09-27, incident: run 36297136135 -- see cosmos-backoff.cjs's
 * own header for the full trace). Every existing caller of `relocateSoldComp`/
 * `readBackKeptRow` that does not pass its own `retry` used to get a bare
 * `(fn) => fn()` passthrough -- so a 429 that outlived the @azure/cosmos SDK's
 * own internal retry budget threw straight out of the upsert/read-back/delete
 * chain with NO application-level backoff underneath any of the 22 other
 * callers grepped in this file's own header, not just the isAuto-flip lane
 * that surfaced it. The default is now a bounded, logged backoff instead of a
 * no-op passthrough -- ANY caller that already supplies its own `retry`
 * (rematch-sold-comps, rekey-product-setkey, ...) is COMPLETELY UNCHANGED,
 * because a supplied argument always wins over a default parameter; this only
 * changes the callers that had NOTHING wrapping their Cosmos calls before. */
const defaultRetry = (fn) => withBackoff(fn, { label: "relocate-sold-comp" });

/**
 * CF-ONE-WRITE-PATH-FOR-SOLD-COMPS (2026-09-07). The mover is SANCTIONED --
 * it is the one way a row changes its key, and 21 scripts go through it -- but
 * being sanctioned is about ORDER, not about the address. This helper
 * guaranteed the sale was never lost between the upsert and the delete and
 * never once asked whether the identity it was moving the row TO was one
 * anybody can read back. A `to` value comes from a list file; a mover that
 * writes it unchecked mints exactly the unaddressable keys #1939 measured,
 * with a verified read-back to prove it landed.
 *
 * So the NEW document goes through the SAME predicate the emitter uses. Loaded
 * from dist/ the way every other script loads shipped logic; when dist has not
 * been built the guard is ABSENT rather than silently permissive, and
 * `relocateSoldComp` refuses to write instead of guessing -- an unguarded move
 * is the thing this exists to stop.
 */
let _guardFn = null;
function loadGuard() {
  if (_guardFn) return _guardFn;
  const backend = path.resolve(__dirname, "..", "..");
  const mod = require(path.join(backend, "dist", "services", "portfolioiq", "splitIdentityWriteGuard.js"));
  if (typeof mod.guardSoldCompDoc !== "function") {
    throw new Error("relocate-sold-comp: dist splitIdentityWriteGuard exports no guardSoldCompDoc");
  }
  _guardFn = mod.guardSoldCompDoc;
  return _guardFn;
}

const SYSTEM_FIELDS = new Set(["_rid", "_self", "_etag", "_attachments", "_ts"]);

/** A copy of the document without Cosmos' system properties. */
function stripSystem(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc ?? {})) if (!SYSTEM_FIELDS.has(k)) out[k] = v;
  return out;
}

const isMissing = (v) => v === null || v === undefined || v === "";
const cents = (p) => Math.round(Number(p ?? 0) * 100);
const day = (iso) => String(iso ?? "").slice(0, 10);

/**
 * CF-CH-CARD-SET-ALREADY-HAS-THE-YEAR, THE MOVE-SIDE HALF (2026-09-28).
 *
 * The producer of the doubled-year title ("2025 2025 Topps Chrome Update
 * Baseball #AC-AB Base") was fixed in backfill-sold-comps-from-ch.cjs on
 * 2026-08-24 (commit 0000f60) -- new CH rows stop repeating the year. But
 * every row written BEFORE that fix still carries the doubled title
 * forever, because nothing that ever MOVES a row (relocateSoldComp's own
 * callers: rekey-product-setkey, repoint-sales-by-list, repoint-sales-
 * isauto-flip, ...) re-derives title -- they carry `row.title` through via
 * `stripSystem(row)` unchanged. Three repair lanes (repair-base-to-title-
 * finish, repair-refractor-mislabel, repair-setkey-from-title-parallel)
 * already grew their OWN identical local `dedupeYear()` just to let their
 * OWN parser read the title correctly -- none of them write the healed
 * title back, so the stored row stays doubled and the next reader pays
 * the same tax again. This is that helper, promoted to the shared mover so
 * a relocate HEALS the title as it moves the row, same as it already
 * heals cardId/hobbyiqCardId/contentHash.
 *
 * IDEMPOTENT BY CONSTRUCTION: only strips a LEADING "<year> <year> "
 * (or "<year>-<year> ", for a hyphenated repeat) -- a title that has
 * already been healed, or was never doubled, is returned byte-for-byte.
 * Running it twice on its own output is a no-op.
 */
function dedupeYearPrefix(title, year) {
  const t = String(title ?? "");
  const y = String(year ?? "").trim();
  if (!y || !t) return t;
  const re = new RegExp(`^${y}[\\s-]+${y}\\s+`);
  return t.replace(re, `${y} `);
}
/** Mirror of soldCompsStore's normalizeParallel (contentHash).
 *
 *  D31: the trailing " Refractor" is NO LONGER stripped. The retracted rule
 *  said a colour and its colour-refractor sibling were one card; D31 says the
 *  checklist decides per card, and Topps Finest #197 lists `Uncommon` AND
 *  `Uncommon Refractor` as two of them. Stripping the word made the two hash
 *  identically inside one cardId partition, and the store's pre-write dedup
 *  reads "same contentHash in this partition" as "the same sale" -- so a
 *  genuine sale of one card was swallowed at ingest by the other's row. */
const normParallel = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/^\[base\]$/, "base") || "base";

/** The pre-D31 normalization, kept ONLY so a stored row's legacy hash can be
 *  recognised during the transition. Never used to WRITE a hash. */
const legacyNormParallel = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/ refractors?$/, "").replace(/^\[base\]$/, "base") || "base";
/** Raw is a grade too: null company + null value is "RAW|0", which is what the
 *  store hashes. Two rows whose gradeKey differs are two sales. */
const gradeKey = (r) => `${String(r?.gradeCompany ?? "raw").toUpperCase()}|${r?.gradeValue ?? 0}`;

/** Mirror of soldCompsStore.computeContentHash -- the partition-scoped dedup
 *  key. A row that moves partition must carry the hash of its NEW cardId or
 *  the store's pre-write dedup can never see it. */
function hashWith(row, parallel) {
  const parts = [
    String(row.cardId ?? "").trim(),
    parallel,
    row.isAuto === true ? "1" : "0",
    String(row.gradeCompany ?? "raw").toUpperCase(),
    String(row.gradeValue ?? 0),
    String(cents(row.price)),
    day(row.soldAt),
  ];
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex");
}

/** D31: the parallel is hashed WHOLE -- see `normParallel`. */
function contentHashOf(row) {
  return hashWith(row, String(row.parallel ?? "").trim().toLowerCase().replace(/\s+/g, " "));
}

/** The hash the SAME sale carries if it was stored before the D31 fix. */
function legacyContentHashOf(row) {
  return hashWith(row, String(row.parallel ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/ refractors?$/, ""));
}

/** Every hash a stored row for this sale could carry: the new form, plus the
 *  legacy form when it differs. Mirrors soldCompsStore.contentHashesForLookup. */
function contentHashesForLookup(row) {
  const fresh = contentHashOf(row), legacy = legacyContentHashOf(row);
  return legacy === fresh ? [fresh] : [fresh, legacy];
}

/**
 * CF-A-DOUBLED-YEAR-IS-NOT-A-DIFFERENT-SALE (2026-09-28 dedupe census).
 * `title` compares equal when the only disagreement is a doubled leading
 * year -- exactly `dedupeYearPrefix`'s own shape, but this comparison has
 * no `cardYear` handed to it (varianceOf takes bare docs+fields, not a
 * card identity), so it detects ANY `^(\d{4})\s+\1[\s-]+` doubling, not
 * only one matching a caller-supplied year. Whitespace is also
 * collapsed/trimmed on top of the doubling strip, so "  2025   2025  Topps"
 * and "2025 Topps" agree too.
 */
function normalizeTitleForVariance(v) {
  if (isMissing(v)) return v;
  const collapsed = String(v).trim().replace(/\s+/g, " ");
  return collapsed.replace(/^(\d{4})\s+\1[\s-]+/, "$1 ");
}

/**
 * CF-SOLDAT-FORMAT-IS-NOT-CONTENT (2026-09-28 dedupe census). The census's
 * one soldAt-only refusal was `2026-07-18T03:36:00+00:00` vs
 * `2026-07-18T03:36:00.000Z` -- the SAME instant, two ISO renderings, one
 * with an explicit +00:00 offset and no milliseconds, the other with a Z
 * suffix and an explicit .000. `Date` parses both to the same epoch
 * millisecond; comparing the parsed instant (not the string) treats them
 * as equal without touching any other field's byte-exact comparison. An
 * unparseable value falls back to the raw string so a garbage soldAt still
 * REFUSES rather than silently comparing equal to another garbage value
 * that happens to also fail to parse.
 */
function normalizeSoldAtForVariance(v) {
  if (isMissing(v)) return v;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? `__instant:${t}` : String(v);
}

const VARIANCE_NORMALIZERS = {
  title: normalizeTitleForVariance,
  soldAt: normalizeSoldAtForVariance,
  date: normalizeSoldAtForVariance,
};

/** Which of `fields` differ between the documents. Missing (null / undefined /
 *  "") values are equal to each other; strings compare trimmed.
 *
 *  A field named in `VARIANCE_NORMALIZERS` (title, soldAt, date) is ALSO
 *  passed through its normalizer before comparison -- see those functions'
 *  own comments for what each one absorbs. Byte-exact comparison is
 *  unchanged for every other field (source, externalId, price, grade,
 *  currency, ...). `result.normalizedFields` names which of the CHECKED
 *  `fields` had a normalizer applied (whether or not it changed the
 *  outcome), so a caller's banner can say the match was via normalization
 *  rather than a plain byte-exact agreement. */
function varianceOf(docs, fields) {
  const differing = [];
  const values = {};
  const normalizedFields = [];
  for (const f of fields) {
    const normalize = VARIANCE_NORMALIZERS[f];
    if (normalize) normalizedFields.push(f);
    const seen = new Map();
    for (const d of docs) {
      const raw = d?.[f];
      const v = normalize ? normalize(raw) : raw;
      const k = isMissing(v) ? "" : typeof v === "string" ? v.trim() : JSON.stringify(v);
      if (!seen.has(k)) seen.set(k, isMissing(raw) ? null : raw);
    }
    if (seen.size > 1) { differing.push(f); values[f] = [...seen.values()]; }
  }
  return { differing, values, normalizedFields };
}

/** Fill the fields the winner LACKS from the donors, in donor order. Never
 *  overwrites a value the winner already has. Returns the fields filled. */
function foldMissing(winner, donors, fields) {
  const filled = [];
  for (const f of fields) {
    if (!isMissing(winner[f])) continue;
    for (const d of donors) {
      if (isMissing(d?.[f])) continue;
      winner[f] = d[f];
      filled.push(f);
      break;
    }
  }
  return filled;
}

const sameRef = (a, b) => a && b && a.id === b.id && a.cardId === b.cardId;
const is404 = (e) => e?.code === 404 || e?.statusCode === 404;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How many times a point-read that does not yet show the write is retried
 *  before the query fallback. */
const READ_BACK_ATTEMPTS = 4;
/** Backoff between those attempts, in ms. */
const READ_BACK_BACKOFF_MS = [120, 300, 700];

/**
 * Read back the row we just wrote -- and believe "it is not there" only when
 * BOTH addresses agree.
 *
 * CF-A-VENDOR-KEYED-SALE-REKEYS-WHERE-IT-LIVES (2026-09-05). The hobbyiq-comps
 * account runs at **Eventual** consistency (measured: defaultConsistencyLevel
 * "Eventual", single region, no multi-write). A point-read issued microseconds
 * after an upsert can land on a replica that has not yet received the write and
 * answer 404 -- so this helper declared "read-back found nothing" for a
 * document that had in fact been written. rekey-product-setkey MODE=pool run
 * 33973364948 hit it on 12 of 35,173 rows; every one of the 12 was later found
 * ALIVE at its new address carrying that run's own `rekeyedAt`, with the old
 * row still in place because the (correct) safety order never deletes after a
 * failed verify. The result is not a lost sale -- it is the opposite, a
 * DUPLICATE, and the run counted it `failed`.
 *
 * Why the 12 were all vendor-keyed is the same fact seen from the other side: a
 * vendor-keyed row CHANGES PARTITION (its `cardId` moves off a CardHedge bubble
 * id onto the hiq: slug), so its read-back addresses a partition that did not
 * hold the document a moment earlier -- exactly where replica lag is visible. A
 * row already on its slug re-reads a partition it was already in.
 *
 * A STALE READ IS NOT ALWAYS A 404 (2026-09-06, the actual cause of the four
 * failures below). This loop used to accept the FIRST non-null document it
 * read, without asking whether that document showed the write. When the
 * keeper's address ALREADY HELD a document -- a collapse target, or the same
 * id re-keyed a second time -- a lagging replica answers with the PRE-UPSERT
 * version instead of 404. That version is non-null, so the loop returned it
 * on attempt 0: the backoff retries never ran, the query fallback never ran,
 * and the caller then compared its `verifyFields` against a document it had
 * already been handed as verified. The result was reported as "read-back
 * differs from the written row" -- the write had in fact landed.
 *
 * Measured: rematch-sold-comps IMPROVE, run 34004076637 (slot 26/32), 4 rows.
 * Every one is ALIVE at its new address carrying that run's own `rekeyedAt`
 * (within 50ms of the log line) and `rekeyedFrom` naming the old identity,
 * with the old row still standing. Sibling rows re-keyed into the SAME
 * partition in the same second and passed; only the timing separates them.
 *
 * So the loop now retries until the read SHOWS THE WRITE: a document counts
 * only when it is the keeper at the keeper's address AND agrees on the fields
 * the caller named. `matches` is that predicate, and it is the SAME predicate
 * the caller applies -- a read-back that satisfies one and not the other is
 * the bug this fixes.
 *
 * The last resort is a query, which is served from an up-to-date replica set.
 * It is addressed like the point read -- `c.id = @id AND c.cardId = @pk` --
 * and NOT by `hobbyiqCardId`: the old-address twin of a re-keyed row carries
 * a hobbyiqCardId too, so an OR on it can answer with the very row this
 * helper is trying to move away from.
 *
 * Returns the document (tagged `__via` when it took more than the first read),
 * or null when no read can show the write -- a REAL failure, after which the
 * caller still deletes nothing.
 */
function readBackShowsWrite(doc, keep, verifyFields = []) {
  if (!doc || doc.id !== keep.id || doc.cardId !== keep.cardId) return false;
  return verifyFields.every((f) => JSON.stringify(doc[f] ?? null) === JSON.stringify(keep[f] ?? null));
}

async function readBackKeptRow(pool, keep, retry = defaultRetry, wait = sleep, verifyFields = []) {
  const shows = (doc) => readBackShowsWrite(doc, keep, verifyFields);
  for (let attempt = 0; attempt < READ_BACK_ATTEMPTS; attempt++) {
    let doc = null;
    try { doc = (await retry(() => pool.item(keep.id, keep.cardId).read())).resource ?? null; }
    catch (e) { if (!is404(e)) throw e; }
    // A non-null document is NOT proof the write is visible -- see the note
    // above. Only a read that SHOWS THE WRITE ends the loop; a stale version
    // of the row that was already at this address is retried past, exactly as
    // a 404 is.
    if (shows(doc)) return attempt === 0 ? doc : { ...doc, __via: "point-read-retry-" + attempt };
    if (attempt < READ_BACK_ATTEMPTS - 1) await wait(READ_BACK_BACKOFF_MS[attempt] ?? 700);
  }
  // The point read, as a query: a query is served from an up-to-date replica
  // set, so it sees the write a lagging point-read did not. It is addressed
  // by (id, cardId) and NOTHING else -- never OR'd onto `hobbyiqCardId`,
  // which the row's own old-address twin also carries, and which would let
  // this helper "verify" the keeper against the row it is moving away from.
  const res = await retry(() => pool.items.query({
    query: "SELECT * FROM c WHERE c.id = @id AND c.cardId = @pk",
    parameters: [
      { name: "@id", value: keep.id },
      { name: "@pk", value: keep.cardId },
    ],
  }, { partitionKey: keep.cardId }).fetchAll());
  const hit = (res?.resources ?? []).find((d) => shows(d)) ?? null;
  return hit ? { ...hit, __via: "query-point-read" } : null;
}

/** Does an error carry a Cosmos 412 (etag precondition failed)? */
function is412(e) {
  return e?.code === 412 || e?.statusCode === 412;
}

/**
 * Keep `keep` (a full document), then delete every `drop` ({ id, cardId,
 * ifMatchEtag? }) that is not `keep` itself. `retry` wraps each Cosmos call
 * (429s); pass the script's own. `verifyFields` are compared between `keep`
 * and the read-back on top of id/cardId, so a stale document at the same
 * address cannot pass as the write. `dryRun` touches nothing and describes
 * the plan.
 *
 * CONDITIONAL DELETE (review, 2026-09-19, OPTIONAL, additive). A `drop` item
 * may carry `ifMatchEtag`: the `_etag` the CALLER's own planning read saw at
 * that address. When present, the delete is issued with an `IfMatch` access
 * condition -- Cosmos itself refuses the delete with a 412 if the document
 * changed since that read, closing the window a caller's own re-read (this
 * lane's own last-line defence, or any future one) cannot fully close on its
 * own: the re-read and the delete are still two round trips, and the SAME
 * document could change in between them without this option. A 412 is
 * reported in the NEW `staleSincePlan` list (disjoint from `duplicatesLeft`
 * -- a 412 means the delete was REFUSED because the address changed, not
 * that a delete FAILED against a still-matching document) and is NOT
 * retried: `retry()` only retries on 429/timeout-shaped errors (see its own
 * regex), and a 412 is neither, so it already passes straight through
 * without any change to `retry` itself.
 *
 * A `drop` item with no `ifMatchEtag` (every existing caller, unchanged)
 * deletes exactly as before -- unconditional, no accessCondition object
 * built at all, so this option is invisible to every one of the 22 other
 * callers of this function (grepped: collapse-ch-dual-ids, consolidate-
 * catalog-duplicates, fold-checklist-numbered-twins, fold-umbrella-to-series,
 * normalize-tca-rows, rekey-catalog-id-to-setkey, rekey-product-setkey,
 * rekey-user-comps, relocate-pool-rows-by-list, rematch-sold-comps, repair-
 * bowman-product-refile, repair-card-number-from-title, repair-ch-product-
 * label-parallel, repair-cpa-draft-refile, repair-finish-collision-refile,
 * repair-parallel-from-title, repair-tiffany-pool-enumeration, repair-
 * tiffany-rung-to-product, repairMegaBoxAndInsertComps, reslug-ruled-alias,
 * revert-d30-base-onto-one-of-one, revert-set-sport-repair, tca-match-
 * enricher -- none pass ifMatchEtag, none read `staleSincePlan`, so this
 * change is byte-for-byte behaviorally identical for every one of them).
 *
 * Result (every list is disjoint):
 *   ok            true iff the kept row is verified AND no duplicate is left
 *                 AND no drop was refused stale (staleSincePlan is empty)
 *   stage         "dry-run" | "upsert" | "verify" | "done"
 *   existedBefore the address already held a document (a collapse target)
 *   deleted       old rows removed
 *   alreadyGone   old rows the delete found missing (404) -- not ours to count
 *   duplicatesLeft old rows whose delete failed: the sale is now in the pool
 *                 TWICE, reported here, never retried past `retry`
 *   staleSincePlan old rows whose CONDITIONAL delete was refused (412): the
 *                 source changed since the caller's own planning read, so
 *                 NOTHING was deleted for that drop -- same sale, still at
 *                 its old address, untouched; never counted as a duplicate
 *                 (a duplicate implies the delete failed against a document
 *                 that still matched; a 412 means it did not match at all)
 *   readBackVia   how the write was confirmed: "point-read", a retry, or the
 *                 (id, cardId) query that defeats replica lag
 *
 * CROSS-PARTITION DUPLICATE VERIFY (2026-09-27, incident: run 36353646453,
 * OPTIONAL, additive, default OFF). Pass `verifyNoDuplicatesAcrossPartitions:
 * true` to run one extra query after the delete loop: cross-partition,
 * `SELECT c.id, c.cardId, c.hobbyiqCardId FROM c WHERE c.id = @id`, asking
 * the pool itself whether any OTHER document still answers to this id. Every
 * per-drop delete above can only address what it was HANDED in `drop` --
 * it cannot see a physical duplicate the caller's own scan never told it
 * about (exactly what happened here: drainSalesIdsAtId's id-only dedup
 * silently dropped one of two documents sharing an id before this function
 * was ever called, so its `drop` list never named the leftover, and no
 * per-drop delete could have reached it). This verify is the backstop for
 * that upstream class of miss, not a replacement for the drop-list fix
 * (sales-at-id.cjs's own fix keys on (id, cardId), so the leftover should
 * never reach `relocateSoldComp` un-named in the first place -- this is
 * defense in depth for callers that opt in).
 *
 * OFF by default because `pool.items.query` is a real Cosmos SDK call this
 * function did not make before, and the 22+ existing callers' own test
 * fakes are not shaped to answer it -- opting in is the caller's choice, not
 * a silent behavior change for everyone who already calls this helper.
 * When on, a leftover this verify finds is appended to `duplicatesLeft`
 * (each carrying its own `cardId`/`hobbyiqCardId` and
 * `viaCrossPartitionVerify: true`, disjoint from a per-drop delete failure);
 * a THROW from the verify query itself is reported as `ok: false, stage:
 * "verify"` -- never silently read as "found nothing, therefore clean" --
 * mirroring how a thrown read-back is already handled above.
 */
async function relocateSoldComp(pool, { keep, drop, retry = defaultRetry, verifyFields = [], dryRun = false, wait = sleep, guard = undefined, verifyNoDuplicatesAcrossPartitions = false }) {
  const drops = (drop ?? []).filter((d) => d && d.id && d.cardId && !sameRef(d, keep));
  if (!keep || !keep.id || !keep.cardId) throw new Error("relocateSoldComp: keep needs id and cardId");

  // ── THE ADDRESS THE ROW IS MOVING TO ─────────────────────────────────────
  // Judged BEFORE the dry-run return, so a dry run reports the same refusal an
  // APPLY would hit rather than describing a move that will not happen. The
  // guard mutates `keep` in place: a parked row still MOVES (the sale is real
  // and the caller decided where it belongs), it just carries the stamp that
  // keeps it out of every pool. A malformed destination is different -- there
  // is no pool to be out of, because the address cannot be read back -- so it
  // is REFUSED and nothing is written or deleted.
  const guardFn = guard === undefined ? loadGuard() : guard;
  const verdict = guardFn(keep, { guardedBy: "relocateSoldComp" });
  if (verdict.verdict === "park" && verdict.reason === "malformed-key") {
    return {
      ok: false, stage: "guard",
      error: `relocateSoldComp: refused — ${verdict.detail}`,
      existedBefore: null, deleted: [], alreadyGone: [], duplicatesLeft: [], staleSincePlan: [], guard: verdict,
    };
  }
  if (dryRun) return { ok: true, stage: "dry-run", existedBefore: null, deleted: [], alreadyGone: [], duplicatesLeft: [], staleSincePlan: [], wouldDelete: drops.length, guard: verdict };

  let existedBefore = false;
  try {
    const { resource } = await retry(() => pool.item(keep.id, keep.cardId).read());
    existedBefore = !!resource;
  } catch (e) { if (!is404(e)) throw e; }

  try {
    await retry(() => pool.items.upsert(keep));
  } catch (e) {
    return { ok: false, stage: "upsert", error: String(e?.message ?? e), existedBefore, deleted: [], alreadyGone: [], duplicatesLeft: [], staleSincePlan: [] };
  }

  let back = null, readBackVia = "point-read";
  try {
    back = await readBackKeptRow(pool, keep, retry, wait, verifyFields);
    if (back && back.__via) { readBackVia = back.__via; delete back.__via; }
  } catch (e) {
    return { ok: false, stage: "verify", error: String(e?.message ?? e), existedBefore, deleted: [], alreadyGone: [], duplicatesLeft: [], staleSincePlan: [], readBackVia };
  }
  const mismatch = !back || back.id !== keep.id || back.cardId !== keep.cardId
    || verifyFields.some((f) => JSON.stringify(back[f] ?? null) !== JSON.stringify(keep[f] ?? null));
  // Reaching a mismatch now means EVERY read -- the retried point reads and
  // the query -- failed to show the write, because `readBackKeptRow` applies
  // these same `verifyFields` before it accepts a document (2026-09-06). A
  // lagging replica no longer lands here.
  //
  // CF-A-VERIFY-MISMATCH-IS-A-DUPLICATE-NOT-A-FAILURE (2026-09-05).
  //
  // The upsert above ALREADY SUCCEEDED. Reaching here means the keeper is
  // written at its new address and the drops are still at their old ones --
  // the row now exists TWICE. This branch used to return `duplicatesLeft: []`,
  // so callers counted it as `failed` and their "duplicates left in pool must
  // be 0" summary line stayed at 0 while a duplicate stood in the pool. This
  // file's own header records the shape: rekey-product-setkey MODE=pool run
  // 33973364948 hit it on 12 of 35,173 rows, and every one of the 12 was
  // later found ALIVE at its new address with the old row still in place.
  //
  // The drops are NOT deleted here -- deleting against a read-back we could
  // not verify is how a sale gets lost, and a sale is never lost. They are
  // REPORTED, which is the whole change: the number the operator reads now
  // counts what is actually in the container.
  if (mismatch) {
    return {
      ok: false, stage: "verify",
      error: back ? "read-back differs from the written row" : "read-back found nothing",
      existedBefore, deleted: [], alreadyGone: [], staleSincePlan: [],
      duplicatesLeft: drops.map((d) => ({
        ...d,
        error: "keeper upserted but read-back failed verification; old row NOT deleted — this id is now resident at two addresses",
      })),
      readBackVia,
    };
  }

  const deleted = [], alreadyGone = [], duplicatesLeft = [], staleSincePlan = [];
  for (const d of drops) {
    // CONDITIONAL DELETE (review, 2026-09-19): only when the caller supplied
    // an etag for THIS drop -- every existing caller's drop objects carry no
    // `ifMatchEtag`, so `options` stays `undefined` and the call below is
    // byte-for-byte the unconditional delete it always was.
    const options = d.ifMatchEtag
      ? { accessCondition: { type: "IfMatch", condition: d.ifMatchEtag } }
      : undefined;
    // The delete is addressed at THIS drop's OWN (id, cardId) -- whatever
    // partition key the CALLER attached to it. relocateSoldComp never
    // second-guesses that address; a caller that hands it the wrong pk for
    // a drop (the #2454 incident: repoint-sales-by-list.cjs handed a `drop`
    // whose cardId was never the doc's own, because the SCAN upstream
    // (drainSalesIdsAtId) had already lost the row -- see sales-at-id.cjs's
    // own fix) leaves the real document untouched and this delete 404s or
    // hits an unrelated row. The cross-partition verify below is what
    // catches that regardless of which layer mis-addressed it.
    try {
      await retry(() => pool.item(d.id, d.cardId).delete(options));
      deleted.push(d);
    } catch (e) {
      if (is404(e)) alreadyGone.push(d);
      else if (is412(e)) staleSincePlan.push({ ...d, error: "delete refused (412): source changed since the caller's own planning read; nothing deleted" });
      else duplicatesLeft.push({ ...d, error: String(e?.message ?? e) });
    }
  }

  // ── CROSS-PARTITION VERIFY (2026-09-27, incident: run 36353646453). ──────
  //
  // Every delete above can report success (`deleted`) or an expected miss
  // (`alreadyGone`) while a THIRD physical document -- one this call was
  // never TOLD about, because whatever scanned for drops upstream missed it
  // -- still sits in the pool under this same `id`. A per-drop delete can
  // only ever address what it was handed; it cannot see what it wasn't.
  //
  // So after the drop loop, ask the pool itself, cross-partition, by `id`
  // alone: how many documents answer to this id, and where do they sit? A
  // clean move leaves EXACTLY ONE -- the keeper, at `keep.cardId`. Anything
  // else (zero, or more than one, or one sitting at the wrong address) is a
  // real duplicate/loss this call did not fully resolve, reported here with
  // each leftover's own cardId/hobbyiqCardId so an operator can address it
  // directly rather than re-deriving it from a census.
  //
  // This is a SEPARATE query from `duplicatesLeft` above (which reports a
  // drop THIS call attempted and failed to delete) -- a leftover found only
  // here was never attempted at all. Both lists feed the same `ok` verdict;
  // neither is folded into the other, so an operator reading `duplicatesLeft`
  // sees which leftovers were attempted-and-failed vs found-only-by-verify
  // (the latter carry `viaCrossPartitionVerify: true`).
  //
  // OFF unless the caller opts in (see this function's own doc comment) --
  // every one of the other 22+ callers, and their own test fakes, get
  // byte-for-byte the same behavior as before this option existed.
  if (verifyNoDuplicatesAcrossPartitions) {
    let crossPartitionExtras = [];
    try {
      const res = await retry(() => pool.items.query({
        query: "SELECT c.id, c.cardId, c.hobbyiqCardId FROM c WHERE c.id = @id",
        parameters: [{ name: "@id", value: keep.id }],
      }).fetchAll());
      const resources = res?.resources ?? [];
      crossPartitionExtras = resources.filter((r) => r && r.cardId !== keep.cardId);
    } catch (e) {
      // A THROWN verify query is reported the same way a thrown read-back is
      // (CF-A-THROWN-VERIFY-IS-FAILED-NOT-CLEAN): we do not know the true
      // state of the pool, so this is never silently treated as "verify
      // found nothing, therefore clean".
      return {
        ok: false, stage: "verify",
        error: `cross-partition duplicate verify threw: ${String(e?.message ?? e)}`,
        existedBefore, deleted, alreadyGone, duplicatesLeft, staleSincePlan, readBackVia,
      };
    }
    for (const extra of crossPartitionExtras) {
      duplicatesLeft.push({
        id: extra.id,
        cardId: extra.cardId ?? null,
        hobbyiqCardId: extra.hobbyiqCardId ?? null,
        error: "cross-partition verify found a leftover document at this id that this call was never told to delete",
        viaCrossPartitionVerify: true,
      });
    }
  }

  return { ok: duplicatesLeft.length === 0 && staleSincePlan.length === 0, stage: "done", existedBefore, deleted, alreadyGone, duplicatesLeft, staleSincePlan, readBackVia };
}

module.exports = { relocateSoldComp, loadGuard, readBackKeptRow, readBackShowsWrite, stripSystem, isMissing, cents, day, normParallel, legacyNormParallel, gradeKey, contentHashOf, legacyContentHashOf, contentHashesForLookup, varianceOf, foldMissing, sameRef, is412, dedupeYearPrefix };
