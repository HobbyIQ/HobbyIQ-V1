// CF-CATALOG-DRIVEN-SETKEY (Drew, 2026-08-12). Resolve a sale's setKey by
// ASKING THE CATALOG which set the card is actually in, instead of guessing
// from the vendor's product text.
//
// Today `normalizeSetKey()` is ~40 hand-written regexes over the vendor
// title. Every new product needs a new rule, the rules are order-dependent,
// and collisions are silent. That is how "Bowman Draft Chrome" became
// arguable: two rules could both claim it and the answer depended on which
// matched first, not on what the card is.
//
// The catalog already knows. `card_catalog` holds real, observed sets keyed
// by (sport, year, setKey, cardNumber). A sale carrying "2025 Bowman Draft
// Chrome ... CPA-JHA" does not need its product text parsed — it needs its
// cardNumber looked up. The cardNumber prefix is the manufacturer's own
// product marker and does not drift with how a seller typed the title
// (see memory: isAuto boundary is cardNumber, not text).
//
// Resolution order:
//   1. EXACT   — one catalog setKey for (sport, year, cardNumber). Done.
//   2. NARROW  — several candidate setKeys; disambiguate with the player,
//                then with tokens from the vendor's product text. Only a
//                unique survivor counts.
//   3. GAP     — catalog has nothing for this (sport, year, cardNumber).
//                Enqueue a checklist seed so the NEXT sale resolves, and
//                hand back null so the caller keeps its current behaviour.
//
// COST NOTE: card_catalog partitions on /cardId, so a lookup keyed by
// (sport, year, cardNumber) is a CROSS-PARTITION fan-out. Every filter is an
// equality on an indexed field so the fan-out is narrow, but before wiring
// this into a per-row ingest path, cache by (sport, year, cardNumber) at the
// batch level — the TCA webhook showed what an uncached per-row catalog query
// costs (~145k RU/s sustained).
//
// This NEVER invents a setKey. A null return means "catalog can't say yet",
// and the caller falls back to normalizeSetKey() exactly as before — so
// adopting this is strictly additive and cannot regress a sale that already
// resolved. It also never overrides the caller: it reports what the catalog
// observed and lets the call site decide.

import { CosmosClient, type Container } from "@azure/cosmos";
import { requestChecklistSeed } from "./checklistSeedQueue.service.js";

const COSMOS_DATABASE = process.env.COSMOS_DATABASE ?? "hobbyiq";
const CATALOG_CONTAINER = process.env.COSMOS_CARD_CATALOG_CONTAINER ?? "card_catalog";

let _container: Container | null = null;
async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    _container = new CosmosClient(conn).database(COSMOS_DATABASE).container(CATALOG_CONTAINER);
    return _container;
  } catch {
    return null;
  }
}

export type SetKeyResolution =
  /** Exactly one setKey in the catalog for this (sport, year, cardNumber). */
  | "exact"
  /** Several candidates, narrowed to one by player. */
  | "narrowed-by-player"
  /** Several candidates, narrowed to one by vendor product text. */
  | "narrowed-by-text"
  /** Several candidates and no signal separates them — caller must decide. */
  | "ambiguous"
  /** Catalog has no row for this cardNumber — seed requested. */
  | "catalog-gap"
  | "insufficient-input"
  | "catalog-unavailable";

export interface ResolveSetKeyInput {
  sport: string;
  year: number;
  cardNumber: string;
  /** Optional disambiguators — used only when the cardNumber is not unique. */
  playerName?: string | null;
  /** The vendor's raw product/set text, used as a last-resort tiebreak. */
  sourceSetText?: string | null;
}

export interface ResolveSetKeyResult {
  /** The catalog's answer, or null when it cannot say. */
  setKey: string | null;
  resolution: SetKeyResolution;
  /** All setKeys the catalog carries for this cardNumber, most-populated
   *  first. Present whenever there was more than one — this is what makes
   *  an ambiguous result actionable rather than just a shrug. */
  candidates?: Array<{ setKey: string; count: number }>;
  seedRequested?: boolean;
}

interface CatalogRow {
  setKey?: string | null;
  playerSlug?: string | null;
}

function slug(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tally(rows: CatalogRow[]): Array<{ setKey: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = String(r.setKey ?? "").trim();
    if (!k) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([setKey, count]) => ({ setKey, count }))
    .sort((a, b) => b.count - a.count || a.setKey.localeCompare(b.setKey));
}

/**
 * Ask the catalog which set this card belongs to.
 *
 * Never throws. Returns `setKey: null` whenever the catalog cannot answer,
 * so callers can fall back to their existing normalization untouched.
 */
export async function resolveSetKeyFromCatalog(
  input: ResolveSetKeyInput,
): Promise<ResolveSetKeyResult> {
  const sport = String(input.sport ?? "").toLowerCase().trim();
  const year = Number(input.year);
  const cardNumber = String(input.cardNumber ?? "").trim();

  if (!sport || !year || !cardNumber) {
    return { setKey: null, resolution: "insufficient-input" };
  }

  const container = await getContainer();
  if (!container) return { setKey: null, resolution: "catalog-unavailable" };

  let rows: CatalogRow[] = [];
  try {
    const { resources } = await container.items.query<CatalogRow>({
      query:
        "SELECT c.setKey, c.playerSlug FROM c WHERE c.sport = @s AND c.year = @y AND UPPER(c.cardNumber ?? '') = UPPER(@n)",
      parameters: [
        { name: "@s", value: sport },
        { name: "@y", value: year },
        { name: "@n", value: cardNumber },
      ],
    }).fetchAll();
    rows = resources ?? [];
  } catch {
    // A failed read is not evidence of absence — do not enqueue a seed for it.
    return { setKey: null, resolution: "catalog-unavailable" };
  }

  const candidates = tally(rows);

  // 3. GAP — the catalog has never seen this card number in this release.
  if (candidates.length === 0) {
    const seedRequested = await requestChecklistSeed({
      sport,
      year,
      setName: String(input.sourceSetText ?? "").trim(),
      // No catalog row means no canonical key yet; key the work order off
      // the vendor's text so the drainer has something to search for.
      setKey: slug(String(input.sourceSetText ?? "")) || `unknown-${cardNumber.toLowerCase()}`,
      reason: "setkey-unresolved",
      missingCardNumber: cardNumber,
      missingPlayer: input.playerName ?? undefined,
    });
    return { setKey: null, resolution: "catalog-gap", seedRequested };
  }

  // 1. EXACT — the cardNumber is unique to one set. The common case, and
  //    the one that makes vendor product text irrelevant.
  if (candidates.length === 1) {
    return { setKey: candidates[0].setKey, resolution: "exact" };
  }

  // 2a. NARROW by player — the same number across sets is usually a
  //     different player; the player collapses it.
  const playerSlug = input.playerName ? slug(input.playerName) : "";
  if (playerSlug) {
    const byPlayer = tally(rows.filter((r) => String(r.playerSlug ?? "") === playerSlug));
    if (byPlayer.length === 1) {
      return { setKey: byPlayer[0].setKey, resolution: "narrowed-by-player", candidates };
    }
  }

  // 2b. NARROW by vendor text — last resort, and deliberately strict: the
  //     candidate must be a token-subset of the seller's product text. This
  //     is the only place seller text is trusted, and only to CHOOSE among
  //     sets the catalog already vouches for, never to invent one.
  const text = slug(String(input.sourceSetText ?? ""));
  if (text) {
    const textTokens = new Set(text.split("-").filter(Boolean));
    const matches = candidates.filter((c) =>
      c.setKey.split("-").filter(Boolean).every((t) => textTokens.has(t)),
    );
    if (matches.length === 1) {
      return { setKey: matches[0].setKey, resolution: "narrowed-by-text", candidates };
    }
  }

  // Genuinely ambiguous. Say so and hand back the evidence rather than
  // picking the most-populated set and calling it truth.
  return { setKey: null, resolution: "ambiguous", candidates };
}

/** Test seam — drops the memoized container. */
export function __resetResolveSetKeyForTests(): void {
  _container = null;
}
