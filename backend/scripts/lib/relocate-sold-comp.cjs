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
 * Step 2 is `readBackKeptRow`, and it is deliberately more than one read: the
 * account is at Eventual consistency, so a single point-read at (id, cardId)
 * can 404 on a document that was written -- see that function for the run that
 * proved it. It retries, then falls back to a query on BOTH keys, and only a
 * row that no read can find is a failure.
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

/** Which of `fields` differ between the documents. Missing (null / undefined /
 *  "") values are equal to each other; strings compare trimmed. */
function varianceOf(docs, fields) {
  const differing = [];
  const values = {};
  for (const f of fields) {
    const seen = new Map();
    for (const d of docs) {
      const v = d?.[f];
      const k = isMissing(v) ? "" : typeof v === "string" ? v.trim() : JSON.stringify(v);
      if (!seen.has(k)) seen.set(k, isMissing(v) ? null : v);
    }
    if (seen.size > 1) { differing.push(f); values[f] = [...seen.values()]; }
  }
  return { differing, values };
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

/** How many times a null point-read is retried before the query fallback. */
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
 * The lag is transient, so the point-read is retried with backoff; the last
 * resort is a query on the identity that does not depend on guessing a
 * partition -- the document id together with `hobbyiqCardId` OR `cardId`. A
 * query is served across partitions from an up-to-date replica set, so it sees
 * the write the stale point-read missed.
 *
 * Returns the document (tagged `__via` when it took more than the first read),
 * or null when every read agrees it is absent -- a REAL failure, after which
 * the caller still deletes nothing.
 */
async function readBackKeptRow(pool, keep, retry = (fn) => fn(), wait = sleep) {
  for (let attempt = 0; attempt < READ_BACK_ATTEMPTS; attempt++) {
    let doc = null;
    try { doc = (await retry(() => pool.item(keep.id, keep.cardId).read())).resource ?? null; }
    catch (e) { if (!is404(e)) throw e; }
    if (doc) return attempt === 0 ? doc : { ...doc, __via: "point-read-retry-" + attempt };
    if (attempt < READ_BACK_ATTEMPTS - 1) await wait(READ_BACK_BACKOFF_MS[attempt] ?? 700);
  }
  // Both keys, one query: the row is addressed by the id it kept and by the
  // identity it moved to, so neither a stale replica nor a changed partition
  // can hide it.
  const res = await retry(() => pool.items.query({
    query: "SELECT * FROM c WHERE c.id = @id AND (c.cardId = @pk OR c.hobbyiqCardId = @slug)",
    parameters: [
      { name: "@id", value: keep.id },
      { name: "@pk", value: keep.cardId },
      { name: "@slug", value: keep.hobbyiqCardId ?? keep.cardId },
    ],
  }, { enableCrossPartitionQuery: true }).fetchAll());
  const found = res?.resources ?? [];
  const hit = found.find((d) => d?.id === keep.id && d?.cardId === keep.cardId) ?? null;
  return hit ? { ...hit, __via: "query-both-keys" } : null;
}

/**
 * Keep `keep` (a full document), then delete every `drop` ({ id, cardId })
 * that is not `keep` itself. `retry` wraps each Cosmos call (429s); pass the
 * script's own. `verifyFields` are compared between `keep` and the read-back
 * on top of id/cardId, so a stale document at the same address cannot pass
 * as the write. `dryRun` touches nothing and describes the plan.
 *
 * Result (every list is disjoint):
 *   ok            true iff the kept row is verified AND no duplicate is left
 *   stage         "dry-run" | "upsert" | "verify" | "done"
 *   existedBefore the address already held a document (a collapse target)
 *   deleted       old rows removed
 *   alreadyGone   old rows the delete found missing (404) -- not ours to count
 *   duplicatesLeft old rows whose delete failed: the sale is now in the pool
 *                 TWICE, reported here, never retried past `retry`
 *   readBackVia   how the write was confirmed: "point-read", a retry, or the
 *                 both-keys query that defeats Eventual-consistency lag
 */
async function relocateSoldComp(pool, { keep, drop, retry = (fn) => fn(), verifyFields = [], dryRun = false, wait = sleep }) {
  const drops = (drop ?? []).filter((d) => d && d.id && d.cardId && !sameRef(d, keep));
  if (!keep || !keep.id || !keep.cardId) throw new Error("relocateSoldComp: keep needs id and cardId");
  if (dryRun) return { ok: true, stage: "dry-run", existedBefore: null, deleted: [], alreadyGone: [], duplicatesLeft: [], wouldDelete: drops.length };

  let existedBefore = false;
  try {
    const { resource } = await retry(() => pool.item(keep.id, keep.cardId).read());
    existedBefore = !!resource;
  } catch (e) { if (!is404(e)) throw e; }

  try {
    await retry(() => pool.items.upsert(keep));
  } catch (e) {
    return { ok: false, stage: "upsert", error: String(e?.message ?? e), existedBefore, deleted: [], alreadyGone: [], duplicatesLeft: [] };
  }

  let back = null, readBackVia = "point-read";
  try {
    back = await readBackKeptRow(pool, keep, retry, wait);
    if (back && back.__via) { readBackVia = back.__via; delete back.__via; }
  } catch (e) {
    return { ok: false, stage: "verify", error: String(e?.message ?? e), existedBefore, deleted: [], alreadyGone: [], duplicatesLeft: [], readBackVia };
  }
  const mismatch = !back || back.id !== keep.id || back.cardId !== keep.cardId
    || verifyFields.some((f) => JSON.stringify(back[f] ?? null) !== JSON.stringify(keep[f] ?? null));
  if (mismatch) return { ok: false, stage: "verify", error: back ? "read-back differs from the written row" : "read-back found nothing", existedBefore, deleted: [], alreadyGone: [], duplicatesLeft: [], readBackVia };

  const deleted = [], alreadyGone = [], duplicatesLeft = [];
  for (const d of drops) {
    try { await retry(() => pool.item(d.id, d.cardId).delete()); deleted.push(d); }
    catch (e) { if (is404(e)) alreadyGone.push(d); else duplicatesLeft.push({ ...d, error: String(e?.message ?? e) }); }
  }
  return { ok: duplicatesLeft.length === 0, stage: "done", existedBefore, deleted, alreadyGone, duplicatesLeft, readBackVia };
}

module.exports = { relocateSoldComp, readBackKeptRow, stripSystem, isMissing, cents, day, normParallel, legacyNormParallel, gradeKey, contentHashOf, legacyContentHashOf, contentHashesForLookup, varianceOf, foldMissing, sameRef };
