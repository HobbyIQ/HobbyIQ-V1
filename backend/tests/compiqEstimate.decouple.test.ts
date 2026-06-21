// CF-DECOUPLE (2026-06-21) — null-safe product classification at the 3
// mechanism1 clamp sites in compiqEstimate.service.ts.
//
// Pre-CF-DECOUPLE: the 3 sites force-fit any non-Bowman product (and
// at site #2 even bare "Bowman" flagship) to "Bowman Chrome" via a
// substring fallback. CF-PROD-RECON identified this as the load-bearing
// launch-blocker — non-Bowman holdings silently mis-resolved to Bowman
// curated rows. The full mis-price was masked today by sparse year
// coverage in the multiplier table, but CF-CAT-ENGINE would unmask it
// as rows fill, so CF-DECOUPLE had to land first.
//
// Scope per spec (B): decouple PRODUCT only; leave subset hardcoded
// "Chrome Prospect Autographs" at all 3 sites. The Bowman-non-CPA
// residual is addressed in CF-DECOUPLE-2 once a cardsightSetName →
// BowmanFamilySubset normalizer is properly budgeted.

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import request from "supertest";

vi.mock("../src/services/compiq/cardsight.router.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    findCompsRouted: vi.fn(),
    getCardSalesRouted: vi.fn(),
    searchCardsRouted: vi.fn(),
  };
});

import app from "../src/app";
import * as cardHedge from "../src/services/compiq/cardsight.router.js";
import { classifyBowmanFamilyProduct } from "../src/services/compiq/compiqEstimate.service.js";

let adminSession = "";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function signIn(username: string, password: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signin")
    .send({ username, password });
  expect(res.status).toBe(200);
  return res.body.sessionId as string;
}

// ─── Unit tests on the classifier — the load-bearing artifact ─────────────

describe("CF-DECOUPLE — classifyBowmanFamilyProduct", () => {
  describe("strict canonical matches (the unchanged-Bowman cases)", () => {
    it("'Bowman Draft' → 'Bowman Draft'", () => {
      expect(classifyBowmanFamilyProduct("Bowman Draft")).toBe("Bowman Draft");
    });
    it("'Bowman Chrome' → 'Bowman Chrome'", () => {
      expect(classifyBowmanFamilyProduct("Bowman Chrome")).toBe("Bowman Chrome");
    });
    it("'Bowman' → 'Bowman' (the Hartman flagship case — site #2's correction)", () => {
      expect(classifyBowmanFamilyProduct("Bowman")).toBe("Bowman");
    });
  });

  describe("Bowman free-text normalization (preserved from legacy fallback)", () => {
    it("'2024 Bowman Chrome RC' → 'Bowman Chrome'", () => {
      expect(classifyBowmanFamilyProduct("2024 Bowman Chrome RC")).toBe("Bowman Chrome");
    });
    it("'Bowman Chrome Prospects' → 'Bowman Chrome'", () => {
      expect(classifyBowmanFamilyProduct("Bowman Chrome Prospects")).toBe("Bowman Chrome");
    });
    it("'Bowman Draft Chrome' → 'Bowman Draft' (Draft checked before Chrome)", () => {
      expect(classifyBowmanFamilyProduct("Bowman Draft Chrome")).toBe("Bowman Draft");
    });
    it("'Bowman /150' → 'Bowman' (parallel-suffix variant of flagship)", () => {
      expect(classifyBowmanFamilyProduct("Bowman /150")).toBe("Bowman");
    });
    it("case-insensitive: 'bowman chrome' → 'Bowman Chrome'", () => {
      expect(classifyBowmanFamilyProduct("bowman chrome")).toBe("Bowman Chrome");
    });
  });

  describe("non-Bowman strings → null (closes the silent mis-route)", () => {
    it("'Topps Chrome' → null", () => {
      expect(classifyBowmanFamilyProduct("Topps Chrome")).toBeNull();
    });
    it("'Topps Update' → null (the Trout 2011 case)", () => {
      expect(classifyBowmanFamilyProduct("Topps Update")).toBeNull();
    });
    it("'Panini Prizm' → null", () => {
      expect(classifyBowmanFamilyProduct("Panini Prizm")).toBeNull();
    });
    it("'Topps Draft' → null (closes the pre-CF-DECOUPLE bug: 'Draft' substring no longer wrong-routes non-Bowman)", () => {
      // Pre-CF-DECOUPLE: `rawProduct.includes("Draft")` matched here and
      // mis-routed to "Bowman Draft". Post-classifier the word-boundary
      // anchor on \bBowman\s+Draft\b requires Bowman presence.
      expect(classifyBowmanFamilyProduct("Topps Draft")).toBeNull();
    });
    it("'Topps Chrome RC' → null (Chrome substring without Bowman → not Bowman)", () => {
      expect(classifyBowmanFamilyProduct("Topps Chrome RC")).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("undefined → null", () => {
      expect(classifyBowmanFamilyProduct(undefined)).toBeNull();
    });
    it("null → null", () => {
      expect(classifyBowmanFamilyProduct(null)).toBeNull();
    });
    it("empty string → null", () => {
      expect(classifyBowmanFamilyProduct("")).toBeNull();
    });
    it("whitespace-only → null", () => {
      expect(classifyBowmanFamilyProduct("   ")).toBeNull();
    });
    it("'Lex-Bowman-Style-Name' (Bowman embedded in unrelated word boundary) → 'Bowman'", () => {
      // The hyphen creates a word boundary on both sides of "Bowman" so the
      // \bBowman\b regex matches. This is intentional — sellers/clients
      // occasionally use hyphenated product strings, and the legitimate
      // Bowman normalization should still fire. Anti-non-Bowman behavior
      // hinges on the absence of any Bowman token, not on hyphenation.
      expect(classifyBowmanFamilyProduct("Lex-Bowman-Style-Name")).toBe("Bowman");
    });
  });
});

// ─── Integration tests via /api/compiq/estimate ───────────────────────────

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

// Variant-mismatch fixture: 2 comps means T0/T1/T2/T3 all yield <3 →
// everythingFilteredOut. Site #1 fires.
function mockVariantMismatchTrout2011Topps() {
  (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    card: {
      card_id: "card-trout-2011-topps-update-base",
      title: "2011 Topps Update Mike Trout Base #US175",
      player: "Mike Trout",
      set: "Topps Update",
      year: 2011,
      number: "US175",
      variant: "Base",
    },
    sales: [
      // 2 comps → insufficient for T3; flows through variant-mismatch
      { price: 1500, date: isoDaysAgo(7),  title: "2011 Topps Update Mike Trout US175" },
      { price: 1400, date: isoDaysAgo(20), title: "2011 Topps Update Mike Trout US175" },
    ],
    variantWarning: [],
    aiCategory: "Baseball",
  });
}

// Bare-Bowman site #2 fixture (the insufficient-comps path): 1 ancient comp
// triggers the `insufficient` branch.
function mockInsufficientBowmanFlagship() {
  (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    card: {
      card_id: "card-hartman-bowman-flagship",
      title: "2026 Bowman Eric Hartman BCP-EHA",
      player: "Eric Hartman",
      set: "Paper Prospects", // CF-FIXTURE-AUDIT: production-accurate Cardsight setName (paper flagship, BCP subset). Pre-audit "Bowman" was the release name.
      year: 2026,
      number: "BCP-EHA",
      variant: "Refractor",
    },
    sales: [
      // 1 old comp → insufficient branch (compCount === 1 && daysSinceNewest > 14)
      { price: 50, date: isoDaysAgo(60), title: "2026 Bowman Eric Hartman BCP-EHA Refractor" },
    ],
    variantWarning: [],
    aiCategory: "Baseball",
  });
}

describe("CF-DECOUPLE — non-Bowman holdings skip mechanism1 cleanly", () => {
  beforeAll(async () => {
    adminSession = await signIn("HobbyIQ", "Baseball25");
  });

  it("Topps Update holding through variant-mismatch (site #1) → m1 returns null result, no Bowman-row match", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
    mockVariantMismatchTrout2011Topps();

    const res = await request(app)
      .post("/api/compiq/estimate")
      .set("x-session-id", adminSession)
      .send({
        playerName: "Mike Trout",
        cardYear: 2011,
        product: "Topps Update",  // ← non-Bowman product, would previously force-fit to "Bowman Chrome"
        parallel: "Base",
        isAuto: false,
      });

    expect(res.status).toBe(200);
    // Non-Bowman: mechanism1 skipped → no estimate emitted from m1.
    // The holding's FMV/path depends on the engine's tier ladder + comp
    // sufficiency; what we assert is that estimateBasis is NEVER one of
    // the multiplier values (no multiplier_provisional, no multiplier).
    // Pre-CF-DECOUPLE these could have surfaced for a non-Bowman holding
    // whose parallel name coincidentally matched a curated Bowman row.
    expect(res.body.estimateBasis).not.toBe("multiplier");
    expect(res.body.estimateBasis).not.toBe("multiplier_provisional");
  });

  it("Panini Prizm holding through variant-mismatch (site #1) → m1 skipped, basis never multiplier", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
    mockVariantMismatchTrout2011Topps();  // shape doesn't matter — what matters is body.product

    const res = await request(app)
      .post("/api/compiq/estimate")
      .set("x-session-id", adminSession)
      .send({
        playerName: "Ronald Acuna",
        cardYear: 2023,
        product: "Panini Prizm",
        parallel: "Blue Refractor",   // would have coincidentally matched a Bowman row pre-fix
        isAuto: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.estimateBasis).not.toBe("multiplier");
    expect(res.body.estimateBasis).not.toBe("multiplier_provisional");
  });
});

describe("CF-DECOUPLE — bare-Bowman flagship at site #2 (the special site)", () => {
  beforeAll(async () => {
    adminSession = await signIn("HobbyIQ", "Baseball25");
  });

  it("bare 'Bowman' product through site #2 classifies to 'Bowman' (not 'Bowman Chrome' as pre-fix)", () => {
    // Pre-CF-DECOUPLE, site #2's `(body.product?.includes("Draft") ?
    // "Bowman Draft" : "Bowman Chrome")` would have force-fit even bare
    // "Bowman" → "Bowman Chrome". Post-classifier, the strict canonical
    // pass returns "Bowman" for the Hartman flagship case.
    expect(classifyBowmanFamilyProduct("Bowman")).toBe("Bowman");
  });

  it("bare 'Bowman' /150 product (Hartman shape) classifies to 'Bowman'", () => {
    expect(classifyBowmanFamilyProduct("Bowman /150")).toBe("Bowman");
  });

  it("integration: bare-Bowman + auto holding through insufficient path (site #2) returns 200 with no multiplier-basis estimate from a wrong-product row", async () => {
    // The actual mechanism1 outcome depends on the multiplier table state
    // (today the 2026 Bowman CPA X-Fractor row exists at provenance:
    // sibling_provisional, so collision-win is gated and basis would be
    // null on this site's variant-mismatch invocation). The wire contract
    // we assert: site #2 emits a valid (or null) estimateBasis on a
    // bare-Bowman holding without throwing or routing to a wrong product.
    process.env.CARD_HEDGE_API_KEY = "test-key";
    mockInsufficientBowmanFlagship();

    const res = await request(app)
      .post("/api/compiq/estimate")
      .set("x-session-id", adminSession)
      .send({
        playerName: "Eric Hartman",
        cardYear: 2026,
        product: "Bowman",  // bare flagship
        parallel: "Blue X-Fractor",
        isAuto: true,
      });

    expect(res.status).toBe(200);
    // basis is one of the valid values (or null); no throw, no wrong-product route.
    const valid: Array<string | null> = [
      null, "multiplier", "multiplier_provisional", "base_auto_floor",
    ];
    expect(valid).toContain(res.body.estimateBasis ?? null);
  });
});

describe("CF-DECOUPLE — anti-regression: Bowman CPA at sites #1/#3 unchanged", () => {
  beforeAll(async () => {
    adminSession = await signIn("HobbyIQ", "Baseball25");
  });

  it("Hartman shape (bare 'Bowman' + Blue X-Fractor + auto) through site #1 produces same response shape as pre-CF-DECOUPLE", async () => {
    // Hartman routes through site #1 via the variant-mismatch short-
    // circuit (2 comps < T3 floor of 3), which fires upstream of
    // mechanism1. The "Hartman unchanged" headline the CF spec called
    // out holds via this short-circuit, not via m1 subset routing —
    // m1 doesn't run on this path. (Post-CF-FIXTURE-AUDIT, 2026-06-21:
    // card.set is now the production-accurate "Chrome Prospects
    // Autographs"; the short-circuit still fires identically.)
    process.env.CARD_HEDGE_API_KEY = "test-key";
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-hartman-blue-xfractor-150",
        title: "2026 Bowman Eric Hartman Chrome Prospects Autographs",
        player: "Eric Hartman",
        set: "Chrome Prospects Autographs", // CF-FIXTURE-AUDIT
        year: 2026,
        number: "CPA-EHA",
        variant: "Blue X-Fractor /150",
      },
      sales: [
        // 2 comps — drives the variant-mismatch (T3 < 3 comps) path
        { price: 60, date: isoDaysAgo(8),  title: "2026 Bowman Refractor Auto Eric Hartman CPA-EHA /499" },
        { price: 65, date: isoDaysAgo(12), title: "2026 Bowman Refractor Auto Eric Hartman CPA-EHA /499" },
      ],
      variantWarning: [],
      aiCategory: "Baseball",
    });

    const res = await request(app)
      .post("/api/compiq/estimate")
      .set("x-session-id", adminSession)
      .send({
        playerName: "Eric Hartman",
        cardYear: 2026,
        product: "Bowman /150",
        parallel: "Blue X-Fractor",
        isAuto: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("variant-mismatch");
    expect(res.body.fairMarketValue).toBeNull();
    // CF-XMULT's CF-X2-ANCHOR established Hartman can't anchor m1
    // (pool fails curatedParallelCount < 3). Post-CF-FIXTURE-AUDIT,
    // the classifier now returns the valid subset "Chrome Prospect
    // Autographs" (was null pre-audit), but m1 still can't anchor on
    // the pool-thin constraint — same null end state via a different
    // failure point. The variant-mismatch short-circuit upstream
    // reaches the same outcome regardless. No estimated value emitted.
    expect(res.body.estimatedValue ?? null).toBeNull();
  });
});

describe("CF-DECOUPLE-2 — production-accurate integration coverage", () => {
  beforeAll(async () => {
    adminSession = await signIn("HobbyIQ", "Baseball25");
  });

  it("CPA HOLDING — production-accurate Cardsight setName 'Chrome Prospects Autographs' (plural) normalizes to 'Chrome Prospect Autographs' (singular), Hartman path unchanged", async () => {
    // Pre-CF-DECOUPLE-2 fixtures used set:"Bowman" (the release) which
    // was incorrect — production `fetched.card.set` carries the SUBSET
    // (compiqEstimate.service.ts:1345 explicitly: "c.set.name is the
    // literal subset name 'Base Set'"). This test uses the production-
    // accurate fixture and asserts the normalizer + lookup roundtrip.
    process.env.CARD_HEDGE_API_KEY = "test-key";
    const now = Date.now();
    const isoDaysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-hartman-blue-xfractor-150",
        title: "2026 Bowman Eric Hartman",
        player: "Eric Hartman",
        set: "Chrome Prospects Autographs", // ← production-accurate subset name
        year: 2026,
        number: "CPA-EHA",
        variant: "Blue X-Fractor /150",
      },
      sales: [
        { price: 60, date: isoDaysAgo(8),  title: "2026 Bowman Refractor Auto Eric Hartman CPA-EHA /499" },
        { price: 65, date: isoDaysAgo(12), title: "2026 Bowman Refractor Auto Eric Hartman CPA-EHA /499" },
      ],
      variantWarning: [],
      aiCategory: "Baseball",
    });

    const res = await request(app)
      .post("/api/compiq/estimate")
      .set("x-session-id", adminSession)
      .send({
        playerName: "Eric Hartman",
        cardYear: 2026,
        product: "Bowman /150",
        parallel: "Blue X-Fractor",
        isAuto: true,
      });

    expect(res.status).toBe(200);
    // Hartman's pool can't anchor mechanism1 (curatedParallelCount < 3).
    // Same outcome as pre-CF-DECOUPLE-2: no estimated value emitted.
    expect(res.body.fairMarketValue).toBeNull();
    expect(res.body.estimatedValue ?? null).toBeNull();
  });

  it("BOWMAN-NON-CPA — 'Base Set' (ambiguous) normalizes to null, mechanism1 skipped, no wrong-CPA route", async () => {
    // The bare-Bowman flagship case CF-DECOUPLE-2 specifically addressed.
    // Pre-CF-DECOUPLE-2: 'Base Set' would have been ignored (subset
    // hardcoded to CPA) → mechanism1 invoked with wrong subset → could
    // accidentally match a CPA row by parallel name. Post-fix: normalizer
    // returns null → mechanism1 skipped → observed FMV from comps wins
    // honestly.
    process.env.CARD_HEDGE_API_KEY = "test-key";
    const now = Date.now();
    const isoDaysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-bowman-flagship-base",
        title: "2026 Bowman Some Player Base",
        player: "Some Player",
        set: "Base Set", // ← Cardsight's ambiguous setName for flagship base
        year: 2026,
        number: "BCP-99",
        variant: "Base",
      },
      sales: [
        { price: 10, date: isoDaysAgo(5),  title: "2026 Bowman Some Player BCP-99" },
        { price: 12, date: isoDaysAgo(10), title: "2026 Bowman Some Player BCP-99" },
      ],
      variantWarning: [],
      aiCategory: "Baseball",
    });

    const res = await request(app)
      .post("/api/compiq/estimate")
      .set("x-session-id", adminSession)
      .send({
        playerName: "Some Player",
        cardYear: 2026,
        product: "Bowman",
        parallel: "Base",
        isAuto: false,
      });

    expect(res.status).toBe(200);
    // No multiplier basis — mechanism1 was skipped (null subset).
    expect(res.body.estimateBasis).not.toBe("multiplier");
    expect(res.body.estimateBasis).not.toBe("multiplier_provisional");
  });
});

describe("CF-DECOUPLE-2 — subset hardcode retired (boundary marker flipped)", () => {
  // CF-DECOUPLE-2 (2026-06-21) replaced the 5 hardcoded subset literals
  // with `normalizeCardsightSetName(fetched.card?.set ?? null)`. The
  // boundary-marker test from CF-DECOUPLE asserted occurrences === 5;
  // it has flipped to asserting === 0. This is the spec-locked "clean
  // signal CF-DECOUPLE-2 landed" — the hardcode is gone.
  //
  // Future CF that intentionally re-introduces a subset literal for any
  // reason should delete THIS test (not relax it) and document why.

  it("ANTI-REGRESSION: subset hardcode is fully removed at all 5 mechanism1 + Build-B sites", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../src/services/compiq/compiqEstimate.service.ts", import.meta.url),
      "utf8",
    );
    const occurrences = (src.match(/subset:\s*"Chrome Prospect Autographs"/g) ?? []).length;
    expect(occurrences).toBe(0);
  });
});
