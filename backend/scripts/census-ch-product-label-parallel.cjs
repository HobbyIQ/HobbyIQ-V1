#!/usr/bin/env node
/**
 * census-ch-product-label-parallel.cjs -- how far does "the CardHedge PRODUCT's
 * label became the SALE's parallel" reach?
 *
 * READ ONLY. There is no write path in this file, in any mode. `apply` is
 * irrelevant to it and is deliberately ignored.
 *
 * ── THE QUESTION ────────────────────────────────────────────────────────────
 *
 * One product is proven: CardHedge 1778540428361x447194681698603460 is labelled
 * "Black & White Red Ink" in CardHedge's catalog, our historical backfill
 * copied that PRODUCT label onto every SALE of it, and 56 plain base autos
 * (median $10) ended up keyed to
 * `hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink-refractor:auto`,
 * pooling with Drew's genuine $270 Red Ink purchase.
 *
 * The doctrine the ingest violated is CF-THE-ENGINE-CONSUMES-CH-SALES-NOT-CH-
 * PRODUCT-FIELDS, and a doctrine violated at a keying step is never violated
 * once. This census sizes the lane: HOW MANY CardHedge products wear a label
 * their own sales' titles never say?
 *
 * ── HOW A PRODUCT IS JUDGED ─────────────────────────────────────────────────
 *
 * Rows are grouped by the CH PRODUCT ID, which is not a field of its own --
 * `vendorCardId` is null on every one of these rows. It is the first segment of
 * the composite key the historical backfill mints:
 *
 *     id                cardhedge::<productId>::<date>::<cents>::<grade>
 *     sourceExternalId  <productId>::<date>::<cents>::<grade>
 *
 * `ch-daily::<price_history_id>` rows carry no product id: that is the OTHER
 * CardHedge writer, which reads the title, and it is out of scope by
 * construction rather than by filter.
 *
 * For each product the census computes a WITNESS RATE: of its sales whose
 * stored slug names a parallel, what share carry no title witness for that
 * parallel? The witness test is the rematch classifier's own
 * `titleEchoesSlugParallel` plus its `titleNamesFinish` backstop, via
 * lib/ch-product-label.cjs -- the SAME predicate the repair lane asserts, so a
 * product the census calls SUSPECT is one the repair can actually act on. No
 * new vocabulary is introduced anywhere in this lane.
 *
 * A product is SUSPECT when ALL of:
 *
 *   - it has at least MIN_ROWS sales in the pool (default 5). Below that the
 *     rate is not a rate. This is a REPORTING floor, and small products are
 *     still counted and listed under `belowFloor` -- never dismissed
 *     (CF-NEVER-DISMISS-SMALL-NUMBERS-AS-NOISE).
 *   - at least SUSPECT_PCT of those sales carry NO witness (default 80). The
 *     threshold is high on purpose: this lane is looking for a product whose
 *     label was STAMPED on every sale, which shows up as a near-total absence
 *     of witnesses, not as a mixed pool. A genuinely-labelled parallel product
 *     has most of its titles saying so.
 *   - the derived destination is CHECKLIST-BACKED and DIFFERENT. A product
 *     with nowhere legitimate to send its rows is reported, never actioned.
 *
 * ── HOW IT READS ────────────────────────────────────────────────────────────
 *
 * Paged reads only (`fetchNext` with a continuation token), never a
 * cross-partition COUNT over the corpus -- 16.4M rows is minutes of RU and the
 * runner has a ceiling. The scan is bounded by its OWN clock (RUN_MINUTES,
 * default 140, under the runner's 150-minute step timeout) and prints the
 * budget marker so a relaunch can continue.
 *
 * Sharding is OPT-IN (CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD): the runner
 * exports `slot=0 slots=16` as workflow-wide DEFAULTS, so an inherited pair
 * cannot be told from a chosen one and means EVERY ROW here. A non-zero slot,
 * or SHARD=true for slot 0 of a real fan-out, is what shards.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   YEARS / SPORTS            the sample scope (e.g. YEARS=2025,2026 SPORTS=baseball)
 *   SETKEYS / SCOPE           optional setKey narrowing; the runner's inherited
 *                             default "refractor" is IGNORED, not obeyed
 *   MIN_ROWS                  reporting floor for a rate (default 5)
 *   SUSPECT_PCT               witness-absence threshold (default 80)
 *   LIMIT                     stop after N rows scanned (a bounded local probe)
 *   SLOT / SLOTS / SHARD      opt-in sharding
 *   RUN_MINUTES               own budget (default 140)
 *   CENSUS_OUT                where the JSON lands (default /tmp/ch-product-label-census)
 */
"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const backend = path.resolve(__dirname, "..");
const L = require(path.join(__dirname, "lib", "ch-product-label.cjs"));
const K = require(path.join(__dirname, "lib", "rematch-classify.cjs"));
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809): the one exit path.
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const str = (v) => String(v ?? "").trim();
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const csv = (v) => String(v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const YEARS = csv(process.env.YEARS || process.env.YEAR).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const SPORTS = csv(process.env.SPORTS || process.env.SPORT);
const SETKEYS = csv(process.env.SETKEYS || process.env.SETKEY || process.env.SCOPE)
  .filter((s) => s !== "refractor" && s !== "all");

const MIN_ROWS = Math.max(1, Number(process.env.MIN_ROWS || 5));
const SUSPECT_PCT = Math.max(1, Number(process.env.SUSPECT_PCT || 80));
const LIMIT = Number(process.env.LIMIT || 0);
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RUN_MS = RUN_MINUTES * 60000;
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top: a unit costing more than
 *  this is stopped BEFORE it starts. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 2 * 60 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const OUT_DIR = process.env.CENSUS_OUT || "/tmp/ch-product-label-census";
const STARTED = Date.now();

// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (2026-09-04). See the header.
const rawSlot = str(process.env.SLOT);
const rawSlots = str(process.env.SLOTS);
const SLOT = Number(rawSlot || 0);
const SLOTS_REQUESTED = Math.max(1, Number(rawSlots || 1));
const SHARD_OPT_IN = /^(1|true|yes)$/i.test(str(process.env.SHARD));
const SHARDED = SLOTS_REQUESTED > 1 && Number.isFinite(SLOT) && (SLOT > 0 || SHARD_OPT_IN);
const SLOTS = SHARDED ? SLOTS_REQUESTED : 1;
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SLOTS;
const mineByShard = (key) => !SHARDED || shardOf(str(key)) === SLOT;

const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|Request timed out/i.test(msg) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000);
    }
  }
};

async function forEachPage(container, spec, onPage, pageSize = 400) {
  let token;
  do {
    const page = await retry(() => container.items
      .query(spec, { maxItemCount: pageSize, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    if ((await onPage(page.resources ?? [])) === false) return;
  } while (token);
}

const median = (xs) => {
  const a = xs.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : Math.round(((a[m - 1] + a[m]) / 2) * 100) / 100;
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(2); }

  // THE SCOPE BANNER. A run says what it bound before it reads anything, so a
  // log can be read back and the scope confirmed rather than assumed
  // (CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME; a report has the same duty).
  console.log("");
  console.log("=".repeat(78));
  console.log("  CENSUS: the CardHedge PRODUCT label became the SALE parallel");
  console.log("  READ ONLY -- this script has no write path in any mode.");
  console.log("=".repeat(78));
  console.log(`  sports        ${SPORTS.length ? SPORTS.join(",") : "(every sport)"}`);
  console.log(`  years         ${YEARS.length ? YEARS.join(",") : "(every year)"}`);
  console.log(`  setKeys       ${SETKEYS.length ? SETKEYS.join(",") : "(every setKey)"}`);
  console.log(`  shard         ${SHARDED ? `slot ${SLOT}/${SLOTS} (opt-in)` : "ALL ROWS (no shard opted in)"}`);
  console.log(`  suspect at    >= ${SUSPECT_PCT}% of sales with NO title witness, min ${MIN_ROWS} rows`);
  console.log(`  budget        ${Math.round(RUN_MS / 60000)} min`);
  console.log(`  limit         ${LIMIT ? f(LIMIT) + " rows scanned" : "(none)"}`);
  console.log("");

  const { CosmosClient } = require("@azure/cosmos");
  const client = new CosmosClient(conn);
  const db = client.database("hobbyiq");
  const pool = db.container("sold_comps");
  const catalog = db.container("card_catalog");

  // ── the checklist-backed verdict, cached ──────────────────────────────────
  // One point-read per DESTINATION slug, not per row: a product's sales all
  // derive to the same handful of destinations, so the cache turns thousands
  // of reads into a few.
  const backedCache = new Map();
  async function checklistBacked(slug) {
    const s = str(slug);
    if (!s) return false;
    if (backedCache.has(s)) return backedCache.get(s);
    let row = null;
    try { row = (await retry(() => catalog.item(s, s).read())).resource ?? null; }
    catch (e) { if (e?.code !== 404 && e?.statusCode !== 404) throw e; }
    const named = [row?.source, row?.sourceSystem, ...(Array.isArray(row?.sources) ? row.sources : [])];
    const backed = !!row && (named.some((x) => K.isStrictChecklistSource(x)) || row.checklistBacked === true);
    backedCache.set(s, backed);
    return backed;
  }

  /**
   * THE DESTINATION for a product-label row: the same identity with the
   * parallel dropped to base.
   *
   * Deliberately a SEGMENT REWRITE of the stored slug rather than a full
   * re-derivation from the title. The stored slug's other axes (sport, year,
   * setKey, cardNumber, auto flag, grade) are not what this lane disputes --
   * only the parallel is -- and a re-derivation would silently drag any other
   * parser disagreement along with the repair. Surgery, never a recompute:
   * the same discipline D28 applies. A row whose OTHER axes are also wrong is
   * the rematch's business, not this lane's.
   */
  function baseDestinationOf(slug) {
    const parts = str(slug).split(":");
    if (parts[0] !== "hiq" || parts.length < 7) return null;
    const out = parts.slice();
    out[5] = "base";
    // A print run belongs to the parallel that carried it. Dropping to base
    // drops the serial with it -- a base auto is not numbered.
    const tail = out.slice(7).filter((seg) => !/^num-\d+$/.test(seg));
    return out.slice(0, 7).concat(tail).join(":");
  }

  // THE READ IS NARROWED SERVER-SIDE TO THE WRITER IN QUESTION.
  //
  // Only the historical backfill mints a key whose first segment is the CH
  // PRODUCT id; the CH-daily writer mints `ch-daily::<price_history_id>` and
  // the bulk import `ch-fill`. Measured on the 2026 baseball scope: without
  // this clause the scan walked 594,061 rows to classify 216 -- 99.96% of the
  // RU spent reading rows that cannot be in scope by construction.
  //
  // `NOT STARTSWITH` on the two known non-product prefixes is used rather than
  // a positive match on the product shape, because Cosmos SQL has no regex and
  // the product id is a Bubble `<digits>x<digits>` that no prefix can express.
  // The client-side `chProductIdOf` still asserts the shape on every row that
  // survives, so this clause is an RU optimisation and never the guard.
  const where = [
    "c.source = 'cardhedge'",
    "NOT STARTSWITH(c.sourceExternalId, 'ch-daily::')",
    "NOT STARTSWITH(c.sourceExternalId, 'ch-fill')",
  ];
  const parameters = [];
  if (YEARS.length) { where.push(`c.cardYear IN (${YEARS.map((_, i) => `@y${i}`).join(",")})`); YEARS.forEach((y, i) => parameters.push({ name: `@y${i}`, value: y })); }
  if (SPORTS.length) { where.push(`c.sport IN (${SPORTS.map((_, i) => `@s${i}`).join(",")})`); SPORTS.forEach((s, i) => parameters.push({ name: `@s${i}`, value: s })); }
  const query = `SELECT c.id, c.cardId, c.hobbyiqCardId, c.title, c.parallel, c.parallelSlug, c.setName, c.source, c.sourceExternalId, c.price, c.cardYear, c.sport, c.cardNumber, c.playerName, c.observedAt FROM c WHERE ${where.join(" AND ")}`;

  const products = new Map();
  const s = { scanned: 0, otherSlot: 0, noProductId: 0, noParallelSlug: 0, outOfScope: 0 };
  let stopReason = null;

  await forEachPage(pool, { query, parameters }, async (rows) => {
    for (const row of rows) {
      const pid = L.chProductIdOf(row);
      if (!pid) { s.noProductId++; continue; }
      if (!mineByShard(pid)) { s.otherSlot++; continue; }

      const slug = str(row.hobbyiqCardId || row.cardId);
      const parts = slug.split(":");
      if (SETKEYS.length && !SETKEYS.includes(String(parts[3] ?? "").toLowerCase())) { s.outOfScope++; continue; }

      s.scanned++;

      let p = products.get(pid);
      if (!p) {
        p = {
          productId: pid, rows: 0, parallelRows: 0, noWitness: 0, witnessed: 0,
          labels: new Map(), slugs: new Map(), prices: [], noWitnessPrices: [],
          samples: [], sport: row.sport ?? null, year: row.cardYear ?? null,
          setKey: parts[3] ?? null, cardNumber: row.cardNumber ?? null,
          playerName: row.playerName ?? null,
        };
        products.set(pid, p);
      }
      p.rows++;
      if (Number.isFinite(Number(row.price))) p.prices.push(Number(row.price));
      const label = str(row.parallel);
      if (label) p.labels.set(label, (p.labels.get(label) ?? 0) + 1);
      p.slugs.set(slug, (p.slugs.get(slug) ?? 0) + 1);

      // Only a row whose stored slug NAMES a parallel can be wearing a label.
      if (!K.slugNamesParallel(slug)) { p.baseRows = (p.baseRows ?? 0) + 1; continue; }
      p.parallelRows++;

      // The witness question, asked with the SAME predicate the repair
      // asserts. Scope and destination are answered later (a product's
      // destination is a per-product read), so they are stubbed permissive
      // here and the verdict is used only for its witness legs.
      const v = L.chProductLabelVerdict(row, {
        productIds: new Set([pid]), derivedSlug: baseDestinationOf(slug), derivedBacked: true,
      });
      const witnessLeg = v.failed === "title-witnesses-the-parallel" || v.failed === "title-names-some-finish";
      if (witnessLeg) { p.witnessed++; }
      else if (v.rekeyable) {
        p.noWitness++;
        if (Number.isFinite(Number(row.price))) p.noWitnessPrices.push(Number(row.price));
        if (p.samples.length < 4) p.samples.push({ price: row.price, title: str(row.title).slice(0, 92) });
      } else {
        // A leg that is neither witness nor rekeyable (label-not-the-slug,
        // malformed id). Counted so the arithmetic closes.
        p.otherLeg = (p.otherLeg ?? 0) + 1;
      }
    }

    if (LIMIT && s.scanned >= LIMIT) { stopReason = "limit"; return false; }
    if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; return false; }
    return true;
  });

  // ── verdicts, and the destination read (once per product) ────────────────
  const suspects = [];
  const belowFloor = [];
  for (const p of products.values()) {
    if (!p.parallelRows) continue;
    const rate = Math.round((p.noWitness / p.parallelRows) * 1000) / 10;
    const topSlug = [...p.slugs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const dest = topSlug ? baseDestinationOf(topSlug) : null;
    const backed = dest && dest !== topSlug ? await checklistBacked(dest) : false;

    // The destination pool's own median, so the report shows BOTH prices --
    // "what this pool says the card is worth" against "what the destination
    // pool says", which is the pricing damage stated as a number.
    let destMedian = null, destRows = null;
    if (backed && dest) {
      // THE CONTINUATION TOKEN IS NOT OPTIONAL HERE, and a single `fetchNext`
      // is not "the first page" -- it is one physical partition's worth of
      // work, which for a cross-partition OR can legitimately be EMPTY while
      // more pages remain. Measured on the Figueroa destination pool: the
      // first fetchNext returned 0 rows with a continuation token set, while
      // the pool holds 119. A census that read one page would have printed
      // "n=0" and invited the reader to conclude the destination pool was
      // empty -- the exact opposite of the truth it exists to report.
      const ps = [];
      await forEachPage(pool, {
        query: "SELECT VALUE c.price FROM c WHERE (c.cardId = @d OR c.hobbyiqCardId = @d)",
        parameters: [{ name: "@d", value: dest }],
      }, async (page) => {
        for (const v of page) { const n = Number(v); if (Number.isFinite(n)) ps.push(n); }
        return ps.length < 5000; // a median does not need more than this
      }, 1000);
      destRows = ps.length; destMedian = median(ps);
    }

    const entry = {
      productId: p.productId,
      sport: p.sport, year: p.year, setKey: p.setKey,
      cardNumber: p.cardNumber, playerName: p.playerName,
      storedParallel: [...p.labels.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      storedSlug: topSlug,
      rows: p.rows, parallelRows: p.parallelRows,
      noWitness: p.noWitness, witnessed: p.witnessed, otherLeg: p.otherLeg ?? 0,
      witnessAbsenceRate: rate,
      derivedDestination: dest,
      destinationChecklistBacked: backed,
      storedPoolMedian: median(p.noWitnessPrices.length ? p.noWitnessPrices : p.prices),
      destinationPoolMedian: destMedian,
      destinationPoolRows: destRows,
      samples: p.samples,
    };

    if (p.parallelRows < MIN_ROWS) { belowFloor.push(entry); continue; }
    if (rate >= SUSPECT_PCT && backed) suspects.push(entry);
  }

  suspects.sort((a, b) => b.noWitness - a.noWitness);
  belowFloor.sort((a, b) => b.noWitness - a.noWitness);

  const rowsAffected = suspects.reduce((n, p) => n + p.noWitness, 0);
  const belowFloorRows = belowFloor.reduce((n, p) => n + p.noWitness, 0);

  console.log("");
  console.log("-".repeat(78));
  console.log(`  rows scanned (this slot)   ${f(s.scanned)}   (+${f(s.otherSlot)} other slots)`);
  console.log(`  CardHedge products seen    ${f(products.size)}`);
  console.log(`  rows with no product id    ${f(s.noProductId)}   <- ch-daily / ch-fill: a different writer, out of scope by construction`);
  console.log(`  rows out of setKey scope   ${f(s.outOfScope)}`);
  console.log("");
  console.log(`  SUSPECT products           ${f(suspects.length)}   <- >=${SUSPECT_PCT}% of parallel-slug sales carry NO title witness, destination checklist-backed`);
  console.log(`  rows they would move       ${f(rowsAffected)}`);
  console.log(`  below the ${MIN_ROWS}-row floor      ${f(belowFloor.length)} products / ${f(belowFloorRows)} rows   <- REPORTED, never dismissed`);
  console.log("");

  const top = suspects.slice(0, 10);
  if (top.length) {
    console.log("  TOP SUSPECTS");
    for (const p of top) {
      console.log("");
      console.log(`    ${p.productId}   ${p.sport ?? "?"} ${p.year ?? "?"} ${p.setKey ?? "?"} #${p.cardNumber ?? "?"}  ${p.playerName ?? ""}`);
      console.log(`      stored parallel   ${JSON.stringify(p.storedParallel)}`);
      console.log(`      stored slug       ${p.storedSlug}`);
      console.log(`      destination       ${p.derivedDestination}   checklist-backed: ${p.destinationChecklistBacked}`);
      console.log(`      rows              ${f(p.rows)} total / ${f(p.parallelRows)} on a parallel slug`);
      console.log(`      NO witness        ${f(p.noWitness)} (${p.witnessAbsenceRate}%)   witnessed ${f(p.witnessed)}   other ${f(p.otherLeg)}`);
      console.log(`      median price      stored pool $${p.storedPoolMedian ?? "?"}   destination pool $${p.destinationPoolMedian ?? "?"} (n=${f(p.destinationPoolRows ?? 0)})`);
      for (const x of p.samples) console.log(`        $${String(x.price).padEnd(7)} ${x.title}`);
    }
  } else {
    console.log("  No product met the SUSPECT bar in this scope.");
  }

  if (belowFloor.length) {
    console.log("");
    console.log(`  BELOW THE ${MIN_ROWS}-ROW FLOOR (a rate on 1-4 rows is not a rate; listed so nobody has to guess)`);
    for (const p of belowFloor.slice(0, 20)) {
      console.log(`    ${p.productId}  ${p.noWitness}/${p.parallelRows} no-witness  ${JSON.stringify(p.storedParallel)}  -> ${p.derivedDestination ?? "?"} backed:${p.destinationChecklistBacked}`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    scope: {
      sports: SPORTS, years: YEARS, setKeys: SETKEYS,
      shard: SHARDED ? { slot: SLOT, slots: SLOTS } : null,
      minRows: MIN_ROWS, suspectPct: SUSPECT_PCT, limit: LIMIT || null,
    },
    totals: {
      rowsScanned: s.scanned, otherSlot: s.otherSlot, productsSeen: products.size,
      noProductId: s.noProductId, outOfScope: s.outOfScope,
      suspectProducts: suspects.length, rowsAffected,
      belowFloorProducts: belowFloor.length, belowFloorRows,
    },
    stopReason,
    suspects, belowFloor,
  };
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const out = path.join(OUT_DIR, `census-slot-${SHARDED ? SLOT : "all"}.json`);
    fs.writeFileSync(out, JSON.stringify(report, null, 1));
    console.log("");
    console.log(`  census written to ${out}`);
  } catch (e) {
    console.log(`  (census file not written: ${String(e?.message ?? e).slice(0, 90)})`);
  }

  console.log("");
  if (stopReason === "budget") {
    // The runner's relaunch greps for this exact marker. A report that stops
    // at its budget says so identically to an apply (CF-REPORT-RELAUNCHES-AS-
    // A-REPORT), so a census longer than one budget can finish.
    console.log("  stopped at the 140-minute budget — the relaunch continues from here");
  } else if (stopReason === "limit") {
    console.log(`  stopped at LIMIT=${f(LIMIT)} rows scanned (a bounded probe, NOT a budget stop — no relaunch)`);
  } else {
    console.log("  scan complete — every row in scope was classified.");
  }
  console.log("");
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
main()
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => { console.error("FATAL", e?.stack ?? e); 
    await finishLane(1);
  });
