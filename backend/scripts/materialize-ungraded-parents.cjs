#!/usr/bin/env node
/**
 * CF-MATERIALIZE-UNGRADED-PARENTS (Drew, 2026-08-31). The inverse of
 * materialize-graded-identities.
 *
 * THE PROBLEM. materialize-graded-identities mints `parent:tier` rows from
 * observed graded sales, but it REFUSES when the parent is missing -- it counts
 * that as an ORPHAN and reports it for phase 06 rather than inventing a base
 * card. Meanwhile `ingest-auto-seed-graded` seeds graded rows directly from
 * sales, and it never had that scruple. The result is a set whose catalog is
 * almost entirely graded children with no ungraded parent:
 *
 *   1993 topps-finest basketball   502 rows,  496 graded,   6 ungraded
 *   1993 topps-finest baseball     609 rows,  580 graded,  29 ungraded
 *
 * A RAW HOLDING CANNOT RESOLVE against that. The card exists in the catalog at
 * PSA 9 and PSA 10 and nowhere as itself, so someone holding the raw card has
 * nothing to match to. This mints the missing parent.
 *
 * WHAT MAKES THIS SAFE, AND WHY IT IS NOT THE SPINE EXPLOSION. It mints ONLY
 * where a graded child already exists -- one parent per distinct child identity,
 * never a cross-join. The child is the evidence: something graded this card, so
 * the card is real. That is the same evidence standard as the graded-identity
 * job, read in the other direction. No child, no parent.
 *
 * ── THE SOURCE NAME IS LOAD-BEARING ─────────────────────────────────────────
 *
 * These rows must classify DERIVED: they are generated from our own catalog,
 * they must never adjudicate a setKey, and they must never outvote a checklist
 * on the write path (upsertCatalogEntry ranks by authority, so a derived row
 * loses to a checklist row rather than overwriting it).
 *
 * `catalogAuthorityOf` matches DERIVED by PREFIX:
 *   /^(ingest-auto-seed|sold-comps-stub|catalog-explode|tree-builder|sales-derived|pool)/
 *
 * So a plain descriptive name does NOT classify derived -- it falls through
 * every class and lands on `unknown` (rank 0):
 *
 *   graded-attested                    -> unknown   WRONG
 *   ingest-auto-seed-graded-attested   -> derived   RIGHT
 *
 * This is not hypothetical. The `sales-attested` rows already in this set
 * classify `unknown` today for exactly this reason. `unknown` is not a harmless
 * synonym for derived: authorityRank gives unknown 0 and derived 1, so an
 * unknown-sourced row loses even to a derived one, and `isDerived` returns
 * false for it -- so every audit that sweeps derived rows would skip these.
 *
 * The name therefore extends the `ingest-auto-seed` prefix deliberately. It is
 * never checklist-matched, so canAdjudicate stays false and these rows can
 * never become VERIFIED-able by provenance.
 *
 * SCOPE IS REQUIRED. Per CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME, a job that
 * writes catalog rows refuses to run unscoped. sport + year + setKey are all
 * mandatory; there is no "everything" mode.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   SPORT / YEAR / SET_KEY    required -- the scope. No default, no wildcard.
 *   APPLY / BACKFILL_APPLY    actually write (default: report only)
 *   CONCURRENCY=32
 *   LIMIT=0                   stop after N mints (0 = no limit)
 *   RUN_MINUTES=140           stop before the 150-min step ceiling
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// CF-ONE-WAY-TO-BUILD-A-CATALOG-ROW. Route through the single write path: it
// ranks by authority, so a derived parent can never overwrite a checklist row.
const { upsertCatalogEntry } = require(path.join(backend, "dist/services/portfolioiq/cardCatalog.service.js"));
// CF-CARD-IDENTITY-VS-GRADE. The grade suffix is parsed by the ONE canonical
// parser, never by a local regex. It is positional (only segment 8) and knows
// that a card NUMBER of `psa-th2` in segment 4 is not a grade -- the trap that
// produced 221 false positives when someone last hand-rolled this.
const { cardIdentityKey } = require(path.join(backend, "dist/services/portfolioiq/cardIdentityKey.service.js"));

/** The source these rows carry. Prefix-matched as DERIVED; never checklist. */
const PARENT_SOURCE = "ingest-auto-seed-graded-attested";
const CATALOG_BATCH = "ungraded-parents-2026-08-31";

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 32));
const LIMIT = Number(process.env.LIMIT || 0);
const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
const STARTED = Date.now();

const f = (n) => Number(n).toLocaleString();

/**
 * Build the ungraded parent row from a graded child.
 *
 * A parent is its child minus the grade -- the exact inverse of buildGradedRow,
 * which spreads the parent and adds grade fields. Spreading (rather than
 * hand-listing fields) is deliberate for the same reason it is there: the old
 * graded builder hand-listed and silently dropped subsetName, displayName,
 * playerSlug, imageUrl and cardYear from every row it made.
 *
 * Returns null when the child has no derivable parent, so the caller counts it
 * rather than writing a malformed row.
 */
function buildParentRow(child, parentSlug) {
  if (!parentSlug || parentSlug === (child.hobbyiqCardId ?? child.id)) return null;
  const {
    _rid, _self, _etag, _attachments, _ts,
    id: _oldId, cardId: _oldCardId, hobbyiqCardId: _oldSlug,
    // The grade dimension is exactly what a parent does not have.
    gradeCompany: _gc, gradeValue: _gv, gradeQualifier: _gq, gradeTier: _gt,
    parentSlug: _ps,
    // Provenance of the CHILD is not provenance of the parent. Re-stamped below
    // so a child seeded from a checklist cannot launder this row into one.
    source: _src, catalogBatch: _cb, confidence: _conf,
    verificationStatus: _vs, builtAt: _ba,
    observedAt: _oa, lastSeenAt: _lsa,
    ...rest
  } = child;

  return {
    ...rest,
    id: parentSlug,
    cardId: parentSlug,
    hobbyiqCardId: parentSlug,
    source: PARENT_SOURCE,
    catalogBatch: CATALOG_BATCH,
    // Derived rows are weak on purpose: below ingest-auto-seed's 0.85 so a real
    // checklist transcription outranks this on both authority and confidence.
    confidence: 0.5,
    catalogVersion: 2,
    // Attested by a graded child, not by a checklist. Never "verified".
    verificationStatus: "provisional",
    derivedFromGradedChild: child.hobbyiqCardId ?? child.id,
    builtAt: new Date().toISOString(),
    // Grade tokens must not survive onto a row that has no grade.
    searchTokens: (rest.searchTokens ?? []).filter(
      (t) => t && !/^(psa|bgs|sgc|cgc|ace|tag|hga|ags)(-|$)/i.test(String(t)) && String(t).toLowerCase() !== "raw",
    ),
  };
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  // ── REFUSALS BEFORE REQUIRES ─────────────────────────────────────────────
  const sport = String(process.env.SPORT || "").trim().toLowerCase();
  const year = Number(process.env.YEAR || 0);
  const setKey = String(process.env.SET_KEY || "").trim().toLowerCase();
  const missing = [];
  if (!sport) missing.push("SPORT");
  if (!Number.isInteger(year) || year <= 0) missing.push("YEAR");
  if (!setKey) missing.push("SET_KEY");
  if (missing.length) {
    console.error(`FATAL: this job refuses to run unscoped — missing ${missing.join(", ")}.`);
    console.error("       sport + year + setKey are all required; there is no whole-catalog mode.");
    process.exit(2);
  }

  console.log(`materialize-ungraded-parents  ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  scope   ${sport} / ${year} / ${setKey}`);
  console.log(`  source  ${PARENT_SOURCE}  (classifies DERIVED — never adjudicates)`);

  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq");
  const cat = db.container("card_catalog");

  const retry = async (fn, tries = 12) => {
    let wait = 1000;
    for (let a = 0; ; a++) {
      try { return await fn(); }
      catch (e) {
        const throttled = /request rate is too large|429/i.test(String(e?.message));
        if (!throttled || a >= tries) throw e;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30000);
      }
    }
  };

  // ── 1. read the scope: every row of this set, graded and not ─────────────
  const rows = [];
  let token;
  do {
    const page = await retry(() => cat.items.query({
      query: `SELECT * FROM c WHERE c.sport=@s AND c.year=@y AND c.setKey=@k`,
      parameters: [{ name: "@s", value: sport }, { name: "@y", value: year }, { name: "@k", value: setKey }],
    }, { maxItemCount: 1000, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    rows.push(...page.resources);
  } while (token);

  // Every id present in the scope. A parent that is already here is NEVER
  // touched -- this job creates, it does not overwrite.
  const present = new Set(rows.map((r) => r.hobbyiqCardId || r.id));

  // ── 2. group graded children by the parent they imply ────────────────────
  // One parent per distinct identity, not one per child: a card with PSA 9 and
  // PSA 10 children is ONE missing parent. (One card, one row, one pool.)
  const wanted = new Map();
  let gradedSeen = 0, unparsable = 0;
  for (const r of rows) {
    if (!r.gradeTier) continue;
    gradedSeen++;
    const parent = cardIdentityKey(r);
    if (!parent || parent === (r.hobbyiqCardId || r.id)) { unparsable++; continue; }
    if (present.has(parent)) continue;              // parent exists — leave it alone
    if (!wanted.has(parent)) wanted.set(parent, r); // first child wins as the template
  }

  console.log(`\n  rows in scope           ${f(rows.length)}`);
  console.log(`  graded children         ${f(gradedSeen)}`);
  console.log(`  ungraded rows present   ${f(rows.length - gradedSeen)}`);
  console.log(`  parents already present ${f(gradedSeen - unparsable - [...wanted.keys()].length)} (untouched)`);
  console.log(`  parents MISSING         ${f(wanted.size)}`);
  if (unparsable) console.log(`  children w/o parseable parent ${f(unparsable)}`);

  let minted = 0, skipped = 0, failed = 0, raced = 0;
  let stopReason = null;
  const sample = [];
  const list = [...wanted.entries()];

  for (let i = 0; i < list.length; i += CONCURRENCY) {
    await Promise.all(list.slice(i, i + CONCURRENCY).map(async ([parentSlug, child]) => {
      try {
        const row = buildParentRow(child, parentSlug);
        if (!row) { skipped++; return; }
        if (sample.length < 5) sample.push(`${parentSlug}  <- ${child.hobbyiqCardId ?? child.id}`);
        if (!APPLY) { minted++; return; }

        // Re-check under APPLY: the scope read is a snapshot, and another job
        // may have minted this parent since. Never overwrite.
        const hit = await retry(() => cat.item(parentSlug, parentSlug).read().catch((e) => {
          if (e.code === 404) return { resource: undefined };
          throw e;
        }));
        if (hit.resource) { raced++; return; }

        // `known: null` tells the write path we already looked -- it skips its
        // own cross-partition fallback scan (CF-DO-NOT-LOOK-TWICE).
        await retry(() => upsertCatalogEntry(row, { known: null }));
        minted++;
      } catch (e) {
        failed++;
        if (failed <= 5) console.error(`  failed ${String(parentSlug).slice(0, 70)}: ${String(e.message || e).slice(0, 70)}`);
      }
    }));
    if (LIMIT && minted >= LIMIT) { stopReason = "limit"; break; }
    if (Date.now() - STARTED > RUN_MS) { stopReason = "budget"; break; }
  }

  if (stopReason === "budget") {
    console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget with work left — the relaunch continues from here`);
  } else if (stopReason === "limit") {
    console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run, not the whole scope`);
  }

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  parents ${APPLY ? "minted" : "would mint"}   ${f(minted)}`);
  console.log(`  existed (raced)         ${f(raced)}`);
  console.log(`  skipped (unbuildable)   ${f(skipped)}`);
  console.log(`  failed                  ${f(failed)}`);
  if (sample.length) {
    console.log(`\n  sample:`);
    for (const s of sample) console.log(`    ${s}`);
  }
  if (APPLY) {
    reportWrites({
      job: "materialize-ungraded-parents",
      intended: wanted.size,
      written: minted,
      skipped: skipped + raced,
      failed,
    });
  }
}

module.exports = { buildParentRow, PARENT_SOURCE, CATALOG_BATCH };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
}
