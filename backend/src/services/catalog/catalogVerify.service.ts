// CF-CATALOG-VERIFY-OWN-POOL (Drew, 2026-08-12). Identity verification
// against OUR card_catalog — no vendor call, no quota, no fallback.
//
// Replaces the TCA-backed verify (`verifyCardAgainstTcaCatalog`). That
// path was structurally wrong for us twice over:
//
//   1. TCA meters catalog reads (2,000 records/day on the current plan,
//      reset at midnight UTC). Once the day's allowance burns, every
//      verify silently returns "can't verify" — indistinguishable from
//      "this card doesn't exist." Verification quality became a function
//      of what time of day the user opened the app.
//   2. It rented identity truth from a vendor while our own catalog IS
//      the moat (memory: catalog-first, "catalog IS the moat, not vendor
//      APIs"). Every verify we sent to TCA was a question we already had
//      the data to answer.
//
// A catalog MISS is not a dead end here — it's the signal that our
// checklist for that release is incomplete. We enqueue a seed request
// (see checklistSeedQueue.service.ts) so the gap gets built into the
// catalog permanently, and the NEXT verify of that set answers locally.
// Misses make the moat wider instead of burning vendor quota.
//
// COST NOTE (corrected 2026-08-12): card_catalog partitions on **/cardId**,
// not /sport — the "partition /sport" comment in cardCatalog.service.ts is
// wrong, and this file previously repeated it. These reads filter on sport +
// year + setKey + playerSlug, none of which is the partition key, so they
// are CROSS-PARTITION fan-outs, not the cheap single-partition lookups this
// comment used to claim.
//
// They stay on the holding-confirm path because that path is user-initiated
// and low-volume (one verify per confirmed holding), and every filter is an
// equality on an indexed field, so the fan-out is narrow. Do NOT reuse this
// on a per-row ingest path — that is exactly how the TCA webhook ended up
// sustaining ~145k RU/s.

import { CosmosClient, type Container } from "@azure/cosmos";
import {
  normalizeSetKey,
  deriveParentSetKey,
  sameCardNumber,
  slugify,
} from "../portfolioiq/hobbyIqCardId.service.js";
import { requestChecklistSeed } from "./checklistSeedQueue.service.js";

const COSMOS_DATABASE = process.env.COSMOS_DATABASE ?? "hobbyiq";
const CATALOG_CONTAINER = process.env.COSMOS_CARD_CATALOG_CONTAINER ?? "card_catalog";

let _container: Container | null = null;
async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    _container = new CosmosClient(conn)
      .database(COSMOS_DATABASE)
      .container(CATALOG_CONTAINER);
    return _container;
  } catch {
    return null;
  }
}

export type CatalogVerifyReason =
  /** Our catalog carries this exact card number for this player+set. */
  | "exact-cardnumber-match"
  /** Matched under the parent set (bowman-chrome-prospects → bowman-chrome). */
  | "family-cardnumber-match"
  /** We have the player's cards for this set, and this number isn't one. */
  | "no-cardnumber-match-in-set"
  /** We have the set, but no rows for this player — checklist incomplete. */
  | "player-not-in-set"
  /** We don't carry this release at all — checklist missing. */
  | "set-not-in-catalog"
  | "insufficient-input"
  | "catalog-unavailable";

export interface CatalogVerifyInput {
  playerName: string;
  cardYear: number;
  setName: string;
  cardNumber: string;
  sport: string;
}

export interface CatalogVerifyResult {
  /**
   * true  → our catalog vouches for this identity
   * false → our catalog covers this player+set and disagrees (bad parse)
   * null  → we can't answer yet (gap or infra), never "the card is fake"
   */
  verified: boolean | null;
  reason: CatalogVerifyReason;
  /** Always our own pool — kept explicit so stored rows are self-describing. */
  source: "hobbyiq-catalog";
  /** Canonical hiq: slug of the matched catalog row. */
  matchedSlug?: string;
  /** What we DO carry for that player+set — powers "did you mean #X?" UI. */
  candidateNumbers?: string[];
  /** True when this miss enqueued a checklist seed request. */
  seedRequested?: boolean;
}

interface CatalogNumberRow {
  id?: string;
  cardNumber?: string | null;
}

/** Cards we carry for (sport, year, setKey, player). Empty on any failure. */
async function rowsForPlayerInSet(
  container: Container,
  sport: string,
  year: number,
  setKey: string,
  playerSlug: string,
): Promise<CatalogNumberRow[]> {
  try {
    const { resources } = await container.items.query<CatalogNumberRow>({
      query:
        "SELECT c.id, c.cardNumber FROM c WHERE c.sport = @s AND c.year = @y AND c.setKey = @sk AND c.playerSlug = @p",
      parameters: [
        { name: "@s", value: sport },
        { name: "@y", value: year },
        { name: "@sk", value: setKey },
        { name: "@p", value: playerSlug },
      ],
    }).fetchAll();
    return resources ?? [];
  } catch {
    return [];
  }
}

/** Do we carry this release at all (any player)? Distinguishes a missing
 *  checklist from a checklist that's merely thin on one player. */
async function setExists(
  container: Container,
  sport: string,
  year: number,
  setKey: string,
): Promise<boolean> {
  try {
    const { resources } = await container.items.query<{ n: number }>({
      query:
        "SELECT TOP 1 VALUE 1 FROM c WHERE c.sport = @s AND c.year = @y AND c.setKey = @sk",
      parameters: [
        { name: "@s", value: sport },
        { name: "@y", value: year },
        { name: "@sk", value: setKey },
      ],
    }).fetchAll();
    return (resources?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

function findNumberMatch(
  rows: CatalogNumberRow[],
  cardNumber: string,
): CatalogNumberRow | undefined {
  // Hyphen- and case-insensitive (D23, ruling d): BD152 verifies against
  // the checklist's BD-152.
  return rows.find((r) => sameCardNumber(r.cardNumber, cardNumber));
}

function numbersOf(rows: CatalogNumberRow[]): string[] {
  return rows
    .map((r) => String(r.cardNumber ?? "").trim())
    .filter(Boolean)
    .slice(0, 10);
}

/**
 * Verify a parsed identity against our own catalog.
 *
 * Never throws and never blocks a caller — every failure path degrades to
 * `verified: null`. A null with a gap reason has ALREADY enqueued the seed
 * request that fixes it.
 */
export async function verifyCardIdentity(
  input: CatalogVerifyInput,
): Promise<CatalogVerifyResult> {
  const sport = String(input.sport ?? "").toLowerCase().trim();
  const year = Number(input.cardYear);
  const rawSet = String(input.setName ?? "").trim();
  const cardNumber = String(input.cardNumber ?? "").trim();
  const playerName = String(input.playerName ?? "").trim();

  if (!sport || !year || !rawSet || !cardNumber || !playerName) {
    return { verified: null, reason: "insufficient-input", source: "hobbyiq-catalog" };
  }

  const container = await getContainer();
  if (!container) {
    return { verified: null, reason: "catalog-unavailable", source: "hobbyiq-catalog" };
  }

  const setKey = normalizeSetKey(rawSet);
  const playerSlug = slugify(playerName);

  // Step 1 — exact: this player, this release.
  const rows = await rowsForPlayerInSet(container, sport, year, setKey, playerSlug);
  if (rows.length > 0) {
    const hit = findNumberMatch(rows, cardNumber);
    if (hit) {
      return {
        verified: true,
        reason: "exact-cardnumber-match",
        source: "hobbyiq-catalog",
        matchedSlug: hit.id,
      };
    }
    // We carry this player's cards for this set and the number isn't among
    // them — a genuine disagreement, which is a real verify signal.
    return {
      verified: false,
      reason: "no-cardnumber-match-in-set",
      source: "hobbyiq-catalog",
      candidateNumbers: numbersOf(rows),
    };
  }

  // Step 2 — family fallback. Specialized releases nest under a flagship
  // (memory: product-family ladder), and a checklist is often indexed at
  // the parent. Only a positive match counts here: absence under the
  // parent says nothing about the child.
  const parentKey = deriveParentSetKey(setKey);
  if (parentKey && parentKey !== setKey) {
    const parentRows = await rowsForPlayerInSet(container, sport, year, parentKey, playerSlug);
    const parentHit = findNumberMatch(parentRows, cardNumber);
    if (parentHit) {
      return {
        verified: true,
        reason: "family-cardnumber-match",
        source: "hobbyiq-catalog",
        matchedSlug: parentHit.id,
      };
    }
  }

  // Step 3 — nothing for this player. Is the release itself missing, or
  // just thin? Both are catalog gaps; the distinction drives seed priority
  // and keeps "we never heard of this set" from reading as "bad parse."
  const haveSet = await setExists(container, sport, year, setKey);
  const reason: CatalogVerifyReason = haveSet ? "player-not-in-set" : "set-not-in-catalog";

  const seedRequested = await requestChecklistSeed({
    sport,
    year,
    setName: rawSet,
    setKey,
    reason,
    missingPlayer: playerName,
    missingCardNumber: cardNumber,
  });

  return { verified: null, reason, source: "hobbyiq-catalog", seedRequested };
}

/** Test seam — drops the memoized container so a fresh env is picked up. */
export function __resetCatalogVerifyContainerForTests(): void {
  _container = null;
}
