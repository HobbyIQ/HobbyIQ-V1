// CF-HOBBYIQ-FMV (Drew, 2026-07-23, "we set the market" surface).
// Public HobbyIQ price for a canonical hobbyiqCardId slug. Reads from
// OUR sold_comps pool (not vendor calls). No vendor attribution — this
// is HobbyIQ's own price.
//
// Design principles:
//   - Deterministic given (slug, grade filter): same inputs → same output.
//   - Zero vendor calls. Every byte comes from sold_comps rows we own.
//   - NEVER returns "no data" when we can compute something reasonable.
//     Fallback ladder — direct-slug → cross-printRun → sibling-parallel
//     → family-baseline. First rung that produces ≥1 comp wins; the
//     `method` field records which rung fired so iOS can render a
//     confidence hint.
//   - Rich breakdown: comp count by source, autoStyle mix, gradeQualifier
//     mix, recent comps with all fields iOS wants for badges.
//   - Trend: OLS regression when n≥3; anchor slope when n=2; flat below.

import { CosmosClient, type Container } from "@azure/cosmos";
import { parseHobbyIqCardId } from "./hobbyIqCardId.service.js";
import { loadPopulationForSlug, type CardPopulationLookup } from "./cardPopulationLookup.service.js";
import { getGraderPremium } from "../compiq/compiqEstimate.service.js";

// CF-HOBBYIQ-FMV-EXCLUDE-USER-PURCHASE (Drew, 2026-07-24). Comps with
// source="ebay-user-purchase" are user cost-basis imports, NOT open-market
// sales. Including them in the FMV pool causes "FMV = purchase price"
// for cards where a single user's import is the only comp. Filter them
// out at the SQL layer so no rung ever sees them.
const EXCLUDED_SOURCES = ["ebay-user-purchase"];

export interface HobbyIqFmvInput {
  hobbyiqCardId: string;              // canonical slug (hiq:sport:year:...)
  gradeCompany?: string | null;       // null = raw
  gradeValue?: number | null;
  /** Freshness cutoff. Rows older than this are dropped. Default 180 days. */
  maxAgeDays?: number;
  /** Max comps to include in the recentComps preview (for iOS render). */
  previewLimit?: number;
}

export interface HobbyIqFmvComp {
  price: number;
  soldAt: string;
  source: string;
  parallel?: string | null;
  autoStyle?: "on-card" | "sticker" | null;
  gradeQualifier?: string | null;
  url?: string | null;
}

export interface HobbyIqFmvBreakdown {
  bySource: Record<string, number>;
  byAutoStyle: {
    onCard: number;
    sticker: number;
    unknown: number;
  };
  byGradeQualifier: Record<string, number>;
}

export interface HobbyIqFmvTrend {
  direction: "up" | "down" | "flat";
  slopePerMonthPct: number;
  method: "regression" | "anchor" | "none";
}

/** Which rung of the fallback ladder produced the number. */
export type HobbyIqFmvMethod =
  | "direct-slug"                // exact slug + grade match (highest confidence)
  | "cross-printrun"             // same identity ignoring printRun (specific variants exist, this one doesn't)
  | "same-printrun-cross-parallel" // same cardNumber + auto + printRun, other parallels (best sibling for numbered cards)
  | "printrun-discovery"         // target has no printRun; find the DOMINANT printRun for this identity and use it
  | "sibling-parallel"           // same cardNumber + auto, different parallels (all variants of the same card)
  | "family-baseline"            // same year + cardNumber, any variant (broadest same-card fallback)
  | "grade-cross-raw"            // grade requested but no graded comps at any rung; raw median × graded multiplier
  | "no-basis";                  // truly nothing — should be rare after the ladder

export interface HobbyIqFmvResult {
  slug: string;
  fmv: number | null;
  compCount: number;
  min: number | null;
  max: number | null;
  breakdown: HobbyIqFmvBreakdown;
  trend: HobbyIqFmvTrend;
  recentComps: HobbyIqFmvComp[];
  /** CF-HOBBYIQ-FMV-LADDER (Drew, 2026-07-23). Which rung produced the
   *  fmv. iOS can render a confidence indicator + human-readable note. */
  method: HobbyIqFmvMethod;
  basisNote: string;
  confidence: number;      // 0.0-1.0
  /** CF-HOBBYIQ-FMV-POPULATION (Drew, 2026-07-24). Per-grader graded
   *  population for the resolved card identity. Present when card_population
   *  has data for this card; null when the fill hasn't reached it yet or
   *  Cardsight has no pop data for the SKU. iOS renders a scarcity badge
   *  (e.g. "PSA10 pop 47"). NOT yet used in fmv math — that comes with
   *  scarcity multiplier calibration in a follow-up. */
  population: CardPopulationLookup | null;
  computedAt: string;
  cachedFrom: "sold_comps";
}

interface PoolRow {
  price: number;
  soldAt: string;
  source: string;
  parallel?: string | null;
  autoStyle?: "on-card" | "sticker" | null;
  gradeQualifier?: string | null;
  url?: string | null;
  isAuto?: boolean;
  printRun?: number | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
}

let cachedContainer: Container | null = null;
async function getSoldCompsContainer(): Promise<Container | null> {
  if (cachedContainer) return cachedContainer;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    cachedContainer = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
    return cachedContainer;
  } catch {
    return null;
  }
}

/** Fetch rows by an arbitrary SQL WHERE clause. Encapsulates the
 *  cross-partition query + freshness + column list. */
async function queryPool(
  container: Container,
  whereClause: string,
  parameters: Array<{ name: string; value: string | number | boolean | null }>,
  cutoffIso: string,
): Promise<PoolRow[]> {
  const params = [
    ...parameters,
    { name: "@from", value: cutoffIso },
  ];
  try {
    const excludedList = EXCLUDED_SOURCES.map((s) => `'${s}'`).join(", ");
    const { resources } = await container.items.query({
      query: `SELECT c.price, c.soldAt, c.source, c.parallel, c.autoStyle, c.gradeQualifier, c.url,
                     c.isAuto, c.printRun, c.gradeCompany, c.gradeValue
              FROM c
              WHERE ${whereClause} AND c.soldAt > @from AND c.source NOT IN (${excludedList})
              ORDER BY c.soldAt DESC`,
      parameters: params,
    }).fetchAll();
    return resources as PoolRow[];
  } catch {
    return [];
  }
}

/** Apply the caller's grade filter in-JS (SQL side is optimistic; JS
 *  handles the null-vs-undefined case that Cosmos SQL fumbles). */
function filterByGrade(
  rows: PoolRow[],
  gradeCompany: string | null,
  gradeValue: number | null,
): PoolRow[] {
  const isRawRequest = !gradeCompany && gradeValue === null;
  return rows.filter((r) => {
    const docCompany = typeof r.gradeCompany === "string"
      ? r.gradeCompany.trim().toUpperCase()
      : "";
    const docValue = typeof r.gradeValue === "number" && Number.isFinite(r.gradeValue)
      ? r.gradeValue
      : null;
    const docIsRaw = docCompany === "" && docValue === null;
    if (isRawRequest) return docIsRaw;
    return docCompany === (gradeCompany ?? "").trim().toUpperCase()
      && docValue === gradeValue;
  });
}

export async function computeHobbyIqFmv(input: HobbyIqFmvInput): Promise<HobbyIqFmvResult> {
  const slug = String(input.hobbyiqCardId ?? "").trim();
  const now = new Date();

  const noBasis: HobbyIqFmvResult = {
    slug,
    fmv: null,
    compCount: 0,
    min: null,
    max: null,
    breakdown: { bySource: {}, byAutoStyle: { onCard: 0, sticker: 0, unknown: 0 }, byGradeQualifier: {} },
    trend: { direction: "flat", slopePerMonthPct: 0, method: "none" },
    recentComps: [],
    method: "no-basis",
    basisNote: "No comparable sales in the last 180 days",
    confidence: 0,
    population: null,
    computedAt: now.toISOString(),
    cachedFrom: "sold_comps",
  };

  if (!slug || !slug.startsWith("hiq:")) return noBasis;

  const container = await getSoldCompsContainer();
  if (!container) return noBasis;

  const parsed = parseHobbyIqCardId(slug);
  if (!parsed) return noBasis;

  // Fire the population lookup in parallel with the first ladder rung. It
  // reads OUR containers (card_catalog → card_population) so it's cheap;
  // running it concurrently with the pool queries hides its latency.
  const populationPromise = loadPopulationForSlug(slug).catch(() => null);

  const maxAgeDays = input.maxAgeDays ?? 180;
  const cutoffIso = new Date(now.getTime() - maxAgeDays * 86_400_000).toISOString();
  const gradeCompany = input.gradeCompany ?? null;
  const gradeValue = input.gradeValue ?? null;

  // ─── Rung 1: exact slug + grade ─────────────────────────────────────
  let rows = await queryPool(
    container,
    "c.hobbyiqCardId = @slug",
    [{ name: "@slug", value: slug }],
    cutoffIso,
  );
  rows = filterByGrade(rows, gradeCompany, gradeValue);
  if (rows.length > 0) {
    return buildResult(slug, rows, "direct-slug",
      `Direct match: ${rows.length} sale${rows.length === 1 ? "" : "s"} of this exact card`,
      confidenceForRung("direct-slug", rows.length),
      input.previewLimit ?? 10, now, await populationPromise);
  }

  // ─── Rung 2: same identity ignoring printRun ────────────────────────
  // Strip the print-run suffix and match anything with the same
  // player/year/set/cardNumber/parallel/auto. Useful when the /50 auto
  // has no sales but the /150 and /99 variants do — approximate but
  // grounded.
  const slugNoPrintRun = slug.replace(/:num-\d+$/, "");
  if (slugNoPrintRun !== slug) {
    rows = await queryPool(
      container,
      "STARTSWITH(c.hobbyiqCardId, @stem)",
      [{ name: "@stem", value: slugNoPrintRun }],
      cutoffIso,
    );
    rows = filterByGrade(rows, gradeCompany, gradeValue);
    if (rows.length > 0) {
      return buildResult(slug, rows, "cross-printrun",
        `Estimated from ${rows.length} sale${rows.length === 1 ? "" : "s"} of the same card at other print runs`,
        confidenceForRung("cross-printrun", rows.length),
        input.previewLimit ?? 10, now, await populationPromise);
    }
  }

  // ─── Rung 3: same-printrun-cross-parallel ─────────────────────────
  // Same year + cardNumber + auto + PRINT RUN, other parallels. For
  // numbered cards, all /50 auto variants (Gold Wave, Gold Shimmer,
  // Gold Refractor, etc.) trade in a tight band vs the base auto (no
  // printRun). This rung finds the "right" price stratum without
  // getting polluted by cheap base autos. Only fires when the target
  // slug has a print run.
  if (parsed.printRun !== null && parsed.printRun !== undefined) {
    rows = await queryPool(
      container,
      "c.cardYear = @y AND UPPER(c.cardNumber) = @cn AND c.isAuto = @auto AND c.sport = @sport AND c.printRun = @pr",
      [
        { name: "@y", value: parsed.year },
        { name: "@cn", value: (parsed.cardNumber ?? "").toUpperCase() },
        { name: "@auto", value: parsed.isAuto },
        { name: "@sport", value: parsed.sport },
        { name: "@pr", value: parsed.printRun },
      ],
      cutoffIso,
    );
    if (rows.length > 0) rows = filterByGrade(rows, gradeCompany, gradeValue);
    if (rows.length > 0) {
      return buildResult(slug, rows, "same-printrun-cross-parallel",
        `Estimated from ${rows.length} sale${rows.length === 1 ? "" : "s"} of same-print-run variants (/${parsed.printRun})`,
        confidenceForRung("same-printrun-cross-parallel", rows.length),
        input.previewLimit ?? 10, now, await populationPromise);
    }
  }

  // ─── Rung 4 (NEW): printrun-discovery ─────────────────────────────
  // Fires when the target slug has NO printRun (Drew's holding data
  // often lacks the /N tag even for numbered variants). Finds the
  // DOMINANT printRun in the pool for this identity — same cardNumber
  // + parallel + auto — and uses that pool's median. Rescues cases
  // where Ingest split the same physical /150 card across a "/150"-
  // tagged pool and a "no-printRun" ghost pool depending on whether
  // the listing title spelled out the run.
  if (parsed.printRun === null || parsed.printRun === undefined) {
    rows = await queryPool(
      container,
      "c.cardYear = @y AND UPPER(c.cardNumber) = @cn AND c.parallel = @par AND c.isAuto = @auto AND c.sport = @sport AND IS_DEFINED(c.printRun) AND c.printRun != null",
      [
        { name: "@y", value: parsed.year },
        { name: "@cn", value: (parsed.cardNumber ?? "").toUpperCase() },
        { name: "@par", value: parsed.parallel },
        { name: "@auto", value: parsed.isAuto },
        { name: "@sport", value: parsed.sport },
      ],
      cutoffIso,
    );
    if (rows.length > 0) rows = filterByGrade(rows, gradeCompany, gradeValue);
    if (rows.length >= 3) {
      // Group by printRun, pick the pool with the most sales (that's
      // the market's dominant SKU for this identity).
      const byRun = new Map<number, PoolRow[]>();
      for (const r of rows) {
        const pr = Number(r.printRun);
        if (!Number.isFinite(pr)) continue;
        if (!byRun.has(pr)) byRun.set(pr, []);
        byRun.get(pr)!.push(r);
      }
      let bestRun: number | null = null;
      let bestPool: PoolRow[] = [];
      for (const [pr, pool] of byRun.entries()) {
        if (pool.length > bestPool.length) { bestRun = pr; bestPool = pool; }
      }
      if (bestPool.length >= 3) {
        return buildResult(slug, bestPool, "printrun-discovery",
          `Estimated from ${bestPool.length} sale${bestPool.length === 1 ? "" : "s"} of the /${bestRun} print-run variant (dominant SKU at this identity)`,
          confidenceForRung("printrun-discovery", bestPool.length),
          input.previewLimit ?? 10, now, await populationPromise);
      }
    }
  }

  // ─── Rung 5: sibling-parallel — same cardNumber + auto, ANY parallel ─
  // Same year+cardNumber+auto flag, any parallel + print run. Broader
  // than rung 4 — includes Base autos and other print runs. Fires when
  // rung 4 was empty (or slug had a print run).
  rows = await queryPool(
    container,
    "c.cardYear = @y AND UPPER(c.cardNumber) = @cn AND c.isAuto = @auto AND c.sport = @sport",
    [
      { name: "@y", value: parsed.year },
      { name: "@cn", value: (parsed.cardNumber ?? "").toUpperCase() },
      { name: "@auto", value: parsed.isAuto },
      { name: "@sport", value: parsed.sport },
    ],
    cutoffIso,
  );
  if (rows.length > 0) {
    rows = filterByGrade(rows, gradeCompany, gradeValue);
  }
  if (rows.length > 0) {
    return buildResult(slug, rows, "sibling-parallel",
      `Estimated from ${rows.length} sale${rows.length === 1 ? "" : "s"} of sibling parallels of this card`,
      confidenceForRung("sibling-parallel", rows.length),
      input.previewLimit ?? 10, now, await populationPromise);
  }

  // ─── Rung 4: family-baseline — same year + cardNumber, any variant ───
  // Broadest same-card rung. Same year + cardNumber gives player-year-
  // typical value across ANY variant (auto/no-auto, any parallel). Useful
  // as a floor when even sibling parallels are thin.
  rows = await queryPool(
    container,
    "c.cardYear = @y AND UPPER(c.cardNumber) = @cn AND c.sport = @sport",
    [
      { name: "@y", value: parsed.year },
      { name: "@cn", value: (parsed.cardNumber ?? "").toUpperCase() },
      { name: "@sport", value: parsed.sport },
    ],
    cutoffIso,
  );
  if (rows.length > 0) {
    rows = filterByGrade(rows, gradeCompany, gradeValue);
  }
  if (rows.length > 0) {
    return buildResult(slug, rows, "family-baseline",
      `Estimated from ${rows.length} same-card sale${rows.length === 1 ? "" : "s"} across variants`,
      confidenceForRung("family-baseline", rows.length),
      input.previewLimit ?? 10, now, await populationPromise);
  }

  // ─── Rung 7 (NEW): grade-cross-raw ───────────────────────────────────
  // Grade was requested but no graded comps at ANY rung. Fall back to raw
  // comps at the same identity (walk the same ladder without the grade
  // filter) and apply the observed graded multiplier from GRADE_CALIBRATION.
  // Rescues thin-market PSA10 auto lookups where raw comps exist. Explicit
  // confidence dip because the number is derived, not observed.
  if (gradeCompany && gradeValue !== null && gradeValue !== undefined) {
    const rawRungs: Array<{ where: string; params: Array<{ name: string; value: string | number | boolean | null }>; method: HobbyIqFmvMethod; note: (n: number) => string }> = [
      { where: "c.hobbyiqCardId = @slug", params: [{ name: "@slug", value: slug }], method: "direct-slug", note: (n) => `Grade estimated from ${n} raw sale${n === 1 ? "" : "s"} of this exact card × ${gradeCompany} ${gradeValue} multiplier` },
      { where: "c.cardYear = @y AND UPPER(c.cardNumber) = @cn AND c.isAuto = @auto AND c.sport = @sport", params: [{ name: "@y", value: parsed.year }, { name: "@cn", value: (parsed.cardNumber ?? "").toUpperCase() }, { name: "@auto", value: parsed.isAuto }, { name: "@sport", value: parsed.sport }], method: "sibling-parallel", note: (n) => `Grade estimated from ${n} raw sale${n === 1 ? "" : "s"} of sibling parallels × ${gradeCompany} ${gradeValue} multiplier` },
    ];
    for (const rung of rawRungs) {
      let rawRows = await queryPool(container, rung.where, rung.params, cutoffIso);
      rawRows = filterByGrade(rawRows, null, null);   // raw only
      if (rawRows.length >= 3) {
        const rawPrices = rawRows.map((r) => Number(r.price)).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
        if (rawPrices.length === 0) continue;
        const rawMedian = rawPrices[Math.floor(rawPrices.length / 2)];
        const cardClass = parsed.isAuto ? "autograph" : "base";
        const multiplier = getGraderPremium(gradeCompany, String(gradeValue), rawMedian, cardClass, parsed.year, parsed.setKey);
        if (!Number.isFinite(multiplier) || multiplier <= 0) continue;
        const gradedFmv = rawMedian * multiplier;
        // Synthesize one synthetic row so the rest of buildResult's math is stable.
        const synth: PoolRow[] = rawRows.map((r) => ({ ...r, price: Number(r.price) * multiplier }));
        return buildResult(slug, synth, "grade-cross-raw",
          rung.note(rawPrices.length) + ` (${multiplier.toFixed(2)}×, applied to raw median $${Math.round(rawMedian)} → $${Math.round(gradedFmv)})`,
          confidenceForRung("grade-cross-raw", rawPrices.length),
          input.previewLimit ?? 10, now, await populationPromise);
      }
    }
  }

  const population = await populationPromise;
  return { ...noBasis, population };
}

// Confidence per rung × sample size. Direct + big sample → 0.95;
// family-baseline + 1 sample → 0.20. Callers can use this to render
// a "high/medium/low confidence" pill on iOS.
function confidenceForRung(rung: HobbyIqFmvMethod, n: number): number {
  const nBonus = Math.min(0.2, n / 100);      // saturating bonus for sample size
  switch (rung) {
    case "direct-slug":                  return Math.min(0.95, 0.75 + nBonus);
    case "cross-printrun":               return Math.min(0.80, 0.55 + nBonus);
    case "same-printrun-cross-parallel": return Math.min(0.70, 0.45 + nBonus);
    case "printrun-discovery":           return Math.min(0.75, 0.55 + nBonus);
    case "sibling-parallel":             return Math.min(0.55, 0.30 + nBonus);
    case "family-baseline":              return Math.min(0.40, 0.20 + nBonus);
    case "grade-cross-raw":              return Math.min(0.45, 0.25 + nBonus);
    case "no-basis":                     return 0;
  }
}

function buildResult(
  slug: string,
  rows: PoolRow[],
  method: HobbyIqFmvMethod,
  basisNote: string,
  confidence: number,
  previewLimit: number,
  now: Date,
  population: CardPopulationLookup | null,
): HobbyIqFmvResult {
  const prices = rows.map((r) => Number(r.price)).filter((p) => Number.isFinite(p) && p > 0);
  if (prices.length === 0) {
    return {
      slug, fmv: null, compCount: 0, min: null, max: null,
      breakdown: { bySource: {}, byAutoStyle: { onCard: 0, sticker: 0, unknown: 0 }, byGradeQualifier: {} },
      trend: { direction: "flat", slopePerMonthPct: 0, method: "none" },
      recentComps: [],
      method: "no-basis",
      basisNote: "No comparable sales",
      confidence: 0,
      population,
      computedAt: now.toISOString(),
      cachedFrom: "sold_comps",
    };
  }

  const sortedPrices = [...prices].sort((a, b) => a - b);
  const median = sortedPrices[Math.floor(sortedPrices.length / 2)];
  const min = sortedPrices[0];
  const max = sortedPrices[sortedPrices.length - 1];

  const breakdown: HobbyIqFmvBreakdown = {
    bySource: {},
    byAutoStyle: { onCard: 0, sticker: 0, unknown: 0 },
    byGradeQualifier: {},
  };
  for (const r of rows) {
    breakdown.bySource[r.source] = (breakdown.bySource[r.source] ?? 0) + 1;
    if (r.autoStyle === "on-card") breakdown.byAutoStyle.onCard++;
    else if (r.autoStyle === "sticker") breakdown.byAutoStyle.sticker++;
    else breakdown.byAutoStyle.unknown++;
    const q = r.gradeQualifier ?? "unqualified";
    breakdown.byGradeQualifier[q] = (breakdown.byGradeQualifier[q] ?? 0) + 1;
  }

  const trend = computeTrend(rows);
  const recentComps: HobbyIqFmvComp[] = rows.slice(0, previewLimit).map((r) => ({
    price: Number(r.price),
    soldAt: r.soldAt,
    source: r.source,
    parallel: r.parallel ?? null,
    autoStyle: r.autoStyle ?? null,
    gradeQualifier: r.gradeQualifier ?? null,
    url: r.url ?? null,
  }));

  return {
    slug,
    fmv: median,
    compCount: prices.length,
    min,
    max,
    breakdown,
    trend,
    recentComps,
    method,
    basisNote,
    confidence,
    population,
    computedAt: now.toISOString(),
    cachedFrom: "sold_comps",
  };
}

function computeTrend(rows: Array<{ price: number; soldAt: string }>): HobbyIqFmvTrend {
  const points = rows
    .map((r) => ({ price: Number(r.price), t: Date.parse(r.soldAt) }))
    .filter((p) => Number.isFinite(p.price) && p.price > 0 && Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  if (points.length < 2) {
    return { direction: "flat", slopePerMonthPct: 0, method: "none" };
  }
  if (points.length >= 3) {
    const xs = points.map((p) => (p.t - points[0].t) / 86_400_000);
    const ys = points.map((p) => p.price);
    const meanX = xs.reduce((s, v) => s + v, 0) / xs.length;
    const meanY = ys.reduce((s, v) => s + v, 0) / ys.length;
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - meanX) * (ys[i] - meanY);
      den += (xs[i] - meanX) * (xs[i] - meanX);
    }
    const slopePerDay = den > 0 ? num / den : 0;
    const slopePerMonthPct = meanY > 0 ? (slopePerDay * 30 / meanY) * 100 : 0;
    const direction = slopePerMonthPct > 1 ? "up" : slopePerMonthPct < -1 ? "down" : "flat";
    return { direction, slopePerMonthPct, method: "regression" };
  }
  const first = points[0], last = points[points.length - 1];
  const spanDays = (last.t - first.t) / 86_400_000;
  if (spanDays <= 0 || first.price <= 0) {
    return { direction: "flat", slopePerMonthPct: 0, method: "anchor" };
  }
  const slopePerMonthPct = ((last.price - first.price) / first.price) / spanDays * 30 * 100;
  const direction = slopePerMonthPct > 1 ? "up" : slopePerMonthPct < -1 ? "down" : "flat";
  return { direction, slopePerMonthPct, method: "anchor" };
}
