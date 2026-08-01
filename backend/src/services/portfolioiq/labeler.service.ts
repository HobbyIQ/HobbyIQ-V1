// CF-LABELER (Drew, 2026-07-31). Human-in-the-loop variant labeling.
// CH's card_catalog holds one row per physical variant (Base / Refractor /
// Green / Blue / etc.) each with an imageUrl. Our sold_comps rows don't
// carry a variant pointer — they only have a title + our best-guess
// parallel. This service surfaces variants to Drew with images, lets
// him input the canonical HobbyIQ parallel name + print run, then
// reclassifies matching sold_comps rows by title-suffix match.
//
// Label storage: written back onto the card_catalog row itself under
// canonicalLabel + labeledAt + labeledBy. No new container.

import { CosmosClient, type Container } from "@azure/cosmos";
import { computeHobbyIqCardId, normalizeSetKey } from "./hobbyIqCardId.service.js";

interface CanonicalLabel {
  parallel: string;
  isRefractor: boolean;
  printRun: number | null;
  setSlug: string;
  labeledBy: string;
  labeledAt: string;
}

export interface VariantView {
  cardCatalogId: string;
  chCardId: string;
  chVariant: string;
  set: string;
  imageUrl: string | null;
  matchedSoldCompsCount: number;
  currentLabel: CanonicalLabel | null;
}

export interface VariantsResponse {
  cardNumber: string;
  cardYear: number | null;
  player: string;
  variants: VariantView[];
  unmatchedSoldCompsCount: number;
}

let cachedCatalog: Container | null = null;
let cachedSoldComps: Container | null = null;
function db(name: string): Container | null {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  const client = new CosmosClient(conn);
  return client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container(name);
}
function getCatalog(): Container | null {
  if (!cachedCatalog) cachedCatalog = db("card_catalog");
  return cachedCatalog;
}
function getSoldComps(): Container | null {
  if (!cachedSoldComps) cachedSoldComps = db("sold_comps");
  return cachedSoldComps;
}

/** Load all CH card_catalog variants for a card + count matching sold_comps. */
export async function listVariantsForCard(cardNumber: string, cardYear: number | null): Promise<VariantsResponse | null> {
  const catalog = getCatalog();
  const sc = getSoldComps();
  if (!catalog || !sc) return null;

  const cnUpper = cardNumber.trim().toUpperCase();
  const { resources: catalogRows } = await catalog.items.query({
    query: `SELECT * FROM c WHERE c.source = 'cardhedge'
              AND (UPPER(c.number ?? '') = @cn OR UPPER(c.cardNumber ?? '') = @cn)`,
    parameters: [{ name: "@cn", value: cnUpper }],
  }).fetchAll();

  const filtered = cardYear
    ? catalogRows.filter(r => {
        const setYearMatch = typeof r.set === "string" && r.set.includes(String(cardYear));
        return r.year === cardYear || r.year === String(cardYear) || setYearMatch;
      })
    : catalogRows;

  const player = filtered[0]?.player ?? catalogRows[0]?.player ?? "";

  const scByTitleSuffix = new Map<string, number>();
  const { resources: scRows } = await sc.items.query({
    query: `SELECT c.title, c.hobbyiqCardId FROM c
              WHERE UPPER(c.cardNumber) = @cn ${cardYear ? "AND c.cardYear = @yr" : ""}`,
    parameters: cardYear
      ? [{ name: "@cn", value: cnUpper }, { name: "@yr", value: cardYear }]
      : [{ name: "@cn", value: cnUpper }],
  }).fetchAll();

  const totalRows = scRows.length;
  let matchedTotal = 0;
  const variants: VariantView[] = filtered.map((r) => {
    const chVariant = String(r.variant ?? "").trim();
    const suffix = ` #${cnUpper} ${chVariant}`.toUpperCase();
    let count = 0;
    for (const row of scRows) {
      const t = (row.title ?? "").toUpperCase();
      if (t.endsWith(suffix)) count += 1;
    }
    scByTitleSuffix.set(chVariant, count);
    matchedTotal += count;
    const currentLabel: CanonicalLabel | null = r.canonicalLabel ?? null;
    return {
      cardCatalogId: r.id,
      chCardId: r.cardId,
      chVariant,
      set: r.set,
      imageUrl: r.imageUrl ?? null,
      matchedSoldCompsCount: count,
      currentLabel,
    };
  });

  return {
    cardNumber: cnUpper,
    cardYear,
    player,
    variants,
    unmatchedSoldCompsCount: totalRows - matchedTotal,
  };
}

export interface SaveLabelInput {
  cardCatalogId: string;
  cardNumber: string;
  cardYear: number;
  set: string;
  chVariant: string;
  canonicalParallel: string;
  isRefractor: boolean;
  printRun: number | null;
  labeledBy: string;
  applyToSoldComps: boolean;
  sport?: string;
}

export interface SaveLabelResult {
  cardCatalogUpdated: boolean;
  soldCompsRewritten: number;
  newSlugSample: string;
}

/** Save a canonical label onto the card_catalog row and optionally
 *  rewrite matching sold_comps rows to the new parallel + slug. */
export async function saveVariantLabel(input: SaveLabelInput): Promise<SaveLabelResult> {
  const catalog = getCatalog();
  const sc = getSoldComps();
  if (!catalog || !sc) throw new Error("Cosmos not configured");

  const sport = input.sport ?? "baseball";
  const setSlug = normalizeSetKey(input.set);
  const newSlug = computeHobbyIqCardId({
    sport,
    year: input.cardYear,
    setKey: setSlug,
    cardNumber: input.cardNumber,
    parallel: input.canonicalParallel,
    isAuto: /auto|autograph|CPA|BCPA|BDPA|BCDA|BCRA|TCRA|FCA|CDA/i.test(input.set + " " + input.chVariant + " " + input.canonicalParallel + " " + input.cardNumber),
    printRun: input.printRun,
  });

  // card_catalog partition key = /cardId. Read requires the PK value,
  // which we don't have from just the doc id — query by id to fetch it.
  const { resources: found } = await catalog.items.query({
    query: "SELECT * FROM c WHERE c.id = @id",
    parameters: [{ name: "@id", value: input.cardCatalogId }],
  }).fetchAll();
  const catalogDoc = found[0];
  if (!catalogDoc) throw new Error(`card_catalog row ${input.cardCatalogId} not found`);

  const label: CanonicalLabel = {
    parallel: input.canonicalParallel,
    isRefractor: input.isRefractor,
    printRun: input.printRun,
    setSlug,
    labeledBy: input.labeledBy,
    labeledAt: new Date().toISOString(),
  };
  catalogDoc.canonicalLabel = label;
  await catalog.items.upsert(catalogDoc);

  let rewritten = 0;
  if (input.applyToSoldComps) {
    const cnUpper = input.cardNumber.trim().toUpperCase();
    const suffix = ` #${cnUpper} ${input.chVariant}`.toUpperCase();
    const { resources: rows } = await sc.items.query({
      query: `SELECT * FROM c WHERE UPPER(c.cardNumber) = @cn AND c.cardYear = @yr AND ENDSWITH(UPPER(c.title), @sfx)`,
      parameters: [
        { name: "@cn", value: cnUpper },
        { name: "@yr", value: input.cardYear },
        { name: "@sfx", value: suffix },
      ],
    }).fetchAll();

    for (const row of rows) {
      row.parallel = input.canonicalParallel;
      row.hobbyiqCardId = newSlug;
      row.__labeledByAdmin = { at: label.labeledAt, by: label.labeledBy, chVariant: input.chVariant };
      try {
        await sc.items.upsert(row);
        rewritten += 1;
      } catch {
        /* skip individual errors — surface aggregate count */
      }
    }
  }

  return {
    cardCatalogUpdated: true,
    soldCompsRewritten: rewritten,
    newSlugSample: newSlug,
  };
}
