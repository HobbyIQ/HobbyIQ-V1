#!/usr/bin/env node
/**
 * rekey-catalog-id-to-setkey.cjs -- a checklist row's id catches up to its
 * own setKey field.
 *
 * CF-THE-ID-FOLLOWS-ITS-OWN-SETKEY-FIELD (2026-09-19, hockey pilot).
 *
 * THE DEFECT (measured, read-only). 127,210 checklist-sourced card_catalog
 * rows for hockey carry a setKey FIELD that is right --
 * `upper-deck-extended-series`, `upper-deck-the-cup`, `upper-deck-premier`,
 * `upper-deck-allure`, `upper-deck-credentials`, `upper-deck-artifacts`,
 * `upper-deck-chl`, ~26 sub-brands in all -- while segment 3 of their id
 * (`hiq:<sport>:<year>:<setKey>:<cardNumber>:<parallel>:<auto>[:num-N][:grade]`)
 * still says the bare umbrella `upper-deck`. They came from three
 * checklistinsider ingests (checklistinsider-2026-08-27/-28/-29). A fresh
 * sale derives the CORRECT product id (D23, CF-THE-ID-CARRIES-THE-PRODUCT)
 * and finds no catalog row there -- the checklist row that should answer it
 * is squatting one segment off, under the umbrella.
 *
 * THIS IS THE MIRROR OF fold-umbrella-to-series.cjs, not a copy of it. That
 * lane moves POOL rows by TITLE evidence (a sale has no setKey field to
 * trust). This lane moves CATALOG rows, and every one of them ALREADY
 * CARRIES the correct answer in its own setKey field -- checklistinsider
 * wrote the field right and the id-minting deriver collapsed the id (the
 * exact D23 defect, on products the registry had no row for at ingest time).
 * No title parsing, no ambiguity gate: the row's own field is the ruling.
 *
 * WHY moveCatalogRow NEEDED A NEW OPTION. Its cross-product guard in
 * `buildIncoming` (catalogRowOps.service.ts) refuses whenever newSlug's
 * setKey segment disagrees with the row's id stem and the caller passed no
 * `changedFields.setKey` -- CF-CANDIDATE-ID-IS-WHAT-WE-ADOPT, added so a FOLD
 * (a renumber, a parallel fix) can never silently change a product. That is
 * exactly backwards for this lane's one job: the product IS changing, on the
 * id, to what the row's OWN field already says -- neither a fold (nothing
 * about the card is staying the same address) nor a rename (nobody is asking
 * for a NEW product name; the id is simply catching up to a field the row has
 * carried all along). `idFollowsOwnSetKeyField: true` is the new, narrowly
 * validated option: moveCatalogRow re-derives newSlug from oldRow itself and
 * throws unless it is EXACTLY "the row's id with segment 3 replaced by the
 * row's own setKey field, nothing else." Every other caller is unaffected --
 * the option is opt-in and off by default.
 *
 * THIS LANE FIXES A ONE-LEVEL DRIFT ONLY. The defect is exactly one segment:
 * the id's segment 3 still names the target's REGISTERED IMMEDIATE PARENT
 * (`productParentOf(target)`), while the setKey field already names the
 * target. A row whose id segment names something else -- a grandparent, an
 * unrelated product, a stale spelling two renames back -- is a DIFFERENT
 * drift this lane does not attempt to fix; it is counted and listed
 * (`not-one-level-drift`) rather than silently moved on weaker evidence than
 * this lane was measured against. See `planRow`'s own doc.
 *
 * TARGET-EXISTS NEVER FOLDS (review finding, BLOCKER 2). Under
 * `idFollowsOwnSetKeyField` moveCatalogRow reads the destination FRESH,
 * immediately before it decides, and REFUSES outright if anything is already
 * there -- it never runs the ordinary authority/vendorIds/sales/confidence
 * ladder for this option, because that ladder decides which of TWO CARDS'
 * fields survive a MERGE, and this lane never asks for one. This script does
 * NOT pre-read the destination itself and hand the answer in as `known`: a
 * point read taken before this script's own I/O (relocating sales, retrying)
 * would be stale by the time moveCatalogRow used it, and an overlapping run
 * or another mover could create the target in the gap.
 *
 * ORDER IS THE INVARIANT, INCLUDING THIS LANE'S OWN SALES (review finding,
 * BLOCKER 1). sold_comps rows keyed to the OLD id must follow on BOTH
 * addressing schemes the pool uses: `hobbyiqCardId === oldId` (patched in
 * place by moveCatalogRow's own `salesContainer`) and `cardId === oldId`
 * (partitioned AT the old slug, which a patch cannot reach at all and needs a
 * relocate: upsert new address, verify read-back, delete old). The SECOND
 * population used to be relocated by this script BEFORE calling
 * moveCatalogRow, which reopened exactly the hazard moveCatalogRow's own
 * ordering exists to close: a crash in that window left sales pointing at an
 * id with no catalog row yet. It is now passed in as `relocateSales`, a hook
 * moveCatalogRow itself invokes INSIDE its own ordered sequence -- after the
 * survivor is copied and the hobbyiqCardId-keyed sales are patched, but
 * BEFORE the old row is deleted -- so at every instant every sale still
 * points at a row that exists. If the hook cannot confirm every sale moved,
 * moveCatalogRow KEEPS the old row (never deletes it) so an unrelocated sale
 * still has something to point at; this script counts that as a failure, not
 * a success.
 *
 * SCOPE IS REQUIRED, BY NAME (CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME): sport,
 * years, and an EXPLICIT target setKey list. An empty or wildcard setKey list
 * is refused (exit 2) -- "every upper-deck sub-brand" is not a scope anyone
 * chose, "upper-deck-extended-series" is. For each (sport, year, target
 * setKey) the umbrella is read from the registry
 * (productParentOf/productAncestry in productSetKeys.ts) rather than
 * hardcoded: `hockey / upper-deck-extended-series` resolves its parent to
 * `upper-deck` via the D39 registration, so the candidate query is
 * `STARTSWITH(c.id, "hiq:<sport>:<year>:<umbrella>:") AND c.setKey = @target`.
 * NEVER a cross-partition COUNT/GROUP BY -- paged with maxItemCount 1000 and
 * a continuation token; card_catalog partitions on /cardId.
 *
 * PER ROW, moveCatalogRow decides everything except what this script's pure
 * `planRow` decides first: the row's source must be checklist authority
 * (catalogAuthorityOf -- vendor/derived rows are never moved by this lane),
 * the row's setKey must be a registered product key (productSetKeys()),
 * segment parsing must succeed, and the id's own segment 3 must be exactly
 * the target's registered parent (the one-level-drift check above) -- a `sub-`
 * segment in the id is handled the same way the fold and rename fleets do:
 * it sits AFTER the setKey segment and is preserved verbatim by the
 * segment-3-only swap, since only index 3 ever changes. Every refusal is
 * counted by name and every id listed.
 *
 * GRADED CHILDREN move with their parent -- moveCatalogRow's own contract
 * (copy, re-point sales, relocate this lane's own partition-keyed sales,
 * retire the OLD slug's graded children, delete the old row, in that order)
 * already does this; nothing extra is needed here.
 *
 * SALES. Both addressing schemes the pool uses (CF-CARDHEDGE-DUAL-ID / the
 * D19 movers) are covered -- see "ORDER IS THE INVARIANT" above for the
 * sequencing: `hobbyiqCardId === oldId` via moveCatalogRow's own in-place
 * patch, `cardId === oldId` via this script's `relocatePartitionKeyedSales`
 * passed in as the `relocateSales` hook (upsert new address -> verify
 * read-back -> delete old, the same primitive fold-checklist-numbered-twins
 * and rekey-product-setkey use). Counted on its own line (`salesRelocated`),
 * never summed into `salesRepointed`. CF-A-SALE-IS-NEVER-LOST: sales before
 * == sales after (patched + relocated + left alone), and every relocate
 * failure is listed by id.
 *
 * HOLDINGS. portfolio.holdings is a MAP -- Object.entries, never
 * `JOIN h IN c.holdings` (feedback_holdings_is_a_map_join_iterates_nothing).
 * The index is built ONCE (fold-checklist-numbered-twins' own shape) and
 * every holding pointing at a moved old id is re-pointed under APPLY; the
 * walk count is printed and a zero-doc walk refuses to claim holdings are
 * clean.
 *
 * REPORT-FIRST. BACKFILL_APPLY=true (not APPLY) gates every write, matching
 * the runner's own env name. REPORT prints scanned / would-move (by setKey,
 * by year, by source) / refused-by-reason with every id listed / sales that
 * would re-point or would relocate / holdings affected / the reconcile line.
 * APPLY verifies by read: old id 404s, new id is live and checklist-sourced,
 * and one sale sample per 500 moved rows is checked on both cardId and
 * hobbyiqCardId.
 *
 * CF-REPORT-MUST-PREDICT-APPLY (2026-09-19, pilot follow-up). The pilot's own
 * REPORT printed "sales relocated 0" while its APPLY, minutes later, relocated
 * 1,192 -- a structural zero, not a forecast: moveCatalogRow only ran the
 * `relocateSales` hook under `!dryRun`, so REPORT never reached it at all.
 * Fixed at the source (moveCatalogRow now runs the hook under dryRun too,
 * handing it `{ dryRun }`) rather than patched here: `relocatePartitionKeyedSales`
 * already enumerated read-only under `!APPLY` (via `relocateSoldComp`'s own
 * dryRun branch), it simply was never being called. Both `sales re-pointed`
 * and `sales relocated` are now LIVE counts in REPORT, not deterministic ones
 * -- see the note this script prints alongside them.
 *
 * BUDGET / RELAUNCH / SHARDING follow the sibling convention exactly:
 * lib/runner-budget.cjs (RUN_MINUTES / RESERVE_MS / VERIFY_MS,
 * "stopped at the N-minute budget" marker, finishLane) and
 * lib/runner-shard-scope.cjs (sha1(id) shards, OFF by default; a moved row no
 * longer matches the selection, so a re-run after a budget stop is
 * idempotent by construction).
 *
 * NO NEW WORKFLOW INPUT. GitHub's 25-input cap is spent; this reuses the
 * runner's existing inputs the way repair-rc-marker-playername does:
 *
 *   SCOPE (runner `scope`)      REQUIRED, comma-separated `sport:year` cells
 *                                (e.g. hockey:2024,hockey:2025). No inherited
 *                                default ('', 'refractor', 'all') is accepted.
 *   SET_KEYS (runner `titles`)  REQUIRED, comma-separated target setKeys
 *                                (e.g. upper-deck-extended-series). Empty or
 *                                a wildcard ('all', '*') is refused (exit 2).
 *   BACKFILL_APPLY (runner `apply`)   write gate
 *   SLOT/SLOTS (runner `slot`/`slots`), CONCURRENCY, LIMIT, RUN_MINUTES
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true / APPLY=true to write;
 *      SCOPE required; SET_KEYS required; CONCURRENCY; LIMIT; SLOT/SLOTS
 *      (sha1(id) shards, opt-in via SHARD=true for slot 0); RUN_MINUTES=110.
 * Requires dist/ (catalogRowOps, catalogAuthority, productSetKeys,
 * hobbyIqCardId, writeReconciliation).
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

const SHARD_SCOPE = runnerShardScope({ label: "rekey-catalog-id-to-setkey" });
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SHARD_SCOPE.SLOTS;

// ── THE SCOPE. sport:year cells, and an inherited default is REFUSED ────────
const INHERITED_SCOPES = new Set(["", "refractor", "all"]);
const RAW_SCOPE = csv(process.env.SCOPE);
const CELL_RE = /^[a-z][a-z0-9-]*:\d{4}$/;
const SCOPE_CELLS = RAW_SCOPE.map(lower).filter((p) => CELL_RE.test(p));
const SCOPE_REJECTED = RAW_SCOPE.filter((p) => !CELL_RE.test(lower(p)));

// ── THE TARGET SETKEYS. Riding the runner's `titles` input (workflow caps at
// 25 inputs; see rekey-product-setkey / repair-rc-marker-playername for the
// same convention). Empty or a wildcard is refused -- a whole-source write
// needs its own name (feedback_a_whole_source_retire_needs_its_name).
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

/** hiq:sport:year:setKey:number:parallel:auto[:sub-...][:num-N][:grade] -> the
 *  parts, or null when this is not a well-formed identity/graded-child id.
 *  Segment 3 is ALWAYS the setKey regardless of what rides after it (a
 *  `sub-` segment sits AFTER the setKey, never before it, so index 3 is
 *  always the right one to swap). */
function idParts(id) {
  const parts = String(id ?? "").split(":");
  if (parts[0] !== "hiq" || parts.length < 7) return null;
  if (!parts[3]) return null;
  return parts;
}

/** Replace ONLY segment 3 with `setKey`. Surgery, never a recompute -- every
 *  other segment (including a `sub-` tag) is carried through verbatim. */
function withOwnSetKeySegment(id, setKey) {
  const parts = idParts(id);
  if (!parts) return null;
  const out = [...parts];
  out[3] = setKey;
  return out.join(":");
}

/** The candidate predicate for one (sport, year, umbrella, target) cell,
 *  shared by the scan and the verify-by-read so the two cannot drift.
 *  Equality on sport/year/setKey, STARTSWITH on the id's umbrella prefix --
 *  never a cross-partition COUNT/GROUP BY. */
function candidateSpec(sport, year, umbrella, target) {
  return {
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.source, c.sport, c.year, c.cardYear,
                   c.setKey, c.setName, c.cardNumber, c.playerName, c.parallel, c.gradeTier
            FROM c
            WHERE c.sport = @sport AND (c.year = @year OR c.cardYear = @year)
              AND c.setKey = @target
              AND STARTSWITH(c.id, @prefix)`,
    parameters: [
      { name: "@sport", value: sport },
      { name: "@year", value: year },
      { name: "@target", value: target },
      { name: "@prefix", value: `hiq:${sport}:${year}:${umbrella}:` },
    ],
  };
}

/**
 * Plan a single row: the newId it should adopt, or a refusal reason. Pure --
 * no I/O -- so it is unit-testable without a fake container. `deps` are the
 * canonical helpers loaded from dist (or src in tests), per
 * CF-DERIVED-FIELDS-ARE-NEVER-HAND-ROLLED.
 *
 * CF-THIS-LANE-FIXES-A-ONE-LEVEL-DRIFT-ONLY (SHOULD-FIX 5, review). The
 * defect this lane closes is exactly one segment of drift: the id's segment 3
 * still names the target's REGISTERED IMMEDIATE PARENT (`productParentOf`),
 * while the setKey field already names the target itself. It is NOT a general
 * "make the id agree with the field" repair for an arbitrary mismatch -- a row
 * whose id segment names something OTHER than the target's own parent (a
 * grandparent, an unrelated product, a stale spelling two renames back) is a
 * DIFFERENT drift with a different cause, and silently swallowing it into this
 * lane's "the field is the ruling" logic would move a row on weaker evidence
 * than the one this lane was built and measured against. So `deps.expectedIdSegment`
 * -- the umbrella this row was SELECTED under (always `productParentOf(target)`,
 * the same value the candidate query's STARTSWITH prefix used) -- is checked
 * explicitly here even though the query already guarantees it for every row
 * this lane actually scans: `planRow` is a pure function callable on ANY row,
 * and a caller (or a future test, or a future reuse of this function) that
 * hands it a row whose id segment is neither the target nor the expected
 * parent gets an explicit, named refusal instead of a newId this lane never
 * measured for. Counted and listed separately from `segment-parse-failed`
 * (the id parses fine; it just is not the ONE step of drift this lane fixes).
 */
function planRow(row, deps) {
  const id = String(row.id ?? "");
  const authority = deps.catalogAuthorityOf(row.source);
  if (authority !== "checklist") {
    return { action: "refuse", reason: "not-checklist-authority", detail: `source "${row.source}" classifies as ${authority}` };
  }
  const setKey = lower(row.setKey);
  if (!setKey) return { action: "refuse", reason: "no-setkey-field", detail: "row carries no setKey field" };
  if (!deps.registeredSetKeys.has(setKey)) {
    return { action: "refuse", reason: "unregistered-setkey", detail: `"${setKey}" is not a registered product key (productSetKeys.ts)` };
  }
  const parts = idParts(id);
  if (!parts) return { action: "refuse", reason: "segment-parse-failed", detail: `id does not parse as a hiq identity: ${id}` };
  const idSetKey = parts[3];
  if (idSetKey === setKey) return { action: "skip", reason: "already-matches", detail: "id segment already equals the setKey field" };
  // ONE-LEVEL DRIFT ONLY. `expectedIdSegment` is optional so planRow stays
  // callable (and testable) without it; when the caller supplies it (the
  // lane always does, as productParentOf(target)) a row whose id segment is
  // neither the target NOR its registered parent is a different drift and is
  // refused by name rather than silently moved.
  if (deps.expectedIdSegment && idSetKey !== deps.expectedIdSegment) {
    return {
      action: "refuse",
      reason: "not-one-level-drift",
      detail: `id segment "${idSetKey}" is neither the target "${setKey}" nor its registered parent "${deps.expectedIdSegment}" -- a different drift than this lane fixes`,
    };
  }
  const newId = withOwnSetKeySegment(id, setKey);
  if (!newId) return { action: "refuse", reason: "segment-parse-failed", detail: `could not build newId for ${id}` };
  return { action: "move", newId, oldSetKeySegment: idSetKey, setKey };
}

async function main() {
  console.log("");
  console.log("=".repeat(78));
  console.log("  REKEY: a checklist row's id catches up to its own setKey field");
  console.log(`  MODE: ${APPLY ? "APPLY -- this run WRITES" : "REPORT ONLY -- nothing is written"}`);
  console.log("=".repeat(78));

  if (SCOPE_REJECTED.length) {
    console.error("");
    console.error(`FATAL: SCOPE carries ${SCOPE_REJECTED.length} value(s) that are not cells: ${SCOPE_REJECTED.join(", ")}`);
    console.error("       A cell looks like hockey:2024 (sport:year).");
    process.exit(2);
  }
  if (!SCOPE_CELLS.length || RAW_SCOPE.some((x) => INHERITED_SCOPES.has(lower(x)))) {
    console.error("");
    console.error("FATAL: SCOPE is REQUIRED and names the cells to rekey, as sport:year.");
    console.error("       There is no 'all' for this lane. Dispatch with -f scope=hockey:2024,hockey:2025");
    console.error("       (comma-separate for several cells).");
    process.exit(2);
  }
  if (!SET_KEYS.length) {
    console.error("");
    console.error("FATAL: SET_KEYS (the runner's `titles` input) is REQUIRED and names the target");
    console.error("       setKey(s) to rekey onto their own id -- an empty value or a wildcard");
    console.error("       ('all', '*') is refused: a whole-source write needs its own name.");
    console.error("       Dispatch with -f titles=upper-deck-extended-series (comma-separate for several).");
    process.exit(2);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING required"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { moveCatalogRow } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
  const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
  const { productParentOf, productSetKeys } = require(path.join(backend, "dist/services/catalog/productSetKeys.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"));

  const registeredSetKeys = new Set(productSetKeys());
  // `expectedIdSegment` is set per-target inside the scan loop (each target
  // setKey has its own registered parent/umbrella); this base object is
  // spread with it there, per row batch.
  const baseDeps = { catalogAuthorityOf, registeredSetKeys };

  // Every target setKey must be a REGISTERED product with a known umbrella
  // (productParentOf) -- "which umbrella does this sub-brand belong to?" is a
  // registry fact, never hardcoded here.
  const targetUmbrella = new Map();
  const unregisteredTargets = SET_KEYS.filter((k) => !registeredSetKeys.has(k));
  if (unregisteredTargets.length) {
    console.error("");
    console.error(`FATAL: SET_KEYS names unregistered product key(s): ${unregisteredTargets.join(", ")}`);
    console.error("       Register the product in productSetKeys.ts (with its parent umbrella) before");
    console.error("       dispatching this lane -- a fold is a ruling, not a guess.");
    process.exit(2);
  }
  for (const k of SET_KEYS) {
    const parent = productParentOf(k);
    if (!parent) {
      console.error("");
      console.error(`FATAL: SET_KEYS names "${k}", which is registered but has no parent umbrella (productParentOf`);
      console.error("       returned null). This lane rekeys a sub-brand's id onto its umbrella prefix; a");
      console.error("       product with no umbrella has nothing to rekey FROM. Register its parent first.");
      process.exit(2);
    }
    targetUmbrella.set(k, parent);
  }

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");
  const portfolio = db.container("portfolio");

  console.log(`  scope (${SCOPE_CELLS.length} cell${SCOPE_CELLS.length === 1 ? "" : "s"})    ${SCOPE_CELLS.join(", ")}`);
  console.log(`  target setKeys   ${SET_KEYS.map((k) => `${k} (umbrella ${targetUmbrella.get(k)})`).join(", ")}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log("");
  console.log("  moveCatalogRow's idFollowsOwnSetKeyField option is used: newSlug is ALWAYS the row's");
  console.log("  own id with segment 3 replaced by the row's OWN setKey field, and nothing else.");
  console.log("  A target address that already exists is a FOLD -- out of scope, reported as target-exists.");
  console.log("");

  const s = {
    scanned: 0, otherShard: 0, moved: 0, gradedMoved: 0, alreadyMatches: 0,
    targetExists: 0, notChecklist: 0, unregisteredSetKey: 0, segmentParseFailed: 0,
    notOneLevelDrift: 0,
    salesRepointed: 0, salesRelocated: 0, salesRelocateFailed: 0,
    gradedChildrenRetired: 0, holdingsRepointed: 0, holdingsWalked: 0, holdingDocsWalked: 0,
    failed: 0, notReached: 0,
  };
  const bySetKey = new Map();
  const byYear = new Map();
  const bySource = new Map();
  const refusals = {
    "not-checklist-authority": [], "unregistered-setkey": [], "segment-parse-failed": [],
    "target-exists": [], "not-one-level-drift": [],
  };
  const examples = [];
  const failures = [];
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
        ops.push({ op: "set", path: `/holdings/${hid}/identityResolvedBy`, value: "rekey-catalog-id-to-setkey" });
        ops.push({ op: "set", path: `/holdings/${hid}/identityResolvedAt`, value: new Date().toISOString() });
        ops.push({ op: "set", path: `/holdings/${hid}/identityRenamedFrom`, value: oldId });
      }
      if (APPLY) await retry(() => portfolio.item(docId, userId).patch(ops));
      s.holdingsRepointed += ids.size;
    }
    holdingsIndex.delete(oldId);
  }

  // Sales whose PARTITION KEY (cardId) is the old id: moveCatalogRow's own
  // in-place patch (via salesContainer) cannot re-key them across partitions
  // (sold_comps partitions on /cardId). BLOCKER 1 fix: this is now invoked BY
  // moveCatalogRow itself, as the `relocateSales` hook, from INSIDE its own
  // ordered sequence -- after the survivor is copied, before the old row is
  // deleted -- rather than by this lane before or after calling it. That is
  // what keeps "a sale must never point at a row that does not exist" true at
  // every instant, including a crash mid-relocation: moveCatalogRow refuses
  // to delete the old row when this returns `ok: false`, so an unrelocated
  // sale still has the OLD row to point at rather than nothing.
  //
  // CF-REPORT-MUST-PREDICT-APPLY (2026-09-19). moveCatalogRow now calls this
  // hook under `dryRun` too, via the third `{ dryRun }` argument -- it did
  // not before, which is WHY the hockey pilot's REPORT printed "sales
  // relocated 0" while its APPLY, minutes later, relocated 1,192: the hook
  // was simply never reached in REPORT mode. Read `dryRun` off the argument
  // moveCatalogRow hands in, not off this script's own `APPLY` flag, so the
  // hook's own dry-run-ness always agrees with the caller that is invoking
  // it. The query below (single-partition, at the OLD id) runs regardless --
  // it is a read, never a write -- and `relocateSoldComp` already has its own
  // read-only dryRun branch (guard check only, returns before the upsert), so
  // passing `dryRun` through to it is enough: nothing is written or deleted
  // in either mode by this function itself.
  //
  // Returns { ok, failures } -- never throws -- so moveCatalogRow's own
  // try/catch around its hook call cannot mistake "some sales failed" for
  // "the whole move failed" (the catalog row and its graded-child cleanup are
  // still correct either way; only the delete is gated on this).
  async function relocatePartitionKeyedSales(oldId, newId, { dryRun } = { dryRun: !APPLY }) {
    let n = 0;
    let anyFailed = false;
    const localFailures = [];
    await forEachPage(pool, { query: "SELECT * FROM c WHERE c.cardId = @o", parameters: [{ name: "@o", value: oldId }] }, async (rows) => {
      for (const row of rows) {
        const keep = { ...stripSystem(row), cardId: newId, hobbyiqCardId: newId, reslugedFrom: oldId, reslugedReason: "id follows its own setKey field (CF-THE-ID-FOLLOWS-ITS-OWN-SETKEY-FIELD)", reslugedAt: new Date().toISOString() };
        keep.contentHash = contentHashOf(keep);
        const res = await relocateSoldComp(pool, { keep, drop: [{ id: row.id, cardId: oldId }], retry, verifyFields: ["cardId", "hobbyiqCardId"], dryRun });
        if (res.ok) {
          s.salesRelocated++; n++;
        } else {
          anyFailed = true;
          const line = `sale relocate ${dryRun ? "would fail" : "failed"} ${row.id}@${oldId} -> ${newId}: ${res.error}`;
          localFailures.push(line);
        }
      }
      return true;
    }, 200);
    return { ok: !anyFailed, failures: localFailures, relocated: n };
  }

  for (const cell of SCOPE_CELLS) {
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    const [sport, yearStr] = cell.split(":");
    const year = Number(yearStr);

    for (const target of SET_KEYS) {
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
      const umbrella = targetUmbrella.get(target);
      const spec = candidateSpec(sport, year, umbrella, target);
      // SHOULD-FIX 5: the umbrella THIS target was selected under is the only
      // id segment this lane's ruling covers -- a one-level drift, never a
      // general "make the id agree with the field" repair. See planRow's doc.
      const deps = { ...baseDeps, expectedIdSegment: umbrella };

      const rows = [];
      await forEachPage(cat, spec, async (page) => {
        for (const r of page) {
          if (CLOCK.outOfClock()) { stoppedAtBudget = true; return false; }
          s.scanned++;
          if (SHARD_SCOPE.SHARDED && shardOf(String(r.id)) !== SHARD_SCOPE.SLOT) { s.otherShard++; continue; }
          rows.push(r);
        }
        return true;
      });

      for (let i = 0; i < rows.length; i += CONCURRENCY) {
        if (CLOCK.outOfClock()) { stoppedAtBudget = true; s.notReached += rows.length - i; break; }
        if (LIMIT && s.moved >= LIMIT) { s.notReached += rows.length - i; break; }
        await Promise.all(rows.slice(i, i + CONCURRENCY).map(async (row) => {
          const plan = planRow(row, deps);
          if (plan.action === "skip") { s.alreadyMatches++; return; }
          if (plan.action === "refuse") {
            if (plan.reason === "not-checklist-authority") s.notChecklist++;
            else if (plan.reason === "unregistered-setkey") s.unregisteredSetKey++;
            else if (plan.reason === "not-one-level-drift") s.notOneLevelDrift++;
            else s.segmentParseFailed++;
            const list = refusals[plan.reason];
            if (list) list.push(`  ${row.id}  [${row.source}]  ${plan.detail}`);
            return;
          }
          // plan.action === "move" from here.
          const { newId } = plan;
          try {
            // moveCatalogRow itself refuses (target-exists) when an incumbent
            // already lives at newId under idFollowsOwnSetKeyField -- see its
            // own doc: this option never folds. No pre-read is done here any
            // more (BLOCKER 2 fix): a point-read taken here, then handed in
            // as `known` after this lane does its own I/O (the old shape),
            // is a STALE answer by the time moveCatalogRow would have used
            // it -- an overlapping run or another mover could create the
            // target in the gap and this lane would have silently carried a
            // wrong "nothing is there" into the write. moveCatalogRow reads
            // fresh, immediately before it decides, every time.
            const res = await moveCatalogRow(cat, row, newId, {}, {
              reason: "id follows its own setKey field (CF-THE-ID-FOLLOWS-ITS-OWN-SETKEY-FIELD, hockey pilot)",
              idFollowsOwnSetKeyField: true,
              dryRun: !APPLY,
              salesContainer: pool,
              // BLOCKER 1 fix: partition-keyed sales (cardId === oldId, which
              // a patch on salesContainer cannot reach) relocate INSIDE
              // moveCatalogRow's own ordered sequence -- after the survivor
              // is copied and the hobbyiqCardId-keyed sales are patched, but
              // BEFORE the old row is deleted. See relocateSales's own doc on
              // MoveCatalogRowOptions for why this must live inside that
              // function rather than being called before or after it.
              //
              // CF-REPORT-MUST-PREDICT-APPLY: moveCatalogRow now runs this
              // hook under dryRun too, handing back which mode it is in --
              // read that off `ctx.dryRun` rather than this script's own
              // `!APPLY`, so the hook always agrees with the caller that
              // invoked it.
              relocateSales: (oldId, movedToId, ctx) => relocatePartitionKeyedSales(oldId, movedToId, ctx),
              retry,
            });
            if (res.action === "refused") {
              s.targetExists++;
              refusals["target-exists"].push(`  ${row.id} -> ${newId}: ${res.decision}`);
              return;
            }
            if (res.salesRelocated === false) {
              // APPLY: the catalog row moved and its graded children retired,
              // but the caller's own partition-keyed sale relocation could not
              // confirm every sale -- moveCatalogRow therefore KEPT the old
              // row rather than deleting it (see its own doc). Counted as a
              // failure, not a success: an operator must look at exactly which
              // sales did not relocate before this row can be considered done.
              //
              // REPORT (CF-REPORT-MUST-PREDICT-APPLY): the hook now runs
              // read-only under dryRun too, so this branch can fire here as
              // well -- a real prediction that an APPLY on this row would hit
              // the same refusal, not a structural impossibility. Nothing was
              // written or kept in either sense; only the label differs.
              s.failed++;
              s.salesRelocateFailed += (res.salesRelocateFailures ?? []).length || 1;
              failures.push(`  ${APPLY ? "FAILED" : "WOULD FAIL"} sale relocation ${row.id} -> ${newId}: ${
                APPLY ? "old row kept, not deleted." : "an APPLY would keep the old row, not delete it."
              } ${(res.salesRelocateFailures ?? []).join("; ") || "(no detail returned)"}`);
              return;
            }
            s.moved++;
            if (row.gradeTier !== undefined && row.gradeTier !== null) s.gradedMoved++;
            s.salesRepointed += res.salesRepointed ?? 0;
            s.gradedChildrenRetired += res.gradedChildrenRetired ?? 0;
            bump(bySetKey, plan.setKey);
            bump(byYear, String(year));
            bump(bySource, row.source ?? "?");
            if (examples.length < 24) examples.push(`  ${row.id} -> ${newId}  [${row.source}]  (${res.decision})`);

            await repointHoldings(String(row.id), newId);
          } catch (e) {
            s.failed++;
            failures.push(`  FAILED ${row.id} -> ${newId}: ${String(e?.stack ?? e?.message ?? e)}`);
            if (s.failed <= 5) console.error(`  FAILED ${row.id}: ${String(e?.message ?? e).slice(0, 160)}`);
          }
        }));
      }
    }
  }

  console.log("");
  console.log(`scanned ${f(s.scanned)} candidate rows${SHARD_SCOPE.SHARDED ? `  (${f(s.otherShard)} in other shards)` : ""}`);
  console.log(`  ${APPLY ? "MOVED" : "WOULD MOVE"}    ${f(s.moved)}   <- ${f(s.gradedMoved)} of them graded children (moved with their parent's cascade, or matched directly)`);
  console.log(`  already matches (id == setKey field)  ${f(s.alreadyMatches)}`);
  console.log(`  REFUSED: target-exists (fold, out of scope)  ${f(s.targetExists)}`);
  console.log(`  REFUSED: not checklist authority             ${f(s.notChecklist)}`);
  console.log(`  REFUSED: unregistered setKey                 ${f(s.unregisteredSetKey)}`);
  console.log(`  REFUSED: segment parse failed                ${f(s.segmentParseFailed)}`);
  console.log(`  REFUSED: not a one-level drift                ${f(s.notOneLevelDrift)}   <- id segment names neither the target nor its registered parent`);
  console.log(`  failed                                       ${f(s.failed)}`);
  if (s.notReached) console.log(`  not reached                                   ${f(s.notReached)}`);
  console.log("");
  console.log(`  sales ${APPLY ? "re-pointed" : "would re-point"} (patch, moveCatalogRow)   ${f(s.salesRepointed)}`);
  console.log(`  sales ${APPLY ? "relocated" : "would relocate"} (re-key, partition-keyed)  ${f(s.salesRelocated)}`);
  console.log(`  sales relocate ${APPLY ? "failed" : "would fail"}                      ${f(s.salesRelocateFailed)}`);
  console.log(`  graded children retired (parent's cascade) ${f(s.gradedChildrenRetired)}`);
  console.log(`  holdings re-pointed                        ${f(s.holdingsRepointed)}   (walked ${f(s.holdingsWalked)} holdings across ${f(s.holdingDocsWalked)} portfolio docs)`);
  // CF-REPORT-MUST-PREDICT-APPLY (2026-09-19): both sale lines above are LIVE
  // counts, not deterministic ones -- they read sold_comps at the moment this
  // run executes, so a REPORT and an APPLY minutes apart can disagree by a few
  // rows as new sales land in between. MOVED/REFUSED above are deterministic:
  // they depend only on card_catalog and this run's own scope/target inputs.
  console.log(`  (the two sale counters above are LIVE counts of sold_comps at run time -- they`);
  console.log(`   can drift by a few between a REPORT and an APPLY run minutes apart; MOVED and`);
  console.log(`   the REFUSED counts are deterministic, from card_catalog and this run's scope)`);

  if (bySetKey.size) {
    console.log(`\n  by setKey:`);
    for (const [k, n] of [...bySetKey.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(9)}  ${k}`);
  }
  if (byYear.size) {
    console.log(`\n  by year:`);
    for (const [k, n] of [...byYear.entries()].sort()) console.log(`    ${String(n).padStart(9)}  ${k}`);
  }
  if (bySource.size) {
    console.log(`\n  by source:`);
    for (const [k, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(9)}  ${k}`);
  }
  if (examples.length) { console.log(`\n  examples:`); for (const e of examples) console.log(e); }

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

  // ── THE RECONCILIATION ------------------------------------------------------
  const written = s.moved;
  const skipped = s.alreadyMatches + s.otherShard + s.notReached
    + s.targetExists + s.notChecklist + s.unregisteredSetKey + s.segmentParseFailed
    + s.notOneLevelDrift;
  const intended = s.scanned;
  console.log("");
  console.log(`  reconciled: intended ${f(intended)} = written ${f(written)} + skipped ${f(skipped)} + failed ${f(s.failed)}`
    + `   [residual ${f(intended - written - skipped - s.failed)}]`);
  if (APPLY) {
    reportWrites({
      job: "rekey-catalog-id-to-setkey",
      intended, written, skipped,
      failed: Math.max(s.failed, intended - written - skipped - s.failed),
    });
  }

  // ── VERIFY BY READ, under the cap ------------------------------------------
  if (APPLY) {
    const vt0 = Date.now();
    let anyUnread = false;
    for (const cell of SCOPE_CELLS) {
      const [sport, yearStr] = cell.split(":");
      for (const target of SET_KEYS) {
        const umbrella = targetUmbrella.get(target);
        const spec = candidateSpec(sport, Number(yearStr), umbrella, target);
        const left = await CLOCK.capped(vt0, `verify ${cell}/${target}`, (signal) => cat.items.query(
          { query: `SELECT VALUE COUNT(1) FROM (${spec.query})`, parameters: spec.parameters },
          { maxItemCount: 1, abortSignal: signal },
        ).fetchAll().then((r) => r.resources[0]));
        if (left === null) anyUnread = true;
        console.log(`  VERIFY BY READ ${cell}/${target}: candidates still under the umbrella prefix: ${left === null ? "UNCONFIRMED (verify cap)" : f(left)}  (refused/skipped rows stay, by design)`);
      }
    }
    if (anyUnread) console.log(CLOCK.unreadNote ? CLOCK.unreadNote() : "  (verify cap reached on at least one cell -- treat as UNREAD, not zero)");
  }

  console.log("");
  // CF-A-REPORT-NEVER-CLAIMS-A-WRITE (review finding, SHOULD-FIX 4). REPORT
  // prints `WOULD MOVE`; only an APPLY run -- where `written` is a count of
  // rows this run actually wrote -- prints `MOVED`. The runner's relaunch
  // decision itself does NOT key on this line at all (CF-RELAUNCH-ONLY-ON-
  // BUDGET, #1361): `.github/actions/relaunch-on-marker` greps only
  // `stopped at the .*budget` / `finishLane: exiting code` to decide whether
  // to re-dispatch, in BOTH modes, so a REPORT run relaunching correctly
  // continues a report and never flips a report into a write. The dispatch
  // step's own `preamble` additionally greps `^  MOVED +[0-9,]+` ONLY to put a
  // count into its human-readable notice text (`moved=N`); that grep matches
  // nothing on a REPORT run's `WOULD MOVE` line and the notice falls back to
  // `moved=0`, which is correct -- a report moved nothing.
  console.log(`  ${APPLY ? "MOVED" : "WOULD MOVE"} ${f(written)}   <- id segment 3 rewritten to the row's own setKey field`);
  if (stoppedAtBudget || CLOCK.outOfClock()) {
    console.log(`  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- the slot has more to do`);
  }
  if (!APPLY) console.log(`\nREPORT ONLY -- nothing was written. Re-run with BACKFILL_APPLY=true to apply.`);

  if (s.failed) {
    console.error(`::error::${f(s.failed)} row(s) failed -- see FAILURES above.`);
    process.exitCode = 4;
  }
}

module.exports = { planRow, idParts, withOwnSetKeySegment, candidateSpec, INHERITED_SCOPES, CELL_RE, WILDCARDS };

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => { console.error("::error::" + (e?.stack ?? e)); await finishLane(1, { budget: CLOCK }); });
}
