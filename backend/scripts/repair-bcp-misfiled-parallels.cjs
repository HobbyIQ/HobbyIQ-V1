#!/usr/bin/env node
/**
 * repair-bcp-misfiled-parallels.cjs -- D33, the stored rows behind Drew's
 * "still a mess" on 2020 Bowman Draft BD-152.
 *
 * Drew, 2026-08-30, "Find this card" for "2020 BOWMAN Bobby Witt Jr. Royals
 * #BD152 sp". The card had 65 un-graded catalog rows and only 18 of them were
 * the card. Five INDEPENDENT defects converge on it, and each is its own MODE
 * here because each has its own population, its own safety question, and its
 * own answer for "what if the target is not there".
 *
 * MODE=card-as-parallel  (a) The page's CARD LIST was parsed as the parallel
 *   column. baseballcardpedia writes card numbers space-separated ("BD 121
 *   Spencer Torkelson"), and scrape-bcp-ladders' card-line guard tested only
 *   the FIRST space-delimited token -- "BD", not a card number -- so every card
 *   on the page became a "parallel" of every other card. Measured read-only
 *   2026-08-30: 47,267 rows, source baseballcardpedia 28,776 +
 *   baseballcardpedia-graded 18,491, across 2,234 distinct cards. These are not
 *   parallels of anything and no better address exists for them, so they are
 *   RETIRED -- never re-parallelled, never called "Base". The root cause closes
 *   in the same PR (scrape-bcp-ladders.cjs), or the next scrape re-mints all
 *   47,267.
 *
 * MODE=chrome-ladder  (b) The converters attached a product page's WHOLE
 *   parallel ladder to every card number on the page, without the paper/chrome
 *   split. In Bowman Draft the BD- numbers are PAPER (Sky Blue /499, Purple
 *   /250, Blue /150, Green /99, Gold /50, Orange /25, Red /5, Black 1/1) and
 *   the BDC- numbers are CHROME (the Refractor ladder); Bowman is BP- paper and
 *   BCP- chrome. So "Blue Refractor /150" sitting on BD-152 is the CHROME card
 *   filed under the PAPER number. Under D31 no vocabulary rule equates a colour
 *   with its refractor -- the refractor row is a DIFFERENT CARD at a DIFFERENT
 *   NUMBER, so it MOVES to the chrome number; it is never folded into the paper
 *   colour. Sapphire is its own product under D23 and is REPORTED, not moved:
 *   naming that product is a ruling this pass does not get to make.
 *
 *   The brief specified "fold onto the chrome row when it exists, report when
 *   it does not". The data does not fit that shape: on a 400-row sample only
 *   125 (31%) had a row already sitting at the exact chrome id to fold onto,
 *   273 (68%) were MOVES into a free slot, and 2 had no chrome number at all.
 *   A fold-or-report design would have silently skipped two thirds of the work,
 *   so this mode carries all three paths and counts them separately.
 *
 * MODE=first-edition  (c) "1st Edition Blue /150" kept the edition in the
 *   PARALLEL NAME under setKey bowman-draft. D23 ruled the id carries the
 *   product as the checklist names it, and both target products already exist
 *   (bowman-draft-1st-edition 3,705 rows, bowman-1st-edition 8,123). The row
 *   moves to the product and the parallel loses the prefix.
 *
 * MODE=names  (d) baseballcardpedia writes the generational suffix with a comma
 *   ("Bobby Witt, Jr.") and cleanPlayerName's trim was end-anchored -- the
 *   trailing character is the "." -- so both spellings persist and the picker
 *   renders ONE player as TWO. 158,567 rows measured 2026-08-30, catalog-wide;
 *   not a Bowman defect. The id carries no player segment, so this is a PATCH,
 *   not a move: the same shape repair-trailing-comma-player-names.cjs uses, and
 *   it calls the SAME cleanPlayerName / slugify / rebuildSearchFields rather
 *   than re-spelling any of them.
 *
 * MODE=number-glued  (f) checklistcenter's "Black 1" (the 1/1 swallowed into
 *   the name) minted `black-1` beside the real `black:num-1`, and the same
 *   shape produced `superfractor-1` / `superfractor-1-refractor`. 20,031 rows
 *   across baseball, football and basketball -- a bowman-only filter would miss
 *   most of them. The fold decision is foldTwinRule.decideTwinFold, whose
 *   ALWAYS_ONE_OF_ONE already encodes superfractor / printing-plate = 1/1.
 *
 * WHAT EVERY MODE REFUSES TO DO.
 *   - It never MINTS a card. When a row's target number does not exist in the
 *     catalog at all, the row is REPORTED and left where it is: the checklist is
 *     the authority on what cards exist, and a repair pass inventing one is how
 *     a wrong row becomes a permanent wrong row.
 *   - It never writes a parallel onto a row it could not place. "Unplaceable" is
 *     reported, never defaulted to Base (retire-prose-parallel-rows' rule).
 *   - Every move, fold and retire goes through catalogRowOps (moveCatalogRow /
 *     retireCatalogRow), which writes the survivor first, re-points the sales,
 *     retires the old slug's graded children, and deletes the old row LAST.
 *     This file never deletes or upserts a catalog row itself.
 *   - MODE is required and has no default: a whole-scope write that guessed its
 *     own scope is the shape that reported 13.14M rows for the wrong source.
 *
 * THE PLAYER GATE, and why it is not string equality. A move from BD-N to BDC-N
 * is only safe if both numbers name the same player. Measured over 1,091
 * distinct (year, setKey, chromeNumber) pairs on 2026-08-30: naive equality
 * called 132 of them mismatches, and every one was spelling noise -- diacritics
 * (Sanchez vs the accented spelling), the comma suffix this same PR fixes
 * ("Robby Martin, Jr." vs "Robby Martin Jr."), a scraped "1st" glued to the name
 * ("Jhonkensy Noel 1st"), and a suffix present on one side only ("Bobby Witt" vs
 * "Bobby Witt Jr."). samePlayer folds all four and leaves exactly ONE residual
 * in 1,091 -- "CJ Chatham" vs "C.J. Chatham" -- which is refused and reported
 * rather than guessed at. A gate that refuses 132 good moves is as wrong as a
 * gate that allows one bad one.
 *
 * Env: COSMOS_CONNECTION_STRING (required); MODE (required, no default);
 *      BACKFILL_APPLY / APPLY (report only by default); SLOT/SLOTS (sha1(id)
 *      shards -- NOT setKey: four products would put half the work on one
 *      worker); CONCURRENCY / BACKFILL_CONCURRENCY=8; RUN_MINUTES=140; LIMIT=0;
 *      YEARS, SPORTS, SOURCES (comma lists); SCOPE (comma list of setKeys).
 */
"use strict";
const crypto = require("node:crypto");
const path = require("node:path");

const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true";
const MODE = String(process.env.MODE || "").trim().toLowerCase();
// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1756, generalised 2026-09-04).
// The runner exports `slots` for EVERY script with a workflow-wide DEFAULT of
// "16", so `process.env.SLOTS ?? 1` NEVER saw undefined and this lane sharded
// itself sixteen ways on a dispatch that asked for no sharding -- sweeping slot
// 0 and leaving fifteen sixteenths untouched, green and honestly reconciled.
// Sharding is now OPT-IN: a non-zero slot, or an explicit SHARD=true for slot 0
// of a real fan-out. Everything else -- including the inherited slot=0 slots=16
// -- sweeps EVERY row. SLOTS binds to 1 when unsharded, so `% SLOTS` and
// `SLOTS === 1` guards below keep working unchanged.
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
const SHARD_SCOPE = runnerShardScope({ label: "repair-bcp-misfiled-parallels" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 140);
const RUN_MS = RUN_MINUTES * 60000;
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8));
const LIMIT = Number(process.env.LIMIT || 0);
const YEARS = String(process.env.YEARS || "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const SPORTS = String(process.env.SPORTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const SOURCES = String(process.env.SOURCES || "").split(",").map((s) => s.trim()).filter(Boolean);
const SCOPE = String(process.env.SCOPE || "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => s && s !== "refractor" && s !== "all");
const f = (n) => Number(n).toLocaleString();
const started = Date.now();
const budgetLeft = () => RUN_MS - (Date.now() - started);
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;
const retry = async (fn, tries = 10) => { let wait = 700; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const m = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(m) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 30000); } } };
const backend = path.resolve(__dirname, "..");

const MODES = ["card-as-parallel", "chrome-ladder", "first-edition", "names", "number-glued"];

// -- pure decisions ----------------------------------------------------------

/**
 * (a) A parallelSlug that is ANOTHER CARD: a Bowman-family number prefix, a
 * number, then a name. "bd-121-spencer-torkelson" yes; "bd-152" alone no (a
 * card number with no name is a different defect); "blue-refractor" no.
 */
const CARD_AS_PARALLEL = /^(bd|bdc|bcp|bp|bdpp|cpa)-\d+[a-z]?-[a-z]/;
function isCardAsParallel(row) {
  if (!row || typeof row.parallelSlug !== "string") return false;
  if (!String(row.source ?? "").startsWith("baseballcardpedia")) return false;
  return CARD_AS_PARALLEL.test(row.parallelSlug);
}

/**
 * (b) Which ladder a parallel belongs to. The refractor family lives at the
 * CHROME number; Sapphire is its own product (D23) and is only ever REPORTED.
 */
const REFRACTOR_FAMILY = /(^|-)(refractor|refractors|xfractor|superfractor)(-|$)|(^|-)(wave|sparkle|sparkles|shimmer|mojo|atomic|pulsar)(-|$)/;
const SAPPHIRE_FAMILY = /(^|-)(sapphire|padparadscha)(-|$)/;
/** Paper number -> chrome number. BD-152 -> BDC-152, BP-41 -> BCP-41. */
const PAPER_TO_CHROME = [[/^BD-/i, "BDC-"], [/^BP-/i, "BCP-"]];
function chromeNumberOf(cardNumber) {
  const n = String(cardNumber ?? "");
  for (const [re, to] of PAPER_TO_CHROME) if (re.test(n)) return n.replace(re, to);
  return null;
}
function chromeLadderClass(row) {
  const slug = String(row?.parallelSlug ?? "");
  if (SAPPHIRE_FAMILY.test(slug)) return "sapphire";
  if (REFRACTOR_FAMILY.test(slug)) return "refractor";
  return null;
}

/**
 * The player gate. Folds the four spelling differences the data actually holds,
 * then accepts token containment -- one side carrying a suffix the other omits
 * ("Bobby Witt" / "Bobby Witt Jr.") is one player, not two. A blank on either
 * side is UNKNOWN, and unknown is not equality: the caller decides whether an
 * unknown name may travel.
 */
const NAME_NOISE = /\b(1st|rc|rookie|exch|sp|ssp)\b/g;
/** Unicode combining marks, so "Sanchez" and its accented spelling fold equal. */
const COMBINING_MARKS = /[̀-ͯ]/g;
function foldPlayer(s) {
  return String(s ?? "")
    .normalize("NFKD").replace(COMBINING_MARKS, "").toLowerCase()
    .replace(/,\s*(jr|sr|iii|iv|ii|v)\b/g, " $1")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(NAME_NOISE, " ")
    .replace(/\s+/g, " ").trim();
}
function samePlayer(a, b) {
  const A = foldPlayer(a).split(" ").filter(Boolean);
  const B = foldPlayer(b).split(" ").filter(Boolean);
  if (!A.length || !B.length) return false;
  const [S, L] = A.length <= B.length ? [A, B] : [B, A];
  return S.every((t, i) => L[i] === t) || S.every((t) => L.includes(t));
}

/** (c) "1st Edition Blue" under bowman-draft -> bowman-draft-1st-edition +
 *  "Blue". Baseball Bowman ONLY: Pokemon's "1st Edition Prerelease" is a PRINT,
 *  not a product, and ~90 such rows sit under base1 / base2 / fossil setKeys. */
const FIRST_EDITION_PRODUCTS = { bowman: "bowman-1st-edition", "bowman-draft": "bowman-draft-1st-edition" };
function firstEditionTarget(row) {
  if (String(row?.sport ?? "").toLowerCase() !== "baseball") return null;
  const setKey = String(row?.setKey ?? "").toLowerCase();
  const product = FIRST_EDITION_PRODUCTS[setKey];
  if (!product) return null;
  const slug = String(row?.parallelSlug ?? "");
  if (!slug.startsWith("1st-edition-")) return null;
  const parallelSlug = slug.slice("1st-edition-".length);
  if (!parallelSlug) return null;
  const parallel = String(row.parallel ?? "").replace(/^\s*1st\s+edition\s+/i, "").trim() || parallelSlug;
  return { product, parallelSlug, parallel };
}

/** (f) "black-1" -> "black", "superfractor-1(-refractor)" -> "superfractor";
 *  the "1" was the 1/1 glued into the name, so the twin carries :num-1. */
const GLUED = { "black-1": "black", "superfractor-1": "superfractor", "superfractor-1-refractor": "superfractor" };
function gluedTarget(row) {
  const parallelSlug = GLUED[String(row?.parallelSlug ?? "")];
  if (!parallelSlug) return null;
  return { parallelSlug, printRun: 1 };
}

/**
 * A row whose id's setKey SEGMENT disagrees with its setKey FIELD. catalogRowOps
 * refuses to move one ("a key needs both halves"), and rightly: which half is
 * the card is a question this pass cannot answer. Measured in the MODE=chrome-
 * ladder dry run 2026-08-30 -- 262 of 864 candidates, ids reading
 * `hiq:baseball:2022:bowman-paper:bp-53:...` whose field says `bowman`. That
 * disagreement is D23's rename fleet's population, not this one's, so these
 * rows are REPORTED and left for it rather than moved on a guess.
 */
function setKeyDisagrees(row, parts) {
  const fromId = String(parts?.[3] ?? "").toLowerCase();
  const fromField = slugSeg(row?.setKey);
  return Boolean(fromId) && Boolean(fromField) && fromId !== fromField;
}

/** hiq:sport:year:setKey:number:parallel:auto[:num-N] -> parts, else null. */
function identityParts(id) {
  const p = String(id ?? "").split(":");
  if (p[0] !== "hiq" || p.length < 7 || p.length > 8) return null;
  if (p.length === 8 && !p[7].startsWith("num-")) return null;
  return p;
}
/** Rebuild an id with some segments replaced. printRun null drops the segment. */
function rebuildId(parts, { setKey, cardNumber, parallelSlug, printRun } = {}) {
  const p = [...parts];
  if (setKey !== undefined) p[3] = setKey;
  if (cardNumber !== undefined) p[4] = cardNumber;
  if (parallelSlug !== undefined) p[5] = parallelSlug;
  if (printRun !== undefined) {
    if (printRun === null) { if (p.length === 8) p.length = 7; }
    else { p[7] = "num-" + printRun; p.length = 8; }
  }
  return p.join(":");
}

const slugSeg = (s) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * reportWrites' counters must partition the population with DISJOINT paths --
 * CF-A-SLICE-IS-NOT-A-SIBLING-COUNTER. Two populations, not one:
 *
 *   candidates  the rows this slot actually EXAMINED. written + skipped +
 *               failed accounts for exactly these, one path each.
 *   notReached  the rows this slot OWNED but never looked at, because the
 *               budget or LIMIT stopped the walk first. A sibling of
 *               candidates, NOT a slice of it -- adding it to the candidate
 *               sum would double-count, which is why `balances` excludes it.
 *
 * reportWrites is handed intended = candidates + notReached and skipped =
 * skipped + notReached, so its own arithmetic closes over the whole slot.
 */
function reconcile(job, s) {
  const candidates = s.candidates ?? 0, written = s.written ?? 0;
  const skipped = s.skipped ?? 0, failed = s.failed ?? 0, notReached = s.notReached ?? 0;
  return {
    job, candidates, written, skipped, failed, notReached,
    intended: candidates + notReached,
    // Every row this slot LOOKED AT went down exactly one path...
    balances: written + skipped + failed === candidates,
    // ...and every row it OWNED was either looked at or explicitly not reached.
    accountsForAll: written + skipped + failed + notReached === candidates + notReached,
  };
}

// -- the run -----------------------------------------------------------------

/** The SQL filters every mode shares: sport / year / source / setKey scoping. */
function scopeSql(prefix = " AND ") {
  const parts = [], params = [];
  if (SPORTS.length) { parts.push(`LOWER(c.sport) IN (${SPORTS.map((_, i) => `@sp${i}`).join(",")})`); SPORTS.forEach((v, i) => params.push({ name: `@sp${i}`, value: v })); }
  if (YEARS.length) { parts.push(`c.year IN (${YEARS.map((_, i) => `@yr${i}`).join(",")})`); YEARS.forEach((v, i) => params.push({ name: `@yr${i}`, value: v })); }
  if (SOURCES.length) { parts.push(`c.source IN (${SOURCES.map((_, i) => `@src${i}`).join(",")})`); SOURCES.forEach((v, i) => params.push({ name: `@src${i}`, value: v })); }
  if (SCOPE.length) { parts.push(`LOWER(c.setKey) IN (${SCOPE.map((_, i) => `@sk${i}`).join(",")})`); SCOPE.forEach((v, i) => params.push({ name: `@sk${i}`, value: v })); }
  return { sql: parts.length ? prefix + parts.join(" AND ") : "", params };
}

const PROJECTION = "c.id, c.cardId, c.source, c.sport, c.year, c.cardYear, c.setKey, c.setName, c.cardNumber, c.playerName, c.playerSlug, c.parallel, c.parallelSlug, c.printRun, c.subsetName, c.gradeTier, c.searchTokens, c.isAuto";

/** Every mode's query: the population it owns, before sharding. */
function querySpec(mode) {
  const sc = scopeSql();
  if (mode === "card-as-parallel") {
    return {
      query: `SELECT ${PROJECTION} FROM c WHERE STARTSWITH(c.source, "baseballcardpedia") AND IS_STRING(c.parallelSlug)
              AND (STARTSWITH(c.parallelSlug,"bd-") OR STARTSWITH(c.parallelSlug,"bdc-") OR STARTSWITH(c.parallelSlug,"bcp-")
                   OR STARTSWITH(c.parallelSlug,"bp-") OR STARTSWITH(c.parallelSlug,"bdpp-") OR STARTSWITH(c.parallelSlug,"cpa-"))${sc.sql}`,
      parameters: sc.params,
    };
  }
  if (mode === "chrome-ladder") {
    return {
      query: `SELECT ${PROJECTION} FROM c WHERE c.setKey IN ("bowman","bowman-draft") AND IS_STRING(c.cardNumber)
              AND (STARTSWITH(c.cardNumber,"BD-") OR STARTSWITH(c.cardNumber,"BP-"))
              AND NOT IS_DEFINED(c.gradeTier)
              AND (CONTAINS(c.parallelSlug,"refractor") OR CONTAINS(c.parallelSlug,"sapphire") OR CONTAINS(c.parallelSlug,"padparadscha")
                   OR CONTAINS(c.parallelSlug,"wave") OR CONTAINS(c.parallelSlug,"sparkle"))${sc.sql}`,
      parameters: sc.params,
    };
  }
  if (mode === "first-edition") {
    return {
      query: `SELECT ${PROJECTION} FROM c WHERE c.setKey IN ("bowman","bowman-draft") AND LOWER(c.sport) = "baseball"
              AND IS_STRING(c.parallelSlug) AND STARTSWITH(c.parallelSlug, "1st-edition-")${sc.sql}`,
      parameters: sc.params,
    };
  }
  if (mode === "names") {
    return {
      query: `SELECT ${PROJECTION} FROM c WHERE IS_STRING(c.playerName)
              AND (CONTAINS(c.playerName,", Jr") OR CONTAINS(c.playerName,", Sr") OR CONTAINS(c.playerName,", II")
                   OR CONTAINS(c.playerName,", III") OR CONTAINS(c.playerName,", IV"))${sc.sql}`,
      parameters: sc.params,
    };
  }
  if (mode === "number-glued") {
    return {
      query: `SELECT ${PROJECTION} FROM c WHERE c.parallelSlug IN ("black-1","superfractor-1","superfractor-1-refractor")
              AND NOT IS_DEFINED(c.gradeTier)${sc.sql}`,
      parameters: sc.params,
    };
  }
  throw new Error(`unknown MODE "${mode}"`);
}

async function main() {
  if (!MODE) {
    console.error(`FATAL: MODE is required and has no default. One of: ${MODES.join(" | ")}`);
    console.error(`  A whole-scope write that guesses its own scope is the shape that reported 13.14M rows for a source nobody named.`);
    process.exit(1);
  }
  if (!MODES.includes(MODE)) { console.error(`FATAL: unknown MODE "${MODE}". One of: ${MODES.join(" | ")}`); process.exit(1); }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { moveCatalogRow, retireCatalogRow, rebuildSearchFields } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
  const { cleanPlayerName } = require(path.join(backend, "dist/services/portfolioiq/cardCatalog.service.js"));
  const { slugify } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  const { decideTwinFold } = require(path.join(backend, "dist/services/catalog/foldTwinRule.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } } }).database("hobbyiq");
  const cat = db.container("card_catalog");
  const sold = db.container("sold_comps");
  const portfolio = db.container("portfolio");

  const scopeWords = [
    SPORTS.length ? `sports=${SPORTS.join(",")}` : null,
    YEARS.length ? `years=${YEARS.join(",")}` : null,
    SOURCES.length ? `sources=${SOURCES.join(",")}` : null,
    SCOPE.length ? `setKeys=${SCOPE.join(",")}` : null,
  ].filter(Boolean).join("  ") || "every year, sport and source in the mode's own population";

  console.log(`repair-bcp-misfiled-parallels  MODE=${MODE}  ${APPLY ? "APPLY" : "REPORT ONLY"}`);
  console.log(`  scope: ${scopeWords}`);
  console.log(`  slot ${SLOT}/${SLOTS} (sha1(id))  concurrency ${CONCURRENCY}  budget ${RUN_MINUTES}m  limit ${LIMIT || "none"}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log("");

  const dryRun = !APPLY;
  const stats = { candidates: 0, otherShard: 0, written: 0, skipped: 0, failed: 0, notReached: 0 };
  const reasons = new Map();
  const byProduct = new Map();
  const examples = [];
  const note = (k) => reasons.set(k, (reasons.get(k) ?? 0) + 1);
  const product = (r) => byProduct.set(`${r.year ?? "?"} ${r.setKey ?? "?"}`, (byProduct.get(`${r.year ?? "?"} ${r.setKey ?? "?"}`) ?? 0) + 1);
  const example = (s) => { if (examples.length < 20) examples.push("  " + s); };

  /** A point read of one catalog id, or null. */
  const readRow = async (id) => {
    try { const { resource } = await retry(() => cat.item(id, id).read()); return resource ?? null; }
    catch (e) { if (e?.code === 404) return null; throw e; }
  };
  /** Does the catalog know this (year, setKey, cardNumber) at all, and who does it say it is? */
  const numberExists = async (year, setKey, cardNumber) => {
    const { resources } = await retry(() => cat.items.query({
      query: `SELECT DISTINCT VALUE c.playerName FROM c WHERE c.year=@y AND c.setKey=@k AND c.cardNumber=@n AND IS_STRING(c.playerName)`,
      parameters: [{ name: "@y", value: year }, { name: "@k", value: setKey }, { name: "@n", value: cardNumber }],
    }, { maxItemCount: 20 }).fetchAll());
    if (resources.length) return { exists: true, names: resources };
    const { resources: any } = await retry(() => cat.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE c.year=@y AND c.setKey=@k AND c.cardNumber=@n`,
      parameters: [{ name: "@y", value: year }, { name: "@k", value: setKey }, { name: "@n", value: cardNumber }],
    }).fetchAll());
    return { exists: (any[0] ?? 0) > 0, names: [] };
  };

  // (a) card-as-parallel: the retire refuses on ANY live reference.
  const referencesTo = async (id) => {
    const { resources: s } = await retry(() => sold.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @i`, parameters: [{ name: "@i", value: id }],
    }).fetchAll());
    return s[0] ?? 0;
  };

  const spec = querySpec(MODE);
  let stopReason = null;
  let token;

  do {
    const page = await retry(() => cat.items.query(spec, { maxItemCount: 300, continuationToken: token }).fetchNext());
    token = page.continuationToken || undefined;
    const rows = page.resources ?? [];
    const mine = SLOTS > 1 ? rows.filter((r) => shardOf(r.id) === SLOT) : rows;
    stats.otherShard += rows.length - mine.length;

    for (let i = 0; i < mine.length; i += CONCURRENCY) {
      if (LIMIT && stats.written >= LIMIT) { stopReason = "limit"; stats.notReached += mine.length - i; break; }
      if (budgetLeft() < 120000) { stopReason = "budget"; stats.notReached += mine.length - i; break; }
      await Promise.all(mine.slice(i, i + CONCURRENCY).map(async (row) => {
        stats.candidates++;
        try {
          // ---- (a) retire a card-as-parallel row ---------------------------
          if (MODE === "card-as-parallel") {
            if (!isCardAsParallel(row)) { stats.skipped++; note("query over-matched (not the card-as-parallel shape)"); return; }
            const refs = await referencesTo(row.id);
            if (refs > 0) {
              // Drew's brief expected none, and the measurement found none. A
              // reference appearing now means the world changed under the
              // measurement -- refuse, never delete a row a sale points at.
              stats.skipped++; note("REFUSED -- a sale points at this row");
              example(`REFUSED ${row.id} (${refs} sale(s))`);
              return;
            }
            const res = await retireCatalogRow(cat, row.id, row.cardId, "the page's card list was parsed as the parallel column; this is another card, not a parallel (CF-A-CARD-NUMBER-IS-NOT-A-RUNG, D33)", { dryRun, retry });
            if (res.action === "noop") { stats.skipped++; note("already gone"); return; }
            stats.written++; product(row);
            example(`retire ${row.id}  parallel=${JSON.stringify(row.parallel)}  (+${res.gradedChildrenRetired} graded)`);
            return;
          }

          // ---- (b) chrome ladder on a paper number -------------------------
          if (MODE === "chrome-ladder") {
            const klass = chromeLadderClass(row);
            if (!klass) { stats.skipped++; note("query over-matched (not a refractor / sapphire rung)"); return; }
            if (klass === "sapphire") {
              stats.skipped++; note("REPORTED -- Sapphire is its own product (D23); naming it is a ruling, not this pass");
              example(`sapphire ${row.id}  parallel=${JSON.stringify(row.parallel)}`);
              return;
            }
            const chromeNumber = chromeNumberOf(row.cardNumber);
            if (!chromeNumber) { stats.skipped++; note("no paper->chrome mapping for this card number"); return; }
            const parts = identityParts(row.id);
            if (!parts) { stats.skipped++; note("id is not an identity slug"); return; }
            if (setKeyDisagrees(row, parts)) {
              stats.skipped++; note("REPORTED -- the id's setKey disagrees with the field (D23's population, not this one)");
              example(`setKey split ${row.id}  field=${JSON.stringify(row.setKey)}`);
              return;
            }
            const known = await numberExists(row.year, row.setKey, chromeNumber);
            if (!known.exists) {
              stats.skipped++; note("REPORTED -- the chrome number does not exist in the catalog (never mint)");
              example(`no ${chromeNumber} for ${row.year} ${row.setKey}  (from ${row.id})`);
              return;
            }
            if (known.names.length && !known.names.some((n) => samePlayer(n, row.playerName))) {
              stats.skipped++; note("REFUSED -- the chrome number names a different player");
              example(`player conflict ${row.cardNumber}=${JSON.stringify(row.playerName)} vs ${chromeNumber}=${JSON.stringify(known.names.slice(0, 3))}`);
              return;
            }
            const newSlug = rebuildId(parts, { cardNumber: slugSeg(chromeNumber) });
            const res = await moveCatalogRow(cat, row, newSlug, { cardNumber: chromeNumber }, {
              reason: "the refractor ladder belongs to the CHROME card number, not the paper one; a colour is never its refractor (D31, D33)",
              salesContainer: sold, dryRun, retry,
            });
            if (res.action === "noop") { stats.skipped++; note("already at the chrome number"); return; }
            stats.written++; product(row); note(`${res.action} to the chrome number`);
            example(`${res.action} ${row.cardNumber} -> ${chromeNumber}  ${row.parallel}  (${res.salesRepointed} sale(s))`);
            return;
          }

          // ---- (c) 1st Edition is its own product --------------------------
          if (MODE === "first-edition") {
            const target = firstEditionTarget(row);
            if (!target) { stats.skipped++; note("query over-matched (not a Bowman 1st Edition parallel)"); return; }
            const parts = identityParts(row.id);
            if (!parts) { stats.skipped++; note("id is not an identity slug"); return; }
            if (setKeyDisagrees(row, parts)) {
              stats.skipped++; note("REPORTED -- the id's setKey disagrees with the field (D23's population, not this one)");
              return;
            }
            const newSlug = rebuildId(parts, { setKey: target.product, parallelSlug: target.parallelSlug });
            const res = await moveCatalogRow(cat, row, newSlug, {
              setKey: target.product, parallel: target.parallel, parallelSlug: target.parallelSlug,
              setName: String(row.setName ?? "").match(/1st\s+edition/i) ? row.setName : undefined,
            }, {
              reason: "the id carries the product as the checklist names it; 1st Edition is its own product (D23, D33)",
              repointNormalizedSetKey: true, salesContainer: sold, dryRun, retry,
            });
            if (res.action === "noop") { stats.skipped++; note("already at the 1st Edition product"); return; }
            stats.written++; product(row); note(`${res.action} to ${target.product}`);
            example(`${res.action} ${row.setKey} -> ${target.product}  ${JSON.stringify(row.parallel)} -> ${JSON.stringify(target.parallel)}`);
            return;
          }

          // ---- (d) the comma before a generational suffix ------------------
          if (MODE === "names") {
            const before = typeof row.playerName === "string" ? row.playerName : null;
            if (before === null) { stats.skipped++; note("no playerName"); return; }
            const after = cleanPlayerName(before);
            if (!after || after === before) { stats.skipped++; note("already clean (the query over-matched, or a concurrent heal)"); return; }
            const year = typeof row.year === "number" ? row.year : (typeof row.cardYear === "number" ? row.cardYear : null);
            const fields = rebuildSearchFields({ ...row, year, playerName: after });
            const existing = Array.isArray(row.searchTokens) ? row.searchTokens.map((t) => String(t).toLowerCase()).filter(Boolean) : [];
            const ops = [
              { op: "set", path: "/playerName", value: after },
              { op: "set", path: "/playerSlug", value: slugify(after) },
              { op: "set", path: "/searchText", value: fields.searchText },
              { op: "set", path: "/displayName", value: fields.displayName },
              // UNIONED, never replaced: the nightly builder adds fold passes
              // the src builder lacks, and a graded row's tokens carry its grade.
              { op: "set", path: "/searchTokens", value: [...new Set([...existing, ...fields.searchTokens])] },
              { op: "set", path: "/playerNameRepairedFrom", value: before },
            ];
            if (!dryRun) await retry(() => cat.item(row.id, row.cardId ?? row.id).patch(ops));
            stats.written++; product(row);
            example(`${JSON.stringify(before)} -> ${JSON.stringify(after)}  [${row.source}]`);
            return;
          }

          // ---- (f) the 1/1 glued into the parallel name --------------------
          if (MODE === "number-glued") {
            const target = gluedTarget(row);
            if (!target) { stats.skipped++; note("query over-matched (not a glued-number slug)"); return; }
            const parts = identityParts(row.id);
            if (!parts) { stats.skipped++; note("id is not an identity slug"); return; }
            if (setKeyDisagrees(row, parts)) {
              stats.skipped++; note("REPORTED -- the id's setKey disagrees with the field (D23's population, not this one)");
              return;
            }
            const newSlug = rebuildId(parts, { parallelSlug: target.parallelSlug, printRun: target.printRun });
            const twin = await readRow(newSlug);
            if (!twin) {
              // The numbered twin is the whole justification for the fold: it
              // is the row that already says /1. Without it this would be a
              // rename inventing a print run. Report it.
              stats.skipped++; note("REPORTED -- no numbered twin to fold onto (never mint)");
              example(`no twin at ${newSlug}  (from ${row.id})`);
              return;
            }
            const decision = decideTwinFold({
              baseId: row.id, twinSource: String(row.source ?? ""), twinIsChecklist: true,
              numbered: [{ id: newSlug, printRun: Number(twin.printRun ?? 1), source: String(twin.source ?? "") }],
              mode: "cross-source",
            });
            if (!decision.fold) { stats.skipped++; note(`REFUSED by foldTwinRule -- ${decision.skip}`); return; }
            const res = await moveCatalogRow(cat, row, newSlug, {
              parallel: twin.parallel ?? target.parallelSlug, parallelSlug: target.parallelSlug, printRun: target.printRun,
            }, {
              reason: `the print run was glued into the parallel name ("Black 1" is Black /1); ${decision.reason}`,
              salesContainer: sold, known: twin, dryRun, retry,
            });
            if (res.action === "noop") { stats.skipped++; note("already at the numbered slug"); return; }
            stats.written++; product(row); note(`${res.action} onto the numbered twin`);
            example(`${res.action} ${row.parallelSlug} -> ${target.parallelSlug}:num-1  (${res.salesRepointed} sale(s))`);
            return;
          }
        } catch (e) {
          stats.failed++;
          if (stats.failed <= 6) console.log(`  failed ${String(row.id).slice(0, 80)}: ${String(e?.message ?? e).slice(0, 140)}`);
        }
      }));
    }
    if (stopReason) break;
  } while (token);

  // -- the report ------------------------------------------------------------
  const verb = APPLY ? "APPLIED" : "REPORT ONLY -- nothing written";
  console.log(`\n${verb}   MODE=${MODE}`);
  console.log(`  candidates (this slot)   ${f(stats.candidates)}   (${f(stats.otherShard)} belong to other slots)`);
  console.log(`  ${APPLY ? "CHANGED" : "WOULD CHANGE"}                 ${f(stats.written)}`);
  console.log(`  left alone               ${f(stats.skipped)}`);
  console.log(`  failed                   ${f(stats.failed)}`);
  console.log(`  not reached              ${f(stats.notReached)}`);
  if (reasons.size) {
    console.log(`  why a row was left alone:`);
    for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`    ${String(k).padEnd(66)} ${f(n)}`);
  }
  if (byProduct.size) {
    console.log(`  by year + product:`);
    for (const [k, n] of [...byProduct].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`    ${k.padEnd(40)} ${f(n)}`);
  }
  if (examples.length) { console.log(`  examples:`); for (const e of examples) console.log(e); }

  const rec = reconcile(`repair-bcp-misfiled-parallels:${MODE}`, stats);
  if (!rec.balances) console.log(`
  NOTE: the rows examined do not partition (${f(rec.written)} + ${f(rec.skipped)} + ${f(rec.failed)} != ${f(rec.candidates)})`);
  if (APPLY) reportWrites({ job: rec.job, intended: rec.intended, written: rec.written, skipped: rec.skipped + rec.notReached, failed: rec.failed });

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);
}

module.exports = {
  MODES, CARD_AS_PARALLEL, isCardAsParallel,
  REFRACTOR_FAMILY, SAPPHIRE_FAMILY, chromeNumberOf, chromeLadderClass,
  foldPlayer, samePlayer,
  FIRST_EDITION_PRODUCTS, firstEditionTarget,
  GLUED, gluedTarget,
  identityParts, rebuildId, slugSeg, setKeyDisagrees, reconcile, querySpec,
};

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
