// CF-CAT-ENGINE (2026-06-21): Cardsight corpus fetcher. Enumerates a
// {set} scope's cards + flattens raw+graded pricing into per-card sales
// pools. Identical fetch shape to the CF-XMULT and CF-CAT-RECON probes,
// hoisted into the engine for first-class reuse.
//
// Read-only on Cardsight. The engine never writes to the catalog.
// Rate-limit shape: sequential per-card pricing calls. 173 CPA cards →
// ~173 sequential requests (~3–4 min wallclock per CF-XMULT timing).

import type { PerCardSales } from "./pairedRatio.js";

const BASE_URL = "https://api.cardsight.ai/v1";

export interface CorpusFetchScope {
  /** The Cardsight set id to enumerate (e.g. "92371597-3bec-4666-996a-00cbb760f865" for 2026 CPA). */
  setId: string;
  /** Human-readable label for logs / worksheet header. */
  scopeLabel: string;
  /** Optional cap on cards probed; falsy = all. */
  maxCards?: number;
}

export interface FetchedCard {
  id: string;
  playerName: string;
}

export interface CorpusFetchResult {
  scope: CorpusFetchScope;
  cardsProbed: number;
  cardsErrored: number;
  perCard: PerCardSales[];
}

async function cs(path: string, apiKey: string): Promise<unknown> {
  const r = await fetch(`${BASE_URL}${path}`, {
    headers: { "X-API-Key": apiKey, "Accept": "application/json" },
  });
  if (!r.ok) return { __http: r.status };
  return r.json();
}

interface PricingShape {
  raw?: { records?: Array<{ price?: number; title?: string }> };
  graded?: Array<{
    grades?: Array<{
      records?: Array<{ price?: number; title?: string }>;
    }>;
  }>;
}

/**
 * Enumerate cards in a set with Cardsight's skip/take pagination.
 */
export async function fetchSetCards(
  setId: string,
  apiKey: string,
): Promise<FetchedCard[]> {
  const cards: FetchedCard[] = [];
  let skip = 0;
  const take = 100;
  while (true) {
    const r = (await cs(`/catalog/sets/${setId}/cards?skip=${skip}&take=${take}`, apiKey)) as
      | { __http?: number; cards?: Array<{ id?: string; player_name?: string; name?: string }> }
      | Array<{ id?: string; player_name?: string; name?: string }>;
    const arr = Array.isArray(r) ? r : r.cards ?? [];
    if (arr.length === 0) break;
    for (const c of arr) {
      if (c.id) cards.push({ id: c.id, playerName: c.player_name ?? c.name ?? "" });
    }
    if (arr.length < take) break;
    skip += take;
  }
  return cards;
}

/**
 * Probe pricing for a card and flatten raw + graded into a single sale list.
 */
export async function fetchCardSales(
  cardId: string,
  apiKey: string,
): Promise<Array<{ price: number; title: string }>> {
  // cs() returns either { __http: number } on HTTP failure or the JSON
  // pricing shape. Cast through unknown so the discriminant check below
  // narrows cleanly under strict TS.
  const raw = await cs(`/pricing/${cardId}`, apiKey) as unknown;
  if (
    typeof raw === "object" && raw !== null && "__http" in raw &&
    typeof (raw as { __http: unknown }).__http === "number"
  ) {
    return [];
  }
  const r = raw as PricingShape;
  const sales: Array<{ price: number; title: string }> = [];
  for (const rec of r.raw?.records ?? []) {
    if (typeof rec.price === "number" && typeof rec.title === "string") {
      sales.push({ price: rec.price, title: rec.title });
    }
  }
  for (const company of r.graded ?? []) {
    for (const grade of company.grades ?? []) {
      for (const rec of grade.records ?? []) {
        if (typeof rec.price === "number" && typeof rec.title === "string") {
          sales.push({ price: rec.price, title: rec.title });
        }
      }
    }
  }
  return sales;
}

/**
 * Top-level fetch: enumerate set → per-card pricing → flat per-card sale lists.
 */
export async function fetchCorpus(
  scope: CorpusFetchScope,
  apiKey: string,
  onProgress?: (probed: number, total: number) => void,
): Promise<CorpusFetchResult> {
  const cards = await fetchSetCards(scope.setId, apiKey);
  const capped = scope.maxCards ? cards.slice(0, scope.maxCards) : cards;
  const perCard: PerCardSales[] = [];
  let errors = 0;
  for (let i = 0; i < capped.length; i++) {
    const card = capped[i]!;
    try {
      const sales = await fetchCardSales(card.id, apiKey);
      perCard.push({ cardId: card.id, playerName: card.playerName, sales });
    } catch {
      errors += 1;
    }
    onProgress?.(i + 1, capped.length);
  }
  return { scope, cardsProbed: capped.length, cardsErrored: errors, perCard };
}
