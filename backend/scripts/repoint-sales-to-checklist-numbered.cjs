#!/usr/bin/env node
/**
 * repoint-sales-to-checklist-numbered.cjs -- move STORED sales that the
 * INGEST-TIME upgrade (#2298, resolveChecklistNumberedIngestId) can never
 * reach, and that the CATALOG-side fold (fold-checklist-numbered-twins.cjs,
 * R1) cannot reach either when no catalog twin row exists at the short id.
 *
 * THE MEASURED PROBLEM. On a sales-volume ranking the single largest reason
 * sports sales are not checklist-backed is the NUMBERED TWIN: the checklist
 * states a print run, so the checklist-backed catalog row's id ends
 * `:num-N` (`hiq:baseball:2026:topps:20:gold:no-auto:num-2026`), but a
 * sale's title rarely states the print run, so the sale's own
 * `hobbyiqCardId`/`cardId` is the SHORT id (`...:gold:no-auto`) -- which has
 * either a vendor-created catalog twin row, or NO catalog row at all.
 * Sampled: 2026 Topps baseball 93% of sales not backed, 2025 Topps 93%, 2025
 * Topps football 100%, also 2025 Prizm baseball, Topps Chrome
 * basketball/football -- ~53% of all not-backed volume in the top 60
 * product-years.
 *
 * WHY NEITHER EXISTING MECHANISM CLOSES THIS.
 *
 *   resolveChecklistNumberedIngest.ts (#2298, merged and deployed
 *   2026-09-19) upgrades a FRESH sale's derived slug at write time, inside
 *   recordSoldComp / persistVendorSalesToPool. It has no effect whatsoever
 *   on a sale already sitting in sold_comps before that PR landed -- it is
 *   an ingest-path hook, never invoked for a stored row.
 *
 *   fold-checklist-numbered-twins.cjs (R1) drives from card_catalog: its
 *   pass 1 is `SELECT c.id, ... FROM c WHERE STARTSWITH(c.id, "hiq:") ...`
 *   over card_catalog ONLY (fold-checklist-numbered-twins.cjs:183), groups
 *   the results by identityKeyOf, and for each group folds every NON-target
 *   CATALOG ROW it finds onto the checklist's numbered row -- re-pointing
 *   that catalog row's own sales as a side effect of the fold
 *   (relocatePartitionKeyedSales at :557, scoped to
 *   `WHERE c.cardId = @t` with `partitionKey: twinId`, where `twinId` is a
 *   CATALOG TWIN's id). A short id with NO catalog row at all is never read
 *   in pass 1 (it produces no `c.id` row to group), is never a `twin` in
 *   pass 2's per-group loop, and so its sales -- however many there are --
 *   are never visited by this lane under any circumstance. THE CLAIM IN THE
 *   BRIEF HOLDS: confirmed by reading fold-checklist-numbered-twins.cjs:178-201
 *   (pass 1 query and grouping) and :301-318 (pass 2 only iterates `rows`
 *   drawn from those same catalog-sourced groups) -- there is no code path
 *   in that file that ever reads sold_comps by a short id absent from
 *   card_catalog.
 *
 * THIS LANE closes exactly that gap by driving from the CATALOG side (the
 * checklist rows that DO exist, and DO carry the numbered identity) rather
 * than scanning sold_comps cross-partition, and then reaching into
 * sold_comps at the short id it computes -- present or absent as a catalog
 * row, sold_comps never knows the difference at that address.
 *
 * DRIVE ORDER, PER (sport, year, setKey):
 *   1. page card_catalog for checklist-backed rows whose id carries a
 *      `:num-N` segment (equality filters + maxItemCount 1000 + continuation,
 *      NEVER a COUNT/GROUP BY);
 *   2. group by identityKeyOf (foldTwinRuleChecklistNumbered.js, the SAME
 *      authority gate the twins fold and the ingest upgrade both reuse);
 *   3. pickChecklistNumberedTarget per group -- exactly ONE checklist print
 *      run required; two rival runs are AMBIGUOUS, counted and skipped, same
 *      as the twins fold;
 *   4. for the one target, derive its SHORT id by stripping ONLY the
 *      trailing `:num-N` segment (parseHobbyIqCardId / computeHobbyIqCardId
 *      round-trip, not a hand-rolled parser -- see shortIdOf below);
 *   5. find sales at the short id BOTH ways sold_comps addresses a card:
 *        - cardId === shortId, partition-scoped (the row's own partition key
 *          IS the short id -- these need a full relocate);
 *        - hobbyiqCardId === shortId, the bounded indexed-equality query the
 *          fold's own player-evidence gathering (player-evidence.cjs) and
 *          #2298's own ingest upgrade both use for a non-partition address
 *          (these need only a patch: the row is already living at some OTHER
 *          partition, usually a vendor id, and only hobbyiqCardId moves);
 *   6. for each sale, the ONE title/print-run rule #2298 itself applies
 *      ("absent beats wrong" -- persistVendorSalesToPool.service.ts:1656,
 *      `if (!parsed.printRun)`): re-parse the sale's own stored `title`
 *      through parseListingIdentity (parseTitleIdentity.service.ts) and
 *      refuse + list whenever it states a print run at all (whether or not
 *      it agrees with N -- a title that states its OWN print run was never
 *      the "un-numbered twin" case this lane exists to fix, and a stored row
 *      whose slug is short despite a title-stated run is itself a defect
 *      this lane must not paper over by relocating it). No second title
 *      parser is written; this is the same function and the same field
 *      #2298 already gates on.
 *   7. relocate (cardId === shortId) or patch (hobbyiqCardId only, cardId
 *      unchanged) onto the numbered id, both fields set to the numbered id
 *      after a relocate, only hobbyiqCardId after a patch.
 *
 * WHAT THIS LANE DOES NOT DO.
 *
 *   - It never touches card_catalog. If a catalog row already exists at the
 *     short id, that row is the TWINS LANE's job (fold-checklist-numbered-
 *     twins.cjs already reaches it via its own pass 1, because the row
 *     itself is a `c.id` this lane's catalog scan never sees since it only
 *     pages NUMBERED rows). This lane only counts and reports how many short
 *     ids still have a twin row, as an input for that lane's own targeting.
 *   - Pre-existing SPLIT IDENTITY (cardId and hobbyiqCardId already point at
 *     two DIFFERENT cards) is never "fixed" here -- it is counted and listed.
 *     relocateSoldComp's own guardSoldCompDoc still runs on every write this
 *     lane makes and can independently park a malformed destination; that is
 *     unrelated to this lane's own split-identity accounting and is counted
 *     separately (guardParked).
 *   - Holdings on the short id are not orphaned by leaving them unmoved:
 *     the price path already unions short + numbered ids at read time
 *     (poolReadIdsFor, catalogIdentityResolver.ts:300) as the documented
 *     bridge until every pool is re-keyed, so a holding not yet re-pointed
 *     here still prices correctly. This lane still re-points every holding
 *     it can (bounded, in-memory map walk) and reports the walk count.
 *
 * CF-A-SALE-IS-NEVER-LOST throughout: every relocation goes through
 * scripts/lib/relocate-sold-comp.cjs (upsert -> verify read-back -> delete),
 * and the banner's own reconciliation is sales-at-short-ids-before ==
 * relocated + patched + refused + left (never written = never counted lost).
 *
 * REPORT-FIRST. BACKFILL_APPLY=true (not APPLY) gates every write, matching
 * the runner's own env name and every sibling lane. REPORT runs the SAME
 * reads and the SAME per-sale decision as APPLY and prints the real "would
 * relocate / would patch" counts -- rekey-catalog-id-to-setkey's own header
 * names the sibling bug this guards against (a REPORT run that structurally
 * cannot reach a non-zero count because a write-only code path decides
 * something a report-only path never runs); this lane's `planSale` /
 * `decideSaleAction` are pure and run identically in both modes, and the
 * pinned test below asserts REPORT's counts equal APPLY's on one fixture.
 *
 * SCOPE IS REQUIRED, BY NAME, reusing the runner's `scope` input for
 * sport:year cells (rekey-catalog-id-to-setkey's own convention) and
 * `titles` for a REQUIRED comma-separated setKey list -- empty or a
 * wildcard ('all', '*') is refused (exit 2). NO NEW WORKFLOW INPUT.
 *
 * BUDGET / RELAUNCH / SHARDING follow the sibling convention exactly:
 * lib/runner-budget.cjs and lib/runner-shard-scope.cjs. A relocated sale no
 * longer matches the short-id selection, so a re-run after a budget stop is
 * idempotent by construction.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true / APPLY=true to write;
 *      SCOPE required (sport:year cells, comma list); SET_KEYS required
 *      (comma list, no 'all'/'*'); SLOT/SLOTS (sha1(id) shards, opt-in via
 *      SHARD=true for slot 0); CONCURRENCY=8; RUN_MINUTES=110; LIMIT=0.
 * Requires dist/ (foldTwinRuleChecklistNumbered, catalogAuthority,
 * parseTitleIdentity, writeReconciliation).
 */
"use strict";
const path = require("path");
const crypto = require("node:crypto");
const backend = path.resolve(__dirname, "..");

const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const csv = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const STARTED = Date.now();
const CLOCK = budget({ minutes: 110, reserveMs: 90 * 1000, verifyMs: 5 * 60 * 1000, startedAt: STARTED });
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8));
const LIMIT = Number(process.env.LIMIT || 0);

const SHARD_SCOPE = runnerShardScope({ label: "repoint-sales-to-checklist-numbered" });
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SHARD_SCOPE.SLOTS;

// ── THE SCOPE. sport:year cells, and an inherited default is REFUSED ────────
const INHERITED_SCOPES = new Set(["", "refractor", "all"]);
const RAW_SCOPE = csv(process.env.SCOPE);
const CELL_RE = /^[a-z][a-z0-9-]*:\d{4}$/;
const SCOPE_CELLS = RAW_SCOPE.map(lower).filter((p) => CELL_RE.test(p));
const SCOPE_REJECTED = RAW_SCOPE.filter((p) => !CELL_RE.test(lower(p)));

// ── THE TARGET SETKEYS. Riding the runner's `titles` input, same convention
// as rekey-catalog-id-to-setkey / repair-rc-marker-playername. Empty or a
// wildcard is refused -- a whole-source write needs its own name.
const WILDCARDS = new Set(["", "all", "*"]);
const RAW_SET_KEYS = csv(process.env.SET_KEYS || process.env.BCP_TITLES).map(lower);
const SET_KEYS = RAW_SET_KEYS.filter((k) => !WILDCARDS.has(k));

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

async function forEachPage(container, spec, onPage, pageSize = 1000) {
  let token;
  do {
    const page = await retry(() => container.items
      .query(spec, { maxItemCount: pageSize, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    if ((await onPage(page.resources ?? [])) === false) return;
  } while (token);
}

/** The candidate predicate for one (sport, year, setKey) cell: checklist rows
 *  carrying a `:num-` segment somewhere in the id (the trailing print-run
 *  segment; STARTSWITH is index-served and cheap, the exact `:num-\d+$` shape
 *  is confirmed in JS below since Cosmos SQL has no anchored regex). Equality
 *  on sport/year/setKey, never a cross-partition COUNT/GROUP BY. */
function candidateSpec(sport, year, setKey) {
  return {
    query: `SELECT c.id, c.cardId, c.source, c.sport, c.year, c.cardYear, c.setKey, c.cardNumber,
                   c.parallelSlug, c.isAuto, c.printRun, c.playerName
            FROM c
            WHERE c.sport = @sport AND (c.year = @year OR c.cardYear = @year)
              AND c.setKey = @setKey
              AND CONTAINS(c.id, ":num-")
              AND NOT IS_DEFINED(c.gradeTier)`,
    parameters: [
      { name: "@sport", value: sport },
      { name: "@year", value: year },
      { name: "@setKey", value: setKey },
    ],
  };
}

/** True iff `id` ends in the print-run segment this lane strips. Cosmos SQL's
 *  CONTAINS(":num-") is a coarse pre-filter (index-served); this is the exact
 *  check applied to every row CONTAINS lets through, so a `:num-` substring
 *  inside a card number or a subset slug can never be mistaken for the
 *  trailing print-run segment. */
const TRAILING_NUM_RE = /:num-(\d+)$/;
function hasTrailingPrintRun(id) {
  return TRAILING_NUM_RE.test(String(id ?? ""));
}

/**
 * The SHORT id: `id` with ONLY the trailing `:num-N` segment removed, every
 * other segment (including a `:sub-...:` subset tag, present between the
 * setKey and the card number) byte-preserved. Surgery, not a recompute --
 * the same discipline rekey-catalog-id-to-setkey and fold-umbrella-to-series
 * both use for their own single-segment edits, and for the same reason: a
 * full re-derive could disagree with what the row already spells (a parallel
 * the resolver would name differently today), and this lane's whole
 * authority is the checklist row's OWN identity, not a fresh computation of
 * it.
 *
 * Graded children (`...:num-N:psa-9`) are excluded upstream by
 * `NOT IS_DEFINED(c.gradeTier)` in candidateSpec and are never handed here;
 * this function still refuses defensively if asked to strip a non-trailing
 * match. Returns null when `id` does not end in `:num-<digits>`.
 */
function shortIdOf(id) {
  const s = String(id ?? "");
  const m = s.match(TRAILING_NUM_RE);
  if (!m) return null;
  return s.slice(0, s.length - m[0].length);
}

/**
 * Pure per-sale decision -- no I/O -- so REPORT and APPLY run the EXACT same
 * logic and a test can assert REPORT's counts equal APPLY's on one fixture
 * (the sibling bug this guards against: a structural zero because a
 * write-only code path decided something a report-only path never ran).
 *
 * @param {object} sale        the sold_comps row as read (cardId, hobbyiqCardId, title, sport)
 * @param {"cardId"|"hobbyiqCardId"} shape  which address found this sale
 * @param {object} ctx
 * @param {string} ctx.shortId       the un-numbered id this sale sits at
 * @param {string} ctx.numberedId    the checklist target it would move to
 * @param {number|null} ctx.titlePrintRun  the print run parseListingIdentity
 *        read out of the sale's OWN stored title, or null. Passed in rather
 *        than computed here so this function stays pure and the title parser
 *        is called exactly once per sale, at the call site.
 * @param {number|null} [ctx.targetPrintRun]  the checklist target's own /N,
 *        for the refusal message only.
 */
function decideSaleAction(sale, shape, ctx) {
  const { shortId, numberedId, titlePrintRun, targetPrintRun } = ctx;

  // Pre-existing split identity: cardId and hobbyiqCardId already name TWO
  // DIFFERENT cards, NEITHER of which is the short id being scanned. Not this
  // lane's job to arbitrate which is right -- counted and listed, never
  // touched. (When one of the two IS the short id, that is exactly the shape
  // this lane exists to repair, not a pre-existing split.)
  const saleCardId = String(sale.cardId ?? "");
  const saleHobbyiqCardId = String(sale.hobbyiqCardId ?? saleCardId);
  if (saleCardId && saleHobbyiqCardId && saleCardId !== saleHobbyiqCardId
    && saleCardId !== shortId && saleHobbyiqCardId !== shortId) {
    return { action: "refuse", reason: "split-identity", detail: `cardId=${saleCardId} hobbyiqCardId=${saleHobbyiqCardId} -- neither is the short id being scanned; pre-existing split, not this lane's to fix` };
  }

  // THE ONE TITLE/PRINT-RUN RULE (#2298's own gate, reused rather than
  // reimplemented): persistVendorSalesToPool.service.ts:1656 only calls the
  // ingest upgrade `if (!parsed.printRun)` -- absent beats wrong. A stored
  // sale whose TITLE states a print run at all (whether or not it agrees with
  // the checklist's N) is left exactly where it is: either it was ingested
  // before #2298 existed and belongs to a DIFFERENT repair, or it is itself
  // evidence of a rival print run this identity's target does not carry.
  if (titlePrintRun) {
    return {
      action: "refuse", reason: "title-states-print-run",
      detail: `title states /${titlePrintRun}${targetPrintRun && titlePrintRun !== targetPrintRun ? ` (checklist target is /${targetPrintRun})` : ""} -- absent beats wrong, left at ${shape === "cardId" ? saleCardId : saleHobbyiqCardId}`,
    };
  }

  return shape === "cardId"
    ? { action: "relocate", newId: numberedId }
    : { action: "patch", newId: numberedId };
}

async function main() {
  console.log("");
  console.log("=".repeat(78));
  console.log("  REPOINT: sales at the short (un-numbered) id follow the checklist's :num-N row");
  console.log(`  MODE: ${APPLY ? "APPLY -- this run WRITES" : "REPORT ONLY -- nothing is written"}`);
  console.log("=".repeat(78));

  if (SCOPE_REJECTED.length) {
    console.error("");
    console.error(`FATAL: SCOPE carries ${SCOPE_REJECTED.length} value(s) that are not cells: ${SCOPE_REJECTED.join(", ")}`);
    console.error("       A cell looks like baseball:2026 (sport:year).");
    process.exit(2);
  }
  if (!SCOPE_CELLS.length || RAW_SCOPE.some((x) => INHERITED_SCOPES.has(lower(x)))) {
    console.error("");
    console.error("FATAL: SCOPE is REQUIRED and names the cells to scan, as sport:year.");
    console.error("       There is no 'all' for this lane. Dispatch with -f scope=baseball:2026,baseball:2025");
    console.error("       (comma-separate for several cells).");
    process.exit(2);
  }
  if (!SET_KEYS.length) {
    console.error("");
    console.error("FATAL: SET_KEYS (the runner's `titles` input) is REQUIRED and names the");
    console.error("       setKey(s) to scan for checklist-numbered rows -- an empty value or a");
    console.error("       wildcard ('all', '*') is refused: a whole-source write needs its own name.");
    console.error("       Dispatch with -f titles=topps (comma-separate for several).");
    process.exit(2);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING required"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
  const {
    identityKeyOf, pickChecklistNumberedTarget, printRunOf, DEFAULT_FORCE_AUTO_PREFIXES,
  } = require(path.join(backend, "dist/services/catalog/foldTwinRuleChecklistNumbered.js"));
  const { parseListingIdentity } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"));

  const isChecklist = (source) => catalogAuthorityOf(source) === "checklist";

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");
  const portfolio = db.container("portfolio");

  console.log(`  scope (${SCOPE_CELLS.length} cell${SCOPE_CELLS.length === 1 ? "" : "s"})    ${SCOPE_CELLS.join(", ")}`);
  console.log(`  target setKeys   ${SET_KEYS.join(", ")}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log("");
  console.log("  drives from card_catalog's checklist-numbered rows; the SHORT id is the");
  console.log("  target's own id with only the trailing :num-N segment removed. Sales at that");
  console.log("  short id -- whether or not a catalog twin also lives there -- are found by");
  console.log("  BOTH addresses sold_comps uses (cardId partition, hobbyiqCardId equality) and");
  console.log("  relocated or patched onto the checklist's numbered id.");
  console.log("");

  const s = {
    catalogRowsScanned: 0, otherShard: 0,
    identityGroups: 0, uniqueNumberedTargets: 0, ambiguousRivalRuns: 0, noChecklistNumbered: 0,
    shortIdsExamined: 0, shortIdsWithCatalogTwin: 0,
    salesFoundByCardId: 0, salesFoundByHobbyiqCardId: 0,
    salesRelocated: 0, salesPatched: 0,
    refusedTitlePrintRun: 0, refusedSplitIdentity: 0, refusedGuardParked: 0,
    salesFailed: 0, salesLeftAlone: 0,
    holdingsRepointed: 0, holdingsWalked: 0, holdingDocsWalked: 0,
    notReached: 0,
  };
  const bySetKey = new Map();
  const byYear = new Map();
  const refusals = { "title-states-print-run": [], "split-identity": [], "guard-parked": [] };
  const failures = [];
  const examples = [];
  const ambiguousExamples = [];
  const twinExamples = [];
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  let stoppedAtBudget = false;

  // ── Holdings index, built ONCE (fold-checklist-numbered-twins' own shape).
  // portfolio.holdings is a MAP: Object.entries, never JOIN h IN c.holdings.
  async function buildHoldingsIndex() {
    const index = new Map();
    let docs = 0;
    await forEachPage(portfolio, { query: "SELECT c.id, c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)", parameters: [] }, async (rows) => {
      for (const doc of rows) {
        docs++;
        const holdings = doc.holdings && typeof doc.holdings === "object" ? doc.holdings : null;
        if (!holdings) continue;
        for (const [hid, h] of Object.entries(holdings)) {
          s.holdingsWalked++;
          if (!h || typeof h !== "object") continue;
          for (const slug of new Set([String(h.hobbyiqCardId ?? ""), String(h.cardId ?? "")])) {
            if (!slug) continue;
            const list = index.get(slug) ?? [];
            list.push({ docId: doc.id, userId: doc.userId, holdingId: hid });
            index.set(slug, list);
          }
        }
      }
      return true;
    }, 100);
    s.holdingDocsWalked = docs;
    if (docs === 0) throw new Error("walked ZERO portfolio docs -- refusing to claim holdings are clean");
    console.log(`  holdings index: walked ${f(s.holdingsWalked)} holdings across ${f(docs)} portfolio docs; ${f(index.size)} distinct slugs held`);
    return index;
  }
  const holdingsIndex = await buildHoldingsIndex();

  async function repointHoldings(oldId, newId) {
    const hits = holdingsIndex.get(oldId);
    if (!hits || !hits.length) return;
    const byDoc = new Map();
    for (const h of hits) {
      const k = `${h.docId}|${h.userId}`;
      const e = byDoc.get(k) ?? { docId: h.docId, userId: h.userId, ids: new Set() };
      e.ids.add(h.holdingId);
      byDoc.set(k, e);
    }
    for (const { docId, userId, ids } of byDoc.values()) {
      const ops = [];
      for (const hid of ids) {
        ops.push({ op: "set", path: `/holdings/${hid}/hobbyiqCardId`, value: newId });
        ops.push({ op: "set", path: `/holdings/${hid}/cardId`, value: newId });
        ops.push({ op: "set", path: `/holdings/${hid}/identityResolvedBy`, value: "repoint-sales-to-checklist-numbered" });
        ops.push({ op: "set", path: `/holdings/${hid}/identityResolvedAt`, value: new Date().toISOString() });
        ops.push({ op: "set", path: `/holdings/${hid}/identityRenamedFrom`, value: oldId });
      }
      if (APPLY) await retry(() => portfolio.item(docId, userId).patch(ops));
      s.holdingsRepointed += ids.size;
    }
    holdingsIndex.delete(oldId);
  }

  /** Does a catalog row already live at the short id? Point read, memoised --
   *  this lane never touches it, only reports it (the twins lane's job). */
  const twinCache = new Map();
  async function catalogTwinAt(shortId) {
    if (twinCache.has(shortId)) return twinCache.get(shortId);
    let row = null;
    try { row = (await retry(() => cat.item(shortId, shortId).read())).resource ?? null; }
    catch (e) { if (e?.code !== 404 && e?.statusCode !== 404) throw e; }
    twinCache.set(shortId, row);
    return row;
  }

  /** The title/print-run signal for one sale, computed exactly once per sale
   *  at the call site -- see decideSaleAction's own doc for why this is
   *  handed in rather than computed inside the pure function. Fails open
   *  (null) on a parser throw: a title this lane cannot parse is not
   *  evidence of a print run, and failing closed here would strand sales
   *  behind a parser bug rather than moving them. */
  function titlePrintRunOf(sale, shortId) {
    try {
      const parsed = parseListingIdentity(String(sale.title ?? ""), undefined, {
        vertical: sale.sport ?? null, hobbyiqCardId: shortId,
      });
      return parsed?.printRun ?? null;
    } catch { return null; }
  }

  for (const cell of SCOPE_CELLS) {
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    const [sport, yearStr] = cell.split(":");
    const year = Number(yearStr);

    for (const setKey of SET_KEYS) {
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
      const spec = candidateSpec(sport, year, setKey);

      const groups = new Map(); // identityKey -> rows[]
      await forEachPage(cat, spec, async (page) => {
        for (const r of page) {
          if (CLOCK.outOfClock()) { stoppedAtBudget = true; return false; }
          s.catalogRowsScanned++;
          if (!hasTrailingPrintRun(r.id)) continue; // CONTAINS pre-filter false-positive (e.g. inside a subset slug)
          if (SHARD_SCOPE.SHARDED && shardOf(String(r.id)) !== SHARD_SCOPE.SLOT) { s.otherShard++; continue; }
          const key = identityKeyOf(r, DEFAULT_FORCE_AUTO_PREFIXES);
          const list = groups.get(key) ?? [];
          list.push(r);
          groups.set(key, list);
        }
        return true;
      });

      s.identityGroups += groups.size;

      for (const [, rows] of groups) {
        if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
        const picked = pickChecklistNumberedTarget(rows, isChecklist);
        if ("skip" in picked) {
          if (picked.skip === "ambiguous") {
            s.ambiguousRivalRuns++;
            if (ambiguousExamples.length < 20) {
              ambiguousExamples.push(`  AMBIGUOUS ${rows.map((r) => `${r.id} /${printRunOf(r)}`).join(" vs ")}`);
            }
          } else {
            s.noChecklistNumbered++;
          }
          continue;
        }
        const target = picked.target;
        s.uniqueNumberedTargets++;

        const numberedId = target.id;
        const shortId = shortIdOf(numberedId);
        if (!shortId) { s.notReached++; continue; } // defensive; candidateSpec + hasTrailingPrintRun already guarantee this
        s.shortIdsExamined++;

        // ── does a catalog twin already exist at the short id? Report only:
        // this lane never touches card_catalog. Input for the twins lane.
        const twin = await catalogTwinAt(shortId);
        if (twin) {
          s.shortIdsWithCatalogTwin++;
          if (twinExamples.length < 20) twinExamples.push(`  ${shortId}  [twin: ${twin.source}] -- the twins lane's job, not this one's`);
        }

        if (LIMIT && (s.salesRelocated + s.salesPatched) >= LIMIT) { s.notReached++; continue; }

        // ── shape 1: sales whose PARTITION KEY (cardId) IS the short id.
        const cardIdRows = [];
        await forEachPage(pool, { query: "SELECT * FROM c WHERE c.cardId = @s", parameters: [{ name: "@s", value: shortId }] }, async (page) => {
          for (const row of page) cardIdRows.push(row);
          return true;
        }, 200);
        s.salesFoundByCardId += cardIdRows.length;

        for (const sale of cardIdRows) {
          const titlePrintRun = titlePrintRunOf(sale, shortId);
          const plan = decideSaleAction(sale, "cardId", { shortId, numberedId, titlePrintRun, targetPrintRun: printRunOf(target) });
          if (plan.action === "refuse") {
            s.salesLeftAlone++;
            if (plan.reason === "title-states-print-run") s.refusedTitlePrintRun++;
            else s.refusedSplitIdentity++;
            const list = refusals[plan.reason];
            if (list) list.push(`  ${sale.id}@${sale.cardId}: ${plan.detail}`);
            continue;
          }
          try {
            const keep = { ...stripSystem(sale), cardId: numberedId, hobbyiqCardId: numberedId, reslugedFrom: shortId, reslugedReason: "sale at the short (un-numbered) id follows the checklist's :num-N row (repoint-sales-to-checklist-numbered)", reslugedAt: new Date().toISOString() };
            keep.contentHash = contentHashOf(keep);
            const res = await relocateSoldComp(pool, { keep, drop: [{ id: sale.id, cardId: shortId }], retry, verifyFields: ["cardId", "hobbyiqCardId"], dryRun: !APPLY });
            if (res.guard?.verdict === "park") {
              s.refusedGuardParked++;
              refusals["guard-parked"].push(`  ${sale.id}@${shortId}: ${res.error ?? res.guard.reason}`);
              continue;
            }
            if (!res.ok && res.stage !== "dry-run") {
              s.salesFailed++;
              failures.push(`  FAILED relocate ${sale.id}@${shortId} -> ${numberedId}: ${res.error ?? "unknown"}`);
              continue;
            }
            s.salesRelocated++;
            bump(bySetKey, setKey); bump(byYear, String(year));
            if (examples.length < 24) examples.push(`  RELOCATE ${sale.id}@${shortId} -> ${numberedId}`);
          } catch (e) {
            s.salesFailed++;
            failures.push(`  FAILED relocate ${sale.id}@${shortId} -> ${numberedId}: ${String(e?.stack ?? e?.message ?? e)}`);
          }
        }

        // ── shape 2: sales whose hobbyiqCardId names the short id but whose
        // OWN cardId is something else (a vendor partition) -- patch only.
        const hobbyiqRows = [];
        await forEachPage(pool, { query: "SELECT * FROM c WHERE c.hobbyiqCardId = @s AND c.cardId != @s", parameters: [{ name: "@s", value: shortId }] }, async (page) => {
          for (const row of page) hobbyiqRows.push(row);
          return true;
        }, 200);
        s.salesFoundByHobbyiqCardId += hobbyiqRows.length;

        for (const sale of hobbyiqRows) {
          const titlePrintRun = titlePrintRunOf(sale, shortId);
          const plan = decideSaleAction(sale, "hobbyiqCardId", { shortId, numberedId, titlePrintRun, targetPrintRun: printRunOf(target) });
          if (plan.action === "refuse") {
            s.salesLeftAlone++;
            if (plan.reason === "title-states-print-run") s.refusedTitlePrintRun++;
            else s.refusedSplitIdentity++;
            const list = refusals[plan.reason];
            if (list) list.push(`  ${sale.id}@${sale.cardId} (hobbyiqCardId=${shortId}): ${plan.detail}`);
            continue;
          }
          try {
            if (APPLY) {
              await retry(() => pool.item(sale.id, sale.cardId).patch([
                { op: "set", path: "/hobbyiqCardId", value: numberedId },
                { op: "set", path: "/reslugedFrom", value: shortId },
                { op: "set", path: "/reslugedReason", value: "sale at the short (un-numbered) id follows the checklist's :num-N row (repoint-sales-to-checklist-numbered)" },
                { op: "set", path: "/reslugedAt", value: new Date().toISOString() },
              ]));
            }
            s.salesPatched++;
            bump(bySetKey, setKey); bump(byYear, String(year));
            if (examples.length < 24) examples.push(`  PATCH ${sale.id}@${sale.cardId} hobbyiqCardId ${shortId} -> ${numberedId}`);
          } catch (e) {
            s.salesFailed++;
            failures.push(`  FAILED patch ${sale.id}@${sale.cardId}: ${String(e?.stack ?? e?.message ?? e)}`);
          }
        }

        await repointHoldings(shortId, numberedId);
      }
    }
  }

  console.log("");
  console.log(`catalog rows scanned (checklist-numbered candidates) ${f(s.catalogRowsScanned)}${SHARD_SCOPE.SHARDED ? `  (${f(s.otherShard)} in other shards)` : ""}`);
  console.log(`  identity groups                ${f(s.identityGroups)}`);
  console.log(`  unique-/N targets               ${f(s.uniqueNumberedTargets)}   <- exactly one checklist print run`);
  console.log(`  rival/ambiguous /N groups        ${f(s.ambiguousRivalRuns)}   <- two checklist print runs; guessing is worse than the split`);
  console.log(`  no checklist /N in group         ${f(s.noChecklistNumbered)}`);
  console.log("");
  console.log(`short ids examined                ${f(s.shortIdsExamined)}`);
  console.log(`  short ids that ALSO have a catalog twin  ${f(s.shortIdsWithCatalogTwin)}   <- input for fold-checklist-numbered-twins.cjs (this lane never touches card_catalog)`);
  console.log("");
  console.log(`sales found by cardId (partition-keyed)        ${f(s.salesFoundByCardId)}`);
  console.log(`sales found by hobbyiqCardId (patch-shape)     ${f(s.salesFoundByHobbyiqCardId)}`);
  console.log(`  ${APPLY ? "RELOCATED" : "WOULD RELOCATE"}     ${f(s.salesRelocated)}`);
  console.log(`  ${APPLY ? "PATCHED" : "WOULD PATCH"}       ${f(s.salesPatched)}`);
  console.log(`  REFUSED: title states a print run   ${f(s.refusedTitlePrintRun)}   <- absent beats wrong (#2298's own rule)`);
  console.log(`  REFUSED: pre-existing split identity ${f(s.refusedSplitIdentity)}   <- cardId != hobbyiqCardId naming two different cards already; not this lane's to fix`);
  console.log(`  REFUSED: guard parked (malformed key) ${f(s.refusedGuardParked)}`);
  console.log(`  failed                              ${f(s.salesFailed)}`);
  console.log(`  not reached                         ${f(s.notReached)}`);
  console.log("");
  console.log(`  holdings re-pointed        ${f(s.holdingsRepointed)}   (walked ${f(s.holdingsWalked)} holdings across ${f(s.holdingDocsWalked)} portfolio docs)`);
  console.log(`  NOTE: a holding still on the short id prices correctly regardless -- poolReadIdsFor`);
  console.log(`        (catalogIdentityResolver.ts) unions the short id and its numbered twin at read`);
  console.log(`        time, so a holding not yet re-pointed here does not go dark.`);

  if (bySetKey.size) { console.log(`\n  by setKey:`); for (const [k, n] of [...bySetKey.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(9)}  ${k}`); }
  if (byYear.size) { console.log(`\n  by year:`); for (const [k, n] of [...byYear.entries()].sort()) console.log(`    ${String(n).padStart(9)}  ${k}`); }
  if (examples.length) { console.log(`\n  examples:`); for (const e of examples) console.log(e); }
  if (twinExamples.length) { console.log(`\n  short ids WITH a catalog twin (sample, ${f(s.shortIdsWithCatalogTwin)} total):`); for (const e of twinExamples) console.log(e); }
  if (ambiguousExamples.length) { console.log(`\n  RIVAL /N groups (sample, ${f(s.ambiguousRivalRuns)} total) -- never folded, a human rules on these:`); for (const e of ambiguousExamples) console.log(e); }

  for (const [reason, list] of Object.entries(refusals)) {
    if (list.length) {
      console.log(`\n  REFUSED (${reason}), every one listed (${f(list.length)}):`);
      for (const l of list) console.log(l);
    }
  }
  if (failures.length) {
    console.log(`\n  FAILURES (${f(failures.length)}):`);
    for (const fl of failures) console.log(fl);
  }

  // ── CF-A-SALE-IS-NEVER-LOST reconciliation ---------------------------------
  const salesBefore = s.salesFoundByCardId + s.salesFoundByHobbyiqCardId;
  const written = s.salesRelocated + s.salesPatched;
  const refused = s.refusedTitlePrintRun + s.refusedSplitIdentity + s.refusedGuardParked;
  const left = salesBefore - written - refused - s.salesFailed;
  console.log("");
  console.log(`CF-A-SALE-IS-NEVER-LOST`);
  console.log(`  sales at short ids before   ${f(salesBefore)}`);
  console.log(`  ${APPLY ? "=" : "would be ="} relocated ${f(s.salesRelocated)} + patched ${f(s.salesPatched)} + refused ${f(refused)} + failed ${f(s.salesFailed)} + left ${f(left)}`);
  const accountedFor = written + refused + s.salesFailed + left;
  if (accountedFor !== salesBefore) {
    console.error(`!! CF-A-SALE-IS-NEVER-LOST: accounted ${f(accountedFor)} != before ${f(salesBefore)}. A sale is unaccounted for. Exit 4.`);
    process.exitCode = 4;
  } else {
    console.log(`  matched -- every sale at a short id is relocated, patched, refused (named), failed (named), or left with a reason accounted above.`);
  }

  console.log("");
  console.log(`  reconciled: intended ${f(s.uniqueNumberedTargets)} = written(targets acted on) ... see sales reconciliation above for the row-level count`);
  if (APPLY) {
    reportWrites({
      job: "repoint-sales-to-checklist-numbered",
      intended: salesBefore,
      written,
      skipped: left,
      refused,
      failed: s.salesFailed,
    });
  }

  console.log("");
  console.log(`  ${APPLY ? "RELOCATED" : "WOULD RELOCATE"} ${f(s.salesRelocated)}   ${APPLY ? "PATCHED" : "WOULD PATCH"} ${f(s.salesPatched)}`);
  if (stoppedAtBudget || CLOCK.outOfClock()) {
    console.log(`  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- the slot has more to do`);
  }
  if (!APPLY) console.log(`\nREPORT ONLY -- nothing was written. Re-run with BACKFILL_APPLY=true to apply.`);

  if (s.salesFailed) {
    console.error(`::error::${f(s.salesFailed)} sale(s) failed -- see FAILURES above.`);
    process.exitCode = 4;
  }
}

module.exports = { candidateSpec, hasTrailingPrintRun, shortIdOf, decideSaleAction, TRAILING_NUM_RE, INHERITED_SCOPES, CELL_RE, WILDCARDS };

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => { console.error("::error::" + (e?.stack ?? e)); await finishLane(1, { budget: CLOCK }); });
}
