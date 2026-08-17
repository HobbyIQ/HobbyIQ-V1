#!/usr/bin/env node
/**
 * CF-ACQUIRE-MISSING-CHECKLISTS (Drew, 2026-08-16: "lets get every catalog we
 * need and ingest the FULL checklist for all of those and that way we can run
 * it daily to stay on top of it").
 *
 * Takes the ranking from checklist-gap-report — products our SALES reference
 * that have little or no CHECKLIST behind them — and goes and gets them.
 *
 * DRIVEN BY THE GAP REPORT, NOT THE SEED QUEUE. The queue is fed by match
 * failures, and only 22% of those were genuinely missing checklists; its top
 * entry asked for 2025 Topps against 2.9M checklist-backed rows we already
 * had. Working from stranded-sales-per-product instead means the job spends
 * publisher goodwill only on things we actually lack.
 *
 * ALREADY-COVERED PRODUCTS ARE SKIPPED AT RUN TIME, not just at ranking time.
 * A daily job re-reads the gap each run, so once a product is covered it stops
 * being fetched — that is what makes this safe to leave on a schedule.
 *
 * THREE SOURCES, TRIED IN ORDER (CF-CHECKLIST-SOURCE-LADDER, 2026-08-17).
 * Cardboard Connection used to be the only one, so a product it does not
 * publish was unreachable no matter how many URL forms we tried. Two more
 * publishers already had working fetchers in this repo and were simply never
 * wired in. They cover different eras, which is why order matters:
 *
 *   cardboardconnection  broad, modern + vintage, established first stop
 *   hobbymonitor         MODERN ONLY — ~100 current releases, heavy on the
 *                        Panini that Beckett barely publishes. It will never
 *                        hold 1995 Fleer.
 *   beckett              XLSX archive, strong on Topps/Bowman and vintage.
 *                        The only candidate for old sets.
 *
 * A rung that 404s, throws, or parses thin (<5 rows) falls through to the next
 * rather than ending the product. A product CC publishes still costs one
 * request, because the lower rungs are only consulted on failure.
 *
 * MATCHING IS STRICT ON PURPOSE. A loose match ingests a DIFFERENT product's
 * checklist under our setKey, which corrupts the catalog rather than filling
 * it — worse than the gap it would close. Both resolvers require the year, the
 * sport and every brand token, and treat an ambiguous match (2+ candidates) as
 * a refusal rather than picking one.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/acquire-missing-checklists.cjs [--apply] [--max=12] [--gaps=path]
 *
 * Defaults to DRY-RUN.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const backend = path.join(__dirname, "..");

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => process.argv.includes(`--${n}`);

/**
 * setKey -> the brand slug the publisher uses in its URLs.
 *
 * Only the cases where OUR key and THEIR name genuinely differ. Everything
 * else falls through to the setKey, which is already a slug. Guessing a URL
 * costs one 404 and nothing else, so this stays small on purpose rather than
 * trying to be a second product vocabulary.
 */
const URL_BRAND = {
  "panini-optic": "donruss-optic",
  "panini-donruss": "donruss",
  "panini-prizm": "prizm",
  "panini-select": "select",
  "panini-mosaic": "mosaic",
  "panini-chronicles": "chronicles",
  "topps-chrome-update-series": "topps-chrome-update",
  "topps-series-1": "topps-series-1",
  "topps-series-2": "topps-series-2",
  "bowman-chrome-sapphire": "bowman-chrome-sapphire",
};

const FETCHER = path.join(backend, "scripts/fetchCardboardConnectionChecklist.cjs");
const INGESTER = path.join(backend, "scripts/ingest-scraped-checklist.cjs");
const HM_FETCHER = path.join(backend, "scripts/fetchHobbyMonitorChecklist.cjs");
const BECKETT_DISCOVER = path.join(backend, "scripts/discoverBeckettChecklists.cjs");
const BECKETT_CONVERT = path.join(backend, "scripts/convertBeckettChecklistXlsx.cjs");

/** A page that parsed but held no real checklist. Ingesting it writes noise
 *  into the catalog for no coverage gain, so it counts as a MISS and the
 *  ladder moves to the next source rather than accepting it. */
const MIN_USEFUL_ROWS = 5;

function csvRowCount(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length - 1;
}

/**
 * CF-CHECKLIST-SOURCE-LADDER (Drew, 2026-08-17).
 *
 * Cardboard Connection was the only source, so a product it does not publish
 * was simply unreachable no matter how many URL forms we tried. Two more
 * publishers already have working fetchers in this repo; they were just never
 * wired into the acquisition path.
 *
 * THE SOURCES COVER DIFFERENT ERAS, which is why this is a ladder and not a
 * choice:
 *
 *   cardboardconnection  broad, modern + vintage, the established first stop
 *   hobbymonitor         MODERN ONLY — a ~100-entry index of current releases,
 *                        heavy on the Panini that Beckett barely publishes.
 *                        It will never hold 1995 Fleer; do not ask it to.
 *   beckett              XLSX archive, strong on Topps/Bowman and the vintage
 *                        back catalogue. The only candidate for old sets.
 *
 * Each rung fires only when the one above returns nothing or returns thin, so
 * a product CC publishes still costs exactly one request.
 */

/** Hobby Monitor's release index, fetched once per run and cached. */
let _hmIndex = null;
function hmIndex() {
  if (_hmIndex) return _hmIndex;
  try {
    const out = run(HM_FETCHER, ["--list"]);
    // The command prints a JSON array followed by a human summary line.
    const start = out.indexOf("[");
    const end = out.lastIndexOf("]");
    _hmIndex = start >= 0 && end > start ? JSON.parse(out.slice(start, end + 1)) : [];
  } catch { _hmIndex = []; }
  return _hmIndex;
}

/** Match a gap onto a Hobby Monitor release slug. Requires the year AND the
 *  sport AND every brand token to appear — a loose match here silently ingests
 *  a DIFFERENT product's checklist under our setKey, which is worse than the
 *  gap it would close. */
function hmSlugFor(g, brand) {
  const tokens = String(brand).split("-").filter(Boolean);
  const sport = String(g.sport).toLowerCase();
  const hits = hmIndex().filter((r) => {
    const s = String(r.slug || "").toLowerCase();
    if (!s.startsWith(`${g.year}-`)) return false;
    if (String(r.sport || "").toLowerCase() !== sport && !s.includes(sport)) return false;
    return tokens.every((t) => s.includes(t));
  });
  // Ambiguity is a refusal, not a coin flip.
  return hits.length === 1 ? hits[0].slug : null;
}

/** Beckett's XLSX manifest, discovered once per sport per run and cached. */
const _beckettBySport = new Map();
function beckettManifest(sport) {
  if (_beckettBySport.has(sport)) return _beckettBySport.get(sport);
  const out = path.join(backend, `.beckett-manifest-${sport}.json`);
  let manifest = [];
  try {
    run(BECKETT_DISCOVER, [`--sport=${sport}`, `--out=${out}`]);
    if (fs.existsSync(out)) manifest = JSON.parse(fs.readFileSync(out, "utf8"));
  } catch { manifest = []; }
  _beckettBySport.set(sport, manifest);
  return manifest;
}

function beckettEntryFor(g, brand) {
  const tokens = String(brand).split("-").filter(Boolean);
  const hits = beckettManifest(g.sport).filter((m) => {
    if (Number(m.year) !== Number(g.year)) return false;
    const name = `${m.productName || ""} ${m.url || ""}`.toLowerCase();
    return m.xlsx && tokens.every((t) => name.includes(t));
  });
  return hits.length === 1 ? hits[0] : null;
}

function download(url, dest) {
  execFileSync("curl", ["-sL", "--max-time", "60", "-o", dest, url], { encoding: "utf8" });
  return fs.existsSync(dest) && fs.statSync(dest).size > 0;
}

function titleCase(slug) {
  return String(slug).split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function run(file, args, env) {
  return execFileSync(process.execPath, [file, ...args], {
    cwd: backend, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(env || {}) }, timeout: 300_000,
  });
}

async function main() {
  const APPLY = has("apply");
  const MAX = Math.max(1, Number(arg("max", "12")));
  const GAPS = arg("gaps", "");
  if (!GAPS || !fs.existsSync(GAPS)) {
    console.error("need --gaps=<json from checklist-gap-report.cjs>");
    process.exit(2);
  }
  const gaps = JSON.parse(fs.readFileSync(GAPS, "utf8"));
  const outDir = path.join(backend, "data/checklists/scraped/acquired");
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[acquire] mode=${APPLY ? "APPLY" : "DRY-RUN"} max=${MAX} candidates=${gaps.length}\n`);

  let fetched = 0, ingested = 0, rows = 0, missing = 0, failed = 0;
  const bySource = new Map();
  for (const g of gaps.slice(0, MAX)) {
    const brand = URL_BRAND[g.setKey] || g.setKey;
    // CF-URL-FORMS (2026-08-16). A sweep of 44 vintage targets fetched 6 and
    // "missed" 38 — but the pages existed. Two reasons, both mine:
    //
    //   301  The existence probe accepted a literal 200, and
    //        /1968-topps-baseball-cards answers 301. Redirects are the norm on
    //        this publisher, so every vintage baseball year read as absent.
    //   YY   Basketball and hockey sets span two calendar years and are
    //        published as 1986-87-fleer-basketball-cards. Asking for
    //        1986-fleer-basketball-cards is a genuine 404 for a set we have.
    //
    // Both candidate forms are tried; the fetcher follows redirects itself.
    //   -cards  The suffix is not universal. 2025-panini-certified-football
    //           is a 200 and 2025-panini-certified-football-cards is a 404,
    //           so appending it unconditionally hid a live product page.
    const yy = String((g.year + 1) % 100).padStart(2, "0");
    const candidates = [
      `${g.year}-${brand}-${g.sport}-cards`,
      `${g.year}-${brand}-${g.sport}`,
    ];
    if (g.sport === "basketball" || g.sport === "hockey") {
      candidates.unshift(`${g.year}-${yy}-${brand}-${g.sport}`);
      candidates.unshift(`${g.year}-${yy}-${brand}-${g.sport}-cards`);
    }
    let url = null;
    for (const c of candidates) {
      const probe = `https://www.cardboardconnection.com/${c}`;
      try {
        // -L so a 301 counts as present, which is what it means.
        const code = execFileSync("curl", ["-sL", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "35", probe], { encoding: "utf8" }).trim();
        if (code === "200") { url = probe; break; }
      } catch { /* try the next form */ }
    }
    const stem = path.join(outDir, `${g.year}-${g.setKey}-${g.sport}`);
    const label = `${g.year} ${g.setKey} ${g.sport}`.padEnd(38);

    // Build the ladder. CC is only a rung if a page actually answered; the
    // other two resolve their own targets, so a CC 404 no longer ends the run.
    const hmSlug = hmSlugFor(g, brand);
    const beckett = beckettEntryFor(g, brand);
    const rungs = [];
    if (url) rungs.push({ src: "cardboardconnection", detail: url });
    if (hmSlug) rungs.push({ src: "hobbymonitor", detail: `https://www.hobbymonitor.com/release/${hmSlug}` });
    if (beckett) rungs.push({ src: "beckett", detail: beckett.xlsx });

    if (rungs.length === 0) {
      missing++;
      console.log(`  MISS  ${label} (no source has it: CC no page, HM no release, Beckett no xlsx)`);
      continue;
    }

    if (!APPLY) {
      console.log(`  would fetch  ${label} ${g.comps} comps / ${g.checklistRows} rows` +
        `  via ${rungs.map((r) => r.src).join(" -> ")}`);
      continue;
    }

    // Walk the rungs until one yields a usable checklist. A rung that 404s,
    // throws, or parses thin drops through to the next rather than ending the
    // product — that fall-through IS the feature.
    let lines = 0, usedSource = null;
    for (const rung of rungs) {
      try {
        if (rung.src === "cardboardconnection") {
          run(FETCHER, ["--url", rung.detail, "--year", String(g.year), "--brand", titleCase(brand),
            "--sport", g.sport, "--set-key", g.setKey, "--out", `${stem}.csv`]);
        } else if (rung.src === "hobbymonitor") {
          run(HM_FETCHER, ["--url", rung.detail, "--out", `${stem}.csv`,
            "--year", String(g.year), "--set-key", g.setKey, "--sport", g.sport]);
        } else {
          const xlsx = `${stem}.xlsx`;
          if (!download(rung.detail, xlsx)) throw new Error("xlsx download empty");
          run(BECKETT_CONVERT, ["--xlsx", xlsx, "--year", String(g.year), "--set-key", g.setKey,
            "--set-name", `${g.year} ${titleCase(brand)}`, "--sport", g.sport,
            "--out", `${stem}.csv`, "--source-url", rung.detail]);
        }
      } catch {
        console.log(`        ${rung.src} failed — trying next source`);
        continue;
      }
      const n = csvRowCount(`${stem}.csv`);
      if (n < MIN_USEFUL_ROWS) {
        console.log(`        ${rung.src} thin (${n} rows) — trying next source`);
        continue;
      }
      lines = n; usedSource = rung.src; break;
    }

    if (!usedSource) { missing++; console.log(`  MISS  ${label} (every source failed or thin)`); continue; }
    fetched++;

    try {
      const out = run(INGESTER, [], {
        CSV_PATH: `${stem}.csv`, SOURCE_LABEL: usedSource, APPLY: "true",
      });
      const m = out.match(/wrote=(\d+)/);
      const n = m ? Number(m[1]) : 0;
      rows += n; ingested++;
      bySource.set(usedSource, (bySource.get(usedSource) || 0) + 1);
      console.log(`  OK    ${label} csv=${lines} wrote=${n}  [${usedSource}]`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${label} ingest: ${String(e.message).slice(0, 80)}`);
    }
  }

  console.log(`\nfetched=${fetched} ingested=${ingested} rows=${rows} missing=${missing} failed=${failed}`);
  if (bySource.size) {
    console.log("which source supplied each:");
    [...bySource.entries()].sort((a, b) => b[1] - a[1])
      .forEach(([s, n]) => console.log(`   ${String(n).padStart(4)}  ${s}`));
  }
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
