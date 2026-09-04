#!/usr/bin/env node
// CF-THE-SITEMAP-IS-THE-DISCOVERY (2026-09-04). Companion to
// fetchSportsCardChecklist.cjs; spec in
// backend/docs/checklists/2026-09-04-vintage-checklist-sources.md §6.2.
//
// Lists the sets www.sportscardchecklist.com serves for the seven target cells
// (plus the hockey/topps bonus cell) and APPENDS manifest entries to
// backend/data/ingest-universe.json under lane `sportscardchecklist`.
//
// ENTRIES ONLY. This mints addresses, never rows: no page fetch beyond the
// sitemaps, no Cosmos access, no ingest. The driver does the acquiring, one
// entry at a time, with a verdict each.
//
// ── WHY THE SITEMAP AND NOT THE SEARCH ──────────────────────────────────────
// robots.txt (HTTP 200, 134 bytes, verbatim):
//
//     # Sitemap
//     Sitemap: https://www.sportscardchecklist.com/site_maps/sitemap.xml
//
//     # All Bots
//     User-agent: *
//     Disallow: /?*
//     Disallow: /*.htm$
//
// `Disallow: /?*` covers /search/?search_terms=..., so the search endpoint is
// off-limits — and it is also WRONG: the survey measured "1972 topps football"
// returning 18 results, none of them the set, which lives at set-11959. The
// sitemap is both the sanctioned path and the accurate one. It is advertised in
// robots.txt itself.
//
// ── THE SPLIT-YEAR TRAP ─────────────────────────────────────────────────────
// Basketball and hockey slugs carry a season (1979-80-o-pee-chee-, 1992-93-
// fleer-); football and baseball carry a single year. A year-anchored regex
// assuming one form reports ZERO sets for basketball 1991-2009 and for all of
// hockey — which is exactly the false negative that makes a live source look
// absent. Both forms are accepted and the FIRST year is the cell year.
//
//   node scripts/discoverSportsCardChecklistSets.cjs                  # report only
//   node scripts/discoverSportsCardChecklistSets.cjs --apply          # append entries
//   node scripts/discoverSportsCardChecklistSets.cjs --cache <dir>    # reuse fetched sitemaps

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const backend = path.join(__dirname, "..");
/**
 * CF-EVERY-EMITTED-SETKEY-IS-A-FIXED-POINT (2026-09-04).
 *
 * setKeyFor() derives a key from the set NAME, and on this source that name is
 * a slug remainder: "1992-93 Fleer All-Stars Basketball" derives
 * "fleer-all-stars". normalizeSetKey collapses that to "fleer" -- so an entry
 * carrying the derived key would be verified against a key the catalog never
 * uses, and rows minted under it land UNFINDABLE (#1614, and the
 * checklist-ingest-leaves-rows-unfindable ruling).
 *
 * Measured over all 5,851 discovered sets: 4,859 of the 4,884 distinct derived
 * keys are NOT fixed points. Passing each through normalizeSetKey IS the fix and
 * is provably safe here -- normalizeSetKey is idempotent on every one of those
 * 4,884 keys (0 exceptions), so its output is a fixed point by construction.
 * The entry records BOTH: setKey is the canonical key the catalog uses, and
 * derivedSetKey keeps the source's own spelling for audit.
 *
 * This is deliberately NOT a new vocabulary. Where a specialized product is
 * already known (topps-chrome, skybox-premium, upper-deck-mvp -- 25 of them) the
 * key survives untouched; where it is not, the set nests under its flagship
 * rather than minting a product nobody can find. Naming the unknown ones is a
 * vocabulary ruling, not a discovery-script decision -- derivedSetKey is what a
 * later ruling reads to find every set that nested.
 */
const { normalizeSetKey } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { setKeyFor } = require(path.join(__dirname, "ingest-universe-driver.cjs"));

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const has = (f) => args.includes(f);

const APPLY = has("--apply");
const BASE = "https://www.sportscardchecklist.com";
const SITEMAP_INDEX = `${BASE}/site_maps/sitemap.xml`;
const UA = process.env.SCC_UA
  || "Mozilla/5.0 (compatible; HobbyIQ-checklist-fetch/1.0; +https://hobbyiq.app; contact: dvabulas@outlook.com)";
const DELAY_MS = Math.max(1000, Number(process.env.SCC_DELAY_MS || 1100));
const MANIFEST_PATH = process.env.MANIFEST_PATH
  || path.join(__dirname, "..", "data", "ingest-universe.json");
const CACHE_DIR = val("--cache", "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (n) => Number(n).toLocaleString();

function get(url, attempt = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": UA, Accept: "application/xml,text/xml" } }, (res) => {
      const code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), attempt));
      }
      if ((code === 429 || code === 503) && attempt < 4) {
        res.resume();
        return sleep(DELAY_MS * Math.pow(2, attempt + 1)).then(() => resolve(get(url, attempt + 1)));
      }
      if (code !== 200) { res.resume(); return reject(new Error(`HTTP ${code} for ${url}`)); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

const locs = (xml) => {
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
};

/**
 * THE SEVEN TARGET CELLS, plus the hockey/topps bonus PR #1689 listed
 * "NOT QUEUED". A cell is (sport, setKey, year range) and the setKey is the
 * catalog's own word for the brand — the same string setKeyFor() derives from
 * the set name, so a manifest entry and its verification agree.
 */
const CELLS = [
  { sport: "football",   setKey: "topps",      from: 1948, to: 1989, label: "football/topps/1948-1989" },
  { sport: "basketball", setKey: "topps",      from: 1948, to: 1988, label: "basketball/topps/1948-1988" },
  { sport: "basketball", setKey: "topps",      from: 1991, to: 2009, label: "basketball/topps/1991-2009" },
  { sport: "basketball", setKey: "upper-deck", from: 1991, to: 2009, label: "basketball/upper-deck/1991-2009" },
  { sport: "basketball", setKey: "fleer",      from: 1990, to: 2009, label: "basketball/fleer/1990-2009" },
  { sport: "basketball", setKey: "skybox",     from: 1991, to: 2008, label: "basketball/skybox/1991-2008" },
  { sport: "hockey",     setKey: "o-pee-chee", from: 1933, to: 1989, label: "hockey/o-pee-chee/1933-1989" },
  { sport: "hockey",     setKey: "topps",      from: 1900, to: 1989, label: "hockey/topps/pre-1990", bonus: true },
  /**
   * CF-THE-DISCOVERY-NEVER-KNEW-ABOUT-BASEBALL (2026-09-04).
   *
   * The seven target cells were chosen because no other lane reached them, and
   * all seven are football/basketball/hockey. So the sitemap pass classified
   * every baseball set URL as `null` and minted nothing for the sport this
   * catalog is most of. Measured on the same 141,482-URL sitemap the survey
   * cached: 40,699 of them are baseball, and NOT ONE was ever offered.
   *
   * The eight #1719 Topps Traded Tiffany entries are what exposed it. They had
   * to be hand-written into the manifest, one at a time, because the discovery
   * that mints entries for exactly this source could not see them -- and the
   * source serves the whole family: 1984-1990 `topps-tiffany-traded`, plus
   * `topps-tiffany` for 1984-1991 and `bowman-tiffany` for 1989-1990, none of
   * which the manifest holds.
   *
   * SCOPED TO TOPPS AND BOWMAN, 1980-1999, deliberately. This is the Tiffany /
   * Traded / flagship window the goal names, and it is where the checklist gap
   * behind the vintage comps sits. Opening baseball to every brand and every
   * year would mint tens of thousands of entries in one commit, which is a
   * queue nobody has budgeted and a review nobody can read. The remaining
   * baseball cells are a later, deliberate widening -- and this file is now the
   * place that widening happens, which it was not before.
   *
   * ENTRIES ONLY, as ever: this mints addresses, and the driver's per-entry
   * verdict is what settles any of them.
   */
  { sport: "baseball",   setKey: "topps",      from: 1980, to: 1999, label: "baseball/topps/1980-1999" },
  { sport: "baseball",   setKey: "bowman",     from: 1980, to: 1999, label: "baseball/bowman/1980-1999" },
  /**
   * CF-THE-FLEER-COATED-REPRINTS-WERE-INVISIBLE-TOO (2026-09-04).
   *
   * The note above says the remaining baseball cells are "a later, deliberate
   * widening -- and this file is now the place that widening happens". This is
   * that widening, and #1745 is what forced it: its repair lane gates 1,339
   * catalog rows and 994 comps on Fleer Tiffany / Fleer Glossy products that
   * the catalog had never minted, and NEITHER key was reachable from here
   * because baseball was scoped to Topps and Bowman.
   *
   * The source serves all of them -- 1987/1988/1989 Fleer Glossy, 1987/1988
   * Fleer Update Glossy, 1996 Fleer Tiffany, 1996 Fleer Update Tiffany, 1997
   * Fleer Tiffany, 2002 Fleer Tiffany -- and every one had to be found by
   * grepping a cached sitemap by hand, which is the same "the discovery never
   * knew about it" failure this cell list already carries a note about.
   *
   * 1985-2003 covers the Glossy Tin run (1987-1989) at its front and Fleer
   * Tradition at its back; `fleer` is anchored at the head of the slug
   * remainder, so `1996-97-skybox-e-x2000-fleer-...` stays out.
   */
  { sport: "baseball",   setKey: "fleer",      from: 1985, to: 2003, label: "baseball/fleer/1985-2003" },
];

/**
 * A brand matches at the HEAD of the slug remainder, anchored. `fleer` must not
 * match `1996-97-skybox-e-x2000-fleer-...`, and an unanchored test would put a
 * SkyBox set in the Fleer cell — a mis-filed cell is a mis-filed product.
 */
const BRAND_RE = {
  "topps": /^topps(?:-|$)/,
  "o-pee-chee": /^o-pee-chee(?:-|$)/,
  "fleer": /^fleer(?:-|$)/,
  "upper-deck": /^upper-deck(?:-|$)/,
  "skybox": /^skybox(?:-|$)/,
  "bowman": /^bowman(?:-|$)/,
};

/**
 * A CELL WHOSE BRAND HAS NO PATTERN MATCHES NOTHING, SILENTLY. classify()
 * skips a cell when BRAND_RE has no entry for its setKey -- which reads
 * exactly like "the source serves no such sets", the false negative this
 * file's own split-year note was written about. Adding a cell and forgetting
 * its pattern is a one-line mistake that costs a whole survey, so it fails at
 * load instead.
 */
for (const cell of CELLS) {
  if (!BRAND_RE[cell.setKey]) {
    throw new Error(`discoverSportsCardChecklistSets: cell ${cell.label} names brand "${cell.setKey}" with no BRAND_RE pattern — it would match nothing and report zero sets`);
  }
}

// Both year forms. `year2` present = split season; the FIRST year is the cell year.
const SET_URL_RE =
  /\/set-(\d+)\/(\d{4})(?:-(\d{2}))?-(.+?)-(football|basketball|hockey|baseball)-trading-card-checklist\/?$/;

function classify(url) {
  const m = SET_URL_RE.exec(url);
  if (!m) return null;
  const year = Number(m[2]);
  const rest = m[4];
  const sport = m[5];
  for (const cell of CELLS) {
    if (cell.sport !== sport) continue;
    if (year < cell.from || year > cell.to) continue;
    const re = BRAND_RE[cell.setKey];
    if (!re || !re.test(rest)) continue;
    return {
      cell,
      setId: m[1],
      year,
      season: m[3] ? `${year}-${m[3]}` : String(year),
      rest,
      sport,
      url,
    };
  }
  return null;
}

/** Title-case a slug remainder back into a set name the catalog can key off.
 *  `setKeyFor()` strips the year and the trailing sport, so the name is spelled
 *  the way the other lanes spell theirs: "<season> <Brand ...> <Sport>". */
const TITLE_EXC = new Set(["o", "pee", "chee"]);
function setNameFrom(season, rest, sport) {
  const words = rest.split("-").map((w) => {
    if (!w) return w;
    if (/^\d+$/.test(w)) return w;
    return w[0].toUpperCase() + w.slice(1);
  });
  const brandish = words.join(" ").replace(/\bO Pee Chee\b/i, "O-Pee-Chee").replace(/\bUpper Deck\b/i, "Upper Deck");
  const sportWord = sport[0].toUpperCase() + sport.slice(1);
  return `${season} ${brandish} ${sportWord}`.replace(/\s+/g, " ").trim();
}

async function main() {
  // ── 1. discovery ──────────────────────────────────────────────────────────
  let sitemapXmls = [];
  if (CACHE_DIR && fs.existsSync(CACHE_DIR)) {
    const files = fs.readdirSync(CACHE_DIR).filter((n) => n.endsWith(".xml") && /sitemap\d+/.test(n));
    sitemapXmls = files.map((n) => fs.readFileSync(path.join(CACHE_DIR, n), "utf8"));
    console.log(`sitemaps: ${files.length} from cache ${CACHE_DIR}`);
  } else {
    const idx = await get(SITEMAP_INDEX);
    const children = locs(idx);
    console.log(`sitemap index: ${children.length} child sitemaps`);
    for (const c of children) {
      sitemapXmls.push(await get(c));
      await sleep(DELAY_MS);          // one at a time, >=1s apart
    }
    if (CACHE_DIR) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      sitemapXmls.forEach((x, i) => fs.writeFileSync(path.join(CACHE_DIR, `sitemap${i + 1}.xml`), x));
    }
  }

  const all = new Set();
  for (const xml of sitemapXmls) for (const u of locs(xml)) if (/\/set-\d+\//.test(u)) all.add(u);
  console.log(`set URLs: ${f(all.size)}`);

  // ── 2. cell classification ────────────────────────────────────────────────
  const perCell = new Map(CELLS.map((c) => [c.label, []]));
  for (const u of all) {
    const c = classify(u);
    if (c) perCell.get(c.cell.label).push(c);
  }

  console.log("\n── candidate sets per cell ──");
  let total = 0;
  for (const cell of CELLS) {
    const n = perCell.get(cell.label).length;
    total += n;
    console.log(`  ${String(n).padStart(6)}  ${cell.label}${cell.bonus ? "   [bonus]" : ""}`);
  }
  console.log(`  ${String(total).padStart(6)}  TOTAL`);

  // ── 3. manifest entries ───────────────────────────────────────────────────
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const existing = new Set(manifest.entries.map((e) => e.id));
  const added = [];
  let dup = 0, unkeyed = 0, notFixed = 0;

  for (const cell of CELLS) {
    for (const c of perCell.get(cell.label).sort((a, b) => a.year - b.year || a.rest.localeCompare(b.rest))) {
      const id = `sportscardchecklist::${c.url}`;
      if (existing.has(id)) { dup++; continue; }
      existing.add(id);
      const setName = setNameFrom(c.season, c.rest, c.sport);
      const derived = setKeyFor({ setName, year: c.year, lane: "sportscardchecklist" });
      const canonical = derived ? normalizeSetKey(derived) : null;
      // An entry whose key is not derivable is UNVERIFIABLE, and the driver
      // treats unverifiable as failed. Refuse it here rather than seeding a
      // verdict nobody can settle.
      if (!canonical) { unkeyed++; continue; }
      if (normalizeSetKey(canonical) !== canonical) { notFixed++; continue; }
      added.push({
        id,
        lane: "sportscardchecklist",
        sourceRef: c.url,
        sport: c.sport,
        year: c.year,
        setName,
        setKey: canonical,
        derivedSetKey: derived !== canonical ? derived : undefined,
        estimatedCards: null,
        // Seeded MISSING, never "partial": nothing here has been fetched, so
        // claiming a partial state would assert a measurement nobody made. The
        // driver's own verdict is what settles it.
        seededStatus: "missing",
        seededNote:
          `sitemap-discovered ${new Date().toISOString().slice(0, 10)}; cell ${cell.label}` +
          (cell.bonus ? " (bonus cell, PR #1689 NOT QUEUED)" : "") +
          `; season=${c.season}; set-${c.setId}; not yet fetched`,
      });
    }
  }

  console.log(`\nmanifest: ${f(manifest.entries.length)} entries now, +${f(added.length)} new` +
    (dup ? `, ${f(dup)} already present` : "") +
    (unkeyed ? `, ${f(unkeyed)} REFUSED (no derivable setKey — unverifiable)` : "") +
    (notFixed ? `, ${f(notFixed)} REFUSED (setKey not a normalizeSetKey fixed point)` : ""));
  const nested = added.filter((e) => e.derivedSetKey).length;
  if (nested) {
    console.log(`  ${f(nested)} sets nest under a flagship key (their derived key is not in the` +
      ` vocabulary); ${f(added.length - nested)} keep their own product key.`);
  }

  // The unreachable list travels with the manifest so the driver never re-probes
  // what a 404 settled. Seven of its eight marks are football/basketball/hockey
  // cells THIS SOURCE COVERS -- 1972 Topps Football among them, proven at 351
  // cards. They are re-pointed, never deleted: the mark records that hobbymonitor
  // could not reach the set, which is still true of hobbymonitor.
  const covered = (manifest.unreachable || []).filter((u) =>
    CELLS.some((c) => c.sport === u.sport && c.setKey === u.setKey && u.year >= c.from && u.year <= c.to));
  if (covered.length) {
    console.log(`\nunreachable marks now covered by this source: ${covered.length}`);
    for (const u of covered) console.log(`  ${u.sport} ${u.year} ${u.setKey}  (${f(u.comps)} comps, ${f(u.uncovered)} uncovered)`);
  }

  if (!APPLY) {
    console.log("\nREPORT ONLY — pass --apply to append these entries to the manifest.");
    if (added.length) {
      console.log("sample entries:");
      for (const e of added.slice(0, 3)) console.log("  " + JSON.stringify(e));
    }
    return;
  }

  manifest.entries.push(...added);
  for (const u of covered) {
    u.nowCoveredBy = "sportscardchecklist";
    u.note = `${u.note ? u.note + "; " : ""}reachable at sportscardchecklist (2026-09-04 sitemap survey); the mark records that the ORIGINAL lane could not reach it`;
  }
  manifest.totals = manifest.totals || {};
  manifest.totals.entries = manifest.entries.length;
  manifest.totals.byLane = manifest.totals.byLane || {};
  const seeded = {};
  for (const e of manifest.entries) if (e.lane === "sportscardchecklist") seeded[e.seededStatus] = (seeded[e.seededStatus] || 0) + 1;
  manifest.totals.byLane.sportscardchecklist = {
    total: manifest.entries.filter((e) => e.lane === "sportscardchecklist").length,
    seeded,
  };
  manifest.mintedAt = new Date().toISOString();

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 1) + "\n");
  console.log(`\nwrote ${MANIFEST_PATH}  (${f(manifest.entries.length)} entries)`);
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
}

module.exports = { classify, setNameFrom, CELLS, BRAND_RE, SET_URL_RE, locs };
