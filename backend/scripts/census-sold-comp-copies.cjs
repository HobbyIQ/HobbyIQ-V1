#!/usr/bin/env node
/**
 * census-sold-comp-copies.cjs -- per sport:year GENERATOR of dedupe
 * candidates for dedupe-sold-comp-copies-by-list.cjs (Drew, 2026-09-28
 * ~00:50Z: "Build it; start with hockey 2025 REPORT").
 *
 * BACKGROUND. A stratified census (C:/tmp/dupecensus_2359/out/REPORT.md,
 * samples.csv, 2026-09-27) found 3.57% of sold_comps sale ids stored as 2+
 * physical documents under different /cardId partition keys (hockey 7.3%;
 * hockey 2025/2026 cells 20-24%). ~86% of docs are partitioned by the raw
 * vendor id with hobbyiqCardId as a field only. That census sampled;
 * this lane DRAINS one sport:year cell exactly and produces the
 * (saleId, keepCardId, deleteCardId, reason) list
 * dedupe-sold-comp-copies-by-list.cjs's own gates will re-check per row at
 * delete time -- this generator never writes to Cosmos, in either mode.
 *
 * ────────────────────────────────────────────────────────────────────────
 * ALGORITHM
 * ────────────────────────────────────────────────────────────────────────
 *
 * PASS 1 (in-scope discovery). Drain
 *   SELECT c.id, c.cardId, c.hobbyiqCardId FROM c
 *   WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:<sport>:<year>:')
 * cross-partition (maxItemCount 500, maxDegreeOfParallelism -1, paginate
 * `while (iter.hasMoreResults())`, NEVER break on an empty page -- Cosmos
 * pagination can legitimately return an empty page before the cursor is
 * exhausted). This finds every id whose hobbyiqCardId falls in scope, but
 * ONLY the copies filed there -- a stray copy of the SAME sale filed under
 * ANOTHER sport/year's hobbyiqCardId (or a raw vendor cardId with no
 * hobbyiqCardId prefix at all) is invisible to this predicate.
 *
 * PASS 2 (out-of-scope discovery). For every distinct id PASS 1 saw, run the
 * SAME cross-partition per-id query the census audits used --
 *   SELECT c.id, c.cardId, c.hobbyiqCardId FROM c WHERE c.id = @id
 * -- batched via ARRAY_CONTAINS(@ids, c.id) in groups of <=50 ids. This finds
 * every physical document for that id, wherever its cardId/hobbyiqCardId
 * point, including a stray parked under a completely different sport or an
 * unknown-setKey slug PASS 1's own STARTSWITH prefix would never match.
 *
 * GROUPING + KEEPER SELECTION. Group PASS 2's results by id. A group of 1 is
 * not a duplicate (informational: if that single doc's own cardId !=
 * hobbyiqCardId, it is intra-doc drift, counted separately, never a dedupe
 * candidate -- there is nothing here to delete). For a group of >=2:
 *
 *   the keeper is the ONE doc whose cardId === hobbyiqCardId (address-
 *   coherent -- CF-COLLISION-IS-NOT-A-DUPLICATE, D31) AND whose
 *   hobbyiqCardId's OWN card_catalog row is CHECKLIST-GRADE
 *   (catalogAuthorityOf(row.source) === "checklist", via
 *   lib/catalog-none-pk.cjs's pkOf -- a catalog row without cardId lives at
 *   Cosmos's own None partition key, never a bare (id, id) guess) AND whose
 *   own SALE TITLE (that doc's own stored `title`, `playerName` field only as
 *   a fallback) NAMES THE CATALOG ROW'S PLAYER (`titleNamesPlayer`,
 *   lib/name-agreement.cjs -- a containment check built for exactly this
 *   shape: a free-text listing title against a bare checklist playerName,
 *   with the SAME stripTrailingTokens vocabulary repoint-sales-by-list.cjs's
 *   own GATE 6 builds, from the candidate's own year/setKey checklist
 *   parallel names).
 *
 *   PR #2490 REVIEW (https://github.com/HobbyIQ/HobbyIQ-V1/pull/2490#issuecomment-5871669672):
 *   "address-coherent + checklist-grade" alone is not enough -- a bare
 *   #cardNumber collision across a sport/setKey boundary can put a coherent,
 *   checklist-grade doc at an address that names a COMPLETELY DIFFERENT
 *   PLAYER than the sale actually stored there (measured: 118/190 cross-sport
 *   entries and 3/30 same-sport entries in the hockey:2025 list -- e.g. sale
 *   tca-ebay::198458636920's own title is a Cam Skattebo football card, but
 *   its coherent+checklist-grade address hiq:baseball:2025:bowman:21:base:
 *   no-auto names Ronald Acuña Jr.). "A checklist row proves the ROW, the
 *   player name proves the SALE" -- a candidate that fails this test is
 *   never promoted to keeper, no matter how address-coherent or
 *   checklist-grade its row is.
 *
 * Exactly one address-coherent + checklist-grade + name-agreeing doc in the
 * group -> emit ONE dedupe entry per OTHER doc in the group (keepCardId = the
 * keeper's cardId, deleteCardId = the other doc's cardId). Zero such docs, or
 * more than one -- this generator NEVER GUESSES: the whole group is filed
 * under census.needsRuling, every doc's own (cardId, hobbyiqCardId) named,
 * and nothing is emitted for it. A candidate that was address-coherent and
 * checklist-grade but FAILED the name test is filed under its own reason,
 * `keeper-name-disagrees` (with the sale's own title and the candidate row's
 * playerName recorded), distinct from `no-checklist-grade-coherent-doc` --
 * the two reasons mean different things (no candidate was checklist-grade at
 * all, vs. a checklist-grade candidate existed but named the wrong player).
 *
 * INTRA-DOC DRIFT (informational only). A group of exactly 1 whose own
 * cardId != hobbyiqCardId is counted under `intraDocDriftIds`, entirely
 * separate from dedupe candidates -- it is a split-identity ROW (the
 * OTHER shape census-split-identity.cjs already covers), not a duplicate
 * DOCUMENT, and this lane has nothing to delete for it.
 *
 * ────────────────────────────────────────────────────────────────────────
 * OUTPUT
 * ────────────────────────────────────────────────────────────────────────
 *
 * PLAN_OUT/dedupe-candidates-<sport>-<year>[-slotN].json, in
 * dedupe-sold-comp-copies-by-list.cjs's own list schema:
 *   { forLane, finding, generatedAt, scope, census: {...}, entries: [...] }
 * so the artifact loads through that lane's real classifyEntry() unchanged
 * -- a candidate that fails classifyEntry is a bug in THIS generator, not a
 * decision for a human reviewer to make blind. The header census carries ids
 * scanned, groups >=2, entries emitted, needsRuling, the stray-address shape
 * histogram and the top setKeys -- the same fields the samples.csv census
 * reported, so the two documents are directly comparable.
 *
 * This artifact becomes the INPUT to a reviewed list PR for the dedupe lane
 * -- it is never applied directly, and this script has no APPLY branch at
 * all: it is REPORT-only by nature, exactly like census-duplicate-sale-ids
 * and census-split-identity before it.
 *
 * ────────────────────────────────────────────────────────────────────────
 * BUDGET + RELAUNCH + SHARDING
 * ────────────────────────────────────────────────────────────────────────
 *
 * A RELAUNCH RE-READS THIS SHARD FROM THE TOP -- exactly the same discipline
 * census-duplicate-sale-ids.cjs and census-split-identity.cjs already carry,
 * and for the SAME reason: this generator is READ ONLY, so there is no
 * predicate that shrinks as it works, and a NO-CURSOR design was chosen
 * deliberately over a cross-hop cursor file. relaunch-on-marker dispatches a
 * FRESH runner for the continuation, and this workflow has no
 * download-artifact step between hops -- a cursor written to PLAN_OUT on one
 * runner's disk is simply gone on the next one's, so a design that relied on
 * one would silently re-drain PASS 1 and restart PASS 2 at offset 0 anyway,
 * while claiming to resume. Cheaper to be honest about it: a budget stop
 * means the WHOLE shard reruns, both passes, from nothing.
 *
 * This is a real limit, not a corner cut: a shard too big for one budget
 * will relaunch forever without making progress, exactly as the split-
 * identity census's own header already says. The fix is the one that census
 * already prescribes too -- MORE SLOTS, not a cursor -- SLOT/SLOTS shard
 * PASS 1's id list by hash(hobbyiqCardId), honouring
 * lib/runner-shard-scope.cjs's own inherited-vs-chosen discipline (a bare
 * inherited slot=0/slots=16 sweeps every id rather than silently covering
 * 1/16 of the cell), so a cell too large for one pass fans out across
 * several dispatches instead of relaunching the same unbounded walk. In
 * practice this cell rarely needs it: the 2026-09-27 stratified census
 * measured roughly 11.5k ids for hockey:2025 (dupRate 20.9% x its sampled
 * denominator), well inside one pass's budget.
 *
 * A unit is ONE ID CONSIDERED IN PASS 2 (one batched IN-lookup batch of <=50
 * ids). Budget stops before starting a new batch and prints
 * CF-RELAUNCH-ONLY-ON-BUDGET's literal marker; RECONCILE IDENTITY: ids
 * scanned (PASS 1) = single (groups of 1) + grouped (groups of >=2), over
 * the ids THIS RUN actually considered in PASS 2 -- a budget stop leaves the
 * rest to the relaunch's own from-the-top pass, never double-counted.
 *
 * Env: COSMOS_CONNECTION_STRING; SCOPE=<sport>:<year> (REQUIRED, no default
 *      -- this lane has no whole-corpus mode); SLOT/SLOTS; RUN_MINUTES
 *      (default 110); PLAN_OUT.
 * Requires dist/ (catalogAuthority.service.js).
 * READ ONLY -- never writes to Cosmos, in any mode; there is no APPLY branch.
 */
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const backend = path.resolve(__dirname, "..");
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const { withBackoff } = require(path.join(__dirname, "lib", "cosmos-backoff.cjs"));
const { pkOf } = require(path.join(__dirname, "lib", "catalog-none-pk.cjs"));
const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
const { titleNamesPlayer } = require(path.join(__dirname, "lib", "name-agreement.cjs"));
// checklistParallelNamesFor is a scripts/lib module (reads the checklist
// corpus JSON directly, no dist/ and no Cosmos), the SAME vocabulary
// repoint-sales-by-list.cjs builds for its own GATE 6 -- required at top
// level for the same reason that lane requires it there: loading this
// module must not need a built tree.
const { checklistParallelNamesFor } = require(path.join(__dirname, "lib", "rematch-finish-vocab.cjs"));

const f = (n) => Number(n ?? 0).toLocaleString("en-US");

// ── THE SCOPE. sport:year, REQUIRED, no default and no whole-corpus mode --
// same convention as repoint-sales-isauto-flip.cjs and every sibling repoint
// lane. The runner's inherited defaults ("", "refractor", "all") are
// REFUSED (exit 2) rather than read as "everything".
const INHERITED_SCOPES = new Set(["", "refractor", "all"]);
const RAW_SCOPE = String(process.env.SCOPE || "").trim();
const CELL_RE = /^([a-z-]+):(\d{4})$/;
const SCOPE_MATCH = CELL_RE.exec(RAW_SCOPE.toLowerCase());
const SCOPE_ERROR = (() => {
  if (!RAW_SCOPE || INHERITED_SCOPES.has(RAW_SCOPE.toLowerCase())) {
    return "FATAL: SCOPE is REQUIRED and names one cell as sport:year (e.g. SCOPE=hockey:2025) -- "
      + "this generator has no whole-corpus mode.";
  }
  if (!SCOPE_MATCH) {
    return `FATAL: SCOPE="${RAW_SCOPE}" is not a sport:year cell. Dispatch with -f scope=hockey:2025.`;
  }
  return null;
})();
const SPORT = SCOPE_MATCH ? SCOPE_MATCH[1] : "";
const YEAR = SCOPE_MATCH ? SCOPE_MATCH[2] : "";
const CELL = `${SPORT}:${YEAR}`;
const PREFIX = `hiq:${SPORT}:${YEAR}:`;

/** Minutes on the clock for the work loop. Hoisted to a named constant --
 *  not an inline `budget({ minutes: Number(...) })` -- so tests/
 *  runnerBudgetMargin.test.ts's static scan (which greps this file's own
 *  source for `const RUN_MINUTES = Number(process.env.RUN_MINUTES || N)`)
 *  can compute this lane's worst case alongside every sibling budgeted
 *  lane; an inline expression is invisible to that pin. */
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);

const SHARD_SCOPE = runnerShardScope({ label: "census-sold-comp-copies" });
const shardOf = (key) => crypto.createHash("md5").update(String(key)).digest().readUInt32BE(0) % SHARD_SCOPE.SLOTS;

const IN_BATCH_SIZE = 50;

/** Does an error carry a Cosmos 404? */
function is404(e) { return e?.code === 404 || e?.statusCode === 404; }

/**
 * The stray-address shape this second-pass doc's address takes, relative to
 * the in-scope cell -- purely descriptive, drives the header histogram only.
 */
function shapeOf(doc, mine) {
  const hiq = String(doc.hobbyiqCardId || "");
  const cid = String(doc.cardId || "");
  if (!hiq.startsWith("hiq:")) return "malformed-legacy-slug";
  const seg = hiq.split(":");
  if (seg[1] !== mine.sport) return "wrong-sport-hiq";
  if (String(seg[3] || "") === "unknown") return "unknown-setkey";
  if (seg[2] !== mine.year) return "other-hiq-variant";
  if (cid !== hiq) return "other-setkey-hiq";
  return "coherent";
}

/** Top-level setKey prefix (hiq:sport:year:setKey) for the header table. */
function setKeyPrefixOf(doc) {
  const hiq = String(doc.hobbyiqCardId || "");
  if (!hiq.startsWith("hiq:")) return "(non-hiq)";
  const seg = hiq.split(":");
  return seg.length >= 4 ? seg.slice(0, 4).join(":") : hiq;
}

// ── CF-COLLISION-IS-NOT-A-DUPLICATE, THE PLAYER-NAME GATE ──────────────────
//
// PR #2490 review (https://github.com/HobbyIQ/HobbyIQ-V1/pull/2490#issuecomment-5871669672):
// "address-coherent + checklist-grade" alone picked a keeper on a bare
// #cardNumber collision, with zero check that the SALE's own title names the
// keeper row's player -- 118/190 cross-sport entries and 3/30 same-sport
// entries in the hockey:2025 list turned out to be a different sale for a
// different player (e.g. sale tca-ebay::198458636920 "Cam Skattebo" football
// card, keeper catalog row playerName "Ronald Acuña Jr."). "A checklist row
// proves the ROW, the player name proves the SALE" -- exactly the doctrine
// repoint-sales-by-list.cjs's own GATE 6 already applies before it moves a
// sale onto a checklist-attested destination; this generator now applies the
// SAME check before it ever calls a doc the keeper of a group.
//
// Vocabulary built once per (year, setKey) and cached, exactly mirroring
// repoint-sales-by-list.cjs's own `stripVocabularyForDestination` (kept as a
// separate copy rather than a shared import: this generator has no dist/
// requirement and this module must stay loadable with no built tree, the
// same contract name-agreement.cjs itself states).
const _stripVocabCache = new Map();
const COLOUR_PREFIX_FAMILY_RE = /^([a-z][a-z'-]*)\s+(refractor|prizm)s?$/i;
const BARE_FAMILY_WORDS = ["Refractor", "Prizm", "Parallel"];

function stripVocabularyForKeeper(catalogRow) {
  const year = catalogRow?.year ?? catalogRow?.cardYear ?? null;
  const setKey = String(catalogRow?.setKey ?? "").trim();
  const cacheKey = `${year}|${setKey.toLowerCase()}`;
  if (_stripVocabCache.has(cacheKey)) return _stripVocabCache.get(cacheKey);

  let names = null;
  try { names = setKey ? checklistParallelNamesFor(year, setKey) : null; }
  catch { names = null; }
  const tokens = new Set();
  if (names) {
    for (const name of names) {
      const trimmed = String(name ?? "").trim();
      if (!trimmed) continue;
      tokens.add(trimmed);
      const m = trimmed.match(COLOUR_PREFIX_FAMILY_RE);
      if (m) tokens.add(m[1]);
    }
  }
  for (const w of BARE_FAMILY_WORDS) tokens.add(w);

  const result = [...tokens];
  _stripVocabCache.set(cacheKey, result);
  return result;
}

/**
 * Does the SALE's own title (falling back to its playerName field only when
 * no title is stored) name the candidate keeper's catalog-row playerName?
 * `titleNamesPlayer` (lib/name-agreement.cjs) is the shared containment
 * check built for exactly this shape -- a free-text listing title (year, set,
 * parallel, grade and all) against a bare checklist playerName, where a
 * strict `namesAgree` whole-string fold would false-refuse almost every
 * genuinely correct keeper (confirmed against this repo's own fixtures:
 * "Victor Hurtado Gold Refractor Auto" vs "Victor Hurtado" fails plain
 * namesAgree, passes titleNamesPlayer) while still refusing the real
 * collisions PR #2490 found (a Cam Skattebo title never contains "Ronald
 * Acuña Jr." in any spelling). Per the doctrine this fix exists to apply: a
 * checklist row proves the ROW, the player name proves the SALE.
 */
function keeperNameAgreesWithSale(saleDoc, catalogRow) {
  const saleName = String(saleDoc?.title ?? saleDoc?.playerName ?? "");
  const keeperName = String(catalogRow?.playerName ?? "");
  if (!saleName || !keeperName) return false;
  const strip = stripVocabularyForKeeper(catalogRow);
  return titleNamesPlayer(saleName, keeperName, { stripTrailingTokens: strip });
}

async function main() {
  console.log("");
  console.log("=".repeat(78));
  console.log("  CENSUS: per sport:year GENERATOR of dedupe-sold-comp-copies-by-list candidates");
  console.log("  READ ONLY -- never writes to Cosmos, in any mode");
  console.log("=".repeat(78));

  if (SCOPE_ERROR) { console.error(SCOPE_ERROR); process.exit(2); }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));

  const client = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  });
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");

  const retry = (fn) => withBackoff(fn, { label: "census-sold-comp-copies" });

  console.log(`  scope                    ${CELL}`);
  console.log(`  prefix                   ${PREFIX}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: 30 * 1000, verifyMs: 60 * 1000 });
  console.log(`  ${CLOCK.describe()}`);
  console.log("");

  const PLAN_OUT = String(process.env.PLAN_OUT || "").trim() || path.join(backend, "..", "tmp", "census-sold-comp-copies");
  try { fs.mkdirSync(PLAN_OUT, { recursive: true }); } catch { /* best effort; a write failure below is a ::warning::, never a crash */ }

  const rowsByIdSeen = new Map(); // id -> { cardId, hobbyiqCardId } (PASS 1's own row -- kept only so PASS 2 always has >=1 doc per id even if the point read races a concurrent write)
  let idsScanned = 0;
  let otherShard = 0;

  // ── PASS 1: in-scope discovery. Cross-partition, paginated, NEVER break
  // on an empty page -- Cosmos pagination can legitimately hand back an
  // empty page before hasMoreResults() goes false. NO CURSOR: a relaunch
  // re-reads this shard from the top (see the header above) -- a budget
  // stop here means the WHOLE shard, both passes, reruns on relaunch.
  console.log("  PASS 1: draining in-scope ids by STARTSWITH(hobbyiqCardId, prefix)...");
  const iter = pool.items.query({
    query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.title, c.playerName FROM c WHERE STARTSWITH(c.hobbyiqCardId, @prefix)",
    parameters: [{ name: "@prefix", value: PREFIX }],
  }, { maxItemCount: 500, maxDegreeOfParallelism: -1 });

  const idSet = new Set();
  while (iter.hasMoreResults()) {
    if (CLOCK.outOfClock()) {
      console.log(`\n  stopped at the ${CLOCK.RUN_MINUTES}-minute budget during PASS 1 (in-scope discovery) --`
        + " the relaunch re-reads this shard from the top (no cursor; see the header).");
      console.log(`  ids scanned so far          ${f(idsScanned)}`);
      return { client, budget: CLOCK, exitCode: 0, printedBudgetMarker: true };
    }
    const page = await retry(() => iter.fetchNext());
    for (const row of page.resources ?? []) {
      idsScanned++;
      const id = String(row.id ?? "");
      if (!id) continue;
      if (SHARD_SCOPE.SHARDED && shardOf(row.hobbyiqCardId || id) !== SHARD_SCOPE.SLOT) { otherShard++; continue; }
      if (!idSet.has(id)) { idSet.add(id); rowsByIdSeen.set(id, row); }
    }
    // deliberately NO break on an empty page -- loop only on hasMoreResults()
  }
  const ids = [...idSet];
  console.log(`  PASS 1 complete: ${f(ids.length)} distinct in-scope ids${SHARD_SCOPE.SHARDED ? ` (${f(otherShard)} in other shards)` : ""}\n`);

  // ── PASS 2: out-of-scope discovery. For every id PASS 1 saw, the SAME
  // cross-partition per-id query the census audits used, batched via
  // ARRAY_CONTAINS in groups of <=50. NO CURSOR here either -- a budget stop
  // mid-PASS-2 relaunches the WHOLE shard from the top of PASS 1 (see the
  // header above); the fix for a cell too large for one pass is more slots,
  // never a cross-hop cursor this workflow cannot actually deliver.
  console.log(`  PASS 2: cross-partition lookup of every physical document per id (batches of ${IN_BATCH_SIZE})...`);
  const docsById = new Map(); // id -> [{id, cardId, hobbyiqCardId}, ...]
  let stoppedInPass2 = false;
  let offset = 0;

  for (; offset < ids.length; offset += IN_BATCH_SIZE) {
    if (CLOCK.outOfClock()) {
      stoppedInPass2 = true;
      break;
    }
    const batch = ids.slice(offset, offset + IN_BATCH_SIZE);
    let rows;
    try {
      const res = await retry(() => pool.items.query({
        query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.title, c.playerName FROM c WHERE ARRAY_CONTAINS(@ids, c.id)",
        parameters: [{ name: "@ids", value: batch }],
      }, { maxItemCount: 500, maxDegreeOfParallelism: -1 }).fetchAll());
      rows = res?.resources ?? [];
    } catch (err) {
      console.log(`\n::warning::PASS 2 batch at offset ${f(offset)} threw: ${String(err?.message ?? err).slice(0, 160)} -- ids in this batch are skipped, not silently dropped`);
      rows = [];
    }
    for (const row of rows) {
      const id = String(row.id ?? "");
      if (!id) continue;
      const list = docsById.get(id) ?? [];
      list.push({
        id, cardId: String(row.cardId ?? ""), hobbyiqCardId: String(row.hobbyiqCardId ?? ""),
        title: row.title ?? "", playerName: row.playerName ?? "",
      });
      docsById.set(id, list);
    }
  }

  if (stoppedInPass2) {
    console.log(`\n  stopped at the ${CLOCK.RUN_MINUTES}-minute budget during PASS 2 (per-id lookup) --`
      + ` offset ${f(offset)} of ${f(ids.length)}. NO CURSOR: the relaunch re-reads this shard from`
      + " the top, both passes (see the header) -- raise SLOT/SLOTS if this cell needs more than one pass.");
  }

  // A batch that returned nothing for an id it should have found at least
  // its own PASS-1 row for (a fresh 404/race) still gets that ONE row, so
  // grouping never under-counts an id down to zero docs.
  for (const id of ids.slice(0, offset)) {
    if (!docsById.has(id) || docsById.get(id).length === 0) {
      const seen = rowsByIdSeen.get(id);
      if (seen) {
        docsById.set(id, [{
          id, cardId: String(seen.cardId ?? ""), hobbyiqCardId: String(seen.hobbyiqCardId ?? ""),
          title: seen.title ?? "", playerName: seen.playerName ?? "",
        }]);
      }
    }
  }

  // ── GROUPING + KEEPER SELECTION ────────────────────────────────────────
  const catalogCache = new Map(); // cardId -> row | null
  const catalogRowAt = async (id) => {
    if (catalogCache.has(id)) return catalogCache.get(id);
    let row = null;
    try { row = (await retry(() => cat.item(id, id).read())).resource ?? null; }
    catch (err) { if (!is404(err)) throw err; }
    if (!row) {
      try {
        const nonePk = pkOf({});
        row = (await retry(() => cat.item(id, nonePk).read())).resource ?? null;
      } catch (err) { if (!is404(err)) throw err; }
    }
    catalogCache.set(id, row);
    return row;
  };

  let single = 0;
  let grouped = 0;
  let intraDocDriftIds = 0;
  let entriesEmitted = 0;
  const needsRuling = [];
  const entries = [];
  const shapeHistogram = new Map();
  const setKeyCounts = new Map();
  const examples = [];

  const consideredIds = offset < ids.length ? ids.slice(0, offset) : ids;
  for (const id of consideredIds) {
    const docs = docsById.get(id) ?? [];
    if (docs.length <= 1) {
      single++;
      const only = docs[0];
      if (only && only.cardId && only.hobbyiqCardId && only.cardId !== only.hobbyiqCardId) intraDocDriftIds++;
      continue;
    }
    grouped++;

    // De-duplicate by (cardId) in case PASS 2 saw the same physical doc twice
    // across batch boundaries (a relaunch resuming mid-scan, or a concurrent
    // write racing the read) -- keyed on cardId, the pair that addresses one
    // physical document within this id.
    const byCardId = new Map();
    for (const d of docs) if (!byCardId.has(d.cardId)) byCardId.set(d.cardId, d);
    const distinctDocs = [...byCardId.values()];
    if (distinctDocs.length <= 1) { single++; grouped--; continue; }

    // Shape + setKey histograms, over every doc in the group.
    const mine = { sport: SPORT, year: YEAR };
    for (const d of distinctDocs) {
      const shape = shapeOf(d, mine);
      shapeHistogram.set(shape, (shapeHistogram.get(shape) ?? 0) + 1);
      const sk = setKeyPrefixOf(d);
      setKeyCounts.set(sk, (setKeyCounts.get(sk) ?? 0) + 1);
    }

    // Candidate keepers: address-coherent (cardId === hobbyiqCardId) AND
    // checklist-grade at that address AND (CF-COLLISION-IS-NOT-A-DUPLICATE,
    // PR #2490 review) the SALE'S OWN title (that coherent doc's own stored
    // title, falling back to its playerName field only when no title is
    // stored) agrees with the keeper catalog row's playerName. A
    // checklist-grade address-coherent doc that FAILS the name test is never
    // promoted to keeper -- the doc's own cardId/hobbyiqCardId pair proves
    // its ADDRESS is coherent, not that the sale sitting there is the right
    // sale for that address; a bare #cardNumber collision across a
    // sport/setKey boundary can produce exactly this shape (Cam Skattebo's
    // football sale landing, by number alone, on Ronald Acuña Jr.'s
    // baseball row).
    const coherent = distinctDocs.filter((d) => d.cardId && d.cardId === d.hobbyiqCardId);
    const checklistKeepers = [];
    const nameDisagreements = [];
    for (const d of coherent) {
      let row;
      try { row = await catalogRowAt(d.cardId); }
      catch (err) {
        console.log(`\n::warning::catalog read threw for ${d.cardId}: ${String(err?.message ?? err).slice(0, 120)} -- treated as absent for this group`);
        row = null;
      }
      if (!row || catalogAuthorityOf(row.source) !== "checklist") continue;
      if (keeperNameAgreesWithSale(d, row)) {
        checklistKeepers.push(d);
      } else {
        nameDisagreements.push({
          cardId: d.cardId,
          saleName: String(d.title ?? d.playerName ?? ""),
          keeperName: String(row.playerName ?? ""),
        });
      }
    }

    if (checklistKeepers.length === 1) {
      const keeper = checklistKeepers[0];
      for (const d of distinctDocs) {
        if (d.cardId === keeper.cardId) continue;
        entries.push({
          saleId: id,
          keepCardId: keeper.cardId,
          deleteCardId: d.cardId,
          reason: `census-sold-comp-copies: ${CELL} generator, ${distinctDocs.length} docs for this id, `
            + `keeper is address-coherent + checklist-grade + name-agreeing at ${keeper.cardId}`,
        });
        entriesEmitted++;
      }
      if (examples.length < 20) {
        examples.push(`  ${id}: keep ${keeper.cardId} -> delete ${distinctDocs.filter((d) => d.cardId !== keeper.cardId).map((d) => d.cardId).join(", ")}`);
      }
    } else if (checklistKeepers.length === 0 && nameDisagreements.length > 0) {
      // At least one candidate was address-coherent + checklist-grade but
      // failed the name test -- a bare card-number collision minted it, not
      // a genuine duplicate. Named its own reason (never folded into
      // "no-checklist-grade-coherent-doc", which means something else: no
      // candidate was even checklist-grade at all) and records the sale
      // title + keeper row player for the human ruling this reason exists
      // to route to.
      needsRuling.push({
        saleId: id,
        reason: "keeper-name-disagrees",
        docs: distinctDocs.map((d) => ({ cardId: d.cardId, hobbyiqCardId: d.hobbyiqCardId })),
        nameDisagreements,
      });
    } else {
      needsRuling.push({
        saleId: id,
        reason: checklistKeepers.length === 0 ? "no-checklist-grade-coherent-doc" : "multiple-checklist-grade-coherent-docs",
        docs: distinctDocs.map((d) => ({ cardId: d.cardId, hobbyiqCardId: d.hobbyiqCardId })),
      });
    }
  }

  // ── RECONCILE: ids scanned = single + grouped (over the ids this run
  // actually considered in PASS 2 -- a budget stop leaves the rest for the
  // relaunch, tracked separately as notConsidered). ──────────────────────
  const notConsidered = ids.length - consideredIds.length;
  const reconciles = consideredIds.length === single + grouped;

  console.log("");
  console.log(`  ids scanned (PASS 1)                 ${f(ids.length)}${SHARD_SCOPE.SHARDED ? `  (${f(otherShard)} in other shards)` : ""}`);
  console.log(`  ids considered in PASS 2 this run     ${f(consideredIds.length)}`);
  console.log(`  not yet considered (budget)           ${f(notConsidered)}   <- the relaunch reruns this WHOLE shard from the top (no cursor)`);
  console.log(`  single-doc ids                        ${f(single)}`);
  console.log(`    of which intra-doc drift (cardId != hobbyiqCardId, informational only) ${f(intraDocDriftIds)}`);
  console.log(`  groups of >=2 docs                    ${f(grouped)}`);
  console.log(`  entries emitted                       ${f(entriesEmitted)}`);
  console.log(`  needsRuling groups                    ${f(needsRuling.length)}`);
  console.log(`\n  reconciled: ids considered ${f(consideredIds.length)} = single ${f(single)} + grouped ${f(grouped)}  -> ${reconciles ? "OK" : "MISMATCH"}`);
  if (!reconciles) { console.log("  ::warning:: the census does not reconcile"); process.exitCode = 4; }

  if (shapeHistogram.size) {
    console.log("\n  STRAY-ADDRESS SHAPE HISTOGRAM (across every doc in a group of >=2):");
    for (const [shape, n] of [...shapeHistogram.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${shape.padEnd(24)} ${f(n)}`);
    }
  }
  const topSetKeys = [...setKeyCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (topSetKeys.length) {
    console.log("\n  TOP SETKEYS (by duplicate-copy count):");
    for (const [sk, n] of topSetKeys) console.log(`    ${sk.padEnd(48)} ${f(n)}`);
  }
  if (examples.length) {
    console.log("\n  EXAMPLES (up to 20):");
    for (const line of examples) console.log(line);
  }
  if (needsRuling.length) {
    console.log(`\n  NEEDSRULING (up to 20 of ${f(needsRuling.length)}):`);
    for (const g of needsRuling.slice(0, 20)) {
      console.log(`    ${g.saleId} (${g.reason}): ${g.docs.map((d) => `${d.cardId}${d.cardId !== d.hobbyiqCardId ? ` [hiq=${d.hobbyiqCardId}]` : ""}`).join(" | ")}`);
    }
  }

  const outName = `dedupe-candidates-${SPORT}-${YEAR}${SHARD_SCOPE.SHARDED ? `-slot${SHARD_SCOPE.SLOT}` : ""}.json`;
  const outPath = path.join(PLAN_OUT, outName);
  const artifact = {
    forLane: "dedupe-sold-comp-copies-by-list",
    finding: `census-sold-comp-copies generator, scope ${CELL}: ${f(grouped)} groups of >=2 docs, `
      + `${f(entriesEmitted)} entries emitted, ${f(needsRuling.length)} needsRuling.`,
    generatedAt: new Date().toISOString(),
    scope: CELL,
    census: {
      lane: "census-sold-comp-copies",
      cell: CELL,
      slot: SHARD_SCOPE.SLOT, slots: SHARD_SCOPE.SLOTS,
      idsScanned: ids.length,
      idsConsideredInPass2: consideredIds.length,
      notConsidered,
      single, intraDocDriftIds, grouped,
      entriesEmitted, needsRulingCount: needsRuling.length,
      reconciled: reconciles,
      shapeHistogram: Object.fromEntries(shapeHistogram),
      topSetKeys: Object.fromEntries(topSetKeys),
      needsRuling,
    },
    entries,
  };
  try {
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
    console.log(`\n  candidate list written to ${outPath}`);
  } catch (e) {
    console.log(`\n::warning::could not write the candidate list artifact (${outPath}): ${e?.message}`);
  }

  if (notConsidered > 0) {
    console.log(`\n  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- ${f(notConsidered)} id(s) not yet considered; `
      + "the relaunch reruns this WHOLE shard from the top (no cursor -- see the header).");
  } else {
    console.log(`\n  finished within budget (ids considered=${f(consideredIds.length)}) -- done, no re-dispatch.`);
  }
  console.log("\nREPORT ONLY -- this generator never writes to Cosmos, in any mode.");

  return { client, budget: CLOCK, exitCode: process.exitCode || 0, printedBudgetMarker: notConsidered > 0 };
}

module.exports = { SCOPE_ERROR, CELL_RE, shapeOf, setKeyPrefixOf, keeperNameAgreesWithSale, stripVocabularyForKeeper };

if (require.main === module) {
  main()
    .then((ctx) => finishLane(ctx?.exitCode || 0, ctx || {}))
    .catch(async (e) => {
      console.error("FATAL:", e?.stack || e?.message);
      await finishLane(3, {});
    });
}
