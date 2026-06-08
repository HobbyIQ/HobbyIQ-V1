// CF-CARDSIGHT-PRICING-CARD-SCHEMA (2026-06-07): two-part coverage for the
// schema-honest pricing-card mapping in fetchComps (pinned-cardId path)
// and the consistency guard that catches Cardsight vendor flaps before
// they leak wrong-card comps to the comp page.
//
// FIX 1 evidence — the Trout fixture is captured VERBATIM from the live
// Cardsight pricing probe of fda530ab-e925-460e-ab88-63199ef975e9
// (recorded 2026-06-07 during CF-TROUT-FRAZIER-RECON). If Cardsight ever
// drifts the schema again ("card_id" → "id", "set.year" → top-level
// "year", etc.) this test fails loudly and the mapping correction is
// localized to one place.
//
// FIX 2 evidence — feeds a pricing payload whose `card_id` doesn't
// match the requested id. Asserts the result surfaces zero comps + a
// stub identity (NOT the wrong-card identity) so a vendor flap can't
// produce a confidently-wrong UI rendering.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

vi.mock("../src/services/compiq/cardsight.client.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getPricing: vi.fn(),
  };
});

import { computeEstimate } from "../src/services/compiq/compiqEstimate.service";
import { testCallContext } from "./_helpers/testCallContext.js";
import * as cardSight from "../src/services/compiq/cardsight.client.js";

// ─── Real Trout pricing fixture (verbatim from live probe 2026-06-07) ──────

const TROUT_PINNED_ID = "fda530ab-e925-460e-ab88-63199ef975e9";

function makeTroutPricingFixture(opts: { rawCount?: number } = {}) {
  const today = new Date();
  const isoDaysAgo = (n: number) =>
    new Date(today.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
  const rawCount = opts.rawCount ?? 12;
  const records = Array.from({ length: rawCount }, (_, i) => ({
    title: `2011 Topps Update Mike Trout RC Rookie #US175 Angels (sample ${i})`,
    price: 200 + i * 10,
    date: isoDaysAgo(i % 5),
    source: "ebay",
    url: null,
  }));
  // Verbatim wire shape — card_id snake-case, name is the player,
  // nested set with name/year/release.
  return {
    card: {
      card_id: TROUT_PINNED_ID,
      name: "Mike Trout",
      number: "US175",
      set: {
        set_id: "9d4173f3-09af-49c2-a719-ba11824fd207",
        name: "Base Set",
        year: "2011",
        release: "Topps Update",
      },
    },
    raw: { count: records.length, records },
    graded: [],
    meta: { total_records: records.length, last_sale_date: records[0].date },
  } as any;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("FIX 1 — schema-honest pricing-card mapping (Trout fixture)", () => {
  beforeAll(() => {
    process.env.CARDSIGHT_API_KEY = "test-cardsight-key";
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps the real Cardsight pricing wire shape to a full identity object", async () => {
    (cardSight.getPricing as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTroutPricingFixture({ rawCount: 12 }),
    );

    // Pinned-id path: query === cardsightCardId.
    const result = (await computeEstimate({
      playerName: TROUT_PINNED_ID,
      cardsightCardId: TROUT_PINNED_ID,
    } as any, testCallContext)) as Record<string, unknown>;

    // compsUsed > 0 confirms the pinned-id branch took the happy path.
    expect(result.compsUsed).toBeGreaterThan(0);
    expect(result.source).not.toBe("no-recent-comps");

    // Identity-mapping assertions — every field from the real wire payload
    // must land in the identity object. cardIdentity is what /price-by-id
    // surfaces to iOS as `cardIdentity` in the response.
    const identity = result.cardIdentity as Record<string, unknown> | undefined;
    expect(identity, "cardIdentity must be present on a successful estimate").toBeDefined();
    expect(identity!.card_id).toBe(TROUT_PINNED_ID);
    expect(identity!.title).toBe("Mike Trout");
    expect(identity!.player).toBe("Mike Trout");
    expect(identity!.set).toBe("Base Set");
    expect(identity!.year).toBe(2011);
    expect(identity!.number).toBe("US175");
  });

  it("legacy `.id` field on pricing.card still maps (defense-in-depth, in case Cardsight rolls back)", async () => {
    // Synthesize a back-compat fixture: only the old `.id` field present,
    // none of the new `.card_id`. The fallback (`c.card_id ?? c.id`) must
    // still produce a usable card_id so we don't regress legacy responses.
    const fixture = makeTroutPricingFixture({ rawCount: 8 });
    delete (fixture.card as any).card_id;
    (fixture.card as any).id = TROUT_PINNED_ID;
    (cardSight.getPricing as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(fixture);

    const result = (await computeEstimate({
      playerName: TROUT_PINNED_ID,
      cardsightCardId: TROUT_PINNED_ID,
    } as any, testCallContext)) as Record<string, unknown>;

    expect(result.compsUsed).toBeGreaterThan(0);
    const identity = result.cardIdentity as Record<string, unknown>;
    expect(identity.card_id).toBe(TROUT_PINNED_ID);
    expect(identity.player).toBe("Mike Trout");
  });
});

describe("FIX 2 — consistency guard (card_id mismatch → unresolved)", () => {
  beforeAll(() => {
    process.env.CARDSIGHT_API_KEY = "test-cardsight-key";
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats Cardsight pricing whose card_id ≠ requested id as UNRESOLVED (no comps, stub identity)", async () => {
    // Simulate the Frazier flap: ask for fda530ab (Trout), Cardsight
    // returns 96dabacb (Frazier) with Frazier's identity + comps. The
    // guard must drop the comps + replace the identity with a stub keyed
    // on the requested id, so wrong-card data cannot surface.
    const FLAP_ID = "96dabacb-419f-449b-a532-c8d4fc1cd991";
    const today = new Date();
    const fixture = {
      card: {
        card_id: FLAP_ID,           // ← MISMATCH: doesn't match TROUT_PINNED_ID
        name: "Todd Frazier",
        number: "US270",
        set: {
          set_id: "9d4173f3-09af-49c2-a719-ba11824fd207",
          name: "Base Set",
          year: "2011",
          release: "Topps Update",
        },
      },
      raw: {
        count: 4,
        records: [
          { title: "2011 Topps Update Todd Frazier RC #US270", price: 1, date: today.toISOString(), source: "ebay", url: null },
          { title: "2011 Topps Update Todd Frazier RC #US270", price: 1, date: today.toISOString(), source: "ebay", url: null },
          { title: "2011 Topps Update Todd Frazier RC #US270", price: 1, date: today.toISOString(), source: "ebay", url: null },
          { title: "2011 Topps Update Todd Frazier RC #US270", price: 1, date: today.toISOString(), source: "ebay", url: null },
        ],
      },
      graded: [],
      meta: { total_records: 4, last_sale_date: today.toISOString() },
    } as any;

    (cardSight.getPricing as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(fixture);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = (await computeEstimate({
      playerName: TROUT_PINNED_ID,
      cardsightCardId: TROUT_PINNED_ID,
    } as any, testCallContext)) as Record<string, unknown>;

    // The Frazier comps (the wrong-card data) must NOT have leaked through.
    expect(result.compsUsed).toBe(0);

    // The identity that DOES surface must be the stub (keyed on the
    // requested id), NOT Frazier's. So if iOS reads it, it sees the
    // honest "couldn't resolve" state rather than confidently-wrong
    // wrong-card data.
    const identity = result.cardIdentity as Record<string, unknown> | undefined;
    if (identity) {
      expect(identity.card_id).toBe(TROUT_PINNED_ID);
      expect(identity.player).toBeNull();
      expect(identity.number).toBeNull();
    }

    // A subsystem-tagged log line was emitted for Group B's [cardsight]
    // alert + ops visibility into vendor flaps.
    const lines = errSpy.mock.calls.map((c) => String(c[0] ?? ""));
    const mismatchLog = lines.find((l) => l.includes("pricing_card_id_mismatch"));
    expect(mismatchLog).toBeDefined();
    expect(mismatchLog).toContain(`"requestedId":"${TROUT_PINNED_ID}"`);
    expect(mismatchLog).toContain(`"returnedCardId":"${FLAP_ID}"`);
    expect(mismatchLog).toContain('"returnedPlayer":"Todd Frazier"');
    expect(mismatchLog).toContain('"subsystem":"cardsight"');

    errSpy.mockRestore();
  });

  it("does NOT fire the guard when card_id matches (happy path passes through)", async () => {
    (cardSight.getPricing as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTroutPricingFixture({ rawCount: 10 }),
    );

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = (await computeEstimate({
      playerName: TROUT_PINNED_ID,
      cardsightCardId: TROUT_PINNED_ID,
    } as any, testCallContext)) as Record<string, unknown>;

    expect(result.compsUsed).toBeGreaterThan(0);

    const lines = errSpy.mock.calls.map((c) => String(c[0] ?? ""));
    const mismatchLog = lines.find((l) => l.includes("pricing_card_id_mismatch"));
    expect(mismatchLog).toBeUndefined();

    errSpy.mockRestore();
  });
});
