// CF-A-SUGGESTION-IS-A-SLUG-OR-NOTHING (2026-08-29, checklist D12a).
//
// The suggester's wire `cardId` could be a CardHedge bubble.io id: chToCommon
// and csIdentityToCommon emit vendor ids by construction, and
// catalogHitToCommon fell back to `h.cardId` — a vendor id on vendor-sourced
// catalog rows — when hobbyiqCardId was null. That id was persisted as
// suggestedCardId and auto-applied as cardId at >= 0.55 by the confirm and
// rescue passes, pinning the holding to a vendor's copy of the card.
//
// Now `cardId` is an hiq: slug or ABSENT; `idKind` says which; a vendor hit
// still scores and still reaches the review sheet, as candidate context
// (candidate.vendorCardId) that nothing adopts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  searchCards: vi.fn(async () => []),
  isAutoCardNumber: (num: unknown) => /^(cpa|bcpa|cra)[- ]/i.test(String(num ?? "")),
}));
vi.mock("../src/services/compiq/cardsightUuidSource.js", () => ({
  fetchCardsightUuidNativeCandidates: vi.fn(async () => []),
}));
vi.mock("../src/services/compiq/referenceCatalogLookup.js", () => ({
  inferPrintRunFromReferenceCatalog: vi.fn(async () => null),
}));
vi.mock("../src/services/portfolioiq/canonicalCardSearch.service.js", () => ({
  canonicalCardSearch: vi.fn(async () => ({ hits: [] })),
}));
const store = vi.hoisted(() => ({
  readUserDoc: vi.fn(),
  writeUserDoc: vi.fn(async () => undefined),
}));
vi.mock("../src/services/portfolioiq/portfolioStore.service.js", () => ({
  readUserDoc: store.readUserDoc,
  writeUserDoc: store.writeUserDoc,
}));

import { suggestCardIdForHolding, generateCardIdSuggestions } from "../src/services/portfolioiq/cardIdSuggester.service.js";
import { searchCards } from "../src/services/compiq/cardhedge.client.js";
import { canonicalCardSearch } from "../src/services/portfolioiq/canonicalCardSearch.service.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

const CH_ID = "1606922959335x293409091214639100";
const SLUG = "hiq:baseball:2020:panini-prizm:275:silver:no-auto";

function holding(overrides: Partial<PortfolioHolding> = {}): PortfolioHolding {
  return {
    id: "h-1",
    playerName: "Mookie Betts",
    cardYear: 2020,
    setName: "Panini Prizm",
    parallel: "Silver",
    cardNumber: "275",
    isAuto: false,
    quantity: 1,
    ...overrides,
  } as PortfolioHolding;
}

const chHit = { card_id: CH_ID, name: "Mookie Betts", set: "2020 Panini Prizm", year: 2020, number: "275", variant: "Silver", image: "https://cdn/x.jpg" };
const catalogHit = (hobbyiqCardId: string | null) => ({
  cardId: hobbyiqCardId ?? CH_ID, hobbyiqCardId, player: "Mookie Betts", releaseName: "Panini Prizm",
  cardYear: 2020, cardNumber: "275", parallels: [{ name: "Silver" }], imageUrl: null,
});

beforeEach(() => {
  vi.mocked(searchCards).mockReset().mockResolvedValue([]);
  vi.mocked(canonicalCardSearch).mockReset().mockResolvedValue({ hits: [] } as never);
  store.readUserDoc.mockReset();
  store.writeUserDoc.mockClear();
  delete process.env.SUGGESTER_CARDHEDGE_ENABLED;
});
afterEach(() => {
  delete process.env.SUGGESTER_CARDHEDGE_ENABLED;
});

describe("suggestCardIdForHolding — the wire id", () => {
  it("a CardHedge winner has NO cardId on the wire; its id is candidate context", async () => {
    process.env.SUGGESTER_CARDHEDGE_ENABLED = "true";
    vi.mocked(searchCards).mockResolvedValue([chHit] as never);
    const r = await suggestCardIdForHolding(holding());
    expect(r).not.toBeNull();
    // Mutation check: the pre-fix wire carried `cardId: CH_ID`.
    expect(r!.cardId).toBeUndefined();
    expect(r!.idKind).toBe("vendor");
    expect(r!.candidate.vendorCardId).toBe(CH_ID);
    expect(r!.candidateSource).toBe("cardhedge");
    expect(r!.confidence).toBeGreaterThan(0);
  });

  it("a vendor-keyed catalog row (hobbyiqCardId null) is a vendor hit too", async () => {
    vi.mocked(canonicalCardSearch).mockResolvedValue({ hits: [catalogHit(null)] } as never);
    const r = await suggestCardIdForHolding(holding());
    expect(r).not.toBeNull();
    expect(r!.cardId).toBeUndefined();
    expect(r!.idKind).toBe("vendor");
    expect(r!.candidate.vendorCardId).toBe(CH_ID);
    expect(r!.candidateSource).toBe("hobbyiq-catalog");
  });

  it("a canonical catalog row carries its hiq: slug as cardId", async () => {
    vi.mocked(canonicalCardSearch).mockResolvedValue({ hits: [catalogHit(SLUG)] } as never);
    const r = await suggestCardIdForHolding(holding());
    expect(r!.cardId).toBe(SLUG);
    expect(r!.idKind).toBe("hiq");
    expect(r!.candidate.vendorCardId).toBeUndefined();
  });

  it("an hiq: alternative keeps its cardId; a vendor alternative keeps only its context", async () => {
    process.env.SUGGESTER_CARDHEDGE_ENABLED = "true";
    // Catalog: a canonical Silver row. CH: a Gold row of the same card — a
    // plausible alternative, but a vendor id.
    vi.mocked(canonicalCardSearch).mockResolvedValue({ hits: [catalogHit(SLUG)] } as never);
    vi.mocked(searchCards).mockResolvedValue([{ ...chHit, card_id: "ch-gold", variant: "Gold" }] as never);
    const r = await suggestCardIdForHolding(holding({ parallel: "Silver Prizm" }));
    expect(r).not.toBeNull();
    for (const alt of r!.alternatives ?? []) {
      if (alt.idKind === "hiq") expect(alt.cardId).toMatch(/^hiq:/);
      else {
        expect(alt.cardId).toBeUndefined();
        expect(alt.candidate.vendorCardId).toBeTruthy();
      }
    }
  });
});

describe("generateCardIdSuggestions — what lands on the holding", () => {
  function pending(id: string): Record<string, unknown> {
    return { ...holding({ id }), cardStatus: "pending-review" };
  }

  it("a vendor winner persists NO suggestedCardId — idKind and the vendor id as context only", async () => {
    process.env.SUGGESTER_CARDHEDGE_ENABLED = "true";
    vi.mocked(searchCards).mockResolvedValue([chHit] as never);
    const h = pending("p-vendor");
    store.readUserDoc.mockResolvedValue({ userId: "u", holdings: { "p-vendor": h }, ledger: [] });
    const summary = await generateCardIdSuggestions("u");
    expect(summary.suggested).toBe(1);
    expect(summary.vendorIdDropped).toBe(1);
    // Mutation check: the pre-fix persist wrote suggestedCardId = CH_ID.
    expect(h.suggestedCardId).toBeUndefined();
    expect(h.suggestionIdKind).toBe("vendor");
    expect((h.suggestionCandidate as { vendorCardId?: string }).vendorCardId).toBe(CH_ID);
  });

  it("an hiq: winner persists suggestedCardId as the slug", async () => {
    vi.mocked(canonicalCardSearch).mockResolvedValue({ hits: [catalogHit(SLUG)] } as never);
    const h = pending("p-hiq");
    store.readUserDoc.mockResolvedValue({ userId: "u", holdings: { "p-hiq": h }, ledger: [] });
    await generateCardIdSuggestions("u");
    expect(h.suggestedCardId).toBe(SLUG);
    expect(h.suggestionIdKind).toBe("hiq");
  });

  it("re-running for a holding that previously held a vendor suggestedCardId clears it", async () => {
    process.env.SUGGESTER_CARDHEDGE_ENABLED = "true";
    vi.mocked(searchCards).mockResolvedValue([chHit] as never);
    const h = { ...pending("p-stale"), suggestedCardId: CH_ID };
    store.readUserDoc.mockResolvedValue({ userId: "u", holdings: { "p-stale": h }, ledger: [] });
    await generateCardIdSuggestions("u", { force: true });
    expect(h.suggestedCardId).toBeUndefined();
  });
});
