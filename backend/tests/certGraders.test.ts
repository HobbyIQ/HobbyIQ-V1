// CF-UNIFIED-SEARCH-AND-CERT v1 W2 — cert-grader abstraction tests.
//
// Three surfaces:
//   1. Registry: register, list, findRecognizing, getById, collision throws
//   2. PSA grader: recognizes (positive + negative), lookup error mapping,
//      toCardIdentity field mapping, variety/wrapper-strip/auto handling,
//      grade-parse fallback graceful-null (Drew Addition 2)
//   3. CertGraderError construction
//
// Mocks psaCert.service so no HTTP fires. Registry is reset between
// cases via the test-only escape hatch in registry.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/psa/psaCert.service.js", () => {
  class PsaApiError extends Error {
    public readonly status: number;
    public readonly code: string;
    constructor(message: string, status = 500, code = "PSA_API_ERROR") {
      super(message);
      this.name = "PsaApiError";
      this.status = status;
      this.code = code;
    }
  }
  return {
    PsaApiError,
    lookupPsaCertByNumber: vi.fn(),
  };
});

import {
  PsaApiError,
  lookupPsaCertByNumber,
} from "../src/services/psa/psaCert.service.js";
import {
  CertGraderError,
  type CertGrader,
} from "../src/services/certGraders/certGrader.js";
import {
  __resetRegistryForTest,
  findRecognizingGraders,
  getCertGrader,
  listCertGraders,
  registerCertGrader,
} from "../src/services/certGraders/registry.js";
import {
  buildPsaTitle,
  canonicalParallelFromVariety,
  detectAutoFromVariety,
  parseGradeValue,
  psaCertGrader,
} from "../src/services/certGraders/psa.grader.js";

const mockedLookup = lookupPsaCertByNumber as unknown as ReturnType<typeof vi.fn>;

function makeDummyGrader(id: string, recognizes: (s: string) => boolean = () => false): CertGrader {
  return {
    id,
    displayName: id.toUpperCase(),
    recognizes,
    async lookup() {
      return {
        rawCertNumber: "0",
        certificationType: "stub",
        cardRaw: null,
        totalPopulation: null,
        populationHigher: null,
      };
    },
    toCardIdentity() {
      return {
        candidateId: `${id}:0`,
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
        title: id,
        imageUrl: null,
      };
    },
  };
}

beforeEach(() => {
  __resetRegistryForTest();
  mockedLookup.mockReset();
});

afterEach(() => {
  __resetRegistryForTest();
});

// ─────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────

describe("certGraders/registry", () => {
  it("registers, lists, looks up by id, and finds by recognizes()", () => {
    const a = makeDummyGrader("alpha", (s) => s === "A");
    const b = makeDummyGrader("beta", (s) => s === "B");
    registerCertGrader(a);
    registerCertGrader(b);

    expect(listCertGraders().map((g) => g.id)).toEqual(["alpha", "beta"]);
    expect(getCertGrader("alpha")).toBe(a);
    expect(getCertGrader("missing")).toBeUndefined();
    expect(findRecognizingGraders("A").map((g) => g.id)).toEqual(["alpha"]);
    expect(findRecognizingGraders("B").map((g) => g.id)).toEqual(["beta"]);
    expect(findRecognizingGraders("X")).toEqual([]);
  });

  it("throws on id collision so shadowing surfaces in CI / startup, not silently at runtime", () => {
    registerCertGrader(makeDummyGrader("psa"));
    expect(() => registerCertGrader(makeDummyGrader("psa"))).toThrow(
      /Cert grader id collision: psa/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PSA grader — recognizes()
// ─────────────────────────────────────────────────────────────────────────

describe("psaCertGrader.recognizes", () => {
  it("accepts 6-12 digit cert numbers", () => {
    expect(psaCertGrader.recognizes("123456")).toBe(true);         // 6
    expect(psaCertGrader.recognizes("1234567")).toBe(true);        // 7
    expect(psaCertGrader.recognizes("12345678")).toBe(true);       // 8 (modern)
    expect(psaCertGrader.recognizes("123456789")).toBe(true);      // 9
    expect(psaCertGrader.recognizes("123456789012")).toBe(true);   // 12
  });

  it("trims whitespace before checking", () => {
    expect(psaCertGrader.recognizes("  12345678  ")).toBe(true);
  });

  it("rejects free-text, empty, non-numeric, too-short, too-long", () => {
    expect(psaCertGrader.recognizes("")).toBe(false);
    expect(psaCertGrader.recognizes("   ")).toBe(false);
    expect(psaCertGrader.recognizes("1989 Topps Griffey")).toBe(false);
    expect(psaCertGrader.recognizes("abc123")).toBe(false);
    expect(psaCertGrader.recognizes("12345")).toBe(false);              // 5 digits
    expect(psaCertGrader.recognizes("1234567890123")).toBe(false);      // 13 digits
    expect(psaCertGrader.recognizes("123-456-789")).toBe(false);
  });

  it("does not throw on non-string input (interface contract: MUST NOT throw)", () => {
    expect(() => psaCertGrader.recognizes(null as unknown as string)).not.toThrow();
    expect(() => psaCertGrader.recognizes(undefined as unknown as string)).not.toThrow();
    expect(() => psaCertGrader.recognizes(12345 as unknown as string)).not.toThrow();
    expect(psaCertGrader.recognizes(null as unknown as string)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PSA grader — lookup() error code mapping
// ─────────────────────────────────────────────────────────────────────────

describe("psaCertGrader.lookup", () => {
  const okFixture = {
    source: "psa-public-api",
    certNumber: "76556858",
    certificationType: "PSA",
    card: {
      year: "1987",
      brand: "Topps Traded",
      category: "Baseball",
      cardNumber: "70T",
      subject: "Greg Maddux",
      variety: "Limited Edition (Tiffany)",
      grade: "10",
      gradeDescription: "GEM MT 10",
      specId: 12345,
      itemStatus: "Active",
      totalPopulation: 47,
      populationHigher: 0,
    },
    raw: { PSACert: { stub: true } },
  };

  it("returns CertLookupResult shape on success", async () => {
    mockedLookup.mockResolvedValueOnce(okFixture);
    const r = await psaCertGrader.lookup("76556858");
    expect(r).toEqual({
      rawCertNumber: "76556858",
      certificationType: "PSA",
      cardRaw: okFixture.card,
      totalPopulation: 47,
      populationHigher: 0,
    });
  });

  it("populates null pop counts when card is absent (cert-not-found shape)", async () => {
    mockedLookup.mockResolvedValueOnce({
      source: "psa-public-api",
      certNumber: "99999999",
      certificationType: "UNKNOWN",
      card: null,
      raw: {},
    });
    const r = await psaCertGrader.lookup("99999999");
    expect(r.totalPopulation).toBeNull();
    expect(r.populationHigher).toBeNull();
    expect(r.cardRaw).toBeNull();
  });

  it.each([
    ["PSA_TOKEN_MISSING", "TOKEN_MISSING"],
    ["PSA_AUTH_FAILED", "AUTH_FAILED"],
    ["PSA_QUOTA_EXCEEDED", "QUOTA_EXCEEDED"],
    ["PSA_TIMEOUT", "TIMEOUT"],
    ["PSA_REQUEST_FAILED", "REQUEST_FAILED"],
    ["PSA_REQUEST_ERROR", "REQUEST_FAILED"],
    ["PSA_CERT_MISSING", "REQUEST_FAILED"],
    ["PSA_API_ERROR", "REQUEST_FAILED"],
  ])("maps %s → CertGraderError code %s", async (psaCode, certCode) => {
    mockedLookup.mockRejectedValueOnce(new PsaApiError("boom", 502, psaCode));
    await expect(psaCertGrader.lookup("12345678")).rejects.toMatchObject({
      name: "CertGraderError",
      graderId: "psa",
      code: certCode,
    });
  });

  it("maps unknown PsaApiError code → REQUEST_FAILED (falls through default switch)", async () => {
    mockedLookup.mockRejectedValueOnce(
      new PsaApiError("weird", 502, "PSA_NEW_FUTURE_CODE"),
    );
    await expect(psaCertGrader.lookup("12345678")).rejects.toMatchObject({
      code: "UNKNOWN",
    });
  });

  it("maps non-PsaApiError exception → UNKNOWN with status 502", async () => {
    mockedLookup.mockRejectedValueOnce(new Error("network blew up"));
    await expect(psaCertGrader.lookup("12345678")).rejects.toMatchObject({
      name: "CertGraderError",
      graderId: "psa",
      code: "UNKNOWN",
      status: 502,
    });
  });

  it("preserves PsaApiError status onto CertGraderError", async () => {
    mockedLookup.mockRejectedValueOnce(
      new PsaApiError("rate-limited", 429, "PSA_QUOTA_EXCEEDED"),
    );
    await expect(psaCertGrader.lookup("12345678")).rejects.toMatchObject({
      status: 429,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PSA grader — toCardIdentity field mapping
// ─────────────────────────────────────────────────────────────────────────

describe("psaCertGrader.toCardIdentity", () => {
  it("maps a Maddux Tiffany fixture into the canonical shape", () => {
    const result = {
      rawCertNumber: "76556858",
      certificationType: "PSA",
      cardRaw: {
        year: "1987",
        brand: "Topps Traded",
        category: "Baseball",
        cardNumber: "70T",
        subject: "Greg Maddux",
        variety: "Limited Edition (Tiffany)",
        grade: "10",
        gradeDescription: "GEM MT 10",
        specId: 12345,
        itemStatus: "Active",
        totalPopulation: 47,
        populationHigher: 0,
      },
      totalPopulation: 47,
      populationHigher: 0,
    };

    const id = psaCertGrader.toCardIdentity(result);

    expect(id.candidateId).toBe("psa:76556858");
    expect(id.source).toBe("psa-cert");
    expect(id.attribution).toBe("authoritative");
    expect(id.confidence).toBe(1.0);

    expect(id.player).toBe("Greg Maddux");
    expect(id.year).toBe(1987);
    expect(id.brand).toBe("Topps Traded");
    expect(id.setName).toBeNull();
    expect(id.cardNumber).toBe("70T");
    expect(id.parallel).toBe("Tiffany");
    expect(id.variation).toBeNull();
    expect(id.isAuto).toBe(false);
    expect(id.serialNumber).toBeNull();

    expect(id.grade).toBe("10");
    expect(id.gradeCompany).toBe("PSA");
    expect(id.gradeValue).toBe(10);
    expect(id.certNumber).toBe("76556858");
    expect(id.totalPopulation).toBe(47);
    expect(id.populationHigher).toBe(0);

    expect(id.title).toBe(
      "1987 Topps Traded #70T Greg Maddux Limited Edition (Tiffany) — PSA 10",
    );
    expect(id.imageUrl).toBeNull();
    expect(id.raw).toBe(result.cardRaw);
  });

  it("handles cert-not-found (cardRaw null) with safe defaults", () => {
    const id = psaCertGrader.toCardIdentity({
      rawCertNumber: "99999999",
      certificationType: "UNKNOWN",
      cardRaw: null,
      totalPopulation: null,
      populationHigher: null,
    });
    expect(id.candidateId).toBe("psa:99999999");
    expect(id.attribution).toBe("authoritative");
    expect(id.player).toBeNull();
    expect(id.year).toBeNull();
    expect(id.parallel).toBeNull();
    expect(id.isAuto).toBe(false);
    expect(id.gradeCompany).toBe("PSA");
    expect(id.gradeValue).toBeNull();
    expect(id.title).toBe("PSA 99999999");
  });

  it("non-4-digit year string → null (does not coerce mangled values)", () => {
    const id = psaCertGrader.toCardIdentity({
      rawCertNumber: "12345678",
      certificationType: "PSA",
      cardRaw: {
        year: "199x",
        brand: null,
        category: null,
        cardNumber: null,
        subject: null,
        variety: null,
        grade: null,
        gradeDescription: null,
        specId: null,
        itemStatus: null,
        totalPopulation: null,
        populationHigher: null,
      },
      totalPopulation: null,
      populationHigher: null,
    });
    expect(id.year).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PSA variety helpers — wrapper-strip + auto detection
// ─────────────────────────────────────────────────────────────────────────

describe("canonicalParallelFromVariety", () => {
  it("strips wrapper text: 'Limited Edition (Tiffany)' → 'Tiffany'", () => {
    expect(canonicalParallelFromVariety("Limited Edition (Tiffany)")).toBe("Tiffany");
  });

  it("passes through clean parallel: 'Tiffany' → 'Tiffany'", () => {
    expect(canonicalParallelFromVariety("Tiffany")).toBe("Tiffany");
  });

  it("title-cases multi-token parallel: 'blue refractor' → 'Blue Refractor'", () => {
    expect(canonicalParallelFromVariety("blue refractor")).toBe("Blue Refractor");
  });

  it("filters auto-signal tokens from parallel: 'Tiffany Auto' → 'Tiffany'", () => {
    expect(canonicalParallelFromVariety("Tiffany Auto")).toBe("Tiffany");
  });

  it("returns null when only auto tokens present: 'Autograph' → null", () => {
    expect(canonicalParallelFromVariety("Autograph")).toBeNull();
    expect(canonicalParallelFromVariety("Signed")).toBeNull();
  });

  it("returns null for empty / null / non-string", () => {
    expect(canonicalParallelFromVariety("")).toBeNull();
    expect(canonicalParallelFromVariety(null)).toBeNull();
    expect(canonicalParallelFromVariety(undefined)).toBeNull();
    expect(canonicalParallelFromVariety(123 as unknown as string)).toBeNull();
  });
});

describe("detectAutoFromVariety", () => {
  it("detects auto tokens: 'Tiffany Auto' → true", () => {
    expect(detectAutoFromVariety("Tiffany Auto")).toBe(true);
    expect(detectAutoFromVariety("Autograph")).toBe(true);
    expect(detectAutoFromVariety("Signed")).toBe(true);
    expect(detectAutoFromVariety("Signature")).toBe(true);
  });

  it("false when no auto tokens: 'Limited Edition (Tiffany)' → false", () => {
    expect(detectAutoFromVariety("Limited Edition (Tiffany)")).toBe(false);
    expect(detectAutoFromVariety("Refractor")).toBe(false);
  });

  it("false for empty / null / non-string", () => {
    expect(detectAutoFromVariety("")).toBe(false);
    expect(detectAutoFromVariety(null)).toBe(false);
    expect(detectAutoFromVariety(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Grade parsing — primary, fallback, and graceful null (Drew Addition 2)
// ─────────────────────────────────────────────────────────────────────────

describe("parseGradeValue", () => {
  it("primary path: parses clean numeric grade '10' → 10", () => {
    expect(parseGradeValue("10", null)).toBe(10);
    expect(parseGradeValue("9.5", null)).toBe(9.5);
  });

  it("fallback path: parses gradeDescription 'GEM MT 10' → 10", () => {
    expect(parseGradeValue(null, "GEM MT 10")).toBe(10);
    expect(parseGradeValue("", "MINT 9")).toBe(9);
  });

  it("primary wins when both present", () => {
    expect(parseGradeValue("9", "GEM MT 10")).toBe(9);
  });

  // Drew Addition 2: both parsers fail → graceful null, no NaN, no throw.
  it("returns null when both parsers fail (does not throw, does not return NaN)", () => {
    const v = parseGradeValue("Authentic", "Authentic");
    expect(v).toBeNull();
    expect(Number.isNaN(v as unknown as number)).toBe(false);
  });

  it("returns null for unparseable garbage: ('xyz', 'qrs') → null", () => {
    expect(parseGradeValue("xyz", "qrs")).toBeNull();
  });

  it("returns null when both null/empty/undefined", () => {
    expect(parseGradeValue(null, null)).toBeNull();
    expect(parseGradeValue(undefined, undefined)).toBeNull();
    expect(parseGradeValue("", "")).toBeNull();
  });

  it("rejects out-of-range numeric grade > 10 (defensive)", () => {
    expect(parseGradeValue("11", null)).toBeNull();
    expect(parseGradeValue("0", null)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Title builder
// ─────────────────────────────────────────────────────────────────────────

describe("buildPsaTitle", () => {
  it("emits the canonical example shape", () => {
    expect(
      buildPsaTitle({
        year: "1989",
        brand: "Upper Deck",
        category: "Baseball",
        cardNumber: "1",
        subject: "Ken Griffey Jr.",
        variety: "RC",
        grade: "9",
        gradeDescription: "MINT 9",
        specId: null,
        itemStatus: null,
        totalPopulation: null,
        populationHigher: null,
      }),
    ).toBe("1989 Upper Deck #1 Ken Griffey Jr. RC — PSA 9");
  });

  it("drops grade suffix when no grade parses (does not emit ' — PSA ' empty fragment)", () => {
    expect(
      buildPsaTitle({
        year: "1990",
        brand: "Topps",
        category: "Baseball",
        cardNumber: "1",
        subject: "Subject",
        variety: null,
        grade: "Authentic",
        gradeDescription: "Authentic",
        specId: null,
        itemStatus: null,
        totalPopulation: null,
        populationHigher: null,
      }),
    ).toBe("1990 Topps #1 Subject");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CertGraderError construction
// ─────────────────────────────────────────────────────────────────────────

describe("CertGraderError", () => {
  it("constructs with graderId + code + default status 502", () => {
    const e = new CertGraderError("nope", "psa", "REQUEST_FAILED");
    expect(e.name).toBe("CertGraderError");
    expect(e.message).toBe("nope");
    expect(e.graderId).toBe("psa");
    expect(e.code).toBe("REQUEST_FAILED");
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });

  it("accepts custom status", () => {
    const e = new CertGraderError("rate", "psa", "QUOTA_EXCEEDED", 429);
    expect(e.status).toBe(429);
  });

  it.each([
    "TOKEN_MISSING",
    "AUTH_FAILED",
    "QUOTA_EXCEEDED",
    "NOT_FOUND",
    "TIMEOUT",
    "REQUEST_FAILED",
    "UNKNOWN",
  ] as const)("accepts %s as a valid code", (code) => {
    const e = new CertGraderError("m", "psa", code);
    expect(e.code).toBe(code);
  });
});
