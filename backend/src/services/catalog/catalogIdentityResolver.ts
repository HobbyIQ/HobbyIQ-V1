/**
 * CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30, holding deced7d3 — Max
 * Williams 2025 Bowman Draft #CPA-MWI Refractor auto, raw).
 *
 * The holding carried hobbyiqCardId hiq:baseball:2025:bowman-draft:cpa-mwi:
 * refractor:auto — un-numbered. The catalog's ONLY Refractor row for that card
 * is …:refractor:auto:num-499 (checklistcenter, /499): the un-numbered row had
 * been folded into it by the cross-source fold, and the fold does not touch
 * holdings. The pool held 35 sales under …:num-499 and 0 under the un-numbered
 * id. The card page showed NO comps: every reader keyed on the holding's id —
 * catalogSlugIfExists (a point read), readCompsByCardId (an equality match),
 * and through them price-by-id, card-detail, recent-sales, listing-range —
 * answered "no row / no comps" for an id whose one checklist row sat a
 * suffix away.
 *
 * The rule "an un-numbered id IS its single numbered twin" existed in two
 * places, neither on a route: exactPoolSupremacy's count query (STARTSWITH)
 * and conform-holdings-to-catalog's rowFor. And catalogSlugIfExists knew only
 * the OTHER direction (a numbered id whose un-numbered row exists, #1509),
 * because a point read cannot enumerate `<id>:num-N`.
 *
 * This module is the ONE home of the rule, for readers and writers alike:
 *
 *   pickCatalogRow(slug, rowsUnderStem)     pure — which row an id resolves to
 *   poolReadIdsFor(id, resolution)          pure — which pool ids a READER
 *                                            unions (the id and its one twin)
 *   resolveIdentityToCatalogRow(slug)       the Cosmos wrapper — point read
 *                                            first (1 RU, the hit path), the
 *                                            twin lookups only on the miss
 *
 * Kinds:
 *   exact            the catalog holds the id itself (wins even when a
 *                    numbered twin also exists — conform's rowFor agrees);
 *   numbered-twin    an UN-numbered id with no row and exactly ONE
 *                    `<id>:num-N` row — that row is the card;
 *   unnumbered-twin  a NUMBERED id with no row whose un-numbered form is a
 *                    row (a title regex added a print run the checklist does
 *                    not carry — the #1509 direction, preserved);
 *   ambiguous        an un-numbered id with TWO OR MORE numbered twins
 *                    (…:num-499 and …:num-250 are two cards) — id null, the
 *                    twins listed: a ruling, never a guess;
 *   none             no row, no twin; or not an hiq id at all (no read);
 *   unresolved       the catalog could not be asked (a non-404 read error, a
 *                    throttle, a query failure) — id null, logged. NOT the
 *                    same as none: a reader falls back to the id as given
 *                    (fail OPEN); a writer still declines to adopt (see
 *                    catalogSlugIfExists).
 *
 * A graded child (`<id>:num-N:psa-9`) is derived from its numbered row and is
 * never a twin (Gillen, 2026-08-30: two graded children made a card look
 * ambiguous). A different parallel under the same card never matches the stem.
 *
 * ── THE POOL IS NOT RE-KEYED YET: readers union the id AND its twin ─────────
 *
 * The fold re-keyed CATALOG rows, not sold_comps. Measured read-only on
 * 2026-08-30: 16/400, 47/200 and 49/200 numbered-twin stems in three product
 * slices still carry pool rows under the UN-numbered id, mostly with 0 under
 * the twin (…:cpa-sha:green:auto 14 vs 0, …:bdc-145:chrome-black-refractor
 * 4 vs 0, …:cpa-bm:red-refractor:auto 8 vs 0, …:56:wave-refractor 7 vs 1).
 * A reader that SWAPS the id for its twin reads 0 on every one of those.
 * So on "numbered-twin" — ONE card, exactly one twin by this module's own
 * definition — every reader reads the id AND its twin (poolReadIdsFor):
 * recent-sales / price-history / listing-range (soldCompsStore), the
 * valuation entry and priceHoldingFromExactPool (exactPoolReader) all read
 * the same union, so an FMV never cites compsUsed N with 0 comps listed. Two
 * numbered twins stay a refusal. The PERMANENT fix is the D29 fleet
 * re-keying the pool's un-numbered rows to their twin; once it has run the
 * union degenerates to the twin alone and nothing here needs to change.
 *
 * ── COST (measured read-only against prod, 2026-08-30) ──────────────────────
 *
 * card_catalog is partitioned on /cardId across 40 physical partitions, so
 * ANY cross-partition query pays the per-partition floor: 40 × ~2.8 RU =
 * 112 RU, whatever the predicate. The branch's plain
 * `SELECT VALUE c.id … STARTSWITH(c.id, @stem)` cost 112 RU and 1.7–2.4 s
 * (the JS SDK walks the partitions one page at a time for a plain query;
 * maxDegreeOfParallelism did not change it). The alternatives measured:
 *   - equality on indexed fields (sport, year, setKey, cardNumber, isAuto):
 *     184–274 RU, 1.6–2.7 s — MORE rows (every graded child), same fan-out;
 *   - the same + parallelSlug: 128–158 RU, 1.7–2.7 s — and WRONG: the
 *     …:cpa-bm:red-refractor:auto twin carries setKey "bowman" while its id
 *     says bowman-chrome, so field equality missed it (the id is what we
 *     resolve; rows disagree with their own fields — CF-CANDIDATE-ID-IS-
 *     WHAT-WE-ADOPT);
 *   - DISTINCT product-parallel printRun (a candidate set): 195–318 RU;
 *   - a point read: 1 RU, 40–60 ms, and a 404 costs the same.
 * The cheapest correct shape is therefore:
 *   1. the caller's own print run, when it has one, names the ONE candidate
 *      `<id>:num-N`: a point read (1 RU) settles it without any query;
 *   2. otherwise the stem query in DISTINCT form — same 112 RU, but the SDK
 *      runs DISTINCT through its parallel pipeline: 150–340 ms instead of
 *      1.7–2.4 s — filtered server-side to the twins (no graded children);
 *   3. memoized per stem (TTL 10 min, bounded), with in-flight de-duplication,
 *      so a card page's 4–5 concurrent reads and a reprice run's holdings
 *      pay the 112 RU once, not per read.
 *
 * The conform script keeps a CJS copy of the pure rule (rowFor /
 * numberedTwinsOf — it cannot import this module); tests/
 * conformNeverAdoptsAVendorRow.test.ts pins both against ONE fixture table so
 * the two cannot drift.
 */

import { CosmosClient, type Container } from "@azure/cosmos";
import { canAdjudicate } from "./catalogAuthority.service.js";

const COSMOS_DATABASE = process.env.COSMOS_DATABASE ?? "hobbyiq";
const CATALOG_CONTAINER = process.env.COSMOS_CARD_CATALOG_CONTAINER ?? "card_catalog";

export type CatalogRowKind = "exact" | "numbered-twin" | "unnumbered-twin" | "ambiguous" | "none" | "unresolved";

/** A catalog row under a stem, as the stem query returns it. */
export interface CatalogStemRow {
  id: string;
  source?: string | null;
}

export interface CatalogRowResolution {
  /** The id the caller asked about, trimmed. */
  requested: string;
  /** The catalog row the identity resolves to; null on "ambiguous", "none" and "unresolved". */
  id: string | null;
  kind: CatalogRowKind;
  /** The `<id>:num-N` rows found under an un-numbered id: the one on
   *  "numbered-twin" (all of them, sorted, when authority chose among
   *  several), all of them (sorted) on "ambiguous", empty otherwise. */
  twins: string[];
  /** "numbered-twin" only, and only when the twin was not simply the one row
   *  under the stem: "authority" — the stem held several and exactly one is
   *  checklist-authority; "print-run" — the caller's print run named it. */
  chosenBy?: "authority" | "print-run";
  /** "unresolved" only: what the catalog read failed with. */
  error?: string;
}

/** The numbered suffix of a canonical slug: `:num-499`. */
export const NUMBERED_SUFFIX = /:num-\d+$/;

export function isHiqSlug(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("hiq:") && v.trim().length > 4;
}

export function isNumberedSlug(id: string): boolean {
  return NUMBERED_SUFFIX.test(id);
}

/**
 * The numbered twins of an un-numbered id among `ids`: exactly `<id>:num-N`.
 * A graded child (`<id>:num-N:psa-9`) is derived, never a twin. Mirrors
 * scripts/conform-holdings-to-catalog.cjs numberedTwinsOf.
 */
export function numberedTwinsOf(id: string, ids: readonly string[]): string[] {
  const prefix = `${id}:num-`;
  return ids.filter((x) => x.startsWith(prefix) && /^\d+$/.test(x.slice(prefix.length)));
}

function none(requested: string): CatalogRowResolution {
  return { requested, id: null, kind: "none", twins: [] };
}

function unresolved(requested: string, error: string): CatalogRowResolution {
  return { requested, id: null, kind: "unresolved", twins: [], error };
}

function toRow(x: string | CatalogStemRow): CatalogStemRow {
  return typeof x === "string" ? { id: x, source: null } : { id: String(x?.id ?? ""), source: x?.source ?? null };
}

/**
 * Pure: which catalog row `slug` resolves to, given the rows the catalog holds
 * under its stem (the id itself, its un-numbered form, and anything starting
 * `<id>:num-`). Rows may be bare ids (the conform script's table) or
 * `{ id, source }` (the stem query). See the kinds above.
 *
 * Several twins (the secondary refutation, 2026-08-30): the row that names a
 * card must be checklist-authority (catalogAuthority.canAdjudicate). When the
 * stem holds more than one `<id>:num-N` row and exactly ONE of them is
 * checklist-authority, that one is the card (a vendor or derived row spelled
 * a print run the checklist does not carry); when two checklist authorities
 * disagree on the print run, or none is an authority, it stays a refusal.
 */
export function pickCatalogRow(slug: string, rowsUnderStem: readonly (string | CatalogStemRow)[]): CatalogRowResolution {
  const id = String(slug ?? "").trim();
  if (!isHiqSlug(id)) return none(id);
  const rows = rowsUnderStem.map(toRow).filter((r) => r.id);
  const ids = rows.map((r) => r.id);
  if (ids.includes(id)) return { requested: id, id, kind: "exact", twins: [] };
  if (isNumberedSlug(id)) {
    const unnumbered = id.replace(NUMBERED_SUFFIX, "");
    return ids.includes(unnumbered)
      ? { requested: id, id: unnumbered, kind: "unnumbered-twin", twins: [] }
      : none(id);
  }
  const twins = numberedTwinsOf(id, ids);
  if (twins.length === 1) return { requested: id, id: twins[0], kind: "numbered-twin", twins };
  if (twins.length > 1) {
    const sorted = [...twins].sort();
    const sourceOf = (t: string) => rows.find((r) => r.id === t)?.source ?? null;
    const authority = sorted.filter((t) => canAdjudicate(sourceOf(t)));
    if (authority.length === 1) return { requested: id, id: authority[0], kind: "numbered-twin", twins: sorted, chosenBy: "authority" };
    return { requested: id, id: null, kind: "ambiguous", twins: sorted };
  }
  return none(id);
}

/**
 * Pure: the pool ids a READER queries for `cardId`, given its resolution.
 * On "numbered-twin" the id AND its one twin — the same card, its pool split
 * across two keys until the D29 fleet re-keys it (see the header). Every
 * other kind reads the id as given: "exact" is its own row; "unnumbered-twin"
 * keeps the number the seller wrote and the valuation path reaches the
 * un-numbered row's pool through exactPoolSupremacy's twin attempt;
 * "ambiguous" is a refusal (two cards are never merged); "none" and
 * "unresolved" have nothing to add. Never a STARTSWITH union.
 */
export function poolReadIdsFor(cardId: string, resolution: CatalogRowResolution | null | undefined): string[] {
  const id = String(cardId ?? "").trim();
  if (resolution && resolution.kind === "numbered-twin" && resolution.id && resolution.id !== id) return [id, resolution.id];
  return [id];
}

let _container: Container | null = null;

function getContainer(): Container | null {
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

export function _setContainerForTests(container: Container | null): void {
  _container = container;
}

/**
 * The stem query: the `<id>:num-N` twins under an un-numbered id, with their
 * source (authority). DISTINCT is not for de-duplication — ids are unique —
 * it is what makes the JS SDK fan the 40 partitions out in parallel
 * (measured: 150–340 ms vs 1.7–2.4 s for the plain form, same 112 RU). The
 * SUBSTRING filter drops the graded children server-side (`…:num-N:psa-9`
 * has a ':' after the stem; a twin does not); pickCatalogRow re-checks the
 * digits. Runs only on the miss path, for an un-numbered id, once per stem
 * per memo TTL.
 */
export const STEM_QUERY =
  "SELECT DISTINCT c.id, c.source FROM c WHERE STARTSWITH(c.id, @stem) AND NOT CONTAINS(SUBSTRING(c.id, LENGTH(@stem), 64), ':')";

/** Memo: one stem lookup per un-numbered stem per TTL, bounded. */
export const IDENTITY_MEMO_TTL_MS = 10 * 60_000;
export const IDENTITY_MEMO_MAX_ENTRIES = 5000;

const memo = new Map<string, { value: CatalogRowResolution; expiresAt: number }>();
const inflight = new Map<string, Promise<CatalogRowResolution>>();

function cloneResolution(r: CatalogRowResolution): CatalogRowResolution {
  return { ...r, twins: [...r.twins] };
}

function memoGet(stem: string, now: number): CatalogRowResolution | null {
  const e = memo.get(stem);
  if (!e) return null;
  if (e.expiresAt <= now) {
    memo.delete(stem);
    return null;
  }
  return cloneResolution(e.value);
}

function memoSet(stem: string, value: CatalogRowResolution, now: number): void {
  if (memo.has(stem)) memo.delete(stem);
  while (memo.size >= IDENTITY_MEMO_MAX_ENTRIES) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
  memo.set(stem, { value: cloneResolution(value), expiresAt: now + IDENTITY_MEMO_TTL_MS });
}

export function _clearIdentityMemoForTests(): void {
  memo.clear();
  inflight.clear();
}

export function _identityMemoSizeForTests(): number {
  return memo.size;
}

function warn(event: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ event, source: "catalogIdentityResolver", ...fields }));
}

function info(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, source: "catalogIdentityResolver", ...fields }));
}

function positiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** true = the row exists, false = 404, { error } = anything else (logged). */
async function rowExists(container: Container, id: string): Promise<boolean | { error: string }> {
  try {
    const { resource } = await container.item(id, id).read();
    return !!resource;
  } catch (err) {
    if ((err as { code?: number })?.code === 404) return false;
    const error = (err as Error)?.message ?? String(err);
    warn("catalog_identity_resolve_error", { step: "point-read", slug: id, error, failOpen: true });
    return { error };
  }
}

/** The stem lookup proper: one query, the pure rule over its rows, the memo. */
async function lookupStem(container: Container, id: string, now: number): Promise<CatalogRowResolution> {
  const t0 = Date.now();
  let rows: CatalogStemRow[] = [];
  let ru: number | null = null;
  try {
    const res = await container.items
      .query<CatalogStemRow | string>({ query: STEM_QUERY, parameters: [{ name: "@stem", value: `${id}:num-` }] })
      .fetchAll();
    rows = (res.resources ?? []).map(toRow);
    ru = typeof res.requestCharge === "number" ? Math.round(res.requestCharge * 100) / 100 : null;
  } catch (err) {
    const error = (err as Error)?.message ?? String(err);
    warn("catalog_identity_resolve_error", { step: "stem-query", slug: id, error, failOpen: true });
    return unresolved(id, error);
  }
  const out = pickCatalogRow(id, rows);
  memoSet(id, out, now);
  info("catalog_identity_stem_lookup", { slug: id, kind: out.kind, twins: out.twins, ru, ms: Date.now() - t0 });
  if (out.kind === "ambiguous") {
    warn("catalog_identity_ambiguous_twins", {
      slug: id,
      twins: out.twins,
      detail: "an un-numbered id with two numbered checklist rows is two cards; no resolution — a ruling, not a guess",
    });
  } else if (out.kind === "numbered-twin") {
    info("catalog_identity_resolved_to_twin", { slug: id, resolvedTo: out.id, chosenBy: out.chosenBy ?? "only" });
  }
  return out;
}

/**
 * Resolve an hiq id to the catalog row that IS its identity. The point read
 * at (id, id) first — the hit path, 1 RU, what catalogSlugIfExists always
 * did; on a 404, the twin lookup in whichever direction the id allows. For an
 * un-numbered id: the caller's print run (when it has one) names the one
 * candidate and a point read settles it; else the memo; else ONE stem query,
 * shared by concurrent callers and memoized by stem.
 *
 * Fails CLOSED on no container (kind "none" — nothing was asked), and OPEN
 * on any non-404 error (kind "unresolved", id null, logged): a reader then
 * reads the id as given, never "identity-not-in-catalog" for an id that may
 * well have a row.
 */
export async function resolveIdentityToCatalogRow(
  slug: string,
  opts: { container?: Container | null; printRun?: number | string | null } = {},
): Promise<CatalogRowResolution> {
  const id = String(slug ?? "").trim();
  if (!isHiqSlug(id)) return none(id);
  const container = opts.container ?? getContainer();
  if (!container) return none(id);

  const own = await rowExists(container, id);
  if (typeof own === "object") return unresolved(id, own.error);
  if (own) return pickCatalogRow(id, [id]);

  if (isNumberedSlug(id)) {
    const unnumbered = id.replace(NUMBERED_SUFFIX, "");
    const twin = await rowExists(container, unnumbered);
    if (typeof twin === "object") return unresolved(id, twin.error);
    return pickCatalogRow(id, twin ? [unnumbered] : []);
  }

  const now = Date.now();
  const printRun = positiveInt(opts.printRun);
  const memoized = memoGet(id, now);
  // The memo answers unless it is a refusal the caller's print run can settle.
  if (memoized && !(memoized.kind === "ambiguous" && printRun !== null)) return memoized;

  if (printRun !== null) {
    const candidate = `${id}:num-${printRun}`;
    const hit = await rowExists(container, candidate);
    if (typeof hit === "object") return unresolved(id, hit.error);
    if (hit) {
      info("catalog_identity_resolved_to_twin", { slug: id, resolvedTo: candidate, chosenBy: "print-run" });
      return { requested: id, id: candidate, kind: "numbered-twin", twins: [candidate], chosenBy: "print-run" };
    }
  }
  if (memoized) return memoized;

  let p = inflight.get(id);
  if (!p) {
    p = lookupStem(container, id, now).finally(() => { inflight.delete(id); });
    inflight.set(id, p);
  }
  return cloneResolution(await p);
}
