#!/usr/bin/env node
// CF-BULK-IMPORT-CH-DAILY-TO-SOLD-COMPS (Drew, 2026-07-30). Sold_comps
// is currently seeded ONLY via user queries — CH-daily bulk historical
// data enters sold_comps just for cards a user has looked up. This
// leaves the FMV comp pool thin for long-tail cards + graded tiers
// nobody has queried yet. Proactive: iterate ch_daily_sales rows and
// upsert into sold_comps preserving vendor-canonical grader/grade.
//
// recordSoldComp handles the identity + dedup work:
//   - contentHash dedup (existing rows with same hash are skipped)
//   - hobbyiqCardId slug computation
//   - composite emission (per Phase 3+4)
//   - cross-source canonical scoring
//
// Idempotent: safe to re-run. Dedup by contentHash ensures no dupes.
//
// Resumable: checkpoint on sale_date + price_history_id so multi-day
// bulk drains via self-relaunch continue from where the last run left.
//
// Env:
//   COSMOS_CONNECTION_STRING     — required
//   BACKFILL_APPLY=true          — actually write (default dry-run)
//   BACKFILL_CONCURRENCY=8       — parallel recordSoldComp calls
//   BULK_START_DATE=2026-07-30   — process rows with sale_date <= this
//   BULK_END_DATE=2018-01-01     — stop at this date
//   BULK_SPORT_FILTER=baseball   — comma-separated; default all sports
//   BULK_LIMIT=500000            — rows per iteration (cap)
//   BULK_SLICE_DAYS=7            — how many days per query (RU budget)

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { recordSoldComp } = require(path.join(backend, "dist/services/portfolioiq/soldCompsStore.service.js"));
// D28 (CF-A-CARD-NUMBER-IS-NOT-A-GRADE). This script keeps its OWN copy of the
// CH mapping -- the copy that wrote ~4.2M of the current sold_comps rows -- so
// the guard has to be applied here too. Applying it only in
// chRowToSoldComp.ts would leave the biggest writer of the defect untouched.
const { judgeCardNumber, logCardNumberVerdict } = require(path.join(backend, "dist/services/portfolioiq/cardNumberIntegrity.js"));

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || "8");
const LIMIT = Number(process.env.BULK_LIMIT || "500000");
const SLICE_DAYS = Number(process.env.BULK_SLICE_DAYS || "7");
const START_DATE = process.env.BULK_START_DATE || new Date().toISOString().slice(0, 10);
const END_DATE = process.env.BULK_END_DATE || "2018-01-01";
const SPORT_FILTER = (process.env.BULK_SPORT_FILTER || "").trim();

function normSport(chGroup) {
  const g = String(chGroup || "").trim().toLowerCase();
  if (g === "baseball") return "baseball";
  if (g === "basketball") return "basketball";
  if (g === "football") return "football";
  if (g === "hockey") return "hockey";
  if (g === "soccer") return "soccer";
  return null;
}

function normGrader(grader) {
  const g = String(grader || "").trim().toUpperCase();
  if (!g || g === "RAW" || g === "UNGRADED") return null;
  if (["PSA", "BGS", "SGC", "CGC", "BVG"].includes(g)) return g;
  return null;
}

function parseGrade(gradeStr) {
  if (!gradeStr || String(gradeStr).trim().toLowerCase() === "raw") return null;
  const n = parseFloat(String(gradeStr).trim());
  return Number.isFinite(n) && n > 0 && n <= 10 ? n : null;
}

function inferIsAutoFromCH(row) {
  // Look for auto tokens in variant OR description
  const combined = `${row.variant || ""} ${row.description || ""}`.toLowerCase();
  if (/\bauto(graph)?\b/.test(combined)) return true;
  if (/\bautographed\b/.test(combined)) return true;
  // Check cardNumber for known auto prefixes (from curated list)
  const num = String(row.number || "").toUpperCase();
  const AUTO_PREFIXES = /^(CPA|BCPA|BCDA|BDPA|BDA|BPA|CPALD|CPATWH|APDCA|54FAV|FFDA|CUSA|SCCA|CCAR|RODA|ROTA|TTAR|DPPA|BSPA|BCRA|TCRA|B96A|BGA|MRA|UAC|BSA|FSA|CDA|CRA|CBA|CCA|USA|DAS|NTS|SSM|DCA|CAA|GQA|AGA|ROA|FAR|FFA|BOA|T1A|SCA|PPA|ODA|IAP|UAR|BA|PA|RA|FA|TA|AA|AP|WT)-/;
  if (AUTO_PREFIXES.test(num)) return true;
  return false;
}

async function fetchWithRetry(iterator, maxRetries = 6) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await iterator.fetchNext(); }
    catch (err) {
      const msg = String(err?.message || "");
      const code = err?.code ?? err?.statusCode;
      if ((code === 429 || msg.includes("request rate is too large")) && attempt < maxRetries) {
        const wait = 2000 * (attempt + 1);
        process.stdout.write(`\r  [429 backoff ${wait}ms attempt ${attempt+1}]  `);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

async function runInParallel(items, worker, concurrency = CONCURRENCY) {
  let i = 0, ok = 0, err = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx]); ok++; }
      catch { err++; }
    }
  });
  await Promise.all(workers);
  return { ok, err };
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const chContainer = c.database("hobbyiq").container("ch_daily_sales");

  console.log(`[bulk-import-ch-daily-to-sold-comps]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit: ${LIMIT}`);
  console.log(`  slice days: ${SLICE_DAYS}`);
  console.log(`  start date (newest, walk backward): ${START_DATE}`);
  console.log(`  end date (stop): ${END_DATE}`);
  console.log(`  sport filter: ${SPORT_FILTER || "(all)"}\n`);

  const sportFilters = SPORT_FILTER
    ? SPORT_FILTER.split(",").map(s => s.trim()).filter(Boolean)
    : null;

  let processed = 0;
  let emitted = 0;      // recordSoldComp succeeded (may be no-op via dedup)
  let skippedRaw = 0;   // no grade info at all (still emit but flag)
  let skippedNoPrice = 0;
  let skippedNoPlayer = 0;
  let skippedSport = 0;
  // D28: the title overrode CardHedge's number, and the number CH gave that
  // the title showed to be a grade / print run / year / ordinal / lot.
  let cardNumberVendorDisagreed = 0;
  let cardNumberRefused = 0;
  const graderDist = {};
  const yearDist = {};

  let currentEnd = START_DATE;
  let currentStart = addDays(currentEnd, -SLICE_DAYS);

  while (processed < LIMIT && currentEnd > END_DATE) {
    // Clamp start to END_DATE
    if (currentStart < END_DATE) currentStart = END_DATE;
    console.log(`\n  Slice ${currentStart} → ${currentEnd}`);

    const params = [
      { name: "@from", value: currentStart },
      { name: "@to", value: currentEnd },
    ];
    let sportClause = "";
    if (sportFilters && sportFilters.length > 0) {
      const chGroupNames = sportFilters.map(s =>
        s === "baseball" ? "Baseball"
        : s === "basketball" ? "Basketball"
        : s === "football" ? "Football"
        : s === "hockey" ? "Hockey"
        : s === "soccer" ? "Soccer"
        : s);
      const inClause = chGroupNames.map((_, i) => `@sp${i}`).join(", ");
      sportClause = ` AND c["group"] IN (${inClause})`;
      chGroupNames.forEach((g, i) => params.push({ name: `@sp${i}`, value: g }));
    }

    const query = `
      SELECT c.price_history_id, c.source, c.description, c.price, c.image_url,
             c.sale_date, c.card_id, c.card_description, c.number, c.player,
             c.grade, c.grader, c["group"], c.card_set, c.card_set_type,
             c.variant, c.year
      FROM c
      WHERE c.sale_date >= @from AND c.sale_date < @to ${sportClause}
        AND IS_STRING(c.card_id) AND c.price > 0
      ORDER BY c.sale_date DESC
    `;

    const it = chContainer.items.query({ query, parameters: params }, { maxItemCount: 500 });
    const slice = [];
    while (it.hasMoreResults() && slice.length + processed < LIMIT) {
      const page = await fetchWithRetry(it);
      if (page && Array.isArray(page.resources)) slice.push(...page.resources);
      process.stdout.write(`\r    fetched ${slice.length}`);
    }
    console.log(`\r    ${slice.length} rows in slice.                     `);

    if (slice.length === 0) {
      // Advance the window
      currentEnd = currentStart;
      currentStart = addDays(currentEnd, -SLICE_DAYS);
      continue;
    }

    // Build the writes
    const writes = [];
    for (const row of slice) {
      processed++;
      const sport = normSport(row["group"]);
      if (sportFilters && sportFilters.length > 0 && (!sport || !sportFilters.includes(sport))) {
        skippedSport++;
        continue;
      }
      const player = String(row.player || "").trim();
      if (!player) { skippedNoPlayer++; continue; }
      const price = Number(row.price);
      if (!Number.isFinite(price) || price <= 0) { skippedNoPrice++; continue; }

      const gradeCompany = normGrader(row.grader);
      const gradeValue = parseGrade(row.grade);
      if (!gradeCompany) skippedRaw++;

      if (gradeCompany) {
        graderDist[gradeCompany] = (graderDist[gradeCompany] ?? 0) + 1;
      }
      if (row.year) yearDist[row.year] = (yearDist[row.year] ?? 0) + 1;

      // D28: CardHedge's `number` is their PRODUCT's number and their
      // `description` is the source listing's title line. When the title
      // states an explicit "#X" it wins; when it shows the number to be a
      // grade / print run / year / ordinal / lot, the number is refused.
      const chTitle = row.description || row.card_description || null;
      const numberVerdict = judgeCardNumber(row.number ?? null, chTitle);
      if (numberVerdict.vendorDisagrees) cardNumberVendorDisagreed++;
      if (numberVerdict.rejected) cardNumberRefused++;
      logCardNumberVerdict("ch-daily-bulk", numberVerdict, { candidate: row.number ?? null, title: chTitle, cardId: String(row.card_id).trim() });

      writes.push({
        cardId: String(row.card_id).trim(),
        playerName: player,
        cardYear: Number.isFinite(Number(row.year)) ? Number(row.year) : null,
        setName: row.card_set || row.card_set_type || null,
        parallel: row.variant || "Base",
        cardNumber: numberVerdict.cardNumber,
        isAuto: inferIsAutoFromCH(row),
        sport,
        gradeCompany,
        gradeValue,
        price,
        soldAt: row.sale_date,
        source: "cardhedge",
        sourceExternalId: `ch-daily::${row.price_history_id}`,
        contributorUserId: null,
        title: chTitle,
        imageUrl: row.image_url || null,
        sellerHandle: null,
        verifiedByUser: false,
        confidence: 0.9,   // CH-daily is authoritative for sale existence
      });
    }

    console.log(`    writes prepared: ${writes.length.toLocaleString()}`);

    if (!APPLY) {
      // Advance window and continue for full survey
      emitted += writes.length;
      currentEnd = currentStart;
      currentStart = addDays(currentEnd, -SLICE_DAYS);
      continue;
    }

    // Actually apply
    console.log(`    applying at concurrency ${CONCURRENCY}...`);
    const t0 = Date.now();
    let doneWrites = 0;
    const { ok, err } = await runInParallel(writes, async (w) => {
      await recordSoldComp(w);
      if (++doneWrites % 500 === 0) {
        process.stdout.write(`\r      ${doneWrites}/${writes.length}`);
      }
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\r      ${doneWrites}/${writes.length} in ${secs}s (ok=${ok} err=${err})`);
    emitted += ok;

    // Advance the window
    currentEnd = currentStart;
    currentStart = addDays(currentEnd, -SLICE_DAYS);
  }

  console.log(`\n════════════════ SUMMARY ════════════════`);
  console.log(`  rows processed:          ${processed.toLocaleString()}`);
  console.log(`  emitted to sold_comps:   ${emitted.toLocaleString()} ${APPLY ? "" : "(dry-run count)"}`);
  console.log(`  skipped (raw grade):     ${skippedRaw.toLocaleString()} (still emitted with null grade)`);
  console.log(`  skipped (no player):     ${skippedNoPlayer.toLocaleString()}`);
  console.log(`  card number: title overrode CH  ${cardNumberVendorDisagreed.toLocaleString()}   <- D28, card_number_vendor_disagrees`);
  console.log(`  card number: refused (grade / print run / year / ordinal / lot)  ${cardNumberRefused.toLocaleString()}`);
  console.log(`  skipped (no price):      ${skippedNoPrice.toLocaleString()}`);
  console.log(`  skipped (sport filter):  ${skippedSport.toLocaleString()}`);
  console.log(`  next start date:         ${currentEnd}`);
  console.log(`\n  Grader distribution (of graded emits):`);
  Object.entries(graderDist).sort((a,b) => b[1] - a[1]).forEach(([g, c]) => {
    console.log(`    ${String(c).padStart(8).toLocaleString()}  ${g}`);
  });
  console.log(`\n  Year distribution (top 15):`);
  Object.entries(yearDist).sort((a,b) => b[1] - a[1]).slice(0, 15).forEach(([y, c]) => {
    console.log(`    ${String(c).padStart(8).toLocaleString()}  ${y}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
