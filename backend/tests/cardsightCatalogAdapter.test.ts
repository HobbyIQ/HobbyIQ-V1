// CF-UNIFIED-SEARCH-AND-CERT v1 W3 + W5-Windows — Cardsight catalog adapter tests.
//
// Covers the exported helpers:
//   - cardsightCatalogToCardIdentity (shape mapping + year=0 sentinel
//                                     + W5 detail enrichment)
//   - detectAutoFromBlob              (autograph signal across fields)
//   - buildCatalogTitle               (display string composition)
//   - enrichWithDetails               (W5 concurrency-limited detail
//                                     fetch + partial-failure semantics)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/compiq/cardsight.client.js", async () => {
  const actual = await vi.importActual<any>("../src/services/compiq/cardsight.client.js");
  return {
    ...actual,
    getCardDetail: vi.fn(),
  };
});

import {
  getCardDetail,
  type CardsightCardDetail,
  type CardsightCatalogResult,
  type CardsightParallel,
} from "../src/services/compiq/cardsight.client.js";
import {
  buildCatalogTitle,
  cardsightCatalogToCardIdentity,
  detectAutoFromBlob,
  enrichWithDetails,
} from "../src/services/unifiedSearch/cardsightCatalogAdapter.js";

const mockedGetCardDetail = getCardDetail as unknown as ReturnType<typeof vi.fn>;

function makeCatalogResult(overrides: Partial<CardsightCatalogResult> = {}): CardsightCatalogResult {
  return {
    id: "c-fixture",
    name: "Base Card",
    number: "1",
    releaseName: "Topps Chrome",
    setName: "Base Set",
    year: 2024,
    player: "Sample Player",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// cardsightCatalogToCardIdentity
// ─────────────────────────────────────────────────────────────────────────

describe("cardsightCatalogToCardIdentity", () => {
  it("maps a typical hit into a ranked CardIdentity", () => {
    const hit = makeCatalogResult({
      id: "abc-123",
      name: "Bobby Witt Jr",
      number: "BCP-50",
      releaseName: "Bowman Chrome Prospects",
      setName: "Chrome Prospect Auto",
      year: 2020,
      player: "Bobby Witt Jr",
    });

    const id = cardsightCatalogToCardIdentity(hit, 0.875);

    expect(id.candidateId).toBe("cardsight:abc-123");
    expect(id.source).toBe("cardsight-catalog");
    expect(id.attribution).toBe("ranked");
    expect(id.confidence).toBe(0.875);

    expect(id.player).toBe("Bobby Witt Jr");
    expect(id.year).toBe(2020);
    expect(id.brand).toBe("Bowman Chrome Prospects");
    expect(id.setName).toBe("Chrome Prospect Auto");
    expect(id.cardNumber).toBe("BCP-50");
    expect(id.parallel).toBeNull();
    expect(id.variation).toBeNull();
    expect(id.isAuto).toBe(true); // "Prospect Auto" + "BCP-" prefix
    expect(id.serialNumber).toBeNull();

    expect(id.grade).toBeNull();
    expect(id.gradeCompany).toBeNull();
    expect(id.gradeValue).toBeNull();
    expect(id.certNumber).toBeNull();
    expect(id.totalPopulation).toBeNull();
    expect(id.populationHigher).toBeNull();

    expect(id.title).toContain("2020");
    expect(id.title).toContain("Bobby Witt Jr");
    expect(id.imageUrl).toBeNull();
    expect(id.raw).toBe(hit);
  });

  // Drew Addition 1 — year=0 sentinel handling
  it("treats year=0 (Cardsight not-found sentinel) as null", () => {
    const hit = makeCatalogResult({ year: 0 });
    const id = cardsightCatalogToCardIdentity(hit, 1.0);
    expect(id.year).toBeNull();
  });

  it("passes a real year through unchanged", () => {
    const hit = makeCatalogResult({ year: 1987 });
    const id = cardsightCatalogToCardIdentity(hit, 1.0);
    expect(id.year).toBe(1987);
  });

  it("falls back from player → name when player is missing", () => {
    const hit = makeCatalogResult({ player: undefined, name: "Greg Maddux" });
    const id = cardsightCatalogToCardIdentity(hit, 1.0);
    expect(id.player).toBe("Greg Maddux");
  });

  it("emits null player when both player and name are empty strings", () => {
    const hit = makeCatalogResult({ player: "", name: "" });
    const id = cardsightCatalogToCardIdentity(hit, 1.0);
    // Empty string is falsy → c.player ?? c.name ?? null picks the
    // empty player (?? only checks null/undefined). Document the
    // current behavior explicitly so a future change is intentional.
    expect(id.player).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// detectAutoFromBlob
// ─────────────────────────────────────────────────────────────────────────

describe("detectAutoFromBlob", () => {
  it("detects 'Auto' token in setName", () => {
    expect(detectAutoFromBlob(makeCatalogResult({ setName: "Chrome Auto" }))).toBe(true);
  });

  it("detects 'Autograph' token in releaseName", () => {
    expect(detectAutoFromBlob(makeCatalogResult({ releaseName: "Topps Prospect Autographs" }))).toBe(true);
  });

  it("detects 'Signature' token in name", () => {
    expect(detectAutoFromBlob(makeCatalogResult({ name: "Rookie Signature" }))).toBe(true);
  });

  it("detects 'Signed' token", () => {
    expect(detectAutoFromBlob(makeCatalogResult({ setName: "Signed Edition" }))).toBe(true);
  });

  it("detects 'CPA' number-prefix autograph subset code", () => {
    expect(detectAutoFromBlob(makeCatalogResult({ number: "CPA-BWJ" }))).toBe(true);
  });

  it("detects 'BDPA' number-prefix autograph subset code", () => {
    expect(detectAutoFromBlob(makeCatalogResult({ number: "BDPA-50" }))).toBe(true);
  });

  it("does NOT trigger on unrelated text", () => {
    expect(
      detectAutoFromBlob(
        makeCatalogResult({
          name: "Base Card",
          number: "1",
          releaseName: "Topps Chrome",
          setName: "Base Set",
          player: "Sample Player",
        }),
      ),
    ).toBe(false);
  });

  it("does NOT trigger on 'autobiography' partial-word noise (word-boundary check)", () => {
    expect(detectAutoFromBlob(makeCatalogResult({ name: "Player Autobiography" }))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildCatalogTitle
// ─────────────────────────────────────────────────────────────────────────

describe("buildCatalogTitle", () => {
  it("composes year + releaseName + player + #number", () => {
    expect(
      buildCatalogTitle(
        makeCatalogResult({
          year: 2024,
          releaseName: "Topps Chrome Update",
          player: "Bobby Witt Jr",
          number: "USC50",
        }),
      ),
    ).toBe("2024 Topps Chrome Update Bobby Witt Jr #USC50");
  });

  it("prefers releaseName over setName when both present", () => {
    const title = buildCatalogTitle(
      makeCatalogResult({
        year: 2024,
        releaseName: "Topps Chrome",
        setName: "Base Set",
        player: "Player",
        number: "1",
      }),
    );
    expect(title).toContain("Topps Chrome");
    expect(title).not.toContain("Base Set");
  });

  it("falls back to setName when releaseName is empty", () => {
    expect(
      buildCatalogTitle(
        makeCatalogResult({
          year: 2024,
          releaseName: "",
          setName: "Vintage",
          player: "Player",
          number: "1",
        }),
      ),
    ).toContain("Vintage");
  });

  it("drops year=0 sentinel from title", () => {
    const title = buildCatalogTitle(
      makeCatalogResult({ year: 0, releaseName: "Topps", player: "P", number: "1" }),
    );
    expect(title).not.toContain("0");
    expect(title).toContain("Topps");
  });

  it("falls back to `name` when all structured fields are empty", () => {
    expect(
      buildCatalogTitle({
        id: "x",
        name: "Last Resort Title",
        number: "",
        releaseName: "",
        setName: "",
        year: 0,
      }),
    ).toBe("Last Resort Title");
  });

  it("returns 'Unknown card' when name is also empty", () => {
    expect(
      buildCatalogTitle({
        id: "x",
        name: "",
        number: "",
        releaseName: "",
        setName: "",
        year: 0,
      }),
    ).toBe("Unknown card");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// W5-Windows — detail-enriched cardsightCatalogToCardIdentity
// ─────────────────────────────────────────────────────────────────────────

function makeParallel(name: string, numberedTo?: number): CardsightParallel {
  return {
    id: `par-${name.replace(/\s+/g, "-").toLowerCase()}`,
    name,
    ...(numberedTo !== undefined ? { numberedTo } : {}),
  };
}

function makeDetail(overrides: Partial<CardsightCardDetail> = {}): CardsightCardDetail {
  return {
    id: "c-fixture",
    name: "Detail Name",
    number: "1",
    releaseName: "Topps Chrome Update",
    setName: "Base Set",
    year: 2022,
    parallels: [],
    attributes: [],
    ...overrides,
  };
}

describe("cardsightCatalogToCardIdentity — W5 detail enrichment", () => {
  it("populates parallels[] when detail is supplied", () => {
    const hit = makeCatalogResult();
    const detail = makeDetail({
      parallels: [
        makeParallel("Refractor", 299),
        makeParallel("Blue Refractor", 199),
        makeParallel("SuperFractor", 1),
      ],
    });
    const id = cardsightCatalogToCardIdentity(hit, 1.0, detail);
    expect(id.parallels).toHaveLength(3);
    expect(id.parallels?.[0].name).toBe("Refractor");
    expect(id.parallels?.[2].numberedTo).toBe(1);
  });

  it("populates attributes[] when detail is supplied", () => {
    const hit = makeCatalogResult();
    const detail = makeDetail({ attributes: ["MLB-KCR", "RC"] });
    const id = cardsightCatalogToCardIdentity(hit, 1.0, detail);
    expect(id.attributes).toEqual(["MLB-KCR", "RC"]);
  });

  it("leaves parallels and attributes undefined when detail is omitted (cert-path / no enrichment)", () => {
    const hit = makeCatalogResult();
    const id = cardsightCatalogToCardIdentity(hit, 1.0);
    expect(id.parallels).toBeUndefined();
    expect(id.attributes).toBeUndefined();
  });

  it("leaves parallels and attributes undefined when detail is notFound sentinel", () => {
    const hit = makeCatalogResult();
    const detail: CardsightCardDetail = {
      ...makeDetail(),
      parallels: [makeParallel("ignored")],
      attributes: ["IGNORED"],
      notFound: true,
    };
    const id = cardsightCatalogToCardIdentity(hit, 1.0, detail);
    expect(id.parallels).toBeUndefined();
    expect(id.attributes).toBeUndefined();
  });

  it("attributes defaults to empty array when detail has parallels but no attributes field", () => {
    const hit = makeCatalogResult();
    const detail = makeDetail({
      parallels: [makeParallel("Refractor")],
      // attributes intentionally omitted from this override; makeDetail
      // defaults to [] but the runtime can also see undefined from older
      // cached responses.
    });
    delete (detail as { attributes?: string[] }).attributes;
    const id = cardsightCatalogToCardIdentity(hit, 1.0, detail);
    expect(id.parallels).toHaveLength(1);
    expect(id.attributes).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// enrichWithDetails — concurrency + partial-failure semantics
// ─────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockedGetCardDetail.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("enrichWithDetails", () => {
  it("returns empty array on empty input without calling getCardDetail", async () => {
    const out = await enrichWithDetails([]);
    expect(out).toEqual([]);
    expect(mockedGetCardDetail).not.toHaveBeenCalled();
  });

  it("maps each hit to its detail in input order", async () => {
    mockedGetCardDetail
      .mockResolvedValueOnce(makeDetail({ id: "a", parallels: [makeParallel("A")] }))
      .mockResolvedValueOnce(makeDetail({ id: "b", parallels: [makeParallel("B")] }))
      .mockResolvedValueOnce(makeDetail({ id: "c", parallels: [makeParallel("C")] }));
    const hits = [
      makeCatalogResult({ id: "a" }),
      makeCatalogResult({ id: "b" }),
      makeCatalogResult({ id: "c" }),
    ];
    const out = await enrichWithDetails(hits);
    expect(out).toHaveLength(3);
    expect(out[0].detail?.parallels[0].name).toBe("A");
    expect(out[1].detail?.parallels[0].name).toBe("B");
    expect(out[2].detail?.parallels[0].name).toBe("C");
  });

  it("preserves the hit on a failed detail fetch with detail=undefined (partial-failure tolerance)", async () => {
    mockedGetCardDetail
      .mockResolvedValueOnce(makeDetail({ id: "ok" }))
      .mockRejectedValueOnce(new Error("upstream-blew-up"))
      .mockResolvedValueOnce(makeDetail({ id: "fine" }));
    const hits = [
      makeCatalogResult({ id: "ok" }),
      makeCatalogResult({ id: "boom" }),
      makeCatalogResult({ id: "fine" }),
    ];
    const out = await enrichWithDetails(hits);
    expect(out).toHaveLength(3);
    expect(out[0].detail?.id).toBe("ok");
    expect(out[1].detail).toBeUndefined();
    expect(out[2].detail?.id).toBe("fine");
  });

  it("notFound-sentinel detail maps to undefined (treated the same as a thrown error)", async () => {
    mockedGetCardDetail.mockResolvedValueOnce({
      ...makeDetail({ id: "x" }),
      notFound: true,
    });
    const out = await enrichWithDetails([makeCatalogResult({ id: "x" })]);
    expect(out[0].detail).toBeUndefined();
  });

  it("emits the aggregated cardsight_detail_fetch_partial_failure warn event when any fetch throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedGetCardDetail
      .mockResolvedValueOnce(makeDetail({ id: "a" }))
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom2"));
    await enrichWithDetails([
      makeCatalogResult({ id: "a" }),
      makeCatalogResult({ id: "b" }),
      makeCatalogResult({ id: "c" }),
    ]);
    const warnedJson = warnSpy.mock.calls.find((call) =>
      String(call[0]).includes("cardsight_detail_fetch_partial_failure"),
    );
    expect(warnedJson).toBeDefined();
    const payload = JSON.parse(String(warnedJson![0]));
    expect(payload.event).toBe("cardsight_detail_fetch_partial_failure");
    expect(payload.source).toBe("unifiedSearch.cardsightCatalogAdapter");
    expect(payload.totalHits).toBe(3);
    expect(payload.failures).toBe(2);
    warnSpy.mockRestore();
  });

  it("does NOT emit the partial-failure event when every fetch succeeds", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedGetCardDetail
      .mockResolvedValueOnce(makeDetail({ id: "a" }))
      .mockResolvedValueOnce(makeDetail({ id: "b" }));
    await enrichWithDetails([
      makeCatalogResult({ id: "a" }),
      makeCatalogResult({ id: "b" }),
    ]);
    const partialFailureWarned = warnSpy.mock.calls.some((call) =>
      String(call[0]).includes("cardsight_detail_fetch_partial_failure"),
    );
    expect(partialFailureWarned).toBe(false);
    warnSpy.mockRestore();
  });
});
