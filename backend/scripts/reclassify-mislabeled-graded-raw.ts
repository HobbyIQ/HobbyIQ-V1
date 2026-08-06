#!/usr/bin/env -S npx tsx
/**
 * CF-RECLASSIFY-MISLABELED-GRADED (Drew, 2026-08-06).
 *
 * Finds sold_comps rows tagged as raw (gradeCompany null) but priced
 * >MULTIPLIER × pool median for their slug, suggesting they're actually
 * graded slab sales that CardHedge ingested without a grade tag.
 *
 * Two-pass detection:
 *   1. Title regex — most reliable, fires when the eBay title contains
 *      "PSA 10" / "BGS 9.5" / "SGC 10" etc.
 *   2. Vision OCR — when title is bare ("Base"), OCR the mirrored
 *      image or the eBay CDN URL upgraded to 1600px. Looks for the
 *      same grader tokens plus the numeric grade below.
 *
 * Patch: sets gradeCompany + gradeValue from detection, marks row
 * with reclassifiedGradeAt + reclassifiedGradeSource. status stays
 * as-is (row is in sold_comps, not staging).
 *
 * Env:
 *   RECLASS_APPLY      true = write; default dry-run
 *   RECLASS_SLUG       optional single slug; default = scan whole pool
 *   RECLASS_MULTIPLIER default 3 (row price > median × N triggers OCR)
 *   RECLASS_MIN_POOL   default 20 (skip thin pools where median is noise)
 *   RECLASS_MAX_ROWS   default 500 (safety cap per run)
 */

import { CosmosClient, type Container } from "@azure/cosmos";
import { ocrImageUrl } from "../src/services/portfolioiq/azureVisionOcr.service.js";

const APPLY = process.env.RECLASS_APPLY === "true";
const MULTIPLIER = Number(process.env.RECLASS_MULTIPLIER ?? 3);
const MIN_POOL = Number(process.env.RECLASS_MIN_POOL ?? 20);
const MAX_ROWS = Number(process.env.RECLASS_MAX_ROWS ?? 500);
const SLUG_ONLY = process.env.RECLASS_SLUG ?? "";

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

const sc: Container = new CosmosClient(conn).database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");

interface Row {
  id: string;
  cardId: string;
  hobbyiqCardId: string;
  price: number;
  title?: string | null;
  imageUrl?: string | null;
  url?: string | null;
  source: string;
  soldAt: string;
}

const GRADE_TITLE_RE = /\b(PSA|BGS|SGC|CGC|CSG|HGA)[\s.-]*?(10(?:\.0)?|9\.5|9|8\.5|8|7|6|5|4|3|2|1)\b/i;

function detectFromText(text: string): { company: string; value: number } | null {
  if (!text) return null;
  const m = text.match(GRADE_TITLE_RE);
  if (!m) return null;
  const value = Number(m[2]);
  if (!Number.isFinite(value) || value <= 0 || value > 10) return null;
  return { company: m[1].toUpperCase(), value };
}

function upgradeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  return u.replace(/\/s-l\d+\.webp$/i, "/s-l1600.jpg").replace(/\/s-l\d+\.jpg$/i, "/s-l1600.jpg");
}

async function medianForSlug(slug: string): Promise<{ median: number; n: number } | null> {
  const cutoff = new Date(Date.now() - 180 * 86_400_000).toISOString();
  const { resources } = await sc.items.query<{ price: number }>({
    query: `SELECT c.price FROM c WHERE c.hobbyiqCardId = @s AND (c.gradeCompany = null OR NOT IS_DEFINED(c.gradeCompany)) AND c.soldAt >= @cut AND c.price > 0 AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)`,
    parameters: [{ name: "@s", value: slug }, { name: "@cut", value: cutoff }],
  }).fetchAll();
  const arr = resources.map((r) => r.price).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (arr.length < MIN_POOL) return null;
  return { median: arr[Math.floor(arr.length / 2)], n: arr.length };
}

async function main(): Promise<void> {
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"} — reclassify raw rows priced > median × ${MULTIPLIER}`);
  const cutoff = new Date(Date.now() - 180 * 86_400_000).toISOString();
  const slugFilter = SLUG_ONLY ? "AND c.hobbyiqCardId = @slug" : "";
  const params: Array<{ name: string; value: string }> = [{ name: "@cut", value: cutoff }];
  if (SLUG_ONLY) params.push({ name: "@slug", value: SLUG_ONLY });

  const { resources: cand } = await sc.items.query<Row>({
    query: `SELECT TOP @n c.id, c.cardId, c.hobbyiqCardId, c.price, c.title, c.imageUrl, c.url, c.source, c.soldAt
            FROM c WHERE (c.gradeCompany = null OR NOT IS_DEFINED(c.gradeCompany))
                       AND c.soldAt >= @cut AND c.price > 0
                       AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)
                       AND (NOT IS_DEFINED(c.reclassifiedGradeAt) OR c.reclassifiedGradeAt = null)
                       ${slugFilter}
            ORDER BY c.price DESC`,
    parameters: [{ name: "@n", value: MAX_ROWS }, ...params],
  }).fetchAll();
  console.log(`  ${cand.length} candidate rows fetched (top prices in raw pools)`);

  const medians = new Map<string, { median: number; n: number }>();
  let scanned = 0, titleHits = 0, ocrHits = 0, ocrRun = 0, patched = 0, errors = 0, skipped = 0;

  for (const r of cand) {
    scanned++;
    // Fetch pool median for this slug (cache per run)
    let pool = medians.get(r.hobbyiqCardId);
    if (pool === undefined) {
      const m = await medianForSlug(r.hobbyiqCardId);
      pool = m ?? { median: 0, n: 0 };
      medians.set(r.hobbyiqCardId, pool);
    }
    if (pool.n < MIN_POOL || pool.median === 0) { skipped++; continue; }
    if (r.price < pool.median * MULTIPLIER) { skipped++; continue; }

    // Detect: title first
    let hit = detectFromText(r.title ?? "");
    let signal: "title" | "ocr" | null = hit ? "title" : null;

    // If no title hit, try OCR on image
    if (!hit) {
      const bigUrl = upgradeUrl(r.imageUrl ?? null);
      if (bigUrl) {
        ocrRun++;
        try {
          const ocr = await ocrImageUrl(bigUrl);
          if (ocr.ok) hit = detectFromText(ocr.rawText ?? "");
          if (hit) signal = "ocr";
        } catch { /* pass */ }
      }
    }
    // CF-HARD-FLAG-EXTREME-OUTLIERS (Drew, 2026-08-06). Even without
    // title/OCR confirmation, a raw sale >HARD_MULTIPLIER × pool median
    // in a pool of N ≥ MIN_POOL comps is statistically indefensible as
    // raw. Ohtani Bowman Chrome #1 raw pool median $2.4K had rows at
    // $20-192K — those are slabs, we just can't prove which grade.
    // Flag flaggedWrong=true so they exit the FMV pool without
    // asserting a specific grade tier.
    const HARD_MULTIPLIER = 10;
    const isExtremeOutlier = r.price >= pool.median * HARD_MULTIPLIER;
    if (!hit && !isExtremeOutlier) { skipped++; continue; }

    if (hit) {
      if (signal === "title") titleHits++;
      else ocrHits++;
      console.log(`  ${r.hobbyiqCardId}  $${r.price} vs pool median $${pool.median}  ${signal}:${hit.company} ${hit.value}`);
    } else {
      console.log(`  ${r.hobbyiqCardId}  $${r.price} vs pool median $${pool.median}  ⚠ EXTREME-OUTLIER hard-flag (${(r.price/pool.median).toFixed(1)}x median)`);
    }

    if (!APPLY) continue;
    try {
      const ops: Array<Record<string, unknown>> = [
        { op: "set", path: "/reclassifiedGradeAt", value: new Date().toISOString() },
      ];
      if (hit) {
        ops.push({ op: "set", path: "/gradeCompany", value: hit.company });
        ops.push({ op: "set", path: "/gradeValue", value: hit.value });
        ops.push({ op: "set", path: "/reclassifiedGradeSource", value: signal });
      } else {
        // Hard-flag extreme outlier without asserting a grade tier
        ops.push({ op: "set", path: "/flaggedWrong", value: true });
        ops.push({ op: "set", path: "/excludedFromFmv", value: true });
        ops.push({ op: "set", path: "/flaggedReason", value: `extreme_price_outlier_raw_pool:${(r.price/pool.median).toFixed(1)}x_median` });
        ops.push({ op: "set", path: "/reclassifiedGradeSource", value: "price-outlier-hard-flag" });
      }
      await sc.item(r.id, r.cardId).patch({ operations: ops } as never);
      patched++;
    } catch (e) {
      errors++;
      if (errors <= 3) console.error(`  ! patch failed ${r.id}: ${(e as Error).message}`);
    }
  }

  console.log(`\n▸ Summary`);
  console.log(`  scanned:    ${scanned}`);
  console.log(`  title hits: ${titleHits}`);
  console.log(`  OCR hits:   ${ocrHits}  (of ${ocrRun} OCR runs)`);
  console.log(`  patched:    ${patched}${APPLY ? "" : " (dry-run)"}`);
  console.log(`  skipped:    ${skipped}`);
  console.log(`  errors:     ${errors}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
