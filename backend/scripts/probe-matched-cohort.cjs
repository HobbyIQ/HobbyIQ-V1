#!/usr/bin/env node
/**
 * CF-MATCHED-COHORT-PLAYER-MOMENTUM — validation probe.
 *
 * Runs the matched-cohort computation against one player using live CH
 * data. Prints the aggregate result + a diagnostic table so we can
 * eyeball whether the signal makes sense before wiring the background
 * job.
 *
 * Usage:
 *   CARD_HEDGE_API_KEY=$(az webapp config appsettings list ... -o tsv) \
 *     node scripts/probe-matched-cohort.cjs "Eric Hartman"
 *
 * Or via the App Service key retrieval oneliner shown at the bottom
 * of the file.
 */

const CH_KEY = process.env.CARD_HEDGE_API_KEY;
if (!CH_KEY) {
  console.error("Missing CARD_HEDGE_API_KEY. See usage in file header.");
  process.exit(1);
}

const BASE = "https://api.cardhedger.com/v1";
const PLAYER = process.argv[2] || "Eric Hartman";
const PRIOR_WEEKS = parseInt(process.env.PRIOR_WEEKS || "4", 10);
const DAYS_PER_CARD = parseInt(process.env.DAYS_PER_CARD || "60", 10);
const MAX_CARDS = parseInt(process.env.MAX_CARDS || "50", 10);

/** Roll a daily series into weekly (Monday-Sunday) buckets. */
function rollupDailyToWeekly(points) {
  if (!points || !points.length) return [];
  const byWeek = new Map();
  for (const p of points) {
    const price = typeof p.price === "number" ? p.price : parseFloat(p.price);
    if (!p.closing_date || !Number.isFinite(price) || price <= 0) continue;
    const monday = mondayOf(p.closing_date.slice(0, 10));
    if (!monday) continue;
    if (!byWeek.has(monday)) byWeek.set(monday, []);
    byWeek.get(monday).push(price);
  }
  const todayISO = new Date().toISOString().slice(0, 10);
  const out = [];
  for (const weekStart of Array.from(byWeek.keys()).sort()) {
    const weekEnd = addDays(weekStart, 6);
    if (weekEnd >= todayISO) continue;
    const prices = byWeek.get(weekStart).slice().sort((a, b) => a - b);
    const median = prices.length % 2 === 0
      ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
      : prices[Math.floor(prices.length / 2)];
    const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
    out.push({
      weekStart, weekEnd,
      saleCount: prices.length,
      medianPrice: Math.round(median * 100) / 100,
      meanPrice: Math.round(mean * 100) / 100,
    });
  }
  return out;
}

function mondayOf(dateIso) {
  const parsed = new Date(dateIso + "T00:00:00Z");
  if (isNaN(parsed)) return null;
  const day = parsed.getUTCDay();
  const offset = day === 0 ? 6 : day - 1;
  parsed.setUTCDate(parsed.getUTCDate() - offset);
  return parsed.toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function weightedMedian(entries) {
  if (!entries.length) return null;
  const s = entries.slice().sort((a, b) => a.value - b.value);
  const total = s.reduce((sum, e) => sum + e.weight, 0);
  if (total <= 0) return null;
  const target = total / 2;
  let running = 0;
  for (const e of s) {
    running += e.weight;
    if (running >= target) return e.value;
  }
  return s[s.length - 1].value;
}

async function chPost(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": CH_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`CH ${path} → HTTP ${res.status}`);
    return null;
  }
  return res.json();
}

(async () => {
  console.log(`=== Matched-cohort probe: "${PLAYER}" ===`);
  console.log(`config: PRIOR_WEEKS=${PRIOR_WEEKS} DAYS_PER_CARD=${DAYS_PER_CARD} MAX_CARDS=${MAX_CARDS}\n`);

  const t0 = Date.now();
  const search = await chPost("/cards/card-search", {
    search: PLAYER,
    category: "Baseball",
    player: PLAYER,
    page: 1,
    page_size: 100,
  });
  if (!search || !search.cards) {
    console.error("card-search returned no cards");
    process.exit(1);
  }
  const cards = search.cards.slice(0, MAX_CARDS);
  console.log(`found ${cards.length} cards (capped at ${MAX_CARDS})\n`);

  const perCardSeries = [];
  let dailyFetched = 0;
  for (const c of cards) {
    const cardId = c.card_id;
    const daily = await chPost("/cards/prices-by-card", {
      card_id: cardId, grade: "Raw", days: DAYS_PER_CARD,
    });
    dailyFetched++;
    const prices = daily && Array.isArray(daily.prices) ? daily.prices : [];
    if (prices.length === 0) continue;
    const buckets = rollupDailyToWeekly(prices);
    if (buckets.length === 0) continue;
    perCardSeries.push({
      cardId,
      label: `${c.set || ""} ${c.variant || c.subset || "Base"} #${c.number || "?"}`.trim(),
      buckets,
    });
  }
  console.log(`fetched ${dailyFetched} card price series; ${perCardSeries.length} had usable weekly data\n`);

  // Determine latest week
  let latestWeekStart = "";
  let latestWeekEnd = "";
  for (const s of perCardSeries) {
    for (const b of s.buckets) {
      if (b.weekStart > latestWeekStart) {
        latestWeekStart = b.weekStart;
        latestWeekEnd = b.weekEnd;
      }
    }
  }

  const cohort = [];
  let latestWeekActiveCards = 0;
  let droppedNewOrLongTail = 0;
  for (const s of perCardSeries) {
    const sorted = s.buckets.slice().sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    const latestIdx = sorted.findIndex((b) => b.weekStart === latestWeekStart);
    if (latestIdx < 0) continue;
    const latest = sorted[latestIdx];
    if (latest.saleCount === 0) continue;
    latestWeekActiveCards++;
    const priorBuckets = sorted.slice(Math.max(0, latestIdx - PRIOR_WEEKS), latestIdx);
    const priorWithSales = priorBuckets.filter((b) => b.saleCount > 0);
    if (!priorWithSales.length) {
      droppedNewOrLongTail++;
      continue;
    }
    const priorMedianPrice = weightedMedian(
      priorWithSales.map((b) => ({ value: b.medianPrice, weight: b.saleCount })),
    );
    if (!priorMedianPrice || priorMedianPrice <= 0) {
      droppedNewOrLongTail++;
      continue;
    }
    cohort.push({
      cardId: s.cardId,
      label: s.label,
      latestMedian: latest.medianPrice,
      latestSaleCount: latest.saleCount,
      priorMedian: Math.round(priorMedianPrice * 100) / 100,
      priorSales: priorWithSales.reduce((sum, b) => sum + b.saleCount, 0),
      ratio: Math.round((latest.medianPrice / priorMedianPrice) * 1000) / 1000,
    });
  }

  const ratios = cohort.map((m) => m.ratio).sort((a, b) => a - b);
  const medianRatio = ratios.length ? median(ratios) : null;
  const meanRatio = ratios.length ? ratios.reduce((s, r) => s + r, 0) / ratios.length : null;

  console.log(`Latest complete week: ${latestWeekStart} → ${latestWeekEnd}`);
  console.log(`Prior window: ${PRIOR_WEEKS} weeks`);
  console.log(`Total cards evaluated: ${perCardSeries.length}`);
  console.log(`Latest-week active cards: ${latestWeekActiveCards}`);
  console.log(`Cohort size (both windows had sales): ${cohort.length}`);
  console.log(`Dropped (new-to-market or long-tail): ${droppedNewOrLongTail}\n`);

  console.log("=== per-card ratios (sorted by ratio) ===");
  const sorted = cohort.slice().sort((a, b) => a.ratio - b.ratio);
  for (const m of sorted) {
    const dir = m.ratio > 1.02 ? "↑" : m.ratio < 0.98 ? "↓" : "=";
    console.log(
      `  ${dir} ratio=${m.ratio.toFixed(3).padStart(6)}  latest=$${m.latestMedian.toString().padStart(6)} (x${m.latestSaleCount})  prior=$${m.priorMedian.toString().padStart(6)} (x${m.priorSales})  ${m.label}`
    );
  }

  console.log("\n=== AGGREGATE ===");
  console.log(`  MATCHED-COHORT MEDIAN RATIO: ${medianRatio ? medianRatio.toFixed(3) : "null"}   (mean=${meanRatio ? meanRatio.toFixed(3) : "null"})`);
  console.log(`  Elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
