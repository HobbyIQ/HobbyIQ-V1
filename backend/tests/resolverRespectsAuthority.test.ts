/**
 * CF-RESOLVER-RESPECTS-AUTHORITY (2026-08-23).
 *
 * resolveSetKeyFromCatalog was written 2026-08-12. CF-CATALOG-AUTHORITY landed
 * 2026-08-20, and the PR that introduced it is titled with the exact failure
 * this guard prevents: "a self-seeded row was outranking a printed checklist"
 * (#1149).
 *
 * In between, the resolver counted every catalog row equally — including the
 * DERIVED class (ingest-auto-seed, sold-comps-stub, catalog-explode), which is
 * built FROM our own comps. Letting those decide closes a loop: a mis-slugged
 * comp seeds a catalog row, and that row then confirms the comp. The resolver
 * has no production callers yet, so the loop never ran — wiring it into ingest
 * without this filter would have run it across 15.5M sales.
 *
 * A row can be worth KEEPING and still not be allowed to DECIDE. Derived rows
 * are still read, because they are what distinguishes "we hold nothing for this
 * card" (acquire) from "we hold only vendor rows for it" (promote) — two gaps
 * that need different work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, ctorMock, seedMock } = vi.hoisted(() => {
  const queryMock = vi.fn();
  const seedMock = vi.fn();
  const containerMock = { items: { query: queryMock } };
  const databaseMock = { container: vi.fn().mockReturnValue(containerMock) };
  const ctorMock = vi.fn(function (this: any) {
    this.database = vi.fn().mockReturnValue(databaseMock);
  });
  return { queryMock, ctorMock, seedMock };
});

vi.mock("@azure/cosmos", () => ({ CosmosClient: ctorMock }));
vi.mock("../src/services/catalog/checklistSeedQueue.service.js", () => ({
  requestChecklistSeed: seedMock,
}));

import {
  resolveSetKeyFromCatalog,
  __resetResolveSetKeyForTests,
} from "../src/services/catalog/resolveSetKey.service";

const CPA = {
  sport: "baseball",
  year: 2025,
  cardNumber: "CPA-JHA",
  playerName: "Jonah Hartshorn",
};

const returns = (rows: Array<Record<string, unknown>>) =>
  queryMock.mockImplementation(() => ({ fetchAll: async () => ({ resources: rows }) }));

beforeEach(() => {
  process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://x/;AccountKey=y;";
  queryMock.mockReset();
  seedMock.mockReset();
  seedMock.mockResolvedValue(true);
  __resetResolveSetKeyForTests();
});
afterEach(() => { delete process.env.COSMOS_CONNECTION_STRING; });

describe("only rows that may adjudicate decide the setKey", () => {
  it("a checklist row decides", async () => {
    returns([{ setKey: "bowman-draft", source: "baseballcardpedia" }]);
    const r = await resolveSetKeyFromCatalog(CPA);
    expect(r.setKey).toBe("bowman-draft");
    expect(r.resolution).toBe("exact");
  });

  it("a DERIVED row never decides, even when it is the only row", async () => {
    // The self-confirming loop: this row was built from our own comps.
    returns([{ setKey: "bowman-chrome", source: "ingest-auto-seed" }]);
    const r = await resolveSetKeyFromCatalog(CPA);
    expect(r.setKey).toBeNull();
    expect(r.resolution).toBe("vendor-only");
  });

  it("a sold-comps stub never decides", async () => {
    returns([{ setKey: "bowman-chrome", source: "sold-comps-stub-2026-08-12" }]);
    expect((await resolveSetKeyFromCatalog(CPA)).setKey).toBeNull();
  });

  it("a VENDOR row never decides — cardhedge classifies product fields wrongly", async () => {
    returns([{ setKey: "bowman-chrome", source: "cardhedge-graded" }]);
    const r = await resolveSetKeyFromCatalog(CPA);
    expect(r.setKey).toBeNull();
    expect(r.resolution).toBe("vendor-only");
  });

  it("a checklist row OUTVOTES a derived row that disagrees", async () => {
    // The #1149 headline, asserted directly.
    returns([
      { setKey: "bowman-chrome", source: "ingest-auto-seed" },
      { setKey: "bowman-chrome", source: "sold-comps-stub-2026-08-12" },
      { setKey: "bowman-draft", source: "beckett-checklist" },
    ]);
    const r = await resolveSetKeyFromCatalog(CPA);
    expect(r.setKey).toBe("bowman-draft");
  });

  it("a derived row cannot become the tiebreak when narrowing by player", async () => {
    // Narrowing is still deciding, so it must run over the adjudicating set.
    returns([
      { setKey: "bowman-draft", playerSlug: "jonah-hartshorn", source: "baseballcardpedia" },
      { setKey: "bowman-chrome", playerSlug: "jonah-hartshorn", source: "ingest-auto-seed" },
    ]);
    const r = await resolveSetKeyFromCatalog(CPA);
    expect(r.setKey).toBe("bowman-draft");
  });
});

describe("vendor-only is not the same gap as catalog-gap", () => {
  it("no rows at all is a catalog-gap — acquire", async () => {
    returns([]);
    const r = await resolveSetKeyFromCatalog(CPA);
    expect(r.resolution).toBe("catalog-gap");
    expect(r.setKey).toBeNull();
  });

  it("rows but none adjudicating is vendor-only — promote", async () => {
    returns([{ setKey: "bowman-chrome", source: "cardhedge" }]);
    const r = await resolveSetKeyFromCatalog(CPA);
    expect(r.resolution).toBe("vendor-only");
  });

  it("vendor-only still reports what IS held, so the gap is actionable", async () => {
    returns([
      { setKey: "bowman-chrome", source: "cardhedge" },
      { setKey: "bowman-chrome", source: "ingest-auto-seed" },
    ]);
    const r = await resolveSetKeyFromCatalog(CPA);
    expect(r.candidates?.[0]?.setKey).toBe("bowman-chrome");
  });

  it("both gap kinds request a checklist seed", async () => {
    returns([]);
    await resolveSetKeyFromCatalog(CPA);
    expect(seedMock).toHaveBeenCalledTimes(1);

    seedMock.mockClear();
    returns([{ setKey: "bowman-chrome", source: "cardhedge" }]);
    await resolveSetKeyFromCatalog(CPA);
    expect(seedMock).toHaveBeenCalledTimes(1);
  });

  it("NEVER invents a setKey — null is the only answer it may give when unsure", async () => {
    returns([{ setKey: "bowman-chrome", source: "ingest-auto-seed" }]);
    const r = await resolveSetKeyFromCatalog(CPA);
    expect(r.setKey).toBeNull();
  });
});

describe("the lookup stays index-usable", () => {
  it("matches card-number casing without wrapping the indexed column in UPPER()", async () => {
    // UPPER(c.cardNumber) = UPPER(@n) cannot use the cardNumber index, which is
    // the likely origin of the ~145k RU/s in this file's header. Case handling
    // moved into the parameter list instead.
    returns([{ setKey: "bowman-draft", source: "baseballcardpedia" }]);
    const r = await resolveSetKeyFromCatalog({ ...CPA, cardNumber: " cpa-jha " });
    expect(r.setKey).toBe("bowman-draft");

    const spec = queryMock.mock.calls[0][0];
    expect(String(spec.query)).not.toMatch(/UPPER\s*\(\s*c\.cardNumber/i);
    expect(String(spec.query)).toMatch(/c\.cardNumber IN \(/);
    const values = (spec.parameters as Array<{ name: string; value: unknown }>)
      .filter((p) => p.name.startsWith("@n")).map((p) => p.value);
    expect(values).toContain("CPA-JHA");
    expect(values).toContain("cpa-jha");
  });
});
