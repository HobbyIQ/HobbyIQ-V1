/**
 * F3+F5 (review fix on the R66/R67/R70 PR, 2026-09-19). Pins
 * insertSetChecklistConfirm.ts's own logic: a title match on a REGISTERED
 * insert set may only re-key when the insert's OWN checklist rows confirm
 * the sale at its card number (or, absent one, its player); an unregistered
 * root's F4 base-confirmation check shares the same primitive.
 *
 * Mirrors resolveChecklistNumberedIngest.test.ts's fake-container shape
 * deliberately -- same query bounds (sport/year/setKey equality, TOP cap,
 * NOT gradeTier), same fail-open/cap-hit-is-unknown rules, so a reviewer who
 * already trusts that module's tests can read these the same way.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  insertReKeyConfirmedByChecklist,
  baseCardConfirmedBySale,
  _clearInsertSetConfirmCacheForTests,
  CONFIRM_RESULT_CAP,
} from "../src/services/portfolioiq/insertSetChecklistConfirm.js";

interface Row { id: string; source?: string | null; cardNumber?: string | null; playerName?: string | null; }

function fakeContainer(rows: Row[], opts: { onQuery?: () => void; throwing?: boolean; cap?: number } = {}) {
  return {
    items: {
      query(spec: { query: string; parameters: Array<{ name: string; value: unknown }> }) {
        opts.onQuery?.();
        const p = Object.fromEntries(spec.parameters.map((x) => [x.name, x.value]));
        const hasSetKeyFilter = spec.query.includes("c.setKey = @k");
        const matched = hasSetKeyFilter && p["@s"] && p["@y"] && p["@k"]
          ? rows.filter((r) => true) // fake container itself is pre-scoped per test
          : [];
        const cap = opts.cap ?? CONFIRM_RESULT_CAP;
        return {
          fetchAll: async () => {
            if (opts.throwing) {
              const err = new Error("The operation was aborted.");
              err.name = "TimeoutError";
              throw err;
            }
            return { resources: matched.slice(0, cap) };
          },
        };
      },
    },
  } as never;
}

const CHECKLIST_ROW: Row = { id: "hiq:x", source: "checklistcenter-2026-08-30", cardNumber: "6", playerName: "Justin Herbert" };
const VENDOR_ROW: Row = { id: "hiq:y", source: "cardhedge", cardNumber: "6", playerName: "Justin Herbert" };

beforeEach(() => { _clearInsertSetConfirmCacheForTests(); });

describe("insertReKeyConfirmedByChecklist -- the checklist decides, never a title match alone", () => {
  it("confirms when a checklist row matches the sale's card number", async () => {
    const ok = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: null },
      { container: fakeContainer([CHECKLIST_ROW]) },
    );
    expect(ok).toBe(true);
  });

  it("does NOT confirm when the checklist has rows for the product but none at this card number (F5: insert setKey + base number is not an address any checklist has)", async () => {
    const ok = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "999", playerName: null },
      { container: fakeContainer([CHECKLIST_ROW]) },
    );
    expect(ok).toBe(false);
  });

  it("does NOT confirm when the insert key has NO checklist rows at all -- only VENDOR rows exist", async () => {
    const ok = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: null },
      { container: fakeContainer([VENDOR_ROW]) },
    );
    expect(ok).toBe(false);
  });

  it("falls back to the normalised player comparison when the sale has no card number", async () => {
    const ok = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: null, playerName: "Justin Herbert" },
      { container: fakeContainer([CHECKLIST_ROW]) },
    );
    expect(ok).toBe(true);
  });

  it("player comparison is normalised (case/punctuation), matching playerIdentityKey's own rules", async () => {
    const ok = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: null, playerName: "justin  HERBERT" },
      { container: fakeContainer([CHECKLIST_ROW]) },
    );
    expect(ok).toBe(true);
  });

  it("a different player at the same number does not confirm", async () => {
    const ok = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: null, playerName: "Someone Else" },
      { container: fakeContainer([CHECKLIST_ROW]) },
    );
    expect(ok).toBe(false);
  });

  it("fails open to UNCONFIRMED on a query error -- never a re-key on a catalog blip", async () => {
    const ok = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: null },
      { container: fakeContainer([CHECKLIST_ROW], { throwing: true }) },
    );
    expect(ok).toBe(false);
  });

  it("no container (no connection string) fails open to UNCONFIRMED", async () => {
    const ok = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: null },
      { container: null },
    );
    expect(ok).toBe(false);
  });

  it("an open breaker costs zero queries and answers UNCONFIRMED", async () => {
    let queries = 0;
    const ok = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: null },
      {
        container: fakeContainer([CHECKLIST_ROW], { onQuery: () => { queries++; } }),
        breakerIsOpen: () => true,
      },
    );
    expect(ok).toBe(false);
    expect(queries).toBe(0);
  });

  it("a TOP-cap hit answers UNCONFIRMED (unknown), not a wrong negative, and is NOT cached", async () => {
    const rows = Array.from({ length: CONFIRM_RESULT_CAP }, (_, i) => ({ id: `hiq:${i}`, source: "checklistcenter", cardNumber: String(i), playerName: null }));
    let queries = 0;
    const container = fakeContainer(rows, { onQuery: () => { queries++; } });
    const first = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: null },
      { container },
    );
    expect(first).toBe(false);
    const second = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: null },
      { container },
    );
    expect(second).toBe(false);
    // Not cached: both calls actually queried.
    expect(queries).toBe(2);
  });

  it("caches the product's checklist rows across calls for the same (sport,year,setKey)", async () => {
    let queries = 0;
    const container = fakeContainer([CHECKLIST_ROW], { onQuery: () => { queries++; } });
    await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: null },
      { container },
    );
    await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "999", playerName: null },
      { container },
    );
    expect(queries).toBe(1);
  });
});

describe("baseCardConfirmedBySale -- F4, the base checklist vouching for an incidental word", () => {
  it("confirms the base card at its number, so an incidental unregistered-root word does not park it", async () => {
    const ok = await baseCardConfirmedBySale(
      { sport: "basketball", year: 2024, baseSetKey: "panini-prizm", cardNumber: "20", playerName: null },
      { container: fakeContainer([{ id: "hiq:z", source: "beckett-2026-08", cardNumber: "20", playerName: null }]) },
    );
    expect(ok).toBe(true);
  });

  it("does not confirm when the base checklist has no row at this number", async () => {
    const ok = await baseCardConfirmedBySale(
      { sport: "basketball", year: 2024, baseSetKey: "panini-prizm", cardNumber: "999", playerName: null },
      { container: fakeContainer([{ id: "hiq:z", source: "beckett-2026-08", cardNumber: "20", playerName: null }]) },
    );
    expect(ok).toBe(false);
  });
});
