/**
 * CF-NO-CONFIDENCE-IS-NOT-HIGH-CONFIDENCE (2026-08-29, D3b).
 *
 * theCleanestOneWins.test.ts pinned the merge ORDER (authority, then
 * confidence) against a COPY of the rule, and the copy passed while the rule
 * failed: `entry.confidence > existing.confidence` is `0.95 > undefined`, false,
 * for every row that never declared a confidence -- the 1.2M old checklistcenter
 * rows, the 13M baseballcardpedia rows, the beckett-checklist rows. The D3
 * re-ingest upserted its 2,869,277 rows and most of them landed as no-ops on
 * a same-id row that kept its old label; the "new source" held only the rungs
 * nobody else had (2025 Bowman Draft CPA-MWI: 13 of 26).
 *
 * These pin the rule itself, through the function the write path calls.
 */
import { describe, expect, it } from "vitest";
import { mergeCatalogEntries } from "../src/services/portfolioiq/cardCatalog.service.js";
import type { CardCatalogEntry } from "../src/services/portfolioiq/cardCatalog.service.js";

const NOW = "2026-08-29T21:00:00.000Z";
const ID = "hiq:baseball:2025:bowman-draft:cpa-mwi:gold-refractor:auto:num-50";

function row(over: Partial<CardCatalogEntry> & { source: string }): CardCatalogEntry {
  return {
    id: ID, cardId: ID, hobbyiqCardId: ID,
    sport: "baseball", year: 2025, setKey: "bowman-draft", setName: "Bowman Draft",
    cardNumber: "CPA-MWI", parallel: "Gold Refractor", parallelSlug: "gold-refractor",
    isAuto: true, printRun: 50, playerName: "Max Williams", playerSlug: "max-williams",
    vendorIds: {}, confidence: 0.95, verificationStatus: "verified", catalogVersion: 2,
    searchTokens: [], observedAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-08-01T00:00:00.000Z",
    ...over,
  } as CardCatalogEntry;
}
const incoming = (over: Partial<CardCatalogEntry> & { source: string }) => {
  const { observedAt: _o, lastSeenAt: _l, ...rest } = row(over);
  return rest;
};

describe("a row with no confidence is not a high-confidence row", () => {
  it("a 0.95 checklist row beats a same-class row that never declared a confidence", () => {
    const existing = row({ source: "baseballcardpedia", parallel: "Gold" });
    delete (existing as Partial<CardCatalogEntry>).confidence;
    const { winnerIsIncoming, merged } = mergeCatalogEntries(incoming({ source: "checklistcenter-2026-08-29" }), existing, NOW);
    expect(winnerIsIncoming).toBe(true);
    expect(merged.source).toBe("checklistcenter-2026-08-29");
    expect(merged.parallel).toBe("Gold Refractor");
  });

  it("the same, against the OLD checklistcenter label (the D3 re-ingest's own predecessor)", () => {
    const existing = row({ source: "checklistcenter", confidence: undefined as unknown as number });
    const { merged } = mergeCatalogEntries(incoming({ source: "checklistcenter-2026-08-29" }), existing, NOW);
    expect(merged.source).toBe("checklistcenter-2026-08-29");
  });

  it("an exact tie keeps the existing row: re-running the same ingest is a no-op", () => {
    const existing = row({ source: "checklistinsider-2026-08-27", confidence: 0.95 });
    const { winnerIsIncoming, merged } = mergeCatalogEntries(incoming({ source: "checklistcenter-2026-08-29", confidence: 0.95 }), existing, NOW);
    expect(winnerIsIncoming).toBe(false);
    expect(merged.source).toBe("checklistinsider-2026-08-27");
    expect(merged.lastSeenAt).toBe(NOW);
  });

  it("authority still comes first: a confident derived row never displaces a confidence-less checklist row", () => {
    const existing = row({ source: "beckett-checklist" });
    delete (existing as Partial<CardCatalogEntry>).confidence;
    const { winnerIsIncoming } = mergeCatalogEntries(incoming({ source: "ingest-auto-seed", confidence: 0.99 }), existing, NOW);
    expect(winnerIsIncoming).toBe(false);
  });

  it("nothing existing: the incoming row lands", () => {
    const { winnerIsIncoming, merged } = mergeCatalogEntries(incoming({ source: "checklistcenter-2026-08-29" }), null, NOW);
    expect(winnerIsIncoming).toBe(true);
    expect(merged.observedAt).toBe(NOW);
  });
});

describe("what an incoming winner carries over", () => {
  it("keeps the replaced row's image, sale counts and move history -- other jobs' facts about the same card", () => {
    const existing = row({ source: "checklistcenter", imageUrl: "https://img/x.jpg", imageSource: "cardsight", recentSaleCount: 12, observedCompCount: 40, movedFrom: "hiq:old", movedAt: "2026-08-20T00:00:00.000Z" } as Partial<CardCatalogEntry> & { source: string });
    delete (existing as Partial<CardCatalogEntry>).confidence;
    const { merged } = mergeCatalogEntries(incoming({ source: "checklistcenter-2026-08-29" }), existing, NOW);
    const m = merged as unknown as Record<string, unknown>;
    expect(m.imageUrl).toBe("https://img/x.jpg");
    expect(m.recentSaleCount).toBe(12);
    expect(m.observedCompCount).toBe(40);
    expect(m.movedFrom).toBe("hiq:old");
    expect(merged.observedAt).toBe(existing.observedAt);
  });

  it("does NOT keep what described the old row's own name: displayName, searchText, checklistBacking", () => {
    const existing = row({ source: "ingest-auto-seed", confidence: 0.85, displayName: "old name", searchText: "old text", checklistBacking: "unconfirmed" } as Partial<CardCatalogEntry> & { source: string });
    const { merged } = mergeCatalogEntries(incoming({ source: "checklistcenter-2026-08-29" }), existing, NOW);
    const m = merged as unknown as Record<string, unknown>;
    expect(m.displayName).toBeUndefined();
    expect(m.searchText).toBeUndefined();
    expect(m.checklistBacking).toBeUndefined();
  });

  it("merges vendorIds both ways, whoever wins", () => {
    const existing = row({ source: "checklistcenter", vendorIds: { cardhedge: "ch-1" } });
    delete (existing as Partial<CardCatalogEntry>).confidence;
    const won = mergeCatalogEntries(incoming({ source: "checklistcenter-2026-08-29", vendorIds: { cardsight: "cs-1" } }), existing, NOW).merged;
    expect(won.vendorIds).toEqual({ cardhedge: "ch-1", cardsight: "cs-1" });
    const lost = mergeCatalogEntries(incoming({ source: "ingest-auto-seed", confidence: 0.5, vendorIds: { cardsight: "cs-1" } }), existing, NOW).merged;
    expect(lost.vendorIds).toEqual({ cardhedge: "ch-1", cardsight: "cs-1" });
  });
});
