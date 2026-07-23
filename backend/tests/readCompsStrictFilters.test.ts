// CF-USER-COMPS-AUTO-FILTER + CF-USER-COMPS-PRINTRUN-FILTER pinning
// tests (Drew, 2026-07-23). Pin the strict-equality semantics so future
// edits don't accidentally re-introduce cross-auto / cross-printRun
// pool pollution. Cosmos is stubbed via _setContainerForTests.

import { describe, it, expect, beforeEach } from "vitest";
import type { Container } from "@azure/cosmos";
import {
  readCompsByCardId,
  readCompsByIdentity,
  _setContainerForTests,
} from "../src/services/portfolioiq/soldCompsStore.service.js";

// Fixture: three rows sharing one cardId, mixing auto/non-auto + print runs.
// Mirrors Owen Carey Blue Refractor scenario:
//   - 2 non-auto rookie rows @ $2 each (base rookie)
//   - 1 auto row @ $180 (his actual card)
const OWEN_CAREY_ROWS = [
  { cardId: "ch-abc", isAuto: false, printRun: null, price: 2.0, parallel: "Blue Refractor", soldAt: "2026-07-01T00:00:00Z" },
  { cardId: "ch-abc", isAuto: false, printRun: null, price: 2.5, parallel: "Blue Refractor", soldAt: "2026-07-05T00:00:00Z" },
  { cardId: "ch-abc", isAuto: true, printRun: 150, price: 180.0, parallel: "Blue Refractor", soldAt: "2026-07-10T00:00:00Z" },
];

// Fixture: Antunez Orange Shimmer with mixed print runs (/25 vs /99).
const ANTUNEZ_ROWS = [
  { cardId: "ch-xyz", isAuto: true, printRun: 99, price: 45.0, parallel: "Orange Shimmer Refractor", soldAt: "2026-07-01T00:00:00Z" },
  { cardId: "ch-xyz", isAuto: true, printRun: 25, price: 300.0, parallel: "Orange Shimmer Refractor", soldAt: "2026-07-05T00:00:00Z" },
  { cardId: "ch-xyz", isAuto: true, printRun: 25, price: 350.0, parallel: "Orange Shimmer Refractor", soldAt: "2026-07-10T00:00:00Z" },
];

function makeStubContainer(rows: unknown[]): Container {
  return {
    items: {
      query: () => ({
        fetchAll: async () => ({ resources: rows }),
      }),
    },
  } as unknown as Container;
}

describe("readCompsByCardId — strict isAuto filter", () => {
  beforeEach(() => _setContainerForTests(makeStubContainer(OWEN_CAREY_ROWS)));

  it("isAuto: true → only the auto row (not the 2 non-auto rookies)", async () => {
    const rows = await readCompsByCardId({ cardId: "ch-abc", isAuto: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(180);
  });

  it("isAuto: false → only the non-auto rookies", async () => {
    const rows = await readCompsByCardId({ cardId: "ch-abc", isAuto: false });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.price).sort()).toEqual([2.0, 2.5]);
  });

  it("isAuto undefined → no filter (legacy behavior, returns all)", async () => {
    const rows = await readCompsByCardId({ cardId: "ch-abc" });
    expect(rows).toHaveLength(3);
  });
});

describe("readCompsByCardId — strict printRun filter", () => {
  beforeEach(() => _setContainerForTests(makeStubContainer(ANTUNEZ_ROWS)));

  it("printRun: 25 → only /25 rows (2)", async () => {
    const rows = await readCompsByCardId({ cardId: "ch-xyz", printRun: 25 });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.printRun === 25)).toBe(true);
  });

  it("printRun: 99 → only the single /99 row", async () => {
    const rows = await readCompsByCardId({ cardId: "ch-xyz", printRun: 99 });
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(45);
  });

  it("printRun: null → unnumbered rows only (0 in this fixture)", async () => {
    const rows = await readCompsByCardId({ cardId: "ch-xyz", printRun: null });
    expect(rows).toHaveLength(0);
  });

  it("printRun undefined → no filter, returns all", async () => {
    const rows = await readCompsByCardId({ cardId: "ch-xyz" });
    expect(rows).toHaveLength(3);
  });
});

describe("readCompsByCardId — combined isAuto + printRun (the real fix)", () => {
  beforeEach(() => _setContainerForTests(makeStubContainer(OWEN_CAREY_ROWS)));

  it("isAuto: true + printRun: 150 → the actual Owen Carey /150 Auto ($180)", async () => {
    const rows = await readCompsByCardId({ cardId: "ch-abc", isAuto: true, printRun: 150 });
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(180);
    expect(rows[0].printRun).toBe(150);
  });
});

describe("readCompsByIdentity — strict isAuto + printRun on the fallback path", () => {
  const identityFixture = OWEN_CAREY_ROWS.map((r) => ({
    ...r,
    playerName: "Owen Carey",
    cardYear: 2026,
    cardNumber: "CPA-OC",
  }));
  beforeEach(() => _setContainerForTests(makeStubContainer(identityFixture)));

  it("isAuto: true + printRun: 150 → only his auto card", async () => {
    const rows = await readCompsByIdentity({
      playerName: "Owen Carey",
      isAuto: true,
      printRun: 150,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(180);
  });
});
