/**
 * CF-AN-INGEST-TWIN-NEVER-OUTLIVES-ITS-FOLD (2026-09-19). The fold lane
 * deletes an un-numbered twin once its sales re-point onto the checklist's
 * `:num-N` row; this module is what keeps the NEXT sale of that card from
 * deriving the same short slug and re-splitting the pool. Pinned against a
 * fake card_catalog the same query-shape resolveProductByChecklist.test.ts
 * and foldTwinRuleChecklistNumbered.test.ts already use.
 */
import { describe, it, expect } from "vitest";
import {
  resolveChecklistNumberedIngestId,
  newNumberedIngestCache,
  type NumberedIngestUpgradeInput,
} from "../src/services/catalog/resolveChecklistNumberedIngest.js";

interface Row {
  id: string;
  source?: string | null;
  setKey?: string | null;
  parallelSlug?: string | null;
  isAuto?: boolean | null;
  printRun?: number | null;
}

/** A card_catalog stand-in answering the (sport, year, cardNumber, isAuto)
 *  query: every fixture row is a candidate whenever the query supplies at
 *  least one cardNumber variant and an isAuto flag, since these tests are
 *  single-card fixtures -- the real container's WHERE does the real
 *  filtering; this fake just proves the call shape and returns the rows. */
function fakeContainer(rows: Row[]) {
  return {
    items: {
      query(spec: { query: string; parameters: Array<{ name: string; value: unknown }> }) {
        const p = Object.fromEntries(spec.parameters.map((x) => [x.name, x.value]));
        const hasCardNumberParam = spec.parameters.some((x) => x.name.startsWith("@n"));
        const hits = "@a" in p && hasCardNumberParam ? rows : [];
        return { fetchAll: async () => ({ resources: hits }) };
      },
    },
  } as never;
}

const BASE: NumberedIngestUpgradeInput = {
  slug: "hiq:baseball:2026:bowman:cpa-mh:refractor:auto",
  sport: "baseball",
  year: 2026,
  setKey: "bowman",
  cardNumber: "cpa-mh",
  parallelSlug: "refractor",
  isAuto: true,
  printRun: null,
};

const ctx = (rows: Row[]) => ({ container: fakeContainer(rows), cache: newNumberedIngestCache() });

describe("resolveChecklistNumberedIngestId", () => {
  it("un-numbered slug + one checklist-numbered row on the identity -> the numbered id (Harris shape)", async () => {
    const rows: Row[] = [
      { id: "hiq:baseball:2026:bowman:cpa-mh:base-refractor:auto:num-499", source: "checklistcenter-2026-08-30", setKey: "bowman", parallelSlug: "base-refractor", isAuto: true, printRun: 499 },
    ];
    const id = await resolveChecklistNumberedIngestId(BASE, ctx(rows));
    expect(id).toBe("hiq:baseball:2026:bowman:cpa-mh:base-refractor:auto:num-499");
  });

  it("two rival checklist print runs -> unchanged (ambiguous; a ruling, never a guess)", async () => {
    const rows: Row[] = [
      { id: "hiq:baseball:2026:bowman:cpa-mh:refractor:auto:num-499", source: "checklistcenter-2026-08-30", setKey: "bowman", parallelSlug: "refractor", isAuto: true, printRun: 499 },
      { id: "hiq:baseball:2026:bowman:cpa-mh:refractor:auto:num-250", source: "beckett-checklist", setKey: "bowman", parallelSlug: "refractor", isAuto: true, printRun: 250 },
    ];
    const id = await resolveChecklistNumberedIngestId(BASE, ctx(rows));
    expect(id).toBeNull();
  });

  it("title states a print run that disagrees with the checklist -> unchanged (absent beats wrong)", async () => {
    const rows: Row[] = [
      { id: "hiq:baseball:2026:bowman:cpa-mh:refractor:auto:num-499", source: "checklistcenter-2026-08-30", setKey: "bowman", parallelSlug: "refractor", isAuto: true, printRun: 499 },
    ];
    // The title stated /36960 -- computeHobbyIqCardId would have minted that
    // straight onto the slug, so the input the caller hands us already
    // carries the stated run in `slug`, and `printRun` is non-null.
    const titledInput: NumberedIngestUpgradeInput = {
      ...BASE,
      slug: "hiq:baseball:2026:bowman:cpa-mh:refractor:auto:num-36960",
      printRun: 36960,
    };
    const id = await resolveChecklistNumberedIngestId(titledInput, ctx(rows));
    expect(id).toBeNull();
  });

  it("no catalog row at all -> unchanged", async () => {
    const id = await resolveChecklistNumberedIngestId(BASE, ctx([]));
    expect(id).toBeNull();
  });

  it("no checklist-authority row (only vendor/derived twins) -> unchanged", async () => {
    const rows: Row[] = [
      { id: "hiq:baseball:2026:bowman:cpa-mh:refractor:auto:num-499", source: "cardhedge", setKey: "bowman", parallelSlug: "refractor", isAuto: true, printRun: 499 },
      { id: "hiq:baseball:2026:bowman:cpa-mh:refractor:auto:num-250", source: "sold-comps-stub", setKey: "bowman", parallelSlug: "refractor", isAuto: true, printRun: 250 },
    ];
    const id = await resolveChecklistNumberedIngestId(BASE, ctx(rows));
    expect(id).toBeNull();
  });

  it("Pokemon is untouched -- no gate keeps it from running, but it behaves the same narrow way", async () => {
    const pkInput: NumberedIngestUpgradeInput = {
      slug: "hiq:pokemon:2024:sv8a:050:base:no-auto",
      sport: "pokemon",
      year: 2024,
      setKey: "sv8a",
      cardNumber: "050",
      parallelSlug: "base",
      isAuto: false,
      printRun: null,
    };
    // No numbered checklist row for this identity at all -- stays unchanged,
    // same "no-checklist-numbered" outcome any sport gets.
    const id = await resolveChecklistNumberedIngestId(pkInput, ctx([]));
    expect(id).toBeNull();
  });

  it("catalog lookup throws -> unchanged, never propagates (the write must still happen)", async () => {
    const throwingContainer = {
      items: {
        query() {
          return { fetchAll: async () => { throw new Error("cosmos throttled"); } };
        },
      },
    } as never;
    const id = await resolveChecklistNumberedIngestId(BASE, { container: throwingContainer, cache: newNumberedIngestCache() });
    expect(id).toBeNull();
  });

  it("null container (no connection string) -> unchanged", async () => {
    const id = await resolveChecklistNumberedIngestId(BASE, { container: null, cache: newNumberedIngestCache() });
    expect(id).toBeNull();
  });

  it("slug already carries its own :num-N -- never even queries the catalog", async () => {
    let queried = false;
    const container = {
      items: {
        query() {
          queried = true;
          return { fetchAll: async () => ({ resources: [] }) };
        },
      },
    } as never;
    const numberedInput: NumberedIngestUpgradeInput = {
      ...BASE,
      slug: "hiq:baseball:2026:bowman:cpa-mh:refractor:auto:num-499",
      printRun: 499,
    };
    const id = await resolveChecklistNumberedIngestId(numberedInput, { container, cache: newNumberedIngestCache() });
    expect(id).toBeNull();
    expect(queried).toBe(false);
  });

  it("caches by identity key -- a second call for the same card does not re-query", async () => {
    let queries = 0;
    const rows: Row[] = [
      { id: "hiq:baseball:2026:bowman:cpa-mh:base-refractor:auto:num-499", source: "checklistcenter-2026-08-30", setKey: "bowman", parallelSlug: "base-refractor", isAuto: true, printRun: 499 },
    ];
    const container = {
      items: {
        query() {
          queries++;
          return { fetchAll: async () => ({ resources: rows }) };
        },
      },
    } as never;
    const cache = newNumberedIngestCache();
    const first = await resolveChecklistNumberedIngestId(BASE, { container, cache });
    const second = await resolveChecklistNumberedIngestId(BASE, { container, cache });
    expect(first).toBe("hiq:baseball:2026:bowman:cpa-mh:base-refractor:auto:num-499");
    expect(second).toBe(first);
    expect(queries).toBe(1);
  });
});
