#!/usr/bin/env node
/**
 * measure-bowman-base-refractor-mix.cjs -- READ ONLY.
 *
 * CF-BASES-ARE-MIXED-IN-WITH-REFRACTORS (Drew, 2026-09-03: "Green refractors
 * and bases are mixed in. This is a systematic issue. Bases are mixed in with
 * refractors in ALL of Bowman.")
 *
 * Prior work closed one-off row-repair lanes (Gonzalez, Caglianone,
 * four-values) in favour of the GREAT REMATCH. Drew's claim is that the shape
 * is not a handful of cards but the whole Bowman corpus. This script measures
 * that claim over sold_comps and writes NOTHING.
 *
 * WHAT IS MEASURED, AND WHY IT IS THREE INDEPENDENT FIELDS
 *
 * Parallel identity comes from the checklist and from the TITLE's finish
 * evidence -- never from the product name. "Bowman Chrome" is NOT evidence of
 * Refractor: a paper Bowman base, a Chrome base and a Refractor are three
 * different cards. So each row is read on three axes that should agree:
 *
 *   1. the SLUG's parallel segment   (hiq:sport:year:set:num:PARALLEL:auto...)
 *   2. the TITLE's finish evidence   (tokenized from the sale title text)
 *   3. the STORED parallel field     (what the row itself claims)
 *
 * BASE-IN-REFRACTOR is the shape from rematch-classify's BASE-EVICTION
 * subclass: the slug carries a finish, the title names none, and the stored
 * parallel field says Base or blank. Three fields, and only the slug -- an
 * artifact of whichever writer keyed the row -- claims a finish.
 *
 * WHY A _ts WALK AND NOT A PREDICATE ON setKey
 *
 * sold_comps is partitioned on /cardId. A field-vs-field predicate or a
 * STARTSWITH on a slug is a cross-partition scan of 16M rows and will not come
 * back. `_ts` is indexed, so the corpus is walked in row-balanced `_ts` range
 * windows and Bowman rows are selected IN PROCESS from the projection. Every
 * Cosmos predicate here is an indexed equality or an indexed range.
 *
 * GREEN IS THE NAMED CASE. Green, Green Refractor, Green Shimmer and Green
 * Wave are DISTINCT parallels. Co-residency of more than one of those title
 * evidences under ONE slug is counted separately, because that is the
 * collision Drew can see in the app.
 *
 * ENV: COSMOS_CONNECTION_STRING (required), ROWS_PER_CHUNK, RUN_MINUTES,
 *      SLOT/SLOTS, LIMIT, OUT.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { CosmosClient } = require("@azure/cosmos");

const DB_NAME = process.env.COSMOS_DATABASE || "hobbyiq";
const CONTAINER = process.env.COSMOS_SOLD_COMPS_CONTAINER || "sold_comps";
const ROWS_PER_CHUNK = Number(process.env.ROWS_PER_CHUNK || 150000);
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 100);
const SLOT = Number(process.env.SLOT || 0);
const SLOTS = Number(process.env.SLOTS || 1);
const LIMIT = Number(process.env.LIMIT || 0);
const OUT = process.env.OUT || "/tmp/bowman-mix";
const started = Date.now();
const f = (n) => Number(n).toLocaleString("en-US");

// -- vocabulary ------------------------------------------------------------
/** Finish words that count as TITLE EVIDENCE of a non-base parallel. A word
 *  here in the title means the seller named a finish. NOTE "chrome" is
 *  deliberately ABSENT: Chrome is a PRODUCT, not a finish, and treating it as
 *  finish evidence is exactly the error being measured. */
const FINISH_WORDS = [
  "superfractor", "x-fractor", "xfractor", "atomic", "pulsar",
  "refractor", "refractors", "shimmer", "wave", "prism", "prizm", "mojo",
  "lava", "speckle", "sparkle", "foilboard", "raywave",
  "vector", "logofractor", "moonshot", "aqua", "fuchsia", "magenta",
];
/**
 * CF-A-PRODUCT-IS-NOT-A-FINISH (measured 2026-09-03, first full sample).
 * "Sapphire" and "Platinum" are BOWMAN PRODUCTS -- Bowman Chrome Sapphire
 * Edition, Bowman Platinum -- exactly as "Chrome" is, and for the same reason
 * "Chrome" was excluded from FINISH_WORDS from the start.
 *
 * Counting them as finish evidence produced 10,593 phantom reverse rows in a
 * 1.2M-row sample (sapphire 7,865 + platinum 2,728 of 36,280 = 29%), and the
 * giveaway was that 6,356 of them already sat on a `bowman-chrome-sapphire`
 * setKey: the title said "Sapphire Edition", the slug said the sapphire
 * PRODUCT, and the two agreed perfectly. Nothing was mis-filed at all.
 *
 * They stay in COLOUR/finish detection nowhere, but remain recognisable to
 * the slug side, because a slug segment `sapphire-refractor` IS a parallel.
 */
const PRODUCT_NOT_FINISH = ["sapphire", "platinum", "chrome"];
/** Colour words. A colour in a title is finish evidence on a Chrome product
 *  (Colour = Refractor is a PER-CARD ruling) but is reported as its own class
 *  so a "green" title and a "green refractor" title are never merged. */
const COLOUR_WORDS = [
  "green", "gold", "blue", "orange", "red", "purple", "black", "silver",
  "pink", "yellow", "teal", "bronze", "platinum", "sepia", "citrine",
  "amethyst", "ruby", "emerald", "lime", "rose", "peach", "indigo",
];
/** Slug parallel segments that are BASE, i.e. claim no finish. */
const BASE_SEGMENTS = new Set(["base", "", "no-parallel", "none"]);

/**
 * CF-A-TEAM-NAME-IS-NOT-A-FINISH (measured on the smoke run, 2026-09-03).
 * The first pass read "Boston Red Sox" as a Red parallel and "1953 Bowman
 * Black & White" as a Black parallel. In a 200-row sample of the reverse
 * class, 51 of 200 (25%) were exactly that: team names (Red Sox, White Sox,
 * Blue Jays, Reds) and the 1953 Bowman Black & White SUBSET -- which is a
 * product subset, not a colour parallel.
 *
 * These are stripped BEFORE tokenizing, not filtered after, because the
 * suppression matters in both directions: a genuine Green Refractor sold by
 * a Red Sox prospect must still read as Green, and a base card whose title
 * says only "Red Sox" must still read as NO-FINISH-WORD.
 */
const TEAM_AND_SUBSET_NOISE = [
  /\bred\s+sox\b/g, /\bwhite\s+sox\b/g, /\bblue\s+jays\b/g,
  /\bcincinnati\s+reds\b/g, /\bthe\s+reds\b/g,
  /\bblack\s*(?:&|and)\s*white\b/g,   // 1953 Bowman B&W subset
  /\bblackhawks\b/g, /\bredskins\b/g, /\bredbirds\b/g,
  /\bgolden\s+(?:state|knights|bears|gophers|hurricanes|eagles|flashes)\b/g,
  /\bgold\s+glove\b/g, /\bsilver\s+slugger\b/g,
  /\bgreen\s+bay\b/g, /\bbowling\s+green\b/g,
  /\bbrowns\b/g, /\borange\s+bowl\b/g, /\bsyracuse\s+orange\b/g,
];
const stripNoise = (s) => {
  let t = String(s || "").toLowerCase()
    .replace(/[^a-z0-9\s/#&-]+/g, " ").replace(/\s+/g, " ").trim();
  for (const re of TEAM_AND_SUBSET_NOISE) t = t.replace(re, " ");
  return t.replace(/\s+/g, " ").trim();
};

const escapeRe = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

/** The finish evidence a TITLE carries, as a sorted token list. */
function titleEvidence(title) {
  const t = stripNoise(title);
  if (!t) return { finishes: [], colours: [], label: "NO-TITLE" };
  const fset = new Set();
  for (const w of FINISH_WORDS) {
    const re = new RegExp(`(?:^|[^a-z])${escapeRe(w)}(?:[^a-z]|$)`);
    if (re.test(t)) {
      fset.add(w === "refractors" ? "refractor" : w === "xfractor" ? "x-fractor" : w);
    }
  }
  const cset = new Set();
  for (const c of COLOUR_WORDS) {
    const re = new RegExp(`(?:^|[^a-z])${c}(?:[^a-z]|$)`);
    if (re.test(t)) cset.add(c);
  }
  const label = fset.size === 0 && cset.size === 0
    ? "NO-FINISH-WORD"
    : [...[...cset].sort(), ...[...fset].sort()].join("+");
  return { finishes: [...fset].sort(), colours: [...cset].sort(), label };
}

/** hiq slug -> components. Returns null when the id is not an hiq slug (a
 *  vendor partition key -- see split-identity.cjs; a foreign key is not a
 *  claim about the card). */
function slugParts(id) {
  const s = String(id || "");
  if (!s.startsWith("hiq:")) return null;
  const p = s.split(":");
  if (p.length < 7) return null;
  return { sport: p[1], year: p[2], setKey: p[3], cardNumber: p[4], parallel: p[5] || "", rest: p.slice(6) };
}

const isBowman = (setKey) => /^bowman(-|$)/.test(String(setKey || ""));

/** The slug parallel segment claims a refractor / colour-refractor finish. */
function slugClaimsFinish(seg) {
  const s = String(seg || "").toLowerCase();
  if (BASE_SEGMENTS.has(s)) return false;
  const toks = s.split("-").filter(Boolean);
  if (toks.some((t) => FINISH_WORDS.includes(t) || t === "refractor")) return true;
  if (toks.some((t) => COLOUR_WORDS.includes(t))) return true;
  // On the SLUG side a bare product word in the parallel segment IS a
  // parallel claim (`…:sapphire-refractor:…`), even though the same word in a
  // TITLE is only the product's name. The asymmetry is the point.
  if (toks.length > 1 && toks.some((t) => PRODUCT_NOT_FINISH.includes(t))) return true;
  return false;
}

/**
 * CF-A-PRINTING-PLATE-IS-NOT-A-FINISH (measured 2026-09-03). A 1/1 printing
 * plate sitting under a plain-auto title IS a mis-filing -- but it is a
 * CARD-TYPE mis-filing, not the finish-mixing Drew named, and 1,537 of them
 * in one sample would have been half the headline number. They are counted in
 * their own class so the two defects cannot be confused for one.
 */
const CARD_TYPE_NOT_FINISH = /printing-plate|printing-plates|buyback|cut-signature|relic|patch|booklet/;
function segIsCardType(seg) {
  return CARD_TYPE_NOT_FINISH.test(String(seg || "").toLowerCase());
  return false;
}

/** Green-family membership of a slug segment or title label. */
function greenFamily(seg) {
  const s = String(seg || "").toLowerCase();
  if (!/(^|[^a-z])green([^a-z]|$)/.test(s)) return null;
  if (/shimmer/.test(s)) return "green-shimmer";
  if (/wave/.test(s)) return "green-wave";
  if (/refractor/.test(s)) return "green-refractor";
  return "green";
}

const norm = (v) => { const s = String(v ?? "").trim(); return s ? s : ""; };
const isBaseField = (v) => { const s = norm(v).toLowerCase(); return s === "" || s === "base" || s === "none"; };

async function retry(fn, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const ms = e?.code === 429 ? (e?.retryAfterInMs || 1000) : 400 * Math.pow(2, i);
      await new Promise((r) => setTimeout(r, Math.min(ms, 20000)));
    }
  }
  throw last;
}

// -- accumulators ----------------------------------------------------------
const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
const matrix = new Map();
const baseInRefr = { total: 0, bySource: new Map(), byYear: new Map(), byProduct: new Map(), bySlugParallel: new Map() };
const reverse = { total: 0, bySource: new Map(), byYear: new Map(), byProduct: new Map(), byTitleLabel: new Map() };
const slugGreenEvidence = new Map();
/** CF-A-ROW-COUNT-IS-NOT-A-CARD-COUNT. One eBay listing re-ingested by several
 *  vendors, or one card sold repeatedly, produces many rows of the SAME shape:
 *  the smoke run's largest single contributor was 11 identical Vladimir
 *  Guerrero Jr. rows on one `blue` /150 slug. The row count is the pool damage
 *  (every one of those rows prices the card) but the DISTINCT SLUG count is the
 *  blast radius in cards, and the two are reported separately so neither can be
 *  mistaken for the other. */
const baseInRefrSlugs = new Set();
const cardTypeMisfile = { total: 0, bySource: new Map(), byProduct: new Map(), bySlugParallel: new Map() };
const reverseSlugs = new Set();
const samples = { baseInRefractor: [], reverse: [], greenCollision: [] };
const bowmanTotals = { rowsScanned: 0, bowmanRows: 0, finishSlugRows: 0, baseSlugRows: 0, nonHiq: 0, adjudicatedInBaseInRefr: 0 };
const perSourceBowman = new Map();

function record(row) {
  bowmanTotals.rowsScanned++;
  const hiq = norm(row.hobbyiqCardId);
  const cid = norm(row.cardId);
  // The exact-pool reader ORs cardId and hobbyiqCardId, so a row is read into
  // whichever of the two is an hiq slug. Measure BOTH identity fields.
  const idsRaw = [hiq, cid].filter(Boolean);
  const parsedIds = idsRaw.map((s) => ({ s, p: slugParts(s) })).filter((x) => x.p);
  if (parsedIds.length === 0) { bowmanTotals.nonHiq++; return; }
  const bow = parsedIds.filter((x) => isBowman(x.p.setKey));
  if (bow.length === 0) return;
  bowmanTotals.bowmanRows++;

  const src = norm(row.source) || "unknown";
  bump(perSourceBowman, src);
  const ev = titleEvidence(row.title);
  const storedPar = norm(row.parallel);
  const storedRun = row.printRun ?? null;
  const adjudicated = row.flaggedWrong === true || row.excludedFromFmv === true;

  const seenSeg = new Set();
  for (const { s: fullSlug, p } of bow) {
    const year = p.year || "?";
    const product = p.setKey;
    const seg = (p.parallel || "").toLowerCase();
    // one row can carry the same parallel on both fields; count the shape once
    const dedupeKey = `${product}|${seg}`;
    if (seenSeg.has(dedupeKey)) continue;
    seenSeg.add(dedupeKey);

    const slugFin = slugClaimsFinish(seg);
    bump(matrix, `${seg || "(blank)"}|${ev.label}|${src}|${year}`);

    if (slugFin) {
      bowmanTotals.finishSlugRows++;
      const gf = greenFamily(seg);
      if (gf) {
        let st = slugGreenEvidence.get(fullSlug);
        if (!st) { st = new Set(); slugGreenEvidence.set(fullSlug, st); }
        const tg = greenFamily(ev.label.replace(/\+/g, "-"));
        st.add(tg || (ev.label === "NO-FINISH-WORD" ? "NO-FINISH-WORD" : ev.label));
      }
      // BASE-IN-REFRACTOR: slug claims a finish, title names NONE, stored
      // parallel field says Base/blank. Three independent fields agreeing.
      if (ev.label === "NO-FINISH-WORD" && isBaseField(storedPar)) {
        if (segIsCardType(seg)) {
          cardTypeMisfile.total++;
          bump(cardTypeMisfile.bySource, src);
          bump(cardTypeMisfile.byProduct, product);
          bump(cardTypeMisfile.bySlugParallel, seg);
          continue;
        }
        baseInRefr.total++;
        baseInRefrSlugs.add(fullSlug);
        if (adjudicated) bowmanTotals.adjudicatedInBaseInRefr++;
        bump(baseInRefr.bySource, src);
        bump(baseInRefr.byYear, year);
        bump(baseInRefr.byProduct, product);
        bump(baseInRefr.bySlugParallel, seg);
        if (samples.baseInRefractor.length < 400) {
          samples.baseInRefractor.push({
            id: row.id, cardId: cid, hobbyiqCardId: hiq, source: src, year, product,
            slugParallel: seg, storedParallel: storedPar, printRun: storedRun,
            title: String(row.title || "").slice(0, 200), soldAt: row.soldAt, price: row.price,
            flaggedWrong: row.flaggedWrong ?? null, excludedFromFmv: row.excludedFromFmv ?? null,
          });
        }
      }
    } else {
      bowmanTotals.baseSlugRows++;
      // REVERSE: slug says base, title DOES name a finish.
      if (ev.label !== "NO-FINISH-WORD" && ev.label !== "NO-TITLE") {
        reverse.total++;
        reverseSlugs.add(fullSlug);
        bump(reverse.bySource, src);
        bump(reverse.byYear, year);
        bump(reverse.byProduct, product);
        bump(reverse.byTitleLabel, ev.label);
        if (samples.reverse.length < 200) {
          samples.reverse.push({
            id: row.id, hobbyiqCardId: hiq, cardId: cid, source: src, year, product,
            slugParallel: seg || "(blank)", storedParallel: storedPar,
            titleEvidence: ev.label, title: String(row.title || "").slice(0, 200),
          });
        }
      }
    }
  }
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const pool = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database(DB_NAME).container(CONTAINER);

  const q = async (query, parameters = [], maxItemCount = 1000) =>
    (await retry(() => pool.items.query({ query, parameters }, { maxItemCount }).fetchAll())).resources;
  const countIn = async (lo, hi) => Number((await q(
    "SELECT VALUE COUNT(1) FROM c WHERE c._ts >= @lo AND c._ts < @hi",
    [{ name: "@lo", value: lo }, { name: "@hi", value: hi }]))[0] ?? 0);

  console.log(`measure-bowman-base-refractor-mix  READ ONLY  slot ${SLOT}/${SLOTS}  budget ${RUN_MINUTES}m`);
  const minTs = Number((await q("SELECT VALUE MIN(c._ts) FROM c"))[0] ?? 0);
  const maxTs = Number((await q("SELECT VALUE MAX(c._ts) FROM c"))[0] ?? 0);
  if (!minTs || !maxTs) { console.error("FATAL: no _ts bounds — refusing to report a measurement of nothing"); process.exit(3); }
  const grand = await countIn(minTs, maxTs + 1);
  console.log(`corpus  ${f(grand)} rows  _ts ${minTs}..${maxTs}`);

  // row-balanced chunk plan by bisection on the indexed _ts
  const chunks = [];
  async function plan(lo, hi, n) {
    if (n <= ROWS_PER_CHUNK || hi - lo <= 1) { if (n > 0) chunks.push([lo, hi, n]); return; }
    const mid = Math.floor((lo + hi) / 2);
    const a = await countIn(lo, mid);
    await plan(lo, mid, a);
    await plan(mid, hi, n - a);
  }
  await plan(minTs, maxTs + 1, grand);
  const mine = chunks.filter((_, i) => i % SLOTS === SLOT);
  const myRows = mine.reduce((s, c) => s + c[2], 0);
  console.log(`plan    ${f(chunks.length)} chunks; slot owns ${f(mine.length)} = ${f(myRows)} rows\n`);

  let done = 0, seen = 0;
  for (const [lo, hi] of mine) {
    if ((Date.now() - started) / 60000 > RUN_MINUTES) { console.log("budget reached — stopping"); break; }
    if (LIMIT && seen >= LIMIT) break;
    const it = pool.items.query({
      query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.source, c.title, c.parallel, c.printRun, c.soldAt, c.price, c.flaggedWrong, c.excludedFromFmv FROM c WHERE c._ts >= @lo AND c._ts < @hi",
      parameters: [{ name: "@lo", value: lo }, { name: "@hi", value: hi }],
    }, { maxItemCount: 1000 });
    while (it.hasMoreResults()) {
      if (LIMIT && seen >= LIMIT) break;
      const page = await retry(() => it.fetchNext());
      for (const row of (page.resources || [])) { record(row); seen++; }
    }
    done++;
    if (done % 5 === 0 || done === mine.length) {
      const el = ((Date.now() - started) / 60000).toFixed(1);
      console.log(`  chunk ${done}/${mine.length}  ${el}m  seen ${f(seen)}  bowman ${f(bowmanTotals.bowmanRows)}  base-in-refr ${f(baseInRefr.total)}  reverse ${f(reverse.total)}`);
    }
  }

  // -- green-family collisions: one slug, more than one green reading -------
  const greenCollisions = [];
  for (const [slug, evs] of slugGreenEvidence) {
    const real = [...evs].filter((e) => e !== "NO-TITLE");
    const distinctGreen = new Set(real.filter((e) => /^green/.test(e)));
    const hasSilent = real.includes("NO-FINISH-WORD");
    if (distinctGreen.size > 1 || (distinctGreen.size >= 1 && hasSilent)) {
      greenCollisions.push({ slug, evidences: real.sort() });
    }
  }
  greenCollisions.sort((a, b) => b.evidences.length - a.evidences.length);
  samples.greenCollision = greenCollisions.slice(0, 100);

  const top = (m, k = 40) => Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k));
  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    corpusRows: grand,
    scanned: seen,
    totals: { ...bowmanTotals, perSourceBowman: top(perSourceBowman, 20) },
    matrix: top(matrix, 400),
    baseInRefractor: {
      total: baseInRefr.total,
      distinctSlugs: baseInRefrSlugs.size,
      bySource: top(baseInRefr.bySource, 20),
      byYear: top(baseInRefr.byYear, 30),
      byProduct: top(baseInRefr.byProduct, 20),
      bySlugParallel: top(baseInRefr.bySlugParallel, 40),
    },
    cardTypeMisfile: {
      total: cardTypeMisfile.total,
      bySource: top(cardTypeMisfile.bySource, 20),
      byProduct: top(cardTypeMisfile.byProduct, 20),
      bySlugParallel: top(cardTypeMisfile.bySlugParallel, 20),
    },
    reverse: {
      total: reverse.total,
      distinctSlugs: reverseSlugs.size,
      bySource: top(reverse.bySource, 20),
      byYear: top(reverse.byYear, 30),
      byProduct: top(reverse.byProduct, 20),
      byTitleEvidence: top(reverse.byTitleLabel, 40),
    },
    greenCollisions: { slugs: greenCollisions.length, top: greenCollisions.slice(0, 60) },
    samples,
  };
  const outFile = path.join(OUT, `bowman-mix-slot${SLOT}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${outFile}`);
  console.log(`BOWMAN rows ${f(bowmanTotals.bowmanRows)}  finish-slug ${f(bowmanTotals.finishSlugRows)}  base-slug ${f(bowmanTotals.baseSlugRows)}`);
  console.log(`BASE-IN-REFRACTOR ${f(baseInRefr.total)} rows / ${f(baseInRefrSlugs.size)} slugs   CARD-TYPE ${f(cardTypeMisfile.total)}   REVERSE ${f(reverse.total)} rows / ${f(reverseSlugs.size)} slugs   GREEN-COLLISION slugs ${f(greenCollisions.length)}`);
}

main().catch((e) => { console.error("FATAL", e?.message || e); process.exit(9); });
