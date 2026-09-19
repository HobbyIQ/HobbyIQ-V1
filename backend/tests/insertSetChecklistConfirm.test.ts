/**
 * F3+F5 (review fix on the R66/R67/R70 PR, 2026-09-19). Pins
 * insertSetChecklistConfirm.ts's own logic: a title match on a REGISTERED
 * insert set may only re-key when the insert's OWN checklist rows confirm
 * the sale at its card number (or, absent one, its player); an unregistered
 * root's F4 base-confirmation check shares the same primitive.
 *
 * FIX 1 (second independent review, same day, high/proven): confirming on
 * card NUMBER alone even when the sale's PLAYER is also known let a
 * number-only match on an UNRELATED checklist row (a different player at
 * the same number, on a different card set) confirm a re-key. Pinned below:
 * "Player A #5" (sale) must NOT confirm against a checklist carrying
 * "Player B #5" -- number matches, player does not, on the SAME row, and
 * that row is what must agree on both, together.
 *
 * FIX 2 (second review, design): the query is now TARGETED by
 * cardNumber (`c.cardNumber IN (...)`) whenever the sale states one, the
 * same way resolveChecklistNumberedIngest.ts's own query is -- a live
 * measurement found the OLD product-wide TOP-300 query hit its cap on 1,585
 * of 1,974 calls for high-volume products, answering UNKNOWN (unconfirmed)
 * almost every time. The fake container below therefore ACTUALLY applies
 * the `c.cardNumber IN (...)` filter (unlike the pre-fix version of this
 * file, which stubbed every row through unconditionally) so these tests
 * exercise the real targeting, not just the in-memory post-filter.
 *
 * Mirrors resolveChecklistNumberedIngest.test.ts's fake-container shape
 * deliberately -- same query bounds (sport/year/setKey[/cardNumber]
 * equality, TOP cap, NOT gradeTier), same fail-open/cap-hit-is-unknown
 * rules, so a reviewer who already trusts that module's tests can read
 * these the same way.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  insertReKeyConfirmedByChecklist,
  baseCardConfirmedBySale,
  _clearInsertSetConfirmCacheForTests,
  CONFIRM_RESULT_CAP,
  CONFIRM_PLAYER_ONLY_RESULT_CAP,
} from "../src/services/portfolioiq/insertSetChecklistConfirm.js";

interface Row { id: string; source?: string | null; cardNumber?: string | null; playerName?: string | null; }

/** A card_catalog stand-in that ACTUALLY applies the query's own filters --
 *  sport/year/setKey equality always, and (when the query is the TARGETED
 *  shape) `c.cardNumber IN (...)` against the bound number-variant
 *  parameters -- so these tests exercise real targeting, not a rubber stamp. */
function fakeContainer(rows: Row[], opts: { onQuery?: () => void; throwing?: boolean; cap?: number } = {}) {
  return {
    items: {
      query(spec: { query: string; parameters: Array<{ name: string; value: unknown }> }) {
        opts.onQuery?.();
        const p = Object.fromEntries(spec.parameters.map((x) => [x.name, x.value]));
        const hasSetKeyFilter = spec.query.includes("c.setKey = @k");
        const isTargeted = spec.query.includes("c.cardNumber IN (");
        let matched = hasSetKeyFilter && p["@s"] && p["@y"] && p["@k"] ? rows : [];
        if (isTargeted) {
          const numberParams = new Set(
            spec.parameters.filter((x) => x.name.startsWith("@n")).map((x) => String(x.value).toLowerCase()),
          );
          matched = matched.filter((r) => numberParams.has(String(r.cardNumber ?? "").toLowerCase()));
        }
        const cap = opts.cap ?? (isTargeted ? CONFIRM_RESULT_CAP : CONFIRM_PLAYER_ONLY_RESULT_CAP);
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
  it("confirms on card number alone when the sale's player is NOT known", async () => {
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

  it("a different player, no card number stated, does not confirm", async () => {
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

  it("a TOP-cap hit on the TARGETED (card-number) query answers UNCONFIRMED, not a wrong negative, and is NOT cached", async () => {
    // Every row shares the SAME card number "6" -- with the targeted filter
    // applied, all of them pass the WHERE and the cap is hit on count alone
    // (a pathological case: many catalog rows filed under one number, e.g.
    // heavy parallel/print-run duplication before dedup).
    const rows = Array.from({ length: CONFIRM_RESULT_CAP }, (_, i) => ({ id: `hiq:${i}`, source: "checklistcenter", cardNumber: "6", playerName: null }));
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

  it("caches per (sport,year,setKey,cardNumber) -- a DIFFERENT card number is a cache MISS, not a hit (FIX 2: caching by product alone would serve one number's targeted result as another's)", async () => {
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
    expect(queries).toBe(2);
  });

  it("caches a REPEAT of the same card number -- second call is a cache HIT", async () => {
    let queries = 0;
    const container = fakeContainer([CHECKLIST_ROW], { onQuery: () => { queries++; } });
    await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: null },
      { container },
    );
    await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: null },
      { container },
    );
    expect(queries).toBe(1);
  });

  it("cache hit is spelling-insensitive: 'BCP-6' and 'bcp6' share one cache slot (same variant set)", async () => {
    const row: Row = { id: "hiq:x", source: "checklistcenter", cardNumber: "BCP-6", playerName: null };
    let queries = 0;
    const container = fakeContainer([row], { onQuery: () => { queries++; } });
    await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "BCP-6", playerName: null },
      { container },
    );
    await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "bcp6", playerName: null },
      { container },
    );
    expect(queries).toBe(1);
  });
});

describe("FIX 1 -- BOTH number and player must agree on the SAME row when both are known", () => {
  it("the reviewer's exact case: Player A #5 does NOT confirm against a checklist carrying Downtown #5 for Player B", async () => {
    const rivalRow: Row = { id: "hiq:downtown-5", source: "checklistcenter-2026-08-30", cardNumber: "5", playerName: "Player B" };
    const ok = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "5", playerName: "Player A" },
      { container: fakeContainer([rivalRow]) },
    );
    expect(ok).toBe(false);
  });

  it("F4 mirror: the same rule applies to baseCardConfirmedBySale -- a base #5 sale of Player A is not confirmed by a base checklist row #5 for Player B", async () => {
    const rivalRow: Row = { id: "hiq:base-5", source: "beckett-2026-08", cardNumber: "5", playerName: "Player B" };
    const ok = await baseCardConfirmedBySale(
      { sport: "football", year: 2024, baseSetKey: "panini-mosaic", cardNumber: "5", playerName: "Player A" },
      { container: fakeContainer([rivalRow]) },
    );
    expect(ok).toBe(false);
  });

  it("confirms when the SAME row matches both number and player", async () => {
    const ok = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: "Justin Herbert" },
      { container: fakeContainer([CHECKLIST_ROW]) },
    );
    expect(ok).toBe(true);
  });

  it("does not confirm when the number matches a row but the player does not, even though no OTHER row exists", async () => {
    const ok = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: "Someone Else" },
      { container: fakeContainer([CHECKLIST_ROW]) },
    );
    expect(ok).toBe(false);
  });

  it("multi-player row: the sale's player matches when it is ANY name listed on the row (D33 shape, 'A / B')", async () => {
    const duoRow: Row = { id: "hiq:duo", source: "checklistcenter", cardNumber: "10", playerName: "Eddie Murray / Cal Ripken Jr." };
    const first = await insertReKeyConfirmedByChecklist(
      { sport: "baseball", year: 1990, insertSetKey: "topps-highlights", cardNumber: "10", playerName: "Cal Ripken Jr." },
      { container: fakeContainer([duoRow]) },
    );
    expect(first).toBe(true);
    const second = await insertReKeyConfirmedByChecklist(
      { sport: "baseball", year: 1990, insertSetKey: "topps-highlights", cardNumber: "10", playerName: "Eddie Murray" },
      { container: fakeContainer([duoRow]) },
    );
    expect(second).toBe(true);
    const third = await insertReKeyConfirmedByChecklist(
      { sport: "baseball", year: 1990, insertSetKey: "topps-highlights", cardNumber: "10", playerName: "Someone Else" },
      { container: fakeContainer([duoRow]) },
    );
    expect(third).toBe(false);
  });
});

describe("baseCardConfirmedBySale -- F4, the base checklist vouching for an incidental word", () => {
  it("confirms the base card at its number when the sale's player is not known", async () => {
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

describe("FIX 2 -- the query is TARGETED by card number, closing the live-measured mass-cap-hit gap", () => {
  it("a product with THOUSANDS of catalog rows (simulated) still confirms cleanly because the query filters by card number in the WHERE, not in memory after a product-wide fetch", async () => {
    // Simulates panini-prizm 2025's shape: far more rows than CONFIRM_RESULT_CAP
    // across the WHOLE product, but only one at the sale's card number. The
    // old product-wide query would have hit its cap and answered UNKNOWN;
    // the targeted query only ever asks for rows AT this number, so the cap
    // is never touched by the other thousands of rows.
    const huge: Row[] = Array.from({ length: CONFIRM_RESULT_CAP * 20 }, (_, i) => ({
      id: `hiq:${i}`, source: "checklistcenter", cardNumber: String(1000 + i), playerName: "Filler Player",
    }));
    huge.push({ id: "hiq:target", source: "checklistcenter", cardNumber: "20", playerName: null });
    const ok = await baseCardConfirmedBySale(
      { sport: "basketball", year: 2025, baseSetKey: "panini-prizm", cardNumber: "20", playerName: null },
      { container: fakeContainer(huge) },
    );
    expect(ok).toBe(true);
  });

  it("the player-only fallback (no card number) still scans product-wide and can hit its own, larger cap", async () => {
    const rows = Array.from({ length: CONFIRM_PLAYER_ONLY_RESULT_CAP }, (_, i) => ({ id: `hiq:${i}`, source: "checklistcenter", cardNumber: String(i), playerName: "Filler" }));
    const ok = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: null, playerName: "Justin Herbert" },
      { container: fakeContainer(rows) },
    );
    expect(ok).toBe(false);
  });
});

describe("leading-zero card-number comparison (FIX 2)", () => {
  it("'05' on the sale confirms against a checklist row stored as '5'", async () => {
    const row: Row = { id: "hiq:x", source: "checklistcenter", cardNumber: "5", playerName: null };
    const ok = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "05", playerName: null },
      { container: fakeContainer([row]) },
    );
    expect(ok).toBe(true);
  });
});
