// CF-PLAYER-PRECISION-IS-NOT-AWAITING-CATALOG (Drew, 2026-08-14).
//
// PLAYER_FALLBACK_CARDNUMBER mints `pf-<playerSlug>` so a row can land WITHOUT
// cardNumber precision; CATALOG_MATCH_ONLY then rejects it for not matching a
// card. The two cancel, and 6,100 slugs / 70,732 sales piled up in
// `awaiting-catalog` — a status that claims they are waiting for a checklist.
// No checklist can contain a card numbered "pf-league-debut-almost-complete".
//
// The routing predicate is pinned here because it is the whole distinction:
// pf- must sit in the cardNumber SLOT, not merely appear somewhere in the slug.
import { describe, it, expect } from "vitest";

/** Mirrors the predicate in promotionJob.service.ts. */
const isPlayerPrecision = (slug: string) => /^hiq:[^:]*:[^:]*:[^:]*:pf-/.test(String(slug ?? ""));

describe("player-precision routing predicate", () => {
  it("matches pf- in the cardNumber slot", () => {
    expect(isPlayerPrecision("hiq:baseball:2025:topps:pf-league-debut-almost-complete:base:no-auto")).toBe(true);
    expect(isPlayerPrecision("hiq:baseball:2015:bowman-draft:pf-taylor-ward-dividends:base:auto")).toBe(true);
    expect(isPlayerPrecision("hiq:baseball:1952:topps:pf-johnny-groth:base:no-auto:num-25")).toBe(true);
  });

  it("does NOT match a real card number that merely starts with p/f letters", () => {
    expect(isPlayerPrecision("hiq:baseball:2024:bowman-chrome:pdc-112:refractor:no-auto:num-399")).toBe(false);
    expect(isPlayerPrecision("hiq:baseball:2026:bowman:pf:base:no-auto")).toBe(false);
    expect(isPlayerPrecision("hiq:football:2026:topps:pfa-12:base:auto")).toBe(false);
  });

  it("does NOT match pf- appearing in a LATER segment", () => {
    // A parallel or set slug containing "pf-" must not be mistaken for a
    // player-fallback card number — the slot is what carries the meaning.
    expect(isPlayerPrecision("hiq:baseball:2025:topps:24:pf-gold:no-auto")).toBe(false);
    expect(isPlayerPrecision("hiq:baseball:2025:pf-set:24:base:no-auto")).toBe(false);
  });

  it("does not blow up on malformed input", () => {
    expect(isPlayerPrecision("")).toBe(false);
    expect(isPlayerPrecision("hiq:baseball")).toBe(false);
  });
});
