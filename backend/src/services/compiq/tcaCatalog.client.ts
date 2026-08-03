// CF-TCA-CATALOG-CLIENT (Drew, 2026-08-03). Reads the TCA /catalog
// beta endpoint (Eric enabled 2026-08-03). Used by checklistNarrow
// when our local card_catalog has no rows for a (playerName, year,
// setName) tuple — TCA carries 15M cards including modern releases
// our catalog doesn't index yet.
//
// Two-step lookup:
//   1. /catalog/sets?sport=<S>&year=<Y> → find set_id whose name matches setName
//   2. /catalog?set_id=<id>&subject=<player> → cards for that player in that set
//
// Cached in-memory (LRU, session-scoped) so hot lookups in a single
// process don't hammer their API. NOT persisted to our card_catalog —
// TCA's catalog is their IP, we use it live per lookup rather than
// mirroring the data. Every request goes to the source of truth.

const TCA_BASE = "https://www.thecardapi.com/api/v1";

const setLookupCache = new Map<string, number | null>();
const cardLookupCache = new Map<string, TcaCatalogCard[]>();
const CACHE_MAX = 5000;

export interface TcaCatalogCard {
  id: number;
  set_id: number;
  card_number: string | null;
  subject: string | null;
  is_rookie?: boolean;
  is_auto?: boolean;
  is_relic?: boolean;
  is_sp?: boolean;
  is_ssp?: boolean;
  print_run?: number | null;
  rarity?: string | null;
}

interface TcaSetRow {
  set_id: number;
  sport: string;
  year: number;
  set_name: string;
  total_cards: number | null;
}

function normalizeSport(s: string | null | undefined): string {
  const t = String(s ?? "").toLowerCase();
  // TCA uses "Baseball", "Basketball", etc. — capitalize.
  if (["baseball", "basketball", "football", "hockey", "soccer", "golf"].includes(t)) {
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function lruSet<K, V>(map: Map<K, V>, key: K, value: V, max: number) {
  if (map.size >= max) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
  map.set(key, value);
}

/** Find the TCA set_id whose set_name best matches setName within (sport, year). */
async function findSetId(sport: string, year: number, setName: string): Promise<number | null> {
  const apiKey = process.env.TCA_API_KEY;
  if (!apiKey) return null;
  const cacheKey = `${sport}|${year}|${setName.toLowerCase().trim()}`;
  if (setLookupCache.has(cacheKey)) return setLookupCache.get(cacheKey) ?? null;

  const url = `${TCA_BASE}/catalog/sets?sport=${encodeURIComponent(normalizeSport(sport))}&year=${year}&limit=100`;
  try {
    const res = await fetch(url, { headers: { "x-market-api-key": apiKey } });
    if (!res.ok) {
      lruSet(setLookupCache, cacheKey, null, CACHE_MAX);
      return null;
    }
    const json = await res.json() as { data?: TcaSetRow[] };
    const sets = json.data || [];
    if (sets.length === 0) {
      lruSet(setLookupCache, cacheKey, null, CACHE_MAX);
      return null;
    }
    // Match logic: exact-name, then containment either way, then earliest word overlap.
    const target = setName.toLowerCase().trim();
    const exact = sets.find((s) => s.set_name.toLowerCase() === target);
    if (exact) {
      lruSet(setLookupCache, cacheKey, exact.set_id, CACHE_MAX);
      return exact.set_id;
    }
    const contains = sets.find((s) => {
      const sn = s.set_name.toLowerCase();
      return sn.includes(target) || target.includes(sn);
    });
    if (contains) {
      lruSet(setLookupCache, cacheKey, contains.set_id, CACHE_MAX);
      return contains.set_id;
    }
    // Word-overlap heuristic: pick set with most overlapping words that ISN'T
    // a variant (Sapphire, Chrome, etc.) unless the user's setName says so.
    const targetWords = new Set(target.split(/\s+/).filter((w) => w.length > 2));
    let best: TcaSetRow | null = null;
    let bestScore = 0;
    for (const s of sets) {
      const words = s.set_name.toLowerCase().split(/\s+/);
      const overlap = words.filter((w) => targetWords.has(w)).length;
      if (overlap > bestScore) {
        bestScore = overlap;
        best = s;
      }
    }
    const chosen = bestScore >= 2 ? best?.set_id ?? null : null;
    lruSet(setLookupCache, cacheKey, chosen, CACHE_MAX);
    return chosen;
  } catch {
    return null;
  }
}

/** Fetch cards for a player within a specific TCA set. Returns [] when nothing. */
export async function tcaCatalogNarrow(
  playerName: string,
  cardYear: number,
  setName: string,
  sport: string,
): Promise<TcaCatalogCard[]> {
  const apiKey = process.env.TCA_API_KEY;
  if (!apiKey) return [];
  if (!playerName || !cardYear || !setName || !sport) return [];

  const set_id = await findSetId(sport, cardYear, setName);
  if (!set_id) return [];

  const cacheKey = `${set_id}|${playerName.toLowerCase().trim()}`;
  if (cardLookupCache.has(cacheKey)) return cardLookupCache.get(cacheKey) ?? [];

  // /catalog?set_id=X&subject=<player> — filter server-side to avoid pulling
  // the full set (some sets have 5000+ cards with parallels).
  const url = `${TCA_BASE}/catalog?set_id=${set_id}&subject=${encodeURIComponent(playerName)}&limit=50`;
  try {
    const res = await fetch(url, { headers: { "x-market-api-key": apiKey }, redirect: "follow" });
    if (!res.ok) {
      lruSet(cardLookupCache, cacheKey, [], CACHE_MAX);
      return [];
    }
    const json = await res.json() as { data?: TcaCatalogCard[] };
    const cards = (json.data || []).filter((c) => c.card_number != null);
    lruSet(cardLookupCache, cacheKey, cards, CACHE_MAX);
    return cards;
  } catch {
    return [];
  }
}

// ── Identity verification against TCA catalog ─────────────────────────────
// CF-TCA-CATALOG-VERIFY (Drew, 2026-08-03). Confirms our parsed
// identity actually exists in TCA's canonical catalog. Used at
// user-facing events (holding confirm, portfolio detail) to gate
// data cleanliness — NOT per-ingest-row (that would hammer TCA).
//
// Returns a shape suitable for downstream tagging:
//   verified: true  → exact card_number match found for (player, year, set)
//   verified: false → catalog returned cards for the tuple but none matched
//                     our card_number → parse likely wrong
//   verified: null  → catalog had no data for the tuple → can't verify
//                     either way (rare set, TCA lookup failed, etc)
export interface TcaVerifyResult {
  verified: boolean | null;
  reason: string;
  candidateNumbers?: string[];
  matchedTcaCardId?: number;
}

export async function verifyCardAgainstTcaCatalog(input: {
  playerName: string;
  cardYear: number;
  setName: string;
  cardNumber: string;
  sport: string;
}): Promise<TcaVerifyResult> {
  const apiKey = process.env.TCA_API_KEY;
  if (!apiKey) return { verified: null, reason: "no-api-key" };
  if (!input.playerName || !input.cardYear || !input.setName || !input.cardNumber || !input.sport) {
    return { verified: null, reason: "insufficient-input" };
  }
  const cards = await tcaCatalogNarrow(input.playerName, input.cardYear, input.setName, input.sport);
  if (cards.length === 0) {
    return { verified: null, reason: "no-tca-candidates" };
  }
  const targetNum = String(input.cardNumber).trim().toUpperCase();
  const match = cards.find((c) => String(c.card_number ?? "").trim().toUpperCase() === targetNum);
  if (match) {
    return { verified: true, reason: "exact-cardnumber-match", matchedTcaCardId: match.id };
  }
  return {
    verified: false,
    reason: "no-cardnumber-match-in-set",
    candidateNumbers: cards.map((c) => String(c.card_number ?? "").trim()).filter(Boolean).slice(0, 10),
  };
}
