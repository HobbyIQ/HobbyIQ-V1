import { Router } from "express";
import { compiqEstimate, computeEstimate, simulateWhatIf } from "../services/compiq/compiqEstimate.service.js";
import { cacheWrap } from "../services/shared/cache.service.js";
import { CompIQEstimateRequest } from "../types/compiq.types.js";
import { getNormalizationDictionary } from "../services/compiq/normalizationDictionary.service.js";
import { searchCards } from "../services/compiq/cardhedge.client.js";
import {
  parseCardQuery,
  buildCompSearchQuery,
  type ParsedCardQuery,
} from "../services/compiq/cardQueryParser.js";
import { buildEngineMeta } from "../services/compiq/engineMeta.js";
import { writeCorpusEntry } from "../services/corpus/writeCorpusEntry.js";
import { corpusEntryFromPricingResult } from "../services/corpus/corpusMapping.js";

// Build a structured CompIQEstimateRequest from a parsed free-text query.
// The parser fills in every field the estimate service needs (year, brand,
// parallel, isAuto, grade), so downstream filters can fire — instead of the
// whole query string being shoved into playerName.
function requestFromParsed(parsed: ParsedCardQuery): CompIQEstimateRequest {
  return {
    playerName: parsed.playerName ?? parsed.rawQuery,
    cardYear: parsed.year ?? undefined,
    product: parsed.set ?? parsed.brand ?? undefined,
    parallel: parsed.parallel ?? undefined,
    isAuto: parsed.isAuto || undefined,
    gradeCompany: parsed.gradingCompany ?? undefined,
    gradeValue: parsed.grade && parsed.grade !== "raw" ? Number(parsed.grade) : undefined,
  };
}

const CACHE_TTL_SECONDS = 15 * 60; // 15 minutes

function normalizeCacheKey(prefix: string, query: string): string {
  return `${prefix}:${query.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

const router = Router();

router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "CompIQ",
    timestamp: new Date().toISOString()
  });
});

router.post("/estimate", (req, res, next) => compiqEstimate(req, res).catch(next));

router.get("/normalization-dictionary", (req, res) => {
  res.json({ success: true, dictionary: getNormalizationDictionary() });
});

// GET /api/compiq/parse?q=2024+bowman+blue+auto+Caleb+Bonemer
// Debug/preview endpoint — returns ParsedCardQuery and the comp search
// string the engine would issue. No comps fetched, no pricing run.
router.get("/parse", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  if (!q.trim()) {
    return res.status(400).json({ success: false, error: 'Missing "q" query param' });
  }
  const parsed = parseCardQuery(q);
  const searchQuery = buildCompSearchQuery(parsed);
  const summaryParts = [
    parsed.year ?? "",
    parsed.brand ?? "",
    parsed.set && parsed.set !== parsed.brand ? parsed.set : "",
    parsed.parallel ?? "",
    parsed.isAuto ? "Auto" : "",
    parsed.playerName ?? "",
  ].filter(Boolean);
  res.json({
    success: true,
    parsed,
    searchQuery,
    explanation: `Searching for: ${summaryParts.join(" ")}`.replace(/\s+/g, " ").trim(),
  });
});

router.post("/what-if", async (req, res, next) => {
  try {
    const { playerName } = req.body || {};
    if (!playerName || typeof playerName !== "string" || !playerName.trim()) {
      return res.status(400).json({ success: false, error: 'Missing "playerName" field' });
    }
    const result = await simulateWhatIf(req.body || {});
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// POST /api/compiq/cardsearch
// Lightweight catalog lookup used by the iOS Search picker — returns up to
// `limit` candidate cards (default 50, hard cap 50) so users can find
// less-common variants/parallels in a single page. The ceiling matches
// Card Hedge's per-page maximum enforced in cardhedge.client.ts. Proxies
// Card Hedge `/cards/card-search` with the server-side API key (the iOS
// app must NEVER hold that key) and normalizes the response so the client
// gets a single `image_url` per hit no matter which image field Card
// Hedge populated.
router.post("/cardsearch", async (req, res, next) => {
  try {
    const { query, limit } = req.body || {};
    if (!query || typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ success: false, error: 'Missing or invalid "query" field' });
    }
    // Variant picker uses one Card Hedge page (max 50). Lower defaults
    // would silently clamp clients that ask for more.
    const cap = Math.max(1, Math.min(Number(limit) || 50, 50));
    const raw = await searchCards(query.trim(), cap);
    const hits = raw.map((c: any) => {
      const imageCandidates: unknown[] = [
        c?.front_image_url,
        c?.image_url,
        c?.front_image,
        c?.image,
        Array.isArray(c?.images) && c.images.length > 0
          ? (typeof c.images[0] === "string" ? c.images[0] : c.images[0]?.url)
          : undefined,
      ];
      const imageUrl = imageCandidates.find(
        (u): u is string => typeof u === "string" && /^https?:\/\//i.test(u),
      ) ?? null;
      const yearVal: number | null =
        typeof c?.year === "number"
          ? c.year
          : typeof c?.year === "string" && /^\d{4}$/.test(c.year)
            ? Number(c.year)
            : null;
      return {
        card_id: String(c?.card_id ?? c?.id ?? ""),
        title:
          (typeof c?.description === "string" && c.description) ||
          (typeof c?.title === "string" && c.title) ||
          (typeof c?.name === "string" && c.name) ||
          [c?.year, c?.set, c?.player, c?.number ? `#${c.number}` : null]
            .filter(Boolean)
            .join(" "),
        player: typeof c?.player === "string" ? c.player : null,
        year: yearVal,
        set: typeof c?.set === "string" ? c.set : null,
        card_number: typeof c?.number === "string" ? c.number : null,
        variant: typeof c?.variant === "string" ? c.variant : null,
        image_url: imageUrl,
      };
    }).filter((h) => h.card_id);
    res.json({ ok: true, hits });
  } catch (err) {
    next(err);
  }
});

// POST /api/compiq/search
// Accepts { query: string } — used by DashboardView free-text search
router.post("/search", async (req, res, next) => {
  const handlerStart = Date.now();
  try {
    const { query } = req.body || {};
    if (!query || typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ success: false, error: 'Missing "query" field' });
    }
    const cacheKey = normalizeCacheKey("compiq:search", query);
    const result = await cacheWrap(cacheKey, async () => {
      // Parse free-text → structured fields so downstream filters fire.
      const parsed = parseCardQuery(query);
      const body: CompIQEstimateRequest = requestFromParsed(parsed);
      const searchQuery = buildCompSearchQuery(parsed);
      console.log(
        `[compiq.search] parsed query="${query}" → player="${parsed.playerName}" year=${parsed.year} brand=${parsed.brand} parallel=${parsed.parallel} isAuto=${parsed.isAuto} confidence=${parsed.confidence} searchQuery="${searchQuery}"`
      );
      const est = await computeEstimate(body);

      const fmv = (est.fairMarketValue as number) ?? 0;
      const quick = (est.quickSaleValue as number) ?? fmv * 0.88;
      const premium = (est.premiumValue as number) ?? fmv * 1.15;
      const trendRaw = ((est.marketDNA as any)?.trend as string | undefined)?.toLowerCase() ?? "flat";
      const direction = trendRaw === "up" ? "up" : trendRaw === "down" ? "down" : "flat";
      const confidence = Math.min(1, ((est.confidence as any)?.pricingConfidence ?? 60) / 100);
      const trendDeltaPct = Number(((est as any)?.pricingAnalytics?.anchorModel?.impliedTrendPct ?? 0));
      const source = (est.source as string | undefined) ?? "live";
      const isThin = source === "no-recent-comps";
      const variantWarning: string[] = (est as any).variantWarning ?? [];
      const hasWarn = variantWarning.length > 0;
      const baseSummary = est.verdict ?? "Estimate based on available market data.";
      const summary = hasWarn
        ? `No exact match for requested variant (missing: ${variantWarning.join(", ")}). Showing closest available comp. ${baseSummary}`
        : baseSummary;
      const finalConfidence = hasWarn ? Math.min(confidence, 0.45) : confidence;

      // Prefer momentum-adjusted FMV when available so the headline price
      // reflects fresh sibling-parallel trend rather than a stale live
      // anchor. `fairMarketValue` (live) is still returned separately.
      const effectiveFmv =
        typeof (est as any).effectiveFmv === "number" && (est as any).effectiveFmv > 0
          ? ((est as any).effectiveFmv as number)
          : fmv;
      const liftRatio = fmv > 0 ? effectiveFmv / fmv : 1;
      const effQuick = quick * liftRatio;
      const effPremium = premium * liftRatio;

      // If we have NO direct comps but DO have a sibling-parallel synthetic
      // anchor, surface that as the headline instead of null. Quick/premium
      // bands derived from the synthetic FMV. Applies both to thin-market
      // (no-recent-comps) and variant-mismatch sources.
      const xpa = (est as any).crossParallelAnchor as any;
      const isVariantMismatch = source === "variant-mismatch";
      const noUsableLiveFmv = isThin || isVariantMismatch || !(fmv > 0);
      const hasSyntheticFallback =
        noUsableLiveFmv && typeof xpa?.fmv === "number" && xpa.fmv > 0;
      const syntheticFmv: number = hasSyntheticFallback
        ? (typeof (est as any).effectiveFmv === "number" && (est as any).effectiveFmv > 0
            ? ((est as any).effectiveFmv as number)
            : (xpa.fmv as number))
        : 0;
      const syntheticQuick = syntheticFmv * 0.88;
      const syntheticPremium = syntheticFmv * 1.15;

      return {
        ...buildEngineMeta(),
        success: true,
        query: query.trim(),
        summary,
        marketTier: hasSyntheticFallback
          ? { value: syntheticFmv, high: syntheticPremium }
          : noUsableLiveFmv
            ? { value: null, high: null }
            : { value: effectiveFmv, high: effPremium },
        buyZone: hasSyntheticFallback
          ? [syntheticQuick * 0.9, syntheticQuick]
          : noUsableLiveFmv
            ? [null, null]
            : [effQuick * 0.9, effQuick],
        holdZone: hasSyntheticFallback
          ? [syntheticQuick, syntheticFmv]
          : noUsableLiveFmv
            ? [null, null]
            : [effQuick, effectiveFmv],
        sellZone: hasSyntheticFallback
          ? [syntheticFmv, syntheticPremium]
          : noUsableLiveFmv
            ? [null, null]
            : [effectiveFmv, effPremium],
        fairMarketValueLive: noUsableLiveFmv ? null : fmv,
        confidence: finalConfidence,
        source,
        trendAnalysis: {
          market_direction: direction,
          change_from_older_to_recent: Number.isFinite(trendDeltaPct) ? trendDeltaPct : null,
          liquidity: (est.marketDNA as any)?.speed ?? "Normal",
        },
        supply: null,
        recentComps: (est as any).recentComps ?? [],
        cardIdentity: (est as any).cardIdentity ?? null,
        gradeUsed: (est as any).gradeUsed ?? null,
        compsUsed: (est as any).compsUsed ?? 0,
        compsAvailable: (est as any).compsAvailable ?? (est as any).compsUsed ?? 0,
        daysSinceNewestComp: (est as any).daysSinceNewestComp ?? null,
        variantWarning,
        neighborSynthesis: (est as any).neighborSynthesis ?? null,
        neighborSynthesisDebug: (est as any).neighborSynthesisDebug ?? null,
        crossParallelAnchor: (est as any).crossParallelAnchor ?? null,
        buySignal: null,
        parsedQuery: {
          playerName: parsed.playerName,
          year: parsed.year,
          brand: parsed.brand,
          set: parsed.set,
          parallel: parsed.parallel,
          isAuto: parsed.isAuto,
          isPatch: parsed.isPatch,
          isRookie: parsed.isRookie,
          printRun: parsed.printRun,
          cardNumber: parsed.cardNumber,
          grade: parsed.grade,
          gradingCompany: parsed.gradingCompany,
          confidence: parsed.confidence,
        },
        searchQuery,
      };
    }, CACHE_TTL_SECONDS);
    res.json(result);
    // Corpus collector — fire-and-forget, gated by COMPIQ_CORPUS_DISABLED
    // and COMPIQ_CORPUS_SAMPLE_RATE. See services/corpus/.
    void writeCorpusEntry(
      corpusEntryFromPricingResult({
        query: query.trim(),
        querySource: "free_text",
        endpoint: "/api/compiq/search",
        durationMs: Date.now() - handlerStart,
        result,
      }),
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/compiq/price  (alias for /search — same contract)
router.post("/price", async (req, res, next) => {
  const handlerStart = Date.now();
  try {
    const { query } = req.body || {};
    if (!query || typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ success: false, error: 'Missing "query" field' });
    }
    const cacheKey = normalizeCacheKey("compiq:price", query);
    const result = await cacheWrap(cacheKey, async () => {
      const parsed = parseCardQuery(query);
      const body: CompIQEstimateRequest = requestFromParsed(parsed);
      const searchQuery = buildCompSearchQuery(parsed);
      console.log(
        `[compiq.price] parsed query="${query}" → player="${parsed.playerName}" year=${parsed.year} brand=${parsed.brand} parallel=${parsed.parallel} isAuto=${parsed.isAuto} confidence=${parsed.confidence}`
      );
      const est = await computeEstimate(body);
      const fmv = (est.fairMarketValue as number) ?? 0;
      const quick = (est.quickSaleValue as number) ?? fmv * 0.88;
      const premium = (est.premiumValue as number) ?? fmv * 1.15;
      const trendRaw = ((est.marketDNA as any)?.trend as string | undefined)?.toLowerCase() ?? "flat";
      const direction = trendRaw === "up" ? "up" : trendRaw === "down" ? "down" : "flat";
      const confidence = Math.min(1, ((est.confidence as any)?.pricingConfidence ?? 60) / 100);
      const trendDeltaPct = Number(((est as any)?.pricingAnalytics?.anchorModel?.impliedTrendPct ?? 0));
      const source = (est.source as string | undefined) ?? "live";
      const isThin = source === "no-recent-comps";
      const variantWarning: string[] = (est as any).variantWarning ?? [];
      const hasWarn = variantWarning.length > 0;
      const baseSummary = est.verdict ?? "Estimate based on available market data.";
      const summary = hasWarn
        ? `No exact match for requested variant (missing: ${variantWarning.join(", ")}). Showing closest available comp. ${baseSummary}`
        : baseSummary;
      const finalConfidence = hasWarn ? Math.min(confidence, 0.45) : confidence;
      return {
        ...buildEngineMeta(),
        success: true,
        query: query.trim(),
        summary,
        marketTier: isThin
          ? { value: null, high: null }
          : { value: fmv, high: premium },
        buyZone: isThin ? [null, null] : [quick * 0.9, quick],
        holdZone: isThin ? [null, null] : [quick, fmv],
        sellZone: isThin ? [null, null] : [fmv, premium],
        // Live FMV emitted at top level for engine-emission symmetry with
        // /search (Option X). Mirrors marketTier.value's null-when-thin
        // semantic so both fields agree within a response.
        fairMarketValueLive: isThin ? null : fmv,
        confidence: finalConfidence,
        source,
        trendAnalysis: {
          market_direction: direction,
          change_from_older_to_recent: Number.isFinite(trendDeltaPct) ? trendDeltaPct : null,
        },
        supply: null,
        recentComps: (est as any).recentComps ?? [],
        cardIdentity: (est as any).cardIdentity ?? null,
        gradeUsed: (est as any).gradeUsed ?? null,
        compsUsed: (est as any).compsUsed ?? 0,
        compsAvailable: (est as any).compsAvailable ?? (est as any).compsUsed ?? 0,
        daysSinceNewestComp: (est as any).daysSinceNewestComp ?? null,
        variantWarning,
        neighborSynthesis: (est as any).neighborSynthesis ?? null,
        neighborSynthesisDebug: (est as any).neighborSynthesisDebug ?? null,
        crossParallelAnchor: (est as any).crossParallelAnchor ?? null,
        buySignal: null,
        parsedQuery: {
          playerName: parsed.playerName,
          year: parsed.year,
          brand: parsed.brand,
          set: parsed.set,
          parallel: parsed.parallel,
          isAuto: parsed.isAuto,
          isPatch: parsed.isPatch,
          isRookie: parsed.isRookie,
          printRun: parsed.printRun,
          cardNumber: parsed.cardNumber,
          grade: parsed.grade,
          gradingCompany: parsed.gradingCompany,
          confidence: parsed.confidence,
        },
        searchQuery,
      };
    }, CACHE_TTL_SECONDS);
    res.json(result);
    // Corpus collector — fire-and-forget, gated by COMPIQ_CORPUS_DISABLED
    // and COMPIQ_CORPUS_SAMPLE_RATE. See services/corpus/.
    void writeCorpusEntry(
      corpusEntryFromPricingResult({
        query: query.trim(),
        querySource: "free_text",
        endpoint: "/api/compiq/price",
        durationMs: Date.now() - handlerStart,
        result,
      }),
    );
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Card-Ladder-style two-step search
//
// 1. POST /api/compiq/search-list { query }
//      → returns up to 20 matching card variants (player, set, year, #, variant)
//        with no comps/pricing. The iOS client renders this as a picker.
// 2. POST /api/compiq/price-by-id { cardHedgeCardId, query?, gradeCompany?, gradeValue? }
//      → returns the full CompIQ estimate pinned to that exact card_id.
// ---------------------------------------------------------------------------

router.post("/search-list", async (req, res, next) => {
  try {
    const { query } = req.body || {};
    if (!query || typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ success: false, error: 'Missing "query" field' });
    }
    const { searchCards } = await import("../services/compiq/cardhedge.client.js");
    const cacheKey = normalizeCacheKey("compiq:search-list:v2", query);
    const result = await cacheWrap(cacheKey, async () => {
      const hits = await searchCards(query.trim(), 30);

      // ----- Autograph detection -------------------------------------------
      // Card Hedge does NOT label autographs explicitly in `variant`.
      // The autograph signal is encoded in `set`, `number`, or `title` via
      // tokens like "Auto", "Autograph", "Signature", or number prefixes
      // CPA / CDA / BDPA / PA- / -AU / RAP / 1stPA etc.
      const AUTO_TEXT_RE = /\b(auto|autograph|autographs|signature|signed)\b/i;
      const AUTO_NUMBER_RE = /(^|[^a-z])(cpa|cda|bdpa|cra|cdra|prospect ?auto|1st\s*pa|pa-|-au\b|ap-|rap)/i;

      const isAutograph = (c: any): boolean => {
        const blob = `${c.set ?? ""} ${c.number ?? ""} ${c.title ?? ""} ${c.name ?? ""} ${c.variant ?? ""}`;
        return AUTO_TEXT_RE.test(blob) || AUTO_NUMBER_RE.test(blob);
      };

      // ----- Query-intent parsing ------------------------------------------
      const q = query.toLowerCase();
      const wantsAuto = AUTO_TEXT_RE.test(q);
      const COLOR_RE = /\b(sky\s+blue|royal\s+blue|navy|aqua|red|blue|green|gold|orange|purple|pink|yellow|black|white|silver|atomic|prizm|mojo|shimmer|wave|rainbow|refractor)\b/gi;
      const wantedColors = Array.from(q.matchAll(COLOR_RE)).map((m) => m[0].toLowerCase().replace(/\s+/g, " "));

      const enriched = hits.map((c) => {
        const auto = isAutograph(c);
        const variantText = (c.variant ?? "").toLowerCase();
        const setText = (c.set ?? "").toLowerCase();
        const numberText = (c.number ?? "").toLowerCase();

        // Score: exact color match in variant > color match in set > nothing.
        let colorScore = 0;
        if (wantedColors.length > 0) {
          for (const col of wantedColors) {
            if (variantText.includes(col)) colorScore += 3;
            else if (setText.includes(col)) colorScore += 1;
          }
          // Penalize "sky blue" being matched when user wanted plain "blue" alone.
          if (wantedColors.includes("blue") && !wantedColors.some((c) => c !== "blue") && variantText.includes("sky blue")) {
            colorScore -= 1;
          }
        }

        const autoScore = wantsAuto ? (auto ? 5 : -2) : 0;

        // Promote "1st" / rookie variants when present, mildly.
        const rookieBoost = /\b(1st|rookie|rc)\b/i.test(`${setText} ${numberText} ${variantText}`) ? 0.5 : 0;

        const sortScore = colorScore + autoScore + rookieBoost;

        const variantWithAuto =
          auto && c.variant && !/auto/i.test(c.variant) ? `${c.variant} Auto` : c.variant ?? null;

        return {
          cardHedgeCardId: c.card_id,
          player: c.player ?? null,
          set: c.set ?? null,
          year: c.year ?? null,
          number: c.number ?? null,
          variant: variantWithAuto,
          isAutograph: auto,
          title: c.title ?? c.name ?? null,
          displayLabel: [c.year, c.set, c.player, c.number, variantWithAuto]
            .filter(Boolean)
            .join(" "),
          sortScore,
        };
      });

      // Stable sort: highest score first; preserve original order on ties.
      const ranked = enriched
        .map((e, i) => ({ e, i }))
        .sort((a, b) => b.e.sortScore - a.e.sortScore || a.i - b.i)
        .map(({ e }) => {
          const { sortScore, ...rest } = e;
          return rest;
        });

      // When the user explicitly asked for an autograph, hide the
      // non-autograph variants so the picker doesn't drown the user.
      const filtered = wantsAuto ? ranked.filter((r) => r.isAutograph) : ranked;

      // Cap to 20 for display.
      const finalResults = filtered.slice(0, 20);

      return {
        success: true,
        query: query.trim(),
        count: finalResults.length,
        filters: {
          wantsAuto,
          wantedColors,
        },
        results: finalResults,
      };
    }, CACHE_TTL_SECONDS);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/price-by-id", async (req, res, next) => {
  const handlerStart = Date.now();
  try {
    const { cardHedgeCardId, query, gradeCompany, gradeValue } = req.body || {};
    if (!cardHedgeCardId || typeof cardHedgeCardId !== "string") {
      return res.status(400).json({ success: false, error: 'Missing "cardHedgeCardId" field' });
    }
    const cacheKey = normalizeCacheKey(
      "compiq:price-by-id:v3",
      `${cardHedgeCardId}|${gradeCompany ?? ""}${gradeValue ?? ""}`
    );
    const result = await cacheWrap(cacheKey, async () => {
      const body: CompIQEstimateRequest = {
        playerName: typeof query === "string" ? query.trim() : cardHedgeCardId,
        cardHedgeCardId,
        gradeCompany: typeof gradeCompany === "string" ? gradeCompany : undefined,
        gradeValue: typeof gradeValue === "number" ? gradeValue : undefined,
      };
      const est = await computeEstimate(body);

      const fmv = (est.fairMarketValue as number) ?? 0;
      const quick = (est.quickSaleValue as number) ?? fmv * 0.88;
      const premium = (est.premiumValue as number) ?? fmv * 1.15;
      const trendRaw = ((est.marketDNA as any)?.trend as string | undefined)?.toLowerCase() ?? "flat";
      const direction = trendRaw === "up" ? "up" : trendRaw === "down" ? "down" : "flat";
      const confidence = Math.min(1, ((est.confidence as any)?.pricingConfidence ?? 60) / 100);
      const trendDeltaPct = Number(((est as any)?.pricingAnalytics?.anchorModel?.impliedTrendPct ?? 0));
      const source = (est.source as string | undefined) ?? "live";
      const isThin = source === "no-recent-comps";

      return {
        ...buildEngineMeta(),
        success: true,
        cardHedgeCardId,
        summary: est.verdict ?? "Estimate based on available market data.",
        marketTier: isThin ? { value: null, high: null } : { value: fmv, high: premium },
        buyZone: isThin ? [null, null] : [quick * 0.9, quick],
        holdZone: isThin ? [null, null] : [quick, fmv],
        sellZone: isThin ? [null, null] : [fmv, premium],
        // Live FMV emitted at top level for engine-emission symmetry
        // with /search and /price (Option X). null when thin market.
        fairMarketValueLive: isThin ? null : fmv,
        confidence,
        source,
        trendAnalysis: {
          market_direction: direction,
          change_from_older_to_recent: Number.isFinite(trendDeltaPct) ? trendDeltaPct : null,
          liquidity: (est.marketDNA as any)?.speed ?? "Normal",
          broaderTrend: (est as any).broaderTrend ?? null,
        },
        recentComps: (est as any).recentComps ?? [],
        cardIdentity: (est as any).cardIdentity ?? null,
        gradeUsed: (est as any).gradeUsed ?? null,
        compsUsed: (est as any).compsUsed ?? 0,
        compsAvailable: (est as any).compsAvailable ?? (est as any).compsUsed ?? 0,
        daysSinceNewestComp: (est as any).daysSinceNewestComp ?? null,
        broaderTrend: (est as any).broaderTrend ?? null,
      };
    }, CACHE_TTL_SECONDS);
    res.json(result);
    // Corpus collector — fire-and-forget, gated by COMPIQ_CORPUS_DISABLED
    // and COMPIQ_CORPUS_SAMPLE_RATE. querySource rule: if the request
    // carried a non-empty free-text `query`, store that with
    // querySource="free_text"; otherwise store cardHedgeCardId in the
    // query slot with querySource="card_id" (self-describing semantics).
    {
      const trimmedQuery =
        typeof query === "string" ? query.trim() : "";
      const queryForCorpus = trimmedQuery.length > 0 ? trimmedQuery : cardHedgeCardId;
      const querySource: "free_text" | "card_id" =
        trimmedQuery.length > 0 ? "free_text" : "card_id";
      void writeCorpusEntry(
        corpusEntryFromPricingResult({
          query: queryForCorpus,
          querySource,
          endpoint: "/api/compiq/price-by-id",
          durationMs: Date.now() - handlerStart,
          result,
        }),
      );
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/compiq/bulk
// Accepts { queries: string[] } — used by PortfolioIQViewModel.refreshPortfolio()
router.post("/bulk", async (req, res, next) => {
  const handlerStart = Date.now();
  try {
    const { queries } = req.body || {};
    if (!Array.isArray(queries) || queries.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid "queries" array' });
    }
    const safeQueries: string[] = queries.slice(0, 20).map(String);

    const settled = await Promise.allSettled(
      safeQueries.map(async (query) => {
        const est = await computeEstimate({ playerName: query.trim() });
        const fmv = (est.fairMarketValue as number) ?? 0;
        const premium = (est.premiumValue as number) ?? fmv * 1.15;
        const trendRaw = ((est.marketDNA as any)?.trend as string | undefined)?.toLowerCase() ?? "flat";
        const data = {
          ...buildEngineMeta(),
          success: true,
          query,
          summary: est.verdict,
          marketTier: { value: fmv, high: premium },
          // Engine-emission symmetry with /search, /price, /price-by-id
          // (Option X). null when the engine produced no usable FMV.
          fairMarketValueLive: fmv > 0 ? fmv : null,
          confidence: Math.min(1, ((est.confidence as any)?.pricingConfidence ?? 60) / 100),
          trendAnalysis: {
            market_direction: trendRaw === "up" ? "up" : trendRaw === "down" ? "down" : "flat",
          },
          source: est.source ?? "live",
          // Comp counts emitted per-item for symmetry with /search and
          // /price; corpus sampleSize maps from compsUsed.
          compsUsed: (est as any).compsUsed ?? 0,
          compsAvailable: (est as any).compsAvailable ?? (est as any).compsUsed ?? 0,
        };
        // Per-item corpus write — fire-and-forget. writeCorpusEntry rolls
        // its sample-rate gate independently per call, so a 20-item bulk
        // request produces up to 20 independent sampling rolls.
        void writeCorpusEntry(
          corpusEntryFromPricingResult({
            query,
            querySource: "free_text",
            endpoint: "/api/compiq/bulk",
            durationMs: Date.now() - handlerStart,
            result: data,
          }),
        );
        return {
          query,
          status: "ok" as const,
          data,
          error: null,
        };
      })
    );

    const results = settled.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : { query: safeQueries[i], status: "error" as const, data: null, error: (r.reason as Error)?.message ?? "Unknown error" }
    );

    const succeeded = results.filter((r) => r.status === "ok").length;
    res.json({ requested: safeQueries.length, succeeded, failed: safeQueries.length - succeeded, results });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/compiq/grade-premium
// Returns the estimated value premium for PSA 10 vs raw for a given card.
// Body: { playerName, cardYear?, product?, parallel?, isAuto? }
// ---------------------------------------------------------------------------
router.post("/grade-premium", async (req, res, next) => {
  try {
    const { playerName } = req.body || {};
    if (!playerName || typeof playerName !== "string" || !playerName.trim()) {
      return res.status(400).json({ success: false, error: 'Missing "playerName" field' });
    }

    const base = req.body as CompIQEstimateRequest;

    // Run two estimates in parallel — raw and PSA 10
    const [rawResult, psa10Result] = await Promise.all([
      computeEstimate({ ...base, gradeCompany: undefined, gradeValue: undefined }),
      computeEstimate({ ...base, gradeCompany: "PSA", gradeValue: 10 }),
    ]);

    const rawFmv = (rawResult.fairMarketValue as number) ?? 0;
    const psa10Fmv = (psa10Result.fairMarketValue as number) ?? 0;
    const premiumDollars = Math.max(0, psa10Fmv - rawFmv);
    const premiumPct = rawFmv > 0 ? (premiumDollars / rawFmv) * 100 : 0;

    // Grade worthwhile if premium covers typical grading cost ($25-50) with margin
    const gradingCostEstimate = 35;
    const worthGrading = premiumDollars > gradingCostEstimate * 2;

    res.json({
      success: true,
      playerName: base.playerName,
      rawFmv,
      psa10Fmv,
      premiumDollars,
      premiumPct: Math.round(premiumPct * 10) / 10,
      worthGrading,
      verdict: worthGrading
        ? `PSA 10 adds ~$${Math.round(premiumDollars)} over raw — likely worth grading.`
        : `PSA 10 only adds ~$${Math.round(premiumDollars)} over raw — grading may not pencil out.`,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/compiq/sell-window
// Returns a seasonal sell-window recommendation for a card/player.
// Body: { playerName, cardYear?, isRookie?, sport? }
// ---------------------------------------------------------------------------
router.post("/sell-window", async (req, res, next) => {
  try {
    const { playerName, isRookie, cardYear, sport } = req.body || {};
    if (!playerName || typeof playerName !== "string" || !playerName.trim()) {
      return res.status(400).json({ success: false, error: 'Missing "playerName" field' });
    }

    const now = new Date();
    const month = now.getMonth() + 1; // 1-indexed
    const currentYear = now.getFullYear();
    const cardAge = cardYear ? currentYear - Number(cardYear) : null;

    // Seasonal windows per sport
    const sportNorm = (typeof sport === "string" ? sport : "").toLowerCase();
    const isBaseball = sportNorm.includes("baseball") || sportNorm === "mlb" || sportNorm === "";
    const isFootball = sportNorm.includes("football") || sportNorm === "nfl";
    const isBasketball = sportNorm.includes("basketball") || sportNorm === "nba";

    interface SellWindow { startMonth: number; endMonth: number; label: string; reason: string }
    let windows: SellWindow[] = [];

    if (isBaseball) {
      if (isRookie) {
        windows = [
          { startMonth: 6, endMonth: 8, label: "Post-Draft Hype (Jun–Aug)", reason: "Rookie cards peak after the draft when prospect hype is highest." },
          { startMonth: 10, endMonth: 11, label: "Playoff Run (Oct–Nov)", reason: "Postseason exposure drives spikes for players on contending teams." },
        ];
      } else {
        windows = [
          { startMonth: 3, endMonth: 5, label: "Opening Day Buzz (Mar–May)", reason: "Veteran cards see renewed interest at the start of the season." },
          { startMonth: 9, endMonth: 10, label: "Late Season / Playoffs (Sep–Oct)", reason: "Award race narratives and playoff push drive collector demand." },
        ];
      }
    } else if (isFootball) {
      if (isRookie) {
        windows = [
          { startMonth: 4, endMonth: 5, label: "NFL Draft Window (Apr–May)", reason: "Rookie selections drive immediate hype for top picks." },
          { startMonth: 9, endMonth: 11, label: "Regular Season Breakout (Sep–Nov)", reason: "Strong early performances push rookie values to their seasonal peak." },
        ];
      } else {
        windows = [
          { startMonth: 8, endMonth: 9, label: "Preseason Optimism (Aug–Sep)", reason: "Offseason moves and training camp buzz lift veterans before the season." },
          { startMonth: 1, endMonth: 2, label: "Super Bowl Run (Jan–Feb)", reason: "Playoff participants see sharp spikes as national interest peaks." },
        ];
      }
    } else if (isBasketball) {
      if (isRookie) {
        windows = [
          { startMonth: 6, endMonth: 7, label: "NBA Draft Hype (Jun–Jul)", reason: "Top picks peak in the days immediately after draft night." },
          { startMonth: 1, endMonth: 3, label: "All-Star Season (Jan–Mar)", reason: "All-Star selections and award races drive mid-season peaks." },
        ];
      } else {
        windows = [
          { startMonth: 10, endMonth: 12, label: "Season Opener Buzz (Oct–Dec)", reason: "Renewed interest at the start of a new NBA season." },
          { startMonth: 4, endMonth: 5, label: "Playoff Push (Apr–May)", reason: "Playoff performers see sharp demand from casual collectors." },
        ];
      }
    } else {
      windows = [{ startMonth: 1, endMonth: 12, label: "Year-Round", reason: "No seasonal pattern available for this sport." }];
    }

    // Determine if we're currently in a window
    const activeWindow = windows.find((w) => month >= w.startMonth && month <= w.endMonth) ?? null;
    const nextWindow = !activeWindow
      ? windows.find((w) => w.startMonth > month) ?? windows[0]
      : null;

    const inWindowNow = activeWindow !== null;
    const monthsUntilNext = nextWindow
      ? nextWindow.startMonth > month
        ? nextWindow.startMonth - month
        : 12 - month + nextWindow.startMonth
      : 0;

    const cardAgeNote =
      cardAge !== null && cardAge <= 2
        ? " This is a recent card — collectors are still actively tracking this player."
        : cardAge !== null && cardAge > 10
        ? " This is a vintage card — prices are driven more by condition than season."
        : null;

    res.json({
      success: true,
      playerName,
      inWindowNow,
      activeWindow,
      nextWindow,
      monthsUntilNext: inWindowNow ? 0 : monthsUntilNext,
      allWindows: windows,
      verdict: inWindowNow
        ? `You're in a sell window now (${activeWindow!.label}). ${activeWindow!.reason}${cardAgeNote ?? ""}`
        : `Next sell window: ${nextWindow?.label} (${monthsUntilNext} month${monthsUntilNext !== 1 ? "s" : ""} away). ${nextWindow?.reason ?? ""}${cardAgeNote ?? ""}`,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
