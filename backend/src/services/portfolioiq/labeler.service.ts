// CF-LABELER (Drew, 2026-07-31). Human-in-the-loop variant labeling.
// CH's card_catalog holds one row per physical variant (Base / Refractor /
// Green / Blue / etc.) each with an imageUrl. Our sold_comps rows don't
// carry a variant pointer — they only have a title + our best-guess
// parallel. This service surfaces variants to Drew with images, lets
// him input the canonical HobbyIQ parallel name + print run, then
// reclassifies matching sold_comps rows by title-suffix match.
//
// Label storage: written back onto the card_catalog row itself under
// canonicalLabel + labeledAt + labeledBy. No new container.

import { CosmosClient, type Container } from "@azure/cosmos";
import { computeHobbyIqCardId, normalizeSetKey } from "./hobbyIqCardId.service.js";

interface CanonicalLabel {
  parallel: string;
  isRefractor: boolean;
  printRun: number | null;
  setSlug: string;
  labeledBy: string;
  labeledAt: string;
}

export interface VariantView {
  cardCatalogId: string;
  chCardId: string;
  chVariant: string;
  set: string;
  imageUrl: string | null;
  matchedSoldCompsCount: number;
  currentLabel: CanonicalLabel | null;
}

export interface VariantsResponse {
  cardNumber: string;
  cardYear: number | null;
  player: string;
  variants: VariantView[];
  unmatchedSoldCompsCount: number;
}

let cachedCatalog: Container | null = null;
let cachedSoldComps: Container | null = null;
function db(name: string): Container | null {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  const client = new CosmosClient(conn);
  return client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container(name);
}
function getCatalog(): Container | null {
  if (!cachedCatalog) cachedCatalog = db("card_catalog");
  return cachedCatalog;
}
function getSoldComps(): Container | null {
  if (!cachedSoldComps) cachedSoldComps = db("sold_comps");
  return cachedSoldComps;
}

export interface QueueCandidate {
  cardNumber: string;
  cardYear: number | null;
  playerName: string;
  portfolioHits: number;   // how many user portfolios hold this card
  unlabeledVariants: number;
  totalVariants: number;
  soldCompsCount: number;
  priority: number;        // computed score: higher = more impactful to label
}

// CF-LABELER-QUEUE-CACHE (Drew, 2026-08-02). Queue endpoint does 3
// heavy cross-partition Cosmos queries (catalog scan, portfolio read,
// sold_comps aggregation). Under backfill load these can time out at
// 20+ seconds and hang the admin dashboard's Promise.all. Cache for
// 5 minutes — labeler queue is a review surface, not a live counter.
const QUEUE_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedQueue: { at: number; limit: number; result: QueueCandidate[] } | null = null;

/** Return the top-N labeling candidates ranked by portfolio impact +
 *  catalog gap. Cards Drew (or any user) HOLDS bubble up first;
 *  ties broken by unlabeled variant count + sold_comps volume. */
export async function listLabelerQueue(limit = 25): Promise<QueueCandidate[]> {
  const now = Date.now();
  if (cachedQueue && cachedQueue.limit >= limit && (now - cachedQueue.at) < QUEUE_CACHE_TTL_MS) {
    return cachedQueue.result.slice(0, limit);
  }
  const catalog = getCatalog();
  const sc = getSoldComps();
  if (!catalog || !sc) return [];

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return [];
  const { CosmosClient } = await import("@azure/cosmos");
  const client = new CosmosClient(conn);
  const portfolio = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("portfolio");

  // Portfolio hits per (cardNumber, cardYear)
  const portfolioHits = new Map<string, number>();
  const { resources: docs } = await portfolio.items.query({
    query: "SELECT c.holdings FROM c WHERE IS_DEFINED(c.holdings)"
  }, { maxItemCount: 200 }).fetchAll();
  for (const doc of docs) {
    for (const h of Object.values((doc as { holdings?: Record<string, unknown> }).holdings ?? {})) {
      const holding = h as { cardNumber?: string; cardYear?: number };
      const cn = String(holding.cardNumber ?? "").trim().toUpperCase();
      const yr = holding.cardYear ?? 0;
      if (!cn) continue;
      const key = `${yr}::${cn}`;
      portfolioHits.set(key, (portfolioHits.get(key) ?? 0) + 1);
    }
  }

  // Catalog per (cardNumber, cardYear) — count total + unlabeled variants
  const catalogByKey = new Map<string, { total: number; unlabeled: number; player: string }>();
  const { resources: catalogRows } = await catalog.items.query({
    query: `SELECT c.number, c.cardNumber, c.year, c.player, c.canonicalLabel FROM c WHERE c.source = 'cardhedge'`
  }, { maxItemCount: 5000 }).fetchAll();
  // CF-LABELER-PARALLEL-AS-PLAYER (Drew, 2026-08-02). Vendor rows
  // sometimes come in with the parallel word stored as `player`
  // (Superfractor, Sunflower Seeds, Pop Corn, Peanuts, Gum Ball, Red
  // Lava, Mini Diamond, etc. — very common in 2025 Bowman Draft
  // Chrome's snack-themed patterned refractor series). Group header
  // showed these as if they were the player, which is wrong.
  //
  // Fix: when picking the group's display player, prefer any row
  // whose player is NOT a known parallel word. Fall back to the
  // first-seen player only when no non-parallel-word candidate
  // exists in the group.
  const PARALLEL_WORD_SET = new Set([
    "superfractor", "refractor", "sapphire", "mini diamond", "x-fractor", "speckle",
    "wave", "ray wave", "shimmer", "lava", "grass", "mojo refractor", "lazer refractor",
    "sunflower seeds", "pop corn", "peanuts", "gum ball", "sparkle",
    "red lava", "blue lava", "green lava", "gold lava", "orange lava",
    "red shimmer", "blue shimmer", "green shimmer", "gold shimmer",
    "red wave", "blue wave", "green wave", "gold wave", "orange wave", "purple wave",
    "red ray wave", "blue ray wave", "green ray wave", "gold ray wave",
    "blue", "red", "gold", "orange", "green", "purple", "pink", "yellow", "aqua", "black", "silver",
    "chrome", "autograph", "base", "rookie",
  ].map(s => s.toLowerCase()));
  function isParallelWord(name: string): boolean {
    return PARALLEL_WORD_SET.has(name.trim().toLowerCase());
  }
  for (const r of catalogRows) {
    const cn = String(((r as { number?: string; cardNumber?: string }).number ?? (r as { number?: string; cardNumber?: string }).cardNumber) ?? "").trim().toUpperCase();
    const yrRaw = (r as { year?: number | string }).year;
    const yr = typeof yrRaw === "number" ? yrRaw : Number(yrRaw ?? 0);
    if (!cn || !yr) continue;
    const key = `${yr}::${cn}`;
    const rowPlayer = String((r as { player?: string }).player ?? "");
    let entry = catalogByKey.get(key);
    if (!entry) {
      entry = { total: 0, unlabeled: 0, player: rowPlayer };
      catalogByKey.set(key, entry);
    } else if (entry.player && isParallelWord(entry.player) && rowPlayer && !isParallelWord(rowPlayer)) {
      // Upgrade the group's header player when we find a real name.
      entry.player = rowPlayer;
    }
    entry.total++;
    if (!(r as { canonicalLabel?: unknown }).canonicalLabel) entry.unlabeled++;
  }

  // sold_comps count per (cardNumber, cardYear) — sampled query
  const soldCountByKey = new Map<string, number>();
  const { resources: scRows } = await sc.items.query({
    query: `SELECT c.cardNumber, c.cardYear FROM c WHERE IS_DEFINED(c.cardNumber) AND IS_DEFINED(c.cardYear)`
  }, { maxItemCount: 5000 }).fetchAll();
  for (const r of scRows) {
    const cn = String((r as { cardNumber?: string }).cardNumber ?? "").trim().toUpperCase();
    const yr = (r as { cardYear?: number }).cardYear ?? 0;
    if (!cn || !yr) continue;
    const key = `${yr}::${cn}`;
    soldCountByKey.set(key, (soldCountByKey.get(key) ?? 0) + 1);
  }

  // Build candidates, prioritize: portfolio hits × 100 + unlabeled variants × 10 + log(soldCounts)
  const candidates: QueueCandidate[] = [];
  for (const [key, cat] of catalogByKey) {
    if (cat.unlabeled === 0) continue;
    const [yrStr, cn] = key.split("::");
    const yr = Number(yrStr);
    const hits = portfolioHits.get(key) ?? 0;
    const soldN = soldCountByKey.get(key) ?? 0;
    const priority = hits * 100 + cat.unlabeled * 10 + Math.log10(soldN + 1);
    candidates.push({
      cardNumber: cn,
      cardYear: yr || null,
      playerName: cat.player,
      portfolioHits: hits,
      unlabeledVariants: cat.unlabeled,
      totalVariants: cat.total,
      soldCompsCount: soldN,
      priority,
    });
  }
  candidates.sort((a, b) => b.priority - a.priority);
  const bounded = candidates.slice(0, 200);   // cache the 200 hottest
  cachedQueue = { at: Date.now(), limit: 200, result: bounded };
  return bounded.slice(0, Math.min(200, Math.max(5, limit)));
}

/** Load all CH card_catalog variants for a card + count matching sold_comps. */
export async function listVariantsForCard(cardNumber: string, cardYear: number | null): Promise<VariantsResponse | null> {
  const catalog = getCatalog();
  const sc = getSoldComps();
  if (!catalog || !sc) return null;

  const cnUpper = cardNumber.trim().toUpperCase();
  const { resources: catalogRows } = await catalog.items.query({
    query: `SELECT * FROM c WHERE c.source = 'cardhedge'
              AND (UPPER(c.number ?? '') = @cn OR UPPER(c.cardNumber ?? '') = @cn)`,
    parameters: [{ name: "@cn", value: cnUpper }],
  }).fetchAll();

  const filtered = cardYear
    ? catalogRows.filter(r => {
        const setYearMatch = typeof r.set === "string" && r.set.includes(String(cardYear));
        return r.year === cardYear || r.year === String(cardYear) || setYearMatch;
      })
    : catalogRows;

  const player = filtered[0]?.player ?? catalogRows[0]?.player ?? "";

  const scByTitleSuffix = new Map<string, number>();
  const { resources: scRows } = await sc.items.query({
    query: `SELECT c.title, c.hobbyiqCardId FROM c
              WHERE UPPER(c.cardNumber) = @cn ${cardYear ? "AND c.cardYear = @yr" : ""}`,
    parameters: cardYear
      ? [{ name: "@cn", value: cnUpper }, { name: "@yr", value: cardYear }]
      : [{ name: "@cn", value: cnUpper }],
  }).fetchAll();

  const totalRows = scRows.length;
  let matchedTotal = 0;
  const variants: VariantView[] = filtered.map((r) => {
    const chVariant = String(r.variant ?? "").trim();
    const suffix = ` #${cnUpper} ${chVariant}`.toUpperCase();
    let count = 0;
    for (const row of scRows) {
      const t = (row.title ?? "").toUpperCase();
      if (t.endsWith(suffix)) count += 1;
    }
    scByTitleSuffix.set(chVariant, count);
    matchedTotal += count;
    const currentLabel: CanonicalLabel | null = r.canonicalLabel ?? null;
    return {
      cardCatalogId: r.id,
      chCardId: r.cardId,
      chVariant,
      set: r.set,
      imageUrl: r.imageUrl ?? null,
      matchedSoldCompsCount: count,
      currentLabel,
    };
  });

  return {
    cardNumber: cnUpper,
    cardYear,
    player,
    variants,
    unmatchedSoldCompsCount: totalRows - matchedTotal,
  };
}

export interface SaveLabelInput {
  cardCatalogId: string;
  cardNumber: string;
  cardYear: number;
  set: string;
  chVariant: string;
  canonicalParallel: string;
  isRefractor: boolean;
  printRun: number | null;
  labeledBy: string;
  applyToSoldComps: boolean;
  sport?: string;
}

export interface SaveLabelResult {
  cardCatalogUpdated: boolean;
  soldCompsRewritten: number;
  newSlugSample: string;
}

/** Save a canonical label onto the card_catalog row and optionally
 *  rewrite matching sold_comps rows to the new parallel + slug. */
export async function saveVariantLabel(input: SaveLabelInput): Promise<SaveLabelResult> {
  const catalog = getCatalog();
  const sc = getSoldComps();
  if (!catalog || !sc) throw new Error("Cosmos not configured");

  const sport = input.sport ?? "baseball";
  const setSlug = normalizeSetKey(input.set);
  const newSlug = computeHobbyIqCardId({
    sport,
    year: input.cardYear,
    setKey: setSlug,
    cardNumber: input.cardNumber,
    parallel: input.canonicalParallel,
    isAuto: /auto|autograph|CPA|BCPA|BDPA|BCDA|BCRA|TCRA|FCA|CDA/i.test(input.set + " " + input.chVariant + " " + input.canonicalParallel + " " + input.cardNumber),
    printRun: input.printRun,
  });

  // card_catalog partition key = /cardId. Read requires the PK value,
  // which we don't have from just the doc id — query by id to fetch it.
  const { resources: found } = await catalog.items.query({
    query: "SELECT * FROM c WHERE c.id = @id",
    parameters: [{ name: "@id", value: input.cardCatalogId }],
  }).fetchAll();
  const catalogDoc = found[0];
  if (!catalogDoc) throw new Error(`card_catalog row ${input.cardCatalogId} not found`);

  const label: CanonicalLabel = {
    parallel: input.canonicalParallel,
    isRefractor: input.isRefractor,
    printRun: input.printRun,
    setSlug,
    labeledBy: input.labeledBy,
    labeledAt: new Date().toISOString(),
  };
  const priorLabel = catalogDoc.canonicalLabel ?? null;
  catalogDoc.canonicalLabel = label;
  await catalog.items.upsert(catalogDoc);
  // CF-LEARNING-CAPTURE (Drew, 2026-08-01). Every label save becomes a
  // training event. Feeds confidence scorer + future classifier.
  try {
    const { logLearningEvent } = await import("./learningEvents.service.js");
    logLearningEvent({
      eventType: "labeler-save",
      actor: input.labeledBy,
      subjectType: "card_catalog",
      subjectId: input.cardCatalogId,
      before: priorLabel ? { canonicalLabel: priorLabel } : undefined,
      after: { canonicalLabel: label },
      decision: { label: input.canonicalParallel, reason: `printRun=${input.printRun ?? "unnumbered"}, isRefractor=${input.isRefractor}` },
      features: { cardNumber: input.cardNumber, cardYear: input.cardYear, chVariant: input.chVariant, set: input.set },
    });
  } catch { /* soft */ }

  let rewritten = 0;
  if (input.applyToSoldComps) {
    const cnUpper = input.cardNumber.trim().toUpperCase();
    const suffix = ` #${cnUpper} ${input.chVariant}`.toUpperCase();
    const { resources: rows } = await sc.items.query({
      query: `SELECT * FROM c WHERE UPPER(c.cardNumber) = @cn AND c.cardYear = @yr AND ENDSWITH(UPPER(c.title), @sfx)`,
      parameters: [
        { name: "@cn", value: cnUpper },
        { name: "@yr", value: input.cardYear },
        { name: "@sfx", value: suffix },
      ],
    }).fetchAll();

    for (const row of rows) {
      row.parallel = input.canonicalParallel;
      row.hobbyiqCardId = newSlug;
      row.__labeledByAdmin = { at: label.labeledAt, by: label.labeledBy, chVariant: input.chVariant };
      try {
        await sc.items.upsert(row);
        rewritten += 1;
      } catch {
        /* skip individual errors — surface aggregate count */
      }
    }
  }

  return {
    cardCatalogUpdated: true,
    soldCompsRewritten: rewritten,
    newSlugSample: newSlug,
  };
}
