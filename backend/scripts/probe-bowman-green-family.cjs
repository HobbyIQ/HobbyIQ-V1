#!/usr/bin/env node
/**
 * probe-bowman-green-family.cjs -- READ ONLY.
 *
 * Drew named GREEN specifically ("Green refractors and bases are mixed in").
 * Green, Green Refractor, Green Shimmer and Green Wave are FOUR DIFFERENT
 * CARDS at four different prices. This asks, per green-family slug in Bowman:
 * what do the TITLES of the rows sitting on it actually say?
 *
 * A slug is a collision when its rows carry more than one green reading, or
 * when a green slug holds rows whose titles name no finish at all (a base card
 * priced as a Green).
 *
 * Walks _ts windows (indexed range) rather than predicating on the slug --
 * sold_comps partitions on /cardId, so slug-shaped predicates are
 * cross-partition scans. No writes.
 */
"use strict";

const fs = require("fs");
const { CosmosClient } = require("@azure/cosmos");

const DB_NAME = process.env.COSMOS_DATABASE || "hobbyiq";
const CONTAINER = process.env.COSMOS_SOLD_COMPS_CONTAINER || "sold_comps";
const ROWS_PER_CHUNK = Number(process.env.ROWS_PER_CHUNK || 200000);
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 90);
const OUT = process.env.OUT || "/tmp/bowman-mix/green-family.json";
const started = Date.now();

const TEAM_NOISE = [/\bgreen\s+bay\b/gi, /\bbowling\s+green\b/gi, /\bgreene\b/gi];
const clean = (t) => { let s = String(t || "").toLowerCase(); for (const r of TEAM_NOISE) s = s.replace(r, " "); return s; };

/** The green reading a TITLE carries: which of the four cards it names. */
function titleGreen(title) {
  const t = clean(title);
  if (!/(?:^|[^a-z])green(?:[^a-z]|$)/.test(t)) {
    // no green at all -- does it name any finish?
    return /(?:^|[^a-z])(refractor|shimmer|wave|prizm|mojo|x-?fractor|lava|sapphire)(?:[^a-z]|$)/.test(t)
      ? "OTHER-FINISH-NO-GREEN" : "NO-FINISH-WORD";
  }
  if (/shimmer/.test(t)) return "green-shimmer";
  if (/wave/.test(t)) return "green-wave";
  if (/refractor/.test(t)) return "green-refractor";
  return "green";
}
function segGreen(seg) {
  const s = String(seg || "").toLowerCase();
  if (!/(^|-)green(-|$)/.test(s)) return null;
  if (/shimmer/.test(s)) return "green-shimmer";
  if (/wave/.test(s)) return "green-wave";
  if (/refractor/.test(s)) return "green-refractor";
  return "green";
}
const slugParts = (id) => {
  const s = String(id || "");
  if (!s.startsWith("hiq:")) return null;
  const p = s.split(":");
  return p.length >= 7 ? { setKey: p[3], parallel: (p[5] || "").toLowerCase() } : null;
};
const isBowman = (k) => /^bowman(-|$)/.test(String(k || ""));

async function retry(fn, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, Math.min(e?.retryAfterInMs || 400 * 2 ** i, 20000))); }
  }
  throw last;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const c = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } })
    .database(DB_NAME).container(CONTAINER);
  const q = async (query, parameters = []) => (await retry(() => c.items.query({ query, parameters }, { maxItemCount: 1000 }).fetchAll())).resources;
  const countIn = async (lo, hi) => Number((await q("SELECT VALUE COUNT(1) FROM c WHERE c._ts >= @lo AND c._ts < @hi", [{ name: "@lo", value: lo }, { name: "@hi", value: hi }]))[0] ?? 0);

  const minTs = Number((await q("SELECT VALUE MIN(c._ts) FROM c"))[0] ?? 0);
  const maxTs = Number((await q("SELECT VALUE MAX(c._ts) FROM c"))[0] ?? 0);
  const grand = await countIn(minTs, maxTs + 1);
  console.log(`corpus ${grand.toLocaleString()} rows`);
  const chunks = [];
  async function plan(lo, hi, n) {
    if (n <= ROWS_PER_CHUNK || hi - lo <= 1) { if (n > 0) chunks.push([lo, hi]); return; }
    const mid = Math.floor((lo + hi) / 2); const a = await countIn(lo, mid);
    await plan(lo, mid, a); await plan(mid, hi, n - a);
  }
  await plan(minTs, maxTs + 1, grand);
  console.log(`plan ${chunks.length} chunks`);

  const perSlug = new Map();   // greenSlug -> Map(titleReading -> {n, prices[]})
  let seen = 0, done = 0;
  for (const [lo, hi] of chunks) {
    if ((Date.now() - started) / 60000 > RUN_MINUTES) { console.log("budget reached"); break; }
    const it = c.items.query({
      query: "SELECT c.hobbyiqCardId, c.cardId, c.title, c.price, c.source FROM c WHERE c._ts >= @lo AND c._ts < @hi",
      parameters: [{ name: "@lo", value: lo }, { name: "@hi", value: hi }],
    }, { maxItemCount: 1000 });
    while (it.hasMoreResults()) {
      const page = await retry(() => it.fetchNext());
      for (const r of (page.resources || [])) {
        seen++;
        for (const idf of [r.hobbyiqCardId, r.cardId]) {
          const p = slugParts(idf);
          if (!p || !isBowman(p.setKey)) continue;
          const g = segGreen(p.parallel);
          if (!g) continue;
          let m = perSlug.get(idf);
          if (!m) { m = new Map(); perSlug.set(idf, m); }
          const reading = titleGreen(r.title);
          let e = m.get(reading);
          if (!e) { e = { n: 0, prices: [], sources: {} }; m.set(reading, e); }
          e.n++; if (Number.isFinite(r.price)) e.prices.push(r.price);
          e.sources[r.source || "?"] = (e.sources[r.source || "?"] || 0) + 1;
          break;
        }
      }
    }
    done++;
    if (done % 10 === 0) console.log(`  ${done}/${chunks.length} seen ${seen.toLocaleString()} greenSlugs ${perSlug.size}`);
  }

  const med = (a) => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
  const collisions = [];
  let totalGreenSlugs = 0, totalGreenRows = 0, silentRows = 0;
  for (const [slug, m] of perSlug) {
    totalGreenSlugs++;
    const readings = [...m.entries()].map(([k, v]) => ({ reading: k, n: v.n, medianPrice: med(v.prices), sources: v.sources }));
    const rows = readings.reduce((s, r) => s + r.n, 0);
    totalGreenRows += rows;
    const silent = m.get("NO-FINISH-WORD")?.n ?? 0;
    silentRows += silent;
    const distinctGreen = readings.filter((r) => /^green/.test(r.reading)).length;
    if (distinctGreen > 1 || (silent > 0 && rows > silent)) {
      collisions.push({ slug, slugGreen: segGreen(slugParts(slug).parallel), rows, silent, readings: readings.sort((a, b) => b.n - a.n) });
    }
  }
  collisions.sort((a, b) => b.rows - a.rows);
  const out = {
    generatedAt: new Date().toISOString(), readOnly: true, scanned: seen,
    greenSlugs: totalGreenSlugs, greenRows: totalGreenRows, titleSilentRowsOnGreenSlugs: silentRows,
    collisionSlugs: collisions.length, top: collisions.slice(0, 60),
  };
  fs.mkdirSync(require("path").dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${OUT}`);
  console.log(`green slugs ${totalGreenSlugs}  green rows ${totalGreenRows}  title-silent on green slugs ${silentRows}  COLLISION slugs ${collisions.length}`);
}
main().catch((e) => { console.error("FATAL", e?.message || e); process.exit(9); });
