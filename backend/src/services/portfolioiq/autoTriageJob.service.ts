// CF-AUTO-TRIAGE (Drew, 2026-07-28).
//
// Reads pending-manual staging rows where the anomaly is
// parser-low-confidence AND the title clearly disagrees with the
// stored parallel. Auto-applies the title-derived parallel as the
// correction (Drew's rule: "title is our source of truth for
// parallel") and promotes the row.
//
// Rationale: 46% of pending-manual has no image → image-verify can
// never confirm. Vast majority of these are Cardsight parallel_name
// mis-tags where our own parser correctly reads "Base" from a title
// that has no color word. Manually clicking Approve on hundreds of
// obvious cases is a waste of Drew's attention; trust the parser
// when the title clearly says one thing and the vendor tag says
// something else.
//
// Guardrails:
//   - Only fires when the anomaly.kind includes parser-low-confidence
//   - Skips when image-verify returned a matched=true verdict (that's
//     an image-verified promotion, not an auto-triage)
//   - Skips when the parser output IS the same as stored (nothing to
//     auto-correct — probably in queue for a different reason)
//   - Records the correction in verify_corrections so the training
//     data stays intact (same as a Drew-approved fix)

import { CosmosClient, type Container } from "@azure/cosmos";
import { parseListingIdentity } from "./parseTitleIdentity.service.js";
import { slugify, computeHobbyIqCardId } from "./hobbyIqCardId.service.js";
import { parseGradeFromTitle } from "./gradeParser.js";
import { recordSoldComp } from "./soldCompsStore.service.js";
import type { StagingDoc } from "./compsStaging.service.js";

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

export interface AutoTriageResult {
  scanned: number;
  autoFixed: number;
  skippedNoParserSignal: number;
  skippedParserAgrees: number;
  skippedNoTitle: number;
  errors: number;
  byNewParallel: Record<string, number>;
}

/**
 * Process a bounded batch of pending-manual rows where the anomaly
 * is parser-low-confidence. Silent-safe.
 */
// CF-STAGING-LIMIT-CAP-WAS-THE-BOTTLENECK (Drew, 2026-08-13). The batch ceiling
// was duplicated: the route clamped `limit` to 500 AND so did this job. Raising
// only the route changed nothing — a limit=2500 call still reported
// scanned=500, which is how the second cap was found. Both now agree at 5000.
//
// This is a guard against a typo'd query param, not a throughput policy: the
// real limiters are this job's wall-clock and the caller's curl --max-time.
const MAX_JOB_BATCH = 5000;

export async function runAutoTriageBatch(opts: { limit?: number } = {}): Promise<AutoTriageResult> {
  const staging = await getStagingContainer();
  const result: AutoTriageResult = {
    scanned: 0,
    autoFixed: 0,
    skippedNoParserSignal: 0,
    skippedParserAgrees: 0,
    skippedNoTitle: 0,
    errors: 0,
    byNewParallel: {},
  };
  if (!staging) return result;

  const limit = Math.max(1, Math.min(MAX_JOB_BATCH, opts.limit ?? 100));
  const { resources: pending } = await staging.items.query<StagingDoc>({
    query: "SELECT TOP @n * FROM c WHERE c.status = 'pending-manual' ORDER BY c.observedAt ASC",
    parameters: [{ name: "@n", value: limit }],
  }).fetchAll();

  for (const row of pending) {
    result.scanned += 1;
    try {
      // CF-AUTO-TRIAGE-ALWAYS-REPARSE (Drew, 2026-07-28). Don't gate
      // on the stale anomaly flag — data-clean may have classified
      // this row before we extended the parser (PRs #921, #923), so
      // an old row's anomalies array might not carry parser-low-
      // confidence even when today's parser would flag it. Always
      // re-run the parser against the title and act on TODAY's
      // disagreement.
      const title = String(row.raw.vendorPayload.title ?? "");
      if (!title) { result.skippedNoTitle += 1; continue; }

      const titleParsed = parseListingIdentity(title);
      const titleParallelSlug = slugify(titleParsed.parallel ?? "base");
      const currentParallelSlug = row.clean?.parallel ?? "base";

      if (titleParallelSlug === currentParallelSlug) {
        result.skippedParserAgrees += 1;
        continue;
      }

      // Recompute slug with the title-derived parallel
      const newSlug = computeHobbyIqCardId({
        sport: row.raw.identityHint.sport ?? row.clean?.sport ?? "baseball",
        year: row.clean?.cardYear ?? row.raw.identityHint.cardYear ?? 0,
        setKey: row.clean?.setName ?? "",
        cardNumber: row.clean?.cardNumber ?? "",
        parallel: titleParsed.parallel ?? "Base",
        isAuto: titleParsed.isAuto ?? row.clean?.isAuto ?? false,
        printRun: titleParsed.printRun ?? row.clean?.printRun ?? null,
      });

      // Also extract grade from title — data-clean now does this, but
      // legacy staging rows classified before that fix may still have
      // gradeCompany/gradeValue null. Re-parse defensively so PSA 7
      // in the title becomes a real (PSA, 7) tuple on the promotion.
      const gradeParsed = parseGradeFromTitle(title);
      const gradeCompany = row.clean?.gradeCompany ?? gradeParsed?.gradeCompany ?? null;
      const gradeValue = row.clean?.gradeValue ?? gradeParsed?.gradeValue ?? null;

      // Promote to sold_comps with the corrected identity.
      await recordSoldComp({
        cardId: `hiq:${newSlug.slice(4)}`,
        playerName: row.clean?.playerName ?? row.raw.identityHint.playerName ?? "(unknown)",
        cardYear: row.clean?.cardYear ?? row.raw.identityHint.cardYear ?? null,
        setName: row.clean?.setName ?? null,
        parallel: titleParsed.parallel,
        cardNumber: row.clean?.cardNumber ?? null,
        isAuto: titleParsed.isAuto,
        sport: row.raw.identityHint.sport ?? row.clean?.sport ?? "baseball",
        gradeCompany,
        gradeValue,
        price: row.clean?.price ?? Number(row.raw.vendorPayload.price ?? 0),
        soldAt: row.clean?.soldAt ?? String(row.raw.vendorPayload.soldAt ?? new Date().toISOString()),
        source: row.raw.vendor,
        sourceExternalId: row.raw.vendorRawId ?? null,
        title,
        imageUrl: row.mirroredImage?.blobUrl ?? row.raw.vendorPayload.imageUrl ?? null,
        sellerHandle: null,
        verifiedByUser: false,
        confidence: 0.8,   // higher than data-clean (0.7); parser explicitly corrected
      });

      // Update staging row: promoted with a "parser-title-truth" tag
      row.status = "promoted";
      row.promoted = {
        at: new Date().toISOString(),
        soldCompsId: `${row.raw.vendor}::${row.raw.vendorRawId ?? newSlug}`,
        verification: "data-clean",
      };
      await staging.item(row.id, row.hobbyiqCardId).replace(row as unknown as Record<string, unknown>);

      // Log the correction so verify_corrections captures the training example.
      try {
        const { recordVerifyCorrection } = await import("./verifyCorrections.service.js");
        await recordVerifyCorrection({
          queueId: row.id,
          reason: "parser-low-confidence",
          action: "fix",
          originalInput: {
            cardId: row.hobbyiqCardId,
            playerName: row.clean?.playerName ?? "(unknown)",
            price: row.clean?.price ?? 0,
            soldAt: row.clean?.soldAt ?? new Date().toISOString(),
            source: row.raw.vendor,
            parallel: row.clean?.parallel ?? null,
            cardNumber: row.clean?.cardNumber ?? null,
            title,
          },
          correction: {
            parallel: titleParsed.parallel,
            cardNumber: titleParsed.cardNumber,
            isAuto: titleParsed.isAuto,
            reasonNote: `auto-triage: title says "${titleParsed.parallel}" (slug ${titleParallelSlug}), stored was "${currentParallelSlug}" — parser wins per Drew's rule`,
          },
          adminUserId: "auto-triage-job",
        });
      } catch { /* corrections log is best-effort */ }

      // CF-AUTO-TRIAGE-CLOSE-QUEUE (Drew, 2026-07-28). When auto-triage
      // silently promotes a staging row, also mark ANY corresponding
      // verify_queue entries as `fixed` so the triage UI stops showing
      // them. Match by cardId + price + soldAt-day (same fuzzy key
      // the sync script uses). Best-effort; a miss just leaves the
      // queue row visible — Drew can approve/reject it manually.
      try {
        const soldDay = String(row.raw.vendorPayload.soldAt ?? "").slice(0, 10);
        const price = Number(row.raw.vendorPayload.price ?? 0);
        const { CosmosClient: _CC } = await import("@azure/cosmos");
        const client = new _CC(process.env.COSMOS_CONNECTION_STRING!);
        const q = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container(process.env.COSMOS_VERIFY_QUEUE_CONTAINER ?? "verify_queue");
        const { resources: matches } = await q.items.query<{ id: string; reason: string }>({
          query:
            "SELECT c.id, c.reason FROM c WHERE c.status = 'pending' AND c.input.cardId = @slug AND ABS(c.input.price - @p) < 0.02 AND STARTSWITH(c.input.soldAt, @day)",
          parameters: [
            { name: "@slug", value: row.hobbyiqCardId },
            { name: "@p", value: price },
            { name: "@day", value: soldDay },
          ],
        }).fetchAll();
        for (const m of matches) {
          await q.item(m.id, m.reason).patch([
            { op: "set", path: "/status", value: "fixed" },
            { op: "set", path: "/resolvedAt", value: new Date().toISOString() },
            { op: "set", path: "/resolvedBy", value: "auto-triage-job" },
          ]).catch(() => { /* best-effort */ });
        }
      } catch { /* never let queue sync break the triage */ }

      result.autoFixed += 1;
      const key = titleParsed.parallel ?? "Base";
      result.byNewParallel[key] = (result.byNewParallel[key] ?? 0) + 1;
    } catch {
      result.errors += 1;
    }
  }
  console.log(JSON.stringify({
    event: "auto_triage_batch_complete",
    source: "autoTriageJob.service",
    ...result,
  }));
  return result;
}
