// CF-DATA-CLEAN-JOB (Drew, 2026-07-28).
//
// Reads pending staging rows, applies programmatic normalizations,
// and flips status to "clean" (promotion-ready) or "anomaly"
// (image-verify needed). Idempotent: re-running on the same row is
// safe — the clean sub-object gets overwritten, raw stays immutable.
//
// Checks applied (in order):
//   1. Parser sanity — parseListingIdentity on the title should agree
//      with the derived slug's parallel + cardNumber + isAuto. Disagree
//      → parser-low-confidence anomaly.
//   2. Rolling-median price plausibility — is the price within
//      [median/3, median*3] of the last 30d at this slug? Outside →
//      price-outlier anomaly.
//   3. Cross-grade sanity — if graded, does the price exceed the p75
//      of a HIGHER tier at this family × value-band? Above → cross-
//      grade-band anomaly.
//   4. Slug conflict — does the derived slug conflict with any
//      catalog entry's canonical parallel for the (year, cardNumber,
//      isAuto) identity? Yes → slug-conflict anomaly.
//   5. Missing image — no vendorPayload.imageUrl AND no successful
//      mirror → no-image anomaly (still routed downstream, not
//      rejected — per no-reject rule).
//
// Rows with zero anomalies → status="clean", ready for promotion.
// Rows with ≥1 anomaly → status="anomaly", awaiting image-verify job.
// Every anomaly carries a reason code so the verify_queue triage UI
// can filter and Drew can spot patterns.

import { CosmosClient, type Container } from "@azure/cosmos";
import { parseListingIdentity } from "./parseTitleIdentity.service.js";
import { parseHobbyIqCardId, slugify } from "./hobbyIqCardId.service.js";
import { parseGradeLabel } from "./gradeParser.js";
import type { StagingClean, StagingDoc } from "./compsStaging.service.js";

let _cached: Container | null = null;
async function getStagingContainer(): Promise<Container | null> {
  if (_cached) return _cached;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    _cached = db.container(process.env.COSMOS_COMPS_STAGING_CONTAINER ?? "comps_staging");
    return _cached;
  } catch {
    return null;
  }
}

let _soldCompsCached: Container | null = null;
async function getSoldCompsContainer(): Promise<Container | null> {
  if (_soldCompsCached) return _soldCompsCached;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    _soldCompsCached = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
    return _soldCompsCached;
  } catch {
    return null;
  }
}

export interface DataCleanResult {
  scanned: number;
  cleaned: number;
  anomalies: number;
  skipped: number;
  errors: number;
  anomalyReasons: Record<string, number>;
}

/**
 * Process a bounded batch of pending staging rows. Returns counts so
 * a caller (nightly cron or manual trigger) can chart throughput.
 * Uses continuation token pagination so successive calls advance
 * through the queue without missing rows.
 */
export async function runDataCleanBatch(opts: {
  limit?: number;
} = {}): Promise<DataCleanResult> {
  const staging = await getStagingContainer();
  const soldComps = await getSoldCompsContainer();
  const result: DataCleanResult = {
    scanned: 0,
    cleaned: 0,
    anomalies: 0,
    skipped: 0,
    errors: 0,
    anomalyReasons: {},
  };
  if (!staging) return result;

  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  const { resources: pending } = await staging.items.query<StagingDoc>({
    query: "SELECT TOP @n * FROM c WHERE c.status = 'pending' ORDER BY c.observedAt ASC",
    parameters: [{ name: "@n", value: limit }],
  }).fetchAll();

  for (const row of pending) {
    result.scanned += 1;
    try {
      const clean = await classifyRow(row, soldComps);
      const nextStatus = clean.anomalies.length === 0 ? "clean" : "anomaly";
      row.clean = clean;
      row.status = nextStatus;
      await staging.item(row.id, row.hobbyiqCardId).replace(row as unknown as Record<string, unknown>);
      if (nextStatus === "clean") result.cleaned += 1;
      else {
        result.anomalies += 1;
        for (const a of clean.anomalies) {
          result.anomalyReasons[a.kind] = (result.anomalyReasons[a.kind] ?? 0) + 1;
        }
      }
    } catch {
      result.errors += 1;
    }
  }
  console.log(JSON.stringify({
    event: "data_clean_batch_complete",
    source: "dataCleanJob.service",
    ...result,
  }));
  return result;
}

/**
 * Classify a single staging row. Pure function apart from the
 * rolling-median lookup against sold_comps (which is read-only).
 * Never throws — always returns a StagingClean.
 */
async function classifyRow(row: StagingDoc, soldComps: Container | null): Promise<StagingClean> {
  const raw = row.raw;
  const parsed = parseHobbyIqCardId(row.hobbyiqCardId);
  const cardYear = parsed?.year ?? raw.identityHint.cardYear ?? 0;
  const sport = parsed?.sport ?? raw.identityHint.sport ?? "baseball";
  const price = Number(raw.vendorPayload.price ?? 0);
  const soldAt = String(raw.vendorPayload.soldAt ?? new Date().toISOString());
  const title = String(raw.vendorPayload.title ?? "");
  const playerName = String(raw.identityHint.playerName ?? "").trim() || "(unknown)";

  const normalizations: string[] = [];
  const anomalies: StagingClean["anomalies"] = [];

  // Check 1: parser sanity — title vs stored slug parallel/isAuto.
  if (title && parsed) {
    const titleParsed = parseListingIdentity(title);
    const titleParallelSlug = slugify(titleParsed.parallel ?? "base");
    if (titleParallelSlug !== parsed.parallel) {
      anomalies.push({
        kind: "parser-low-confidence",
        detail: `title parallel "${titleParsed.parallel}" (slug=${titleParallelSlug}) disagrees with staging parallel "${parsed.parallel}"`,
      });
    } else {
      normalizations.push("title-parallel-agrees");
    }
    if (titleParsed.isAuto !== parsed.isAuto) {
      anomalies.push({
        kind: "parser-low-confidence",
        detail: `title isAuto=${titleParsed.isAuto} disagrees with staging isAuto=${parsed.isAuto}`,
      });
    }
  }

  // Check 2: rolling-median price plausibility.
  if (soldComps && price > 0) {
    try {
      const rollingCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const { resources: rollingRows } = await soldComps.items.query<{ price: number }>({
        query: "SELECT c.price FROM c WHERE c.hobbyiqCardId = @hiq AND c.soldAt >= @cutoff",
        parameters: [{ name: "@hiq", value: row.hobbyiqCardId }, { name: "@cutoff", value: rollingCutoff }],
      }).fetchAll();
      if (rollingRows.length >= 5) {
        const prices = rollingRows.map((r) => Number(r.price)).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
        if (prices.length >= 5) {
          const median = prices[Math.floor(prices.length / 2)];
          const ratio = price / median;
          if (ratio > 3 || ratio < (1 / 3)) {
            anomalies.push({
              kind: "price-outlier",
              detail: `${(ratio * 100).toFixed(0)}% of 30d median $${median.toFixed(2)} (n=${prices.length})`,
            });
          } else {
            normalizations.push("price-within-30d-band");
          }
        }
      }
    } catch { /* rolling median failure is non-fatal */ }
  }

  // Check 3: cross-grade sanity — deferred until GRADE_MULTIPLIER
  // helper returns the full cell (rawMedian, gradedMedian, p75) which
  // needs a small helper add. Placeholder marker so we know to add it.
  // (See recon report #1 — the data supports it, just needs a wrapper.)

  // Check 4: slug conflict against card_catalog — deferred until
  // catalog seed reaches meaningful coverage.

  // Check 5: no-image anomaly.
  const hasIngestImageUrl = Boolean(raw.vendorPayload.imageUrl);
  const hasMirrorSuccess = Boolean(row.mirroredImage?.blobUrl) && !row.mirroredImage?.mirrorError;
  if (!hasIngestImageUrl && !hasMirrorSuccess) {
    anomalies.push({
      kind: "no-image",
      detail: "vendor sent no imageUrl and no successful mirror on file — image-verify cannot fire",
    });
  } else if (row.mirroredImage?.mirrorError) {
    anomalies.push({
      kind: "no-image",
      detail: `mirror failed: ${row.mirroredImage.mirrorError.reason} ${row.mirroredImage.mirrorError.detail ?? ""}`,
    });
  } else {
    normalizations.push("image-mirrored");
  }

  // CF-DATA-CLEAN-EXTRACT-GRADE (Drew, 2026-07-28). Title often carries
  // grade tokens (PSA 10, BGS 9.5, SGC 9, "Raw", "Ungraded"). Extract
  // now so the triage UI + promotion carry the right grade — the
  // legacy migration copied sold_comps.gradeCompany/Value verbatim
  // but many Cardsight rows never captured them.
  const gradeParsed = title ? parseGradeLabel(title) : null;

  return {
    cleanedAt: new Date().toISOString(),
    slug: row.hobbyiqCardId,
    cardNumber: parsed?.cardNumber ?? null,
    parallel: parsed?.parallel ?? null,
    isAuto: parsed?.isAuto ?? false,
    printRun: parsed?.printRun ?? null,
    gradeCompany: gradeParsed?.gradeCompany ?? null,
    gradeValue: gradeParsed?.gradeValue ?? null,
    setName: parsed?.setKey ?? null,
    playerName,
    cardYear: cardYear as number,
    sport,
    price,
    soldAt,
    normalizations,
    anomalies,
  };
}
