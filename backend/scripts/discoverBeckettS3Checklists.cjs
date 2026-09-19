#!/usr/bin/env node
/**
 * CF-BECKETT-S3-DISCOVER (2026-09-18/19). beckett.com itself has been in
 * maintenance since ~2026-09-09 (site-wide 302 -> maintenance.beckett.com),
 * but the checklist .xlsx files were never served FROM beckett.com — they
 * live on an S3 origin that is still fully up and unauthenticated:
 *
 *   https://beckett-www.s3.amazonaws.com/news/news-content/uploads/<YYYY>/<MM>/<Product-Name>-Checklist.xlsx
 *
 * (Same path shape as the `img.beckett.com` CDN host discoverBeckettChecklists.cjs
 * already knew about -- this is the S3 bucket that CDN sits in front of.)
 *
 * S3 answers 403 (not 404) for a key that does not exist, and bucket listing
 * is denied -- so the year/month segment cannot be found by listing, only by
 * a BOUNDED probe around a product's known release window, or by a real
 * discovery signal (a search-engine hit, an archived page). This script
 * does the bounded probe: given a product name, a release year/month
 * estimate, and a window in months, it HEAD-checks every YYYY/MM combination
 * in that window (release month +/- windowMonths, default 4) at ≤1
 * request/second, and stops probing a product's window early if it hits
 * REPEATED_403_BURST consecutive 403s (a signal the product's naming pattern
 * itself is wrong, not that the right month is still ahead -- continuing to
 * hammer S3 past that point is not politeness, it is noise).
 *
 * CASE MATTERS. Measured 2026-09-18: 2024 Panini Zenith Football sits under
 * `2024-Panini-Zenith-Football-Checklist.xlsx` (plain title-case) but 2024
 * Panini PhotoGenic Football sits under
 * `2024-Panini-PhotoGenic-Football-Checklist.xlsx` -- Beckett's own brand
 * spelling ("PhotoGenic", camel-cased) is baked into the S3 key, and the
 * plain-title-case guess 403s. So each candidate product entry may carry an
 * explicit `fileNameOverride` (the exact brand spelling) alongside the
 * generic title-cased default, and the prober tries BOTH.
 *
 * Usage:
 *   node backend/scripts/discoverBeckettS3Checklists.cjs [--out=<path>] [--dry-run]
 *
 *   --out       manifest JSON path (default: the committed gap-list manifest)
 *   --dry-run   print what would be probed without making any request
 *
 * Writes a committed manifest: one entry per HIT, {url, bytes, sha256,
 * fetchedAt, product, year, sport}. A MISS is logged to stdout, never
 * written to the manifest (an absent entry means "not found", not "known to
 * not exist" -- S3's own 403 cannot distinguish those two claims, so this
 * script does not pretend it can).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const S3_BASE = "https://beckett-www.s3.amazonaws.com/news/news-content/uploads";

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(`--${f}`); if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1]; const eq = args.find((a) => a.startsWith(`--${f}=`)); return eq ? eq.split("=").slice(1).join("=") : d; };
const OUT = val("out", path.join(__dirname, "..", "data", "checklists", "beckett-s3-manifest-2026-09.json"));
const DRY_RUN = args.includes("--dry-run");

/** ≤1 request/second, polite. */
const RATE_LIMIT_MS = 1000;
/** Stop probing a single product's window after this many CONSECUTIVE 403s
 *  -- a burst this long past a real hit means the naming guess itself is
 *  wrong, not that the right month is further out. */
const REPEATED_403_BURST = 6;

/**
 * THE GAP LIST (from the coordinator's brief, 2026-09-18/19). One entry per
 * product: `product` is the S3 filename stem (without "-Checklist.xlsx"),
 * `year`/`sport` are for the manifest record, `releaseYear`/`releaseMonth`
 * seed the probe window center. `fileNameOverride`, when present, is tried
 * FIRST (a known brand-casing quirk) and the plain title-cased `product` is
 * always tried too, since most products need no override at all.
 */
const GAP_LIST = [
  // 2024/2025 Panini football
  { product: "2024-Panini-Prizm-Football", sport: "football", year: 2024, releaseYear: 2024, releaseMonth: 12 },
  { product: "2024-Panini-Select-Football", sport: "football", year: 2024, releaseYear: 2025, releaseMonth: 4 },
  { product: "2024-Panini-Donruss-Optic-Football", sport: "football", year: 2024, releaseYear: 2025, releaseMonth: 2 },
  { product: "2024-Panini-Mosaic-Football", sport: "football", year: 2024, releaseYear: 2025, releaseMonth: 1 },
  { product: "2024-Panini-Zenith-Football", sport: "football", year: 2024, releaseYear: 2025, releaseMonth: 3 },
  { product: "2024-Panini-Illusions-Football", sport: "football", year: 2024, releaseYear: 2025, releaseMonth: 5 },
  { product: "2024-Panini-Photogenic-Football", sport: "football", year: 2024, releaseYear: 2025, releaseMonth: 2, fileNameOverride: "2024-Panini-PhotoGenic-Football" },
  { product: "2024-Panini-Phoenix-Football", sport: "football", year: 2024, releaseYear: 2025, releaseMonth: 6 },
  { product: "2024-Panini-Contenders-Football", sport: "football", year: 2024, releaseYear: 2025, releaseMonth: 3 },
  { product: "2025-Panini-Prizm-Football", sport: "football", year: 2025, releaseYear: 2025, releaseMonth: 12 },
  { product: "2025-Panini-Select-Football", sport: "football", year: 2025, releaseYear: 2026, releaseMonth: 4 },
  { product: "2025-Panini-Donruss-Optic-Football", sport: "football", year: 2025, releaseYear: 2026, releaseMonth: 2 },
  { product: "2025-Panini-Mosaic-Football", sport: "football", year: 2025, releaseYear: 2026, releaseMonth: 1 },
  { product: "2025-Panini-Zenith-Football", sport: "football", year: 2025, releaseYear: 2026, releaseMonth: 3 },
  { product: "2025-Panini-Illusions-Football", sport: "football", year: 2025, releaseYear: 2026, releaseMonth: 5 },
  { product: "2025-Panini-Photogenic-Football", sport: "football", year: 2025, releaseYear: 2026, releaseMonth: 2, fileNameOverride: "2025-Panini-PhotoGenic-Football" },
  { product: "2025-Panini-Phoenix-Football", sport: "football", year: 2025, releaseYear: 2026, releaseMonth: 6 },
  { product: "2025-Panini-Contenders-Football", sport: "football", year: 2025, releaseYear: 2026, releaseMonth: 3 },

  // 2024-25 Panini basketball
  { product: "2024-25-Panini-Prizm-Basketball", sport: "basketball", year: 2024, releaseYear: 2024, releaseMonth: 12 },
  { product: "2024-25-Panini-Select-Basketball", sport: "basketball", year: 2024, releaseYear: 2025, releaseMonth: 6 },
  { product: "2024-25-Panini-Donruss-Optic-Basketball", sport: "basketball", year: 2024, releaseYear: 2025, releaseMonth: 2 },
  { product: "2024-25-Panini-Mosaic-Basketball", sport: "basketball", year: 2024, releaseYear: 2024, releaseMonth: 11 },
  { product: "2024-25-Panini-Hoops-Basketball", sport: "basketball", year: 2024, releaseYear: 2024, releaseMonth: 11, fileNameOverride: "2024-25-Panini-NBA-Hoops-Basketball" },

  // 2022 Topps Chrome baseball + variants
  { product: "2022-Topps-Chrome-Baseball", sport: "baseball", year: 2022, releaseYear: 2022, releaseMonth: 4 },
  { product: "2022-Topps-Chrome-Sonic-Baseball", sport: "baseball", year: 2022, releaseYear: 2022, releaseMonth: 4 },
  { product: "2022-Topps-Chrome-Ben-Baller-Baseball", sport: "baseball", year: 2022, releaseYear: 2022, releaseMonth: 4 },
  { product: "2022-Topps-Chrome-Cosmic-Baseball", sport: "baseball", year: 2022, releaseYear: 2022, releaseMonth: 4 },

  // 2025 Bowman baseball
  { product: "2025-Bowman-Baseball", sport: "baseball", year: 2025, releaseYear: 2025, releaseMonth: 2 },
  { product: "2025-Bowman-Chrome-Baseball", sport: "baseball", year: 2025, releaseYear: 2025, releaseMonth: 6 },
  { product: "2025-Bowman-Draft-Baseball", sport: "baseball", year: 2025, releaseYear: 2025, releaseMonth: 10 },
];

function httpsHead(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: "HEAD", headers: { "User-Agent": UA } }, (res) => {
      res.resume(); // discard body, HEAD has none anyway
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.on("error", () => resolve({ status: 0, headers: {} }));
    req.setTimeout(15_000, () => { req.destroy(); resolve({ status: 0, headers: {} }); });
    req.end();
  });
}

function httpsGetBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": UA } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Months to probe, centred on releaseMonth, +/- windowMonths, wrapping the
 *  year boundary. Returns [{year, month2}] oldest-first. */
function probeWindow(releaseYear, releaseMonth, windowMonths) {
  const out = [];
  for (let d = -windowMonths; d <= windowMonths; d++) {
    let m = releaseMonth + d;
    let y = releaseYear;
    while (m < 1) { m += 12; y -= 1; }
    while (m > 12) { m -= 12; y += 1; }
    out.push({ year: y, month2: String(m).padStart(2, "0") });
  }
  return out;
}

async function probeProduct(entry, windowMonths) {
  const stems = [...new Set([entry.fileNameOverride, entry.product].filter(Boolean))];
  const window = probeWindow(entry.releaseYear, entry.releaseMonth, windowMonths);
  // CF-BECKETT-S3-BURST-COUNTS-MONTHS-NOT-ATTEMPTS (2026-09-19). This counted
  // every (month, stem) HEAD as one unit, so a product with a fileNameOverride
  // (two stems tried per month) burned the burst budget in HALF as many
  // months as a product with one stem -- 2024 Panini Photogenic Football hit
  // the 6-consecutive-403 stop after only 3 real months (Oct/Oct/Nov/Nov/
  // Dec/Dec) and gave up one month before its real January 2025 hit. The
  // burst is meant to measure "how many CALENDAR MONTHS of guessing have come
  // back empty", not "how many requests", so it must reset per month (a HIT
  // on either stem clears it) rather than per request.
  let consecutive403Months = 0;
  for (const { year, month2 } of window) {
    let monthHadNon403 = false;
    for (const stem of stems) {
      const url = `${S3_BASE}/${year}/${month2}/${stem}-Checklist.xlsx`;
      if (DRY_RUN) { console.log(`  [dry-run] would probe ${url}`); continue; }
      const { status } = await httpsHead(url);
      console.log(`  ${status || "ERR"}  ${url}`);
      await sleep(RATE_LIMIT_MS);
      if (status === 200) return { url, year, month: month2 };
      if (status !== 403) monthHadNon403 = true;
    }
    if (DRY_RUN) continue;
    consecutive403Months = monthHadNon403 ? 0 : consecutive403Months + 1;
    if (consecutive403Months >= REPEATED_403_BURST) {
      console.log(`  -- ${REPEATED_403_BURST} consecutive months of nothing but 403, stopping this product's window (naming guess is likely wrong, not "not yet released")`);
      return null;
    }
  }
  return null;
}

async function main() {
  console.log(`[discover-s3] ${GAP_LIST.length} products in the gap list, window +/-4 months, rate limit ${RATE_LIMIT_MS}ms, burst-stop at ${REPEATED_403_BURST}`);
  if (DRY_RUN) console.log("[discover-s3] DRY RUN -- no requests will be made");

  const hits = [];
  const misses = [];
  for (const entry of GAP_LIST) {
    console.log(`\n=== ${entry.product} (${entry.sport} ${entry.year}, release ~${entry.releaseYear}-${String(entry.releaseMonth).padStart(2, "0")}) ===`);
    const found = await probeProduct(entry, 4);
    if (!found) { misses.push(entry); console.log(`  MISS: ${entry.product}`); continue; }

    if (DRY_RUN) { hits.push({ ...entry, url: "(dry-run, not fetched)" }); continue; }

    let bytes = null, sha256 = null;
    try {
      const buf = await httpsGetBuffer(found.url);
      bytes = buf.length;
      sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    } catch (e) {
      console.warn(`  could not fetch bytes for sha256/size: ${e.message}`);
    }

    hits.push({
      url: found.url,
      product: entry.product,
      sport: entry.sport,
      year: entry.year,
      bytes,
      sha256,
      fetchedAt: new Date().toISOString(),
    });
    console.log(`  HIT: ${found.url}  bytes=${bytes} sha256=${sha256}`);
  }

  console.log(`\n═══ SUMMARY ═══`);
  console.log(`hits: ${hits.length}/${GAP_LIST.length}`);
  for (const h of hits) console.log(`  FOUND  ${h.product}: ${h.url}`);
  console.log(`misses: ${misses.length}/${GAP_LIST.length}`);
  for (const m of misses) console.log(`  MISS   ${m.product}`);

  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), hits }, null, 2));
    console.log(`\n[discover-s3] manifest written: ${OUT}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
