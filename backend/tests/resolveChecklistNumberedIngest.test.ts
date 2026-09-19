/**
 * CF-AN-INGEST-TWIN-NEVER-OUTLIVES-ITS-FOLD (2026-09-19, revised after the
 * #2221/#2226 incident review). The fold lane deletes an un-numbered twin
 * once its sales re-point onto the checklist's `:num-N` row; this module is
 * what keeps the NEXT sale of that card from deriving the same short slug
 * and re-splitting the pool. Pinned against a fake card_catalog the same
 * query-shape resolveProductByChecklist.test.ts already uses, PLUS the
 * #2221 bounds: this module's card_catalog query is the same per-sale
 * cross-partition shape that caused 3.8M queries / 92% failures in one TCA
 * webhook request, so it must share persistVendorSalesToPool's breaker and
 * timeout rather than invent a second one -- these tests pin that sharing.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveChecklistNumberedIngestId,
  newNumberedIngestCache,
  _clearProcessCacheForTests,
  type NumberedIngestUpgradeInput,
  type NumberedIngestUpgradeOpts,
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
 *  query. Counts every call so the tests can assert exact query volume. */
function fakeContainer(rows: Row[], opts: { onQuery?: () => void; throwing?: boolean } = {}) {
  return {
    items: {
      query(spec: { query: string; parameters: Array<{ name: string; value: unknown }> }) {
        opts.onQuery?.();
        const p = Object.fromEntries(spec.parameters.map((x) => [x.name, x.value]));
        const hasCardNumberParam = spec.parameters.some((x) => x.name.startsWith("@n"));
        const hits = "@a" in p && hasCardNumberParam ? rows : [];
        return {
          fetchAll: async () => {
            if (opts.throwing) {
              const err = new Error("The operation was aborted.");
              err.name = "TimeoutError";
              throw err;
            }
            return { resources: hits };
          },
        };
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

const CHECKLIST_ROW: Row = {
  id: "hiq:baseball:2026:bowman:cpa-mh:base-refractor:auto:num-499",
  source: "checklistcenter-2026-08-30",
  setKey: "bowman",
  parallelSlug: "base-refractor",
  isAuto: true,
  printRun: 499,
};

beforeEach(() => { _clearProcessCacheForTests(); });

const ctx = (rows: Row[], overrides: Partial<NumberedIngestUpgradeOpts> = {}) =>
  ({ container: fakeContainer(rows), cache: newNumberedIngestCache(), ...overrides }) as NumberedIngestUpgradeOpts;

describe("resolveChecklistNumberedIngestId -- the rule", () => {
  it("un-numbered slug + one checklist-numbered row on the identity -> the numbered id (Harris shape)", async () => {
    const id = await resolveChecklistNumberedIngestId(BASE, ctx([CHECKLIST_ROW]));
    expect(id).toBe(CHECKLIST_ROW.id);
  });

  it("two rival checklist print runs -> unchanged (ambiguous; a ruling, never a guess)", async () => {
    const rows: Row[] = [
      { id: "hiq:baseball:2026:bowman:cpa-mh:refractor:auto:num-499", source: "checklistcenter-2026-08-30", setKey: "bowman", parallelSlug: "refractor", isAuto: true, printRun: 499 },
      { id: "hiq:baseball:2026:bowman:cpa-mh:refractor:auto:num-250", source: "beckett-checklist", setKey: "bowman", parallelSlug: "refractor", isAuto: true, printRun: 250 },
    ];
    expect(await resolveChecklistNumberedIngestId(BASE, ctx(rows))).toBeNull();
  });

  it("title states a print run that disagrees with the checklist -> unchanged, no query issued (absent beats wrong)", async () => {
    let queries = 0;
    const titledInput: NumberedIngestUpgradeInput = {
      ...BASE,
      slug: "hiq:baseball:2026:bowman:cpa-mh:refractor:auto:num-36960",
      printRun: 36960,
    };
    const id = await resolveChecklistNumberedIngestId(
      titledInput,
      ctx([CHECKLIST_ROW], { runQuery: (run) => { queries++; return run(); } }),
    );
    expect(id).toBeNull();
    expect(queries).toBe(0);
  });

  it("no catalog row at all -> unchanged", async () => {
    expect(await resolveChecklistNumberedIngestId(BASE, ctx([]))).toBeNull();
  });

  it("no checklist-authority row (only vendor/derived twins) -> unchanged", async () => {
    const rows: Row[] = [
      { id: "hiq:baseball:2026:bowman:cpa-mh:refractor:auto:num-499", source: "cardhedge", setKey: "bowman", parallelSlug: "refractor", isAuto: true, printRun: 499 },
      { id: "hiq:baseball:2026:bowman:cpa-mh:refractor:auto:num-250", source: "sold-comps-stub", setKey: "bowman", parallelSlug: "refractor", isAuto: true, printRun: 250 },
    ];
    expect(await resolveChecklistNumberedIngestId(BASE, ctx(rows))).toBeNull();
  });

  it("null container (no connection string) -> unchanged", async () => {
    expect(await resolveChecklistNumberedIngestId(BASE, { container: null, cache: newNumberedIngestCache() })).toBeNull();
  });
});

describe("skip gates -- cost ZERO queries", () => {
  const queriesIn = async (input: NumberedIngestUpgradeInput) => {
    let queries = 0;
    await resolveChecklistNumberedIngestId(input, ctx([CHECKLIST_ROW], { runQuery: (run) => { queries++; return run(); } }));
    return queries;
  };

  it("slug already carries its own :num-N -- never queries", async () => {
    expect(await queriesIn({ ...BASE, slug: `${BASE.slug}:num-499`, printRun: 499 })).toBe(0);
  });

  it("Pokemon -- never queries, whatever the catalog holds", async () => {
    expect(await queriesIn({ ...BASE, sport: "pokemon", slug: "hiq:pokemon:2024:sv8a:050:base:no-auto" })).toBe(0);
  });

  it("no cardNumber -- never queries", async () => {
    expect(await queriesIn({ ...BASE, cardNumber: "" })).toBe(0);
  });

  it("setKey is the literal sentinel \"unknown\" -- never queries", async () => {
    expect(await queriesIn({ ...BASE, setKey: "unknown" })).toBe(0);
  });
});

describe("#2221 REUSE -- the shared breaker and timeout, not a second implementation", () => {
  it("breaker open -> no query issued, result null", async () => {
    let queries = 0;
    const id = await resolveChecklistNumberedIngestId(
      BASE,
      ctx([CHECKLIST_ROW], {
        runQuery: (run) => { queries++; return run(); },
        breakerIsOpen: () => true,
      }),
    );
    expect(id).toBeNull();
    expect(queries).toBe(0);
  });

  it("breaker open bumps the caller's shared skip counter, not a local one", async () => {
    let skips = 0;
    await resolveChecklistNumberedIngestId(
      BASE,
      ctx([CHECKLIST_ROW], { breakerIsOpen: () => true, recordSkip: () => { skips++; } }),
    );
    expect(skips).toBe(1);
  });

  it("a timeout thrown by the injected runQuery -> unchanged, never propagates (the sale still writes)", async () => {
    const throwing = fakeContainer([], { throwing: true });
    const id = await resolveChecklistNumberedIngestId(BASE, {
      container: throwing,
      cache: newNumberedIngestCache(),
      runQuery: (run) => run(),
    });
    expect(id).toBeNull();
  });

  it("the abortSignal is threaded onto the actual .query() call, not just wrapped in a race", async () => {
    let seenOptions: { abortSignal?: AbortSignal } | undefined;
    const container = {
      items: {
        query(_spec: unknown, feedOptions?: { abortSignal?: AbortSignal }) {
          seenOptions = feedOptions;
          return { fetchAll: async () => ({ resources: [CHECKLIST_ROW] }) };
        },
      },
    } as never;
    const signal = AbortSignal.timeout(8_000);
    await resolveChecklistNumberedIngestId(BASE, {
      container,
      cache: newNumberedIngestCache(),
      queryOptions: { abortSignal: signal },
    });
    expect(seenOptions?.abortSignal).toBe(signal);
  });

  it("a timeout is NOT cached as a negative -- the next sale still tries again", async () => {
    let attempt = 0;
    const flaky = {
      items: {
        query() {
          attempt++;
          return {
            fetchAll: async () => {
              if (attempt === 1) { const e = new Error("aborted"); e.name = "TimeoutError"; throw e; }
              return { resources: [CHECKLIST_ROW] };
            },
          };
        },
      },
    } as never;
    const cache = newNumberedIngestCache();
    const first = await resolveChecklistNumberedIngestId(BASE, { container: flaky, cache });
    const second = await resolveChecklistNumberedIngestId(BASE, { container: flaky, cache });
    expect(first).toBeNull();
    expect(second).toBe(CHECKLIST_ROW.id);
    expect(attempt).toBe(2);
  });
});

describe("caching does real work, including NEGATIVE answers", () => {
  it("a batch cache hit (positive) issues no second query", async () => {
    let queries = 0;
    const container = fakeContainer([CHECKLIST_ROW], { onQuery: () => { queries++; } });
    const cache = newNumberedIngestCache();
    await resolveChecklistNumberedIngestId(BASE, { container, cache });
    await resolveChecklistNumberedIngestId(BASE, { container, cache });
    expect(queries).toBe(1);
  });

  it("a batch cache hit (NEGATIVE) issues no second query -- a card with no numbered row is not re-asked", async () => {
    let queries = 0;
    const container = fakeContainer([], { onQuery: () => { queries++; } });
    const cache = newNumberedIngestCache();
    const first = await resolveChecklistNumberedIngestId(BASE, { container, cache });
    const second = await resolveChecklistNumberedIngestId(BASE, { container, cache });
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(queries).toBe(1);
  });

  it("500 sales across 40 distinct cards issue at most 40 queries", async () => {
    let queries = 0;
    const container = fakeContainer([CHECKLIST_ROW], { onQuery: () => { queries++; } });
    const cache = newNumberedIngestCache();
    const CARDS = 40;
    const SALES = 500;
    for (let i = 0; i < SALES; i++) {
      const cardIdx = i % CARDS;
      await resolveChecklistNumberedIngestId(
        { ...BASE, cardNumber: `cpa-m${cardIdx}`, slug: `hiq:baseball:2026:bowman:cpa-m${cardIdx}:refractor:auto` },
        { container, cache },
      );
    }
    expect(queries).toBeLessThanOrEqual(CARDS);
  });

  it("recordSoldComp's call site (no batch cache passed) uses the module-level bounded/TTL cache -- a second call still hits", async () => {
    let queries = 0;
    const container = fakeContainer([CHECKLIST_ROW], { onQuery: () => { queries++; } });
    // No `cache` in opts -- exercises the module-level process cache path
    // recordSoldComp uses (one call = one sale, no batch to scope a Map to).
    const first = await resolveChecklistNumberedIngestId(BASE, { container });
    const second = await resolveChecklistNumberedIngestId(BASE, { container });
    expect(first).toBe(CHECKLIST_ROW.id);
    expect(second).toBe(first);
    expect(queries).toBe(1);
  });
});
