#!/usr/bin/env -S npx tsx
/**
 * CF-OCR-PRICE-DISAMBIGUATE v2 (Drew, 2026-08-06).
 *
 * Iteration on the first pilot which surfaced three real issues:
 *   1. eBay thumbnails (s-l140.webp) are too small for Azure Vision OCR.
 *      Upgrade to s-l1600.jpg for legible finish text.
 *   2. Sibling matching was too strict — needed n>=3 sales per variant.
 *      Now accepts n>=1 so rare finishes (Blue Wave / Ice / Concourse
 *      etc.) participate in the comparison.
 *   3. Fetched sample had duplicate rows for the same card. Now
 *      dedups on hobbyiqCardId + price + soldAt so each sample is a
 *      distinct case.
 *
 * Approach per row:
 *   a. Upgrade the eBay URL to full resolution.
 *   b. Vision-OCR the image, extract lowercase text.
 *   c. Query sold_comps for siblings at the same year/set/cardNumber
 *      that CONTAIN the target color word — group by parallel.
 *   d. Compute median price per parallel bucket.
 *   e. Rank siblings by |median - row.price|.
 *   f. Cross-check with OCR: does the text contain the nearest sibling's
 *      finish token (concourse, ice, wave, refractor, etc.)?
 *   g. If YES → high confidence reclassification candidate.
 *
 * Env:
 *   PILOT_SAMPLES  default 15
 *   PILOT_COLOR    default "blue"
 */

import { CosmosClient, type Container } from "@azure/cosmos";
import { ocrImageUrl } from "../src/services/portfolioiq/azureVisionOcr.service.js";

const SAMPLES = Number(process.env.PILOT_SAMPLES ?? 15);
const COLOR = (process.env.PILOT_COLOR ?? "blue").toLowerCase();
const MODE = (process.env.PILOT_MODE ?? "non-auto").toLowerCase();  // "auto" or "non-auto"

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

const stage: Container = new CosmosClient(conn)
  .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
  .container("comps_staging");
const sold: Container = new CosmosClient(conn)
  .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
  .container("sold_comps");

interface AnomalyRow {
  id: string;
  hobbyiqCardId: string;
  raw: {
    vendorPayload: { title?: string; imageUrl?: string; price?: number; soldAt?: string };
    identityHint?: { playerName?: string; parallel?: string };
  };
}

interface SiblingBucket { parallel: string; slug: string; median: number; n: number }

// Common finish tokens that distinguish parallels sharing a color.
const FINISH_TOKENS = [
  "concourse", "premier level", "premier", "field level",
  "refractor", "wave", "raywave", "ice", "cracked", "shimmer",
  "vibrations", "cosmic", "hyper", "prizm", "atomic", "mojo",
  "electric", "explosion", "lava", "storm", "burst", "aqua",
  "rookie", "prospects", "sapphire", "velocity", "ink",
];

function upgradeEbayImageUrl(u: string): string {
  // eBay CDN pattern: /images/g/<id>/s-l140.webp → replace to s-l1600.jpg
  return u
    .replace(/\/s-l\d+\.webp$/i, "/s-l1600.jpg")
    .replace(/\/s-l\d+\.jpg$/i, "/s-l1600.jpg");
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function findColorSiblings(slug: string, color: string): Promise<SiblingBucket[]> {
  const parts = slug.split(":");
  if (parts.length < 6) return [];
  const [prefix, sport, year, set, cardNumber] = parts;
  const stem = [prefix, sport, year, set, cardNumber].join(":");
  const { resources } = await sold.items.query<{ slug: string; parallel: string; price: number }>({
    query: `SELECT c.hobbyiqCardId as slug, c.parallel, c.price
            FROM c WHERE STARTSWITH(c.hobbyiqCardId, @stem)
              AND CONTAINS(LOWER(c.parallel), @color)
              AND c.price > 0
              AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)`,
    parameters: [{ name: "@stem", value: stem + ":" }, { name: "@color", value: color }],
  }, { maxItemCount: 1000 }).fetchAll();
  const byParallel = new Map<string, { slug: string; prices: number[] }>();
  for (const r of resources) {
    if (!r.parallel) continue;
    const p = String(r.parallel).toLowerCase().trim();
    const arr = byParallel.get(p) ?? { slug: r.slug, prices: [] };
    arr.prices.push(Number(r.price));
    byParallel.set(p, arr);
  }
  return [...byParallel.entries()]
    .filter(([, v]) => v.prices.length >= 1)       // ← relaxed from 3 to 1
    .map(([par, v]) => ({ parallel: par, slug: v.slug, median: median(v.prices), n: v.prices.length }))
    .sort((a, b) => a.median - b.median);
}

async function main(): Promise<void> {
  console.log(`▸ Pilot v2 — samples=${SAMPLES}, color=${COLOR}, mode=${MODE}`);

  // MODE selection: "auto" filters on slugs ending with :auto (or :auto:num-*)
  //                 "non-auto" filters on slugs ending with :no-auto (or :no-auto:num-*)
  // The isAuto boundary lives in cardNumber prefix per doctrine, and is
  // reflected in the slug's second-to-last segment.
  const autoFilter = MODE === "auto"
    ? `AND (ENDSWITH(c.hobbyiqCardId, ":auto") OR CONTAINS(c.hobbyiqCardId, ":auto:num-"))`
    : `AND (ENDSWITH(c.hobbyiqCardId, ":no-auto") OR CONTAINS(c.hobbyiqCardId, ":no-auto:num-"))`;
  // Dedup: fetch 10x more, then group by (slug, price rounded, soldAt-day)
  // and pick the first from each group.
  const { resources: raw } = await stage.items.query<AnomalyRow>({
    query: `SELECT TOP @n c.id, c.hobbyiqCardId, c.raw FROM c
            WHERE c.status = "anomaly"
              AND CONTAINS(LOWER(c.raw.vendorPayload.title), @color)
              AND CONTAINS(LOWER(c.raw.vendorPayload.title), "psa 10")
              AND IS_DEFINED(c.raw.vendorPayload.imageUrl)
              AND c.raw.vendorPayload.imageUrl != null
              ${autoFilter}`,
    parameters: [{ name: "@n", value: SAMPLES * 10 }, { name: "@color", value: COLOR }],
  }).fetchAll();
  const seen = new Set<string>();
  const rows: AnomalyRow[] = [];
  for (const r of raw) {
    const key = `${r.hobbyiqCardId}|${Math.round(Number(r.raw?.vendorPayload?.price ?? 0))}|${(r.raw?.vendorPayload?.soldAt ?? "").slice(0, 10)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(r);
    if (rows.length >= SAMPLES) break;
  }
  console.log(`  ${raw.length} candidates → ${rows.length} unique after dedup\n`);

  let processed = 0, disambiguated = 0, ocrAgree = 0, insufficient = 0, ocrFailed = 0;

  for (const r of rows) {
    processed++;
    const title = r.raw?.vendorPayload?.title ?? "";
    const rawUrl = r.raw?.vendorPayload?.imageUrl ?? "";
    const price = Number(r.raw?.vendorPayload?.price ?? 0);
    const storedParallel = (r.raw?.identityHint?.parallel ?? "").toLowerCase();
    const bigUrl = upgradeEbayImageUrl(rawUrl);

    const siblings = await findColorSiblings(r.hobbyiqCardId, COLOR);
    if (siblings.length < 2) { insufficient++; continue; }
    const scored = siblings.map((s) => ({ ...s, dist: Math.abs(s.median - price) })).sort((a, b) => a.dist - b.dist);
    const nearest = scored[0];

    let ocrText = "";
    let ocrErr = "";
    try {
      const ocr = await ocrImageUrl(bigUrl);
      if (ocr.ok) ocrText = (ocr.rawText ?? "").toLowerCase();
      else ocrErr = ocr.error ?? "unknown";
    } catch (e) { ocrErr = (e as Error).message; }
    if (ocrErr) ocrFailed++;

    const ocrHits = FINISH_TOKENS.filter((t) => ocrText.includes(t));
    const nearestFinishTokens = FINISH_TOKENS.filter((t) => nearest.parallel.includes(t));
    const agree = nearestFinishTokens.some((t) => ocrHits.includes(t));

    if (nearest && nearest.parallel !== storedParallel) disambiguated++;
    if (agree) ocrAgree++;

    console.log(`\n[${processed}] ${title.slice(0, 90)}`);
    console.log(`  $${price}  storedParallel: "${storedParallel}"  slug: ${r.hobbyiqCardId}`);
    console.log(`  hi-res img: ${bigUrl.slice(0, 90)}`);
    console.log(`  siblings (top 5 by price closeness):`);
    for (const s of scored.slice(0, 5)) console.log(`    $${s.median.toFixed(2).padStart(8)} n=${String(s.n).padStart(3)}  ${s.parallel.padEnd(30)}  dist=$${s.dist.toFixed(2)}`);
    console.log(`  nearest-by-price: ${nearest.parallel}`);
    console.log(`  OCR text len=${ocrText.length}${ocrErr ? " err=" + ocrErr.slice(0, 60) : ""}  finish hits: [${ocrHits.join(", ") || "none"}]`);
    if (ocrText.length > 0 && ocrText.length < 400) console.log(`  OCR text: "${ocrText.replace(/\s+/g, " ").slice(0, 300)}"`);
    console.log(`  agreement: ${agree ? "YES ✓ high-confidence reclass" : "no"}`);
  }

  console.log(`\n▸ Summary`);
  console.log(`  processed:                ${processed}`);
  console.log(`  needs reclass (nearest ≠ stored): ${disambiguated}`);
  console.log(`  OCR-price agreement:      ${ocrAgree}  (${processed ? Math.round(ocrAgree/processed*100) : 0}%)`);
  console.log(`  insufficient siblings:    ${insufficient}`);
  console.log(`  OCR failed:               ${ocrFailed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
