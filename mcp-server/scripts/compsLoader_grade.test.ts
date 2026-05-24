// Unit tests for compsLoader's grade-flow fix (CF-COMPSLOADER-GRADE-FLOW).
//
// Verifies that fetchPlayerComps forwards preferredGrade to the backend
// /api/compiq/comps-by-player endpoint as gradeCompany + gradeValue query
// params, so the backend's translateResponse picks the matching graded path.
//
// Mechanism: stubs global.fetch with a recording function, calls
// fetchPlayerComps with each grade variant, asserts the captured URL contains
// (or omits) the expected query params.
//
// Run: cd mcp-server && node --import tsx --test scripts/compsLoader_grade.test.ts

import { describe, it, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";

// Backend URL must be set BEFORE the module under test loads — compsLoader
// captures it at module-init time. Static imports are hoisted in ESM, so we
// use a dynamic import below to control timing.
process.env.HOBBYIQ_BACKEND_URL = "http://test-backend.invalid";

// Test-time bindings, populated in before() via dynamic import.
let fetchPlayerComps: typeof import("../compsLoader.js").fetchPlayerComps;
let parseGradeForBackend: typeof import("../compsLoader.js").parseGradeForBackend;

type Fetch = typeof globalThis.fetch;

interface FetchCall {
  url: string;
  init?: RequestInit;
}

const originalFetch: Fetch = globalThis.fetch;
let calls: FetchCall[] = [];

function stubFetch(responseBody: unknown, status = 200): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as Fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

const okResponseBody = {
  player: "Mike Trout",
  product: "Topps Update",
  cardYear: 2011,
  cardIds: ["c1"],
  comps: [
    { cardId: "c1", price: 350, date: "2026-05-20T00:00:00Z", title: "Mike Trout US175", source: "cardsight" },
  ],
  cached: false,
  warnings: [],
};

before(async () => {
  const mod = await import("../compsLoader.js");
  fetchPlayerComps = mod.fetchPlayerComps;
  parseGradeForBackend = mod.parseGradeForBackend;
});

describe("parseGradeForBackend", () => {
  it('returns {} for undefined', () => {
    assert.deepEqual(parseGradeForBackend(undefined), {});
  });
  it('returns {} for empty string', () => {
    assert.deepEqual(parseGradeForBackend(""), {});
  });
  it('returns {} for "Raw"', () => {
    assert.deepEqual(parseGradeForBackend("Raw"), {});
  });
  it('returns {} for "raw" (case-insensitive)', () => {
    assert.deepEqual(parseGradeForBackend("raw"), {});
  });
  it('returns {} for "Ungraded"', () => {
    assert.deepEqual(parseGradeForBackend("Ungraded"), {});
  });
  it('parses "PSA 10" → company=PSA value=10', () => {
    assert.deepEqual(parseGradeForBackend("PSA 10"), { gradeCompany: "PSA", gradeValue: "10" });
  });
  it('parses "BGS 9.5" → company=BGS value=9.5', () => {
    assert.deepEqual(parseGradeForBackend("BGS 9.5"), { gradeCompany: "BGS", gradeValue: "9.5" });
  });
  it('parses "SGC 9" → company=SGC value=9', () => {
    assert.deepEqual(parseGradeForBackend("SGC 9"), { gradeCompany: "SGC", gradeValue: "9" });
  });
  it('parses "CGC 10" → company=CGC value=10', () => {
    assert.deepEqual(parseGradeForBackend("CGC 10"), { gradeCompany: "CGC", gradeValue: "10" });
  });
  it('uppercases company token', () => {
    assert.deepEqual(parseGradeForBackend("psa 10"), { gradeCompany: "PSA", gradeValue: "10" });
  });
  it('returns {} for "PSA" alone (no number — unparseable)', () => {
    assert.deepEqual(parseGradeForBackend("PSA"), {});
  });
  it('returns {} for "10" alone (no company — unparseable)', () => {
    assert.deepEqual(parseGradeForBackend("10"), {});
  });
  it('returns {} for "MINT 10" (looks parseable but treats as unknown)', () => {
    // Logic is permissive: any letters + numeric value pattern matches. Backend
    // will reject unknown company at translateResponse with grade_company_not_found
    // warning and return []. This is intended fall-through behavior.
    assert.deepEqual(parseGradeForBackend("MINT 10"), { gradeCompany: "MINT", gradeValue: "10" });
  });
});

describe("fetchPlayerComps grade-flow", () => {
  before(() => {
    stubFetch(okResponseBody);
  });
  beforeEach(() => {
    calls = [];
  });
  after(() => {
    restoreFetch();
  });

  it("forwards preferredGrade='PSA 10' as gradeCompany=PSA & gradeValue=10", async () => {
    await fetchPlayerComps("Mike Trout", "Topps Update", { cardYear: 2011, preferredGrade: "PSA 10" });
    assert.equal(calls.length, 1);
    const u = new URL(calls[0].url);
    assert.equal(u.searchParams.get("playerName"), "Mike Trout");
    assert.equal(u.searchParams.get("product"), "Topps Update");
    assert.equal(u.searchParams.get("cardYear"), "2011");
    assert.equal(u.searchParams.get("gradeCompany"), "PSA");
    assert.equal(u.searchParams.get("gradeValue"), "10");
  });

  it("forwards preferredGrade='BGS 9.5' as gradeCompany=BGS & gradeValue=9.5", async () => {
    await fetchPlayerComps("Aaron Judge", "Topps Update", { cardYear: 2017, preferredGrade: "BGS 9.5" });
    const u = new URL(calls[0].url);
    assert.equal(u.searchParams.get("gradeCompany"), "BGS");
    assert.equal(u.searchParams.get("gradeValue"), "9.5");
  });

  it("preferredGrade='Raw' produces no gradeCompany/gradeValue params", async () => {
    await fetchPlayerComps("Mike Trout", "Topps Update", { cardYear: 2011, preferredGrade: "Raw" });
    const u = new URL(calls[0].url);
    assert.equal(u.searchParams.has("gradeCompany"), false);
    assert.equal(u.searchParams.has("gradeValue"), false);
  });

  it("no preferredGrade (undefined) → no gradeCompany/gradeValue params (backward compat)", async () => {
    await fetchPlayerComps("Mike Trout", "Topps Update", { cardYear: 2011 });
    const u = new URL(calls[0].url);
    assert.equal(u.searchParams.has("gradeCompany"), false);
    assert.equal(u.searchParams.has("gradeValue"), false);
  });

  it("malformed grade 'PSA' (no number) → no params, no exception", async () => {
    await fetchPlayerComps("Mike Trout", "Topps Update", { cardYear: 2011, preferredGrade: "PSA" });
    const u = new URL(calls[0].url);
    assert.equal(u.searchParams.has("gradeCompany"), false);
    assert.equal(u.searchParams.has("gradeValue"), false);
  });

  it("returned comps still carry preferredGrade label (backward compat for renderers)", async () => {
    const comps = await fetchPlayerComps("Mike Trout", "Topps Update", { cardYear: 2011, preferredGrade: "PSA 10" });
    assert.equal(comps.length, 1);
    assert.equal(comps[0].grade, "PSA 10");
  });
});
