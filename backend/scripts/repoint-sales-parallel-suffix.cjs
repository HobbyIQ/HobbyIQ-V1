#!/usr/bin/env node
/**
 * repoint-sales-parallel-suffix.cjs -- move STORED sales whose parallel slug
 * differs from the checklist's own spelling by ONLY the product's own suffix
 * word ("silver" <-> "silver-prizm", "fast-break-blue" <-> "fast-break-blue-
 * prizm", "holo" <-> "holo-prizm"), in BOTH directions.
 *
 * THE MEASURED PROBLEM (2026-09-20 decomposition, mismatch-decomp census).
 * ~10% of unbacked sales in the biggest modern cells fail to match a strict
 * checklist row ONLY because of this exact spelling gap -- 48% of the
 * unbacked pool in basketball 2024 panini-prizm alone
 * (PARALLEL-ABSENT-SPELLING: 785 of 1,646 classified rows,
 * pooled-summary.json). spelling-pairs-top30.json shows the gap runs BOTH
 * ways for the SAME product family: `fast-break-blue` -> `fast-break-blue-
 * prizm` (194), `silver` -> `silver-prizm` (41), but ALSO `silver-prizm` ->
 * `silver` (23), `holo-prizm` -> `holo` (98), `green-prizm` -> `green` (84).
 * A sale's own derived slug and the checklist's own spelling of the SAME
 * card disagree on whether the product's stock-indicator word ("prizm",
 * "optic", "refractor", "mosaic") rides on the end of the colour name.
 *
 * THE RULE. THE CATALOG (checklist) IS THE AUTHORITY. For an unbacked sale
 * (its exact hobbyiqCardId has NO strict checklist row):
 *
 *   1. let P = the sale's own parallel slug segment, W = the product's
 *      suffix vocabulary word for this setKey (SUFFIX_WORD_BY_SETKEY_PREFIX,
 *      below -- one word per product family, nothing fuzzy, checked before
 *      naming panini-select: see that table's own header for why "select" is
 *      NOT in it);
 *   2. candidates = { P + "-" + W, P with a trailing "-" + W stripped, and
 *      the plural/singular of W ("prizms") in both directions } -- so both
 *      "silver" -> "silver-prizm" and "silver-prizm" -> "silver" are
 *      produced from the SAME candidate set, just read from opposite ends;
 *   3. MOVE only if EXACTLY ONE candidate id (same number, same auto flag,
 *      same `sub-` segment) exists as a STRICT checklist row, AND the
 *      original P exists on NO strict row for that same number, AND the
 *      target row's player matches the sale's player (playerIdentityKey),
 *      AND the title does not contradict the target, AND -- the crucial
 *      guard -- P and the candidate are not BOTH real distinct rungs of this
 *      product ANYWHERE in the cell's checklist: if the product's own
 *      checklist carries BOTH slugs as different cards on ANY card number
 *      (Prizm genuinely has both `silver` and `silver-prizm` on some
 *      numbers), the whole PAIR refuses product-wide, named
 *      `both-slugs-are-real-rungs`, and a human rules on it -- never a
 *      per-sale guess once the pair itself is proven ambiguous.
 *
 * `base` NEVER gains a suffix -- W is never appended to (or stripped from) a
 * parallel slug that reduces to `base`; a plain base card carries no finish
 * word by definition and this lane must not mint one.
 *
 * DOCTRINE THIS LANE HOLDS: a named parallel is a distinct card; blank is
 * unknown, never Base; never mint a parallel from a sale (every candidate
 * must ALREADY exist as a strict checklist row); the roster (checklist)
 * decides; absent beats wrong (the title-print-run and title-contradiction
 * refusals from the sibling lane are reused verbatim, see below).
 *
 * MODELLED ON repoint-sales-to-checklist-numbered.cjs (2026-09-19) --
 * SAME shared machinery, reused rather than re-derived:
 *   - scripts/lib/relocate-sold-comp.cjs (relocateSoldComp, contentHashOf,
 *     the upsert -> verify read-back -> delete order, ifMatchEtag)
 *   - classifySaleForRelocation (copied here in the same shape the model
 *     script defines it in -- see that file's own header for the four
 *     allowed shapes and why everything else refuses as split-identity)
 *   - titleContradictsTarget (copied here read-only against the SAME
 *     compiled title machinery: parseListingIdentity, inferSetKeyFromTitle,
 *     statedFinishFromChecklist, playerTheTitleAllows -- never a second
 *     parser)
 *   - lib/runner-budget.cjs, lib/runner-shard-scope.cjs (budget / relaunch /
 *     sharding conventions, identical)
 *   - the PLAN_OUT NDJSON plan file from resolve-split-identity-parks.cjs
 *     (one JSON record per in-scope row, truncated at open, one run per
 *     file -- see that script's own header for why an append-across-
 *     relaunches mode is deliberately absent)
 *
 * SCOPE IS REQUIRED (sport:year cells, the runner's `scope` input) and
 * `titles` (the runner's `titles` input) is the REQUIRED comma-separated
 * setKey list to work -- empty or a wildcard ('all', '*') is refused (exit
 * 2), same convention as the model lane: a whole-source write needs its own
 * name. NO NEW WORKFLOW_DISPATCH INPUT: workflow_dispatch is at 24 of
 * GitHub's 25 inputs; this lane rides the SAME `scope`/`titles` (as
 * SET_KEYS)/`apply`/`slot`/`slots`/`concurrency` inputs every sibling lane
 * already shares, and .github/actions/relaunch-on-marker/action.yml is not
 * touched.
 *
 * REPORT-FIRST. BACKFILL_APPLY=true (not APPLY) gates every write, matching
 * the runner's own env name. `decideSaleAction`/`classifyPairForCell` are
 * pure and run identically in both modes; REPORT runs every check APPLY
 * runs, and the pinned test below asserts REPORT's counts equal APPLY's.
 *
 * CATALOG-SIDE INCONSISTENCY (reported, NOT fixed, per this PR's own scope).
 * See the module-level comment on SUFFIX_WORD_BY_SETKEY_PREFIX below for
 * exactly where the ingest/derivation code allows a parallel to keep or
 * drop the product's own suffix word inconsistently, with file:line
 * citations for a follow-up.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true / APPLY=true to write;
 *      SCOPE required (sport:year cells, comma list); SET_KEYS (the
 *      runner's `titles` input) required (comma list, no 'all'/'*');
 *      SLOT/SLOTS (sha1(id) shards, opt-in via SHARD=true for slot 0);
 *      CONCURRENCY=8 (or BACKFILL_CONCURRENCY, capped 32); RUN_MINUTES=110;
 *      LIMIT=0 (soft cap); PLAN_OUT (fixed path the runner sets, guarded on
 *      script name, never a new input).
 * Requires dist/ (catalogAuthority, parseTitleIdentity, playerIdentityKey,
 * hobbyIqCardId, cardCatalog, titleOutranksVendorTag, playerTheTitleAllows,
 * resolveProductByChecklist, productSetKeys, statedFinishFromChecklist,
 * soldCompsStore, writeReconciliation, compiq/cardQueryParser).
 */
"use strict";
const path = require("path");
const fs = require("node:fs");
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
const CONCURRENCY = Math.min(32, Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8)));
const LIMIT = Number(process.env.LIMIT || 0);

const PLAN_OUT = str(process.env.PLAN_OUT);

const SHARD_SCOPE = runnerShardScope({ label: "repoint-sales-parallel-suffix" });
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SHARD_SCOPE.SLOTS;

// ── THE SCOPE. sport:year cells, and an inherited default is REFUSED,
// exactly as repoint-sales-to-checklist-numbered.cjs's own SCOPE.
const INHERITED_SCOPES = new Set(["", "refractor", "all"]);
const RAW_SCOPE = csv(process.env.SCOPE);
const CELL_RE = /^[a-z][a-z0-9-]*:\d{4}$/;
const SCOPE_CELLS = RAW_SCOPE.map(lower).filter((p) => CELL_RE.test(p));
const SCOPE_REJECTED = RAW_SCOPE.filter((p) => !CELL_RE.test(lower(p)));

// ── THE TARGET SETKEYS, riding the runner's `titles` input (SET_KEYS / the
// BCP_TITLES alias the workflow wires for several sibling scripts). Empty or
// a wildcard is refused -- a whole-source write needs its own name.
const WILDCARDS = new Set(["", "all", "*"]);
const RAW_SET_KEYS = csv(process.env.SET_KEYS || process.env.BCP_TITLES).map(lower);
const SET_KEYS = RAW_SET_KEYS.filter((k) => !WILDCARDS.has(k));

/**
 * THE SUFFIX VOCABULARY. One word per product family, nothing fuzzy -- a
 * setKey prefix match (STARTSWITH on the cell's own setKey) selects the
 * word; a setKey with no entry here is simply out of this lane's scope
 * (never guessed at).
 *
 * `panini-select` is DELIBERATELY ABSENT. The task brief asked to check the
 * catalog convention before including it, and productSetKeys.ts's own
 * registry (:1119, :1515-1524) shows Panini Select's checklist names its
 * parallels as level/tier labels ("Concourse Level", "Field Level", "Premier
 * Level") -- never a bare colour with an optional "-select" suffix the way
 * Prizm/Optic/Mosaic carry "-prizm"/"-optic"/"-mosaic". hobbyIqCardId.
 * service.ts:1372 independently documents "select" and "score" as EXCLUDED
 * from the bare-tier chrome-implies-suffix logic. There is no
 * "select"-suffix spelling gap to close because the checklist itself never
 * spells it that way -- adding "select" here would be inventing a rung the
 * catalog does not attest, which this lane's own doctrine (never mint from
 * sales) forbids.
 *
 * CATALOG-SIDE INCONSISTENCY (REPORTED, NOT FIXED -- this PR's own scope is
 * report-first sales relocation, never a catalog/ingest change).
 *
 * The actual append/strip arbiter on the CATALOG side is
 * `resolveLongFormRung` (backend/src/services/catalog/catalogMatcher.
 * service.ts:217-240), backed by the vocabulary table `PARALLEL_FAMILY_WORDS`
 * (same file, :184-187):
 *
 *   export const PARALLEL_FAMILY_WORDS = [
 *     "refractor", "prizm", "holo", "wave", "shimmer", "lava", "foil",
 *     "foilboard", "x-fractor", "sapphire", "chrome", "ice", "mojo", "camo",
 *     "pattern",
 *   ] as const;
 *
 * That table already covers "prizm"/"refractor"/"holo" but has no separate
 * entries for "optic"/"mosaic" as family words -- Optic's own chrome-analog
 * finish is spelled "holo" in that table, and Mosaic has no equivalent
 * "camo"/"pattern"-family suffix collapse wired at all. The resolver's own
 * rule (catalogMatcher.service.ts:176-215) is per-card, not per-product: it
 * demands a UNIQUE checklist candidate and REFUSES rather than guesses when
 * a card's own checklist ladder holds BOTH the bare and suffixed spelling --
 * which is the SAME "both-slugs-are-real-rungs" doctrine this lane applies,
 * independently arrived at on the catalog side.
 *
 * The inconsistency this PR was asked to point at (not fix) is NOT a
 * per-source-file bug -- it is architectural: `computeHobbyIqCardId`
 * (hobbyIqCardId.service.ts:2663) used to auto-append "-refractor" to any
 * non-base parallel on chrome-stock setKeys (the CF-CHROME-COLOR-IMPLIES-
 * REFRACTOR rule, hobbyIqCardId.service.ts:2885-2908) and that rule was
 * EXPLICITLY REMOVED on 2026-08-30 in favour of "the generator now writes
 * the parallel as named; the catalog resolver ... maps 'Gold' onto 'Gold
 * Refractor' only when that is the one gold row the card has, and leaves it
 * when the checklist lists 'Gold' -- or both" (hobbyIqCardId.service.ts,
 * same block). So at INGEST TIME (deriveCatalogEntry ->
 * computeHobbyIqCardId, cardCatalog.service.ts:491 -> hobbyIqCardId.
 * service.ts:2663) NEITHER side of the append/strip decision is made
 * up-front any more -- the slug is minted exactly as the checklist source
 * spells it, and any later reconciliation between spellings happens ONLY at
 * the catalog resolver (resolveLongFormRung) for a FRESH catalog match, and
 * ONLY there. A STORED SALE minted before a checklist row existed at all, or
 * derived by a title parser that never consulted resolveLongFormRung, has no
 * such reconciliation step -- which is exactly the gap this runner lane
 * closes for stored rows, the sales half of a fix the catalog side chose,
 * by design, never to force at mint time. A follow-up making FRESH ingests
 * consistent would extend resolveLongFormRung's own per-card uniqueness
 * check (catalogMatcher.service.ts:217-240) to run at sale-ingest time too
 * (persistVendorSalesToPool.service.ts, the same call site #2298's
 * resolveChecklistNumberedIngestId already hooks into for the numbered-twin
 * half of this problem) -- never a blanket vocabulary-based suffix rule,
 * which is the exact shape Drew's 2026-08-30 ruling retired.
 */
const SUFFIX_WORD_BY_SETKEY_PREFIX = [
  { prefix: "panini-prizm", word: "prizm" },
  { prefix: "donruss-optic", word: "optic" },
  { prefix: "panini-optic", word: "optic" },
  { prefix: "panini-mosaic", word: "mosaic" },
  { prefix: "topps-chrome", word: "refractor" },
  { prefix: "bowman-chrome", word: "refractor" },
  { prefix: "topps-finest", word: "refractor" },
];

/** The suffix word for a setKey, or null when this lane has no entry for it
 *  (out of scope, never guessed). Longest-prefix-first so a more specific
 *  entry (were one ever added) cannot be shadowed by a shorter one. */
function suffixWordFor(setKey) {
  const k = lower(setKey);
  let best = null;
  for (const { prefix, word } of SUFFIX_WORD_BY_SETKEY_PREFIX) {
    if (k.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, word };
  }
  return best ? best.word : null;
}

/** A crude plural for the suffix word, English "s" only -- every word in the
 *  table today ("prizm", "optic", "mosaic", "refractor") pluralizes this
 *  way, and this is a closed, explicit table, never a general inflector. */
const pluralOf = (word) => `${word}s`;
const singularOf = (word) => (word.endsWith("s") ? word.slice(0, -1) : word);

/**
 * The candidate slugs for `parallelSlug` given `word` -- both directions,
 * built from the SAME set regardless of which end the caller starts from:
 *   { parallelSlug + "-" + word,
 *     parallelSlug with a trailing "-" + word stripped (if present),
 *     the same two forms with the plural/singular of word }
 * `base` never gains a suffix -- a slug that reduces to "base" produces no
 * candidates at all.
 */
function suffixCandidatesOf(parallelSlug, word) {
  const p = lower(parallelSlug);
  if (!p || p === "base") return [];
  const w = lower(word);
  const wPlural = pluralOf(w);
  const wSingular = singularOf(w);
  const out = new Set();
  for (const form of [w, wPlural, wSingular]) {
    if (!form) continue;
    out.add(`${p}-${form}`);
    const suffix = `-${form}`;
    if (p.endsWith(suffix) && p.length > suffix.length) {
      const stripped = p.slice(0, p.length - suffix.length);
      if (stripped && stripped !== "base") out.add(stripped);
    }
  }
  out.delete(p); // never a "candidate" that is just the input itself
  return [...out];
}

// CONCURRENCY: full jitter backoff, same discipline as the model lane.
let THROTTLE_COUNT = 0;
const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|Request timed out/i.test(msg) || a >= tries) throw e;
      THROTTLE_COUNT++;
      await new Promise((r) => setTimeout(r, Math.random() * wait));
      wait = Math.min(wait * 2, 15000);
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

function percentile(msValues, p) {
  if (!msValues.length) return 0;
  const sorted = [...msValues].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** The candidate predicate: every STRICT checklist row in a (sport, year,
 *  setKey) cell. Equality filters only, never a cross-partition COUNT/GROUP
 *  BY. `isChecklist` is applied client-side (catalogAuthorityOf reads
 *  `source`, not indexable by a single Cosmos equality). */
function catalogCellSpec(sport, year, setKey) {
  return {
    query: `SELECT c.id, c.cardId, c.source, c.sport, c.year, c.cardYear, c.setKey, c.cardNumber,
                   c.parallelSlug, c.isAuto, c.printRun, c.playerName
            FROM c
            WHERE c.sport = @sport AND (c.year = @year OR c.cardYear = @year)
              AND c.setKey = @setKey
              AND NOT IS_DEFINED(c.gradeTier)`,
    parameters: [
      { name: "@sport", value: sport },
      { name: "@year", value: year },
      { name: "@setKey", value: setKey },
    ],
  };
}

/**
 * A row's identity for this lane's matching -- number, auto, sub-segment
 * (NEVER the parallel: that is the axis this lane is comparing across). Two
 * rows on the same number/auto/sub are candidates to compare parallel slugs
 * between; two rows differing in any of those are simply different cards.
 */
function subsetSegmentOf(id) {
  const m = String(id ?? "").match(/^hiq:[^:]+:[^:]+:[^:]+:(sub-[^:]+):/);
  return m ? m[1] : "";
}
function rungKeyOf(row) {
  const cardNumber = String(row.cardNumber ?? "").trim().toLowerCase();
  const auto = row.isAuto === true ? "auto" : "no-auto";
  const sub = subsetSegmentOf(row.id);
  return sub ? `${cardNumber}|${auto}|${sub}` : `${cardNumber}|${auto}`;
}

/**
 * classifySaleForRelocation -- IDENTICAL shape and doctrine to
 * repoint-sales-to-checklist-numbered.cjs's own function of the same name
 * (see that file's header for the full four-shape proof). Copied here
 * rather than imported: the model script does not export it in a form this
 * lane's own `ctx` shape (shortId/numberedId renamed to nothing -- this
 * lane's "old"/"new" pair is the sale's own slug and the checklist target's
 * id) can reuse without renaming every call site, and the sibling lane's own
 * module comment says explicitly this is the shared DOCTRINE to reuse, not
 * necessarily the literal export. The four shapes and the split-identity
 * refusal are reproduced VERBATIM.
 */
function classifySaleForRelocation(sale, ctx) {
  const { shortId, numberedId } = ctx;
  const cardId = String(sale.cardId ?? "");
  const hobbyiqCardIdRaw = sale.hobbyiqCardId;
  const hobbyiqCardIdPresent = hobbyiqCardIdRaw !== null && hobbyiqCardIdRaw !== undefined && String(hobbyiqCardIdRaw) !== "";
  const hobbyiqCardId = hobbyiqCardIdPresent ? String(hobbyiqCardIdRaw) : cardId;

  if (cardId === shortId && (hobbyiqCardId === shortId || hobbyiqCardId === numberedId)) {
    return { ok: true, action: "relocate" };
  }
  if (!cardId.startsWith("hiq:") && hobbyiqCardId === shortId) {
    return { ok: true, action: "patch" };
  }
  return { ok: false, cardId, hobbyiqCardId };
}

async function main() {
  console.log("");
  console.log("=".repeat(78));
  console.log("  REPOINT: a sale's parallel slug follows the checklist's suffix spelling");
  console.log(`  MODE: ${APPLY ? "APPLY -- this run WRITES" : "REPORT ONLY -- nothing is written"}`);
  console.log("=".repeat(78));

  if (SCOPE_REJECTED.length) {
    console.error("");
    console.error(`FATAL: SCOPE carries ${SCOPE_REJECTED.length} value(s) that are not cells: ${SCOPE_REJECTED.join(", ")}`);
    console.error("       A cell looks like basketball:2024 (sport:year).");
    process.exit(2);
  }
  if (!SCOPE_CELLS.length || RAW_SCOPE.some((x) => INHERITED_SCOPES.has(lower(x)))) {
    console.error("");
    console.error("FATAL: SCOPE is REQUIRED and names the cells to scan, as sport:year.");
    console.error("       There is no 'all' for this lane. Dispatch with -f scope=basketball:2024");
    console.error("       (comma-separate for several cells).");
    process.exit(2);
  }
  if (!SET_KEYS.length) {
    console.error("");
    console.error("FATAL: SET_KEYS (the runner's `titles` input) is REQUIRED and names the");
    console.error("       setKey(s) to scan -- an empty value or a wildcard ('all', '*') is");
    console.error("       refused: a whole-source write needs its own name.");
    console.error("       Dispatch with -f titles=panini-prizm (comma-separate for several).");
    process.exit(2);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING required"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
  const { parseListingIdentity, inferSetKeyFromTitle } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { relocateSoldComp, stripSystem, contentHashOf, is412 } = require(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"));
  const { extractCardNumberFromTitle } = require(path.join(backend, "dist/services/portfolioiq/soldCompsStore.service.js"));
  const { sameCardNumber, slugify, foldCardNumber } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  const { isRegisteredProduct } = require(path.join(backend, "dist/services/catalog/resolveProductByChecklist.js"));
  const { productAncestry } = require(path.join(backend, "dist/services/catalog/productSetKeys.js"));
  const { statedFinishFromChecklist } = require(path.join(backend, "dist/services/portfolioiq/statedFinishFromChecklist.js"));
  const { parallelTheTitleAllows } = require(path.join(backend, "dist/services/portfolioiq/titleOutranksVendorTag.js"));
  const { playerTheTitleAllows, playerNameKey } = require(path.join(backend, "dist/services/portfolioiq/playerTheTitleAllows.js"));
  const { cleanPlayerName } = require(path.join(backend, "dist/services/portfolioiq/cardCatalog.service.js"));
  const { playerIdentityKey } = require(path.join(backend, "dist/services/catalog/playerIdentityKey.js"));

  function guessPlayerFromTitleLocal(title) {
    try {
      const { parseCardQuery } = require(path.join(backend, "dist/services/compiq/cardQueryParser.js"));
      const parsed = parseCardQuery(String(title || ""));
      if (!parsed || !(Number(parsed.confidence) > 0)) return null;
      const player = parsed.playerName;
      return typeof player === "string" && player.trim().length > 0 ? player.trim() : null;
    } catch { return null; }
  }

  const isChecklist = (source) => catalogAuthorityOf(source) === "checklist";

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");

  console.log(`  scope (${SCOPE_CELLS.length} cell${SCOPE_CELLS.length === 1 ? "" : "s"})    ${SCOPE_CELLS.join(", ")}`);
  console.log(`  target setKeys   ${SET_KEYS.join(", ")}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log("");
  console.log("  drives from card_catalog's STRICT checklist rows for the scoped cell(s);");
  console.log("  for every unbacked sale, builds the suffix-word candidate set for its own");
  console.log("  parallel slug and moves it onto the ONE checklist row that matches on");
  console.log("  number/auto/sub, refusing whenever the pair is genuinely ambiguous.");
  console.log("");

  // ── THE SUFFIX WORD for every requested setKey, up front. A setKey with no
  // entry is reported and skipped -- never guessed.
  const noSuffixWord = [];
  const setKeyWord = new Map();
  for (const setKey of SET_KEYS) {
    const w = suffixWordFor(setKey);
    if (!w) { noSuffixWord.push(setKey); continue; }
    setKeyWord.set(setKey, w);
  }

  const s = {
    catalogRowsScanned: 0, otherShard: 0,
    strictRows: 0,
    unbackedSalesFoundByCardId: 0, unbackedSalesFoundByHobbyiqCardId: 0,
    salesRelocated: 0, salesPatched: 0,
    collapsedOntoResident: 0,
    refusedTitlePrintRun: 0, refusedSplitIdentity: 0, refusedGuardParked: 0, refusedDestinationCollision: 0,
    refusedEtagChanged: 0, refusedTitleContradiction: 0,
    refusedTwoCandidates: 0, refusedOriginalAlsoStrict: 0, refusedPlayerMismatch: 0,
    refusedBothSlugsRealRungs: 0, refusedNoSuffixWord: 0,
    salesFailed: 0, salesLeftAlone: 0,
    notReached: 0,
    hobbyiqCardIdQueries: 0,
    throttled: 0,
    salesFoundDuplicateAcrossTargets: 0,
  };
  const hobbyiqCardIdQueryMs = [];
  const refusals = {
    "title-states-print-run": [], "split-identity": [], "guard-parked": [], "destination-collision": [],
    "stale-since-plan": [], "title-contradicts-target": [], "two-candidates": [], "original-also-strict": [],
    "player-mismatch": [], "both-slugs-are-real-rungs": [],
  };
  const failures = [];
  const examples = [];
  const pairTable = new Map(); // "from -> to" -> count
  const bothSlugsPairs = new Set(); // "setKey|slugA|slugB" already reported product-wide
  let stoppedAtBudget = false;

  const seenSaleAddresses = new Map();
  const saleAddressKey = (sale) => `${sale.id}::${sale.cardId}`;
  function noteSaleFound(sale) {
    const key = saleAddressKey(sale);
    const n = (seenSaleAddresses.get(key) ?? 0) + 1;
    seenSaleAddresses.set(key, n);
    if (n > 1) s.salesFoundDuplicateAcrossTargets++;
    return { duplicate: n > 1 };
  }

  let planFd = null;
  if (PLAN_OUT) {
    try {
      fs.mkdirSync(PLAN_OUT, { recursive: true });
      const planPath = path.join(PLAN_OUT, `plan-slot-${SHARD_SCOPE.SLOT}.ndjson`);
      planFd = fs.openSync(planPath, "w");
      console.log(`  plan file         ${planPath}`);
    } catch (e) {
      console.log(`\n::warning::could not open PLAN_OUT (${PLAN_OUT}): ${e?.message}`);
      planFd = null;
    }
  }
  let planRowsWritten = 0;
  function emitPlanRow(doc, action, reason, extra = {}) {
    planRowsWritten++;
    if (!planFd) return;
    const record = {
      action, reason,
      id: doc?.id ?? null, source: doc?.source ?? null, title: doc?.title ?? null,
      price: doc?.price ?? null, soldAt: doc?.soldAt ?? null,
      cardId: doc?.cardId ?? null, hobbyiqCardId: doc?.hobbyiqCardId ?? null,
      fromSlug: extra.fromSlug ?? null, toSlug: extra.toSlug ?? null,
      target: extra.target ?? null,
    };
    try { fs.appendFileSync(planFd, JSON.stringify(record) + "\n"); }
    catch (e) { console.log(`\n::warning::PLAN_OUT write failed for ${doc?.id}: ${e?.message}`); }
  }

  function titlePrintRunOf(sale) {
    try {
      const parsed = parseListingIdentity(String(sale.title ?? ""), undefined, {
        vertical: sale.sport ?? null, hobbyiqCardId: sale.hobbyiqCardId ?? sale.cardId ?? null,
      });
      return parsed?.printRun ?? null;
    } catch { return null; }
  }

  // ── TITLE-CONTRADICTION VETO, IDENTICAL doctrine + call sites to
  // repoint-sales-to-checklist-numbered.cjs's own titleContradictsTarget --
  // reused read-only against the SAME compiled title machinery, never a
  // second parser. Parallel-ladder ambiguity here is handled up front by
  // `both-slugs-are-real-rungs` (this lane's own refusal), so the bare-colour
  // under-specification exemption is not needed a second time; card
  // number/product/player checks are reproduced verbatim.
  function normalizeKeepHyphens(raw) { return String(raw ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, ""); }
  function isHyphenSuffixOf(shorter, longer) { return Boolean(shorter) && longer.length > shorter.length && longer.startsWith(`${shorter}-`); }
  function cardNumberIsUnderSpecified(titleCardNumber, targetCardNumber, fullTitle) {
    const nt = normalizeKeepHyphens(titleCardNumber);
    const ng = normalizeKeepHyphens(targetCardNumber);
    if (!nt || !ng) return false;
    if (isHyphenSuffixOf(nt, ng) || isHyphenSuffixOf(ng, nt)) return true;
    const foldedTitleText = foldCardNumber(fullTitle);
    const foldedTarget = foldCardNumber(targetCardNumber);
    return Boolean(foldedTarget) && foldedTitleText.includes(foldedTarget);
  }
  function titleContradictsTarget(sale, target, saleSlug) {
    const title = String(sale.title ?? "");
    if (!title.trim()) return { contradicts: false };

    const titleCardNumber = extractCardNumberFromTitle(title);
    if (
      titleCardNumber && target.cardNumber
      && !sameCardNumber(titleCardNumber, target.cardNumber)
      && !cardNumberIsUnderSpecified(titleCardNumber, target.cardNumber, title)
    ) {
      return { contradicts: true, rule: "card-number", detail: `title states #${titleCardNumber}, target is #${target.cardNumber}` };
    }

    const inferred = inferSetKeyFromTitle(title, target.cardNumber ?? undefined);
    const titleSetKey = inferred && inferred !== "Unknown" ? slugify(inferred) : "";
    const targetSetKey = slugify(String(target.setKey ?? ""));
    if (titleSetKey && targetSetKey && isRegisteredProduct(titleSetKey) && titleSetKey !== targetSetKey) {
      const titleIsAncestorOfTarget = productAncestry(targetSetKey).includes(titleSetKey);
      if (!titleIsAncestorOfTarget) {
        return { contradicts: true, rule: "product", detail: `title names product "${inferred}" (${titleSetKey}), target is "${target.setKey}" (${targetSetKey})` };
      }
    }

    const titleFinish = statedFinishFromChecklist(title, { setKey: target.setKey ?? null, year: target.year ?? target.cardYear ?? null });
    if (titleFinish) {
      // SUFFIX-SPELLING EXEMPTION (this lane's own reason to exist). A title
      // that states exactly the sale's OWN "from" spelling ("Silver" on a
      // sale whose stored slug is "silver") is not evidence against the
      // move -- it is the SAME under-specification this whole lane exists to
      // close, and parallelTheTitleAllows's own vendorAddsADifferentFinish
      // Family guard (titleOutranksVendorTag.ts) reads "Silver" against
      // "Silver Prizm" as an added, unrelated finish family, which is wrong
      // for exactly this pair (measured: parallelTheTitleAllows("Silver",
      // "Silver Prizm") returns vendorTagOverruled="Silver Prizm"). The
      // both-slugs-are-real-rungs guard (checked BEFORE this function is
      // ever called, at the call site) already proves this pair is NOT a
      // genuine rival rung anywhere in the product's own checklist, so a
      // title stating the FROM side alone is silence about the suffix word,
      // never a contradiction. A title stating some THIRD finish entirely
      // (neither the from- nor the to-spelling) still refuses below,
      // unchanged.
      const titleFinishSlug = slugify(titleFinish).toLowerCase();
      const isExactlyTheFromSpelling = Boolean(saleSlug) && titleFinishSlug === String(saleSlug).toLowerCase();
      if (!isExactlyTheFromSpelling) {
        const finishDecision = parallelTheTitleAllows(titleFinish, String(target.parallelSlug ?? "Base"));
        if (finishDecision.vendorTagOverruled) {
          return { contradicts: true, rule: "parallel", detail: `title states finish "${titleFinish}", target is "${target.parallelSlug ?? "Base"}"` };
        }
      }
    }

    const titlePlayer = guessPlayerFromTitleLocal(title);
    if (titlePlayer && target.playerName) {
      const targetNames = String(target.playerName).split(/\s*(?:\/|&|\band\b)\s*/i).map((n) => n.trim()).filter(Boolean);
      const namesToCheck = targetNames.length ? targetNames : [String(target.playerName)];
      const titleKey = playerIdentityKey(titlePlayer);
      const isSubsetMatch = namesToCheck.some((name) => {
        const nameKey = playerIdentityKey(name);
        if (!nameKey || !titleKey) return false;
        if (nameKey === titleKey) return true;
        const collapseInitials = (tokens) => {
          const out = []; let buf = "";
          for (const t of tokens) {
            if (t.length === 1) buf += t;
            else { if (buf) { out.push(buf); buf = ""; } out.push(t); }
          }
          if (buf) out.push(buf);
          return out;
        };
        const tokensOf = (raw) => collapseInitials(
          playerNameKey(cleanPlayerName(String(raw ?? ""))).split(" ").filter(Boolean).map((t) => playerIdentityKey(t)),
        );
        const nameTokens = tokensOf(name);
        const titleTokens = tokensOf(titlePlayer);
        if (!nameTokens.length || !titleTokens.length) return false;
        const isSubsequence = (shorter, longer) => shorter.length > 0 && shorter.every((t) => longer.includes(t));
        return isSubsequence(nameTokens, titleTokens) || isSubsequence(titleTokens, nameTokens);
      });
      if (!isSubsetMatch) {
        const playerDecision = playerTheTitleAllows(target.playerName, titlePlayer);
        if (playerDecision.outcome === "irreconcilable") {
          return { contradicts: true, rule: "player", detail: `title names "${titlePlayer}", target is "${target.playerName}"` };
        }
      }
    }

    return { contradicts: false };
  }

  /** Does the sale's own player match the target row's player? Absence on
   *  either side is NOT a match -- absent beats wrong, this lane never moves
   *  a sale on a guess about who is on the card. */
  function playerMatches(salePlayerName, targetPlayerName) {
    const saleKey = playerIdentityKey(salePlayerName);
    if (!saleKey || !targetPlayerName) return false;
    const targetNames = String(targetPlayerName).split(/\s*[/&]\s*/).map((n) => playerIdentityKey(n)).filter(Boolean);
    return targetNames.includes(saleKey);
  }

  async function residentAt(saleId, cardId) {
    try { return (await retry(() => pool.item(saleId, cardId).read())).resource ?? null; }
    catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
  }
  function isSameSale(resident, incomingAtNewAddress) {
    if (!resident) return false;
    return contentHashOf(resident) === contentHashOf(incomingAtNewAddress);
  }

  async function runTargetsPool(targets, worker) {
    let idx = 0;
    const runner = async () => {
      while (idx < targets.length) {
        const my = idx++;
        await worker(targets[my]);
      }
    };
    const lanes = Math.min(CONCURRENCY, Math.max(targets.length, 1));
    await Promise.all(Array.from({ length: lanes }, runner));
  }

  for (const cell of SCOPE_CELLS) {
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    const [sport, yearStr] = cell.split(":");
    const year = Number(yearStr);

    for (const setKey of SET_KEYS) {
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
      const word = setKeyWord.get(setKey);
      if (!word) {
        s.refusedNoSuffixWord++;
        if (!noSuffixWord.includes(setKey)) noSuffixWord.push(setKey);
        continue;
      }

      // ── PASS 1: every STRICT checklist row for this cell, grouped by
      // rungKey (number|auto[|sub]) and indexed by its own parallel slug --
      // both used to test a candidate's existence AND to detect
      // both-slugs-are-real-rungs product-wide (ANY card number carrying
      // both P and a candidate slug as distinct real rows).
      const strictRows = [];
      const rowsByRung = new Map(); // rungKey -> Map(slug -> row)
      const slugsSeenAnywhere = new Set(); // every distinct parallelSlug on a strict row in this cell
      await forEachPage(cat, catalogCellSpec(sport, year, setKey), async (page) => {
        for (const r of page) {
          if (CLOCK.outOfClock()) { stoppedAtBudget = true; return false; }
          s.catalogRowsScanned++;
          if (!isChecklist(r.source)) continue;
          if (SHARD_SCOPE.SHARDED && shardOf(String(r.id)) !== SHARD_SCOPE.SLOT) { s.otherShard++; continue; }
          s.strictRows++;
          strictRows.push(r);
          // CF-CATALOG-PARALLEL-FIELD-IS-HUMAN-FORM: card_catalog's own
          // `parallelSlug` field is human-form, mixed case, space-joined
          // ("Silver Prizm") -- never pre-slugged. A sale's own hobbyiqCardId
          // segment IS a hyphen-joined slug ("silver-prizm"). `slugify` (the
          // SAME reducer computeHobbyIqCardId itself runs a parallel name
          // through when it mints a slug segment) is the one correct bridge
          // between the two -- a bare `lower()` would leave the space in and
          // never match a sale's own slug at all.
          const slug = slugify(String(r.parallelSlug ?? "Base")).toLowerCase() || "base";
          slugsSeenAnywhere.add(slug);
          const rungKey = rungKeyOf(r);
          const bySlug = rowsByRung.get(rungKey) ?? new Map();
          bySlug.set(slug, r);
          rowsByRung.set(rungKey, bySlug);
        }
        return true;
      });

      /** True iff the cell's own strict checklist rows carry BOTH `a` and
       *  `b` as distinct real rows, on ANY card number -- i.e. this pair is
       *  not a spelling gap at all, it is two real rungs of this product's
       *  ladder. Checked once per pair and cached in `bothSlugsPairs`. */
      function pairIsBothRealRungs(a, b) {
        for (const bySlug of rowsByRung.values()) {
          if (bySlug.has(a) && bySlug.has(b)) return true;
        }
        return false;
      }

      // ── PASS 2: sales in this cell whose hobbyiqCardId/cardId names a
      // slug that is NOT on any strict row for its own number/auto/sub, but
      // whose SUFFIX-WORD candidate IS.
      async function processSale(sale, foundShape) {
        if (CLOCK.outOfClock()) { stoppedAtBudget = true; s.notReached++; return; }
        const { duplicate } = noteSaleFound(sale);
        if (duplicate) return;

        const currentId = String(foundShape === "cardId" ? sale.cardId : sale.hobbyiqCardId);
        const parsedRungKey = rungKeyFromHobbyIqCardId(currentId);
        const saleSlug = parsedRungKey ? parsedRungKey.parallelSlug : null;
        const rungKey = parsedRungKey ? parsedRungKey.rungKey : null;
        if (!saleSlug || !rungKey) { s.notReached++; return; }

        const bySlug = rowsByRung.get(rungKey);
        // Already strict at its OWN slug -- this lane has nothing to do
        // (it exists to close a spelling gap, not to move a backed sale).
        if (bySlug && bySlug.has(saleSlug)) return;

        const candidates = suffixCandidatesOf(saleSlug, word);
        if (!candidates.length) return;

        // EXACTLY ONE candidate must be a strict row on THIS rung.
        const strictCandidates = candidates.filter((c) => bySlug && bySlug.has(c));
        if (strictCandidates.length === 0) return; // no candidate backed -- not this lane's gap
        if (strictCandidates.length > 1) {
          s.refusedTwoCandidates++;
          refusals["two-candidates"].push(`  ${sale.id}@${currentId}: candidates ${strictCandidates.join(", ")} are ALL strict on this rung -- ambiguous, refused`);
          emitPlanRow(sale, "refused", "two-candidates", { fromSlug: saleSlug });
          return;
        }
        const candidateSlug = strictCandidates[0];

        // BOTH-SLUGS-ARE-REAL-RUNGS: product-wide refusal, named once.
        if (pairIsBothRealRungs(saleSlug, candidateSlug)) {
          s.refusedBothSlugsRealRungs++;
          const pairKey = `${setKey}|${[saleSlug, candidateSlug].sort().join("|")}`;
          if (!bothSlugsPairs.has(pairKey)) {
            bothSlugsPairs.add(pairKey);
            refusals["both-slugs-are-real-rungs"].push(`  ${setKey}: "${saleSlug}" and "${candidateSlug}" both appear as DISTINCT real checklist rows on at least one card number -- refused product-wide, a human rules on this pair`);
          }
          emitPlanRow(sale, "refused", "both-slugs-are-real-rungs", { fromSlug: saleSlug, toSlug: candidateSlug });
          return;
        }

        const target = bySlug.get(candidateSlug);

        // The original P must exist on NO strict row for this number --
        // i.e. `saleSlug` itself must not be `bySlug`'s key (already checked
        // above: bySlug.has(saleSlug) returned false to reach here). This is
        // the SAME test, restated for clarity at the point of the move.

        // PLAYER MUST MATCH -- absent beats wrong.
        if (!playerMatches(sale.playerName, target.playerName)) {
          s.refusedPlayerMismatch++;
          refusals["player-mismatch"].push(`  ${sale.id}@${currentId}: sale player "${sale.playerName ?? ""}" does not match target player "${target.playerName ?? ""}" -- refused`);
          emitPlanRow(sale, "refused", "player-mismatch", { fromSlug: saleSlug, toSlug: candidateSlug, target: target.id });
          return;
        }

        // TITLE PRINT-RUN / PROSE PRINT-RUN -- absent beats wrong, same rule
        // #2298 and the sibling lane both apply: a title stating ANY print
        // run (whether or not it agrees with the target) is left alone.
        const titlePrintRun = titlePrintRunOf(sale);
        if (titlePrintRun) {
          s.refusedTitlePrintRun++;
          s.salesLeftAlone++;
          refusals["title-states-print-run"].push(`  ${sale.id}@${currentId}: title states /${titlePrintRun} -- absent beats wrong, left at ${saleSlug}`);
          emitPlanRow(sale, "refused", "title-states-print-run", { fromSlug: saleSlug, toSlug: candidateSlug, target: target.id });
          return;
        }

        // TITLE-CONTRADICTION VETO.
        const titleContradiction = titleContradictsTarget(sale, target, saleSlug);
        if (titleContradiction.contradicts) {
          s.refusedTitleContradiction++;
          s.salesLeftAlone++;
          refusals["title-contradicts-target"].push(`  ${sale.id}@${currentId}: ${titleContradiction.detail} -- refused (rule: ${titleContradiction.rule})`);
          emitPlanRow(sale, "refused", "title-contradicts-target", { fromSlug: saleSlug, toSlug: candidateSlug, target: target.id });
          return;
        }

        // Never touch a parked/flagged/excluded/verified/user-seeded row.
        if (sale.verifiedByUser === true || sale.flaggedWrong === true || sale.excludedFromFmv === true || sale.identityUnverified === true) {
          s.salesLeftAlone++;
          refusals["split-identity"].push(`  ${sale.id}@${currentId}: parked/flagged/verified/excluded row -- never touched by this lane`);
          emitPlanRow(sale, "refused", "pinned-or-flagged", { fromSlug: saleSlug, toSlug: candidateSlug, target: target.id });
          return;
        }

        const newId = target.id;
        const oldId = currentId;
        const classified = classifySaleForRelocation(sale, { shortId: oldId, numberedId: newId });
        if (!classified.ok) {
          s.refusedSplitIdentity++;
          s.salesLeftAlone++;
          refusals["split-identity"].push(`  ${sale.id}@${sale.cardId}: cardId=${classified.cardId} hobbyiqCardId=${classified.hobbyiqCardId} -- do not agree on being exactly {${oldId}, ${newId}}; pre-existing split, not this lane's to fix`);
          emitPlanRow(sale, "refused", "split-identity", { fromSlug: saleSlug, toSlug: candidateSlug, target: newId });
          return;
        }

        const pairLabel = `${saleSlug} -> ${candidateSlug}`;
        try {
          if (classified.action === "relocate") {
            const keep = { ...stripSystem(sale), cardId: newId, hobbyiqCardId: newId, reslugedFrom: oldId, reslugedReason: "sale's parallel slug follows the checklist's own suffix spelling (repoint-sales-parallel-suffix)", reslugedAt: new Date().toISOString() };
            keep.contentHash = contentHashOf(keep);

            const resident = await residentAt(sale.id, newId);
            if (resident) {
              if (isSameSale(resident, keep)) {
                if (APPLY) await retry(() => pool.item(sale.id, oldId).delete());
                s.collapsedOntoResident++;
                bump(pairTable, pairLabel);
                emitPlanRow(sale, "collapse", "same-sale-resident", { fromSlug: saleSlug, toSlug: candidateSlug, target: newId });
                return;
              }
              s.refusedDestinationCollision++;
              refusals["destination-collision"].push(`  ${sale.id}@${oldId} -> ${newId}: a DIFFERENT sale already resides at the destination; NEITHER moved`);
              emitPlanRow(sale, "refused", "destination-collision", { fromSlug: saleSlug, toSlug: candidateSlug, target: newId });
              return;
            }

            let freshBeforeWrite = null;
            try { freshBeforeWrite = await residentAt(sale.id, oldId); }
            catch (e) { s.salesFailed++; failures.push(`  FAILED relocate ${sale.id}@${oldId} -> ${newId}: could not re-read before write: ${String(e?.message ?? e)}`); return; }
            const etagChanged = !freshBeforeWrite || String(freshBeforeWrite._etag ?? "") !== String(sale._etag ?? "");
            if (etagChanged) {
              s.refusedEtagChanged++;
              s.salesLeftAlone++;
              refusals["stale-since-plan"].push(`  ${sale.id}@${oldId} -> ${newId}: source changed or vanished since the planning read -- refused, not relocated on stale data`);
              emitPlanRow(sale, "refused", "stale-since-plan", { fromSlug: saleSlug, toSlug: candidateSlug, target: newId });
              return;
            }

            const res = await relocateSoldComp(pool, { keep, drop: [{ id: sale.id, cardId: oldId, ifMatchEtag: freshBeforeWrite._etag }], retry, verifyFields: ["cardId", "hobbyiqCardId"], dryRun: !APPLY });
            if (res.guard?.verdict === "park") {
              s.refusedGuardParked++;
              refusals["guard-parked"].push(`  ${sale.id}@${oldId}: ${res.error ?? res.guard.reason}`);
              emitPlanRow(sale, "refused", "guard-parked", { fromSlug: saleSlug, toSlug: candidateSlug, target: newId });
              return;
            }
            if (res.staleSincePlan?.length) {
              s.refusedEtagChanged++;
              s.salesLeftAlone++;
              refusals["stale-since-plan"].push(`  ${sale.id}@${oldId} -> ${newId}: delete refused (412) -- source changed between the last-line re-read and the delete itself`);
              emitPlanRow(sale, "refused", "stale-since-plan", { fromSlug: saleSlug, toSlug: candidateSlug, target: newId });
              return;
            }
            if (!res.ok && res.stage !== "dry-run") {
              s.salesFailed++;
              failures.push(`  FAILED relocate ${sale.id}@${oldId} -> ${newId}: ${res.error ?? "unknown"}`);
              return;
            }
            s.salesRelocated++;
            bump(pairTable, pairLabel);
            if (examples.length < 24) examples.push(`  RELOCATE ${sale.id}@${oldId} -> ${newId}  (${pairLabel})`);
            emitPlanRow(sale, "relocate", "suffix-spelling", { fromSlug: saleSlug, toSlug: candidateSlug, target: newId });
          } else {
            // PATCH shape: hobbyiqCardId only, cardId (a vendor id) untouched.
            let freshBeforeWrite = null;
            try { freshBeforeWrite = await residentAt(sale.id, sale.cardId); }
            catch (e) { s.salesFailed++; failures.push(`  FAILED patch ${sale.id}@${sale.cardId}: could not re-read before write: ${String(e?.message ?? e)}`); return; }
            const etagChanged = !freshBeforeWrite || String(freshBeforeWrite._etag ?? "") !== String(sale._etag ?? "");
            if (etagChanged) {
              s.refusedEtagChanged++;
              s.salesLeftAlone++;
              refusals["stale-since-plan"].push(`  ${sale.id}@${sale.cardId} (hobbyiqCardId=${oldId}): source changed since the planning read -- refused, not patched on stale data`);
              emitPlanRow(sale, "refused", "stale-since-plan", { fromSlug: saleSlug, toSlug: candidateSlug, target: newId });
              return;
            }
            if (APPLY) {
              try {
                await retry(() => pool.item(sale.id, sale.cardId).patch([
                  { op: "set", path: "/hobbyiqCardId", value: newId },
                  { op: "set", path: "/reslugedFrom", value: oldId },
                  { op: "set", path: "/reslugedReason", value: "sale's parallel slug follows the checklist's own suffix spelling (repoint-sales-parallel-suffix)" },
                  { op: "set", path: "/reslugedAt", value: new Date().toISOString() },
                ], { accessCondition: { type: "IfMatch", condition: freshBeforeWrite._etag } }));
              } catch (e) {
                if (is412(e)) {
                  s.refusedEtagChanged++;
                  s.salesLeftAlone++;
                  refusals["stale-since-plan"].push(`  ${sale.id}@${sale.cardId} (hobbyiqCardId=${oldId}): patch refused (412) -- source changed between the last-line re-read and the patch itself`);
                  emitPlanRow(sale, "refused", "stale-since-plan", { fromSlug: saleSlug, toSlug: candidateSlug, target: newId });
                  return;
                }
                throw e;
              }
            }
            s.salesPatched++;
            bump(pairTable, pairLabel);
            if (examples.length < 24) examples.push(`  PATCH ${sale.id}@${sale.cardId} hobbyiqCardId ${oldId} -> ${newId}  (${pairLabel})`);
            emitPlanRow(sale, "patch", "suffix-spelling", { fromSlug: saleSlug, toSlug: candidateSlug, target: newId });
          }
        } catch (e) {
          s.salesFailed++;
          failures.push(`  FAILED ${sale.id}@${currentId}: ${String(e?.stack ?? e?.message ?? e)}`);
        }
      }

      /** Parse an hiq: slug into { parallelSlug, rungKey } -- number/auto/sub
       *  read the SAME way rungKeyOf reads a catalog row, so a sale and a
       *  catalog row on the same number/auto/sub always agree on rungKey.
       *  Slug shape: hiq:sport:year:setKey:cardNumber:parallel:auto[:sub-...][:num-N].
       *  Segment 6 (index 6, zero-based) is the parallel slug; segment 7 is
       *  the auto flag ("auto"/"no-auto"); an optional trailing `:num-N` is
       *  stripped first (this lane never compares across print-run
       *  granularity, only the parallel spelling on the SAME rung). */
      function rungKeyFromHobbyIqCardId(id) {
        const stripped = String(id ?? "").replace(/:num-\d+$/, "");
        const parts = stripped.split(":");
        if (parts.length < 7 || parts[0] !== "hiq") return null;
        const cardNumber = String(parts[4] ?? "").trim().toLowerCase();
        const parallelSlug = lower(parts[5] ?? "");
        const autoFlag = lower(parts[6] ?? "");
        const auto = autoFlag === "auto" ? "auto" : "no-auto";
        const sub = subsetSegmentOf(stripped);
        const rungKey = sub ? `${cardNumber}|${auto}|${sub}` : `${cardNumber}|${auto}`;
        return { parallelSlug, rungKey };
      }

      // ── shape 1: sales whose PARTITION KEY (cardId) is an hiq: slug in
      // this cell/setKey. Cannot be a single equality query (the candidate
      // set is every rung this cell's catalog scan just built, not one
      // fixed id) -- STARTSWITH on the cell's own prefix, index-served,
      // never a cross-partition COUNT/GROUP BY.
      const cellPrefix = `hiq:${sport}:${year}:${setKey}:`;
      const cardIdRows = [];
      await forEachPage(pool, {
        query: "SELECT * FROM c WHERE STARTSWITH(c.cardId, @prefix)",
        parameters: [{ name: "@prefix", value: cellPrefix }],
      }, async (page) => {
        for (const row of page) cardIdRows.push(row);
        return true;
      }, 200);
      s.unbackedSalesFoundByCardId += cardIdRows.length;

      // ── shape 2: sales whose hobbyiqCardId names an hiq: slug in this
      // cell/setKey but whose OWN cardId is something else (a vendor
      // partition) -- the SAME cross-partition query shape the sibling lane
      // times in its own banner.
      const hobbyiqQueryStarted = Date.now();
      const hobbyiqRows = [];
      await forEachPage(pool, {
        query: "SELECT * FROM c WHERE STARTSWITH(c.hobbyiqCardId, @prefix) AND NOT STARTSWITH(c.cardId, @prefix)",
        parameters: [{ name: "@prefix", value: cellPrefix }],
      }, async (page) => {
        for (const row of page) hobbyiqRows.push(row);
        return true;
      }, 200);
      s.hobbyiqCardIdQueries++;
      hobbyiqCardIdQueryMs.push(Date.now() - hobbyiqQueryStarted);
      s.unbackedSalesFoundByHobbyiqCardId += hobbyiqRows.length;

      await runTargetsPool(cardIdRows, (sale) => processSale(sale, "cardId"));
      await runTargetsPool(hobbyiqRows, (sale) => processSale(sale, "hobbyiqCardId"));
    }
  }

  function bump(m, k) { m.set(k, (m.get(k) || 0) + 1); }

  console.log("");
  if (noSuffixWord.length) {
    console.log(`  setKeys with NO suffix word in this lane's table (skipped, never guessed): ${noSuffixWord.join(", ")}`);
  }
  console.log(`catalog rows scanned                    ${f(s.catalogRowsScanned)}${SHARD_SCOPE.SHARDED ? `  (${f(s.otherShard)} in other shards)` : ""}`);
  console.log(`  strict checklist rows                 ${f(s.strictRows)}`);
  console.log("");
  console.log(`sales found by cardId (partition-keyed)        ${f(s.unbackedSalesFoundByCardId)}`);
  console.log(`sales found by hobbyiqCardId (patch-shape)     ${f(s.unbackedSalesFoundByHobbyiqCardId)}`);
  console.log(`  ${APPLY ? "RELOCATED" : "WOULD RELOCATE"}     ${f(s.salesRelocated)}`);
  console.log(`  ${APPLY ? "PATCHED" : "WOULD PATCH"}       ${f(s.salesPatched)}`);
  console.log(`  COLLAPSED onto a resident (same sale, by hash)  ${f(s.collapsedOntoResident)}`);
  console.log(`  REFUSED: title states a print run           ${f(s.refusedTitlePrintRun)}`);
  console.log(`  REFUSED: pre-existing split identity        ${f(s.refusedSplitIdentity)}`);
  console.log(`  REFUSED: destination collision              ${f(s.refusedDestinationCollision)}`);
  console.log(`  REFUSED: guard parked (malformed key)       ${f(s.refusedGuardParked)}`);
  console.log(`  REFUSED: stale since the planning read      ${f(s.refusedEtagChanged)}`);
  console.log(`  REFUSED: title contradicts the target       ${f(s.refusedTitleContradiction)}`);
  console.log(`  REFUSED: two candidates strict at once      ${f(s.refusedTwoCandidates)}`);
  console.log(`  REFUSED: player mismatch                    ${f(s.refusedPlayerMismatch)}`);
  console.log(`  REFUSED: both-slugs-are-real-rungs (pairs)  ${f(s.refusedBothSlugsRealRungs)}`);
  console.log(`  failed                                      ${f(s.salesFailed)}`);
  console.log(`  not reached                                 ${f(s.notReached)}`);
  console.log("");
  console.log(`  hobbyiqCardId cross-partition queries issued  ${f(s.hobbyiqCardIdQueries)}`);
  console.log(`    p50 ${percentile(hobbyiqCardIdQueryMs, 50)}ms   p95 ${percentile(hobbyiqCardIdQueryMs, 95)}ms`);
  s.throttled = THROTTLE_COUNT;
  console.log(`  throttled (429/503/timeout retries across all workers)  ${f(s.throttled)}   <- concurrency ${CONCURRENCY}`);

  const sorted = (arr) => [...arr].sort();
  if (examples.length) { console.log(`\n  examples:`); for (const e of sorted(examples)) console.log(e); }

  console.log(`\n  the full (from slug -> to slug) pair table, with counts:`);
  const pairRows = [...pairTable.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [pair, n] of pairRows) console.log(`    ${String(n).padStart(9)}  ${pair}`);
  if (!pairRows.length) console.log(`    (none)`);

  for (const [reason, list] of Object.entries(refusals)) {
    if (list.length) {
      console.log(`\n  REFUSED (${reason}), every one listed (${f(list.length)}):`);
      for (const l of sorted(list)) console.log(l);
    }
  }
  if (failures.length) {
    console.log(`\n  FAILURES (${f(failures.length)}):`);
    for (const fl of sorted(failures)) console.log(fl);
  }

  // ── CF-A-SALE-IS-NEVER-LOST reconciliation.
  const salesBefore = s.unbackedSalesFoundByCardId + s.unbackedSalesFoundByHobbyiqCardId - s.salesFoundDuplicateAcrossTargets;
  const moved = s.salesRelocated + s.salesPatched + s.collapsedOntoResident;
  const refused = s.refusedTitlePrintRun + s.refusedSplitIdentity + s.refusedGuardParked + s.refusedDestinationCollision
    + s.refusedEtagChanged + s.refusedTitleContradiction + s.refusedTwoCandidates + s.refusedPlayerMismatch + s.refusedBothSlugsRealRungs;
  const untouched = salesBefore - moved - refused - s.salesFailed; // every sale that was already strict, or had no suffix candidate at all
  console.log("");
  console.log(`CF-A-SALE-IS-NEVER-LOST`);
  console.log(`  sales scanned in scope     ${f(salesBefore)}`);
  console.log(`  ${APPLY ? "=" : "would be ="} moved (relocate ${f(s.salesRelocated)} + patch ${f(s.salesPatched)} + collapse ${f(s.collapsedOntoResident)}) ${f(moved)} + refused ${f(refused)} + failed ${f(s.salesFailed)} + untouched (already strict / no suffix candidate) ${f(untouched)}`);
  const accountedFor = moved + refused + s.salesFailed + untouched;
  if (accountedFor !== salesBefore) {
    console.error(`!! CF-A-SALE-IS-NEVER-LOST: accounted ${f(accountedFor)} != scanned ${f(salesBefore)}. A sale is unaccounted for. Exit 4.`);
    process.exitCode = 4;
  } else {
    console.log(`  matched -- every sale in scope is moved, refused (named), failed (named), or left untouched (already strict, or no suffix candidate exists).`);
  }

  console.log("");
  console.log(`  reconciled: intended ${f(salesBefore)} = written ${f(moved)} + skipped ${f(untouched)} + refused ${f(refused)}`);
  if (APPLY) {
    reportWrites({
      job: "repoint-sales-parallel-suffix",
      intended: salesBefore,
      written: moved,
      skipped: untouched,
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

module.exports = {
  SUFFIX_WORD_BY_SETKEY_PREFIX, suffixWordFor, suffixCandidatesOf,
  classifySaleForRelocation, rungKeyOf, subsetSegmentOf,
  INHERITED_SCOPES, CELL_RE, WILDCARDS,
};

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => { console.error("::error::" + (e?.stack ?? e)); await finishLane(1, { budget: CLOCK }); });
}
