// CF-ONE-WAY-TO-MOVE-A-CATALOG-ROW (Drew, catalog rebuild D5, 2026-08-29).
//
// A census found 15 scripts that MOVE a card_catalog row -- rename a setKey,
// clean a parallel name, fix a card number, fold onto a twin, re-point the
// sales, delete the old row. One shape, copied 15 times, with four real
// defects spread across the copies:
//
//   1. six of the seven setKey rewrites carried the OLD set's searchTokens
//      through `...rest`, so the moved row kept answering searches for the
//      set it had just left;
//   2. none rebuilt searchText or displayName;
//   3. none unioned vendorIds on a fold -- a cross-reference silently lost
//      every time a twin absorbed a row;
//   4. five of seven never retired the graded children
//      (`STARTSWITH(c.id, id + ":") AND IS_DEFINED(c.gradeTier)`), which were
//      left pointing at a deleted parent; and five did no authority check at
//      all (write only `if (!existing)`), so a DERIVED incumbent beat an
//      incoming CHECKLIST row -- exactly the failure cardCatalog.service
//      documents under CF-THE-CLEANEST-ONE-WINS.
//
// Two of them also re-declared a local CHECKLIST_SOURCE regex that had drifted
// from catalogAuthority.service. This module is the one shape. Scripts keep
// their own client, sharding, budget and retry, and hand the containers in.
//
// ORDER IS THE INVARIANT. Copy before delete, sales before delete:
//
//   1. the survivor is written at newSlug          (a row exists to point at)
//   2. sold_comps rows at the old slug are re-pointed
//   3. graded children of the OLD slug are retired  (regenerable from the parent)
//   4. the old row is deleted LAST
//
// so at every instant every sale points at a row that exists. A crash between
// any two steps leaves a duplicate identity, never a dangling sale.
//
// Builders reused rather than re-spelled:
//   searchText / searchTokens  searchIndexing.service (buildSearchText, buildSearchTokens)
//   displayName                canonicalCardName (CF-ONE-NAME-FORMAT-FOR-EVERY-CARD)
//   parallelSlug / playerSlug  deriveCatalogEntry when it agrees with newSlug,
//                              else the slug's own segments + slugify
//   brand / parentSetKey       deriveBrand / deriveParentSetKey on a setKey change
//   authority                  authorityRank (catalogAuthority.service)

import type { Container, PatchOperation, SqlQuerySpec } from "@azure/cosmos";
import { deriveCatalogEntry, type CardCatalogEntry } from "../portfolioiq/cardCatalog.service.js";
import {
  deriveBrand,
  deriveParentSetKey,
  parseHobbyIqCardId,
  slugify,
} from "../portfolioiq/hobbyIqCardId.service.js";
import { buildSearchText, buildSearchTokens } from "../portfolioiq/searchIndexing.service.js";
import { authorityRank } from "./catalogAuthority.service.js";
import { canonicalCardName } from "./canonicalCardName.js";

/** A catalog row as it comes back from Cosmos: the typed fields plus whatever
 *  else the writer stamped on it. Extra fields travel with the row. */
export type CatalogRowDoc = CardCatalogEntry & Record<string, unknown>;

/** Scripts keep their own retry (429/timeout backoff). Every Cosmos call this
 *  module makes goes through it; the default is no retry at all. */
export type CatalogOpsRetry = <T>(fn: () => Promise<T>) => Promise<T>;
const noRetry: CatalogOpsRetry = (fn) => fn();

export type MoveCatalogRowAction = "move" | "fold" | "replace" | "noop";

export interface MoveCatalogRowOptions {
  /** Stamped on every re-pointed sale (`reslugedReason`) and on the moved row
   *  (`movedReason`). Required: a move with no reason is a move nobody can
   *  audit. */
  reason: string;
  /** Also stamp `normalizedSetKey` on re-pointed sales with the survivor's
   *  setKey. Set on setKey renames; leave off for parallel/number moves. */
  repointNormalizedSetKey?: boolean;
  /** Read everything, write nothing, return the counts a real run would. */
  dryRun?: boolean;
  /** sold_comps. Omit only when the caller KNOWS no sale points at the old
   *  slug; the decision string says so when it was omitted. */
  salesContainer?: Container;
  /** The incumbent at newSlug when the caller already looked (including
   *  `null` for "I checked, it is not there"). Same contract as
   *  upsertCatalogEntry's `known` -- CF-DO-NOT-LOOK-TWICE. */
  known?: CatalogRowDoc | null;
  retry?: CatalogOpsRetry;
}

export interface MoveCatalogRowResult {
  /** move: nothing was at newSlug. replace: the incoming row won the
   *  collision. fold: the incumbent won and absorbed the old row. noop:
   *  newSlug is the row's own id. */
  action: MoveCatalogRowAction;
  newSlug: string;
  salesRepointed: number;
  gradedChildrenRetired: number;
  /** Whose fields now sit at newSlug. */
  survivor: "incoming" | "incumbent" | null;
  /** Why -- the "say what you chose" line, in words a script can print. */
  decision: string;
}

export interface RetireCatalogRowOptions {
  dryRun?: boolean;
  retry?: CatalogOpsRetry;
}

export interface RetireCatalogRowResult {
  /** noop: neither the row nor any graded child existed. */
  action: "retire" | "noop";
  id: string;
  rowDeleted: boolean;
  gradedChildrenRetired: number;
  /** Carried back for the caller's log line. A delete has no fields, so
   *  nothing in Cosmos records it -- and nothing is stamped on the sales:
   *  the rematch owns unplaced sales. */
  reason: string;
}

// ── field hygiene ────────────────────────────────────────────────────────────

/** Cosmos system properties. Never copy them onto a new document. */
const SYSTEM_FIELDS = ["_rid", "_self", "_etag", "_attachments", "_ts"] as const;

/** Annotations that describe the SLUG, not the card: whether THIS id is
 *  checklist-backed. True of the old address, meaningless at the new one, and
 *  annotate-checklist-backing re-derives them. Both reference movers strip
 *  these; the helper does the same so a moved row cannot claim a backing it
 *  was never measured for. */
const SLUG_BOUND_FIELDS = ["checklistBacking", "checklistBackingAt", "checklistFamilySetKeys"] as const;

function stripSystemFields(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const k of SYSTEM_FIELDS) delete out[k];
  return out;
}

function stripSlugBoundFields(row: Record<string, unknown>): Record<string, unknown> {
  const out = stripSystemFields(row);
  for (const k of SLUG_BOUND_FIELDS) delete out[k];
  return out;
}

/** Earliest of several ISO timestamps, ignoring blanks. Lexical order IS
 *  chronological order for ISO-8601 strings in one timezone. */
function earliest(...stamps: Array<unknown>): string | undefined {
  const xs = stamps.filter((s): s is string => typeof s === "string" && s.length > 0).sort();
  return xs[0];
}

// ── the searchable fields ────────────────────────────────────────────────────

/**
 * searchText / searchTokens / displayName for a row, from the row's own
 * identity fields. The field mapping is the canonical-row shape that
 * scripts/comp-quality/searchTokenBuilders.cjs (the nightly backfill and the
 * coverage canary) reads: player, setName, setKey with hyphens as spaces,
 * cardNumber, year, the parallel unless it is Base, and the parallelSlug's
 * words. Same spelling, so a moved row is not "stale" to the canary.
 *
 * Exported so an in-place heal (a row whose slug did not change but whose
 * name text did) can rebuild the same three fields the same way.
 */
export function rebuildSearchFields(row: {
  sport?: string | null;
  year?: number | null;
  setKey?: string | null;
  setName?: string | null;
  cardNumber?: string | null;
  playerName?: string | null;
  parallel?: string | null;
  parallelSlug?: string | null;
  printRun?: number | null;
  subsetName?: string | null;
}): { searchText: string; searchTokens: string[]; displayName: string } {
  const setKey = String(row.setKey ?? "").trim();
  const parallel = String(row.parallel ?? "").trim();
  const parallelSlug = String(row.parallelSlug ?? "").trim();
  const searchText = buildSearchText({
    player: row.playerName ?? null,
    setName: row.setName ?? null,
    set: setKey ? setKey.replace(/-/g, " ") : null,
    number: row.cardNumber ?? null,
    year: row.year ?? null,
    variant: parallel && parallel.toLowerCase() !== "base" ? parallel : null,
    attributes: parallelSlug && parallelSlug !== parallel ? [parallelSlug.replace(/-/g, " ")] : null,
  });
  return {
    searchText,
    searchTokens: buildSearchTokens(searchText),
    displayName: canonicalCardName({
      year: row.year ?? null,
      setName: row.setName ?? null,
      setKey,
      sport: row.sport ?? null,
      cardNumber: row.cardNumber ?? null,
      playerName: row.playerName ?? null,
      parallel: parallel || null,
      printRun: typeof row.printRun === "number" ? row.printRun : null,
      subsetName: row.subsetName ?? null,
    }),
  };
}

// ── the incoming row ─────────────────────────────────────────────────────────

/**
 * The old row as it should exist at newSlug: id fields from the slug, the
 * derived fields re-derived, the searchable fields rebuilt, the slug-bound
 * annotations dropped. Pure -- no I/O -- and it THROWS when the slug and the
 * fields disagree about the setKey, because a key needs both halves and a
 * row whose id says one product while its setKey says another is the
 * fragmentation this module exists to end.
 */
function buildIncoming(
  oldRow: CatalogRowDoc,
  newSlug: string,
  changedFields: Partial<CardCatalogEntry> & Record<string, unknown>,
): CatalogRowDoc {
  const merged = { ...stripSlugBoundFields(oldRow), ...changedFields } as CatalogRowDoc;
  const parsed = parseHobbyIqCardId(newSlug);
  if (!parsed) throw new Error(`moveCatalogRow: newSlug is not a hiq slug: ${newSlug}`);
  const setKey = String(merged.setKey ?? "").trim();
  if (parsed.setKey !== setKey) {
    throw new Error(
      `moveCatalogRow: newSlug says setKey "${parsed.setKey}" but the row says "${setKey}" (${newSlug}) -- a key needs both halves`,
    );
  }

  const playerName = merged.playerName ? String(merged.playerName).trim() || null : null;
  const cardNumber = String(merged.cardNumber ?? "").trim().toUpperCase();
  const parallel = String(merged.parallel ?? "Base");
  const printRun = typeof merged.printRun === "number" && Number.isFinite(merged.printRun)
    ? merged.printRun
    : parsed.printRun ?? null;

  // deriveCatalogEntry is the canonical constructor; use its derived fields
  // whenever the slug it computes IS newSlug. It applies the slug generator's
  // vocabulary (Colour = Refractor on chrome stock, the auto-only prefixes),
  // so it can disagree with a caller-supplied ruling -- and the caller
  // carries the ruling. When it disagrees, or the row has no player (8.4% of
  // the catalog), the slug's own segments are the derivation.
  const derived = playerName
    ? deriveCatalogEntry({
        sport: String(merged.sport ?? ""),
        year: parsed.year,
        setKey,
        cardNumber,
        parallel,
        isAuto: parsed.isAuto,
        printRun,
        playerName,
        source: String(merged.source ?? ""),
        confidence: Number(merged.confidence ?? 0),
        authoritativeSetKey: true,
      })
    : null;
  const agrees = derived !== null && derived.id === newSlug;
  const parallelSlug = agrees ? derived.parallelSlug : parsed.parallel;
  const playerSlug = agrees
    ? derived.playerSlug
    : playerName ? slugify(playerName) : (typeof merged.playerSlug === "string" ? merged.playerSlug : null);
  const setKeyChanged = setKey !== String(oldRow.setKey ?? "").trim();

  const doc: CatalogRowDoc = {
    ...merged,
    id: newSlug,
    cardId: newSlug,
    hobbyiqCardId: newSlug,
    setKey,
    cardNumber,
    parallel,
    parallelSlug,
    playerName,
    playerSlug,
    // CF-YEAR-CARDYEAR-DUAL-WRITE: both names, always.
    year: parsed.year,
    cardYear: parsed.year,
    // The slug's segment 6 IS the auto boundary; a row field that disagrees
    // with its own id is the stale one.
    isAuto: parsed.isAuto,
    printRun,
    ...(setKeyChanged ? { brand: deriveBrand(setKey), parentSetKey: deriveParentSetKey(setKey) } : {}),
  };
  Object.assign(doc, rebuildSearchFields(doc));
  return doc;
}

/**
 * The row as it should exist in its OWN partition (a rehome: same slug,
 * foreign `cardId`). Nothing about the card changes, so nothing derived is
 * rebuilt and the slug-bound annotations stay -- they still describe this
 * slug. The old partition key was a vendor id for 17.7M rows
 * (CF-A-ROW-IN-THE-WRONG-PARTITION-IS-AN-INVISIBLE-ROW) and a CH lookup
 * resolves by it, so it is kept under the row's source in vendorIds.
 */
function rehomeIncoming(
  oldRow: CatalogRowDoc,
  oldPk: string,
  changedFields: Partial<CardCatalogEntry> & Record<string, unknown>,
): CatalogRowDoc {
  const doc = { ...stripSystemFields(oldRow), ...changedFields, cardId: String(oldRow.id) } as CatalogRowDoc;
  if (!oldPk.startsWith("hiq:")) {
    const k = String(oldRow.source ?? "vendor");
    const vendorIds = { ...(doc.vendorIds ?? {}) };
    if (!vendorIds[k]) vendorIds[k] = oldPk;
    doc.vendorIds = vendorIds;
  }
  return doc;
}

// ── the collision ────────────────────────────────────────────────────────────

function salesCounter(row: CatalogRowDoc): number {
  if (typeof row.compCount === "number") return row.compCount;
  if (typeof row.observedCompCount === "number") return row.observedCompCount;
  return 0;
}

/**
 * Who keeps the address when a row already sits at newSlug.
 *
 * Authority first, and it is decisive: the incoming row NEVER loses to a
 * lower-authority incumbent, and never beats a higher one. catalogAuthority
 * says a derived row "must never outvote a checklist"; the `if (!existing)`
 * scripts let it, every time. Within a class: more vendorIds, then more
 * observed sales, then confidence, then the incumbent keeps its address --
 * it is already at the canonical slug and rewriting it gains nothing.
 */
function chooseSurvivor(
  incoming: CatalogRowDoc,
  incumbent: CatalogRowDoc,
): { survivor: "incoming" | "incumbent"; decision: string } {
  const rankIn = authorityRank(incoming.source);
  const rankInc = authorityRank(incumbent.source);
  const tag = (row: CatalogRowDoc, rank: number) => `${String(row.source ?? "?")} (rank ${rank})`;
  if (rankIn !== rankInc) {
    return rankIn > rankInc
      ? { survivor: "incoming", decision: `authority: incoming ${tag(incoming, rankIn)} outranks incumbent ${tag(incumbent, rankInc)}` }
      : { survivor: "incumbent", decision: `authority: incumbent ${tag(incumbent, rankInc)} outranks incoming ${tag(incoming, rankIn)}` };
  }
  const vIn = Object.keys(incoming.vendorIds ?? {}).length;
  const vInc = Object.keys(incumbent.vendorIds ?? {}).length;
  if (vIn !== vInc) {
    return vIn > vInc
      ? { survivor: "incoming", decision: `equal authority (${tag(incoming, rankIn)}): incoming carries ${vIn} vendorIds vs ${vInc}` }
      : { survivor: "incumbent", decision: `equal authority (${tag(incoming, rankIn)}): incumbent carries ${vInc} vendorIds vs ${vIn}` };
  }
  const sIn = salesCounter(incoming);
  const sInc = salesCounter(incumbent);
  if (sIn !== sInc) {
    return sIn > sInc
      ? { survivor: "incoming", decision: `equal authority and vendorIds: incoming has ${sIn} observed sales vs ${sInc}` }
      : { survivor: "incumbent", decision: `equal authority and vendorIds: incumbent has ${sInc} observed sales vs ${sIn}` };
  }
  const cIn = Number(incoming.confidence ?? 0);
  const cInc = Number(incumbent.confidence ?? 0);
  if (cIn !== cInc) {
    return cIn > cInc
      ? { survivor: "incoming", decision: `equal authority, vendorIds and sales: incoming confidence ${cIn} vs ${cInc}` }
      : { survivor: "incumbent", decision: `equal authority, vendorIds and sales: incumbent confidence ${cInc} vs ${cIn}` };
  }
  return { survivor: "incumbent", decision: "equal authority, vendorIds, sales and confidence: the incumbent keeps its address" };
}

// ── Cosmos plumbing ──────────────────────────────────────────────────────────

async function forEachPage<T>(
  container: Container,
  spec: SqlQuerySpec,
  retry: CatalogOpsRetry,
  fn: (rows: T[]) => Promise<void>,
): Promise<void> {
  let token: string | undefined;
  do {
    const page = await retry(() =>
      container.items.query<T>(spec, { maxItemCount: 200, continuationToken: token }).fetchNext(),
    );
    token = page.continuationToken || undefined;
    await fn(page.resources ?? []);
  } while (token);
}

/** Delete; a 404 is "already gone", which is the state we wanted. */
async function deleteTolerant(container: Container, id: string, pk: string, retry: CatalogOpsRetry): Promise<boolean> {
  try {
    await retry(() => container.item(id, pk).delete());
    return true;
  } catch (err) {
    if ((err as { code?: number })?.code === 404) return false;
    throw err;
  }
}

/** Point read at (slug, slug) -- ~1 RU, and correct for every row written
 *  through deriveCatalogEntry. Rows still under a foreign partition key are
 *  invisible to it; a caller that has looked harder passes `known`. */
async function readIncumbent(container: Container, slug: string, retry: CatalogOpsRetry): Promise<CatalogRowDoc | null> {
  try {
    const { resource } = await retry(() => container.item(slug, slug).read<CatalogRowDoc>());
    return resource ?? null;
  } catch (err) {
    if ((err as { code?: number })?.code === 404) return null;
    throw err;
  }
}

/**
 * Is this row a graded child of exactly this parent?
 *
 * Graded ids are `${parentSlug}:${tier}` and the census query is
 * `STARTSWITH(c.id, parent + ":") AND IS_DEFINED(c.gradeTier)`. That prefix
 * also matches the NUMBERED sibling's children: retiring
 * `hiq:…:gold:no-auto` would sweep up `hiq:…:gold:no-auto:num-50:psa-10`,
 * whose parent is a different card that is not going anywhere. parentSlug
 * settles it when present; otherwise the remainder after the prefix must be a
 * single segment -- a tier is `psa-10`, never `num-50:psa-10`.
 */
export function isGradedChildOf(row: { id: string; parentSlug?: string | null }, parentId: string): boolean {
  const id = String(row.id ?? "");
  const prefix = parentId + ":";
  if (!id.startsWith(prefix)) return false;
  if (typeof row.parentSlug === "string" && row.parentSlug) return row.parentSlug === parentId;
  // A tier is one segment and never the print-run segment: "psa-10" yes,
  // "num-50" (the numbered sibling itself) and "num-50:psa-10" (its child) no.
  const rest = id.slice(prefix.length);
  return rest.length > 0 && !rest.includes(":") && !rest.startsWith("num-");
}

const GRADED_CHILDREN_QUERY = "SELECT c.id, c.cardId, c.parentSlug FROM c WHERE STARTSWITH(c.id, @p) AND IS_DEFINED(c.gradeTier)";

async function retireGradedChildren(
  container: Container,
  parentId: string,
  retry: CatalogOpsRetry,
  dryRun: boolean,
): Promise<number> {
  let n = 0;
  await forEachPage<{ id: string; cardId?: string; parentSlug?: string | null }>(
    container,
    { query: GRADED_CHILDREN_QUERY, parameters: [{ name: "@p", value: parentId + ":" }] },
    retry,
    async (rows) => {
      for (const g of rows) {
        if (!isGradedChildOf(g, parentId)) continue;
        if (!dryRun) await deleteTolerant(container, g.id, g.cardId ?? g.id, retry);
        n++;
      }
    },
  );
  return n;
}

// ── the two operations ───────────────────────────────────────────────────────

/**
 * Move a catalog row to a new slug: copy, re-point its sales, retire its
 * graded children, delete the old row -- in that order. See the header for
 * why the order is the invariant.
 *
 * `changedFields` are the identity fields the caller changed (setKey,
 * parallel, cardNumber, printRun, parallelNote, ...). Everything derived from
 * them -- parallelSlug, playerSlug, year/cardYear, isAuto, brand,
 * parentSetKey, searchText, searchTokens, displayName -- is rebuilt here, so a
 * caller cannot forget one.
 *
 * `newSlug === oldRow.id` with a foreign `cardId` is a REHOME: the slug is
 * right, the partition key is not (a vendor id, or a parent's slug from the
 * exploded ladder), so the (slug, slug) point read cannot see the row. The
 * card does not change: no sale is re-pointed (they already name this slug)
 * and no graded child is retired (they are still this row's children). Copy
 * to (slug, slug), decide a twin by the same authority rule, delete the
 * foreign copy last.
 */
export async function moveCatalogRow(
  container: Container,
  oldRow: CatalogRowDoc,
  newSlug: string,
  changedFields: Partial<CardCatalogEntry> & Record<string, unknown>,
  opts: MoveCatalogRowOptions,
): Promise<MoveCatalogRowResult> {
  const reason = String(opts.reason ?? "").trim();
  if (!reason) throw new Error("moveCatalogRow: reason is required");
  const retry = opts.retry ?? noRetry;
  const dryRun = opts.dryRun === true;
  const now = new Date().toISOString();
  const oldId = String(oldRow.id);
  const oldPk = String(oldRow.cardId ?? oldId);
  const rehome = newSlug === oldId && oldPk !== oldId;
  if (newSlug === oldId && !rehome) {
    return { action: "noop", newSlug, salesRepointed: 0, gradedChildrenRetired: 0, survivor: null, decision: "newSlug equals the row's id; nothing to move" };
  }

  const incoming = rehome ? rehomeIncoming(oldRow, oldPk, changedFields) : buildIncoming(oldRow, newSlug, changedFields);
  const incumbent = "known" in opts ? (opts.known ?? null) : await readIncumbent(container, newSlug, retry);

  let action: MoveCatalogRowAction;
  let survivor: "incoming" | "incumbent";
  let decision: string;
  let doc: CatalogRowDoc;
  const stamp = rehome
    ? { rehomedFrom: oldPk, rehomedReason: reason, rehomedAt: now }
    : { movedFrom: oldId, movedReason: reason, movedAt: now };
  if (!incumbent) {
    action = "move";
    survivor = "incoming";
    decision = `no row at ${newSlug}`;
    doc = { ...incoming, ...stamp, observedAt: earliest(oldRow.observedAt) ?? now, lastSeenAt: now };
  } else {
    const choice = chooseSurvivor(incoming, incumbent);
    survivor = choice.survivor;
    decision = choice.decision;
    // observedAt / firstSeenAt: the card was first seen when EITHER row first
    // saw it. vendorIds: a union, the survivor's value winning a key clash.
    const observedAt = earliest(oldRow.observedAt, incumbent.observedAt) ?? now;
    const firstSeenAt = earliest(oldRow.firstSeenAt, incumbent.firstSeenAt);
    if (survivor === "incoming") {
      action = "replace";
      doc = {
        ...incoming,
        ...stamp,
        vendorIds: { ...(incumbent.vendorIds ?? {}), ...(incoming.vendorIds ?? {}) },
        observedAt,
        ...(firstSeenAt ? { firstSeenAt } : {}),
        lastSeenAt: now,
        replacedSource: incumbent.source,
      };
    } else {
      action = "fold";
      doc = {
        ...(stripSystemFields(incumbent) as CatalogRowDoc),
        vendorIds: { ...(incoming.vendorIds ?? {}), ...(incumbent.vendorIds ?? {}) },
        observedAt,
        ...(firstSeenAt ? { firstSeenAt } : {}),
        lastSeenAt: now,
      };
    }
  }
  if (rehome) decision = `rehome from partition ${oldPk}: ${decision}`;

  // 1. Copy first. The survivor exists at newSlug before any sale points there.
  if (!dryRun) {
    await retry(() => container.items.upsert(doc));
    // A replaced incumbent that still sat under a foreign partition key was
    // not overwritten by the upsert at (newSlug, newSlug); remove that copy
    // or the id exists twice.
    if (action === "replace" && incumbent && typeof incumbent.cardId === "string" && incumbent.cardId !== newSlug) {
      await deleteTolerant(container, newSlug, incumbent.cardId, retry);
    }
  }

  // 2. Sales follow the card. On a rehome the card did not move.
  let salesRepointed = 0;
  if (rehome) {
    decision += "; sales and graded children stay (the slug did not change)";
  } else if (opts.salesContainer) {
    const sales = opts.salesContainer;
    const ops: PatchOperation[] = [
      { op: "set", path: "/hobbyiqCardId", value: newSlug },
      { op: "set", path: "/reslugedFrom", value: oldId },
      { op: "set", path: "/reslugedReason", value: reason },
      { op: "set", path: "/reslugedAt", value: now },
      ...(opts.repointNormalizedSetKey ? [{ op: "set", path: "/normalizedSetKey", value: incoming.setKey } as PatchOperation] : []),
    ];
    await forEachPage<{ id: string; cardId: string }>(
      sales,
      { query: "SELECT c.id, c.cardId FROM c WHERE c.hobbyiqCardId = @s", parameters: [{ name: "@s", value: oldId }] },
      retry,
      async (rows) => {
        for (const x of rows) {
          if (!dryRun) await retry(() => sales.item(x.id, x.cardId).patch(ops));
          salesRepointed++;
        }
      },
    );
  } else {
    decision += "; sales not re-pointed (no salesContainer)";
  }

  // 3. Graded children of the old slug. Regenerable from the survivor by
  //    materialize-graded-identities; they do not move. A rehomed row keeps
  //    its own ladder.
  const gradedChildrenRetired = rehome ? 0 : await retireGradedChildren(container, oldId, retry, dryRun);

  // 4. The old row, last -- on a rehome, the copy in the foreign partition.
  if (!dryRun) await deleteTolerant(container, oldId, oldPk, retry);

  return { action, newSlug, salesRepointed, gradedChildrenRetired, survivor, decision };
}

/**
 * Retire a catalog row: its graded children, then the row. The delete-only
 * half of a move, for the `retire-*` scripts. Nothing is stamped on the sales
 * that pointed here -- they are unplaced now, and the rematch owns unplaced
 * sales.
 */
export async function retireCatalogRow(
  container: Container,
  id: string,
  cardId: string | null | undefined,
  reason: string,
  opts: RetireCatalogRowOptions = {},
): Promise<RetireCatalogRowResult> {
  const why = String(reason ?? "").trim();
  if (!why) throw new Error("retireCatalogRow: reason is required");
  const retry = opts.retry ?? noRetry;
  const dryRun = opts.dryRun === true;
  const pk = cardId ? String(cardId) : id;

  const gradedChildrenRetired = await retireGradedChildren(container, id, retry, dryRun);
  let rowDeleted: boolean;
  if (dryRun) {
    // Report what a real run would delete, at the cost of one point read.
    try {
      const { resource } = await retry(() => container.item(id, pk).read<CatalogRowDoc>());
      rowDeleted = resource !== undefined && resource !== null;
    } catch (err) {
      if ((err as { code?: number })?.code !== 404) throw err;
      rowDeleted = false;
    }
  } else {
    rowDeleted = await deleteTolerant(container, id, pk, retry);
  }
  return {
    action: rowDeleted || gradedChildrenRetired > 0 ? "retire" : "noop",
    id,
    rowDeleted,
    gradedChildrenRetired,
    reason: why,
  };
}
