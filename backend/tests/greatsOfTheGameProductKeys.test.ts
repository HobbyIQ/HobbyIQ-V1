// GREATS OF THE GAME — a named product is its own card set (Drew, 2026-09-15).
//
// Four products carry "Greats of the Game" or "Greats" in their name. None was
// registered, so two survived only because no family catch-all happened to
// name them, and the others were being swallowed:
//
//   fleer-greats-of-the-game               -> fleer        COLLAPSED
//   upper-deck-greats-of-the-game          -> upper-deck   COLLAPSED
//   sports-illustrated-greats-of-the-game  -> itself       (by luck)
//   donruss-greats                         -> itself       (by luck)
//
// That is CF-FLAGSHIP-CATCH-ALL-SWALLOWS-SPECIALIZATIONS: a bare brand regex
// discarding the qualifier. Measured read-only 2026-09-15, the cost is 2,961
// POOL rows titled "… Greats of the Game" addressed to bare `fleer` — 1,518 in
// 2001 and 1,443 in 2002 — because no other destination resolves.
//
// Registering a key is what makes it survive, and it is NOT enough on its own:
// normalizeSetKey asks productSetKeyForName first, and that resolves by SPELLED
// name, so a bare P() entry still lost to the catch-all until an explicit
// pattern was placed ahead of it (the same finding as R62, #2219).

import { describe, it, expect } from "vitest";
import { isProductSetKey, productParentOf, productFamilyOf } from "../src/services/catalog/productSetKeys";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

const REGISTERED = [
  "fleer-greats-of-the-game",
  "sports-illustrated-greats-of-the-game",
  "donruss-greats",
];

describe("Greats of the Game product keys", () => {
  it("registers the three keys whose evidence is settled", () => {
    expect(REGISTERED.filter((k) => !isProductSetKey(k))).toEqual([]);
  });

  it("each is a normalizeSetKey FIXED POINT — the point of registering", () => {
    const collapsed = REGISTERED
      .filter((k) => normalizeSetKey(k) !== k)
      .map((k) => `${k} -> ${normalizeSetKey(k)}`);
    expect(collapsed).toEqual([]);
  });

  it("fleer-greats-of-the-game specifically no longer lands on bare fleer", () => {
    // The 2,961 mis-addressed pool rows have nowhere to go until this holds.
    expect(normalizeSetKey("fleer-greats-of-the-game")).not.toBe("fleer");
    expect(normalizeSetKey("fleer-greats-of-the-game")).toBe("fleer-greats-of-the-game");
  });

  it("nests each under its maker so the matcher can still widen", () => {
    expect(productParentOf("fleer-greats-of-the-game")).toBe("fleer");
    expect(productFamilyOf("fleer-greats-of-the-game")).toBe("fleer");
    // Donruss Greats is a Panini-era Donruss product; `donruss` itself
    // normalizes to panini-donruss, so that is the parent.
    expect(productParentOf("donruss-greats")).toBe("panini-donruss");
    // Sports Illustrated is not a Fleer/UD/Panini line — it is its own family.
    expect(productFamilyOf("sports-illustrated-greats-of-the-game"))
      .toBe("sports-illustrated-greats-of-the-game");
  });

  it("is a specialisation, not a hole — the family catch-alls still catch", () => {
    // The mutation check: the new pattern names one product exactly, and
    // anything else under Fleer still answers to /fleer/.
    expect(isProductSetKey("fleer-nonesuch")).toBe(false);
    expect(normalizeSetKey("fleer-nonesuch")).toBe("fleer");
    expect(normalizeSetKey("fleer")).toBe("fleer");
    expect(normalizeSetKey("fleer-tradition")).toBe("fleer-tradition");
    expect(normalizeSetKey("fleer-ultra")).toBe("ultra");
    expect(normalizeSetKey("donruss")).toBe("panini-donruss");
    expect(normalizeSetKey("panini-donruss")).toBe("panini-donruss");
    expect(normalizeSetKey("upper-deck")).toBe("upper-deck");
  });

  it("does NOT register the 2006 product — its key form is with Drew", () => {
    // 4,797 checklist-backed rows are spelled "2006 Greats of the Game" in
    // 4,796 of them, with no maker in the name, and the 2006 `upper-deck` pool
    // holds ZERO rows titled Greats of the Game. R51 attributed the product to
    // Upper Deck; the evidence points the other way, so the recheck is with
    // Drew and neither candidate key is registered here. Absent beats wrong.
    expect(isProductSetKey("upper-deck-greats-of-the-game")).toBe(false);
    expect(isProductSetKey("greats-of-the-game")).toBe(false);
  });
});
