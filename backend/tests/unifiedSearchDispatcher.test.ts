// CF-UNIFIED-SEARCH-AND-CERT v1 W3 — unified search dispatcher tests.
//
// Covers:
//   - empty input → empty_input warning
//   - hint resolution (hint=cert / hint=freetext / auto-detect)
//   - cert mode: success, per-grader failure surfaces as warning,
//     ordering contract (Drew Addition 2), hint=cert with no
//     recognizers fans out to all registered graders, defensive
//     numeric-vs-numeric handled by individual graders (not dispatcher)
//   - freetext mode: searchCatalog → rankCatalogHits → adapter
//
// Mocks `searchCatalog` and resets the cert-grader registry between
// tests via the W2 test-only escape hatch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/compiq/catalogSource.js", () => ({
  searchCatalog: vi.fn(),
  getCardDetail: vi.fn(),
}));

import {
  getCardDetail,
  searchCatalog,
} from "../src/services/compiq/catalogSource.js";
import { dispatchSearch } from "../src/services/unifiedSearch/dispatcher.js";
import {
  __resetRegistryForTest,
  registerCertGrader,
} from "../src/services/certGraders/registry.js";
import {
  CertGraderError,
  type CertGrader,
} from "../src/services/certGraders/certGrader.js";
import type { CardIdentity } from "../src/types/cardIdentity.js";

const mockedSearchCatalog = searchCatalog as unknown as ReturnType<typeof vi.fn>;
const mockedGetCardDetail = getCardDetail as unknown as ReturnType<typeof vi.fn>;

function makeIdentity(overrides: Partial<CardIdentity> = {}): CardIdentity {
  return {
    candidateId: "stub:0",
    source: "psa-cert",
    attribution: "authoritative",
    confidence: 1.0,
    player: null,
    year: null,
    brand: null,
    setName: null,
    cardNumber: null,
    parallel: null,
    variation: null,
    isAuto: false,
    serialNumber: null,
    grade: null,
    gradeCompany: null,
    gradeValue: null,
    certNumber: null,
    totalPopulation: null,
    populationHigher: null,
    title: "stub",
    imageUrl: null,
    ...overrides,
  };
}

function makeGrader(opts: {
  id: string;
  recognizes?: (s: string) => boolean;
  lookupResolved?: unknown;
  lookupRejected?: unknown;
}): CertGrader {
  return {
    id: opts.id,
    displayName: opts.id.toUpperCase(),
    recognizes: opts.recognizes ?? (() => false),
    async lookup() {
      if (opts.lookupRejected !== undefined) throw opts.lookupRejected;
      return (
        (opts.lookupResolved as {
          rawCertNumber: string;
          certificationType: string;
          cardRaw: unknown;
          totalPopulation: number | null;
          populationHigher: number | null;
        }) ?? {
          rawCertNumber: "0",
          certificationType: "stub",
          cardRaw: null,
          totalPopulation: null,
          populationHigher: null,
        }
      );
    },
    toCardIdentity() {
      return makeIdentity({ candidateId: `${opts.id}:fixture` });
    },
  };
}

beforeEach(() => {
  __resetRegistryForTest();
  mockedSearchCatalog.mockReset();
  mockedGetCardDetail.mockReset();
  // Default detail mock returns a minimal valid CardsightCardDetail so
  // dispatcher tests that don't care about enrichment specifics get
  // sensible behavior without per-test setup.
  mockedGetCardDetail.mockResolvedValue({
    id: "stub",
    name: "stub",
    number: "1",
    releaseName: "stub",
    setName: "stub",
    year: 2024,
    parallels: [],
    attributes: [],
  });
});

afterEach(() => {
  __resetRegistryForTest();
});

// ─────────────────────────────────────────────────────────────────────────
// Empty input
// ─────────────────────────────────────────────────────────────────────────

describe("dispatchSearch — empty input", () => {
  it("returns empty candidates + 'empty_input' warning, mode=freetext", async () => {
    const r = await dispatchSearch("");
    expect(r.input.raw).toBe("");
    expect(r.input.detectedMode).toBe("freetext");
    expect(r.candidates).toEqual([]);
    expect(r.warnings).toEqual(["empty_input"]);
  });

  it("treats whitespace-only as empty", async () => {
    const r = await dispatchSearch("   \n\t  ");
    expect(r.warnings).toEqual(["empty_input"]);
    expect(r.candidates).toEqual([]);
  });

  it("treats undefined as empty without throwing", async () => {
    const r = await dispatchSearch(undefined as unknown as string);
    expect(r.warnings).toEqual(["empty_input"]);
    expect(r.candidates).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Mode resolution
// ─────────────────────────────────────────────────────────────────────────

describe("dispatchSearch — mode resolution", () => {
  it("auto-detects cert mode when a grader recognizes the input", async () => {
    registerCertGrader(makeGrader({ id: "psa", recognizes: () => true }));
    const r = await dispatchSearch("12345678");
    expect(r.input.detectedMode).toBe("cert");
  });

  it("auto-detects freetext mode when no grader recognizes", async () => {
    registerCertGrader(makeGrader({ id: "psa", recognizes: () => false }));
    mockedSearchCatalog.mockResolvedValueOnce([]);
    const r = await dispatchSearch("Bobby Witt Jr");
    expect(r.input.detectedMode).toBe("freetext");
  });

  it("hint=freetext overrides a recognizing grader", async () => {
    registerCertGrader(makeGrader({ id: "psa", recognizes: () => true }));
    const r = await dispatchSearch("12345678", "freetext");
    expect(r.input.detectedMode).toBe("freetext");
  });

  it("hint=cert with no recognizers fans out to ALL registered graders", async () => {
    registerCertGrader(makeGrader({ id: "psa", recognizes: () => false }));
    registerCertGrader(makeGrader({ id: "bgs", recognizes: () => false }));
    const r = await dispatchSearch("ambiguous", "cert");
    expect(r.input.detectedMode).toBe("cert");
    expect(r.input.recognizingGraders).toEqual(["psa", "bgs"]);
    // Both graders produced candidates (stub fixture by default)
    expect(r.candidates).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cert mode
// ─────────────────────────────────────────────────────────────────────────

describe("dispatchSearch — cert mode", () => {
  it("returns 1 authoritative candidate on successful PSA-style lookup", async () => {
    registerCertGrader(
      makeGrader({
        id: "psa",
        recognizes: (s) => /^\d{6,12}$/.test(s),
      }),
    );
    const r = await dispatchSearch("76556858");
    expect(r.input.detectedMode).toBe("cert");
    expect(r.input.recognizingGraders).toEqual(["psa"]);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].candidateId).toBe("psa:fixture");
    expect(r.warnings).toEqual([]);
  });

  it("surfaces per-grader failure as 'graderId_cert_lookup_failed:CODE' warning", async () => {
    registerCertGrader(
      makeGrader({
        id: "psa",
        recognizes: () => true,
        lookupRejected: new CertGraderError("quota", "psa", "QUOTA_EXCEEDED"),
      }),
    );
    const r = await dispatchSearch("12345678");
    expect(r.candidates).toEqual([]);
    expect(r.warnings).toEqual(["psa_cert_lookup_failed:QUOTA_EXCEEDED"]);
  });

  it("classifies non-CertGraderError rejection codes as UNKNOWN", async () => {
    registerCertGrader(
      makeGrader({
        id: "psa",
        recognizes: () => true,
        lookupRejected: new Error("network exploded"),
      }),
    );
    const r = await dispatchSearch("12345678");
    expect(r.warnings).toEqual(["psa_cert_lookup_failed:UNKNOWN"]);
  });

  it("dispatches to multiple recognizers in parallel; partial failure surfaces both outcomes", async () => {
    registerCertGrader(
      makeGrader({ id: "psa", recognizes: () => true }),
    );
    registerCertGrader(
      makeGrader({
        id: "bgs",
        recognizes: () => true,
        lookupRejected: new CertGraderError("timeout", "bgs", "TIMEOUT"),
      }),
    );
    const r = await dispatchSearch("12345678");
    expect(r.input.recognizingGraders).toEqual(["psa", "bgs"]);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].candidateId).toBe("psa:fixture");
    expect(r.warnings).toEqual(["bgs_cert_lookup_failed:TIMEOUT"]);
  });

  // Drew Addition 2 — ordering contract test
  it("emits recognizingGraders in registry insertion order (ordering contract)", async () => {
    registerCertGrader(makeGrader({ id: "alpha", recognizes: () => true }));
    registerCertGrader(makeGrader({ id: "bravo", recognizes: () => true }));
    registerCertGrader(makeGrader({ id: "charlie", recognizes: () => true }));
    const r = await dispatchSearch("any-input");
    expect(r.input.recognizingGraders).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("hint=cert + no grader recognizes does not query searchCatalog", async () => {
    registerCertGrader(makeGrader({ id: "psa", recognizes: () => false }));
    await dispatchSearch("anything", "cert");
    expect(mockedSearchCatalog).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Freetext mode — now backed by CardHedge via searchCardsRouted (the
// Cardsight catalog seam is gone). With no CARD_HEDGE_API_KEY in the test
// environment the CH client returns zero hits, so dispatchFreetextMode
// yields zero candidates plus a "no_freetext_matches" warning
// (dispatcher.ts:163). Cert-mode lookups (PSA, etc.) remain the only
// candidate-producing path under test.
// ──────────────────────────────────────────────────────────────────

describe("dispatchSearch — freetext mode", () => {
  it("returns zero candidates and the no-matches warning when CH yields nothing", async () => {
    const r = await dispatchSearch("Bobby Witt Jr");
    expect(r.input.detectedMode).toBe("freetext");
    expect(r.candidates).toEqual([]);
    expect(r.warnings).toEqual(["no_freetext_matches"]);
  });

  it("never queries searchCatalog in freetext mode", async () => {
    await dispatchSearch("nonexistent player");
    expect(mockedSearchCatalog).not.toHaveBeenCalled();
  });
});
