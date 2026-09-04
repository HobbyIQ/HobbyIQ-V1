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
 *   SOURCES=hobbymonitor|insider|bcp|beckett|tcdb|clc|tcgdexja   REQUIRED
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
  tcdb: "tcdb",
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

  for (const r of rows) {
    if (r.parallel) { stats.ladder++; if (r.printRun) stats.withPrintRun++; }
    else stats.base++;
  }

  // ZERO BASE CARDS. A checklist with a parallel ladder but no base cards is a
  // ladder that has nothing to attach to -- the shape a cross-join leaves when
  // it joins rungs onto a subset that was never parsed. Note this is a floor on
  // BASE rows, not on the blank-parallel reading: a blank parallel means
  // unknown, never "Base", and those rows are still cards.
  if (stats.base === 0) {
    return { ok: false, reason: `zero base cards (${f(stats.rows)} rows, all carry a parallel)`, stats };
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
    if (!byCat.has(c)) byCat.set(c, { pars: new Set(), nums: new Set(), rows: 0 });
    const g = byCat.get(c);
    g.pars.add(r.parallel); g.nums.add(r.cardNumber); g.rows++;
  }
  stats.categories = byCat.size;
  for (const [c, g] of byCat) {
    if (g.pars.size > EXPLODED_PAR_MAX) return { ok: false, reason: `category "${c}" carries ${f(g.pars.size)} distinct parallels (>${EXPLODED_PAR_MAX}) — cross-join`, stats };
    if (g.nums.size > EXPLODED_NUM_MAX) return { ok: false, reason: `category "${c}" carries ${f(g.nums.size)} distinct card numbers (>${EXPLODED_NUM_MAX}) — cross-join`, stats };
    // The multiplicative signature: rows ≈ cards × rungs means every card was
    // paired with every rung rather than the ladder being read per subset.
    if (g.pars.size > 3 && g.nums.size > 20 && g.rows >= g.pars.size * g.nums.size * 0.92) {
      return { ok: false, reason: `category "${c}" is ${f(g.rows)} rows ≈ ${f(g.nums.size)} cards × ${f(g.pars.size)} rungs — cross-join arithmetic`, stats };
    }
  }

  return { ok: true, reason: null, stats };
}

// ── acquisition, per lane, through the EXISTING scripts ──────────────────────

function run(script, args, env, timeoutMs) {
  const isMjs = script.endsWith(".mjs");
  const out = execFileSync(process.execPath, [path.join(HERE, script), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs || 10 * 60000,
  });
  return out;
}

const slugOf = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

/**
 * Acquire ONE entry into its own directory. Returns { csvPath, log } or throws.
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
      return { csvPath };
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
      return { csvPath: path.join(dir, csvs[0]) };
    }
    case "bcp": {
      // --titles names the exact mainspace page; BCP has no index, so the page
      // title IS the address.
      const title = decodeURIComponent(entry.sourceRef.split("/index.php/")[1] || "");
      if (!title) throw new Error("cannot derive a bcp page title from sourceRef");
      run("scrape-bcp-ladders.cjs", [
        `--titles=${title}`, "--titlesOnly=1", `--outDir=${dir}`, "--delayMs=800",
        `--sport=${entry.sport || "baseball"}`,
      ]);
      const csvs = fs.readdirSync(dir).filter((n) => n.endsWith(".csv"));
      if (!csvs.length) throw new Error("bcp scrape produced no CSV");
      return { csvPath: path.join(dir, csvs[0]) };
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
      return { csvPath };
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
      return { csvPath: path.join(dir, csvs[0]) };
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
      const modern = /^(SV|S\d|CS|M[0-9]|M-P|SVK|SVLN|SVLS)/i.test(setId);
      const script = modern ? "scrape-tcgdex-ja-modern.cjs" : "scrape-tcgdex-ja.cjs";
      run(script, [`--outDir=${dir}`, `--sets=${setId}`, "--delayMs=150"]);
      const csvs = fs.readdirSync(dir).filter((n) => n.endsWith(".csv"));
      if (!csvs.length) throw new Error(`tcgdex produced no CSV (${script}, set ${setId})`);
      return { csvPath: path.join(dir, csvs[0]) };
    }
    default:
      throw new Error(`no acquisition machinery for lane ${entry.lane}`);
  }
}

// ── Cosmos: the control docs and the verify-by-read ──────────────────────────

let db = null;
function cosmos() {
  if (db) return db;
  const { CosmosClient } = require("@azure/cosmos");
  db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING).database(process.env.COSMOS_DATABASE || "hobbyiq");
  return db;
}

const controlId = (entryId) => `ingest_universe::${entryId}`;

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

// ── main ────────────────────────────────────────────────────────────────────

// The gate is exported so its rules can be asserted directly against fixture
// CSVs, rather than only through a full acquisition. `require`d as a module the
// script does nothing; run as a CLI it drives.
module.exports = { gateStagedCsv, splitCsv, isPersonName, setKeyFor, LANE_ALIASES, CANONICAL_HEADER };
if (require.main !== module) return;

(async () => {
  // REFUSALS BEFORE REQUIRES.
  const rawSource = String(process.env.SOURCES || "").trim().toLowerCase();
  if (!rawSource) {
    console.error("REFUSE: SOURCES is required and has no default — name exactly one lane:");
    console.error("        hobbymonitor | insider | bcp | beckett | clc | tcgdexja  (tcdb is refused, see below)");
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
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("REFUSE: COSMOS_CONNECTION_STRING not set"); process.exit(2); }
  if (!fs.existsSync(MANIFEST_PATH)) { console.error(`REFUSE: manifest not found at ${MANIFEST_PATH}`); process.exit(2); }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const years = String(process.env.YEARS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const sports = String(process.env.SPORTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  let candidates = manifest.entries.filter((e) => e.lane === lane);
  const laneTotal = candidates.length;
  if (years.length) candidates = candidates.filter((e) => years.includes(String(e.year)));
  if (sports.length) candidates = candidates.filter((e) => sports.includes(String(e.sport || "").toLowerCase()));

  // The unreachable list travels with the manifest so a run never spends its
  // budget re-probing what a direct 404 already settled.
  const unreachable = new Set((manifest.unreachable || []).map((u) => `${u.sport}|${u.year}|${u.setKey}`));

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

  const TERMINAL = new Set(["ingested", "unreachable"]);
  const queue = [];
  for (const e of candidates) {
    const prior = priorById.get(e.id);
    if (prior && !RECHECK && TERMINAL.has(prior.status)) continue;
    if (prior && !RECHECK && prior.status === "failed" && (prior.attempts || 0) >= 3) continue;
    queue.push({ entry: e, prior });
  }

  console.log(`  ${f(queue.length)} entries eligible; taking up to ${f(LIMIT)}\n`);

  // RECONCILIATION: intended is fixed BEFORE the loop and every entry lands in
  // exactly one bucket, counted directly. A remainder derived by subtraction
  // balances by construction and can never disagree with itself.
  const take = queue.slice(0, LIMIT);
  const intended = take.length;
  const verdicts = { ingested: 0, partial: 0, failed: 0, unreachable: 0 };
  let notReached = 0, rowsCreatedTotal = 0;
  // Report mode reconciles against what it INSPECTED. Counting a dry run's
  // deliberate zero writes as a shortfall reports a false imbalance and, worse,
  // exits non-zero -- which would stop the very relaunch that is working.
  let inspected = 0;
  const perEntry = [];
  let stoppedOnBudget = false;

  for (let i = 0; i < take.length; i++) {
    const { entry, prior } = take[i];
    if (left() < perEntryMin * 60000 * 1.5) { notReached = take.length - i; stoppedOnBudget = true; break; }

    const label = `${entry.lane}/${entry.setName || entry.sourceRef}`;
    const ukey = `${entry.sport}|${entry.year}|${setKeyFor(entry) || ""}`;
    if (unreachable.has(ukey)) {
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
      const plan = {
        hobbymonitor: "fetchHobbyMonitorChecklist.cjs --url <sourceRef> (direct-URL lane) → ingest-checklist-csv-to-catalog.cjs",
        checklistinsider: "scrape-checklistinsider.cjs --slugsFile → convertChecklistInsiderToChecklistCsv.cjs → ingest-checklist-csv-to-catalog.cjs",
        bcp: "scrape-bcp-ladders.cjs --titles=<page> --titlesOnly → ingest-checklist-csv-to-catalog.cjs",
        beckett: "fetch <sourceRef>.xlsx → convertBeckettChecklistXlsx.cjs → ingest-checklist-csv-to-catalog.cjs",
        clc: "scrape-checklistcenter-products.cjs --urls → convertChecklistCenterToChecklistCsv.cjs → ingest-checklist-csv-to-catalog.cjs",
        tcgdexja: "scrape-tcgdex-ja.cjs --sets=<id> → ingest-checklist-csv-to-catalog.cjs",
      }[entry.lane];
      const inCatalog = await countCatalogRows(entry).catch(() => null);
      console.log(`      would drive: ${plan}`);
      console.log(`      gates: canonical header · zero-base-cards · players-as-parallels · card-line-as-rung · cross-join arithmetic`);
      console.log(`      catalog now: ${inCatalog === null ? "(setKey/year not derivable — verify would refuse)" : f(inCatalog) + " rows"}   seeded=${entry.seededStatus}   prior=${prior?.status || "(none)"}`);
      perEntry.push({ id: entry.id, label, status: "would-attempt", reason: null, rowsInCatalog: inCatalog, seeded: entry.seededStatus });
      inspected++;
      continue;
    }

    const dir = path.join(WORKDIR, lane, slugOf(entry.id).slice(0, 60));
    let verdict;
    try {
      const before = await countCatalogRows(entry);
      const { csvPath } = acquireEntry(entry, dir);

      // GATE BEFORE INGEST. A staged file that violates doctrine is refused as
      // a whole entry -- never a dirty ingest, and never a silent skip.
      const gate = gateStagedCsv(csvPath);
      if (!gate.ok) {
        verdict = { status: "failed", reason: `cleanliness gate: ${gate.reason}`, rowsCreated: 0, stats: gate.stats };
        console.log(`      REFUSED — ${gate.reason}`);
      } else {
        run("ingest-checklist-csv-to-catalog.cjs", [], {
          DIR: path.dirname(csvPath),
          SOURCE: `${lane}-${new Date().toISOString().slice(0, 10)}`,
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
      const msg = String(e.message || e).slice(0, 200);
      // A 404/403 from the source is the source not serving this set -- not a
      // defect in our pipe, and a different verdict from a broken acquisition.
      const isGone = /HTTP 40[34]|ENOTFOUND|exit(ed)? .*code 9|workbook empty or unreachable/i.test(msg);
      verdict = { status: isGone ? "unreachable" : "failed", reason: `acquisition: ${msg}`, rowsCreated: 0 };
      console.log(`      ${isGone ? "UNREACHABLE" : "FAILED"} — ${msg.slice(0, 140)}`);
    }

    verdicts[verdict.status]++;
    perEntry.push({ id: entry.id, label, status: verdict.status, reason: verdict.reason, rowsCreated: verdict.rowsCreated });
    await writeControl(entry, { ...verdict, priorAttempts: prior?.attempts });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  // ── reconciliation ────────────────────────────────────────────────────────
  const written = verdicts.ingested + verdicts.partial + verdicts.failed + verdicts.unreachable;
  const accounted = APPLY ? written : inspected;
  const spent = Math.round((Date.now() - STARTED) / 60000);
  console.log(`\n── driver complete in ${spent}m ──`);
  console.log(`  lane                ${lane}`);
  console.log(`  intended            ${f(intended)}   (entries this run took)`);
  if (APPLY) {
    console.log(`    ingested          ${f(verdicts.ingested)}`);
    console.log(`    partial           ${f(verdicts.partial)}`);
    console.log(`    failed            ${f(verdicts.failed)}`);
    console.log(`    unreachable       ${f(verdicts.unreachable)}`);
  } else {
    console.log(`    inspected         ${f(inspected)}   (report mode: planned, never fetched)`);
    console.log(`    unreachable       ${f(verdicts.unreachable)}   (settled from the manifest, no fetch needed)`);
  }
  console.log(`    not reached       ${f(notReached)}   (budget stop, counted directly)`);
  console.log(`  written             ${f(APPLY ? written : 0)}   (control docs upserted)`);
  console.log(`  rows created        ${f(rowsCreatedTotal)}   (verified by catalog read, not claimed)`);
  const balanced = accounted + notReached === intended;
  console.log(`  RECONCILED          ${balanced ? "yes" : `NO — ${f(accounted)} + ${f(notReached)} != ${f(intended)}`}`);
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
      skipped: verdicts.unreachable + notReached,
      failed: verdicts.failed,
    });
  }

  const remaining = queue.length - accounted;
  console.log(`  remaining in lane   ${f(Math.max(0, remaining))}`);
  console.log(`  universe_entries_done=${written}`);

  // THE BUDGET MARKER. Printed only when entries remain AND this run stopped on
  // its own clock -- the relaunch gates on this line, never on a count, because
  // a count gate loops forever on a lane whose remainder cannot be changed and
  // stops early on a budget stop that happened to change nothing.
  if (remaining > 0 && (stoppedOnBudget || written >= LIMIT)) {
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
})().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
