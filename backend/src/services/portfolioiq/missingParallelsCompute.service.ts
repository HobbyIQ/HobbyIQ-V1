// CF-MISSING-PARALLELS (Drew, 2026-07-17). Pure math for finding
// parallels a user doesn't own for players/sets they DO own.
//
// Input: user's owned cardIds bucketed by (player, year, cardSet) +
// the corpus's full parallel catalog for each bucket. Output: the
// bucket-level list of parallels missing from ownership, with
// recent-sales stats so iOS can rank them by "worth chasing".

/** One row from ch_daily_sales-derived aggregates, keyed by cardId. */
export interface CorpusParallelRow {
  cardId: string;
  player: string;
  year: number;
  cardSet: string;
  variant: string;
  number: string;
  recentSales: number;
  medianPrice: number;
  imageUrl: string | null;
}

export interface MissingParallelsBundle {
  player: string;
  year: number;
  cardSet: string;
  ownedVariants: string[];
  missingParallels: Array<{
    cardId: string;
    variant: string;
    number: string;
    recentSales: number;
    medianPrice: number;
    imageUrl: string | null;
  }>;
}

/** Bucketed compute. For each (player, year, cardSet) the user owns
 *  at least ONE card in, list every parallel in the corpus not
 *  matching an owned cardId. Requires the caller to provide:
 *    ownedCardIds: Set of cardIds the user owns
 *    ownedBuckets: Set of "player::year::cardSet" strings the user owns
 *    corpusRows: all corpus rows for those bucket keys (caller filters). */
export function computeMissingParallels(
  ownedCardIds: Set<string>,
  ownedBuckets: Set<string>,
  corpusRows: CorpusParallelRow[],
): MissingParallelsBundle[] {
  const byBucket = new Map<string, MissingParallelsBundle>();

  for (const row of corpusRows) {
    const bucketKey = `${row.player}::${row.year}::${row.cardSet}`;
    if (!ownedBuckets.has(bucketKey)) continue;

    let bundle = byBucket.get(bucketKey);
    if (!bundle) {
      bundle = {
        player: row.player,
        year: row.year,
        cardSet: row.cardSet,
        ownedVariants: [],
        missingParallels: [],
      };
      byBucket.set(bucketKey, bundle);
    }

    if (ownedCardIds.has(row.cardId)) {
      if (!bundle.ownedVariants.includes(row.variant)) {
        bundle.ownedVariants.push(row.variant);
      }
      continue;
    }

    // Not owned — track as missing.
    bundle.missingParallels.push({
      cardId: row.cardId,
      variant: row.variant,
      number: row.number,
      recentSales: row.recentSales,
      medianPrice: row.medianPrice,
      imageUrl: row.imageUrl,
    });
  }

  // Sort each bundle's missing parallels by medianPrice DESC (most valuable first).
  for (const bundle of byBucket.values()) {
    bundle.missingParallels.sort((a, b) => b.medianPrice - a.medianPrice);
    bundle.ownedVariants.sort();
  }

  return Array.from(byBucket.values())
    .sort((a, b) => a.player.localeCompare(b.player));
}

/** Utility for callers: derive bucketKey + parallelKey shape. */
export function bucketKeyOf(player: string, year: number, cardSet: string): string {
  return `${player}::${year}::${cardSet}`;
}
