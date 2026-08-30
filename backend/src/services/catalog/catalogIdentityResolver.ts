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
 *   pickCatalogRow(slug, idsUnderStem)      pure — which row an id resolves to
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
 *   none             no row, no twin; or not an hiq id at all (no read).
 *
 * A graded child (`<id>:num-N:psa-9`) is derived from its numbered row and is
 * never a twin (Gillen, 2026-08-30: two graded children made a card look
 * ambiguous). A different parallel under the same card never matches the stem.
 *
 * Fails CLOSED exactly as catalogSlugIfExists always has: no container, a
 * non-404 read error, or a query error → kind "none", id null, logged. A
 * caller adopting or pricing a slug on this answer does neither during an
 * outage, and says so.
 *
 * The conform script keeps a CJS copy of the pure rule (rowFor /
 * numberedTwinsOf — it cannot import this module); tests/
 * conformNeverAdoptsAVendorRow.test.ts pins both against ONE fixture table so
 * the two cannot drift.
 */

import { CosmosClient, type Container } from "@azure/cosmos";

const COSMOS_DATABASE = process.env.COSMOS_DATABASE ?? "hobbyiq";
const CATALOG_CONTAINER = process.env.COSMOS_CARD_CATALOG_CONTAINER ?? "card_catalog";

export type CatalogRowKind = "exact" | "numbered-twin" | "unnumbered-twin" | "ambiguous" | "none";

export interface CatalogRowResolution {
  /** The id the caller asked about, trimmed. */
  requested: string;
  /** The catalog row the identity resolves to; null on "ambiguous" and "none". */
  id: string | null;
  kind: CatalogRowKind;
  /** The `<id>:num-N` rows found under an un-numbered id: the one on
   *  "numbered-twin", all of them (sorted) on "ambiguous", empty otherwise. */
  twins: string[];
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

/**
 * Pure: which catalog row `slug` resolves to, given the ids the catalog holds
 * under its stem (the id itself, its un-numbered form, and anything starting
 * `<id>:num-`). See the kinds above.
 */
export function pickCatalogRow(slug: string, idsUnderStem: readonly string[]): CatalogRowResolution {
  const id = String(slug ?? "").trim();
  if (!isHiqSlug(id)) return none(id);
  if (idsUnderStem.includes(id)) return { requested: id, id, kind: "exact", twins: [] };
  if (isNumberedSlug(id)) {
    const unnumbered = id.replace(NUMBERED_SUFFIX, "");
    return idsUnderStem.includes(unnumbered)
      ? { requested: id, id: unnumbered, kind: "unnumbered-twin", twins: [] }
      : none(id);
  }
  const twins = numberedTwinsOf(id, idsUnderStem);
  if (twins.length === 1) return { requested: id, id: twins[0], kind: "numbered-twin", twins };
  if (twins.length > 1) return { requested: id, id: null, kind: "ambiguous", twins: [...twins].sort() };
  return none(id);
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

/** The stem query: every id under `<id>:num-` (the twins and their graded
 *  children — pickCatalogRow keeps only the twins). `id` is the partition key,
 *  so this is a cross-partition prefix scan on an indexed path; it runs only
 *  on the miss path, for an un-numbered id. */
export const STEM_QUERY = "SELECT VALUE c.id FROM c WHERE STARTSWITH(c.id, @stem)";

function warn(event: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ event, source: "catalogIdentityResolver", ...fields }));
}

/** true = the row exists, false = 404, "error" = anything else (logged). */
async function rowExists(container: Container, id: string): Promise<boolean | "error"> {
  try {
    const { resource } = await container.item(id, id).read();
    return !!resource;
  } catch (err) {
    if ((err as { code?: number })?.code === 404) return false;
    warn("catalog_identity_resolve_error", { step: "point-read", slug: id, error: (err as Error)?.message ?? String(err) });
    return "error";
  }
}

/**
 * Resolve an hiq id to the catalog row that IS its identity. The point read
 * at (id, id) first — the hit path, 1 RU, what catalogSlugIfExists always
 * did; on a 404, the twin lookup in whichever direction the id allows. Fails
 * closed (kind "none") on no container or any non-404 error.
 */
export async function resolveIdentityToCatalogRow(
  slug: string,
  opts: { container?: Container | null } = {},
): Promise<CatalogRowResolution> {
  const id = String(slug ?? "").trim();
  if (!isHiqSlug(id)) return none(id);
  const container = opts.container ?? getContainer();
  if (!container) return none(id);

  const own = await rowExists(container, id);
  if (own === "error") return none(id);
  if (own) return pickCatalogRow(id, [id]);

  if (isNumberedSlug(id)) {
    const unnumbered = id.replace(NUMBERED_SUFFIX, "");
    const twin = await rowExists(container, unnumbered);
    if (twin === "error") return none(id);
    return pickCatalogRow(id, twin ? [unnumbered] : []);
  }

  let ids: string[] = [];
  try {
    const { resources } = await container.items
      .query<string>({ query: STEM_QUERY, parameters: [{ name: "@stem", value: `${id}:num-` }] })
      .fetchAll();
    ids = (resources ?? []).map((x) => String(x));
  } catch (err) {
    warn("catalog_identity_resolve_error", { step: "stem-query", slug: id, error: (err as Error)?.message ?? String(err) });
    return none(id);
  }
  const out = pickCatalogRow(id, ids);
  if (out.kind === "ambiguous") {
    warn("catalog_identity_ambiguous_twins", {
      slug: id,
      twins: out.twins,
      detail: "an un-numbered id with two numbered checklist rows is two cards; no resolution — a ruling, not a guess",
    });
  } else if (out.kind === "numbered-twin") {
    console.log(JSON.stringify({
      event: "catalog_identity_resolved_to_twin",
      source: "catalogIdentityResolver",
      slug: id,
      resolvedTo: out.id,
    }));
  }
  return out;
}
