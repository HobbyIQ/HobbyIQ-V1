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
//   2. Rolling price plausibility — is the price within the last 30d
//      dispersion band at this (slug, gradeTier), i.e. [p10/3, p90*3]?
//      Outside → price-outlier anomaly. Fewer than 8 comps → no verdict.
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
import { parseGradeFromTitle } from "./gradeParser.js";
import { normalizeHoldingFields } from "./holdingFieldNormalizer.service.js";
import type { StagingClean, StagingDoc } from "./compsStaging.service.js";
import { classifyTcg } from "./tcgVertical.service.js";
import { resolveVertical } from "./resolveVertical.service.js";

/** CF-DATA-CLEAN-MEDIAN-BY-GRADE: the bucket a sale belongs to for price
 *  plausibility. Raw and PSA 10 are different markets for the same card, so
 *  they must not share a median. */
/** Exported so the verify-queue loop-back re-runs the IDENTICAL tier bucketing
 *  the admission test used. A re-evaluated verdict is only trustworthy if it is
 *  computed the same way as the verdict it replaces — a copied helper that drifts
 *  would release rows on a rule this file no longer applies. */
export function gradeTierKey(company?: string | null, value?: number | null): string {
  const c = String(company ?? "").trim().toUpperCase();
  if (!c) return "raw";
  const v = typeof value === "number" && Number.isFinite(value) ? value : null;
  return v === null ? c : `${c}${v}`;
}

// CF-PRICE-BAND-FROM-DISPERSION (Drew, 2026-08-13: "lets check the anomaly out
// and fix").
//
// The band was median/3 .. median*3, which assumes every pool is tightly
// clustered. Bucketing by grade tier (CF-DATA-CLEAN-MEDIAN-BY-GRADE) fixed the
// graded-vs-raw comparison, but it cannot fix RAW: gradeTierKey collapses every
// ungraded copy into one "raw" bucket, and a raw pool has no condition
// dimension at all. A 1969 Topps common trades from a $3 beater to a $600
// near-mint copy — genuine 100x dispersion, in one bucket, by design.
//
// So a fixed ±3x brands ordinary condition variance as bad data. Measured
// 2026-08-13 on a 30,000-row anomaly sample: price-outlier was 46.6%, and the
// examples are exactly this — "1969 Topps #100 Base, 2287% of 30d median
// $44.95", "1955 Bowman #110 Base, 27% of $3.54". Those are sales, not errors,
// and status=anomaly means they never reach sold_comps.
//
// Band from the pool's OWN spread instead: p10..p90, widened by OUTLIER_FACTOR.
// Self-calibrating — a tight pool (modern graded) keeps a tight band, a
// dispersed pool (vintage raw) earns a wide one. What still trips are the
// failures worth catching: lot listings, typos, wrong-card matches, which sit
// orders of magnitude outside the observed range rather than inside its tail.
export interface PriceBand {
  median: number;
  /** 10th percentile of the 30d pool. */
  lo: number;
  /** 90th percentile of the 30d pool. */
  hi: number;
  n: number;
}

// Quantiles need more support than a median does. Below this we return NO
// verdict rather than guessing — extending the rule this file already applies
// to thin grade tiers: an unjudgeable row must not be branded an anomaly.
const MIN_BAND_SAMPLES = 8;
const OUTLIER_FACTOR = 3;

/** Build a dispersion band from an ASCENDING-sorted price array. */
export function priceBandFromSorted(sorted: number[]): PriceBand | null {
  const n = sorted.length;
  if (n < MIN_BAND_SAMPLES) return null;
  const q = (f: number) => sorted[Math.min(n - 1, Math.max(0, Math.floor(f * (n - 1))))];
  return { median: q(0.5), lo: q(0.1), hi: q(0.9), n };
}

/** Verdict for one price against a band. `null` detail means "in band". */
export function priceOutlierDetail(price: number, band: PriceBand): string | null {
  const ceiling = band.hi * OUTLIER_FACTOR;
  const floor = band.lo / OUTLIER_FACTOR;
  if (price <= ceiling && price >= floor) return null;
  return `$${price.toFixed(2)} outside 30d p10-p90 $${band.lo.toFixed(2)}-$${band.hi.toFixed(2)} ` +
    `(x${OUTLIER_FACTOR} → $${floor.toFixed(2)}-$${ceiling.toFixed(2)}, n=${band.n}, median $${band.median.toFixed(2)})`;
}

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

// CF-STAGING-LIMIT-CAP-WAS-THE-BOTTLENECK (Drew, 2026-08-13). The batch ceiling
// was duplicated: the route clamped `limit` to 500 AND so did this job. Raising
// only the route changed nothing — a limit=2500 call still reported
// scanned=500, which is how the second cap was found. Both now agree at 5000.
//
// This is a guard against a typo'd query param, not a throughput policy: the
// real limiters are this job's wall-clock and the caller's curl --max-time.
const MAX_JOB_BATCH = 5000;

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

  const limit = Math.max(1, Math.min(MAX_JOB_BATCH, opts.limit ?? 100));

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
  // CF-DRAINER-NEWEST-FIRST (Drew, 2026-08-06). Flip order so drainer
  // processes RECENT observations first. Old backlog still drains
  // when the fresh pipe is quiet.
  //
  // CF-DRAINER-PRIORITIZE-TCA (Drew, 2026-08-06). Also prefer TCA-source
  // rows (Drew: "this is the best data and a fire hose"). Try TCA-only
  // pass first; if we get a full batch, use it. Otherwise fill the
  // remaining slots from any-source pending. CardHedge still lands but
  // TCA gets to sold_comps first.
  const { resources: tcaFirst } = await staging.items.query<StagingDoc>({
    // CF-DATACLEAN-VENDOR-FIELD-PATH (Drew, 2026-08-13). This filtered on
    // c.raw.vendorPayload.source, which exists on ZERO staging rows — the
    // vendor lives at c.raw.vendor (promotionJob already reads it there).
    //
    // Both passes therefore matched nothing, and the fallback below could not
    // rescue it: in Cosmos `undefined != 'tca-ebay'` evaluates to undefined,
    // not true, so the "any other source" query returned 0 as well. The job
    // reported {"scanned":0,"cleaned":0} every run and looked healthy while
    // 3,513,701 rows sat in `pending` — nothing was ever cleaned, so promotion
    // (which reads status IN ('clean','verified')) had nothing to promote and
    // scanned 2 rows against a 3.5M backlog.
    query: `SELECT TOP @n * FROM c WHERE c.status = 'pending' AND c.raw.vendor = 'tca-ebay'${shardFilter} ORDER BY c.observedAt DESC`,
    parameters: [{ name: "@n", value: limit }, ...shardParams],
  }).fetchAll();
  let pending: StagingDoc[] = tcaFirst;
  if (pending.length < limit) {
    const remainder = limit - pending.length;
    const { resources: fill } = await staging.items.query<StagingDoc>({
      // Same field-path correction. IS_DEFINED guards the not-equals so a row
      // with no vendor at all still qualifies for the any-source fill rather
      // than silently evaluating to undefined.
      query: `SELECT TOP @n * FROM c WHERE c.status = 'pending' AND (NOT IS_DEFINED(c.raw.vendor) OR c.raw.vendor != 'tca-ebay')${shardFilter} ORDER BY c.observedAt DESC`,
      parameters: [{ name: "@n", value: remainder }, ...shardParams],
    }).fetchAll();
    pending = [...pending, ...fill];
  }

  // CF-DATA-CLEAN-BATCH-MEDIAN (Drew, 2026-08-06). Pre-fetch rolling
  // medians for every unique slug in this batch in a SINGLE
  // cross-partition query so classifyRow doesn't fan out to N
  // per-row queries. Before this: 500 rows × 1 query = ~5000 RU/batch,
  // ~80s wall-clock. After: 1 query + 1 write per row.
  const medianCache = new Map<string, PriceBand>();
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
          // CF-DATA-CLEAN-MEDIAN-BY-GRADE (Drew, 2026-08-13). The median was
          // GRADE-BLIND — bucketed by slug alone — so on a card that mostly
          // trades raw, every graded sale read as a huge outlier. Real example
          // from the backlog: a PSA 10 1968 Topps #573 at $153.50 flagged as
          // "4723% of 30d median $3.25", where $3.25 is the raw-commons median.
          //
          // price-outlier was 68% of all anomalies and 23% of them carried a
          // grade, so a large share of the anomaly bucket is legitimate graded
          // sales being compared against raw prices. This is the "Check 3:
          // cross-grade sanity" the file below notes as deferred.
          //
          // Bucket per (slug, gradeTier) so like compares with like.
          const { resources: rows } = await soldComps.items.query<{
            hobbyiqCardId: string; price: number; gradeCompany?: string | null; gradeValue?: number | null;
          }>({
            query: `SELECT c.hobbyiqCardId, c.price, c.gradeCompany, c.gradeValue FROM c WHERE c.hobbyiqCardId IN (${inList}) AND c.soldAt >= @cutoff`,
            parameters: params,
          }).fetchAll();
          const bySlug = new Map<string, number[]>();
          for (const r of rows) {
            const p = Number(r.price);
            if (!Number.isFinite(p) || p <= 0) continue;
            const key = `${r.hobbyiqCardId}||${gradeTierKey(r.gradeCompany, r.gradeValue)}`;
            const arr = bySlug.get(key) ?? [];
            arr.push(p);
            bySlug.set(key, arr);
          }
          for (const [slug, prices] of bySlug) {
            prices.sort((a, b) => a - b);
            const band = priceBandFromSorted(prices);
            if (band) medianCache.set(slug, band);
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

      // CF-TCG-IS-NOT-BLOCKED (Drew, 2026-08-13). An earlier revision of this
      // routed every TCG row to a `holding-tcg` park, on the theory that TCG
      // "can never match a sports catalog". That was WRONG and would have
      // pulled working data out of the pipeline:
      //
      //   sold_comps with hiq:pokemon:*   402,809 comps — matched and promoted
      //   card_catalog sport=pokemon       48,094 rows
      //
      // The vertical is live. Slugs are `hiq:{vertical}:…` and `sport` is just a
      // namespace string, so Pokemon matches exactly like baseball does. The
      // conclusion came from a biased sample: the 8 unmatched slugs I inspected
      // happened to all be `hiq:baseball:<pokemon-set>`, which is the
      // MISCLASSIFIED tail (~0.6%), not TCG as a category (7.7%).
      //
      // So there is no park here. Rows whose vertical is wrong need their sport
      // CORRECTED so they compute a matching slug — see resolveVertical.service
      // — which makes them promotable rather than shelved. Tagging is recorded
      // for visibility only.
      const tcg = classifyTcg({
        sport: clean.sport ?? row.raw.identityHint.sport,
        title: row.raw.vendorPayload.title,
        hobbyiqCardId: row.hobbyiqCardId,
      });
      if (tcg.isTcg && !parseHobbyIqCardId(row.hobbyiqCardId)?.sport?.match(/pokemon|yugioh|tcg|mtg|lorcana/)) {
        // TCG content wearing a SPORT slug — the population that cannot match.
        clean.normalizations.push(`tcg-vertical-mismatch:${tcg.reason}`);
      }
      const nextStatus: StagingDoc["status"] =
        clean.anomalies.length === 0 ? "clean" : "anomaly";
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
async function classifyRow(row: StagingDoc, soldComps: Container | null, medianCache?: Map<string, PriceBand>): Promise<StagingClean> {
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
  // CF-VERTICAL-NOT-SPORT wired in (Drew, 2026-08-14). resolveVertical checks
  // TCG before any sport keyword, because a Pokemon title contains none — it
  // would otherwise fall through to the "baseball" default and compute a slug
  // (hiq:baseball:2000:neo-genesis:…) that no catalog can ever hold.
  //
  // The slug's own sport is the fallback rather than a hardcoded default, so a
  // row that was already correctly verticalled keeps its value.
  let sport = parsed?.sport ?? raw.identityHint.sport ?? "baseball";
  if (title) {
    const res = resolveVertical({
      declared: parsed?.sport ?? raw.identityHint.sport ?? null,
      title,
      hobbyiqCardId: row.hobbyiqCardId,
      fallback: sport,
    });
    if (res.vertical !== sport) sport = res.vertical;
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
      // CF-ANOMALY-DIRECTION (Drew, 2026-08-06). Only flag as anomaly
      // when title's setKey is MORE specific than the slug's. If the
      // slug is more specific (e.g. slug="bowman-chrome" vs title
      // says just "Bowman"), the slug wins per slug-recompute-only-
      // improve doctrine — no anomaly. Heuristic: length + prefix.
      const titleMoreSpecific =
        titleSetSlug.length > parsed.setKey.length &&
        titleSetSlug.startsWith(parsed.setKey);
      if (titleMoreSpecific) {
        // CF-SETKEY-UPGRADE-IS-NOT-AN-ANOMALY (Drew, 2026-08-13: "lets check
        // the anomaly out and fix").
        //
        // This branch RESOLVES the discrepancy — it adopts the more specific
        // setKey on the next line — and then used to raise an anomaly anyway,
        // which parks the row in `anomaly` where promotion (status IN
        // ('clean','verified')) never picks it up. Same shape as the no-image
        // bug: intent "record that we improved this", effect "never promote".
        //
        // Adopting a strictly-more-specific setKey is the sanctioned operation
        // under slug-recompute-only-improve, not a low-confidence parse. The
        // guard above already establishes strictness (longer AND prefixed), so
        // bowman → bowman-chrome and topps → topps-transcendent upgrade, while
        // an orthogonal disagreement falls to the else branch untouched.
        //
        // Measured 2026-08-13: parser-low-confidence was 53% of a 30,000-row
        // anomaly sample, dominated by exactly this verdict.
        derivedSetName = titleSetSlug;
        normalizations.push("setKey-preferred-from-title");
      } else {
        // Slug is more specific or orthogonal — keep slug, no anomaly.
        normalizations.push("setKey-slug-more-specific-or-neutral");
      }
    } else {
      normalizations.push("setKey-agrees-with-title");
    }
  }

  // Check 1: parser sanity — title vs stored slug parallel/isAuto.
  if (title && parsed) {
    const titleParsed = parseListingIdentity(title);
    const titleParallelSlug = slugify(titleParsed.parallel ?? "base");
    if (titleParallelSlug !== parsed.parallel) {
      // CF-ANOMALY-DIRECTION (Drew, 2026-08-06). Suppress the false
      // positive where title has no parallel info (defaults to "base")
      // and slug is more specific — that's slug-more-specific, keep it.
      // Only flag when both are specific-and-different.
      const titleIsDefault = titleParallelSlug === "base" && parsed.parallel !== "base";
      if (!titleIsDefault) {
        anomalies.push({
          kind: "parser-low-confidence",
          detail: `title parallel "${titleParsed.parallel}" (slug=${titleParallelSlug}) disagrees with staging parallel "${parsed.parallel}"`,
        });
      } else {
        normalizations.push("parallel-slug-more-specific");
      }
    } else {
      normalizations.push("title-parallel-agrees");
    }
    if (titleParsed.isAuto !== parsed.isAuto) {
      // CF-ANOMALY-DIRECTION: title says non-auto but slug says auto →
      // slug is more specific, keep it. Only flag the other direction
      // (title claims auto, slug says non-auto — real disagreement).
      const slugMoreSpecific = titleParsed.isAuto === false && parsed.isAuto === true;
      if (!slugMoreSpecific) {
        anomalies.push({
          kind: "parser-low-confidence",
          detail: `title isAuto=${titleParsed.isAuto} disagrees with staging isAuto=${parsed.isAuto}`,
        });
      } else {
        normalizations.push("isAuto-slug-more-specific");
      }
    }
  }

  // Check 2: rolling-median price plausibility.
  // CF-DATA-CLEAN-BATCH-MEDIAN (Drew, 2026-08-06). Prefer the batched
  // pre-fetch in medianCache — falls back to a per-row query only when
  // the caller didn't supply the cache (used by legacy call sites).
  if (soldComps && price > 0) {
    try {
      // Compare against this row's OWN grade tier. When that tier has too few
      // sales we deliberately return NO verdict rather than falling back to the
      // mixed-grade median — an unjudgeable row should not be branded an
      // anomaly, which is exactly how legitimate graded sales ended up here.
      // Parse the grade here rather than reusing `gradeParsed`, which is
      // declared further down this function (line ~529) — the price check runs
      // before it exists. parseGradeLabel is pure and cheap.
      const rowGrade = title ? parseGradeFromTitle(title) : null;
      const rowGradeKey = gradeTierKey(rowGrade?.gradeCompany, rowGrade?.gradeValue);
      let band: PriceBand | null = medianCache?.get(`${row.hobbyiqCardId}||${rowGradeKey}`) ?? null;
      if (band === null && !medianCache) {
        const rollingCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
        const { resources: rollingRows } = await soldComps.items.query<{
          price: number; gradeCompany?: string | null; gradeValue?: number | null;
        }>({
          query: "SELECT c.price, c.gradeCompany, c.gradeValue FROM c WHERE c.hobbyiqCardId = @hiq AND c.soldAt >= @cutoff",
          parameters: [{ name: "@hiq", value: row.hobbyiqCardId }, { name: "@cutoff", value: rollingCutoff }],
        }).fetchAll();
        const prices = rollingRows
          .filter((r) => gradeTierKey(r.gradeCompany, r.gradeValue) === rowGradeKey)
          .map((r) => Number(r.price)).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
        band = priceBandFromSorted(prices);
      }
      if (band !== null) {
        const detail = priceOutlierDetail(price, band);
        if (detail) anomalies.push({ kind: "price-outlier", detail });
        else normalizations.push("price-within-30d-band");
      }
    } catch { /* rolling median failure is non-fatal */ }
  }

  // Check 3: cross-grade sanity — deferred until GRADE_MULTIPLIER
  // helper returns the full cell (rawMedian, gradedMedian, p75) which
  // needs a small helper add. Placeholder marker so we know to add it.
  // (See recon report #1 — the data supports it, just needs a wrapper.)

  // Check 4: slug conflict against card_catalog — deferred until
  // catalog seed reaches meaningful coverage.

  // Check 5: image presence.
  //
  // CF-NO-IMAGE-IS-NOT-AN-ANOMALY (Drew, 2026-08-13: "if no image, then no
  // need to do it"). A sale without a picture is still a valid PRICE POINT.
  // The photo is enrichment; the sale is the data.
  //
  // This used to push an anomaly, which contradicted this check's own stated
  // rule ("still routed downstream, not rejected"): status=anomaly means
  // promotion — which reads status IN ('clean','verified') — never picks the
  // row up. Intent was "do not reject", effect was "never promote".
  //
  // It mattered enormously. Blob mirroring is currently failing account-wide
  // with "This request is not authorized to perform this operation using this
  // permission", so EVERY row got mirrorError and therefore no-image. Measured
  // 2026-08-13: 1,498 of 1,500 freshly-cleaned rows were anomalies, 1,498 of
  // them for no-image — i.e. a storage permission was holding 3.5M sales out
  // of the pool. price-outlier was only 89 of that 1,500.
  //
  // Recorded either way so image-verify can still enrich later and so the
  // mirror failure stays visible — it just no longer blocks the price.
  const hasIngestImageUrl = Boolean(raw.vendorPayload.imageUrl);
  const hasMirrorSuccess = Boolean(row.mirroredImage?.blobUrl) && !row.mirroredImage?.mirrorError;
  if (row.mirroredImage?.mirrorError) {
    normalizations.push(`image-mirror-failed:${row.mirroredImage.mirrorError.reason}`);
  } else if (!hasIngestImageUrl && !hasMirrorSuccess) {
    normalizations.push("no-image");
  } else {
    normalizations.push("image-mirrored");
  }

  // CF-DATA-CLEAN-EXTRACT-GRADE (Drew, 2026-07-28). Title often carries
  // grade tokens (PSA 10, BGS 9.5, SGC 9, "Raw", "Ungraded"). Extract
  // now so the triage UI + promotion carry the right grade — the
  // legacy migration copied sold_comps.gradeCompany/Value verbatim
  // but many Cardsight rows never captured them.
  const gradeParsed = title ? parseGradeFromTitle(title) : null;

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
