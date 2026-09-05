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
 *
 * PREREQ: `npm run build`. The dist/ modules below are loaded lazily inside
 * main() (see REFUSALS BEFORE REQUIRES) but they are still required to RUN --
 * and the test suite requires this file, so dist must exist to run the tests
 * too, not only to apply.
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");

// CF-REFUSALS-BEFORE-REQUIRES (#1565). Nothing heavyweight may be required at
// module load. An unscoped invocation has to exit rc=2 saying WHY it refused,
// and it has to do that on a checkout where dist/ was never built and where
// COSMOS_CONNECTION_STRING is unset -- otherwise the operator gets
// MODULE_NOT_FOUND (rc=1), or a missing-conn-string rc=1, and reads either as
// "the tooling is broken" rather than "I forgot the scope". The scope refusal
// is the FIRST thing main() does, before the connection string is even looked
// at and before a single require of @azure/cosmos or dist/.
const lazy = () => ({
  CosmosClient: require("@azure/cosmos").CosmosClient,
  reportWrites: require(path.join(backend, "dist/services/ops/writeReconciliation.js")).reportWrites,
  // CF-ONE-WAY-TO-BUILD-A-CATALOG-ROW. Route through the single write path: it
  // ranks by authority, so a derived parent can never overwrite a checklist row.
  upsertCatalogEntry: require(path.join(backend, "dist/services/portfolioiq/cardCatalog.service.js")).upsertCatalogEntry,
  // CF-CARD-IDENTITY-VS-GRADE. The grade suffix is parsed by the ONE canonical
  // parser, never by a local regex. It is positional (only segment 8) and knows
  // that a card NUMBER of `psa-th2` in segment 4 is not a grade -- the trap that
  // produced 221 false positives when someone last hand-rolled this.
  cardIdentityKey: require(path.join(backend, "dist/services/portfolioiq/cardIdentityKey.service.js")).cardIdentityKey,
});

/** The source these rows carry. Prefix-matched as DERIVED; never checklist. */
const PARENT_SOURCE = "ingest-auto-seed-graded-attested";
const CATALOG_BATCH = "ungraded-parents-2026-08-31";

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 32));
const LIMIT = Number(process.env.LIMIT || 0);
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RUN_MS = RUN_MINUTES * 60000;
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top: a unit costing more than
 *  this is stopped BEFORE it starts. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 2 * 60 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const STARTED = Date.now();

const f = (n) => Number(n).toLocaleString();

/**
 * Write one parent through the production write path.
 *
 * EXTRACTED SO IT IS TESTABLE. The safety claim of this whole job -- "a derived
 * parent can NEVER overwrite an existing row" -- lives entirely in HOW
 * upsertCatalogEntry is called. When that call sat inline in main() the only
 * tests that could reach it called upsertCatalogEntry themselves, so they kept
 * passing no matter what the script did: the shipped `{ known: null }` bug was
 * invisible to a green suite. The call site is a named function now, so a test
 * exercises the same code production runs and a mutation to it goes red.
 *
 * NEVER OVERWRITE -- and the guard has to be REAL. This used to point-read
 * (slug, slug) locally and then pass `{ known: null }`. Both halves were wrong:
 *
 *   1. the local point-read has NO cross-partition fallback, so a row sitting
 *      under a foreign partition key -- the exact condition getCatalogEntry's
 *      fallback exists for -- was invisible to it;
 *   2. `known: null` then told the write path "I checked, it is not there",
 *      which forces existing=null, so mergeCatalogEntries computes
 *      winnerIsIncoming = !existing = TRUE unconditionally and blind-upserts.
 *      The authority ranking NEVER ran on the only path production uses, while
 *      the comment above the call claimed that it did.
 *
 * Passing NO `known` at all is what makes the guard real: upsert does its own
 * getCatalogEntry (point read + cross-partition fallback) and ranks by
 * authority, so an existing checklist row -- or any row this derived
 * 0.5-confidence parent cannot outrank -- wins and is preserved. The cost is a
 * fallback scan on a miss, the correct trade for a job whose safety claim is
 * exactly this.
 *
 * Returns "minted" | "raced" | "failed" so the caller counts what happened
 * rather than assuming a call that returned is a row that was created.
 */
async function writeParent(upsertCatalogEntry, row) {
  const result = await upsertCatalogEntry(row);
  if (!result) return "failed";
  // The write path returns the row that WON. If it is not ours, an existing row
  // was there and kept its identity: a race, not a mint.
  return result.source === PARENT_SOURCE ? "minted" : "raced";
}

/**
 * Choose the template child for a parent, deterministically.
 *
 * "First child wins" made the template a function of Cosmos page order, so a
 * rerun could pick a different child. Lowest child slug is stable across reruns
 * and across page boundaries, which is what makes this job idempotent.
 */
function chooseTemplate(current, candidate) {
  if (!current) return candidate;
  const a = String(candidate.hobbyiqCardId || candidate.id);
  const b = String(current.hobbyiqCardId || current.id);
  return a < b ? candidate : current;
}

/**
 * Compose the ungraded parent's displayName from the parent's OWN identity.
 *
 * WHY THIS IS COMPOSED AND NOT INHERITED. displayName rode the ...rest spread,
 * so every minted parent read as a graded card: measured on prod, 587/587
 * would-be parents carried a grade, e.g. the parent of
 * hiq:basketball:1993:topps-finest:110:base:no-auto got
 *   "1993 1993 Topps Finest Basketball Jamal Mashburn #110 PSA 7"
 * -- the row whose ONLY reason to exist is letting a RAW holding resolve would
 * be displayed to that holder as a PSA 7.
 *
 * Stripping the trailing grade token off the inherited string was the obvious
 * repair and it is the wrong one: these inherited names are independently
 * malformed. Real rows in this very set carry a doubled year ("1993 1993"), and
 * one where a team leaked into playerName. A regex would faithfully preserve
 * all of that and merely drop " PSA 7".
 *
 * So compose from the fields, which are the same fields the slug is built from.
 * A missing piece is simply omitted -- blank means unknown, never a guess
 * (CF-EVERY-INGEST-USES-THE-ONE-CHECKLIST-FORMAT). Parallel is included only
 * when it is a real parallel: "Base" is the absence of one, not a name.
 *
 * THE SET NAME COMES FROM setKey, NOT setName. The first dry run of this
 * function produced "1993 1993 Topps Finest Basketball ..." because prod
 * setName ALREADY embeds the year and the sport, so prefixing our own year
 * duplicated it. Worse, setName is not one value: this single scope holds six
 * spellings -- "1993 Topps Finest Baseball" (555), "1993 Topps Finest
 * Basketball" (501), "1993 topps-finest Baseball" (52), "1993 Topps Finest"
 * (2), "1993 finest Baseball" (2) and a bare "Finest" (1). Composing from a
 * field with six spellings would mint six spellings.
 *
 * setKey is the canonical half of the identity -- it is the segment the slug
 * itself is keyed on (CF-THE-ID-CARRIES-THE-PRODUCT), so it is exactly one
 * value per product. Title-case it and prefix the year once. The sport is not
 * in the name at all: it is already a column, and a name is not the place to
 * restate the partition.
 */
function titleCaseSetKey(setKey) {
  return String(setKey ?? "")
    .trim()
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function parentDisplayName(child) {
  const year = child.year ?? child.cardYear ?? null;
  const set = titleCaseSetKey(child.setKey);
  const player = String(child.playerName ?? "").trim();
  const num = String(child.cardNumber ?? "").trim();
  const par = String(child.parallel ?? "").trim();
  const parts = [];
  if (year) parts.push(String(year));
  if (set) parts.push(set);
  if (player) parts.push(player);
  if (num) parts.push(`#${num.toUpperCase()}`);
  if (par && par.toLowerCase() !== "base") parts.push(par);
  if (child.isAuto === true) parts.push("Auto");
  const printRun = child.printRun ?? null;
  if (typeof printRun === "number" && Number.isFinite(printRun) && printRun > 0) parts.push(`/${printRun}`);
  const out = parts.join(" ").replace(/\s+/g, " ").trim();
  return out || undefined;
}

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
    // gradedIdentitySource says "a GRADED sale proved this pairing" -- it is a
    // statement about the child's tier and is meaningless on a row that has no
    // tier. observedCompCount is the CHILD's comp count; a parent that has
    // observed no comps of its own must not inherit a number claiming it did.
    // Both leaked onto 587/587 rows through ...rest before they were named.
    gradedIdentitySource: _gis, observedCompCount: _occ,
    // Composed below from the parent's own identity, never inherited: the
    // child's name ends in its grade.
    displayName: _dn,
    // Provenance of the CHILD is not provenance of the parent. Re-stamped below
    // so a child seeded from a checklist cannot launder this row into one.
    source: _src, catalogBatch: _cb, confidence: _conf,
    verificationStatus: _vs, builtAt: _ba,
    observedAt: _oa, lastSeenAt: _lsa,
    ...rest
  } = child;

  const displayName = parentDisplayName(child);

  return {
    ...rest,
    ...(displayName ? { displayName } : {}),
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
  // ── REFUSALS BEFORE REQUIRES ─────────────────────────────────────────────
  // The scope refusal comes FIRST -- before the connection string is read and
  // before anything is required. An unscoped run must exit rc=2 naming what is
  // missing even on a checkout with no dist/ and no COSMOS_CONNECTION_STRING,
  // because both of those would otherwise mask the real mistake as an rc=1
  // tooling failure.
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

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  // Scope is valid and we have a connection: only now load the heavyweight
  // dependencies (requires dist/ -- run `npm run build` first).
  const { CosmosClient, reportWrites, upsertCatalogEntry, cardIdentityKey } = lazy();

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
  // The PARENTS that already exist -- distinct identities, not the graded
  // children pointing at them. Counted as a Set for the same reason `wanted` is
  // a Map: a card with PSA 8 / 9 / 10 children is ONE parent, present or not.
  const parentsPresent = new Set();
  let gradedSeen = 0, unparsable = 0;
  for (const r of rows) {
    if (!r.gradeTier) continue;
    gradedSeen++;
    const parent = cardIdentityKey(r);
    if (!parent || parent === (r.hobbyiqCardId || r.id)) { unparsable++; continue; }
    if (present.has(parent)) { parentsPresent.add(parent); continue; } // exists — leave it alone
    wanted.set(parent, chooseTemplate(wanted.get(parent), r));
  }

  console.log(`\n  rows in scope           ${f(rows.length)}`);
  console.log(`  graded children         ${f(gradedSeen)}`);
  console.log(`  ungraded rows present   ${f(rows.length - gradedSeen)}`);
  // Was `gradedSeen - unparsable - wanted.size`, which is graded CHILDREN minus
  // the missing set -- not a count of parents at all. It reported 209/280 where
  // the truth is 3/10, overstating by ~20x the amount of real data exercising
  // the never-overwrite branch.
  console.log(`  parents already present ${f(parentsPresent.size)} (untouched)`);
  console.log(`  parents MISSING         ${f(wanted.size)}`);
  if (unparsable) console.log(`  children w/o parseable parent ${f(unparsable)}`);

  let minted = 0, skipped = 0, failed = 0, raced = 0;
  // CF-INTENDED-IS-COUNTED-WHERE-WRITTEN-IS-COUNTED. `intended` was wanted.size
  // -- the whole pre-loop set -- while `written` stops at a LIMIT or budget
  // break. A legitimate bounded stop then looks like vanished work and
  // reconcileWrites goes red above the 0.5% threshold. Count intent on the same
  // pass that counts the write, so a bounded run reconciles honestly.
  let intended = 0;
  let stopReason = null;
  const sample = [];
  const list = [...wanted.entries()];

  for (let i = 0; i < list.length; i += CONCURRENCY) {
    await Promise.all(list.slice(i, i + CONCURRENCY).map(async ([parentSlug, child]) => {
      intended++;
      try {
        const row = buildParentRow(child, parentSlug);
        if (!row) { skipped++; return; }
        if (sample.length < 5) {
          sample.push(`${parentSlug}  <- ${child.hobbyiqCardId ?? child.id}\n      displayName: ${row.displayName ?? "(none)"}`);
        }
        if (!APPLY) { minted++; return; }

        // The never-overwrite guard lives in writeParent (see its comment).
        const outcome = await retry(() => writeParent(upsertCatalogEntry, row));
        if (outcome === "raced") { raced++; return; }
        if (outcome === "failed") { failed++; return; }
        minted++;
      } catch (e) {
        failed++;
        if (failed <= 5) console.error(`  failed ${String(parentSlug).slice(0, 70)}: ${String(e.message || e).slice(0, 70)}`);
      }
    }));
    if (LIMIT && minted >= LIMIT) { stopReason = "limit"; break; }
    if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; break; }
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
      // Counted inside the loop, so a LIMIT/budget stop reconciles against the
      // work actually attempted rather than against the full scope.
      intended,
      written: minted,
      skipped: skipped + raced,
      failed,
    });
  }
}

module.exports = {
  buildParentRow, parentDisplayName, writeParent, chooseTemplate,
  PARENT_SOURCE, CATALOG_BATCH,
};

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
}
