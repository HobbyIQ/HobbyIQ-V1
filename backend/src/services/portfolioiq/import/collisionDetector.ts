// CF-IMPORT-BE (2026-06-21) — collision (dedup) detector.
//
// The #2 guard: detect when an incoming row collides with an existing
// holding on (identity + grade + serial). This is the Hartman-4× scenario —
// same physical card across multiple holdings. The preview returns per-row
// actions {skip / add-copy / update-cost}; the user picks per-row, with
// skip-default for safety.
//
// "Update-cost on holdingId match" refinement (4-prime, banked):
// when both identity AND holdingId match an existing row, that signals
// "re-importing the same exported row" (a round-trip) — default flips
// to update-cost rather than skip. Skip-default stays only for the
// arbitrary-path case where identity matches but holdingId is missing/new.
//
// CF-IMPORT-RESOLVES-TO-CHECKLIST (D12-b, 2026-08-29). The key is derived
// from the RESOLVED SLUG, and a row with no slug is keyed by its title tuple
// (player / year / product / cardNumber / parallel) instead of skipping the
// check. The old null-skip meant the entire unresolved population — which,
// with the resolver stubbed, was every arbitrary-sheet row — bypassed dedup.

import type { PortfolioHolding } from "../../../types/portfolioiq.types.js";

export type CollisionAction = "skip" | "add-as-copy" | "update-cost";

export interface CollisionRow {
  /** Resolved canonical slug, or null when the row did not resolve. */
  cardId: string | null;
  holdingId: string | null;
  parallel: string | null;
  gradeCompany: string | null;
  gradeValue: number | null;
  serialNumber: string | null;
  /** Title tuple — keys the row when there is no slug. */
  playerName?: string | null;
  cardYear?: number | null;
  product?: string | null;
  cardNumber?: string | null;
}

export interface CollisionDetection {
  /** True when the row collides with at least one existing holding (or an
   *  earlier row of the same import). */
  collides: boolean;
  /** Matching existing holdingIds (most relevant first by specificity). */
  existingHoldingIds: string[];
  /** Earlier rows of the same import that carry the same key. */
  duplicateOfRowNumbers?: number[];
  /** "skip" | "add-as-copy" | "update-cost" — the default action; user can override. */
  defaultAction: CollisionAction;
  /** Reason the defaultAction was selected; surfaces in the preview. */
  reason: string;
  /** Which key matched: the resolved slug, or the title tuple. */
  keyedBy: "slug" | "title";
}

function norm(v: string | null | undefined | number): string {
  return (v ?? "").toString().trim().toLowerCase();
}

function gradeSerialKey(row: {
  gradeCompany?: string | null;
  gradeValue?: number | null;
  serialNumber?: string | null;
}): string {
  return [norm(row.gradeCompany), row.gradeValue ?? "", norm(row.serialNumber)].join("|");
}

/** The slug half of the key: identity + grade + serial. Null without a slug. */
export function slugCollisionKey(row: {
  cardId?: string | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  serialNumber?: string | null;
}): string | null {
  const id = norm(row.cardId);
  if (!id) return null;
  return `slug:${id}|${gradeSerialKey(row)}`;
}

/** The title-tuple half of the key: what the row SAYS it is + grade + serial.
 *  Null when the row says nothing at all. */
export function titleCollisionKey(row: {
  playerName?: string | null;
  cardYear?: number | null;
  product?: string | null;
  cardNumber?: string | null;
  parallel?: string | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  serialNumber?: string | null;
}): string | null {
  const tuple = [norm(row.playerName), row.cardYear ?? "", norm(row.product), norm(row.cardNumber), norm(row.parallel)];
  if (tuple.every((t) => t === "")) return null;
  return `title:${tuple.join("|")}|${gradeSerialKey(row)}`;
}

/** The key an incoming row is deduplicated on. Slug when resolved, title
 *  tuple otherwise — never null-skips. */
export function collisionKeyOf(row: CollisionRow): string | null {
  return slugCollisionKey(row) ?? titleCollisionKey(row);
}

function existingKeys(h: PortfolioHolding): { slug: string | null; title: string | null } {
  const loose = h as PortfolioHolding & { hobbyiqCardId?: string | null };
  const grade = { gradeCompany: h.gradeCompany ?? null, gradeValue: h.gradeValue ?? null, serialNumber: h.serialNumber ?? null };
  return {
    slug: slugCollisionKey({ cardId: loose.hobbyiqCardId ?? h.cardId ?? null, ...grade }),
    title: titleCollisionKey({
      playerName: h.playerName ?? null,
      cardYear: h.cardYear ?? null,
      product: h.product ?? (h as { setName?: string }).setName ?? null,
      cardNumber: h.cardNumber ?? null,
      parallel: h.parallel ?? null,
      ...grade,
    }),
  };
}

/**
 * Find collisions for one incoming row against the user's existing holdings.
 *
 * A resolved row matches an existing holding on the slug key, OR on the
 * title key (the same card text under a different / absent id is still the
 * same card). An unresolved row matches on the title key only.
 */
export function detectCollision(
  row: CollisionRow,
  existingHoldings: Record<string, PortfolioHolding>,
): CollisionDetection {
  const slugKey = slugCollisionKey(row);
  const titleKey = titleCollisionKey(row);

  if (!slugKey && !titleKey) {
    return {
      collides: false,
      existingHoldingIds: [],
      defaultAction: "skip",
      reason: "row carries no identity and no title; nothing to compare",
      keyedBy: "title",
    };
  }

  const matches: string[] = [];
  let keyedBy: "slug" | "title" = slugKey ? "slug" : "title";
  for (const [hid, h] of Object.entries(existingHoldings)) {
    if (!h) continue;
    const keys = existingKeys(h);
    if (slugKey && keys.slug === slugKey) {
      matches.push(hid);
      keyedBy = "slug";
      continue;
    }
    if (titleKey && keys.title === titleKey) {
      matches.push(hid);
    }
  }

  if (matches.length === 0) {
    return {
      collides: false,
      existingHoldingIds: [],
      defaultAction: "skip",
      reason: slugKey
        ? "no existing holding matches the (slug + grade + serial) key"
        : "no existing holding matches the title tuple (player + year + product + number + parallel + grade + serial)",
      keyedBy,
    };
  }

  // 4-prime: when holdingId on the incoming row matches one of the
  // matches, that signals "re-importing the same exported row" → default
  // to update-cost rather than skip.
  if (row.holdingId && matches.includes(row.holdingId)) {
    return {
      collides: true,
      existingHoldingIds: matches,
      defaultAction: "update-cost",
      reason: "holdingId + identity match an existing row — round-trip update default",
      keyedBy,
    };
  }

  return {
    collides: true,
    existingHoldingIds: matches,
    defaultAction: "skip",
    reason: keyedBy === "slug"
      ? `collision on ${row.cardId} (grade/serial match); skip-default applied`
      : "collision on title tuple (player/year/product/number/parallel + grade/serial match); skip-default applied",
    keyedBy,
  };
}
