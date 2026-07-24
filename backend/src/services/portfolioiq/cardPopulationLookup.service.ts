// CF-CARD-POPULATION-LOOKUP (Drew, 2026-07-24). Reads card_population
// container for the resolved identity of a hobbyiqCardId slug and
// returns a compact per-grader breakdown. Two-step lookup:
//   1. card_catalog match by (sport, year, cardNumber) → CS card UUID
//   2. card_population by (cardId=UUID, level=card) → per-grader rows
//
// Fall-through: if no card-level rows exist yet (card_population still
// being seeded by the bulk crawler), returns null. The caller (FMV
// endpoint) treats null as "population data not available yet" and iOS
// hides the scarcity badge — no fabrication.
//
// Zero-vendor-calls guarantee: reads OUR containers only. Never touches
// Cardsight. Cheap enough to call synchronously from the FMV endpoint.

import { CosmosClient, type Container } from "@azure/cosmos";
import { parseHobbyIqCardId } from "./hobbyIqCardId.service.js";

export interface PopulationGrade {
  gradeName: string;           // "10", "9.5", etc.
  population: number;
}

export interface PopulationCompany {
  name: string;                // "PSA", "BGS", "SGC", "CGC"
  totalPopulation: number;
  lastSyncedAt: string | null;
  grades: PopulationGrade[];
}

export interface CardPopulationLookup {
  csCardId: string;
  level: "card";
  companies: PopulationCompany[];
}

let cachedCatalog: Container | null = null;
let cachedPop: Container | null = null;

async function containers(): Promise<{ catalog: Container; pop: Container } | null> {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    if (!cachedCatalog || !cachedPop) {
      const client = new CosmosClient(conn);
      const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
      cachedCatalog = db.container("card_catalog");
      cachedPop = db.container("card_population");
    }
    return { catalog: cachedCatalog, pop: cachedPop };
  } catch {
    return null;
  }
}

/** Resolve a hobbyiqCardId slug to a Cardsight UUID by matching against
 *  card_catalog on (sport, year, cardNumber). Returns null when no match
 *  — either the card isn't in CS's catalog OR our card_catalog fill hasn't
 *  reached it yet. */
async function resolveCsCardId(slug: string): Promise<string | null> {
  const parsed = parseHobbyIqCardId(slug);
  if (!parsed) return null;
  const c = await containers();
  if (!c) return null;
  try {
    const { resources } = await c.catalog.items.query({
      query: "SELECT TOP 1 c.cardId FROM c WHERE c.source = 'cardsight' AND c.sport = @sp AND c.year = @y AND UPPER(c.number) = @cn",
      parameters: [
        { name: "@sp", value: parsed.sport },
        { name: "@y", value: String(parsed.year) },
        { name: "@cn", value: (parsed.cardNumber ?? "").toUpperCase() },
      ],
    }).fetchAll();
    return resources[0]?.cardId ?? null;
  } catch { return null; }
}

/** Load population data (per-grader breakdown) for a hobbyiqCardId slug.
 *  Returns null when nothing landed yet. Never throws. */
export async function loadPopulationForSlug(slug: string): Promise<CardPopulationLookup | null> {
  const csId = await resolveCsCardId(slug);
  if (!csId) return null;
  const c = await containers();
  if (!c) return null;
  try {
    const { resources } = await c.pop.items.query({
      query: "SELECT c.gradingCompanyName, c.totalPopulation, c.lastSyncedAt, c.gradingTypes FROM c WHERE c.cardId = @cid AND c.level = 'card'",
      parameters: [{ name: "@cid", value: csId }],
    }).fetchAll();
    if (!resources || resources.length === 0) return null;
    const companies: PopulationCompany[] = resources.map((r) => {
      const grades: PopulationGrade[] = [];
      for (const gt of (r.gradingTypes || [])) {
        for (const g of (gt?.grades || [])) {
          const pop = Number(g?.population ?? 0) + Number(g?.qualified_population ?? 0);
          if (pop > 0) grades.push({ gradeName: String(g?.name ?? g?.value ?? "?"), population: pop });
        }
      }
      grades.sort((a, b) => b.population - a.population);
      return {
        name: String(r.gradingCompanyName ?? "?"),
        totalPopulation: Number(r.totalPopulation ?? 0),
        lastSyncedAt: r.lastSyncedAt ?? null,
        grades: grades.slice(0, 12),
      };
    });
    companies.sort((a, b) => b.totalPopulation - a.totalPopulation);
    return { csCardId: csId, level: "card", companies };
  } catch { return null; }
}
