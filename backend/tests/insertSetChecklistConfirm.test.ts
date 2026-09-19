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
 * FIX 2 (second review, design): the query is TARGETED by cardNumber
 * (`c.cardNumber IN (...)`) whenever the sale states one, the same way
 * resolveChecklistNumberedIngest.ts's own query is.
 *
 * FIX A (third review, live-measured, 2026-09-19): FIX 2's targeted query
 * still fetched one ROW per parallel -- a 2025 flagship product carries
 * ~382 rows at one (setKey, cardNumber), so the old 50-row cap still hit on
 * 78% of live calls. The query is now `SELECT DISTINCT` over exactly the
 * (cardNumber, playerName, source) triple the predicate reads, with caps
 * raised to 200 (targeted) / 2,000 (player-only) distinct triples -- the fake
 * container below applies DISTINCT itself (dedupes on that triple) so these
 * tests exercise the real collapsed cardinality, not just a rubber stamp.
 *
 * FIX B (third review, ruling on UNKNOWN, 2026-09-19): the predicate is now a
 * TRI-STATE (`"confirmed" | "refuted" | "unknown"`), never a boolean. A
 * cap hit / timeout / open breaker / no container / query error is
 * "unknown" -- the caller must leave the sale untouched, never park it,
 * since #2330 made a parked row invisible to every FMV pool. Every case
 * where the query DID answer -- no checklist rows at all, or rows exist but
 * none match -- is "refuted", the same "do not re-key/park it" outcome the
 * boolean `false` used to mean.
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
  _resetInsertConfirmUnknownCounterForTests,
  insertConfirmUnknownTotal,
  CONFIRM_RESULT_CAP,
  CONFIRM_PLAYER_ONLY_RESULT_CAP,
} from "../src/services/portfolioiq/insertSetChecklistConfirm.js";

interface Row { source?: string | null; cardNumber?: string | null; playerName?: string | null; }

/** A card_catalog stand-in that ACTUALLY applies the query's own filters --
 *  sport/year/setKey equality always, `c.cardNumber IN (...)` against the
 *  bound number-variant parameters when the query is the TARGETED shape,
 *  and DISTINCT over the projected fields (FIX A) -- so these tests exercise
 *  real targeting and real cardinality collapse, not a rubber stamp.
 *  `rows` may list the SAME (cardNumber, playerName, source) triple many
 *  times (simulating one row per parallel); the fake collapses those to one
 *  the same way `SELECT DISTINCT` does, so a cap sized in DISTINCT TRIPLES
 *  is exercised honestly. */
function fakeContainer(rows: Row[], opts: { onQuery?: () => void; throwing?: boolean; cap?: number } = {}) {
  return {
    items: {
      query(spec: { query: string; parameters: Array<{ name: string; value: unknown }> }) {
        opts.onQuery?.();
        const p = Object.fromEntries(spec.parameters.map((x) => [x.name, x.value]));
        const hasSetKeyFilter = spec.query.includes("c.setKey = @k");
        const isTargeted = spec.query.includes("c.cardNumber IN (");
        const isDistinct = spec.query.includes("SELECT DISTINCT");
        let matched = hasSetKeyFilter && p["@s"] && p["@y"] && p["@k"] ? rows : [];
        if (isTargeted) {
          const numberParams = new Set(
            spec.parameters.filter((x) => x.name.startsWith("@n")).map((x) => String(x.value).toLowerCase()),
          );
          matched = matched.filter((r) => numberParams.has(String(r.cardNumber ?? "").toLowerCase()));
        }
        if (isDistinct) {
          const seen = new Set<string>();
          const deduped: Row[] = [];
          for (const r of matched) {
            const key = isTargeted
              ? `${String(r.cardNumber ?? "").toLowerCase()}|${String(r.playerName ?? "").toLowerCase()}|${String(r.source ?? "").toLowerCase()}`
              : `${String(r.playerName ?? "").toLowerCase()}|${String(r.source ?? "").toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            deduped.push(r);
          }
          matched = deduped;
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

const CHECKLIST_ROW: Row = { source: "checklistcenter-2026-08-30", cardNumber: "6", playerName: "Justin Herbert" };
const VENDOR_ROW: Row = { source: "cardhedge", cardNumber: "6", playerName: "Justin Herbert" };

beforeEach(() => {
  _clearInsertSetConfirmCacheForTests();
  _resetInsertConfirmUnknownCounterForTests();
});

describe("insertReKeyConfirmedByChecklist -- the checklist decides, never a title match alone", () => {
  it("CONFIRMED on card number alone when the sale's player is NOT known", async () => {
    const verdict = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: null },
      { container: fakeContainer([CHECKLIST_ROW]) },
    );
    expect(verdict).toBe("confirmed");
  });

  it("REFUTED when the checklist has rows for the product but none at this card number (F5: insert setKey + base number is not an address any checklist has)", async () => {
    const verdict = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "999", playerName: null },
      { container: fakeContainer([CHECKLIST_ROW]) },
    );
    expect(verdict).toBe("refuted");
  });

  it("REFUTED when the insert key has NO checklist rows at all -- only VENDOR rows exist (the query answered; nothing confirms)", async () => {
    const verdict = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: null },
      { container: fakeContainer([VENDOR_ROW]) },
    );
    expect(verdict).toBe("refuted");
  });

  it("falls back to the normalised player comparison when the sale has no card number", async () => {
    const verdict = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: null, playerName: "Justin Herbert" },
      { container: fakeContainer([CHECKLIST_ROW]) },
    );
    expect(verdict).toBe("confirmed");
  });

  it("player comparison is normalised (case/punctuation), matching playerIdentityKey's own rules", async () => {
    const verdict = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: null, playerName: "justin  HERBERT" },
      { container: fakeContainer([CHECKLIST_ROW]) },
    );
    expect(verdict).toBe("confirmed");
  });

  it("a different player, no card number stated, is REFUTED", async () => {
    const verdict = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: null, playerName: "Someone Else" },
      { container: fakeContainer([CHECKLIST_ROW]) },
    );
    expect(verdict).toBe("refuted");
  });

  it("UNKNOWN on a query error (timeout) -- never a re-key, never a park, on a catalog blip", async () => {
    const verdict = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: null },
      { container: fakeContainer([CHECKLIST_ROW], { throwing: true }) },
    );
    expect(verdict).toBe("unknown");
  });

  it("no container (no connection string) is UNKNOWN", async () => {
    const verdict = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: null },
      { container: null },
    );
    expect(verdict).toBe("unknown");
  });

  it("an open breaker costs zero queries and answers UNKNOWN", async () => {
    let queries = 0;
    const verdict = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: null },
      {
        container: fakeContainer([CHECKLIST_ROW], { onQuery: () => { queries++; } }),
        breakerIsOpen: () => true,
      },
    );
    expect(verdict).toBe("unknown");
    expect(queries).toBe(0);
  });

  it("a TOP-cap hit on the TARGETED (card-number) DISTINCT query answers UNKNOWN, not a wrong negative, and is NOT cached", async () => {
    // CONFIRM_RESULT_CAP+1 DISTINCT (cardNumber, playerName, source) triples,
    // all sharing card number "6" but each a different player -- with
    // DISTINCT applied, the cap is hit on TRIPLE count, not row count.
    const rows = Array.from({ length: CONFIRM_RESULT_CAP + 1 }, (_, i) => ({ source: "checklistcenter", cardNumber: "6", playerName: `Player ${i}` }));
    let queries = 0;
    const container = fakeContainer(rows, { onQuery: () => { queries++; } });
    const first = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: null },
      { container },
    );
    expect(first).toBe("unknown");
    const second = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: null },
      { container },
    );
    expect(second).toBe("unknown");
    // Not cached: both calls actually queried.
    expect(queries).toBe(2);
  });

  it("a 382-parallel rung (FIX A's exact live-measured shape) collapses to ONE distinct triple and CONFIRMS cleanly, well under the new cap", async () => {
    // Simulates the live incident shape: 382 rows at one (setKey,
    // cardNumber) -- one per parallel -- but every one of them the SAME
    // player/source triple (a parallel changes the card's finish, not its
    // player or checklist source). The old row-counting cap (50) would have
    // hit on row count alone; DISTINCT collapses this to 1 triple.
    const parallels: Row[] = Array.from({ length: 382 }, () => ({ source: "checklistcenter-2026-08-30", cardNumber: "6", playerName: "Justin Herbert" }));
    const verdict = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2025, insertSetKey: "panini-prizm", cardNumber: "6", playerName: "Justin Herbert" },
      { container: fakeContainer(parallels) },
    );
    expect(verdict).toBe("confirmed");
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
    const row: Row = { source: "checklistcenter", cardNumber: "BCP-6", playerName: null };
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

describe("FIX B -- UNKNOWN telemetry: counter + one log line per process per reason", () => {
  it("insertConfirmUnknownTotal() increments on every UNKNOWN verdict, for both call sites", async () => {
    expect(insertConfirmUnknownTotal()).toBe(0);
    await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: null },
      { container: null },
    );
    expect(insertConfirmUnknownTotal()).toBe(1);
    await baseCardConfirmedBySale(
      { sport: "basketball", year: 2024, baseSetKey: "panini-prizm", cardNumber: "20", playerName: null },
      { container: null },
    );
    expect(insertConfirmUnknownTotal()).toBe(2);
  });

  it("a CONFIRMED or REFUTED verdict does not touch the unknown counter", async () => {
    await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: null },
      { container: fakeContainer([CHECKLIST_ROW]) },
    );
    await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "999", playerName: null },
      { container: fakeContainer([CHECKLIST_ROW]) },
    );
    expect(insertConfirmUnknownTotal()).toBe(0);
  });
});

describe("FIX 1 -- BOTH number and player must agree on the SAME row when both are known", () => {
  it("the reviewer's exact case: Player A #5 is REFUTED against a checklist carrying Downtown #5 for Player B (the query answered; number matched, player did not, on that row)", async () => {
    const rivalRow: Row = { source: "checklistcenter-2026-08-30", cardNumber: "5", playerName: "Player B" };
    const verdict = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "5", playerName: "Player A" },
      { container: fakeContainer([rivalRow]) },
    );
    expect(verdict).toBe("refuted");
  });

  it("F4 mirror: the same rule applies to baseCardConfirmedBySale -- a base #5 sale of Player A is REFUTED by a base checklist row #5 for Player B", async () => {
    const rivalRow: Row = { source: "beckett-2026-08", cardNumber: "5", playerName: "Player B" };
    const verdict = await baseCardConfirmedBySale(
      { sport: "football", year: 2024, baseSetKey: "panini-mosaic", cardNumber: "5", playerName: "Player A" },
      { container: fakeContainer([rivalRow]) },
    );
    expect(verdict).toBe("refuted");
  });

  it("CONFIRMS when the SAME row matches both number and player", async () => {
    const verdict = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: "Justin Herbert" },
      { container: fakeContainer([CHECKLIST_ROW]) },
    );
    expect(verdict).toBe("confirmed");
  });

  it("REFUTED when the number matches a row but the player does not, even though no OTHER row exists", async () => {
    const verdict = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "6", playerName: "Someone Else" },
      { container: fakeContainer([CHECKLIST_ROW]) },
    );
    expect(verdict).toBe("refuted");
  });

  it("multi-player row: the sale's player matches when it is ANY name listed on the row (D33 shape, 'A / B')", async () => {
    const duoRow: Row = { source: "checklistcenter", cardNumber: "10", playerName: "Eddie Murray / Cal Ripken Jr." };
    const first = await insertReKeyConfirmedByChecklist(
      { sport: "baseball", year: 1990, insertSetKey: "topps-highlights", cardNumber: "10", playerName: "Cal Ripken Jr." },
      { container: fakeContainer([duoRow]) },
    );
    expect(first).toBe("confirmed");
    const second = await insertReKeyConfirmedByChecklist(
      { sport: "baseball", year: 1990, insertSetKey: "topps-highlights", cardNumber: "10", playerName: "Eddie Murray" },
      { container: fakeContainer([duoRow]) },
    );
    expect(second).toBe("confirmed");
    const third = await insertReKeyConfirmedByChecklist(
      { sport: "baseball", year: 1990, insertSetKey: "topps-highlights", cardNumber: "10", playerName: "Someone Else" },
      { container: fakeContainer([duoRow]) },
    );
    expect(third).toBe("refuted");
  });
});

describe("baseCardConfirmedBySale -- F4, the base checklist vouching for an incidental word", () => {
  it("CONFIRMS the base card at its number when the sale's player is not known", async () => {
    const verdict = await baseCardConfirmedBySale(
      { sport: "basketball", year: 2024, baseSetKey: "panini-prizm", cardNumber: "20", playerName: null },
      { container: fakeContainer([{ source: "beckett-2026-08", cardNumber: "20", playerName: null }]) },
    );
    expect(verdict).toBe("confirmed");
  });

  it("REFUTED when the base checklist has no row at this number", async () => {
    const verdict = await baseCardConfirmedBySale(
      { sport: "basketball", year: 2024, baseSetKey: "panini-prizm", cardNumber: "999", playerName: null },
      { container: fakeContainer([{ source: "beckett-2026-08", cardNumber: "20", playerName: null }]) },
    );
    expect(verdict).toBe("refuted");
  });

  it("UNKNOWN (breaker open) leaves the caller with no answer, distinct from REFUTED", async () => {
    const verdict = await baseCardConfirmedBySale(
      { sport: "basketball", year: 2024, baseSetKey: "panini-prizm", cardNumber: "20", playerName: null },
      { container: fakeContainer([{ source: "beckett-2026-08", cardNumber: "20", playerName: null }]), breakerIsOpen: () => true },
    );
    expect(verdict).toBe("unknown");
  });
});

describe("FIX A -- DISTINCT projection closes the live-measured 382-parallel cap-hit gap", () => {
  it("a product with THOUSANDS of catalog rows (simulated) still confirms cleanly because the query filters by card number in the WHERE and collapses to distinct triples, not one row per parallel", async () => {
    // Simulates panini-prizm 2025's shape: far more rows than
    // CONFIRM_RESULT_CAP across the WHOLE product, but only one distinct
    // triple at the sale's card number.
    const huge: Row[] = Array.from({ length: CONFIRM_RESULT_CAP * 20 }, (_, i) => ({
      source: "checklistcenter", cardNumber: String(1000 + i), playerName: "Filler Player",
    }));
    huge.push({ source: "checklistcenter", cardNumber: "20", playerName: null });
    const verdict = await baseCardConfirmedBySale(
      { sport: "basketball", year: 2025, baseSetKey: "panini-prizm", cardNumber: "20", playerName: null },
      { container: fakeContainer(huge) },
    );
    expect(verdict).toBe("confirmed");
  });

  it("382 rows at ONE card number, all the same triple (the exact live incident shape), collapses to 1 distinct triple -- nowhere near the 200 cap", async () => {
    const parallels: Row[] = Array.from({ length: 382 }, () => ({ source: "checklistcenter", cardNumber: "6", playerName: "Justin Herbert" }));
    const verdict = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2025, insertSetKey: "panini-prizm", cardNumber: "6", playerName: "Justin Herbert" },
      { container: fakeContainer(parallels) },
    );
    expect(verdict).toBe("confirmed");
  });

  it("the player-only fallback (no card number) still scans product-wide and can hit its own, larger (2,000) distinct cap -- answers UNKNOWN, not a wrong negative", async () => {
    const rows = Array.from({ length: CONFIRM_PLAYER_ONLY_RESULT_CAP + 1 }, (_, i) => ({ source: "checklistcenter", cardNumber: String(i), playerName: `Filler ${i}` }));
    const verdict = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: null, playerName: "Justin Herbert" },
      { container: fakeContainer(rows) },
    );
    expect(verdict).toBe("unknown");
  });
});

describe("leading-zero card-number comparison (FIX 2)", () => {
  it("'05' on the sale confirms against a checklist row stored as '5'", async () => {
    const row: Row = { source: "checklistcenter", cardNumber: "5", playerName: null };
    const verdict = await insertReKeyConfirmedByChecklist(
      { sport: "football", year: 2024, insertSetKey: "donruss-optic-downtown", cardNumber: "05", playerName: null },
      { container: fakeContainer([row]) },
    );
    expect(verdict).toBe("confirmed");
  });
});
