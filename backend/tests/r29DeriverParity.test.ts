/**
 * RULING R29 PARITY: the .cjs re-derivation path and the TS service path must
 * produce the SAME product for the same title.
 *
 * They are two programs reading one ruling, and the whole value of a
 * checklist-first resolver evaporates if the pool re-derivation disagrees with
 * the ingest that wrote the pool -- that disagreement IS the split-pool defect
 * (CF-ONE-CARD-ONE-ROW-ONE-POOL) wearing a new hat.
 *
 * WHAT IS ACTUALLY PROVEN HERE, and what is not. The .cjs deriver is
 * synchronous and reads pre-resolved answers out of a Map; the service path
 * calls the resolver inline. This test drives BOTH with the same catalog and
 * asserts the derived setKey is identical row by row on the 1,000-row TCA eBay
 * fixture -- so it proves the MAP HANDOFF and the KEY CONVENTION agree, which
 * is exactly the seam where two copies of a rule drift. It does not re-prove
 * the resolver's own decisions; resolveProductByChecklist.test.ts pins those.
 *
 * The catalog is a fake built from real reads (same rows as the resolver's own
 * suite) so the test is deterministic and runs with no Cosmos credential.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  resolveProductByChecklist,
  productResolutionKey,
  newResolveCache,
} from "../src/services/catalog/resolveProductByChecklist.js";
import {
  normalizeSetKey,
  computeHobbyIqCardId,
  applySiblingChecklistOverride,
  slugify,
  stripYearAndSport,
} from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import {
  inferSetKeyFromTitle,
  parseListingIdentity,
  inferSportFromTitle,
  isMultiCardLot,
  isCardNumberAutoSubset,
} from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { extractYearFromTitle } from "../src/services/portfolioiq/slugRederivation.service.js";
import { spellForEra } from "../src/services/catalog/productSetKeys.js";
import { guardSlugInputs, normalizeSportStrict } from "../src/services/portfolioiq/slugGuard.service.js";
import { ingestGradeFromTitle } from "../src/services/portfolioiq/persistVendorSalesToPool.service.js";

const require_ = createRequire(import.meta.url);
const { deriveIdentity } = require_("../scripts/lib/rematch-derive-identity.cjs");

interface Row { year: number; setKey: string; cardNumber: string; playerName: string | null; source: string | null }
const ROWS: Row[] = [
  { year: 2025, setKey: "topps-allen-ginter", cardNumber: "234", playerName: "Alec Bohm", source: "checklistcenter-2026-08-30" },
  { year: 2025, setKey: "topps", cardNumber: "234", playerName: null, source: "bccp" },
  { year: 2024, setKey: "bowmans-best", cardNumber: "B24-GW", playerName: "George Wolkow", source: "checklistcenter-2026-08-29" },
  { year: 2024, setKey: "bowman", cardNumber: "B24-GW", playerName: null, source: "bccp" },
  { year: 2024, setKey: "panini-prizm-wnba", cardNumber: "5", playerName: "Betnijah Laney-Hamilton", source: "checklistinsider-2026-08-27" },
  { year: 2024, setKey: "donruss-optic", cardNumber: "201", playerName: "Precious Achiuwa", source: "checklistinsider-2026-08-27" },
  { year: 2026, setKey: "bowman", cardNumber: "CPA-MG", playerName: "Marconi German", source: "checklistcenter-2026-08-29" },
  { year: 2026, setKey: "bowman-chrome", cardNumber: "CPA-MG", playerName: "Marconi German", source: "checklist" },
  { year: 2026, setKey: "bowman-chrome", cardNumber: "CPA-AC", playerName: "Argenis Cayama", source: "checklistinsider-2026-08-27" },
];

function fakeContainer() {
  return {
    items: {
      query(spec: { query: string; parameters: Array<{ name: string; value: unknown }> }) {
        const p = Object.fromEntries(spec.parameters.map((x) => [x.name, x.value]));
        const byCard = spec.query.includes("c.cardNumber = @n");
        const hits = ROWS.filter((r) => r.year === p["@y"] && r.setKey === p["@s"] && (!byCard || r.cardNumber === p["@n"]));
        return { fetchAll: async () => ({ resources: hits.map((r) => ({ playerName: r.playerName, source: r.source })) }) };
      },
    },
  } as never;
}

/** The service path's product decision, for one title. */
async function serviceSetKey(title: string, cache: ReturnType<typeof newResolveCache>): Promise<string> {
  const parsed = parseListingIdentity(title, undefined, {} as never);
  const year = extractYearFromTitle(title);
  const cardNumber = parsed.cardNumber ?? "";
  const base = applySiblingChecklistOverride(
    spellForEra(normalizeSetKey(inferSetKeyFromTitle(title, cardNumber)), year ?? null),
    cardNumber,
    year ?? 0,
  );
  if (!year || !cardNumber) return base;
  const res = await resolveProductByChecklist(
    { productText: stripYearAndSport(slugify(title)), year, cardNumber, player: null, parsedSetKey: base },
    { container: fakeContainer(), cache },
  );
  return res.setKey || base;
}

describe("R29 parity: the .cjs deriver and the TS service agree", () => {
  it("derives the same product for every row of the 1,000-row TCA eBay fixture", async () => {
    const rows = JSON.parse(readFileSync("tests/fixtures/tcaEbay0910Sample1000.json", "utf8")).data as Array<{ title: string }>;

    // ONE resolution map for the batch -- built exactly as a fleet driver would.
    const cache = newResolveCache();
    const resolvedProducts = new Map<string, string>();
    for (const r of rows) {
      const title = String(r.title ?? "");
      if (!title) continue;
      const parsed = parseListingIdentity(title, undefined, {} as never);
      const year = extractYearFromTitle(title);
      const cardNumber = parsed.cardNumber ?? "";
      if (!year || !cardNumber) continue;
      const base = applySiblingChecklistOverride(
        spellForEra(normalizeSetKey(inferSetKeyFromTitle(title, cardNumber)), year),
        cardNumber,
        year,
      );
      const key = productResolutionKey(year, base, cardNumber);
      if (resolvedProducts.has(key)) continue;
      const res = await resolveProductByChecklist(
        { productText: stripYearAndSport(slugify(title)), year, cardNumber, player: null, parsedSetKey: base },
        { container: fakeContainer(), cache },
      );
      if (res.setKey && res.setKey !== base) resolvedProducts.set(key, res.setKey);
    }

    const deps = {
      parseListingIdentity,
      ingestGradeFromTitle,
      inferSportFromTitle,
      normalizeSportStrict,
      extractYearFromTitle,
      inferSetKeyFromTitle,
      normalizeSetKey,
      computeHobbyIqCardId,
      applySiblingChecklistOverride,
      spellForEra,
      guardSlugInputs,
      isMultiCardLot,
      isCardNumberAutoSubset,
      // The R29 handoff under test.
      resolvedProducts,
      productResolutionKey,
    };

    let compared = 0;
    const disagreements: string[] = [];
    for (const r of rows) {
      const title = String(r.title ?? "");
      if (!title) continue;
      const der = deriveIdentity({ title, sport: null, cardYear: null, playerName: null }, deps);
      if (!der.ok) continue;
      const want = await serviceSetKey(title, cache);
      compared++;
      if (der.identity.setKey !== want) disagreements.push(`${JSON.stringify(title)}  cjs=${der.identity.setKey}  ts=${want}`);
    }

    // A parity test that compared nothing would pass silently -- refuse on zero
    // (CF-HOLDINGS-IS-A-MAP: print the count, refuse on zero).
    expect(compared).toBeGreaterThan(100);
    expect(disagreements.slice(0, 10)).toEqual([]);
  }, 300000);

  it("an absent resolution map leaves the parser's answer standing", () => {
    // ONLY-IMPROVE: with no R29 answers the deriver must behave exactly as it
    // did before this change, so a fleet running without a map is unaffected.
    const deps = {
      parseListingIdentity, ingestGradeFromTitle, inferSportFromTitle, normalizeSportStrict,
      extractYearFromTitle, inferSetKeyFromTitle, normalizeSetKey, computeHobbyIqCardId,
      applySiblingChecklistOverride, spellForEra, guardSlugInputs, isMultiCardLot, isCardNumberAutoSubset,
    };
    const title = "2024 Topps Chrome Update Baseball #USC23 Refractor";
    const der = deriveIdentity({ title, sport: null, cardYear: null, playerName: null }, deps);
    expect(der.ok).toBe(true);
    expect(der.identity.setKey).toBe("topps-chrome-update-series");
  });
});
