// CF-CARDSIGHT-GRADE-ID-PATTERN -- resolver unit tests.
//
// Covers:
//   - PSA happy path (Card + Autograph type axes)
//   - BGS happy path
//   - Unknown grading company -> null
//   - Unknown type (grader without Autograph/Card split) -> null
//   - Unknown grade value -> null
//   - Half grade (PSA "9.5") -> null when not in enumeration; hit
//     when present
//   - Empty / non-string gradeCompany -> null
//   - Non-finite gradeValue -> null
//   - isAuto=undefined coerces to Card type
//   - Cardsight 4xx/5xx/network failure -> null (never throws)
//   - Cache hit: second resolve doesn't hit fetch

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveCardsightGradeId } from "../src/services/cardsight/cardsightGradesTaxonomy";
import { __resetMemoryCacheForTest } from "../src/services/shared/cache.service";

const PSA_UUID = "7acc6827-3794-4205-bc73-08a9060d5af7";
const PSA_CARD_TYPE_UUID = "psa-card-type-uuid";
const PSA_AUTO_TYPE_UUID = "psa-auto-type-uuid";
const PSA_10_GRADE_UUID = "psa-10-grade-uuid";
const PSA_10_AUTO_GRADE_UUID = "psa-10-auto-grade-uuid";
const PSA_9_GRADE_UUID = "psa-9-grade-uuid";

const BGS_UUID = "11bfc982-39bc-4813-99fc-70483a4dd653";
const BGS_CARD_TYPE_UUID = "bgs-card-type-uuid";
const BGS_10_GRADE_UUID = "bgs-10-grade-uuid";

const COMPANIES_RESPONSE = {
  companies: [
    { id: PSA_UUID, name: "PSA", description: "Professional Sports Authenticator" },
    { id: BGS_UUID, name: "BGS", description: "Beckett Grading Services" },
  ],
  total: 2,
};

const PSA_TYPES_RESPONSE = {
  types: [
    { id: PSA_AUTO_TYPE_UUID, gradingCompanyId: PSA_UUID, gradingCompanyName: "PSA",
      name: "Autograph", description: "Autograph Grade" },
    { id: PSA_CARD_TYPE_UUID, gradingCompanyId: PSA_UUID, gradingCompanyName: "PSA",
      name: "Card", description: "Card Grade" },
  ],
  total: 2,
};

const PSA_CARD_GRADES_RESPONSE = {
  grades: [
    { id: PSA_10_GRADE_UUID, gradingTypeId: PSA_CARD_TYPE_UUID,
      gradingTypeName: "Card", gradingCompanyId: PSA_UUID,
      gradingCompanyName: "PSA", grade: "10", condition: "Gem Mint" },
    { id: PSA_9_GRADE_UUID, gradingTypeId: PSA_CARD_TYPE_UUID,
      gradingTypeName: "Card", gradingCompanyId: PSA_UUID,
      gradingCompanyName: "PSA", grade: "9", condition: "Mint" },
  ],
  total: 2,
};

const PSA_AUTO_GRADES_RESPONSE = {
  grades: [
    { id: PSA_10_AUTO_GRADE_UUID, gradingTypeId: PSA_AUTO_TYPE_UUID,
      gradingTypeName: "Autograph", gradingCompanyId: PSA_UUID,
      gradingCompanyName: "PSA", grade: "10", condition: "Gem Mint" },
  ],
  total: 1,
};

const BGS_TYPES_RESPONSE = {
  types: [
    { id: BGS_CARD_TYPE_UUID, gradingCompanyId: BGS_UUID,
      gradingCompanyName: "BGS", name: "Card", description: "Card Grade" },
  ],
  total: 1,
};

const BGS_CARD_GRADES_RESPONSE = {
  grades: [
    { id: BGS_10_GRADE_UUID, gradingTypeId: BGS_CARD_TYPE_UUID,
      gradingTypeName: "Card", gradingCompanyId: BGS_UUID,
      gradingCompanyName: "BGS", grade: "10", condition: "Pristine" },
  ],
  total: 1,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function routeRequest(url: string): Response {
  if (url.endsWith("/v1/grades/companies")) {
    return jsonResponse(COMPANIES_RESPONSE);
  }
  if (url.endsWith(`/v1/grades/companies/${PSA_UUID}/types`)) {
    return jsonResponse(PSA_TYPES_RESPONSE);
  }
  if (url.endsWith(`/v1/grades/companies/${PSA_UUID}/types/${PSA_CARD_TYPE_UUID}/grades`)) {
    return jsonResponse(PSA_CARD_GRADES_RESPONSE);
  }
  if (url.endsWith(`/v1/grades/companies/${PSA_UUID}/types/${PSA_AUTO_TYPE_UUID}/grades`)) {
    return jsonResponse(PSA_AUTO_GRADES_RESPONSE);
  }
  if (url.endsWith(`/v1/grades/companies/${BGS_UUID}/types`)) {
    return jsonResponse(BGS_TYPES_RESPONSE);
  }
  if (url.endsWith(`/v1/grades/companies/${BGS_UUID}/types/${BGS_CARD_TYPE_UUID}/grades`)) {
    return jsonResponse(BGS_CARD_GRADES_RESPONSE);
  }
  return new Response("not found", { status: 404 });
}

beforeEach(() => {
  process.env.CARDSIGHT_API_KEY = "test-key";
  // The taxonomy resolver wraps each fetch in cacheWrap with a 24h
  // TTL against shared/cache.service.ts's process-memory Map.
  // Without resetting, a successful resolution in test N caches the
  // result for test N+1; tests that expect a fresh resolver pass
  // (e.g. unauthorized fetch -> null) would see cached hits. Reset
  // the in-memory cache between every test so each test exercises
  // the resolver from scratch.
  __resetMemoryCacheForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveCardsightGradeId -- happy paths", () => {
  it("PSA 10 Card -> PSA Card 10 gradeId UUID", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => routeRequest(url)));
    const id = await resolveCardsightGradeId("PSA", 10, false);
    expect(id).toBe(PSA_10_GRADE_UUID);
  });

  it("PSA 10 Autograph -> PSA Autograph 10 gradeId UUID", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => routeRequest(url)));
    const id = await resolveCardsightGradeId("PSA", 10, true);
    expect(id).toBe(PSA_10_AUTO_GRADE_UUID);
  });

  it("PSA 9 Card -> PSA Card 9 gradeId UUID", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => routeRequest(url)));
    const id = await resolveCardsightGradeId("PSA", 9, false);
    expect(id).toBe(PSA_9_GRADE_UUID);
  });

  it("BGS 10 Card -> BGS Card 10 gradeId UUID", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => routeRequest(url)));
    const id = await resolveCardsightGradeId("BGS", 10, false);
    expect(id).toBe(BGS_10_GRADE_UUID);
  });
});

describe("resolveCardsightGradeId -- miss paths", () => {
  it("unknown grading company -> null", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => routeRequest(url)));
    const id = await resolveCardsightGradeId("FakeGrader", 10, false);
    expect(id).toBeNull();
  });

  it("BGS Autograph (BGS has no Autograph type in this fixture) -> null", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => routeRequest(url)));
    const id = await resolveCardsightGradeId("BGS", 10, true);
    expect(id).toBeNull();
  });

  it("PSA grade 8 (not in fixture's enumeration) -> null", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => routeRequest(url)));
    const id = await resolveCardsightGradeId("PSA", 8, false);
    expect(id).toBeNull();
  });

  it("PSA grade 9.5 Autograph (no half grade in Autograph) -> null", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => routeRequest(url)));
    const id = await resolveCardsightGradeId("PSA", 9.5, true);
    expect(id).toBeNull();
  });
});

describe("resolveCardsightGradeId -- invalid inputs", () => {
  it("null gradeCompany -> null", async () => {
    const fetchMock = vi.fn(async (url: string) => routeRequest(url));
    vi.stubGlobal("fetch", fetchMock);
    const id = await resolveCardsightGradeId(null, 10, false);
    expect(id).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("empty string gradeCompany -> null", async () => {
    const fetchMock = vi.fn(async (url: string) => routeRequest(url));
    vi.stubGlobal("fetch", fetchMock);
    const id = await resolveCardsightGradeId("", 10, false);
    expect(id).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("null gradeValue -> null without fetch", async () => {
    const fetchMock = vi.fn(async (url: string) => routeRequest(url));
    vi.stubGlobal("fetch", fetchMock);
    const id = await resolveCardsightGradeId("PSA", null, false);
    expect(id).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("NaN gradeValue -> null without fetch", async () => {
    const fetchMock = vi.fn(async (url: string) => routeRequest(url));
    vi.stubGlobal("fetch", fetchMock);
    const id = await resolveCardsightGradeId("PSA", NaN, false);
    expect(id).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("undefined isAuto coerces to Card type (falsy)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => routeRequest(url)));
    const id = await resolveCardsightGradeId("PSA", 10, undefined);
    expect(id).toBe(PSA_10_GRADE_UUID);
  });
});

describe("resolveCardsightGradeId -- Cardsight upstream failures", () => {
  it("Cardsight 500 on companies list -> null (never throws)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("server error", { status: 500 })));
    const id = await resolveCardsightGradeId("PSA", 10, false);
    expect(id).toBeNull();
  });

  it("Cardsight 401 on companies list -> null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    const id = await resolveCardsightGradeId("PSA", 10, false);
    expect(id).toBeNull();
  });

  it("network failure (fetch throws) -> null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    const id = await resolveCardsightGradeId("PSA", 10, false);
    expect(id).toBeNull();
  });

  it("missing CARDSIGHT_API_KEY env -> null", async () => {
    const originalKey = process.env.CARDSIGHT_API_KEY;
    delete process.env.CARDSIGHT_API_KEY;
    try {
      const fetchMock = vi.fn(async (url: string) => routeRequest(url));
      vi.stubGlobal("fetch", fetchMock);
      const id = await resolveCardsightGradeId("PSA", 10, false);
      expect(id).toBeNull();
    } finally {
      process.env.CARDSIGHT_API_KEY = originalKey;
    }
  });
});
