#!/usr/bin/env node
/**
 * CF-INGEST-THE-CLEAN-CHECKLIST (Drew, 2026-08-26).
 *
 * Turns staged canonical checklist CSVs into catalog rows. This is the step
 * that makes an acquired checklist matchable, and it is deliberately the LAST
 * step -- every scraper stages to disk, because a scraper that wrote straight
 * into the catalog would be another self-confirming source.
 *
 * WHY IT MATTERS, measured: 2026 Bowman Chrome Mega Box holds 944 catalog rows
 * from `ingest-auto-seed` -- built FROM the sales -- against 614 from a
 * checklist. A sale seeds a row and that row then confirms the sale, so the
 * match proves nothing about whether the card is real, spelled right or
 * numbered right. A checklist is the only artifact that can CONTRADICT a sale.
 *
 * THE SOURCE NAME IS LOAD-BEARING. upsertCatalogEntry now ranks by authority
 * before confidence, and catalogAuthority decides authority from `source`. A
 * name it does not recognise falls to `unknown` (rank 0) and loses to the very
 * derived rows this ingest exists to correct -- `keymancollectibles` is
 * currently in exactly that state. So the source is asserted to be a checklist
 * BEFORE anything is written, and the run refuses rather than quietly writing
 * rows that cannot win.
 *
 * READS THE MANIFEST, NOT THE FILENAME. Each product carries sport, year,
 * setKey and setName next to its CSV. Parsing those back out of a filename is
 * how "2025-26" seasons and multi-word set names get mangled.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   DIR                       directory of *.csv (+ *.manifest.json)
 *   SOURCE                    provenance stamped on every row; must be a
 *                             checklist-class name
 *   APPLY / BACKFILL_APPLY    actually write (default: report only)
 *   SLOT / SLOTS              shard across workers by file
 *   CONCURRENCY=48
 *   RUN_MINUTES=140
 *   LIMIT=0
 */
const fs = require("node:fs");
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
const { upsertCatalogEntry, cleanPlayerName } = require(path.join(backend, "dist/services/portfolioiq/cardCatalog.service.js"));
const { computeHobbyIqCardId, slugify, normalizeSetKey } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
// CF-VACATE-THE-PLAIN-ID-OR-REFUSE: the incumbent is MOVED, never re-upserted
// at a second address, so the ambiguous plain id genuinely stops existing and
// the sales hanging off it follow the card.
const { moveCatalogRow } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
const { CosmosClient } = require("@azure/cosmos");

/**
 * CF-EVERY-CHECKLIST-ROW-IS-A-MISS.
 *
 * upsertCatalogEntry with no `known` hint calls getCatalogEntry, which point-
 * reads and then, ON A MISS, falls back to a CROSS-PARTITION
 * `SELECT TOP 1 * WHERE c.id = @id` across 31.2M documents.
 *
 * That fallback exists to find rows still sitting under a foreign partition
 * key. A checklist ingest is the pathological caller for it: every row it
 * writes is a NEW slug, so every row misses, so every row pays the scan.
 * Measured: 9,297 rows in 43 minutes. 216/min puts one Beckett pass at 38
 * hours, which is why two full runs landed 8 files out of 409.
 *
 * So do the point read here (1 RU) and hand the answer over. A miss stays a
 * miss instead of escalating. The authority merge is unaffected -- a row at
 * its own address is still found, and 98.9% of the catalog is at its own
 * address now.
 */
const db = (() => {
  let d = null;
  return () => (d ??= new CosmosClient({
    connectionString: process.env.COSMOS_CONNECTION_STRING,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq"));
})();
const catalogContainer = () => db().container("card_catalog");
// The pool, so a vacated plain id's sales are RE-POINTED rather than orphaned.
const poolContainer = () => db().container("sold_comps");

const lookup = async (slug) => {
  try { return (await catalogContainer().item(slug, slug).read()).resource ?? null; }
  catch (e) { if (e.code === 404) return null; throw e; }
};

const DIR = process.env.DIR || "";
const SOURCE = process.env.SOURCE || "";
const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 48));
const LIMIT = Number(process.env.LIMIT || 0);
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
// CF-BASE-SET-IS-NOT-A-SUBSET: a page-section heading ("Base Set", "Checklist")
// is not a claim that the row belongs to a named subset.
const { claimedSubsetOf } = require(path.join(__dirname, "lib", "subset-identity.cjs"));
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809): the one exit path.
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const SHARD_SCOPE = runnerShardScope({ label: "ingest-checklist-csv-to-catalog" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

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

/** Split a canonical CSV line, honouring quoted fields. */
function splitCsv(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** sport/year/setKey/setName for a product, from its manifest. */
function productOf(csvPath) {
  const manifest = csvPath.replace(/\.csv$/, ".manifest.json");
  if (fs.existsSync(manifest)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (m.year && m.sport && (m.setKey || m.setName)) {
        return {
          sport: m.sport, year: Number(m.year),
          setKey: m.setKey || normalizeSetKey(m.setName),
          setName: m.setName || m.setKey,
          sourceUrl: m.sourceUrl ?? null,
          // CF-A-PARALLEL-SET-BELONGS-TO-ITS-PARENT. A page that is one rung or
          // one insert of a parent product states the subset it came from. It is
          // DISPLAY ONLY -- the identity slug has no subset axis -- but it makes
          // a cross-subset cardNumber collision visible instead of silent.
          subsetName: m.subset || null,
        };
      }
    } catch { /* fall through */ }
  }
  // Fallback: <year>-<set>-<sport>. Season products ("2025-26-...") take the
  // FIRST year, matching how the catalog keys them.
  const base = path.basename(csvPath, ".csv");
  const m = base.match(/^((?:19|20)\d{2})(?:-\d{2})?-(.+)-(baseball|basketball|football|hockey|soccer|pokemon|wrestling)$/);
  if (!m) return null;
  return {
    sport: m[3], year: Number(m[1]), setKey: slugify(m[2]),
    setName: `${m[1]} ${m[2].replace(/-/g, " ")}`, sourceUrl: null,
  };
}

/**
 * CF-A-CARD-IS-NOT-A-PARALLEL, the ingest side (D33, Drew 2026-08-30).
 *
 * The old gate was /^\d+[a-z]?\s+[A-Za-z]/ -- BARE numbers only. It blocked
 * "100 Mike Trout" and admitted every prefixed form, which is exactly the
 * shape sitting in prod: "BD 154 Adley Rutschman", "BD-121 Spencer
 * Torkelson", 29,189 rows of another card's number+name in the parallel
 * column. The scraper that minted them is deleted, but nothing stopped a
 * future one from re-admitting the shape, so the gate is widened here too:
 * defence in depth, at the last step before a row is written.
 *
 * BLAST RADIUS. Real parallel/insert names that START WITH DIGITS must
 * survive -- "20 in '20" (a 2020 Bowman Draft insert) and "1990 Bowman" (a
 * 2020 Bowman retro insert) are both on the pages this ingest reads. A
 * 4-digit year lead is therefore never a card line, and "20 in '20" is
 * followed by "in", which no card line is: a card line's number is followed
 * by a NAME, so a stop-word after the number rules it out.
 */
const CARD_LINE_PARALLEL = /^[A-Za-z]{0,5}[-\s]?\d{1,4}[a-z]?\s+\p{L}/u;
const NOT_A_NAME_AFTER_NUMBER = /^(?:in|of|to|and|the|for|per|on|at|by)\b/i;
/** Finish vocabulary that legitimately follows a bare number in a parallel. */
const FINISH_AFTER_NUMBER = /^(?:colou?r|tone|tool|of|piece|pc|patch|star|swatch|box|case|player|team|logo|letter|strand)\b/i;
function isCardLineParallel(parallel) {
  const v = String(parallel || "").trim();
  if (!CARD_LINE_PARALLEL.test(v)) return false;
  if (/^(?:19|20)\d{2}\s/.test(v)) return false;              // "1990 Bowman"
  const after = v.replace(/^[A-Za-z]{0,5}[-\s]?\d{1,4}[a-z]?\s+/u, "");
  if (NOT_A_NAME_AFTER_NUMBER.test(after)) return false;      // "20 in '20"
  // A BARE number (no letter prefix) can still name a PARALLEL when what
  // follows is finish vocabulary rather than a person: "3 Color Patch",
  // "5 Tool", "1 of 1". Capitalisation cannot separate those from "100 Mike
  // Trout" (both are two capitalised words), so the finish words decide. A
  // PREFIXED line ("BD 154 ...") is a card line regardless: no parallel
  // carries a set prefix.
  if (!/^[A-Za-z]{1,5}[-\s]/.test(v) && FINISH_AFTER_NUMBER.test(after)) return false;
  return true;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  if (!DIR || !fs.existsSync(DIR)) { console.error(`FATAL: DIR not found: ${DIR}`); process.exit(1); }
  if (!SOURCE) { console.error("FATAL: SOURCE required — it decides authority"); process.exit(1); }

  // The whole point of ingesting a checklist is that it can outrank a
  // sales-derived row. A source name catalogAuthority does not recognise ranks
  // BELOW derived, so the rows would be written and then lose to exactly what
  // they were meant to correct. Refuse instead.
  const authority = catalogAuthorityOf(SOURCE);
  if (authority !== "checklist") {
    console.error(`FATAL: SOURCE "${SOURCE}" classifies as ${authority}, not checklist.`);
    console.error(`       It would rank below the derived rows this ingest exists to correct.`);
    console.error(`       Declare it in catalogAuthority.service.ts first.`);
    process.exit(2);
  }

  const allFiles = fs.readdirSync(DIR).filter((n) => n.endsWith(".csv")).sort();
  let files = allFiles;
  if (SLOTS > 1) files = files.filter((_, i) => i % SLOTS === SLOT);

  // A SHARD IS NOT A RUN. The workflow's `slots` input defaults to 16 and the
  // wrapper hands the child its whole environment, so an un-sharded dispatch
  // silently took 1/16 of the files -- 26 of 409 -- and then printed a clean
  // reconciliation, a full phases-done line and a green check. The totals were
  // all internally consistent; they were just consistent about a sixteenth of
  // the job. Say the denominator out loud so that can never read as complete.
  //
  // The denominator is stated on EVERY path, not only the sharded one. An
  // unsharded run that says nothing about coverage is exactly how `slot 0/16`
  // came to read as configuration rather than as "this covers a sixteenth" --
  // silence is what made the loss invisible.
  if (SHARDED) {
    console.log(`SHARD ${SLOT}/${SLOTS} — this run owns ${f(files.length)} of ${f(allFiles.length)} files.`);
    console.log(`  The other ${f(allFiles.length - files.length)} belong to sibling slots and are NOT ingested here.`);
    console.log(`  Dispatch every slot 0..${SLOTS - 1}, or pass slots=1 for the whole set.`);
  } else {
    console.log(`ALL ${f(allFiles.length)} staged files — this run ingests every one of them.`);
  }
  console.log(`  ${SHARD_SCOPE.banner()}\n`);

  // A file that finished completely leaves a marker beside its CSV, and the
  // marker rides the same cache the CSVs do. Without this, a budget stop sends
  // the next run back to file 1 to re-do the same head of the list forever,
  // never reaching the tail.
  const REINGEST = String(process.env.REINGEST || "") === "true";
  let alreadyDone = 0;
  let cardLineParallel = 0, explodedFiles = 0, explodedCategories = 0, explodedRows = 0, playerNameParallel = 0;
  const foldName = (v) => String(v ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const PARALLEL_WORDS = new Set(["refractor","refractors","xfractor","x-fractor","fractor","prizm","prizms","mojo","wave","shimmer","foil","foilboard","holo","chrome","sapphire","superfractor","printing","plate","plates","black","gold","silver","blue","red","green","orange","purple","pink","yellow","aqua","teal","magenta","fuchsia","bronze","platinum","rainbow","atomic","lava","pattern","laser","crackle","mini","base","parallel","variation","variations","sp","ssp","auto","autograph","autographs","relic","patch","jersey","insert","inserts","checklist","1/1","numbered","border","camo","tie-dye","disco","cracked","ice","optic","velocity","hyper","speckle","sparkle","glitter","neon","negative","sepia","vintage","stock","paper","canvas","gilded","glossy","matte"]);
  const isPersonName = (v) => { const t = foldName(v).split(" ").filter(Boolean); return t.length >= 2 && t.length <= 5 && !t.some((w) => PARALLEL_WORDS.has(w)) && !/^\d/.test(t[0]); };
  const EXPLODED_PAR_MAX = Number(process.env.EXPLODED_PAR_MAX || 150), EXPLODED_NUM_MAX = Number(process.env.EXPLODED_NUM_MAX || 2000);
  if (!REINGEST) {
    const before = files.length;
    files = files.filter((n) => !fs.existsSync(path.join(DIR, n + ".ingested")));
    alreadyDone = before - files.length;
  }
  console.log(`${f(files.length)} files  source=${SOURCE} (${authority})  ${APPLY ? "APPLY" : "REPORT ONLY"}\n`);

  let rows = 0, written = 0, skippedRow = 0, noProduct = 0, failed = 0, files_ok = 0;
  // Signed rows, counted alongside written. The BCP autograph work (#1700 /
  // #1703) exists to make a signed card its own row, and "N rows written" is
  // silent about whether any of them were autographs -- a lane that dropped
  // every §Autographs section reports exactly the same number as one that read
  // them. The canary for that work is "isAuto=true > 1 for 2011 topps-chrome",
  // so the run has to state the figure the canary is about.
  let signed = 0;
  // Counted directly, never by subtraction: a remainder derived as
  // intended-minus-everything-else makes the reconciliation balance by
  // construction and so can never disagree with itself.
  let notReached = 0;
  // Numbered rows whose parallel the source left blank. NOT base cards.
  let unnamedParallel = 0;
  // A clash the subset RESOLVES: both cards get their own subset-bearing id.
  let subsetDisambiguated = 0, subsetIncumbentMoved = 0, subsetVacateFailed = 0, subsetSalesRepointed = 0;
  const vacateFailures = [];
  // A clash where the subset is UNKNOWN on one side. Still refused, still
  // counted -- blank is unknown and this pass never invents one.
  let subsetCollision = 0;
  const collisionExamples = [];
  const disambiguatedExamples = [];
  // Written, but the merge kept the row another source already held there.
  let keptExisting = 0;
  let stopReason = null;

  for (const name of files) {
    if (stopReason) break;
    const csvPath = path.join(DIR, name);
    const product = productOf(csvPath);
    if (!product) { noProduct++; continue; }
    files_ok++;

    const lines = fs.readFileSync(csvPath, "utf8").split("\n");
    const batch = [];
    const rawRows = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const [category, cardNumber, parallel, isAuto, printRun, rawPlayer, parallelNote] = splitCsv(line);
      // CF-A-NAME-DOES-NOT-END-IN-A-COMMA: Beckett's cell is "Max Williams,".
      const player = cleanPlayerName(rawPlayer);
      rows++;
      if (!cardNumber || !player) { skippedRow++; continue; }
      // CF-A-CARD-LINE-IS-NOT-A-RUNG (2026-08-29; widened D33 2026-08-30).
      // parallel column is a scraper joining a card line to a rung; it can
      // never name a parallel. Skipped per row, counted, never written.
      if (isCardLineParallel(parallel)) { cardLineParallel++; continue; }
      rawRows.push({ category, cardNumber, parallel, isAuto, printRun, player, parallelNote });
      continue;
      batch.push({ category, cardNumber, parallel, isAuto, printRun, player, parallelNote: parallelNote || null });
    }

    // CF-A-PLAYER-IS-NOT-A-RUNG (2026-08-29). A parallel equal to a player name
    // of the same file is a roster line the scraper took for a rung ("Jimmy
    // Rollins" x 661 rows on 2008 Topps). The file knows its own players.
    {
      const players = new Set(rawRows.map((r) => r.player).filter(isPersonName).map(foldName));
      for (const r of rawRows) {
        if (r.parallel && players.has(foldName(r.parallel))) { playerNameParallel++; continue; }
        batch.push({ category: r.category, cardNumber: r.cardNumber, parallel: r.parallel, isAuto: r.isAuto, printRun: r.printRun, player: r.player, parallelNote: r.parallelNote || null });
      }
    }

    // CF-EXPLODED-FILE-GATE (2026-08-29). The spine held 140 products / 11.49M
    // rows from a scrape that cross-joined cards with players: 99,994 card
    // numbers for 2012 Topps, 162,763 for 2025 Topps. No real checklist
    // CATEGORY has more than ~150 rungs or ~2,000 card numbers.
    // CF-RIGHT-GUARD-RIGHT-SCOPE (2026-08-29, D3 dry run): the unit is the
    // category, not the file. A flagship's xlsx carries 20 insert sets, each
    // with its own ladder -- 514 distinct rung names across 2025 Topps Series 1
    // is the checklist, not a cross-join; a roster cross-join still puts 600
    // "rungs" inside ONE category and is refused there. A category over either
    // line is dropped -- logged, counted, no resume marker -- and the rest of
    // the file lands.
    {
      const byCat = new Map();
      for (const r of batch) { const c = String(r.category || "base"); if (!byCat.has(c)) byCat.set(c, { pars: new Set(), nums: new Set(), rows: 0 }); const g = byCat.get(c); g.pars.add(String(r.parallel || "")); g.nums.add(String(r.cardNumber)); g.rows++; }
      const refused = new Set();
      for (const [c, g] of byCat) {
        if (g.pars.size > EXPLODED_PAR_MAX || g.nums.size > EXPLODED_NUM_MAX) {
          console.log(`!! EXPLODED category refused: ${name} [${c}]  rows=${f(g.rows)} distinct parallels=${f(g.pars.size)} distinct cardNumbers=${f(g.nums.size)}`);
          refused.add(c); explodedCategories++; explodedRows += g.rows;
        }
      }
      if (refused.size) { const keep = batch.filter((r) => !refused.has(String(r.category || "base"))); batch.length = 0; batch.push(...keep); }
      if (!batch.length) { explodedFiles++; continue; }
    }

    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      await Promise.all(batch.slice(i, i + CONCURRENCY).map(async (r) => {
        try {
          // A blank parallel is "the plain card", which the slug generator
          // reads as Base. It is NOT the string "Base" in the CSV, and that
          // distinction is what lets a later pass tell "plain" from "nobody
          // told us".
          const slug = computeHobbyIqCardId({
            sport: product.sport, year: product.year, setKey: product.setKey,
            cardNumber: String(r.cardNumber),
            parallel: r.parallel || "Base",
            isAuto: r.isAuto === "true",
            printRun: r.printRun ? Number(r.printRun) : null,
            // CF-AUTHORITATIVE-SETKEY. A published checklist IS the ground
            // truth for which product a card belongs to, so the cardNumber-
            // prefix repair meant for untrusted VENDOR text must not fire on
            // it. Without this flag the slug took the override (`bowman` +
            // CPA- -> `bowman-chrome`) while the doc below kept writing
            // `setKey: product.setKey` -- and the row landed filed at one
            // product and labelled with another. Census 2026-09-05: 19,867
            // rows on bowman-chrome, 16,822 on bowman-paper, 208 on sapphire,
            // still minting ~4,700/week. It also collapses 2026 Bowman CPA-AG
            // (Adrian Gil) onto 2026 Bowman Chrome CPA-AG (Angeibel Gomez),
            // which is the merge the flag exists to prevent.
            authoritativeSetKey: true,
          });
          if (!slug || !slug.startsWith("hiq:")) { skippedRow++; return; }
          if (!APPLY) { written++; if (r.isAuto === "true") signed++; return; }

          // TRUST THE CHECKLIST (Drew, 2026-08-28: "we have to stop looking for
          // just base and trust the checklist").
          //
          // An earlier guard here refused any blank-parallel row that carried a
          // print run, reasoning "base cards are never serial numbered". That
          // is a false universal: National Treasures and Impeccable number
          // their base sets, and Bowman base autos carry runs. The checklist's
          // own structure is the authority -- a row in the base section IS the
          // base card, with exactly the print run the checklist states, and no
          // pass gets an opinion about what Base "should" look like.
          //
          // The guard survives only where the checklist itself said nothing: a
          // row whose CATEGORY is unknown AND whose parallel is blank AND that
          // carries a run has no structural claim to Base, so it is counted
          // rather than minted.
          const parallelBlank = !r.parallel || !String(r.parallel).trim();
          const numbered = r.printRun && Number(r.printRun) > 0;
          const categoryBlank = !r.category || !String(r.category).trim();
          if (parallelBlank && numbered && categoryBlank) { unnamedParallel++; return; }

          let known = await lookup(slug);
          let slugForWrite = slug;
          let subsetInId = false;

          // CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE (Drew ruling,
          // 2026-09-04). SUPERSEDES CF-A-SUBSET-IS-NOT-IN-THE-IDENTITY (#1741),
          // which refused the second write and counted it.
          //
          // Two subsets of one product that number their cards alike collide on
          // the plain slug: 2000-01 Topps Chrome publishes both "Cards That
          // Never Were" (MJ1-MJ10) and "Johnson Reprints" (MJ1-MJ7), every row
          // Magic Johnson, both Refractor. #1741 stopped the merge by refusing
          // the second row -- right about the harm, and it left those cards
          // uningestable.
          //
          // Drew's ruling: for THOSE cards, and only those, the subset becomes
          // part of the identity and each gets its own pool. So the clash is
          // RESOLVED rather than refused. Both sides are re-minted with a
          // `:sub-` segment -- the incoming row and the row already stored --
          // and the plain id is vacated, so nothing keeps landing on the
          // address that answers for two different cards.
          //
          // THE CLASH IS WHAT THE CATALOG SAYS. It is visible here because the
          // stored row at this exact rung names a DIFFERENT subset. No text is
          // read, nothing is inferred from a title, and a product whose numbers
          // are unique never reaches this branch at all.
          //
          // WHAT STILL REFUSES: a clash where one side's subset is UNKNOWN.
          // Blank means unknown and is never invented, and minting the unknown
          // side without a segment would put it straight back on the ambiguous
          // plain id. #1741's counter stays for exactly that case.
          // CF-BASE-SET-IS-NOT-A-SUBSET (2026-09-06, run 34027488624).
          //
          // THE CLASH IS BETWEEN SUBSETS THE SOURCES CLAIM, not between raw
          // subsetName strings. The 1957 Topps recheck read 417 checklist rows
          // and wrote 9: the other 407 were refused here because the stored
          // baseballcardpedia row carried subsetName "Base Set" while the
          // checklist page -- a base-set page -- stated none. Mantle #95, Mays
          // #10 and Aaron #20 were all refused against themselves.
          //
          // "Base Set" is a PAGE-SECTION HEADING, not a subset:
          // scrape-baseballcardpedia reads it off the wiki nav and maps it to
          // `category: "base"`, and the label rides along into subsetName where
          // it asserts the OPPOSITE of a subset -- "this row IS the base set".
          // Comparing it against a blank claim concluded "two different cards"
          // when both sides were saying the same thing.
          //
          // claimedSubsetOf() folds those structural labels to "no claim". Two
          // rows that both claim nothing do not clash, so the newcomer falls
          // through to upsertCatalogEntry and the AUTHORITY MERGE decides --
          // which is where a same-card newcomer has always belonged. A real
          // named subset ("Cards That Never Were", "Rookies") is untouched and
          // still clashes exactly as #1741 and the 2026-09-04 ruling require.
          const knownClaim = claimedSubsetOf(known && known.subsetName);
          const productClaim = claimedSubsetOf(product.subsetName);
          if (known && knownClaim && knownClaim !== (productClaim || null)) {
            if (!productClaim) {
              subsetCollision++;
              if (collisionExamples.length < 8) {
                collisionExamples.push(String(r.cardNumber).toUpperCase() + "|" + (r.parallel || "base")
                  + ': subset UNKNOWN vs stored "' + known.subsetName + '"');
              }
              return;
            }
            subsetInId = true;
            slugForWrite = computeHobbyIqCardId({
              sport: product.sport, year: product.year, setKey: product.setKey,
              cardNumber: String(r.cardNumber),
              parallel: r.parallel || "Base",
              isAuto: r.isAuto === "true",
              printRun: r.printRun ? Number(r.printRun) : null,
              subsetName: productClaim, subsetInId: true,
              // CF-AUTHORITATIVE-SETKEY, as above -- the subset re-slug must
              // land on the same product the plain slug did, or disambiguating
              // a subset would move the card to another product as a side
              // effect.
              authoritativeSetKey: true,
            });
            // MOVE THE INCUMBENT TOO. Leaving it on the plain id leaves one of
            // the two cards at an address the other one also answers to.
            const incumbentSlug = computeHobbyIqCardId({
              sport: product.sport, year: product.year, setKey: product.setKey,
              cardNumber: String(known.cardNumber ?? r.cardNumber),
              parallel: known.parallel || "Base",
              isAuto: known.isAuto === true,
              printRun: typeof known.printRun === "number" ? known.printRun : null,
              subsetName: knownClaim, subsetInId: true,
              // CF-AUTHORITATIVE-SETKEY. The incumbent is a catalog row this
              // same checklist lane minted; recomputing its address under a
              // different rule would move it to a third product.
              authoritativeSetKey: true,
            });
            if (incumbentSlug !== slugForWrite) {
              // CF-VACATE-THE-PLAIN-ID-OR-REFUSE (2026-09-06).
              //
              // The ruling above says "the plain id is vacated", and the code
              // did not vacate it: an `upsertCatalogEntry` at `incumbentSlug`
              // COPIES the incumbent to its new address and LEAVES the row on
              // the plain id. Two subsets that clashed on one address then
              // occupied three -- the newcomer's :sub- row, the incumbent's
              // :sub- row, and the original plain-id row still answering for
              // both cards, still collecting their sales. The disambiguation
              // reported success while the ambiguity it existed to remove was
              // still there.
              //
              // moveCatalogRow is the primitive that actually vacates: it
              // copies to the new slug, RE-POINTS that row's sales, retires
              // its graded children and deletes the old row -- in that order,
              // so no sale is ever dangling. A raw patch cannot do any of it
              // (feedback: use patchCatalogRowFields, never a raw patch; here
              // the address itself changes, so the move is the only correct
              // tool).
              //
              // AND IF IT CANNOT MOVE, IT REFUSES AND SAYS SO. An occupied
              // destination is adjudicated by moveCatalogRow's own authority
              // rule; any outcome that leaves the plain id still standing is
              // counted in `subsetVacateFailed` and named in the banner,
              // because a disambiguation that silently half-happened is how
              // this defect survived review the first time.
              const moved = await moveCatalogRow(
                catalogContainer(),
                known,
                incumbentSlug,
                // The CLAIMED subset, so a structural page-section label never
                // becomes the identity of the row it is moved onto.
                { subsetName: knownClaim, subsetInId: true },
                {
                  reason: `subset disambiguation: "${known.subsetName}" and "${product.subsetName}" both claim ${String(r.cardNumber).toUpperCase()}|${r.parallel || "base"}`,
                  dryRun: !APPLY,
                  salesContainer: poolContainer(),
                  known: await lookup(incumbentSlug),
                },
              );
              // "noop" means the row was already where it belongs. Any other
              // non-moving action left the plain id occupied.
              if (moved.action === "move" || moved.action === "replace" || moved.action === "fold") {
                subsetIncumbentMoved++;
                subsetSalesRepointed += moved.salesRepointed || 0;
              } else if (moved.action !== "noop") {
                subsetVacateFailed++;
                if (vacateFailures.length < 8) {
                  vacateFailures.push(String(r.cardNumber).toUpperCase() + "|" + (r.parallel || "base")
                    + ` -> ${incumbentSlug}: ${moved.action} (${moved.decision})`);
                }
              }
            }
            subsetDisambiguated++;
            if (disambiguatedExamples.length < 8) {
              disambiguatedExamples.push(String(r.cardNumber).toUpperCase() + "|" + (r.parallel || "base")
                + ': "' + product.subsetName + '" + "' + known.subsetName + '" -> ' + slugForWrite);
            }
            known = await lookup(slugForWrite);
          }

          const landed = await upsertCatalogEntry({
            id: slugForWrite, cardId: slugForWrite, hobbyiqCardId: slugForWrite,
            sport: product.sport, year: product.year,
            // CF-YEAR-CARDYEAR-DUAL-WRITE (Drew, 2026-08-11), which this
            // hand-rolled doc never honoured. deriveCatalogEntry writes both
            // names; this lane bypasses it and wrote `year` alone, so every
            // row it has ever minted -- Tiffany 1984-1991, Fleer
            // Tiffany/Glossy, the 1990s baseball destinations (#1766), the
            // vintage FB/BK/HK cells -- was invisible to any reader filtering
            // `c.cardYear`. That is precisely how the strictest checklists we
            // own read as "strict-checklist 0" to the GREAT REMATCH and left
            // the 22 Tiffany-titled 1987 Maddux #70T rows in CONFLICT.
            // cardYear is a MIRROR of year, never a second fact: same value,
            // one expression, so the two can never drift.
            cardYear: product.year,
            setKey: product.setKey, setName: product.setName,
            ...(product.subsetName ? { subsetName: product.subsetName } : {}),
            // PERSISTED, so the decision is the CATALOG'S and every later reader
            // reaches the same slug without re-deriving the clash for itself.
            ...(subsetInId ? { subsetInId: true } : {}),
            cardNumber: String(r.cardNumber).toUpperCase(),
            // EXACTLY the checklist's words. Identity grammar (the :base:
            // segment) lives in the slug; injecting "Base" into the stored
            // field puts a word in the checklist's mouth ("you keep adding
            // words like that and it messes up the checklists" -- Drew,
            // 2026-08-28). Blank stays blank.
            parallel: r.parallel || null,
            // optional 7th column: the checklist's footnote, verbatim, never in the name
            ...(r.parallelNote ? { parallelNote: r.parallelNote } : {}),
            parallelSlug: slugify(r.parallel || "Base"),
            isAuto: r.isAuto === "true",
            printRun: r.printRun ? Number(r.printRun) : null,
            playerName: r.player, playerSlug: slugify(r.player),
            vendorIds: {},
            source: SOURCE,
            confidence: 0.95,
            verificationStatus: "verified",
            catalogVersion: 2,
            searchTokens: Array.from(new Set([
              String(product.year), String(r.cardNumber).toLowerCase(),
              ...r.player.toLowerCase().split(/\s+/),
              ...(r.parallel ? r.parallel.toLowerCase().split(/\s+/) : []),
              ...product.setKey.split("-"),
            ].filter(Boolean))),
          }, { known });
          // The service swallows its own upsert error and returns null: that
          // row was NOT written, and counting it as written is how a run
          // reconciles green having lost rows.
          if (!landed) { failed++; return; }
          written++;
          if (r.isAuto === "true") signed++;
          // CF-THE-LABEL-IS-NOT-THE-ATTESTATION (2026-08-29, D3b). When the
          // merge keeps the existing row (another source, equal or higher
          // authority, equal or higher confidence), the write refreshed
          // lastSeenAt and nothing else -- the row does NOT carry this SOURCE.
          // Counted on its own line, as a slice of written, so "rows under the
          // new source" is never mistaken for "rows this ingest attested".
          if (landed.source !== SOURCE) keptExisting++;
        } catch (e) {
          failed++;
          if (failed <= 5) console.error(`  failed ${String(r.cardNumber)}: ${String(e.message || e).slice(0, 70)}`);
        }
      }));
      const processed = Math.min(i + CONCURRENCY, batch.length);
      if (LIMIT && written >= LIMIT) { stopReason = "limit"; notReached += batch.length - processed; break; }
      if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; notReached += batch.length - processed; break; }
    }
    // Marked only when the whole file was processed: a budget stop mid-file
    // must NOT claim the file is done, or its tail is silently lost.
    if (!stopReason && APPLY) {
      try { fs.writeFileSync(csvPath + ".ingested", String(written)); } catch { /* a lost marker only costs a redo */ }
    }
    // Rate, live. Printing throughput only in the final summary means the
    // answer to "does this fit in the budget?" arrives when the budget is
    // already spent -- which is how a 216 rows/min run went two full cycles
    // before anyone could see it was 175x too slow.
    const mins = Math.max(1 / 60, (Date.now() - STARTED) / 60000);
    process.stderr.write(`\r  ${files_ok}/${files.length}  rows=${f(rows)} written=${f(written)}  ${f(Math.round(written / mins))}/min   `);
  }
  process.stderr.write("\n");

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  files ingested         ${f(files_ok)}${SLOTS > 1 ? `   of ${f(allFiles.length)} in the directory — SHARD ${SLOT}/${SLOTS}, NOT the whole set` : ""}`);
  console.log(`  files already done     ${f(alreadyDone)}   <- resumed past these`);
  console.log(`  files with no manifest ${f(noProduct)}   <- could not name the product`);
  console.log(`  categories REFUSED, exploded ${f(explodedCategories)} (${f(explodedRows)} rows)   <- >${f(EXPLODED_PAR_MAX)} rungs or >${f(EXPLODED_NUM_MAX)} card numbers inside ONE category; a cross-join, not a checklist`);
  console.log(`  files with nothing left ${f(explodedFiles)}   <- every category refused`);
  console.log(`  rows with card-line parallel ${f(cardLineParallel)}   <- "100 Mike Trout" is not a rung; skipped`);
  console.log(`  rows with player-name parallel ${f(playerNameParallel)}   <- a roster line, not a rung; skipped`);
  console.log(`  csv rows read          ${f(rows)}`);
  console.log(`  catalog rows written   ${f(written)}`);
  console.log(`  ${APPLY ? "ingested" : "would ingest"} ${f(written)} rows (${f(signed)} signed)   <- signed = isAuto, from a section the page attested; never inferred from a rung name`);
  if (APPLY) console.log(`    of which kept the existing row ${f(keptExisting)}   <- same id already held by another source at equal/higher authority and confidence; only lastSeenAt moved, the row does NOT carry source=${SOURCE}`);
  {
    // The number that decides whether another cycle is needed, stated rather
    // than left to be inferred from a wall-clock subtraction.
    const mins = Math.max(1 / 60, (Date.now() - STARTED) / 60000);
    const rate = Math.round(written / mins);
    const left = files.length - files_ok;
    console.log(`  throughput             ${f(rate)} rows/min`);
    if (left > 0 && rate > 0 && files_ok > 0) {
      const perFile = rows / Math.max(1, files_ok);
      console.log(`  files left             ${f(left)}   ~${f(Math.ceil((left * perFile) / rate))} more minutes at this rate`);
    }
  }
  console.log(`  rows skipped           ${f(skippedRow)}   <- no card number, no player, or unslugable`);
  console.log(`  subset clashes RESOLVED   ${f(subsetDisambiguated)}   <- same (cardNumber, rung) under a DIFFERENT subset; both cards re-minted with a :sub- segment (${f(subsetIncumbentMoved)} incumbents MOVED off the plain id, vacating it; ${f(subsetSalesRepointed)} sales re-pointed)`);
  if (subsetVacateFailed) {
    // LOUD. Each of these is a plain id still answering for two cards.
    console.log(`  subset clashes NOT VACATED ${f(subsetVacateFailed)}   <- the incumbent could NOT be moved off the plain id; it still answers for both cards`);
    for (const line of vacateFailures) console.log(`      ${line}`);
  }
  if (disambiguatedExamples.length) console.log(`    e.g. ${disambiguatedExamples.join("; ")}`);
  console.log(`  subset collisions REFUSED ${f(subsetCollision)}   <- the clash is real but ONE SIDE OF IT HAS NO SUBSET NAME; blank is unknown and is never invented`);
  if (collisionExamples.length) console.log(`    e.g. ${collisionExamples.join("; ")}`);
  console.log(`  numbered, parallel blank ${f(unnamedParallel)}   <- NOT written as Base; the name is unknown`);
  console.log(`  rows not reached       ${f(notReached)}   <- the budget stopped before these`);
  console.log(`  failed                 ${f(failed)}`);
  if (APPLY) {
    // CF-A-SLICE-IS-NOT-A-SIBLING-COUNTER: every row the gates dropped before
    // the batch (card-line parallels, player-name parallels, exploded
    // categories) is DECLARED, or the reconciliation calls the run vanished --
    // D3 APPLY shards 3/4 wrote 353,739 + 351,022 rows and exited non-zero
    // over 2,065 + 6,434 undeclared gate drops.
    //
    // CF-A-REFUSED-SUBSET-COLLISION-IS-A-DECLARED-SKIP (2026-09-04, run
    // 33882293958). `subsetCollision` was missing from this sum, and it is the
    // ONE refusal path that returns without touching any counter the sum knows
    // about. So a page holding a real collision wrote fewer rows than it
    // intended, declared none of the difference, and exited 4 "WORK VANISHED"
    // -- which the driver records as `failed`. It cost 8 of that run's 76
    // failures, every one of them a page where the guard did EXACTLY its job:
    //
    //   2000-01 Topps Chrome Johnson Reprints Refractors   intended 7, written 0
    //   2003-04 Topps Chrome Gametime Gear Relics Refractors  intended 24, written 20
    //   2004-05 Topps Chrome Town Heroes Refractors        intended 29, written 24
    //
    // A refusal we chose, counted, printed a reason for and showed examples of
    // is the definition of a DELIBERATE, DECLARED skip. Leaving it out of the
    // declaration makes the reconciler report our own correct guard as a
    // vanished write, which is the same class of defect as
    // CF-A-CORRECT-REFUSAL-IS-NOT-A-LANE-FAILURE in the driver: a right answer
    // must not be laundered into an error somewhere downstream.
    //
    // `subsetDisambiguated` is deliberately NOT added: those rows ARE written,
    // just at a subset-bearing slug, so they are already inside `written`.
    // Adding them would double-count and overshoot `intended` instead.
    reportWrites({ job: "ingest-checklist-csv-to-catalog", intended: rows, written, skipped: skippedRow + notReached + unnamedParallel + cardLineParallel + playerNameParallel + explodedRows + subsetCollision, failed });
  }
}

module.exports = { splitCsv, productOf };

if (require.main === module) {
  // CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
main()
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => { console.error("FATAL:", e?.stack || e?.message); 
    await finishLane(3);
  });
}
