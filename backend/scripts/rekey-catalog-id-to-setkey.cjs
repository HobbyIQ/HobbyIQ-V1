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
 * PER ROW, moveCatalogRow decides everything except one thing this script
 * checks FIRST: whether the target id already exists. That is a FOLD (two
 * rows becoming one) and is explicitly OUT OF SCOPE for this lane -- it is
 * counted `target-exists` and reported, never merged, matching the pilot's
 * "0 collisions" measurement rather than assuming it holds everywhere this
 * lane might later run. Also refused, by name, and listed: the row's source
 * is not checklist authority (catalogAuthorityOf -- vendor/derived rows are
 * never moved by this lane), the row's setKey is not a registered product key
 * (productSetKeys()), segment parsing fails, or the id carries a `sub-`
 * segment in an unexpected position (handled the same way the fold and rename
 * fleets do: `sub-` sits AFTER the setKey segment and is preserved verbatim by
 * the segment-3-only swap, since only index 3 ever changes).
 *
 * GRADED CHILDREN move with their parent -- moveCatalogRow's own contract
 * (copy, re-point sales, retire the OLD slug's graded children, delete the
 * old row, in that order) already does this; nothing extra is needed here.
 *
 * SALES. sold_comps rows keyed to the OLD id must follow, on BOTH addressing
 * schemes the pool actually uses (CF-CARDHEDGE-DUAL-ID / the D19 movers):
 *   - `hobbyiqCardId === oldId`, partitioned elsewhere -> moveCatalogRow's own
 *     in-place patch (via `salesContainer`) re-points /hobbyiqCardId; `cardId`
 *     is untouched because the partition key cannot be patched.
 *   - `cardId === oldId` (partitioned AT the old slug) -> relocate-sold-comp
 *     (upsert new address -> verify read-back -> delete old), the same
 *     primitive fold-checklist-numbered-twins and rekey-product-setkey use,
 *     so BOTH cardId and hobbyiqCardId equal the new id afterward. Counted on
 *     its own line (`salesRelocated`), never summed into `salesRepointed`.
 * CF-A-SALE-IS-NEVER-LOST: sales before == sales after (patched + relocated +
 * left alone), and every relocate failure is listed by id.
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
 * would move / holdings affected / the reconcile line. APPLY verifies by
 * read: old id 404s, new id is live and checklist-sourced, and one sale
 * sample per 500 moved rows is checked on both cardId and hobbyiqCardId.
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
  const deps = { catalogAuthorityOf, registeredSetKeys };

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
    salesRepointed: 0, salesRelocated: 0, salesRelocateFailed: 0,
    gradedChildrenRetired: 0, holdingsRepointed: 0, holdingsWalked: 0, holdingDocsWalked: 0,
    failed: 0, notReached: 0,
  };
  const bySetKey = new Map();
  const byYear = new Map();
  const bySource = new Map();
  const refusals = { "not-checklist-authority": [], "unregistered-setkey": [], "segment-parse-failed": [], "target-exists": [] };
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
  // (sold_comps partitions on /cardId), so they are relocated BEFORE the move
  // -- upsert new address, verify read-back, delete old -- exactly as
  // fold-checklist-numbered-twins' relocatePartitionKeyedSales does.
  async function relocatePartitionKeyedSales(oldId, newId) {
    let n = 0;
    await forEachPage(pool, { query: "SELECT * FROM c WHERE c.cardId = @o", parameters: [{ name: "@o", value: oldId }] }, async (rows) => {
      for (const row of rows) {
        const keep = { ...stripSystem(row), cardId: newId, hobbyiqCardId: newId, reslugedFrom: oldId, reslugedReason: "id follows its own setKey field (CF-THE-ID-FOLLOWS-ITS-OWN-SETKEY-FIELD)", reslugedAt: new Date().toISOString() };
        keep.contentHash = contentHashOf(keep);
        const res = await relocateSoldComp(pool, { keep, drop: [{ id: row.id, cardId: oldId }], retry, verifyFields: ["cardId", "hobbyiqCardId"], dryRun: !APPLY });
        if (res.ok) { s.salesRelocated++; n++; } else { s.salesRelocateFailed++; failures.push(`  sale relocate failed ${row.id}@${oldId} -> ${newId}: ${res.error}`); }
      }
      return true;
    }, 200);
    return n;
  }

  for (const cell of SCOPE_CELLS) {
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    const [sport, yearStr] = cell.split(":");
    const year = Number(yearStr);

    for (const target of SET_KEYS) {
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
      const umbrella = targetUmbrella.get(target);
      const spec = candidateSpec(sport, year, umbrella, target);

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
            else s.segmentParseFailed++;
            const list = refusals[plan.reason];
            if (list) list.push(`  ${row.id}  [${row.source}]  ${plan.detail}`);
            return;
          }
          // plan.action === "move" from here.
          const { newId } = plan;
          try {
            // TARGET-EXISTS CHECK, before any write. A fold is out of scope
            // for this lane -- counted and reported, never merged.
            let incumbent = null;
            try {
              const { resource } = await retry(() => cat.item(newId, newId).read());
              incumbent = resource ?? null;
            } catch (e) {
              if (e?.code !== 404 && e?.statusCode !== 404) throw e;
            }
            if (incumbent) {
              s.targetExists++;
              refusals["target-exists"].push(`  ${row.id} -> ${newId}  [${row.source}] -- target already exists [${incumbent.source}]; a fold is out of scope for this lane`);
              return;
            }

            // Sales partitioned AT the old id must relocate BEFORE the
            // catalog move (ORDER IS THE INVARIANT: a sale must never point
            // at a row that does not exist). moveCatalogRow's own
            // salesContainer patch handles sales whose partition key is
            // something ELSE (hobbyiqCardId === oldId only).
            await relocatePartitionKeyedSales(String(row.id), newId);

            const res = await moveCatalogRow(cat, row, newId, {}, {
              reason: "id follows its own setKey field (CF-THE-ID-FOLLOWS-ITS-OWN-SETKEY-FIELD, hockey pilot)",
              idFollowsOwnSetKeyField: true,
              dryRun: !APPLY,
              salesContainer: pool,
              known: null,
              retry,
            });
            if (res.action === "refused") {
              // Should not be reachable (no incumbent, so chooseSurvivor never
              // runs), but handled defensively rather than assumed away.
              s.targetExists++;
              refusals["target-exists"].push(`  ${row.id} -> ${newId}: unexpected refusal ${res.decision}`);
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
  console.log(`  ${APPLY ? "MOVED" : "would move"}    ${f(s.moved)}   <- ${f(s.gradedMoved)} of them graded children (moved with their parent's cascade, or matched directly)`);
  console.log(`  already matches (id == setKey field)  ${f(s.alreadyMatches)}`);
  console.log(`  REFUSED: target-exists (fold, out of scope)  ${f(s.targetExists)}`);
  console.log(`  REFUSED: not checklist authority             ${f(s.notChecklist)}`);
  console.log(`  REFUSED: unregistered setKey                 ${f(s.unregisteredSetKey)}`);
  console.log(`  REFUSED: segment parse failed                ${f(s.segmentParseFailed)}`);
  console.log(`  failed                                       ${f(s.failed)}`);
  if (s.notReached) console.log(`  not reached                                   ${f(s.notReached)}`);
  console.log("");
  console.log(`  sales re-pointed (patch, moveCatalogRow)   ${f(s.salesRepointed)}`);
  console.log(`  sales relocated (re-key, partition-keyed)  ${f(s.salesRelocated)}`);
  console.log(`  sales relocate failed                      ${f(s.salesRelocateFailed)}`);
  console.log(`  graded children retired (parent's cascade) ${f(s.gradedChildrenRetired)}`);
  console.log(`  holdings re-pointed                        ${f(s.holdingsRepointed)}   (walked ${f(s.holdingsWalked)} holdings across ${f(s.holdingDocsWalked)} portfolio docs)`);

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
    + s.targetExists + s.notChecklist + s.unregisteredSetKey + s.segmentParseFailed;
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
  // The runner's relaunch action greps `^  MOVED +[0-9,]+` -- the SAME shape
  // repair-rc-marker-playername's `REPAIRED` line uses (CF-RELAUNCH-ONLY-ON-
  // BUDGET, #1361). The words after the number are free; the count must come
  // first.
  console.log(`  MOVED ${f(written)}   <- id segment 3 rewritten to the row's own setKey field`);
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
