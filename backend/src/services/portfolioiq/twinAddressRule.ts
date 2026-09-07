// CF-A-PARKED-TWIN-IS-NOT-A-TWIN (2026-09-07, #1953).
//
// The rule that decides what a sold_comps write door does when the sale id it
// is about to write already exists somewhere in the container.
//
// WHY THIS IS ITS OWN MODULE. The predicate lived inline inside
// persistVendorSalesToPool's 1,300-line write loop, where it had no seam and
// no test could reach it. It was one line --
//
//     const twin = elsewhere.find((r) => r.cardId !== doc.cardId);
//
// -- and that line was wrong in two independent ways at once, both of which a
// three-line unit test would have caught. A rule this load-bearing (it gates
// EVERY vendor sale entering the pool) has to be readable and executable on
// its own.
//
// THE TWO DEFECTS IT REPLACES, both measured on the hourly promoter's stuck
// backlog (run 34133391955, 2026-09-07 14:31Z: scanned 6,557, inserted 0,
// `WORK VANISHED — UNACCOUNTED 6,557 (100.00%)`; 461 distinct sale ids, 200 of
// them probed live against sold_comps):
//
//   1. IT SKIPPED PAST THE ROW'S OWN ADDRESS. The query returns EVERY copy of
//      the id, including one already at `doc.cardId`. `.find(r => r.cardId !==
//      doc.cardId)` steps over it and reports the first row it finds
//      elsewhere. So a sale correctly resident at the very address being
//      written was refused. That write cannot create a second document --
//      Cosmos scopes id uniqueness per partition and the id is already in that
//      partition, so the upsert is a REPLACE. Refusing it is refusing to
//      notice the work was already done. 124 of the 200 probed (62%).
//
//   2. IT COUNTED PARKED COPIES AS RIVALS. #1942's repair lane parks the
//      losing copy of a duplicate with `flaggedWrong: true`, `flaggedReason:
//      "duplicate-partition-copy"` and `dedupSupersededBy` NAMING THE WINNING
//      ADDRESS. A parked row is out of every pool: it cannot split a pool and
//      it cannot double-count, which is the entire purpose of parking it. Of
//      the 139 parked copies in the sample, 131 carried `dedupSupersededBy`
//      equal to EXACTLY the address the promoter was trying to write -- so the
//      guard was using the repair lane's own ruling as a permanent block on
//      the write that ruling authorized.
//
// The backlog this produced is permanent rather than flowing: the 461 ids
// refused at 14:31Z were a 100% subset of the 503 refused at 13:31Z. The same
// rows, every hour, at ~14 persist calls per id, forever, because nothing
// about them could change.
//
// THE RULE. A twin is a copy of this sale at a DIFFERENT address that is still
// LIVE. A parked copy is not a twin. A copy at THIS address is not a twin --
// it is this row.

/** The projection the write door reads. Only the fields the rule consults. */
export interface TwinCandidate {
  cardId?: string | null;
  flaggedWrong?: boolean | null;
  identityUnverified?: boolean | null;
  dedupSupersededBy?: string | null;
}

export type TwinVerdict =
  /** No copy of this id anywhere else that is live, and none here. A normal
   *  first write. */
  | { action: "write"; liveTwinAt: null }
  /** The sale is already resident at the address being written. The upsert is
   *  a replace, so it proceeds -- but it enters no NEW sale, and a caller
   *  reconciling `scanned = inserted + ...` needs that named or the row falls
   *  out of its ledger. `liveTwinAt` is non-null when a live copy ALSO exists
   *  elsewhere: the write here is still safe (it touches only this partition),
   *  and the other copy is the dedup lane's to adjudicate. */
  | { action: "fold"; liveTwinAt: string | null }
  /** A live copy holds a different address and this row is not resident here.
   *  Writing would mint a second document for one sale. Refused: absent beats
   *  wrong, and which address is right is a ruling, not an ingest decision. */
  | { action: "refuse"; liveTwinAt: string };

/**
 * A parked copy is out of every pool, so it is not a competing address.
 *
 * Both markers count. `flaggedWrong` is the dedup lane's (#1942);
 * `identityUnverified` is the write guard's (CF-ONE-WRITE-PATH-FOR-SOLD-COMPS)
 * -- a row whose identity nothing attests is likewise held out of every pool.
 * Either one means the row is not pricing a card, which is the only property
 * this rule cares about.
 */
export function isParked(row: TwinCandidate | null | undefined): boolean {
  return row?.flaggedWrong === true || row?.identityUnverified === true;
}

/**
 * Decide what to do with a sale id whose copies are `copies`, when the write
 * door intends to write it at `writingAt`.
 *
 * `copies` is every document sharing this id, cross-partition -- INCLUDING one
 * at `writingAt` if it exists. Passing only the "other" rows would reintroduce
 * defect 1 at the call site.
 */
export function decideTwinAddress(writingAt: string, copies: readonly TwinCandidate[]): TwinVerdict {
  const here = String(writingAt ?? "");
  const residentHere = copies.some((r) => String(r?.cardId ?? "") === here);
  const liveTwin = copies.find((r) => String(r?.cardId ?? "") !== here && !isParked(r));
  const liveTwinAt = liveTwin ? String(liveTwin.cardId ?? "") : null;

  if (residentHere) return { action: "fold", liveTwinAt };
  if (liveTwinAt) return { action: "refuse", liveTwinAt };
  // Every other copy is parked and none is at this address, so the sale has no
  // live home. Writing it here is what gives it one.
  return { action: "write", liveTwinAt: null };
}
