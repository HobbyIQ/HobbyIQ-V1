/**
 * CF-A-ROOKIE-MARKER-IS-NOT-A-DIFFERENT-PLAYER (2026-09-19).
 *
 * #2294 fixed cleanPlayerName so the catalog stops MINTING "jonah-tong-rc" as
 * a playerSlug. But playerIdentityKey.ts -- the single reduction the fold
 * lane's "different player" contention runs on (CF-A-FOLD-NEVER-CHANGES-THE-
 * PLAYER, catalogRowOps.service.ts's playerKeyOf) -- read the STORED
 * playerName field directly, so every row minted before #2294 (or minted by
 * one of the mint paths #2294 did not thread cleanPlayerName through) still
 * produced a DIFFERENT key for "Jonah Tong RC" than for "Jonah Tong":
 * jonahtongrc vs jonahtong. That reads as two different players at one
 * card number, and either gets arbitrated on corroboration/sale-title
 * evidence that has nothing to do with the real question, or REFUSED
 * outright when neither side is corroborated. RC-suffixed rows are, by
 * construction, rookies -- so this concentrated the damage on exactly the
 * population a fold decision matters most for.
 *
 * This pins playerIdentityKey routing through cleanPlayerName FIRST (on the
 * original-case string, before this function's own lowercasing -- the RC
 * strip is case-sensitive by design) so the RC row and its clean sibling
 * reduce to the SAME key, while everything the Pokemon-name fixture file
 * already pins (accents, identity symbols, genuine-suffix contentions) stays
 * exactly as it was -- cleanPlayerName's own regexes are ASCII-only and
 * cannot touch a Pokemon symbol or accent.
 */
import { describe, expect, it } from "vitest";
import { playerIdentityKey } from "../src/services/catalog/playerIdentityKey.js";

describe("playerIdentityKey -- the RC family folds onto the clean spelling", () => {
  it.each([
    ["Jonah Tong RC", "Jonah Tong"],
    ["Jonah Tong RC*", "Jonah Tong"],
    ["Jonah Tong (RC)", "Jonah Tong"],
    ["Mike Trout RC", "Mike Trout"],
  ])("%s == %s", (a, b) => {
    expect(playerIdentityKey(a)).toBe(playerIdentityKey(b));
  });

  it("the reduction is already lowercase-invariant -- an already-lowercased RC still folds", () => {
    // playerIdentityKey itself lowercases before it would ever see this, but
    // cleanPlayerName's RC strip runs FIRST on the original case, so this
    // guards the ordering: if cleanPlayerName ran after the lowercase step it
    // would never match "rc" (case-sensitive by design) and this would fail.
    expect(playerIdentityKey("Jonah Tong RC")).toBe(playerIdentityKey("jonah tong"));
  });

  it("combines with the pre-existing generational-suffix comma case", () => {
    expect(playerIdentityKey("Bobby Witt, Jr. RC")).toBe(playerIdentityKey("Bobby Witt Jr."));
  });
});

describe("playerIdentityKey -- what the RC fold does NOT do", () => {
  it("genuinely different players stay different, RC or not", () => {
    expect(playerIdentityKey("Jonah Tong RC")).not.toBe(playerIdentityKey("Mike Trout"));
    expect(playerIdentityKey("Aaron Judge")).not.toBe(playerIdentityKey("Aaron Nola"));
  });

  it("a name that merely ends in those letters without the marker's shape stays its own key", () => {
    // Same guards cleanPlayerName itself pins: no space before "RC", wrong
    // case, or "R" alone (not the two-letter token) must not fold onto
    // anything else.
    expect(playerIdentityKey("Marc")).not.toBe(playerIdentityKey("Ma"));
    expect(playerIdentityKey("DuPRC")).not.toBe(playerIdentityKey("Du"));
    expect(playerIdentityKey("J.R. Richard")).toBe(playerIdentityKey("JR Richard"));
    expect(playerIdentityKey("J.R. Richard")).not.toBe(playerIdentityKey("J."));
  });

  it("R72 (owner, 2026-09-19): TC/UER/SP/SSP/RR/DP/tier-letter rows NOW fold onto the clean spelling", () => {
    // cleanPlayerName was extended by R72 to strip these too, so this
    // reduction inherits the change unchanged -- see this file's header and
    // cardCatalog.service.ts's cleanPlayerName header for the ruling. Folding
    // the KEY is not folding the CARD: this is a VETO the fold guard consults
    // (catalogRowOps.service.ts's arbitratePlayer, "different player ->
    // refuse"), never a merge trigger by itself -- see the header above.
    expect(playerIdentityKey("New York Yankees TC")).toBe(playerIdentityKey("New York Yankees"));
    expect(playerIdentityKey("Mike Trout UER")).toBe(playerIdentityKey("Mike Trout"));
    expect(playerIdentityKey("Jonah Tong SP")).toBe(playerIdentityKey("Jonah Tong"));
    expect(playerIdentityKey("Jonah Tong SSP")).toBe(playerIdentityKey("Jonah Tong"));
    expect(playerIdentityKey("Al Leiter RR")).toBe(playerIdentityKey("Al Leiter"));
    expect(playerIdentityKey("Luis De Los Santos DP")).toBe(playerIdentityKey("Luis De Los Santos"));
    expect(playerIdentityKey("Rich Hunter B RC")).toBe(playerIdentityKey("Rich Hunter"));
  });

  it("Pokemon identity symbols and accents are unaffected -- cleanPlayerName's regexes are ASCII-only", () => {
    // Re-asserts the load-bearing pins from playerIdentityKeyPokemonNames.test.ts
    // are untouched by this change, inline so a regression here is visible
    // without cross-referencing the other file.
    expect(playerIdentityKey("Suicune ☆")).not.toBe(playerIdentityKey("Suicune"));
    expect(playerIdentityKey("Nidoran♀")).not.toBe(playerIdentityKey("Nidoran♂"));
    expect(playerIdentityKey("Miracle Sphere α")).toBe(playerIdentityKey("Miracle Sphere Alpha"));
    expect(playerIdentityKey("Flabébé")).toBe(playerIdentityKey("Flabebe"));
  });

  it("a bare RC token with no space before it is untouched (matches cleanPlayerName's own guard)", () => {
    expect(playerIdentityKey("MarcRC")).not.toBe(playerIdentityKey("Marc"));
  });
});

describe("playerIdentityKey -- empty and absent still reduce to the empty key", () => {
  it.each([null, undefined, "", "   "])("%s -> \"\"", (v) => {
    expect(playerIdentityKey(v)).toBe("");
  });
});
