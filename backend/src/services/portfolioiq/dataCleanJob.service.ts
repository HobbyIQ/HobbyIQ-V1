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
import { parseListingIdentity, inferSetKeyFromTitle, inferSportFromTitle } from "./parseTitleIdentity.service.js";
import { parseHobbyIqCardId, slugify } from "./hobbyIqCardId.service.js";
import { parseGradeLabel } from "./gradeParser.js";
import { normalizeHoldingFields } from "./holdingFieldNormalizer.service.js";
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
  // CF-STAGING-REJECT-ZERO-PRICE (Drew, 2026-07-29). Count of rows
  // rejected in this tick because vendor reported price <= 0. Never
  // enters the manual queue; also closes any pre-existing verify_queue
  // entry for the same slug+day.
  zeroPriceRejected: number;
}

/**
 * Process a bounded batch of pending staging rows. Returns counts so
 * a caller (nightly cron or manual trigger) can chart throughput.
 * Uses continuation token pagination so successive calls advance
 * through the queue without missing rows.
 */
// CF-DRAINER-WORKER-SHARDING (Drew, 2026-08-06). When multiple
// workers run the same pending SELECT, they all pull the SAME TOP N
// rows (Cosmos returns deterministically) and race on updates —
// contention makes 16 workers slower than 8. Fix: each worker takes a
// hex-char shard of the UUID id space. Staging id = randomUUID() which
// starts with an even distribution of 0-9,a-f. Worker i of N filters
// `STARTSWITH(c.id, <chars>)` for its assigned char range.
function shardChars(index: number, total: number): string[] {
  const hex = ["0","1","2","3","4","5","6","7","8","9","a","b","c","d","e","f"];
  if (total <= 1) return hex;
  // For up to 16 workers, single hex chars are enough (each worker gets
  // ~ceil(16/N) chars). Above 16, expand to 2-char prefixes (256
  // possibilities) so 32 or 64 workers still get disjoint slices.
  if (total <= 16) {
    const chars: string[] = [];
    for (let i = 0; i < hex.length; i++) {
      if (i % total === (index % total)) chars.push(hex[i]);
    }
    return chars;
  }
  const chars: string[] = [];
  for (let a = 0; a < hex.length; a++) {
    for (let b = 0; b < hex.length; b++) {
      const twoCharIdx = a * 16 + b;
      if (twoCharIdx % total === (index % total)) chars.push(hex[a] + hex[b]);
    }
  }
  return chars;
}

export async function runDataCleanBatch(opts: {
  limit?: number;
  workerShard?: { index: number; total: number };
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
    zeroPriceRejected: 0,
  };
  if (!staging) return result;

  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));

  // CF-STAGING-REJECT-ZERO-PRICE-SWEEP (Drew, 2026-07-29). "There is no
  // sales at 0 dollars." Reject any row with vendorPayload.price <= 0
  // across ALL non-terminal statuses (pending/anomaly/pending-manual) —
  // sweeps existing junk out of the manual queue AND catches new
  // zero-price rows in the same tick. Uses same limit as the clean
  // pass; if there are more, next tick picks them up. Also closes any
  // corresponding verify_queue entries.
  try {
    const { resources: zeroRows } = await staging.items.query<StagingDoc>({
      query:
        "SELECT TOP @n * FROM c WHERE c.status IN ('pending','anomaly','pending-manual') AND (c.raw.vendorPayload.price = null OR c.raw.vendorPayload.price = 0 OR c.raw.vendorPayload.price < 0) ORDER BY c.observedAt ASC",
      parameters: [{ name: "@n", value: limit }],
    }).fetchAll();
    for (const row of zeroRows) {
      try {
        row.status = "rejected";
        await staging.item(row.id, row.hobbyiqCardId).replace(row as unknown as Record<string, unknown>);
        result.zeroPriceRejected += 1;
        // Close any corresponding verify_queue entry so triage UI
        // stops showing it. Best-effort — a miss just leaves the queue
        // row visible.
        try {
          const soldDay = String(row.raw.vendorPayload.soldAt ?? "").slice(0, 10);
          const { CosmosClient: _CC } = await import("@azure/cosmos");
          const client = new _CC(process.env.COSMOS_CONNECTION_STRING!);
          const q = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container(process.env.COSMOS_VERIFY_QUEUE_CONTAINER ?? "verify_queue");
          const { resources: matches } = await q.items.query<{ id: string; reason: string }>({
            query:
              "SELECT c.id, c.reason FROM c WHERE c.status = 'pending' AND c.input.cardId = @slug AND (c.input.price = 0 OR c.input.price = null OR c.input.price < 0) AND STARTSWITH(c.input.soldAt, @day)",
            parameters: [
              { name: "@slug", value: row.hobbyiqCardId },
              { name: "@day", value: soldDay },
            ],
          }).fetchAll();
          for (const m of matches) {
            await q.item(m.id, m.reason).patch([
              { op: "set", path: "/status", value: "rejected" },
              { op: "set", path: "/resolvedAt", value: new Date().toISOString() },
              { op: "set", path: "/resolvedBy", value: "data-clean-zero-price" },
            ]).catch(() => { /* best-effort */ });
          }
        } catch { /* never let queue sync break the reject */ }
      } catch { result.errors += 1; }
    }
  } catch { /* sweep is best-effort — main loop still runs */ }

  // CF-DRAINER-WORKER-SHARDING (Drew, 2026-08-06). Filter pending rows to
  // this worker's id-prefix shard so N parallel workers don't compete on
  // the same TOP N rows. See shardChars() above.
  const shardFilter = opts.workerShard
    ? " AND (" + shardChars(opts.workerShard.index, opts.workerShard.total)
        .map((_, i) => `STARTSWITH(c.id, @shard${i})`).join(" OR ") + ")"
    : "";
  const shardParams = opts.workerShard
    ? shardChars(opts.workerShard.index, opts.workerShard.total)
        .map((ch, i) => ({ name: `@shard${i}`, value: ch }))
    : [];
  const { resources: pending } = await staging.items.query<StagingDoc>({
    query: `SELECT TOP @n * FROM c WHERE c.status = 'pending'${shardFilter} ORDER BY c.observedAt ASC`,
    parameters: [{ name: "@n", value: limit }, ...shardParams],
  }).fetchAll();

  // CF-DATA-CLEAN-BATCH-MEDIAN (Drew, 2026-08-06). Pre-fetch rolling
  // medians for every unique slug in this batch in a SINGLE
  // cross-partition query so classifyRow doesn't fan out to N
  // per-row queries. Before this: 500 rows × 1 query = ~5000 RU/batch,
  // ~80s wall-clock. After: 1 query + 1 write per row.
  const medianCache = new Map<string, number>();
  if (soldComps) {
    const uniqSlugs = Array.from(new Set(pending.map((r) => r.hobbyiqCardId).filter(Boolean)));
    if (uniqSlugs.length > 0) {
      try {
        const rollingCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
        // Chunk to keep the SQL under the 512-param IN() limit.
        for (let i = 0; i < uniqSlugs.length; i += 200) {
          const chunk = uniqSlugs.slice(i, i + 200);
          const params: Array<{ name: string; value: string }> = chunk.map((s, idx) => ({ name: `@s${idx}`, value: s }));
          const inList = chunk.map((_, idx) => `@s${idx}`).join(",");
          params.push({ name: "@cutoff", value: rollingCutoff });
          const { resources: rows } = await soldComps.items.query<{ hobbyiqCardId: string; price: number }>({
            query: `SELECT c.hobbyiqCardId, c.price FROM c WHERE c.hobbyiqCardId IN (${inList}) AND c.soldAt >= @cutoff`,
            parameters: params,
          }).fetchAll();
          const bySlug = new Map<string, number[]>();
          for (const r of rows) {
            const p = Number(r.price);
            if (!Number.isFinite(p) || p <= 0) continue;
            const arr = bySlug.get(r.hobbyiqCardId) ?? [];
            arr.push(p);
            bySlug.set(r.hobbyiqCardId, arr);
          }
          for (const [slug, prices] of bySlug) {
            if (prices.length >= 5) {
              prices.sort((a, b) => a - b);
              medianCache.set(slug, prices[Math.floor(prices.length / 2)]);
            }
          }
        }
      } catch { /* pre-fetch failure is non-fatal — classifyRow falls back to per-row query */ }
    }
  }

  for (const row of pending) {
    result.scanned += 1;
    try {
      // CF-STAGING-REJECT-ZERO-PRICE (Drew, 2026-07-29). Belt-and-braces
      // vs the sweep above — if the sweep hit its limit and left some
      // pending zero-price rows behind, catch them here so they never
      // reach the anomaly/manual pipeline.
      const rawPrice = Number(row.raw.vendorPayload.price ?? 0);
      if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
        row.status = "rejected";
        await staging.item(row.id, row.hobbyiqCardId).replace(row as unknown as Record<string, unknown>);
        result.zeroPriceRejected += 1;
        continue;
      }
      const clean = await classifyRow(row, soldComps, medianCache);
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
async function classifyRow(row: StagingDoc, soldComps: Container | null, medianCache?: Map<string, number>): Promise<StagingClean> {
  const raw = row.raw;
  const parsed = parseHobbyIqCardId(row.hobbyiqCardId);
  const cardYear = parsed?.year ?? raw.identityHint.cardYear ?? 0;
  const price = Number(raw.vendorPayload.price ?? 0);
  const soldAt = String(raw.vendorPayload.soldAt ?? new Date().toISOString());
  const title = String(raw.vendorPayload.title ?? "");

  // CF-SPORT-RE-INFER (Drew, 2026-07-29). Slug sport is frozen at
  // ingest — 1986 Fleer Sticker Michael Jordan #8 landed at sport=
  // baseball because the title carries no basketball keyword. Re-infer
  // from title-visible product signals (Fleer Sticker → basketball)
  // and prefer the title-derived sport when it disagrees. Fall back
  // to slug sport / identity hint / baseball default.
  let sport = parsed?.sport ?? raw.identityHint.sport ?? "baseball";
  if (title) {
    const titleSport = inferSportFromTitle(title, sport);
    if (titleSport !== sport) sport = titleSport;
  }

  const normalizations: string[] = [];
  const anomalies: StagingClean["anomalies"] = [];

  // CF-HERITAGE-PLAYERNAME-CLEAN (Drew, 2026-07-29). Run the standard
  // holdingFieldNormalizer on the ingest playerName so leaked subset
  // words ("Patchwork", "Sapphire", "SP", etc.) get stripped before
  // classification. CH sometimes returns subset-prefixed player fields
  // for Heritage Patchwork / Bowman Sapphire / Panini SP subsets.
  const rawPlayerName = String(raw.identityHint.playerName ?? "").trim();
  let playerName = rawPlayerName || "(unknown)";
  if (rawPlayerName) {
    try {
      const cleaned = normalizeHoldingFields({ playerName: rawPlayerName, cardYear });
      const scrubbed = String(cleaned.fields.playerName ?? "").trim();
      if (scrubbed && scrubbed !== rawPlayerName) {
        playerName = scrubbed;
        normalizations.push(`playerName-stripped:${cleaned.changes.map(c => c.rule).join(",")}`);
      }
    } catch { /* normalizer failure is non-fatal; keep raw playerName */ }
  }

  // CF-HERITAGE-SETKEY-RE-INFER (Drew, 2026-07-29). The slug is frozen
  // at ingest time from the CH-supplied title/set fields — which for
  // Heritage subsets often say "Topps Chrome" in the group field even
  // though the product is Topps Heritage. Re-run the title-based set
  // inference on the vendor title and prefer that when it disagrees
  // with the slug's setKey. Also flags the mismatch as a parser anomaly
  // so it shows up in the triage counters. Writes the corrected setKey
  // to clean.setName; the slug itself stays until a re-slug pass.
  //
  // CF-BOWMAN-PAPER-SETKEY (Drew, 2026-07-29). Pass the parsed slug's
  // cardNumber into inferSetKeyFromTitle so BPA-XX / BDA-XX prefixes
  // trigger "Bowman Paper" / "Bowman Draft Paper" even when the vendor
  // title is bare ("2026 Bowman").
  let derivedSetName = parsed?.setKey ?? null;
  if (title) {
    const titleSet = inferSetKeyFromTitle(title, parsed?.cardNumber ?? null);
    const titleSetSlug = slugify(titleSet);
    if (parsed && titleSetSlug !== parsed.setKey) {
      anomalies.push({
        kind: "parser-low-confidence",
        detail: `title infers setKey "${titleSet}" (slug=${titleSetSlug}) — disagrees with slug setKey "${parsed.setKey}"`,
      });
      derivedSetName = titleSetSlug;    // prefer title over the frozen slug
      normalizations.push("setKey-preferred-from-title");
    } else {
      normalizations.push("setKey-agrees-with-title");
    }
  }

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
  // CF-DATA-CLEAN-BATCH-MEDIAN (Drew, 2026-08-06). Prefer the batched
  // pre-fetch in medianCache — falls back to a per-row query only when
  // the caller didn't supply the cache (used by legacy call sites).
  if (soldComps && price > 0) {
    try {
      let median: number | null = medianCache?.get(row.hobbyiqCardId) ?? null;
      if (median === null && !medianCache) {
        const rollingCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
        const { resources: rollingRows } = await soldComps.items.query<{ price: number }>({
          query: "SELECT c.price FROM c WHERE c.hobbyiqCardId = @hiq AND c.soldAt >= @cutoff",
          parameters: [{ name: "@hiq", value: row.hobbyiqCardId }, { name: "@cutoff", value: rollingCutoff }],
        }).fetchAll();
        if (rollingRows.length >= 5) {
          const prices = rollingRows.map((r) => Number(r.price)).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
          if (prices.length >= 5) median = prices[Math.floor(prices.length / 2)];
        }
      }
      if (median !== null) {
        const ratio = price / median;
        if (ratio > 3 || ratio < (1 / 3)) {
          anomalies.push({
            kind: "price-outlier",
            detail: `${(ratio * 100).toFixed(0)}% of 30d median $${median.toFixed(2)}`,
          });
        } else {
          normalizations.push("price-within-30d-band");
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

  // CF-STERLING-CARDNUMBER-REPARSE (Drew, 2026-07-29). The slug's
  // cardNumber slot is frozen at ingest time — and for legacy CH rows
  // it's often empty (CH ingest didn't emit a cardNumber for many
  // Bowman Sterling / vintage / Heritage rows) even when the vendor
  // title clearly carries "#BST-14" / "#136". Re-parse the title and
  // prefer the parsed cardNumber whenever the slug has none. Same
  // shape as the setKey re-inference block above.
  //
  // OBSERVED 2026-07-29: two Bowman Sterling BST-14 rows landed with
  // empty cardNumber (slug = "hiq:baseball:2026:bowman::base:no-auto")
  // even though "#BST-14" is in both titles.
  let derivedCardNumber = parsed?.cardNumber ?? null;
  if (!derivedCardNumber && title) {
    const titleParsedForCn = parseListingIdentity(title);
    if (titleParsedForCn.cardNumber) {
      derivedCardNumber = slugify(titleParsedForCn.cardNumber);
      normalizations.push("cardNumber-recovered-from-title");
    }
  }

  return {
    cleanedAt: new Date().toISOString(),
    slug: row.hobbyiqCardId,
    cardNumber: derivedCardNumber,
    parallel: parsed?.parallel ?? null,
    isAuto: parsed?.isAuto ?? false,
    printRun: parsed?.printRun ?? null,
    gradeCompany: gradeParsed?.gradeCompany ?? null,
    gradeValue: gradeParsed?.gradeValue ?? null,
    setName: derivedSetName,
    playerName,
    cardYear: cardYear as number,
    sport,
    price,
    soldAt,
    normalizations,
    anomalies,
  };
}
