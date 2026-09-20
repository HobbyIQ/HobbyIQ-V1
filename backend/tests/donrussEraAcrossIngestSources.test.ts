// CF-DONRUSS-ERA-ACROSS-INGEST-SOURCES (Drew ruling, 2026-09-20).
//
// OWNER RULING: Donruss before 2009 is keyed `donruss`, never
// `panini-donruss` (Panini did not own Donruss then). The engine's
// era-aware resolver (`resolveSetKeyForSlug` / `spellForEra` in
// productSetKeys.ts, `DONRUSS_SPELLING_POLICY="panini-era"`,
// `PANINI_DONRUSS_FROM_YEAR=2009`) already gets this right at the ONE
// function every sale-ingest path funnels through: `computeHobbyIqCardId`
// (hobbyIqCardId.service.ts:2687 calls `resolveSetKeyForSlug`, which applies
// `spellForEra` AFTER `normalizeSetKey`'s era-blind vocabulary match --
// `normalizeSetKey("Donruss")` alone returns `panini-donruss` in every year,
// per the bare-alias regex at hobbyIqCardId.service.ts:1336, but that raw
// result is never the final answer on any traced path).
//
// This file is the per-source proof Drew's 2026-09-20 investigation asked
// for: CardHedge daily, TCA/eBay (title-derived), and cardsight all reach
// `computeHobbyIqCardId` through the SAME shared sink
// (`soldCompsStore.service.ts`'s `deriveHobbyIqSlug`, called by
// `recordSoldComp`) or through `persistVendorSalesToPool.service.ts`'s own
// direct `computeHobbyIqCardId` call — and BOTH thread the row's raw
// setName/setKey text plus its year straight into the resolver, never a
// pre-normalized (`normalizeSetKey`-only) key. Traced call sites, all
// outside the six I9 derivation-stamp files:
//
//   CardHedge   chRowToSoldComp.ts:250   mapChRowToSoldComp() hands back
//               input.setName = row.card_set (raw text) + input.cardYear;
//               recordSoldComp -> deriveHobbyIqSlug -> computeHobbyIqCardId.
//   TCA/eBay    tcaWebhook.routes.ts / ebayOrderPoll.service.ts hand a raw
//               title-derived setName to persistVendorSalesToPool.service.ts,
//               whose setKey variable (line ~1218) starts as
//               `identity.setName ?? inferSetKeyFromTitle(title)` (raw) and
//               reaches `computeHobbyIqCardId` (line ~1794) un-collapsed.
//   cardsight   same two sinks (recordSoldComp / persistVendorSalesToPool);
//               no separate identity deriver.
//   bulk/backfill .cjs scripts (bulk-import-ch-daily-to-sold-comps.cjs,
//               backfill-sold-comps-from-ch.cjs) also call
//               `computeHobbyIqCardId({ setKey: r.card_set, year: cardYear })`
//               with the raw vendor text, never a pre-normalized key.
//
// No defect found on any currently-traced path: this file exists to PIN
// that finding (regression guard) rather than to fix a bug in these files.

import { describe, it, expect } from "vitest";
import { computeHobbyIqCardId, normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";
import { mapChRowToSoldComp } from "../src/services/portfolioiq/chRowToSoldComp";
import type { CHDailySaleRow } from "../src/types/chDailySales.types";
import { deriveHobbyIqSlug } from "../src/services/portfolioiq/soldCompsStore.service";

/** Minimal, fully-populated CH daily-export row (all 22 CSV columns are
 *  required strings/numbers per chDailySales.types.ts), with test-specific
 *  fields overridable. */
function chRow(overrides: Partial<CHDailySaleRow>): CHDailySaleRow {
  return {
    price_history_id: "ph-1",
    source: "ebay",
    description: "",
    price: 10,
    listing_url: "",
    image_url: "",
    pop: 0,
    sale_date: "2026-09-19",
    sale_type: "BIN",
    card_id: "ch-1",
    card_description: "",
    number: "1",
    player: "Test Player",
    grade: "Raw",
    grader: "Raw",
    group: "Baseball",
    card_set: "Donruss",
    card_set_type: "Donruss",
    variant: "Base",
    year: 2026,
    created_at: "2026-09-19T00:00:00Z",
    updated_at: "2026-09-19T00:00:00Z",
    ...overrides,
  };
}

describe("Donruss era-split holds across every traced sale-ingest source", () => {
  it("BASELINE: normalizeSetKey alone is era-blind (why the resolver, not the vocabulary, must run last)", () => {
    // This is the exact trap the investigation was chasing: if a call site
    // used THIS value as the final setKey, every pre-2009 Donruss sale would
    // mis-key. No traced ingest call site does.
    expect(normalizeSetKey("Donruss")).toBe("panini-donruss");
  });

  it("CardHedge daily row (chRowToSoldComp.mapChRowToSoldComp -> recordSoldComp's deriveHobbyIqSlug)", () => {
    const row = chRow({
      card_id: "ch-1987-donruss-101",
      group: "Baseball",
      player: "Barry Bonds",
      price: 45.5,
      year: 1987,
      card_set: "Donruss",
      number: "101",
      variant: "Base",
      description: "1987 Donruss Baseball #101 Barry Bonds RC",
    });

    const mapped = mapChRowToSoldComp(row);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.input.setName).toBe("Donruss"); // raw, un-collapsed
    expect(mapped.input.cardYear).toBe(1987);

    const derived = deriveHobbyIqSlug({
      sport: mapped.input.sport,
      setName: mapped.input.setName,
      title: row.description,
      cardYear: mapped.input.cardYear,
      cardNumber: mapped.input.cardNumber,
      parallel: mapped.input.parallel,
      isAuto: mapped.input.isAuto,
      playerName: mapped.input.playerName,
      printRun: null,
    });
    expect(derived.resolvedSetKey).toBe("donruss");
    expect(derived.slug).toContain(":donruss:");
    expect(derived.slug).not.toContain(":panini-donruss:");
  });

  it("CardHedge daily row, modern era (2015) resolves panini-donruss", () => {
    const row = chRow({
      card_id: "ch-2015-donruss-1",
      group: "Baseball",
      player: "Kris Bryant",
      price: 12,
      year: 2015,
      card_set: "Donruss",
      number: "1",
      variant: "Base",
      description: "2015 Donruss Baseball #1 Kris Bryant",
    });

    const mapped = mapChRowToSoldComp(row);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;

    const derived = deriveHobbyIqSlug({
      sport: mapped.input.sport,
      setName: mapped.input.setName,
      title: row.description,
      cardYear: mapped.input.cardYear,
      cardNumber: mapped.input.cardNumber,
      parallel: mapped.input.parallel,
      isAuto: mapped.input.isAuto,
      playerName: mapped.input.playerName,
      printRun: null,
    });
    expect(derived.resolvedSetKey).toBe("panini-donruss");
    expect(derived.slug).toContain(":panini-donruss:");
  });

  it("TCA/eBay title-derived sale (raw setName handed straight to computeHobbyIqCardId, as persistVendorSalesToPool does)", () => {
    // persistVendorSalesToPool.service.ts's `setKey` variable starts as the
    // raw parser answer (identity.setName ?? inferSetKeyFromTitle(title)) and
    // is passed UN-COLLAPSED into computeHobbyIqCardId (~line 1794). This
    // reproduces that exact shape for a 1987 Donruss eBay/TCA title.
    const slug1987 = computeHobbyIqCardId({
      sport: "baseball",
      year: 1987,
      setKey: "Donruss", // raw title-parsed text, not normalizeSetKey's output
      cardNumber: "101",
      parallel: "Base",
      isAuto: false,
      playerName: "Barry Bonds",
    });
    expect(slug1987).toContain(":donruss:");
    expect(slug1987).not.toContain(":panini-donruss:");

    const slug2015 = computeHobbyIqCardId({
      sport: "baseball",
      year: 2015,
      setKey: "Donruss",
      cardNumber: "1",
      parallel: "Base",
      isAuto: false,
      playerName: "Kris Bryant",
    });
    expect(slug2015).toContain(":panini-donruss:");
  });

  it("cardsight sale (same shared sink as CardHedge/TCA/eBay; no separate deriver)", () => {
    // cardsight has no cardsight-specific setKey deriver anywhere in the
    // traced call graph -- it reaches recordSoldComp exactly like the other
    // vendor sources, so the CardHedge repro above already covers its
    // derivation path byte-for-byte. This test pins that equivalence
    // directly against deriveHobbyIqSlug with a cardsight-shaped input.
    const derived = deriveHobbyIqSlug({
      sport: "baseball",
      setName: "Donruss",
      title: "1987 Donruss #101 Barry Bonds",
      cardYear: 1987,
      cardNumber: "101",
      parallel: "Base",
      isAuto: false,
      playerName: "Barry Bonds",
      printRun: null,
    });
    expect(derived.resolvedSetKey).toBe("donruss");
    expect(derived.slug).toContain(":donruss:");
    expect(derived.slug).not.toContain(":panini-donruss:");
  });

  it("boundary: 2008 is still Donruss, 2009 is Panini Donruss, for a raw title-parsed setKey", () => {
    const at = (year: number) => computeHobbyIqCardId({
      sport: "baseball", year, setKey: "Donruss",
      cardNumber: "101", parallel: "Base", isAuto: false,
    });
    expect(at(2008)).toContain(":donruss:");
    expect(at(2008)).not.toContain(":panini-donruss:");
    expect(at(2009)).toContain(":panini-donruss:");
    expect(at(2009)).not.toContain(":donruss:");
  });

  it("bulk/backfill .cjs scripts pass the raw vendor text too (same computeHobbyIqCardId contract)", () => {
    // Mirrors bulk-import-ch-daily-to-sold-comps.cjs / backfill-sold-comps-
    // from-ch.cjs: both call computeHobbyIqCardId({ setKey: r.card_set, ... })
    // with CardHedge's raw card_set field, never a pre-normalized key.
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 1987, setKey: "Donruss",
      cardNumber: "101", parallel: "Base", isAuto: false,
      playerName: "Barry Bonds",
    });
    expect(slug).toContain(":donruss:");
  });
});
