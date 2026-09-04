#!/usr/bin/env node
/**
 * CF-DRIVE-THE-UNIVERSE-ONE-ENTRY-AT-A-TIME (D38, 2026-09-01).
 *
 * The enumeration (D37) proved WHAT exists: 7,755 sets across six lanes, of
 * which 2,451 are missing from the catalog entirely and 2,264 are partial. This
 * script is the thing that closes them, one entry at a time, on a runner.
 *
 * WHY A DRIVER AND NOT ANOTHER SWEEP. ingest-checklists-end-to-end acquires a
 * whole SOURCE per run -- scrape all of Beckett, then all of insider. That is
 * the right shape for a first fill and the wrong shape for closing a gap list:
 * it re-scrapes 718 pages to reach the 3 that are missing, it cannot say which
 * SET a failure belonged to, and a budget stop loses the position. This drives
 * the MANIFEST instead: take the next N pending entries for one lane, acquire
 * exactly those, and record a verdict per entry.
 *
 * IT REIMPLEMENTS NO SCRAPING. Every acquisition shells out to the same script
 * the end-to-end path uses, with the same arguments, and every ingest lands
 * through ingest-checklist-csv-to-catalog.cjs / ingest-scraped-checklist.cjs --
 * so the doctrine guards those carry (the exploded-file gate, the player-as-rung
 * filter, the card-line-as-rung filter) apply here unchanged. What this adds is
 * a PER-ENTRY gate in front of the ingest, because those guards drop a bad
 * category and land the rest, which is right for a sweep and wrong for an entry
 * whose whole verdict we are about to record.
 *
 * WHERE THE STATE LIVES. A runner job cannot push, so the manifest is immutable
 * (the universe: which sets exist and where each is fetched) and the mutable
 * verdict is a control doc per entry in `crawl_state` -- the container
 * tca-firehose-ingest already uses for exactly this, self-partitioned on id.
 *
 * SCOPE IS REQUIRED. `sources` names the lane and there is NO default: a driver
 * that picks its own lane on an empty input runs a lane nobody dispatched.
 *
 * Env (all via the existing backfill-runner inputs -- no new inputs):
 *   SOURCES=hobbymonitor|insider|bcp|beckett|tcdb|clc|tcgdexja|sportscardchecklist   REQUIRED
 *   BACKFILL_APPLY=true    actually acquire + ingest + write verdicts
 *   LIMIT=N                entries this run (0 = budget-sized)
 *   YEARS=1969,1972        optional year scope
 *   SPORTS=football        optional sport scope
 *   SCOPE=recheck          re-attempt entries already verdicted (default: pending only)
 *   RUN_MINUTES=140        budget; prints the marker when entries remain
 *   COSMOS_CONNECTION_STRING   required
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const HERE = __dirname;
const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
const STARTED = Date.now();
const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const RECHECK = String(process.env.SCOPE || "").toLowerCase() === "recheck";
const MANIFEST_PATH = process.env.MANIFEST_PATH || path.join(HERE, "..", "data", "ingest-universe.json");
const WORKDIR = process.env.WORKDIR || path.join(os.tmpdir(), "hiq-universe");
const CONTROL_CONTAINER = process.env.CONTROL_CONTAINER || "crawl_state";
/** How many CONSECUTIVE failed/unreachable entries mean the lane is down rather
 *  than the entries being bad. Consecutive, never cumulative -- see the
 *  tripwire in the loop. Tunable so a probe can lower it; never 0 or 1, which
 *  would restore the exact one-entry-kills-the-lane behaviour this replaced. */
const SYSTEMIC_FAILURE_STREAK = Math.max(2, Number(process.env.SYSTEMIC_FAILURE_STREAK || 3));

/**
 * CF-A-CORRECT-REFUSAL-IS-NOT-A-LANE-FAILURE (2026-09-04).
 *
 * The statuses that mean "we asked, and the source answered that it has nothing
 * here". They are TERMINAL verdicts about the entry and they are deliberately
 * NOT evidence about the lane's health, so the systemic tripwire skips them --
 * a lane whose next thirty sets the source genuinely does not card is a WORKING
 * lane, and aborting it strands the entries behind them (run 33845979897: XY2,
 * XY3, XY4 empty at tcgdex, 49 entries never attempted).
 *
 * `failed` still means OUR pipe broke and `unreachable` still means the host
 * would not answer; both still count toward the streak.
 */
const EMPTY_STATUS = "empty";
/** Statuses that advance the systemic-failure streak. `empty` is excluded by
 *  construction: it is the source answering, not the lane refusing. */
const STREAK_STATUSES = new Set(["failed", "unreachable"]);

const f = (n) => Number(n).toLocaleString();
const left = () => RUN_MS - (Date.now() - STARTED);

/**
 * The lane vocabulary. `sources` is the operator's word; `lane` is the
 * manifest's. They differ in exactly one place -- the runner input has always
 * said `insider` and the manifest says `checklistinsider` -- so the alias is
 * written down rather than left for a dispatch to discover as an empty run.
 *
 * tcdb is accepted and then REFUSED with a reason, deliberately. D37 measured
 * that scrape-tcdb.cjs extracts 0 rows and exits 0 on a block, and that TCDB
 * has no enumerable index at all. Silently omitting it from this map would make
 * `sources=tcdb` an unknown-lane error that reads like a typo; naming it here
 * makes the refusal say why.
 */
const LANE_ALIASES = {
  hobbymonitor: "hobbymonitor",
  insider: "checklistinsider",
  checklistinsider: "checklistinsider",
  bcp: "bcp",
  beckett: "beckett",
  clc: "clc",
  tcgdexja: "tcgdexja",
  // The vintage lane (2026-09-04). Covers the seven football/basketball/hockey
  // cells no other source reaches; `scc` is the short form an operator types.
  sportscardchecklist: "sportscardchecklist",
  scc: "sportscardchecklist",
  tcdb: "tcdb",
};

/**
 * CF-THE-LANE-NAME-IS-NOT-THE-SOURCE-NAME (2026-09-04).
 *
 * The ingest child stamps `source` on every row it writes, and
 * catalogAuthorityOf reads that string to decide whether the row may
 * adjudicate. The driver was building it from its OWN lane key --
 * `${lane}-${date}` -- and two of the six lane keys are not source names the
 * authority vocabulary knows:
 *
 *   hobbymonitor-2026-09-04       checklist   ok
 *   checklistinsider-2026-09-04   checklist   ok
 *   beckett-2026-09-04            checklist   ok
 *   tcgdexja-2026-09-04           checklist   ok
 *   bcp-2026-09-04                UNKNOWN  <- the CHECKLIST regex spells it
 *   clc-2026-09-04                UNKNOWN     `cardpedia`/`bccp`, never `bcp`
 *
 * The child refuses an unknown source ON PURPOSE -- rows written under it rank
 * BELOW the derived rows the ingest exists to correct -- so it printed FATAL
 * and exited 2. Every bcp and clc entry the driver has ever attempted failed
 * at that line, which is what run 33839532087 was actually reporting.
 *
 * The names below are not new: ingest-checklists-end-to-end.cjs, the sibling
 * wrapper over the same staged directories, already ingests bcp as
 * `baseballcardpedia-ladders-<stamp>` and clc as `checklistcenter-<stamp>`.
 * The driver invented a parallel vocabulary for the same rows. Using the
 * wrapper's names also keeps `isBcpFamily` true for the bcp rows, so D29/R2's
 * product-filing rule keeps applying to them -- a row stamped `bcp-` would
 * have escaped that rule as well as the authority one.
 *
 * The lane keys stay what they are; only the stamped provenance is mapped.
 */
const LANE_SOURCE = {
  hobbymonitor: "hobbymonitor",
  checklistinsider: "checklistinsider",
  bcp: "baseballcardpedia-ladders",
  beckett: "beckett-checklist",
  clc: "checklistcenter",
  tcgdexja: "tcgdex-ja",
  // #1710's vintage lane. Its own name already classifies as checklist, so
  // this entry is the declaration rather than a translation -- but it is still
  // REQUIRED, because a lane absent from this map now refuses up front instead
  // of failing one fetch at a time. That is the point: adding a lane is a
  // decision about provenance, and the map is where the decision is recorded.
  sportscardchecklist: "sportscardchecklist",
};

/** Per-entry minutes, measured from D37's own acquisition timings. Used to size
 *  N against the budget so a run stops on its own clock and prints the marker,
 *  rather than being SIGKILLed at the step ceiling having printed nothing. */
const LANE_MINUTES = {
  hobbymonitor: 1.2,
  checklistinsider: 2.0,
  bcp: 1.0,
  beckett: 1.5,
  clc: 1.2,
  tcgdexja: 0.5,
  // 0.5-2 MB per set page plus the >=2s politeness delay this source is
  // crawled under. Measured on the three sampled sets, not assumed.
  sportscardchecklist: 0.6,
};

// ── the canonical CSV ────────────────────────────────────────────────────────
const CANONICAL_HEADER = "category,cardNumber,parallel,isAuto,printRun,player";

/** Split one CSV line on commas outside quotes. The staged files are written by
 *  the lane scripts in the canonical format, but a player name legitimately
 *  carries a comma ("Griffey Jr., Ken"), so a naive split mis-columns the row
 *  and a gate reading those columns would judge the wrong field. */
function splitCsv(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === "," && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const foldName = (v) => String(v ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The rung vocabulary, copied from ingest-checklist-csv-to-catalog.cjs so the
 *  gate and the ingest agree on what a parallel name looks like. */
const PARALLEL_WORDS = new Set(["refractor","refractors","xfractor","x-fractor","fractor","prizm","prizms","mojo","wave","shimmer","foil","foilboard","holo","chrome","sapphire","superfractor","printing","plate","plates","black","gold","silver","blue","red","green","orange","purple","pink","yellow","aqua","teal","magenta","fuchsia","bronze","platinum","rainbow","atomic","lava","pattern","laser","crackle","mini","base","parallel","variation","variations","sp","ssp","auto","autograph","autographs","relic","patch","jersey","insert","inserts","checklist","1/1","numbered","border","camo","tie-dye","disco","cracked","ice","optic","velocity","hyper","speckle","sparkle","glitter","neon","negative","sepia","vintage","stock","paper","canvas","gilded","glossy","matte"]);

const isPersonName = (v) => {
  const t = foldName(v).split(" ").filter(Boolean);
  return t.length >= 2 && t.length <= 5 && !t.some((w) => PARALLEL_WORDS.has(w)) && !/^\d/.test(t[0]);
};

/** The same ceilings the ingest's exploded-file gate uses. No real checklist
 *  CATEGORY carries more than ~150 rungs or ~2,000 card numbers; the 11.49M-row
 *  spine did, because it cross-joined cards against players. */
const EXPLODED_PAR_MAX = Number(process.env.EXPLODED_PAR_MAX || 150);
const EXPLODED_NUM_MAX = Number(process.env.EXPLODED_NUM_MAX || 2000);

/**
 * THE PER-ENTRY CLEANLINESS GATE.
 *
 * The ingest's own guards are per-category and per-row: they drop the bad part
 * and land the rest, which is correct for a sweep across 400 files. An entry in
 * this driver is ONE set whose status we are about to record, so a file that
 * needs those guards to fire is not a clean acquisition -- it is a scrape that
 * went wrong, and recording it `ingested` would close a gap the catalog still
 * has. This refuses the whole entry and says which rule it broke.
 *
 * Returns { ok, reason, stats }.
 */
function gateStagedCsv(csvPath) {
  const stats = { rows: 0, base: 0, ladder: 0, withPrintRun: 0, categories: 0, playersAsParallel: 0, cardLineParallel: 0 };
  let text;
  try { text = fs.readFileSync(csvPath, "utf8"); }
  catch (e) { return { ok: false, reason: `staged file unreadable: ${e.code || e.message}`, stats }; }

  const lines = text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim());
  if (!lines.length) return { ok: false, reason: "staged file is empty", stats };

  // THE ONE CANONICAL CSV. A file whose header is not the canonical format
  // means the converter wrote a different shape, and every column index the
  // gate and the ingest read would be off by one silently.
  const header = lines[0].replace(/^﻿/, "").trim();
  const headerCols = splitCsv(header).slice(0, 6).join(",");
  if (headerCols !== CANONICAL_HEADER) {
    return { ok: false, reason: `not the canonical CSV header (got "${header.slice(0, 80)}")`, stats };
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const [category, cardNumber, parallel, isAuto, printRun, player] = splitCsv(lines[i]);
    if (!cardNumber && !player) continue;
    stats.rows++;
    rows.push({ category: category || "base", cardNumber, parallel: parallel || "", isAuto, printRun: printRun || "", player: player || "" });
  }
  if (!stats.rows) return { ok: false, reason: "0 data rows parsed", stats };

  // CF-THE-LITERAL-BASE-IS-A-BASE-CARD (2026-09-04).
  //
  // "base" was read as "the parallel column is EMPTY", but the BCP scraper
  // states the base set explicitly -- its own header says so: "Base rows are
  // emitted with the literal 'Base' -- these ARE the checklist's base set,
  // which is the one place 'Base' is a statement of fact rather than a default
  // for a blank (see #1324)". So every row of a page whose base set is spelled
  // out counted as ladder, stats.base fell to 0, and the zero-base rule
  // refused the file.
  //
  // Measured on 1990_Bowman, run 33845791358 entry [7/20]: 1,058 staged rows,
  // 529 of them `parallel=Base` and 529 `parallel=Tiffany`, REFUSED as "zero
  // base cards (1,058 rows, all carry a parallel)". A complete, correct
  // two-rung checklist thrown away -- and, being the third verdict in a row,
  // it was the entry that tripped the systemic abort and took the lane down.
  //
  // This does NOT weaken #1324. A BLANK parallel still means unknown and still
  // counts as a base card, exactly as before; what changes is that the literal
  // word, which is an ATTESTATION that the row is the base card, is no longer
  // mistaken for a rung. The two spellings now agree, and a page that says
  // "Base" out loud is no longer punished for saying it.
  const isBaseParallel = (p) => !p || /^base(?:\s+set)?$/i.test(String(p).trim());
  for (const r of rows) {
    if (isBaseParallel(r.parallel)) stats.base++;
    else { stats.ladder++; if (r.printRun) stats.withPrintRun++; }
  }

  // ZERO BASE CARDS. A checklist with a parallel ladder but no base cards is a
  // ladder that has nothing to attach to -- the shape a cross-join leaves when
  // it joins rungs onto a subset that was never parsed. Note this is a floor on
  // BASE rows, not on the blank-parallel reading: a blank parallel means
  // unknown, never "Base", and those rows are still cards.
  //
  // The code is load-bearing: this is the ONE rule of the gate that a single
  // scope file may legitimately break, because a page's base set can live in a
  // sibling scope (see gateStagedEntry). Every other rule below is a defect in
  // the file itself and stays fatal per file.
  if (stats.base === 0) {
    return { ok: false, code: "zero-base", reason: `zero base cards (${f(stats.rows)} rows, all carry a parallel)`, stats };
  }

  // PLAYERS-AS-PARALLELS LEAKAGE. A parallel equal to a player name IN THIS
  // FILE is a roster line the scraper read as a rung. The file knows its own
  // players, so this needs no external vocabulary.
  const players = new Set(rows.map((r) => r.player).filter(isPersonName).map(foldName));
  for (const r of rows) if (r.parallel && players.has(foldName(r.parallel))) stats.playersAsParallel++;
  if (stats.playersAsParallel > 0) {
    return { ok: false, reason: `${f(stats.playersAsParallel)} rows whose parallel is a player name from this same file`, stats };
  }

  // A CARD LINE IS NOT A RUNG. "27 Mike Trout" in the parallel column is a
  // scraper joining a card line to a ladder.
  const CARD_LINE_PARALLEL = /^[A-Za-z]{0,5}[-\s]?\d{1,4}[a-z]?\s+\p{L}/u;
  const NOT_A_NAME_AFTER_NUMBER = /^(?:in|of|to|and|the|for|per|on|at|by)\b/i;
  const FINISH_AFTER_NUMBER = /^(?:colou?r|tone|tool|of|piece|pc|patch|star|swatch|box|case|player|team|logo|letter|strand)\b/i;
  for (const r of rows) {
    if (!r.parallel || !CARD_LINE_PARALLEL.test(r.parallel)) continue;
    const tail = r.parallel.replace(/^[A-Za-z]{0,5}[-\s]?\d{1,4}[a-z]?\s+/, "");
    if (NOT_A_NAME_AFTER_NUMBER.test(tail) || FINISH_AFTER_NUMBER.test(tail)) continue;
    stats.cardLineParallel++;
  }
  if (stats.cardLineParallel > 0) {
    return { ok: false, reason: `${f(stats.cardLineParallel)} rows whose parallel is a card line ("<number> <name>")`, stats };
  }

  // CROSS-JOIN ARITHMETIC, per category -- the 11.49M-row graveyard.
  const byCat = new Map();
  for (const r of rows) {
    const c = String(r.category || "base");
    if (!byCat.has(c)) byCat.set(c, { pars: new Set(), nums: new Set(), rows: 0, ladderRows: 0 });
    const g = byCat.get(c);
    g.pars.add(r.parallel); g.nums.add(r.cardNumber); g.rows++;
    if (r.parallel) g.ladderRows++;
  }
  stats.categories = byCat.size;
  for (const [c, g] of byCat) {
    if (g.pars.size > EXPLODED_PAR_MAX) return { ok: false, reason: `category "${c}" carries ${f(g.pars.size)} distinct parallels (>${EXPLODED_PAR_MAX}) — cross-join`, stats };
    if (g.nums.size > EXPLODED_NUM_MAX) return { ok: false, reason: `category "${c}" carries ${f(g.nums.size)} distinct card numbers (>${EXPLODED_NUM_MAX}) — cross-join`, stats };
    // THE MULTIPLICATIVE SIGNATURE IS NOT ITSELF A DEFECT
    // (CF-A-PER-SUBSET-LADDER-IS-SUPPOSED-TO-MULTIPLY, 2026-09-03).
    //
    // `rows ≈ cards × rungs` is what a CORRECTLY read ladder looks like. Since
    // CF-HM-LADDER-INTO-ROWS the fetchers emit one row per (card, rung of that
    // card's OWN subset) — 2012/13 Panini Prizm's base is 300 cards × {blank,
    // Prizms, Prizms Green, Prizms Gold} = 1,200 rows, and that is the actual
    // checklist. This rule read that as a smear and refused every modern Panini
    // file the lane produced, which is why 2022 Donruss Optic Basketball has
    // 7,603 pool rows against 0 catalog rows.
    //
    // The 11.49M-row graveyard was cards × PLAYERS, not cards × rungs, and the
    // two are told apart by WHAT is in the parallel column — which the
    // players-as-parallels and card-line-as-rung guards above already decide,
    // per row, on this file's own roster. What is left for arithmetic to catch
    // is a ladder too WIDE to be one subset's rung list: the ceilings above
    // (EXPLODED_PAR_MAX / EXPLODED_NUM_MAX) do that.
    //
    // So the shape is refused only when the rung list is implausibly wide AND
    // perfectly dense — a full cartesian product against a large rung set, with
    // no card missing a single rung. A real ladder is ragged: short prints,
    // rookie-only rungs and per-card variations leave holes. Measured on the
    // lane, the widest legitimate per-subset ladder is 2023/24 Donruss Optic's
    // base at 253 rungs; a file that beats EXPLODED_PAR_MAX is already refused
    // above, so this only fires on a dense product inside that ceiling.
    // Density is measured against the NON-BLANK rungs. A blank parallel is a
    // base row, one per card, and counting it as a rung drags a true cartesian
    // just under any threshold — a 300 x 80 product reads as 300 x 81 and
    // slips through at 98.8% of the wrong denominator.
    const rungCount = g.pars.size - (g.pars.has("") ? 1 : 0);
    const cartesian = rungCount > 0 && g.ladderRows >= rungCount * g.nums.size * 0.995;
    if (cartesian && rungCount > 60 && g.nums.size > 200) {
      return { ok: false, reason: `category "${c}" pairs every one of ${f(g.nums.size)} cards with every one of ${f(rungCount)} rungs (${f(g.ladderRows)} ladder rows, no gaps) — a cartesian product, not a ladder`, stats };
    }
  }

  return { ok: true, reason: null, stats };
}

/**
 * THE ENTRY-LEVEL GATE. One BCP page stages one CSV PER SCOPE, and the verdict
 * this driver records is about the PAGE, so the judgment has to be made over
 * all of them at once.
 *
 * Every rule of gateStagedCsv stays fatal per file -- a bad header, a
 * players-as-rungs leak or a cartesian category is a defect in that file no
 * sibling can excuse, and admitting the entry would land exactly the dirty
 * rows the per-entry gate exists to keep out.
 *
 * `zero-base` is the one exception, and it is not a weakening. "This ladder
 * has nothing to attach to" was always a claim about the PAGE; it only read as
 * a claim about a file back when a page was a file. 2015 Bowman Chrome's
 * Prospects Light Blue Refractors scope genuinely has no base cards of its
 * own, and it is not supposed to -- the base cards are the page's, in the bare
 * stem file, and the rung attaches to them. So the rule is asked of the entry:
 * refused only when NO staged file of the page carries a base card, which is
 * the cross-join shape the rule was written for and which the 11.49M-row
 * graveyard actually had.
 *
 * Stats are summed across the files, so `ladder`/`withPrintRun` -- which
 * decide `partial` vs `ingested` downstream -- describe the whole page.
 */
function gateStagedEntry(csvPaths) {
  const paths = Array.isArray(csvPaths) ? csvPaths : [csvPaths];
  const total = { rows: 0, base: 0, ladder: 0, withPrintRun: 0, categories: 0, playersAsParallel: 0, cardLineParallel: 0 };
  if (!paths.length) return { ok: false, reason: "no staged CSV", stats: total, files: [] };

  const files = [];
  let zeroBase = null;
  for (const p of paths) {
    const g = gateStagedCsv(p);
    files.push({ file: path.basename(p), ok: g.ok, code: g.code ?? null, reason: g.reason, stats: g.stats });
    for (const k of Object.keys(total)) total[k] += g.stats?.[k] ?? 0;
    // A per-file defect other than zero-base condemns the entry immediately,
    // and it names the FILE -- "the gate refused" with no filename is
    // unactionable when a page stages five of them.
    if (!g.ok && g.code !== "zero-base") {
      return { ok: false, reason: `${path.basename(p)}: ${g.reason}`, stats: total, files };
    }
    if (!g.ok) zeroBase = zeroBase ?? g;
  }

  if (total.base === 0) {
    return {
      ok: false,
      reason: `zero base cards across all ${f(paths.length)} staged file(s) (${f(total.rows)} rows, all carry a parallel)`,
      stats: total, files,
    };
  }
  return { ok: true, reason: null, stats: total, files, zeroBaseFiles: files.filter((x) => x.code === "zero-base").map((x) => x.file) };
}

// ── acquisition, per lane, through the EXISTING scripts ──────────────────────

/** How many trailing lines of a failed child's stderr reach the verdict. */
const CHILD_STDERR_LINES = 15;

/**
 * CF-A-COMMAND-FAILED-IS-NOT-A-DIAGNOSIS (2026-09-04).
 *
 * Backfill Runner 33839532087 aborted the bcp lane on a 3-streak and left
 * exactly this in the log, twice:
 *
 *   FAILED — Command failed: /opt/.../node /home/.../ingest-checklist-csv-
 *
 * That is execFileSync's own message -- the ARGV, truncated by the verdict's
 * 140-char slice -- and it names the command rather than the complaint. The
 * child had in fact printed the reason on stderr and exited 2:
 *
 *   FATAL: SOURCE "bcp-2026-09-04" classifies as unknown, not checklist.
 *
 * The driver captured that on the pipe and threw it away, so the run reported
 * a broken lane where the truth was a one-line naming defect. A whole dispatch
 * (20 entries, the canary acceptance among them) was spent to learn nothing.
 *
 * execFileSync hangs stdout/stderr off the error, so the fix is to read them.
 * The TAIL, not the head: a child that fails prints its diagnosis last, and
 * `FATAL:` on the final line is exactly the shape being lost here. The child's
 * words come first in the message so the verdict's own truncation cuts the
 * argv, never the reason.
 */

/**
 * CF-THE-RUNNER-FANOUT-IS-NOT-THE-CHILD'S (2026-09-04).
 *
 * The workflow exports its OWN fan-out and bound as plain environment
 * variables -- LIMIT (entries this DRIVER run takes), SLOT/SLOTS (which shard
 * of a FLEET this dispatch is) -- and `run()` handed the child
 * `{...process.env}`. Those names mean something completely different one
 * level down: in ingest-checklist-csv-to-catalog they are the bound on ROWS
 * WRITTEN and the shard of STAGED FILES.
 *
 * Measured on backfill run 33845791358 (LIMIT=20, SLOT=0, SLOTS=16):
 *
 *   SLOTS=16  ->  the child kept files.filter((_, i) => i % 16 === 0), so
 *                 2015 Bowman Chrome's THREE staged scope files became one --
 *                 and the one kept was `--prospects-light-blue-refractors`,
 *                 a parallel scope with no base cards in it at all.
 *   LIMIT=20  ->  the child stopped after 20 rows written, so a 2,980-row
 *                 2011 Topps Chrome staging (290 of them autographs) landed
 *                 ELEVEN rows across the whole run, every one of them
 *                 isAuto=false, and every one of them card #1, #2 or #3.
 *
 * The driver had already read the catalog before and after, so it reported
 * "INGESTED — 3 rows created" and a green reconciliation. The numbers were
 * internally consistent; they were consistent about 0.4% of the job. This is
 * the same defect the ingest child's own SHARD banner was written for, one
 * wrapper up -- and this driver never got that lesson.
 *
 * A DRIVER'S OWN SCOPE IS NOT ITS CHILD'S SCOPE. The child is handed exactly
 * one product's staged directory and must ingest ALL of it; any narrowing here
 * is silent data loss wearing a green check. So these names are DELETED from
 * the child's environment rather than passed through -- explicitly, by name,
 * so a child that genuinely wants one can still be given it in `env`.
 */
const RUNNER_SCOPE_VARS = ["LIMIT", "SLOT", "SLOTS", "SCAN_LIMIT", "MAX_ROWS"];

function run(script, args, env, timeoutMs) {
  const childEnv = { ...process.env, ...env };
  // Deleted AFTER the merge so an explicit `env` value still wins: the caller
  // stating a bound is a decision, inheriting one is an accident.
  for (const k of RUNNER_SCOPE_VARS) if (!(env && k in env)) delete childEnv[k];
  try {
    return execFileSync(process.execPath, [path.join(HERE, script), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs || 10 * 60000,
    });
  } catch (e) {
    // stdout is read too: a child that dies on a guard sometimes says why on
    // stdout and leaves stderr empty, and "no output at all" is itself worth
    // saying out loud rather than reporting as a bare command failure.
    const tail = (buf) => String(buf ?? "")
      .split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean)
      .slice(-CHILD_STDERR_LINES).join(" | ");
    const said = tail(e.stderr) || tail(e.stdout) || "(the child printed nothing)";
    const how = e.status != null ? `exit ${e.status}` : e.signal ? `signal ${e.signal}` : "no exit status";
    const err = new Error(`${script} ${how}: ${said}`);
    err.childStatus = e.status;
    err.childStderr = String(e.stderr ?? "");
    throw err;
  }
}

const slugOf = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

/**
 * CF-A-SCOPE-FILE-IS-NOT-THE-PAGE (2026-09-04).
 *
 * Every multi-file lane took `csvs[0]` off a raw readdirSync -- the FIRST name
 * in lexical order -- and threw the rest away. That was survivable while a
 * page staged one file. It is not survivable now: since CF-ONE-FILE-PER-SCOPE
 * the BCP scraper writes one CSV PER SCOPE of a page, and the bare stem (the
 * scope that holds the base cards, the inserts and the typed sections) sorts
 * LAST, because every qualified sibling carries a `--<scope>` suffix that
 * sorts before the `.csv` extension.
 *
 * Measured on 2015 Bowman Chrome, the entry run 33839532087 refused:
 *
 *   2015-bowman-chrome-baseball--prospects-light-blue-refractors.csv   600 rows, 0 base
 *   2015-bowman-chrome-baseball--prospects-wave-refractors.csv       1,200 rows, 0 base
 *   2015-bowman-chrome-baseball.csv                                  4,430 rows, 227 base
 *
 * csvs[0] is the light-blue PARALLEL scope, so the zero-base-cards gate saw a
 * file that is all parallel -- correctly, for that file -- and refused the
 * whole entry as "600 rows, all carry a parallel". The page's base set was in
 * the third file and was never looked at. A page whose base set lives in
 * another scope must not be refused as all-parallel, and the other two scopes
 * are real rows that were being discarded even on the pages that DID pass.
 *
 * So the acquisition returns every staged file and the caller judges the
 * ENTRY, not an arbitrary member of it. Sorted, so a re-run reads them in the
 * same order a previous run did.
 */
function stagedCsvs(dir) {
  return fs.readdirSync(dir).filter((n) => n.endsWith(".csv")).sort().map((n) => path.join(dir, n));
}

/** The provenance stamped on this lane's rows. See LANE_SOURCE. */
function sourceLabelFor(lane, stamp) {
  const base = LANE_SOURCE[lane];
  if (!base) throw new Error(`no checklist source name declared for lane ${lane} — declare it in LANE_SOURCE`);
  return `${base}-${stamp || new Date().toISOString().slice(0, 10)}`;
}

/**
 * CF-THE-PLAN-AND-THE-APPLY-ARE-ONE-FUNCTION (2026-09-04).
 *
 * The report mode used to print its plan from a hardcoded object literal that
 * lived 500 lines away from the switch that actually runs. Nothing tied them
 * together, so run 33847474466 printed
 *
 *     would drive: fetchSportsCardChecklist.cjs --url <sourceRef> ...
 *
 * for all three entries and was believed to be a clean rehearsal of the apply
 * -- while the apply path for that same lane was broken and threw on every one
 * of them. A report that cannot be wrong about the apply is worth nothing as a
 * rehearsal, and that is exactly what a second copy of the truth buys.
 *
 * So the plan string is DERIVED, by this function, for both modes: report mode
 * prints it, and every lane branch of acquireEntry opens by declaring it, which
 * is what makes it the same sentence rather than two that happen to agree. The
 * completeness assert below closes the other half: a lane that acquireEntry can
 * dispatch but planFor cannot describe -- the shape a new lane arrives in --
 * fails at load, not on the first dispatch.
 *
 * A wrong PLAN is now a wrong RUN. That is the point: they are the same string.
 */
function planFor(entry) {
  const lane = entry.lane;
  switch (lane) {
    case "hobbymonitor":
      return "fetchHobbyMonitorChecklist.cjs --url <sourceRef> (direct-URL lane) → ingest-checklist-csv-to-catalog.cjs";
    case "sportscardchecklist":
      return "fetchSportsCardChecklist.cjs --url <sourceRef> (direct-URL lane) → ingest-checklist-csv-to-catalog.cjs";
    case "checklistinsider":
      return "scrape-checklistinsider.cjs --slugsFile → convertChecklistInsiderToChecklistCsv.cjs → ingest-checklist-csv-to-catalog.cjs";
    case "bcp":
      return "scrape-bcp-ladders.cjs --titles=<page> --titlesOnly → ingest-checklist-csv-to-catalog.cjs";
    case "beckett":
      return "fetch <sourceRef>.xlsx → convertBeckettChecklistXlsx.cjs → ingest-checklist-csv-to-catalog.cjs";
    case "clc":
      return "scrape-checklistcenter-products.cjs --urls → convertChecklistCenterToChecklistCsv.cjs → ingest-checklist-csv-to-catalog.cjs";
    // The lane is TWO scrapers and the plan must say WHICH, or the sentence it
    // prints is not the sentence the apply runs: a modern code (SV*, S*, CS*,
    // M*) routes to the ladder-carrying scraper, the vintage PMCG/neo titles to
    // the original. tcgdexModern is the ONE predicate both sides read.
    case "tcgdexja":
      return `${tcgdexModern(entry)
        ? "scrape-tcgdex-ja-modern.cjs (rarity ladder → parallel)"
        : "scrape-tcgdex-ja.cjs (base-only; tcgdex serves no ladder for these)"} --sets=<id> → ingest-checklist-csv-to-catalog.cjs`;
    default:
      return null;
  }
}

/** The one predicate that decides which tcgdexja scraper runs. Read by BOTH planFor and acquireEntry. */
function tcgdexModern(entry) {
  const setId = String(entry.sourceRef || "").split("/").pop() || "";
  return /^(SV|S\d|CS|M[0-9]|M-P|SVK|SVLN|SVLS)/i.test(setId);
}

/** Every lane acquireEntry can dispatch. The load-time assert below pins planFor to it. */
const ACQUIRE_LANES = ["hobbymonitor", "sportscardchecklist", "checklistinsider", "bcp", "beckett", "clc", "tcgdexja"];

/**
 * Acquire ONE entry into its own directory. Returns { csvPaths: [...] } or
 * throws -- see acquireStaged, which is the checked way to call this.
 * Each lane is the same script the end-to-end wrapper calls, scoped down to the
 * single set by whichever argument that script already accepts for the purpose.
 */
function acquireEntry(entry, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const stem = slugOf(`${entry.year || ""}-${entry.setName || entry.sourceRef}`);
  const csvPath = path.join(dir, `${stem}.csv`);

  switch (entry.lane) {
    case "hobbymonitor": {
      // The direct-URL lane (#1565): fetch this exact release page, bypassing
      // hmSlugFor, which cannot name a release absent from the thin --list index.
      run("fetchHobbyMonitorChecklist.cjs", [
        "--url", entry.sourceRef,
        "--out", csvPath,
        "--year", String(entry.year || ""),
        "--set-key", setKeyFor(entry) || "",
        "--set-name", String(entry.setName || ""),
        "--sport", String(entry.sport || "baseball"),
      ]);
      return { csvPaths: [csvPath] };
    }
    case "sportscardchecklist": {
      // The direct-URL lane, same shape as hobbymonitor: the sourceRef IS the
      // address. Discovery happened once, in the sitemap pass that minted these
      // entries -- this never touches /search/, which robots.txt Disallows via
      // `/?*` and which returns the wrong sets anyway (the survey measured
      // "1972 topps football" returning 18 results, none of them set-11959).
      run("fetchSportsCardChecklist.cjs", [
        "--url", entry.sourceRef,
        "--out", csvPath,
        "--year", String(entry.year || ""),
        "--set-key", setKeyFor(entry) || "",
        "--set-name", String(entry.setName || ""),
        "--sport", String(entry.sport || ""),
      ]);
      // csvPathS. The fetcher writes `<stem>.csv` beside `<stem>.manifest.json`
      // and, for a ladder rung, `<stem>.parallels.json`; the ingest child reads
      // the DIRECTORY, so the sidecars need no naming here. Only the CSV is
      // gated, and it is returned in the same one-element array shape
      // hobbymonitor uses -- see acquireStaged, which now refuses any other.
      return { csvPaths: [csvPath] };
    }
    case "checklistinsider": {
      // --slugsFile re-runs a NAMED subset without re-fetching all 599 pages.
      const slug = entry.sourceRef.replace(/^https?:\/\/[^/]+\//, "").replace(/\/$/, "");
      const slugsFile = path.join(dir, "slugs.txt");
      fs.writeFileSync(slugsFile, slug + "\n");
      const jsonl = path.join(dir, "staged.jsonl");
      run("scrape-checklistinsider.cjs", [`--slugsFile=${slugsFile}`, `--out=${jsonl}`, "--delayMs=1500"]);
      run("convertChecklistInsiderToChecklistCsv.cjs", [`--in=${jsonl}`, `--outDir=${dir}`]);
      const csvs = fs.readdirSync(dir).filter((n) => n.endsWith(".csv"));
      if (!csvs.length) throw new Error("converter produced no CSV");
      return { csvPaths: stagedCsvs(dir) };
    }
    case "bcp": {
      // --titles names the exact mainspace page; BCP has no index, so the page
      // title IS the address.
      const title = decodeURIComponent(entry.sourceRef.split("/index.php/")[1] || "");
      if (!title) throw new Error("cannot derive a bcp page title from sourceRef");
      const said = run("scrape-bcp-ladders.cjs", [
        `--titles=${title}`, "--titlesOnly=1", `--outDir=${dir}`, "--delayMs=800",
        `--sport=${entry.sport || "baseball"}`,
      ]);
      const csvs = fs.readdirSync(dir).filter((n) => n.endsWith(".csv"));
      if (!csvs.length) {
        // CF-A-SET-THE-SOURCE-DOES-NOT-CARD-IS-NOT-A-BROKEN-LANE, the bcp side
        // (#1717 ruled this for tcgdex on the same day; the wiki has the same
        // shape, so it gets the same status rather than a parallel one).
        //
        // The scraper stages nothing for two completely different reasons, and
        // it SAYS which on stdout while exiting 0 either way:
        //
        //   "base ok (109) but 0 rungs — nothing new to add"   <- the page is
        //      fine and we already have everything it offers. 1990_Baseball_Wit
        //      and 1990_Bazooka are oddballs with no parallel ladder at all;
        //      certified autos are a 1990s-ONWARD feature and 1990 is the
        //      boundary year. There is nothing here and never was.
        //
        //   "0 base cards — layout not understood, SKIPPED"    <- a real gap in
        //      our parser, worth a verdict that brings someone back to it.
        //
        // Both read as `failed` before, so run 33845791358 spent entries 5 and
        // 6 on pages with nothing to give, called them failures, and they
        // became two thirds of the 3-streak that aborted the lane. A lane is
        // not broken because the wiki has nothing to add for a 1990 oddball.
        if (/nothing new to add/.test(String(said || ""))) {
          const e = new Error(`bcp page has a base set but no parallel ladder — the wiki carries no rungs for it`);
          // #1717's flag, and deliberately the SAME one: "the source answered,
          // and its answer is that it has nothing here" is ONE concept, and it
          // earns one status and one exclusion from the streak whether the
          // source is tcgdex or the wiki.
          e.emptyAtSource = true;
          throw e;
        }
        throw new Error("bcp scrape produced no CSV");
      }
      return { csvPaths: stagedCsvs(dir) };
    }
    case "beckett": {
      // sourceRef is the workbook itself, so the archive walk is skipped
      // entirely and the converter runs against the downloaded xlsx.
      const xlsxPath = path.join(dir, `${stem}.xlsx`);
      const bin = execFileSync(process.execPath, ["-e", `
        const https=require("node:https"),fs=require("node:fs");
        https.get(process.argv[1],{headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"}},(r)=>{
          if(r.statusCode!==200){console.error("HTTP "+r.statusCode);process.exit(9);}
          const c=[];r.on("data",(d)=>c.push(d));r.on("end",()=>{fs.writeFileSync(process.argv[2],Buffer.concat(c));console.log("ok");});
        }).on("error",(e)=>{console.error(e.message);process.exit(9);});
      `, entry.sourceRef, xlsxPath], { encoding: "utf8", timeout: 5 * 60000 });
      if (!fs.existsSync(xlsxPath) || fs.statSync(xlsxPath).size < 2000) throw new Error("workbook empty or unreachable");
      run("convertBeckettChecklistXlsx.cjs", [
        "--xlsx", xlsxPath, "--year", String(entry.year || ""),
        "--set-key", setKeyFor(entry) || "",
        "--set-name", String(entry.setName || ""),
        "--sport", String(entry.sport || "baseball"),
        "--out", csvPath, "--source-url", entry.sourceRef,
      ]);
      fs.rmSync(xlsxPath, { force: true });
      return { csvPaths: [csvPath] };
    }
    case "clc": {
      // Both CLC scripts are driven by a work-list JSON, not by a URL argument,
      // and the committed list holds 547 of the 2,367 pages the sitemap serves.
      // CLC_LIST hands them a one-product list built from this entry, so the
      // fetch and the parse stay theirs and only the work list is ours.
      const slug = entry.sourceRef.replace(/^https?:\/\/[^/]+\//, "").replace(/\/$/, "");
      const listPath = path.join(dir, "clc-list.json");
      fs.writeFileSync(listPath, JSON.stringify({
        products: [{
          url: entry.sourceRef, sourceSlug: slug,
          productName: entry.setName || slug, year: entry.year, sport: entry.sport || "baseball",
        }],
      }));
      const pagesDir = path.join(dir, "pages");
      run("scrape-checklistcenter-products.cjs", [`--outDir=${pagesDir}`, "--delayMs=800"], { CLC_LIST: listPath });
      run("convertChecklistCenterToChecklistCsv.cjs", [`--pagesDir=${pagesDir}`, `--outDir=${dir}`], { CLC_LIST: listPath });
      const csvs = fs.readdirSync(dir).filter((n) => n.endsWith(".csv"));
      if (!csvs.length) throw new Error("clc converter produced no CSV (page fetched but refused, or no page served)");
      return { csvPaths: stagedCsvs(dir) };
    }
    case "tcgdexja": {
      const setId = entry.sourceRef.split("/").pop();
      // CF-JA-MODERN-PARALLEL-LADDER (gap doc 2026-09-03, recommendation 5).
      // The vintage scraper stages BASE-ONLY -- every row `parallel=""` -- and a
      // base-only checklist does not unblock the comps behind these cells, which
      // are waiting on the parallel axis. For the modern codes (SV*, S*, M*, CS*)
      // the JA rarity ladder IS that axis, so those sets route to the scraper
      // that carries it. The vintage PMCG/neo titles keep the original lane:
      // tcgdex serves them no rarity ladder, so pointing them at the modern
      // scraper would change nothing but the provenance string.
      const modern = tcgdexModern(entry);
      const script = modern ? "scrape-tcgdex-ja-modern.cjs" : "scrape-tcgdex-ja.cjs";
      const said = run(script, [`--outDir=${dir}`, `--sets=${setId}`, "--delayMs=150"]);
      const csvs = fs.readdirSync(dir).filter((n) => n.endsWith(".csv"));
      if (!csvs.length) {
        /**
         * CF-A-SET-THE-SOURCE-DOES-NOT-CARD-IS-NOT-A-BROKEN-LANE (2026-09-04).
         *
         * Run 33845979897 took XY2, XY3, XY4 and reported all three "FAILED --
         * tcgdex produced no CSV", tripping the 3-streak and leaving 49 entries
         * -- including all 52 staged modern sets -- unattempted.
         *
         * None of the three is a defect. Probed live: every one answers HTTP 200
         * with its right name and a populated `cardCount.total`, and `cards: []`.
         * tcgdex simply holds no per-card rows for the XY-era Japanese sets. The
         * scraper reads that correctly -- `!d.cards.length` -> skippedSets++,
         * continue -- writes nothing, and exits 0. The DRIVER then read "no CSV"
         * as a failure.
         *
         * Measured over the whole lane: 32 of the 97 vintage entries answer with
         * an empty `cards` array. A refusal the source itself states is a VERDICT
         * about that set, not evidence the lane is down, so it gets its own
         * status and is excluded from the systemic streak (see EMPTY_STATUS).
         */
        const setsSkipped = /sets skipped\s+([1-9])/.test(String(said ?? ""));
        const stagedNone = /sets staged\s+0(?!\d)/.test(String(said ?? ""));
        if (setsSkipped && stagedNone) {
          const err = new Error(`tcgdex serves no cards for this set (${script}, set ${setId}) — the source's own answer, not a lane failure`);
          err.emptyAtSource = true;
          throw err;
        }
        throw new Error(`tcgdex produced no CSV (${script}, set ${setId})`);
      }
      return { csvPaths: stagedCsvs(dir) };
    }
    default:
      throw new Error(`no acquisition machinery for lane ${entry.lane}`);
  }
}

/**
 * CF-A-LANE-THAT-RETURNS-THE-WRONG-SHAPE-IS-A-REFUSAL (2026-09-04).
 *
 * Run 33848115955 (sportscardchecklist, apply=true, limit=3) failed all three
 * entries with
 *
 *     FAILED — The "path" argument must be of type string. Received undefined
 *
 * and then tripped the 3-streak systemic abort. The report run for the very
 * same three, 33847474466, was clean, because report mode never calls this
 * function at all.
 *
 * The cause was one character. #1710 wrote the lane's return as
 *
 *     return { csvPath };          // singular
 *
 * while the caller -- and every one of the other six lanes -- speaks csvPathS:
 *
 *     const { csvPaths } = acquireEntry(entry, dir);
 *
 * So csvPaths was `undefined`, gateStagedEntry's `Array.isArray(x) ? x : [x]`
 * faithfully wrapped it into `[undefined]`, and gateStagedCsv handed `undefined`
 * to fs.readFileSync. The CSV was fetched and staged correctly; nothing was
 * wrong with the acquisition. A one-character key mismatch cost a whole lane.
 *
 * The lesson is not "spell it right" -- it is that the contract between a lane
 * branch and its caller was never stated anywhere, so a wrong shape read as a
 * legitimately-empty one. It is stated here now, and it is CHECKED. A lane that
 * returns anything but `{ csvPaths: [string, ...] }` is a defect in this file,
 * so it says so by name rather than surfacing as an undefined path five frames
 * down in an unrelated gate.
 */
function acquireStaged(entry, dir) {
  const got = acquireEntry(entry, dir);
  const paths = got && got.csvPaths;
  if (!Array.isArray(paths)) {
    const keys = got && typeof got === "object" ? Object.keys(got).join(", ") : String(got);
    throw new Error(
      `lane ${entry.lane} returned no csvPaths array (got keys: ${keys || "(none)"}) — ` +
      `every lane must return { csvPaths: [<file>, ...] }`,
    );
  }
  const bad = paths.findIndex((p) => typeof p !== "string" || !p);
  if (bad !== -1) {
    throw new Error(`lane ${entry.lane} returned a non-string staged path at index ${bad} — every lane must return { csvPaths: [<file>, ...] }`);
  }
  return paths;
}

// ── Cosmos: the control docs and the verify-by-read ──────────────────────────

let db = null;
function cosmos() {
  if (db) return db;
  const { CosmosClient } = require("@azure/cosmos");
  db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING).database(process.env.COSMOS_DATABASE || "hobbyiq");
  return db;
}

/**
 * CF-A-URL-IS-NOT-A-COSMOS-ID (2026-09-04).
 *
 * The manifest's entry.id embeds the whole sourceRef -- "bcp::http://www.
 * baseballcardpedia.com/index.php/1990_Baseball_Wit" -- so the control id it
 * produced carried slashes, and the SDK rejects those CLIENT-SIDE:
 * "Illegal characters ['/', '\', '#'] cannot be used in Resource ID".
 *
 * That throw came from writeControl, which sits AFTER the per-entry try/catch,
 * so it escaped to the outer handler and killed the lane on entry 1 with exit
 * 3. Measured on the manifest: ALL 7,755 entries across ALL SIX lanes produce
 * an illegal id, so no generation of this driver has ever written a verdict in
 * APPLY mode -- run 33837346045 is simply the first that reached the line.
 *
 * The id is an ADDRESS, not the record: the readable fields (entryId, lane,
 * sourceRef) all stay on the doc verbatim. So the illegal characters are
 * ESCAPED rather than stripped -- two entries differing only where a slash sat
 * must not fold onto one doc. `~` is escaped first, so the mapping is
 * injective by construction.
 */
const COSMOS_ID_ESCAPES = [[/~/g, "~t"], [/\//g, "~s"], [/\\/g, "~b"], [/#/g, "~h"], [/\?/g, "~q"]];
function cosmosSafeId(raw) {
  let v = String(raw ?? "");
  for (const [re, to] of COSMOS_ID_ESCAPES) v = v.replace(re, to);
  return v;
}
const controlId = (entryId) => cosmosSafeId(`ingest_universe::${entryId}`);

async function readControl(entryId) {
  const id = controlId(entryId);
  try {
    const { resource } = await cosmos().container(CONTROL_CONTAINER).item(id, id).read();
    return resource || null;
  } catch (e) { if (e.code === 404) return null; throw e; }
}

async function writeControl(entry, verdict) {
  const id = controlId(entry.id);
  const doc = {
    id,
    docType: "ingest_universe_status",
    entryId: entry.id,
    lane: entry.lane,
    sourceRef: entry.sourceRef,
    sport: entry.sport, year: entry.year, setName: entry.setName,
    status: verdict.status,
    reason: verdict.reason || null,
    rowsCreated: verdict.rowsCreated ?? null,
    rowsInCatalog: verdict.rowsInCatalog ?? null,
    stagedStats: verdict.stats || null,
    lastAttempt: new Date().toISOString(),
    attempts: (verdict.priorAttempts || 0) + 1,
  };
  await cosmos().container(CONTROL_CONTAINER).items.upsert(doc);
  return doc;
}

/**
 * The catalog's setKey for an entry's set name.
 *
 * A set name is "1952 Topps Baseball" and the catalog key is `topps`: the YEAR
 * is its own column and the SPORT is its own column, so carrying either in the
 * key mints a second product beside the real one. Measured on the dry run --
 * `topps-baseball` counted 0 rows against the 6,115 the catalog actually holds
 * under `topps`, which would have marked a healthy ingest `failed`.
 *
 * Season spans ("2023-24 Upper Deck") lose the span the same way, for the same
 * reason. Anything left empty returns null and the caller REFUSES to verify
 * rather than guessing -- an unverifiable entry is a failed entry, never an
 * assumed-good one.
 */
const SPORT_SUFFIX = /-(baseball|football|basketball|hockey|soccer|pokemon|wrestling|racing|golf|tcg)$/;
function setKeyFor(entry) {
  // POKEMON MATCHES ON THE SET ID, and year is not part of that identity. A
  // ja-exclusive set's name is Japanese ("PMCG1 拡張パック"), which slugifies to
  // nothing at all -- so deriving a key from the name would leave every tcgdexja
  // entry unverifiable and a clean ingest would be recorded `failed`. The set id
  // IS the vocabulary the catalog keys pokemon on (sv3-obsidian-flames), and it
  // is what the sourceRef carries.
  if (entry.lane === "tcgdexja") {
    const id = String(entry.sourceRef || "").split("/").pop();
    return id ? id.toLowerCase() : null;
  }
  let k = slugOf(entry.setName || "");
  k = k.replace(/^(?:19|20)\d{2}(?:-\d{2})?-/, "");
  // ORDER MATTERS. The CLC page titles end "...Baseball Card Checklist", so the
  // sport is only trailing once the checklist words are gone. Stripping the
  // sport first leaves `bowman-baseball` -- a key the catalog does not use.
  // Both are stripped repeatedly until neither applies.
  for (let i = 0; i < 4; i++) {
    const before = k;
    k = k.replace(/-(?:card-)?checklist$/, "");
    k = k.replace(SPORT_SUFFIX, "");
    if (k === before) break;
  }
  return k || null;
}

/** Count catalog rows for this entry's product. The verification is a READ of
 *  what actually landed, never the ingest's own claim -- a green ingest that
 *  wrote nothing is the exact failure this reconciles against. */
async function countCatalogRows(entry) {
  const setKey = setKeyFor(entry);
  if (!setKey) return null;
  // Pokemon identity is the setKey alone -- year is NOT part of it, and gating
  // on year here read as a false zero for every tcgdex set. Every other lane
  // needs the year, because `topps` without one spans eighty products.
  const byKeyOnly = entry.lane === "tcgdexja";
  if (!byKeyOnly && !entry.year) return null;
  const q = byKeyOnly
    ? { query: "SELECT VALUE COUNT(1) FROM c WHERE c.setKey = @k", parameters: [{ name: "@k", value: setKey }] }
    : {
        query: "SELECT VALUE COUNT(1) FROM c WHERE c.year = @y AND c.setKey = @k",
        parameters: [{ name: "@y", value: Number(entry.year) }, { name: "@k", value: setKey }],
      };
  const { resources } = await cosmos().container("card_catalog").items.query(q, { maxItemCount: 1 }).fetchAll();
  return resources[0] ?? 0;
}

/**
 * CF-A-CANARY-SHOULD-HIT-THE-CARDS-THAT-SELL (2026-09-04).
 *
 * The queue was manifest order, which is year-then-name -- so a LIMIT=20 canary
 * on YEARS=1990..2026 spent all twenty entries in 1990, starting at "Baseball
 * Wit": an oddball with no parallel ladder and, per the 2026-09-03 probe, no
 * autograph section either, because certified autos are a 1990s-ONWARD feature
 * and 1990 is the boundary year itself. Twenty pages of the least valuable end
 * of the lane prove nothing about a re-scrape whose whole purpose is autographs.
 *
 * ORDER BY VALUE. Two mechanisms, in priority order:
 *
 *   1. AN EXPLICIT LIST WINS. `titles` is an EXISTING runner input, exported as
 *      BCP_TITLES, and naming the exact pages is both the cheapest ranking and
 *      the most honest one -- the operator states the order and the banner
 *      prints it back. Entries match on page title, set name, "<year> <name>"
 *      or sourceRef, so the same list works whichever the operator has to hand.
 *      Named entries lead, in the order given; the rest follow beneath, so a
 *      LIMIT larger than the list still runs a full budget.
 *
 *   2. OTHERWISE, AN INTRINSIC PROXY, NOT A COSMOS READ. Ranking by real pool
 *      rows would need a sold_comps aggregate per (year, setKey) across 2,637
 *      entries -- a cross-partition GROUP BY over a 16M-row container, spent on
 *      the driver's own budget before it acquires anything. That cost is the
 *      whole reason mechanism 1 exists. What the manifest ALREADY holds is
 *      enough to sort the HEAD of the list correctly: the flagship chrome and
 *      prospect products carry the auto ladders and the liquid cards, and the
 *      probe measured autograph yield rising by decade. So the proxy is
 *      product family + era, computed from fields already in hand, at zero RU.
 *
 * This is a PROXY and says so. It decides which twenty a canary sees; it is not
 * a claim about any card's price, and nothing downstream reads it. When the
 * ranking matters more than its cost, pass the list.
 */
const VALUE_FAMILIES = [
  [/\btopps chrome\b/i, 98],
  [/\bbowman chrome\b/i, 96],
  [/\bbowman'?s best\b/i, 88],
  [/\bbowman\b/i, 84],
  [/\bprizm\b/i, 80],
  [/\bfinest\b/i, 78],
  [/\boptic\b/i, 74],
  [/\btopps\b/i, 72],
  [/\bselect\b/i, 68],
  [/\bsp authentic\b|\bupper deck\b/i, 60],
  [/\bleaf\b|\bdonruss\b|\bfleer\b|\bscore\b|\bpanini\b/i, 50],
];
function valueRank(entry) {
  const name = String(entry.setName || "");
  let family = 10;
  for (const [re, w] of VALUE_FAMILIES) if (re.test(name)) family = Math.max(family, w);
  // The autograph-yield gradient the 2026-09-03 probe measured: 0% pre-1990,
  // then rising by decade. Bounded so era NUDGES the family order rather than
  // replacing it -- a 2024 oddball must not outrank 2011 Topps Chrome.
  const y = Number(entry.year) || 0;
  const era = y >= 2010 ? 20 : y >= 2000 ? 14 : y >= 1990 ? 6 : 0;
  // A seeded partial is a page we already hold rows for, so a re-scrape gains
  // the delta rather than a first fill -- which is exactly what a recheck is.
  const seeded = entry.seededStatus === "partial" ? 4 : 0;
  // THE FLAGSHIP OUTRANKS ITS SPECIALIZATIONS (memory: product-family ladder).
  // Family alone put "2020 Topps Chrome Ben Baller Edition" and "Bowman Chrome
  // Mini" above 2011 Topps Chrome itself -- they match the same family regex and
  // sit in a later era. But the flagship is the product that carries the pool:
  // the base rookie, the auto ladder, the sales. A specialization is a narrow
  // side product with a fraction of the rows. The test is the page name itself:
  // a name that IS the family, with nothing trailing, is the flagship.
  const bare = name.replace(/^(?:19|20)\d{2}(?:-\d{2})?\s+/, "").trim();
  const flagship = VALUE_FAMILIES.some(([re]) => { const m = bare.match(re); return m && m[0].length >= bare.length - 1; }) ? 30 : 0;
  return family + era + seeded + flagship;
}

/**
 * CF-A-STAGED-CSV-LEADS-ITS-LANE (2026-09-04).
 *
 * Run 33845979897's queue put 2014 XY2/XY3/XY4 first and the 52 modern JA sets
 * that #1702 had ALREADY STAGED -- CSVs and manifests committed to the repo --
 * behind them. The proxy is not wrong about value; it simply cannot see the
 * work already done. Both groups score family 10 + era 20; the vintage XY rows
 * carry `seededStatus: "partial"` for its +4 and the staged modern sets are
 * seeded `missing`, so the entries with a checklist in hand sorted LAST.
 *
 * That cost the whole run: the three vintage sets ahead of them are empty at
 * tcgdex, the lane aborted on the streak, and none of the 52 was attempted.
 *
 * An entry whose checklist is already on disk is the cheapest and surest work
 * in the lane -- no fetch, no source outage, no rate limit between us and the
 * rows. So it leads, ahead of the value proxy, and the ordering says so in the
 * banner. Keyed by the staged manifest's own `sourceUrl`, which is the address
 * the universe entry was built from, so no name normalization can drift.
 */
const CHECKLIST_DIR = path.join(HERE, "..", "data", "checklists");
let _stagedIndex = null;
function stagedSourceRefs() {
  if (_stagedIndex) return _stagedIndex;
  const refs = new Set();
  const walk = (dir) => {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { walk(full); continue; }
      if (!d.name.endsWith(".manifest.json")) continue;
      // A manifest with no CSV beside it is not staged work.
      if (!fs.existsSync(full.replace(/\.manifest\.json$/, ".csv"))) continue;
      try {
        const m = JSON.parse(fs.readFileSync(full, "utf8"));
        if (m && m.sourceUrl) refs.add(String(m.sourceUrl));
      } catch { /* an unreadable manifest simply stages nothing */ }
    }
  };
  walk(CHECKLIST_DIR);
  _stagedIndex = refs;
  return refs;
}

/** True when this entry's checklist is already staged on disk. */
function isStaged(entry) {
  return stagedSourceRefs().has(String(entry?.sourceRef || ""));
}

/**
 * Order the eligible queue. `titlesRaw` is the operator's explicit list (the
 * existing `titles` input / BCP_TITLES env); empty means use the proxy.
 *
 * Returns { queue, mode, named, unmatched }. `unmatched` is REPORTED, never
 * silently dropped: a mistyped title that quietly ranked nothing would leave
 * the canary back on alphabetical order while the banner claimed otherwise,
 * which is the exact failure this ordering exists to prevent.
 */
function orderQueue(queue, titlesRaw) {
  const wanted = String(titlesRaw || "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!wanted.length) {
    // Stable: equal rank keeps manifest order, so a re-dispatch takes the same
    // twenty rather than a fresh shuffle of a tie. STAGED FIRST, then the value
    // proxy within each group -- work already on disk cannot be lost to a
    // source outage, so it never queues behind work that can.
    const decorated = queue.map((q, i) => ({ q, i, s: isStaged(q.entry) ? 1 : 0, r: valueRank(q.entry) }));
    decorated.sort((a, b) => (b.s - a.s) || (b.r - a.r) || (a.i - b.i));
    const staged = decorated.filter((d) => d.s).length;
    return {
      queue: decorated.map((d) => d.q),
      mode: staged
        ? `staged-first (${staged} with a checklist on disk), then value-proxy (product family + era)`
        : "value-proxy (product family + era)",
      named: 0,
      unmatched: [],
      staged,
    };
  }
  const norm = (v) => String(v || "").toLowerCase().replace(/[_\s]+/g, " ").replace(/[^a-z0-9 ]+/g, "").trim();
  const keysOf = (e) => {
    const title = decodeURIComponent(String(e.sourceRef || "").split("/index.php/")[1] || "");
    return new Set([norm(title), norm(e.setName), norm(`${e.year} ${e.setName}`), norm(e.sourceRef)].filter(Boolean));
  };
  const lead = [], rest = [...queue], unmatched = [];
  for (const w of wanted) {
    const nw = norm(w);
    const at = rest.findIndex((q) => keysOf(q.entry).has(nw));
    if (at < 0) { unmatched.push(w); continue; }
    lead.push(rest.splice(at, 1)[0]);
  }
  return { queue: [...lead, ...rest], mode: "explicit list (titles / BCP_TITLES)", named: lead.length, unmatched, staged: 0 };
}


// ── main ────────────────────────────────────────────────────────────────────

// The gate is exported so its rules can be asserted directly against fixture
// CSVs, rather than only through a full acquisition. `require`d as a module the
// script does nothing; run as a CLI it drives.

// EVERY LANE acquireEntry CAN DISPATCH MUST HAVE A PLAN, checked at load rather
// than on the first dispatch of a new lane. This is the half that a shared
// function alone does not buy: planFor and acquireEntry could still drift apart
// by one of them gaining a lane the other never heard of, and the report would
// print "would drive: undefined" -- which is precisely the silent shape that
// let the sportscardchecklist apply path ship untested.
for (const lane of ACQUIRE_LANES) {
  if (!planFor({ lane, sourceRef: "" })) {
    throw new Error(`lane ${lane} is dispatchable by acquireEntry but planFor cannot describe it — report mode would print "would drive: undefined"`);
  }
}

module.exports = { gateStagedCsv, gateStagedEntry, stagedCsvs, sourceLabelFor, splitCsv, isPersonName, setKeyFor, planFor, tcgdexModern, acquireStaged, ACQUIRE_LANES, LANE_ALIASES, LANE_SOURCE, LANE_MINUTES, CANONICAL_HEADER, CHILD_STDERR_LINES, cosmosSafeId, controlId, orderQueue, SYSTEMIC_FAILURE_STREAK, EMPTY_STATUS, STREAK_STATUSES, isStaged, stagedSourceRefs };
if (require.main !== module) return;

(async () => {
  // REFUSALS BEFORE REQUIRES.
  const rawSource = String(process.env.SOURCES || "").trim().toLowerCase();
  if (!rawSource) {
    console.error("REFUSE: SOURCES is required and has no default — name exactly one lane:");
    console.error("        hobbymonitor | insider | bcp | beckett | clc | tcgdexja | sportscardchecklist  (tcdb is refused, see below)");
    process.exit(2);
  }
  if (rawSource.includes(",")) {
    console.error(`REFUSE: SOURCES names one lane per dispatch (got "${rawSource}") — dispatch once per lane so each has its own budget and its own reconciliation`);
    process.exit(2);
  }
  const lane = LANE_ALIASES[rawSource];
  if (!lane) {
    console.error(`REFUSE: unknown lane "${rawSource}" — known: ${Object.keys(LANE_ALIASES).join(", ")}`);
    process.exit(2);
  }
  if (lane === "tcdb") {
    console.error("REFUSE: tcdb has no enumerable universe and no manifest entries.");
    console.error("        D37 measured scrape-tcdb.cjs extracting 0 rows and exiting 0 on a 403 block, writing");
    console.error("        an empty CSV and a manifest naming the set \"Trading Card Database\" (the block page's");
    console.error("        title). It stays a per-URL backup, and it needs a refusal-on-zero-rows guard of its");
    console.error("        own before any driver trusts it. Driving it here would record fabricated successes.");
    process.exit(2);
  }
  // REFUSE THE UNSTAMPABLE LANE UP FRONT. The ingest child checks the source
  // name it is handed and exits 2, which is correct -- but it does so per
  // ENTRY, after a fetch, so a lane whose name the authority vocabulary does
  // not know burns a fetch and a verdict per entry until the systemic tripwire
  // stops it. That is exactly what run 33839532087 spent its budget on. The
  // name is knowable before the first fetch, so it is checked before the first
  // fetch, and the refusal names the file the declaration lives in.
  {
    let label;
    try { label = sourceLabelFor(lane); }
    catch { console.error(`REFUSE: no checklist source name declared for lane "${lane}" — add it to LANE_SOURCE`); process.exit(2); }
    let authorityOf = null;
    try { ({ catalogAuthorityOf: authorityOf } = require(path.join(HERE, "..", "dist/services/catalog/catalogAuthority.service.js"))); }
    catch { /* dist not built (a unit-test run); the child re-checks anyway */ }
    if (authorityOf && authorityOf(label) !== "checklist") {
      console.error(`REFUSE: lane "${lane}" would stamp source="${label}", which catalogAuthority classifies as ${authorityOf(label)}, not checklist.`);
      console.error(`        Rows written under it rank BELOW the derived rows this ingest exists to correct, so`);
      console.error(`        ingest-checklist-csv-to-catalog.cjs refuses them one entry at a time, after the fetch.`);
      console.error(`        Fix LANE_SOURCE here, or declare the name in catalogAuthority.service.ts.`);
      process.exit(2);
    }
  }
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("REFUSE: COSMOS_CONNECTION_STRING not set"); process.exit(2); }
  if (!fs.existsSync(MANIFEST_PATH)) { console.error(`REFUSE: manifest not found at ${MANIFEST_PATH}`); process.exit(2); }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const years = String(process.env.YEARS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const sports = String(process.env.SPORTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  let candidates = manifest.entries.filter((e) => e.lane === lane);
  const laneTotal = candidates.length;
  if (years.length) candidates = candidates.filter((e) => years.includes(String(e.year)));
  if (sports.length) candidates = candidates.filter((e) => sports.includes(String(e.sport || "").toLowerCase()));

  /**
   * CF-A-404-BELONGS-TO-THE-HOST-THAT-SERVED-IT (2026-09-04).
   *
   * The unreachable list travels with the manifest so a run never spends its
   * budget re-probing what a direct 404 already settled. But the mark was keyed
   * `sport|year|setKey` -- the SET, with no lane and no sourceRef in it -- so it
   * settled the set everywhere, on every host, forever.
   *
   * Run 33841276495 is what that costs. `football|1972|topps` is on the list
   * because the lanes that existed when it was probed could not serve it. #1710
   * then added sportscardchecklist, whose sitemap survey fetched that very set
   * (set-11959, 351 cards) without trouble, and the manifest RECORDS this:
   *
   *   nowCoveredBy: "sportscardchecklist"
   *   note: "...the mark records that the ORIGINAL lane could not reach it"
   *
   * The driver read neither field. It matched the set key, printed
   * "UNREACHABLE — direct 404 probe, no lane serves it", and skipped an entry
   * seeded `missing` that a working lane was standing right there to fetch. 7
   * of the 8 marks carry nowCoveredBy, so the new lane was inheriting almost
   * the whole list as permanent refusals.
   *
   * A 404 is a fact about a URL, so the mark is keyed by the lane whose
   * sourceRef earned it. A record naming the lane it belongs to binds only that
   * lane; `nowCoveredBy` releases the lane that has since been proven to serve
   * it; and a legacy record naming neither keeps its old set-wide reach for the
   * lanes that existed when it was written, which is the only reading under
   * which it was ever true.
   */
  const unreachableMarks = (manifest.unreachable || []).map((u) => ({
    key: `${u.sport}|${u.year}|${u.setKey}`,
    lane: u.lane || null,
    sourceRef: u.sourceRef || null,
    nowCoveredBy: u.nowCoveredBy || null,
  }));
  const isUnreachable = (entry) => {
    const key = `${entry.sport}|${entry.year}|${setKeyFor(entry) || ""}`;
    return unreachableMarks.some((m) => {
      if (m.key !== key) return false;
      // Proven reachable HERE since the probe: the mark is history, not a veto.
      if (m.nowCoveredBy && m.nowCoveredBy === entry.lane) return false;
      // A mark that names its own address binds that address only.
      if (m.sourceRef) return m.sourceRef === entry.sourceRef;
      if (m.lane) return m.lane === entry.lane;
      return true;
    });
  };

  const perEntryMin = LANE_MINUTES[lane] || 1.5;
  const budgetSized = Math.max(1, Math.floor((RUN_MS / 60000) * 0.85 / perEntryMin));
  const LIMIT = Number(process.env.LIMIT || 0) || budgetSized;

  console.log(`── ingest-universe-driver ──`);
  console.log(`  lane          ${lane}${rawSource !== lane ? ` (dispatched as "${rawSource}")` : ""}`);
  console.log(`  manifest      ${path.relative(process.cwd(), MANIFEST_PATH)}  (${f(manifest.entries.length)} entries, ${f(laneTotal)} in this lane)`);
  console.log(`  scope         years=${years.join(",") || "(all)"}  sports=${sports.join(",") || "(all)"}  ${RECHECK ? "RECHECK (re-attempt verdicted entries)" : "pending only"}`);
  console.log(`  budget        ${RUN_MS / 60000}m  →  N=${f(LIMIT)} entries @ ~${perEntryMin}m each`);
  console.log(`  mode          ${APPLY ? "APPLY" : "REPORT ONLY (no acquisition, no writes)"}\n`);

  // Read the existing verdicts so a relaunch continues rather than re-doing the
  // head of the list forever.
  const priorById = new Map();
  {
    const { resources } = await cosmos().container(CONTROL_CONTAINER).items.query({
      query: "SELECT c.entryId, c.status, c.attempts FROM c WHERE c.docType = 'ingest_universe_status' AND c.lane = @l",
      parameters: [{ name: "@l", value: lane }],
    }).fetchAll();
    for (const r of resources) priorById.set(r.entryId, r);
  }
  console.log(`  control docs  ${f(priorById.size)} already carry a verdict for this lane\n`);

  // `empty` is terminal too: re-fetching a set the source does not card burns
  // a request and a verdict per run to learn the same thing. SCOPE=recheck is
  // the way back once tcgdex grows the cards.
  const TERMINAL = new Set(["ingested", "unreachable", EMPTY_STATUS]);
  const queue = [];
  for (const e of candidates) {
    const prior = priorById.get(e.id);
    if (prior && !RECHECK && TERMINAL.has(prior.status)) continue;
    if (prior && !RECHECK && prior.status === "failed" && (prior.attempts || 0) >= 3) continue;
    queue.push({ entry: e, prior });
  }

  // ORDER BEFORE TAKING. The slice below is the run; ordering after it would
  // only shuffle the twenty already chosen by alphabet.
  const ordering = orderQueue(queue, process.env.BCP_TITLES || process.env.TITLES || "");
  queue.length = 0; queue.push(...ordering.queue);
  console.log(`  order         ${ordering.mode}${ordering.named ? `  —  ${f(ordering.named)} named entries lead` : ""}`);
  if (ordering.unmatched.length) {
    console.log(`  UNMATCHED     ${ordering.unmatched.length} title(s) in the list matched no entry of this lane and ranked NOTHING:`);
    for (const u of ordering.unmatched.slice(0, 10)) console.log(`                  "${u}"`);
    console.log(`                (check the page title against the manifest sourceRef; the run continues on the rest)`);
  }
  console.log(`  ${f(queue.length)} entries eligible; taking up to ${f(LIMIT)}`);
  for (const q of queue.slice(0, Math.min(LIMIT, 5))) console.log(`                  → ${q.entry.year} ${q.entry.setName}`);
  console.log("");

  // RECONCILIATION: intended is fixed BEFORE the loop and every entry lands in
  // exactly one bucket, counted directly. A remainder derived by subtraction
  // balances by construction and can never disagree with itself.
  const take = queue.slice(0, LIMIT);
  const intended = take.length;
  const verdicts = { ingested: 0, partial: 0, failed: 0, unreachable: 0, [EMPTY_STATUS]: 0 };
  let notReached = 0, rowsCreatedTotal = 0;
  // Report mode reconciles against what it INSPECTED. Counting a dry run's
  // deliberate zero writes as a shortfall reports a false imbalance and, worse,
  // exits non-zero -- which would stop the very relaunch that is working.
  let inspected = 0;
  const perEntry = [];
  let stoppedOnBudget = false;
  // The systemic-failure tripwire's state. A refusal is a per-entry verdict; a
  // STREAK of them is the lane. See CF-A-REFUSED-ENTRY-IS-NOT-A-BROKEN-LANE.
  let consecutiveFailures = 0, controlWriteFailures = 0, systemicAbort = null;

  for (let i = 0; i < take.length; i++) {
    const { entry, prior } = take[i];
    if (left() < perEntryMin * 60000 * 1.5) { notReached = take.length - i; stoppedOnBudget = true; break; }

    const label = `${entry.lane}/${entry.setName || entry.sourceRef}`;
    if (isUnreachable(entry)) {
      verdicts.unreachable++;
      perEntry.push({ id: entry.id, label, status: "unreachable", reason: "on the manifest's probed-404 list", rowsCreated: 0 });
      if (APPLY) await writeControl(entry, { status: "unreachable", reason: "on the manifest's probed-404 list", rowsCreated: 0, priorAttempts: prior?.attempts });
      console.log(`  [${i + 1}/${take.length}] ${label}\n      UNREACHABLE — direct 404 probe, no lane serves it`);
      continue;
    }

    console.log(`  [${i + 1}/${take.length}] ${label}`);
    console.log(`      ${entry.sourceRef}`);

    if (!APPLY) {
      // REPORT ONLY: name the exact machinery this entry would drive, and the
      // gates it would face, without a fetch or a write.
      //
      // planFor is the SAME function the apply path is pinned to (see
      // CF-THE-PLAN-AND-THE-APPLY-ARE-ONE-FUNCTION). A report that describes a
      // pipe the apply does not run is worse than no report at all: it was
      // believed as a rehearsal on 2026-09-04 and the apply threw on every
      // entry it had just called clean.
      const plan = planFor(entry);
      const inCatalog = await countCatalogRows(entry).catch(() => null);
      console.log(`      would drive: ${plan}`);
      console.log(`      gates: canonical header · zero-base-cards (per ENTRY, across every staged scope file) · players-as-parallels · card-line-as-rung · cross-join arithmetic`);
      console.log(`      would stamp source: ${sourceLabelFor(lane)}`);
      console.log(`      catalog now: ${inCatalog === null ? "(setKey/year not derivable — verify would refuse)" : f(inCatalog) + " rows"}   seeded=${entry.seededStatus}   prior=${prior?.status || "(none)"}`);
      perEntry.push({ id: entry.id, label, status: "would-attempt", reason: null, rowsInCatalog: inCatalog, seeded: entry.seededStatus });
      inspected++;
      continue;
    }

    const dir = path.join(WORKDIR, lane, slugOf(entry.id).slice(0, 60));
    let verdict;
    try {
      const before = await countCatalogRows(entry);
      const csvPaths = acquireStaged(entry, dir);

      // GATE BEFORE INGEST. A staged file that violates doctrine is refused as
      // a whole entry -- never a dirty ingest, and never a silent skip.
      const gate = gateStagedEntry(csvPaths);
      if (csvPaths.length > 1) {
        console.log(`      ${f(csvPaths.length)} staged scope files: ${csvPaths.map((p) => path.basename(p)).join(", ")}`);
      }
      if (!gate.ok) {
        verdict = { status: "failed", reason: `cleanliness gate: ${gate.reason}`, rowsCreated: 0, stats: gate.stats };
        console.log(`      REFUSED — ${gate.reason}`);
      } else {
        run("ingest-checklist-csv-to-catalog.cjs", [], {
          DIR: dir,
          SOURCE: sourceLabelFor(lane),
          BACKFILL_APPLY: "true",
          RUN_MINUTES: String(Math.max(2, Math.floor(left() / 60000 / 2))),
          CONCURRENCY: process.env.CONCURRENCY || "16",
        }, 20 * 60000);

        // VERIFY BY READ. Not the ingest's claim -- a count from Cosmos.
        const after = await countCatalogRows(entry);
        const created = (after ?? 0) - (before ?? 0);
        rowsCreatedTotal += Math.max(0, created);
        if (after === null) {
          verdict = { status: "failed", reason: "cannot verify by read — setKey/year not derivable for this entry", rowsCreated: 0, stats: gate.stats };
          console.log(`      FAILED — unverifiable`);
        } else if (after === 0) {
          verdict = { status: "failed", reason: "ingest reported success but the catalog holds 0 rows for this product", rowsCreated: 0, rowsInCatalog: 0, stats: gate.stats };
          console.log(`      FAILED — green ingest, 0 rows landed`);
        } else if (gate.stats.ladder === 0 || gate.stats.withPrintRun === 0) {
          // Landed and clean, but incomplete: base-only, or a ladder with no
          // print runs. That is `partial` -- the exact shape D37 counted 1,873
          // + 172 of. Recording it `ingested` would close a gap still open.
          const why = gate.stats.ladder === 0 ? "base-only, no parallel ladder" : "ladder present but zero print runs";
          verdict = { status: "partial", reason: why, rowsCreated: created, rowsInCatalog: after, stats: gate.stats };
          console.log(`      PARTIAL — ${why} (${f(created)} rows created, ${f(after)} in catalog)`);
        } else {
          verdict = { status: "ingested", reason: null, rowsCreated: created, rowsInCatalog: after, stats: gate.stats };
          console.log(`      INGESTED — ${f(created)} rows created, ${f(after)} in catalog, ${f(gate.stats.withPrintRun)} with print runs`);
        }
      }
    } catch (e) {
      // Wide enough for the child's own words. The old 200/140 pair was set
      // when the message was ours; now it carries up to CHILD_STDERR_LINES of
      // the child's stderr, and truncating THAT is the defect this run hit.
      const msg = String(e.message || e).slice(0, 1200);
      // A 404/403 from the source is the source not serving this set -- not a
      // defect in our pipe, and a different verdict from a broken acquisition.
      const isGone = /HTTP 40[34]|ENOTFOUND|exit(ed)? .*code 9|workbook empty or unreachable/i.test(msg);
      // The acquisition itself says when the SOURCE answered "nothing here".
      // That is a verdict about the set, never a symptom of a broken lane.
      const status = e?.emptyAtSource ? EMPTY_STATUS : isGone ? "unreachable" : "failed";
      verdict = { status, reason: `acquisition: ${msg}`, rowsCreated: 0 };
      console.log(`      ${status.toUpperCase()} — ${msg}`);
    }

    verdicts[verdict.status]++;
    perEntry.push({ id: entry.id, label, status: verdict.status, reason: verdict.reason, rowsCreated: verdict.rowsCreated });

    // CF-A-REFUSED-ENTRY-IS-NOT-A-BROKEN-LANE (2026-09-04).
    //
    // writeControl sat OUTSIDE the per-entry try, so a throw here -- the
    // illegal-id one above, a 429, a transient socket -- escaped to the outer
    // handler and exited 3, losing the other 19 entries of the run AND the
    // verdicts already earned. Recording a verdict is per-entry work and it
    // fails per-entry: the write is guarded, the failure is COUNTED, and the
    // lane keeps going. A run whose verdicts are not landing is still a real
    // problem, so it trips the systemic tripwire below rather than being
    // swallowed -- it is just no longer allowed to take the lane down at once.
    try {
      await writeControl(entry, { ...verdict, priorAttempts: prior?.attempts });
    } catch (e) {
      controlWriteFailures++;
      const msg = String(e?.message || e).slice(0, 160);
      console.log(`      CONTROL WRITE FAILED — ${msg}`);
      console.log(`      (the entry's own verdict stands in this run's summary; the control doc did not land)`);
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

    // THE SYSTEMIC TRIPWIRE. One entry the source does not serve is a VERDICT.
    // N in a row is the lane itself being down -- the site blocking us, the
    // network gone, credentials rejected -- and continuing then burns the
    // budget writing `failed` onto entries that are fine, which a later
    // `pending only` run would skip on their attempt count. Consecutive, never
    // cumulative: a lane where every fourth page is genuinely unreachable is a
    // working lane, not a broken one.
    // `empty` neither advances the streak NOR resets it: the source having no
    // cards for this set is no evidence either way about the lane's health, so
    // a genuine outage interrupted by an empty set still trips on its own run.
    if (STREAK_STATUSES.has(verdict.status)) consecutiveFailures++;
    else if (verdict.status !== EMPTY_STATUS) consecutiveFailures = 0;
    if (consecutiveFailures >= SYSTEMIC_FAILURE_STREAK) {
      systemicAbort = `${consecutiveFailures} consecutive entries failed or were unreachable — the lane, not the entries`;
      notReached = take.length - (i + 1);
      console.log(`
  ABORTING THE LANE — ${systemicAbort}`);
      console.log(`  ${f(notReached)} entries of this run were not attempted; the verdicts already written stand.`);
      break;
    }
    if (controlWriteFailures >= SYSTEMIC_FAILURE_STREAK) {
      systemicAbort = `${controlWriteFailures} control-doc writes failed — the verdicts are not landing, so the run cannot resume from them`;
      notReached = take.length - (i + 1);
      console.log(`
  ABORTING THE LANE — ${systemicAbort}`);
      break;
    }
  }

  // ── reconciliation ────────────────────────────────────────────────────────
  // `empty` is a verdict like any other and lands a control doc, so it counts
  // toward `written` -- leaving it out would put a lane of correctly-refused
  // sets straight into RECONCILED NO.
  const written = verdicts.ingested + verdicts.partial + verdicts.failed + verdicts.unreachable + verdicts[EMPTY_STATUS];
  // CF-AN-UNREACHABLE-ENTRY-IS-ACCOUNTED-FOR (2026-09-04).
  //
  // Run 33841276495 (sportscardchecklist, report mode, limit=20) printed
  //
  //   intended 20 / inspected 19 / unreachable 1 / not reached 0
  //   RECONCILED NO — 19 + 0 != 20
  //
  // and exited 4, so the runner refused to relaunch a lane that had done
  // nothing wrong. The entry WAS accounted for -- it was settled from the
  // manifest and printed on its own line one row above the failing sum -- but
  // report mode counted only `inspected`, and an entry settled without a fetch
  // is never inspected. The banner and the arithmetic were reading different
  // columns.
  //
  // APPLY's `written` already sums all four verdict buckets, unreachable
  // included, which is why only report mode ever went red on this. Report mode
  // now says the same thing: every entry the loop DECIDED, by whichever route.
  const accounted = APPLY ? written : inspected + verdicts.unreachable + verdicts[EMPTY_STATUS];
  const spent = Math.round((Date.now() - STARTED) / 60000);
  console.log(`\n── driver complete in ${spent}m ──`);
  console.log(`  lane                ${lane}`);
  console.log(`  intended            ${f(intended)}   (entries this run took)`);
  if (APPLY) {
    console.log(`    ingested          ${f(verdicts.ingested)}`);
    console.log(`    partial           ${f(verdicts.partial)}`);
    console.log(`    failed            ${f(verdicts.failed)}`);
    console.log(`    unreachable       ${f(verdicts.unreachable)}`);
    console.log(`    empty at source   ${f(verdicts[EMPTY_STATUS])}   (the source served no cards; a verdict, not a lane fault)`);
  } else {
    console.log(`    inspected         ${f(inspected)}   (report mode: planned, never fetched)`);
    console.log(`    unreachable       ${f(verdicts.unreachable)}   (settled from the manifest, no fetch needed)`);
  }
  console.log(`    not reached       ${f(notReached)}   (budget stop, counted directly)`);
  console.log(`  written             ${f(APPLY ? written : 0)}   (control docs upserted)`);
  console.log(`  rows created        ${f(rowsCreatedTotal)}   (verified by catalog read, not claimed)`);
  const balanced = accounted + notReached === intended;
  console.log(`  RECONCILED          ${balanced ? "yes" : `NO — ${f(accounted)} + ${f(notReached)} != ${f(intended)}`}`);
  if (controlWriteFailures) console.log(`  control writes lost  ${f(controlWriteFailures)}   (verdict earned, doc did not land)`);
  if (systemicAbort) console.log(`  SYSTEMIC ABORT      ${systemicAbort}`);
  if (!APPLY) console.log(`  (REPORT ONLY — nothing acquired, nothing written)`);

  // CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW. The house reconciliation, which sets
  // process.exitCode itself so a run that dropped its work goes RED rather than
  // green. DISJOINT counters: `written` is the entries that actually landed
  // rows; an entry refused by a gate or unreachable at the source is SKIPPED --
  // deliberately not written, and not loss -- while `failed` is an entry that
  // tried to land and could not. `notReached` is a budget stop, and the
  // relaunch continues from it, so it is skipped rather than unaccounted.
  if (APPLY) {
    const { reportWrites } = require(path.join(HERE, "..", "dist", "services", "ops", "writeReconciliation.js"));
    reportWrites({
      job: "ingest-universe-driver",
      intended,
      written: verdicts.ingested + verdicts.partial,
      // An entry the source does not card is deliberately not written; it is
      // skipped, exactly like an unreachable one -- never counted as loss.
      skipped: verdicts.unreachable + verdicts[EMPTY_STATUS] + notReached,
      failed: verdicts.failed,
    });
  }

  const remaining = queue.length - accounted;
  console.log(`  remaining in lane   ${f(Math.max(0, remaining))}`);
  // CF-A-REPORT-THAT-WALKED-IS-NOT-A-REPORT-THAT-DID-NOTHING (2026-09-04).
  //
  // This marker is the number the runner greps and echoes, and it read
  // `written` -- which counts control docs and is 0 in report mode BY DESIGN.
  // So a report run that walked its whole queue and planned every entry
  // published `entries=0`, indistinguishable from a run that matched nothing
  // and exactly what run 33837346045 preceding report reported. Report mode
  // reconciles against what it INSPECTED, so the marker says that. APPLY is
  // unchanged: `written` is still the control docs upserted.
  //
  // It counts `accounted`, not `inspected`, for the same reason the
  // reconciliation does: an entry settled from the manifest without a fetch is
  // DONE, and a marker that omits it leaves the lane permanently short of draining.
  console.log(`  universe_entries_done=${APPLY ? written : accounted}`);

  // THE BUDGET MARKER. Printed only when entries remain AND this run stopped on
  // its own clock -- the relaunch gates on this line, never on a count, because
  // a count gate loops forever on a lane whose remainder cannot be changed and
  // stops early on a budget stop that happened to change nothing.
  if (systemicAbort) {
    console.log(`  lane aborted — NOT printing the budget marker; a relaunch would meet the same wall. Fix the cause, then re-dispatch.`);
  } else if (remaining > 0 && (stoppedOnBudget || written >= LIMIT)) {
    console.log(`stopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  } else if (remaining > 0) {
    console.log(`  ${f(remaining)} entries remain but this run ended early — inspect the failures before re-dispatching`);
  } else {
    console.log(`  lane complete — nothing left pending`);
  }

  // Set, never exit(): reportWrites has already set process.exitCode on a
  // shortfall, and an exit() here would race its verdict and could mask a
  // reconciliation failure behind this one's success.
  if (!balanced) process.exitCode = 4;
  // A LANE ABORT IS RED, A REFUSED ENTRY IS NOT. The whole point of the change
  // above is that "this page has no ladder" is a verdict the run records and
  // walks past. A systemic abort is the opposite: the lane is down, the
  // remaining entries were never attempted, and a relaunch would repeat it --
  // so it goes red and the marker below is deliberately NOT printed.
  if (systemicAbort) process.exitCode = 5;
})().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
