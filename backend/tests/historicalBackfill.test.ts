// CF-HISTORICAL-BACKFILL (Drew, 2026-07-15) — pins the dual-vendor
// (CH + CS) full-history sweep that accumulates seasonality data
// in sold_comps.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Container } from "@azure/cosmos";
import type { CardHedgeSale } from "../src/services/compiq/cardhedge.client.js";
import type { CardsightPricingResponse } from "../src/services/compiq/cardsightSlim.client.js";

vi.mock("../src/services/compiq/cardhedge.client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/compiq/cardhedge.client.js")>(
    "../src/services/compiq/cardhedge.client.js",
  );
  return { ...actual, getCardSales: vi.fn() };
});
vi.mock("../src/services/compiq/cardsightSlim.client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/compiq/cardsightSlim.client.js")>(
    "../src/services/compiq/cardsightSlim.client.js",
  );
  return { ...actual, getPricing: vi.fn() };
});

import { getCardSales } from "../src/services/compiq/cardhedge.client.js";
import { getPricing } from "../src/services/compiq/cardsightSlim.client.js";
import {
  runHistoricalBackfill,
  buildTargetsFromHoldings,
} from "../src/services/portfolioiq/historicalBackfill.service.js";
import {
  _setContainerForTests as setSoldCompsContainer,
  readCompsByCardId,
} from "../src/services/portfolioiq/soldCompsStore.service.js";

const mockedCH = vi.mocked(getCardSales);
const mockedCS = vi.mocked(getPricing);

function fakeContainer(): { container: Container; store: Map<string, any> } {
  const store = new Map<string, any>();
  const container = {
    items: {
      async upsert(doc: any) {
        store.set(`${doc.cardId}::${doc.id}`, doc);
        return { resource: doc };
      },
      query(spec: { query: string; parameters?: Array<{ name: string; value: any }> }) {
        const params = new Map<string, any>();
        for (const p of spec.parameters ?? []) params.set(p.name, p.value);
        return {
          async fetchAll() {
            const cid = params.get("@cid");
            let rows = Array.from(store.values());
            if (cid) rows = rows.filter((d) => d.cardId === cid);
            const h = params.get("@h"); if (h) rows = rows.filter((d) => d.contentHash === h);
            rows.sort((a, b) => (a.soldAt < b.soldAt ? 1 : -1));
            return { resources: rows };
          },
        };
      },
    },
  } as unknown as Container;
  return { container, store };
}

let store: Map<string, any>;
beforeEach(() => {
  vi.resetAllMocks();
  const f = fakeContainer();
  store = f.store;
  setSoldCompsContainer(f.container);
});
afterEach(() => setSoldCompsContainer(null));

function chSale(o: Partial<CardHedgeSale> = {}): CardHedgeSale {
  return {
    price: 100,
    date: "2024-07-15T00:00:00Z",
    grade: "Raw",
    source: "ebay",
    sale_type: "auction",
    title: "Sale",
    url: null,
    ...o,
  };
}

function csPricing(o: Partial<CardsightPricingResponse> = {}): CardsightPricingResponse {
  return {
    raw: { count: 0, records: [], ...(o.raw ?? {}) },
    graded: o.graded ?? [],
    meta: { total_records: 0, last_sale_date: null, ...(o.meta ?? {}) },
  } as CardsightPricingResponse;
}

const identity = {
  playerName: "Bobby Witt Jr",
  cardYear: 2020,
  setName: "Bowman Chrome",
  parallel: null,
  cardNumber: "BCP-42",
  isAuto: false,
};

describe("runHistoricalBackfill — dual-vendor accumulation", () => {
  it("writes CH sales to sold_comps at confidence 0.8", async () => {
    mockedCH.mockResolvedValue([
      chSale({ price: 500, date: "2022-08-01T00:00:00Z" }),
      chSale({ price: 480, date: "2023-08-01T00:00:00Z" }),
      chSale({ price: 460, date: "2024-08-01T00:00:00Z" }),
    ]);
    mockedCS.mockResolvedValue(csPricing());
    const result = await runHistoricalBackfill([
      { chCardId: "ch-witt-base", csCardId: null, identity },
    ]);
    expect(result.totalCHSalesWritten).toBe(3);
    expect(result.totalCSSalesWritten).toBe(0);
    const rows = await readCompsByCardId({
      cardId: "ch-witt-base",
      fromDate: "2000-01-01T00:00:00Z",
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.source === "cardhedge" && r.confidence === 0.8)).toBe(true);
  });

  it("writes CS raw + graded records at confidence 0.6", async () => {
    mockedCH.mockResolvedValue([]);
    mockedCS.mockResolvedValue(csPricing({
      raw: { count: 2, records: [
        { price: 100, date: "2023-01-01T00:00:00Z" },
        { price: 110, date: "2024-01-01T00:00:00Z" },
      ] as any },
      graded: [{
        company_name: "PSA",
        grades: [{
          grade_value: "10",
          count: 1,
          records: [{ price: 800, date: "2023-06-01T00:00:00Z" }] as any,
        }],
      }],
    }));
    const result = await runHistoricalBackfill([
      { chCardId: null, csCardId: "cs-uuid-1", identity },
    ]);
    expect(result.totalCSSalesWritten).toBe(3);
    const rows = await readCompsByCardId({
      cardId: "cs-uuid-1", fromDate: "2000-01-01T00:00:00Z",
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.source === "cardsight" && r.confidence === 0.6)).toBe(true);
  });

  it("both vendors together for a single target", async () => {
    mockedCH.mockResolvedValue([chSale({ price: 200 })]);
    mockedCS.mockResolvedValue(csPricing({
      raw: { count: 1, records: [{ price: 190, date: "2024-06-01T00:00:00Z" }] as any },
    }));
    const result = await runHistoricalBackfill([
      { chCardId: "ch-1", csCardId: "cs-1", identity },
    ]);
    expect(result.totalCHSalesWritten).toBe(1);
    expect(result.totalCSSalesWritten).toBe(1);
    expect(mockedCH).toHaveBeenCalledWith("ch-1", "Raw", 100);
    expect(mockedCS).toHaveBeenCalledWith("cs-1");
  });

  it("is IDEMPOTENT — running twice doesn't duplicate", async () => {
    mockedCH.mockResolvedValue([
      chSale({ price: 500, date: "2022-08-01T00:00:00Z" }),
      chSale({ price: 480, date: "2023-08-01T00:00:00Z" }),
    ]);
    mockedCS.mockResolvedValue(csPricing());
    await runHistoricalBackfill([{ chCardId: "ch-x", csCardId: null, identity }]);
    await runHistoricalBackfill([{ chCardId: "ch-x", csCardId: null, identity }]);
    // Same composite ids → upsert dedups → still 2 rows, not 4
    expect(store.size).toBe(2);
  });

  it("skips targets with no chCardId AND no csCardId", async () => {
    const result = await runHistoricalBackfill([
      { chCardId: null, csCardId: null, identity },
    ]);
    expect(result.totalCHSalesWritten).toBe(0);
    expect(result.totalCSSalesWritten).toBe(0);
    expect(mockedCH).not.toHaveBeenCalled();
    expect(mockedCS).not.toHaveBeenCalled();
  });

  it("captures errors per-target without killing the batch", async () => {
    mockedCH.mockRejectedValueOnce(new Error("boom-1")).mockResolvedValueOnce([chSale()]);
    mockedCS.mockResolvedValue(csPricing());
    const result = await runHistoricalBackfill([
      { chCardId: "ch-fail", csCardId: null, identity },
      { chCardId: "ch-ok", csCardId: null, identity },
    ]);
    expect(result.perTarget[0].errors[0]).toContain("ch:boom-1");
    expect(result.perTarget[0].chSalesWritten).toBe(0);
    expect(result.perTarget[1].chSalesWritten).toBe(1);
  });
});

// CF-THE-TITLE-OUTRANKS-THE-VENDOR-TAG reaches historicalBackfill (Drew,
// 2026-08-31). The CPA-VF case, exactly: a Red Ink SSP holding resolved to
// CardHedge's ONLY CPA-VF product — a BASE auto whose 315 rows all carry
// variant "Base" — and 50 of that base product's ~$11 sales were stamped with
// the HOLDING's parallel and written onto the SSP slug. FMV fell to $9.38.
describe("the title outranks the holding's parallel (CPA-VF regression)", () => {
  const redInkIdentity = {
    playerName: "Vaughn Fisher",
    cardYear: 2026,
    setName: "Bowman Chrome",
    parallel: "Black & White Red Ink",
    cardNumber: "CPA-VF",
    isAuto: true,
  };
  // Real shape of the intruders: base-auto titles, none naming red ink.
  const baseTitles = [
    "2026 Bowman Chrome Vaughn Fisher 1st Bowman Auto #CPA-VF - Raw",
    "Vaughn Fisher 2026 Bowman Chrome Prospect Autograph CPA-VF",
    "2026 Bowman Chrome Vaughn Fisher Rookie Auto #CPA-VF",
  ];

  it("50 base-titled sales onto an SSP target write ZERO rows on the SSP slug", async () => {
    mockedCH.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) =>
        chSale({
          price: 11 + (i % 9),
          date: `2026-0${(i % 8) + 1}-15T00:00:00Z`,
          title: baseTitles[i % baseTitles.length],
        }),
      ),
    );
    mockedCS.mockResolvedValue(csPricing());
    await runHistoricalBackfill([
      { chCardId: "1778540428361x447194681698603460", csCardId: null, identity: redInkIdentity },
    ]);
    const written = Array.from(store.values());
    // Not one row may carry the holding's SSP parallel.
    expect(written.filter((d) => /red ink/i.test(String(d.parallel ?? "")))).toHaveLength(0);
    expect(written.filter((d) => /red-ink/i.test(String(d.hobbyiqCardId ?? "")))).toHaveLength(0);
  });

  it("the whole target is refused when the vendor product is Base and the holding is an SSP", async () => {
    mockedCH.mockResolvedValue(
      Array.from({ length: 50 }, () => chSale({ price: 11, title: baseTitles[0] })),
    );
    mockedCS.mockResolvedValue(csPricing());
    const result = await runHistoricalBackfill([
      { chCardId: "ch-cpa-vf", csCardId: null, identity: redInkIdentity },
    ]);
    expect(result.totalCHSalesWritten).toBe(0);
    expect(store.size).toBe(0);
  });

  it("the Cardsight path refuses the same way", async () => {
    mockedCH.mockResolvedValue([]);
    mockedCS.mockResolvedValue(csPricing({
      raw: { count: 2, records: [
        { price: 11, date: "2026-05-01T00:00:00Z", title: baseTitles[0] },
        { price: 12, date: "2026-06-01T00:00:00Z", title: baseTitles[1] },
      ] as any },
    }));
    const result = await runHistoricalBackfill([
      { chCardId: null, csCardId: "cs-cpa-vf", identity: redInkIdentity },
    ]);
    expect(result.totalCSSalesWritten).toBe(0);
    expect(store.size).toBe(0);
  });

  // The healthy direction: the gate must not become a blanket refusal.
  it("a title that DOES name the finish still lands on the SSP identity", async () => {
    mockedCH.mockResolvedValue([
      chSale({ price: 270, date: "2026-08-01T00:00:00Z", title: "2026 Bowman Chrome Vaughn Fisher 1st Auto Black & White Red Ink #CPA-VF" }),
      chSale({ price: 250, date: "2026-07-01T00:00:00Z", title: "Vaughn Fisher 2026 Bowman Chrome Black and White Red Ink Auto CPA-VF" }),
    ]);
    mockedCS.mockResolvedValue(csPricing());
    const result = await runHistoricalBackfill([
      { chCardId: "ch-cpa-vf-ssp", csCardId: null, identity: redInkIdentity },
    ]);
    expect(result.totalCHSalesWritten).toBe(2);
    const written = Array.from(store.values());
    expect(written).toHaveLength(2);
    // The parser reads these as "Black White Red" (it drops "&" and "Ink");
    // the vendor tag is the same finish spelled in full, so it is adopted —
    // one card, one row, one pool.
    expect(written.every((d) => /red ink/i.test(String(d.parallel ?? "")))).toBe(true);
  });

  it("a non-SSP holding still gets its base sales — the gate is scoped to rarity", async () => {
    mockedCH.mockResolvedValue([chSale({ price: 12, title: baseTitles[0] })]);
    mockedCS.mockResolvedValue(csPricing());
    const result = await runHistoricalBackfill([
      { chCardId: "ch-base", csCardId: null, identity: { ...redInkIdentity, parallel: null } },
    ]);
    expect(result.totalCHSalesWritten).toBe(1);
  });

  it("a title naming a DIFFERENT finish is written as that finish, never the holding's", async () => {
    mockedCH.mockResolvedValue([
      chSale({ price: 60, title: "2026 Bowman Chrome Vaughn Fisher 1st Auto Blue Refractor /150 #CPA-VF" }),
    ]);
    mockedCS.mockResolvedValue(csPricing());
    await runHistoricalBackfill([
      { chCardId: "ch-blue", csCardId: null, identity: redInkIdentity },
    ]);
    const written = Array.from(store.values());
    expect(written).toHaveLength(1);
    expect(String(written[0].parallel ?? "")).toMatch(/blue/i);
    expect(String(written[0].parallel ?? "")).not.toMatch(/red ink/i);
  });
});

describe("buildTargetsFromHoldings — holding → target mapping", () => {
  it("routes CH bubble.io format (Nx...) cardId to chCardId (CF-BACKFILL-CARDID-FORMAT)", () => {
    // Live evidence 2026-07-15: 16 of Drew's 17 non-empty cardIds are
    // CH bubble format. Previous behavior treated them as CS UUIDs and
    // wrote 0 backfill records.
    const targets = buildTargetsFromHoldings([{
      cardId: "1778540952494x233768468903861100",
      playerName: "Owen Carey",
    }]);
    expect(targets).toHaveLength(1);
    expect(targets[0].chCardId).toBe("1778540952494x233768468903861100");
    expect(targets[0].csCardId).toBeNull();
  });

  it("routes CS UUID format cardId to csCardId", () => {
    const targets = buildTargetsFromHoldings([{
      cardId: "1617d20b-c6b7-470e-a227-3a5d75735c5a",
      playerName: "Bobby Witt Jr",
    }]);
    expect(targets).toHaveLength(1);
    expect(targets[0].csCardId).toBe("1617d20b-c6b7-470e-a227-3a5d75735c5a");
    expect(targets[0].chCardId).toBeNull();
  });

  it("explicit chCardId field wins when set (overrides cardId's inferred routing)", () => {
    const targets = buildTargetsFromHoldings([{
      cardId: "1617d20b-c6b7-470e-a227-3a5d75735c5a",  // CS UUID
      chCardId: "1234567890x0987654321",                  // explicit CH
      playerName: "P",
    }]);
    expect(targets[0].chCardId).toBe("1234567890x0987654321");
    expect(targets[0].csCardId).toBe("1617d20b-c6b7-470e-a227-3a5d75735c5a");
  });

  it("skips holdings with no cardId anywhere", () => {
    const targets = buildTargetsFromHoldings([{ playerName: "Bobby Witt Jr" }]);
    expect(targets).toHaveLength(0);
  });

  it("skips backstop-synthetic 'cardsight:x::y' compound cardIds (not queryable via CS getPricing)", () => {
    const targets = buildTargetsFromHoldings([{
      cardId: "cardsight:parent-uuid::par-uuid",
      chCardId: null,
      playerName: "Bobby Witt Jr",
    }]);
    // No ch, no valid cs → skipped
    expect(targets).toHaveLength(0);
  });

  it("uses holding's grade for CH sales grade filter when present", () => {
    const targets = buildTargetsFromHoldings([{
      cardId: "1234567890x098",  // CH bubble format
      playerName: "P", gradeCompany: "PSA", gradeValue: 10,
    }]);
    expect(targets[0].grade).toBe("PSA 10");
  });

  it("defaults grade to 'Raw' when ungraded", () => {
    const targets = buildTargetsFromHoldings([{
      cardId: "1234567890x098",  // CH bubble format
      playerName: "P",
    }]);
    expect(targets[0].grade).toBe("Raw");
  });

  it("skips 'unknown' cardId formats (not a UUID, bubble, or backstop)", () => {
    const targets = buildTargetsFromHoldings([{
      cardId: "garbage-not-uuid-not-bubble",
      playerName: "P",
    }]);
    expect(targets).toHaveLength(0);
  });
});
