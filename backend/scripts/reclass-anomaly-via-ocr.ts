#!/usr/bin/env -S npx tsx
/**
 * CF-RECLASS-ANOMALY-OCR (Drew, 2026-08-06).
 *
 * Combines OCR + price-nearest-sibling + doctrine-aware rules to
 * automatically reclassify high-confidence anomaly rows.
 *
 * For NON-AUTO cards: nearest sibling by price + OCR text confirms
 *   the sibling's finish token (Refractor / Wave / Ice / etc.).
 * For AUTO cards: OCR text alone (price signals are unreliable on
 *   tiny print runs).
 *
 * Only HIGH confidence rows get patched. Everything else is logged
 * with a reason and left in anomaly for manual triage.
 *
 * Patch shape when HIGH:
 *   - raw.identityHint.parallel   → corrected parallel string
 *   - raw.identityHint.cardNumber → corrected if OCR reads a better one
 *   - hobbyiqCardId               → recomputed slug from corrected identity
 *   - status                      → "pending" (drainer re-processes)
 *   - reclassifiedAt, reclassifyReason (audit)
 *
 * Env:
 *   RECLASS_APPLY   true = write; default dry-run
 *   RECLASS_MODE    "auto" | "non-auto"
 *   RECLASS_SAMPLES default 30
 *   RECLASS_COLOR   default "blue"
 */

import { CosmosClient, type Container } from "@azure/cosmos";
import { ocrImageUrl } from "../src/services/portfolioiq/azureVisionOcr.service.js";
import { computeHobbyIqCardId, parseHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

const APPLY = process.env.RECLASS_APPLY === "true";
const MODE = (process.env.RECLASS_MODE ?? "non-auto").toLowerCase();
const SAMPLES = Number(process.env.RECLASS_SAMPLES ?? 30);
const COLOR = (process.env.RECLASS_COLOR ?? "blue").toLowerCase();

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

const stage: Container = new CosmosClient(conn).database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("comps_staging");
const sold: Container = new CosmosClient(conn).database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");

const FINISH_TOKENS = [
  "concourse", "premier level", "field level", "refractor", "wave", "raywave",
  "ice", "cracked ice", "shimmer", "vibrations", "cosmic", "hyper", "prizm",
  "atomic", "mojo", "electric", "explosion", "lava", "storm", "burst", "aqua",
  "sapphire", "velocity", "ink", "sky blue", "reactive blue",
];

interface AnomalyRow {
  id: string;
  hobbyiqCardId: string;
  raw: {
    vendorPayload: { title?: string; imageUrl?: string; price?: number; soldAt?: string };
    identityHint?: { playerName?: string; parallel?: string; cardNumber?: string; setName?: string; cardYear?: number; sport?: string; isAuto?: boolean; printRun?: number | null };
  };
}

function upgradeEbayUrl(u: string): string {
  return u.replace(/\/s-l\d+\.webp$/i, "/s-l1600.jpg").replace(/\/s-l\d+\.jpg$/i, "/s-l1600.jpg");
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  return s.length % 2 === 0 ? (s[s.length/2 - 1] + s[s.length/2]) / 2 : s[Math.floor(s.length/2)];
}

async function siblings(slug: string): Promise<Array<{ parallel: string; median: number; n: number }>> {
  const parts = slug.split(":");
  if (parts.length < 6) return [];
  const stem = parts.slice(0, 5).join(":") + ":";
  const { resources } = await sold.items.query<{ p: string; price: number }>({
    query: `SELECT c.parallel as p, c.price FROM c WHERE STARTSWITH(c.hobbyiqCardId, @s) AND CONTAINS(LOWER(c.parallel), @c) AND c.price > 0 AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)`,
    parameters: [{ name: "@s", value: stem }, { name: "@c", value: COLOR }],
  }, { maxItemCount: 1000 }).fetchAll();
  const byPar = new Map<string, number[]>();
  for (const r of resources) {
    const p = String(r.p ?? "").toLowerCase().trim();
    if (!p) continue;
    const arr = byPar.get(p) ?? []; arr.push(Number(r.price)); byPar.set(p, arr);
  }
  return [...byPar.entries()].filter(([, v]) => v.length >= 1)
    .map(([p, v]) => ({ parallel: p, median: median(v), n: v.length }));
}

interface Reclass {
  confidence: "HIGH" | "MED" | "LOW";
  reason: string;
  newParallel?: string;
  newCardNumber?: string;
  ocrHits?: string[];
  nearest?: { parallel: string; median: number; n: number; dist: number };
}

async function classify(row: AnomalyRow): Promise<Reclass> {
  const title = row.raw?.vendorPayload?.title ?? "";
  const rawUrl = row.raw?.vendorPayload?.imageUrl ?? "";
  const price = Number(row.raw?.vendorPayload?.price ?? 0);
  const storedParallel = (row.raw?.identityHint?.parallel ?? "").toLowerCase().trim();
  if (!rawUrl || !(price > 0)) return { confidence: "LOW", reason: "no url or price" };

  const bigUrl = upgradeEbayUrl(rawUrl);
  const ocr = await ocrImageUrl(bigUrl);
  const ocrText = ocr.ok ? (ocr.rawText ?? "").toLowerCase() : "";
  const ocrHits = FINISH_TOKENS.filter((t) => ocrText.includes(t));

  if (MODE === "auto") {
    // For auto — rely on OCR alone. If OCR reads a distinctive finish
    // token and the slug/hint doesn't have it, that's the reclassification.
    const newFinish = ocrHits.find((t) => !storedParallel.includes(t) && !row.hobbyiqCardId.includes(t.replace(/\s+/g, "-")));
    if (!newFinish) return { confidence: "LOW", reason: "OCR didn't surface a new finish token", ocrHits };
    // Only accept color+finish combos
    if (!ocrText.includes(COLOR)) return { confidence: "LOW", reason: "OCR lacks color match", ocrHits };
    return {
      confidence: "HIGH",
      reason: `OCR: color=${COLOR}, finish=${newFinish}`,
      newParallel: `${COLOR} ${newFinish}`,
      ocrHits,
    };
  }

  // Non-auto: price-nearest + OCR confirmation.
  const sibs = await siblings(row.hobbyiqCardId);
  if (sibs.length < 2) return { confidence: "LOW", reason: "insufficient siblings", ocrHits };
  const scored = sibs.map((s) => ({ ...s, dist: Math.abs(s.median - price) })).sort((a, b) => a.dist - b.dist);
  const nearest = scored[0];
  const priceCloseness = price > 0 ? nearest.dist / price : 1;

  // HIGH: OCR confirms nearest sibling's finish token AND dist ≤ 30% of price
  const nearestFinishTokens = FINISH_TOKENS.filter((t) => nearest.parallel.includes(t));
  const ocrConfirms = nearestFinishTokens.some((t) => ocrHits.includes(t));
  if (ocrConfirms && priceCloseness <= 0.30) {
    return {
      confidence: "HIGH",
      reason: `nearest sibling "${nearest.parallel}" (dist=$${nearest.dist.toFixed(2)}, ${(priceCloseness*100).toFixed(0)}% of price); OCR confirms`,
      newParallel: nearest.parallel,
      ocrHits, nearest,
    };
  }
  if (priceCloseness <= 0.10 && nearest.n >= 3) {
    return {
      confidence: "MED",
      reason: `nearest sibling "${nearest.parallel}" (dist=$${nearest.dist.toFixed(2)}, ${(priceCloseness*100).toFixed(0)}% of price, n=${nearest.n}); no OCR confirmation`,
      newParallel: nearest.parallel,
      ocrHits, nearest,
    };
  }
  return { confidence: "LOW", reason: `dist ${(priceCloseness*100).toFixed(0)}% of price (need ≤30 with OCR or ≤10 without)`, ocrHits, nearest };
}

async function main(): Promise<void> {
  console.log(`▸ Reclass — ${APPLY ? "APPLY" : "DRY-RUN"} — mode=${MODE}  color=${COLOR}  samples=${SAMPLES}`);

  const autoFilter = MODE === "auto"
    ? `AND (ENDSWITH(c.hobbyiqCardId, ":auto") OR CONTAINS(c.hobbyiqCardId, ":auto:num-"))`
    : `AND (ENDSWITH(c.hobbyiqCardId, ":no-auto") OR CONTAINS(c.hobbyiqCardId, ":no-auto:num-"))`;
  const { resources: raw } = await stage.items.query<AnomalyRow>({
    query: `SELECT TOP @n c.id, c.hobbyiqCardId, c.raw FROM c
            WHERE c.status = "anomaly"
              AND CONTAINS(LOWER(c.raw.vendorPayload.title), @color)
              AND CONTAINS(LOWER(c.raw.vendorPayload.title), "psa 10")
              AND IS_DEFINED(c.raw.vendorPayload.imageUrl) AND c.raw.vendorPayload.imageUrl != null
              ${autoFilter}`,
    parameters: [{ name: "@n", value: SAMPLES * 10 }, { name: "@color", value: COLOR }],
  }).fetchAll();

  const seen = new Set<string>();
  const rows: AnomalyRow[] = [];
  for (const r of raw) {
    const k = `${r.hobbyiqCardId}|${Math.round(Number(r.raw?.vendorPayload?.price ?? 0))}`;
    if (seen.has(k)) continue;
    seen.add(k); rows.push(r);
    if (rows.length >= SAMPLES) break;
  }
  console.log(`  ${rows.length} unique candidates\n`);

  let high = 0, med = 0, low = 0, patched = 0, errors = 0;

  for (const r of rows) {
    const title = r.raw?.vendorPayload?.title ?? "";
    const result = await classify(r);
    if (result.confidence === "HIGH") high++;
    else if (result.confidence === "MED") med++;
    else low++;

    console.log(`\n[${result.confidence}] ${title.slice(0, 90)}`);
    console.log(`  slug: ${r.hobbyiqCardId}  price: $${r.raw?.vendorPayload?.price ?? 0}`);
    console.log(`  ${result.reason}`);
    if (result.newParallel) console.log(`  → new parallel: "${result.newParallel}"`);
    if (result.ocrHits && result.ocrHits.length > 0) console.log(`  OCR finish hits: ${result.ocrHits.join(",")}`);

    if (APPLY && result.confidence === "HIGH" && result.newParallel) {
      try {
        // Recompute slug with corrected parallel
        const idHint = r.raw.identityHint ?? {};
        const newSlug = computeHobbyIqCardId({
          sport: idHint.sport ?? r.hobbyiqCardId.split(":")[1] ?? "baseball",
          year: idHint.cardYear ?? Number(r.hobbyiqCardId.split(":")[2]) ?? 2024,
          setKey: idHint.setName ?? r.hobbyiqCardId.split(":")[3] ?? "",
          cardNumber: result.newCardNumber ?? idHint.cardNumber ?? r.hobbyiqCardId.split(":")[4] ?? "",
          parallel: result.newParallel,
          isAuto: idHint.isAuto ?? r.hobbyiqCardId.includes(":auto"),
          printRun: idHint.printRun ?? null,
        });
        if (!newSlug || newSlug.includes("::")) throw new Error(`bad newSlug: ${newSlug}`);
        await stage.item(r.id, r.hobbyiqCardId).patch({
          operations: [
            { op: "set", path: "/raw/identityHint/parallel", value: result.newParallel },
            { op: "set", path: "/hobbyiqCardId", value: newSlug },
            { op: "set", path: "/status", value: "pending" },
            { op: "set", path: "/reclassifiedAt", value: new Date().toISOString() },
            { op: "set", path: "/reclassifyReason", value: result.reason },
          ],
        } as never);
        patched++;
        console.log(`  ✓ patched slug ${r.hobbyiqCardId} → ${newSlug}`);
      } catch (e) {
        errors++;
        console.error(`  ✗ patch failed: ${(e as Error).message}`);
      }
    }
  }

  console.log(`\n▸ Summary`);
  console.log(`  HIGH:  ${high}`);
  console.log(`  MED:   ${med}`);
  console.log(`  LOW:   ${low}`);
  console.log(`  patched: ${patched}${APPLY ? "" : " (dry-run)"}`);
  console.log(`  errors:  ${errors}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
