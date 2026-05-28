/**
 * Unit tests for canonicalizePlayerName + the playerName-canonicalization
 * gate on getPlayerScoreByName.
 *
 * CF-PLAYERNAME-CANONICALIZATION (2026-05-28). The fix:
 *   1. canonicalizePlayerName composes NFKD accent strip + lowercase +
 *      punctuation strip (periods, commas, apostrophes incl. curly
 *      variants) + suffix drop (jr|sr|ii|iii|iv) + whitespace collapse.
 *   2. upsertPlayerScore sets playerNameNormalized on every write.
 *   3. getPlayerScoreByName queries the normalized field with indexed
 *      exact-match (primary) and falls back to LOWER(playerName) for
 *      documents not yet backfilled (legacy fallback, removed after
 *      backfill completes).
 *
 * Test coverage:
 *   - canonicalizePlayerName cases including the Witt period anomaly,
 *     synthetic accented "Ronald Acuña Jr." (no current stored player
 *     has accents because the write path was already accent-stripping,
 *     but caller forms WILL come in with accents — this is the
 *     show-relevant class), apostrophe handling, hyphen preservation,
 *     empty/null/undefined safety
 *   - Determinism: same input → same output across many calls
 *   - Regression: clean stored names that already matched continue to
 *     match (no false negatives introduced)
 */
import { describe, it, expect } from "vitest";
import { canonicalizePlayerName } from "../src/types/playerScore";

describe("canonicalizePlayerName — punctuation + suffix + accents", () => {
  it("collapses Jr. (with period) and Jr (no period) to the same form — the production anomaly", () => {
    // The Bobby Witt Jr. case that surfaced the entire CF.
    // Stored as "Bobby Witt Jr" (no period); MLB Stats API supplies
    // "Bobby Witt Jr." (with period). Both must canonicalize identically.
    expect(canonicalizePlayerName("Bobby Witt Jr.")).toBe("bobby witt");
    expect(canonicalizePlayerName("Bobby Witt Jr")).toBe("bobby witt");
    expect(canonicalizePlayerName("Bobby Witt Jr.")).toBe(
      canonicalizePlayerName("Bobby Witt Jr"),
    );
  });

  it("strips Latin accents via NFKD + combining mark removal", () => {
    // Synthetic Acuña case — caller will pass MLB API form "Acuña" while
    // the write path already strips to "Acuna". Both forms must
    // canonicalize identically post-fix. This is the show-relevant
    // class (current rosters: Acuña, Peña, Suárez, Devers, etc.).
    expect(canonicalizePlayerName("Ronald Acuña Jr.")).toBe("ronald acuna");
    expect(canonicalizePlayerName("Ronald Acuna Jr.")).toBe("ronald acuna");
    expect(canonicalizePlayerName("Ronald Acuña Jr.")).toBe(
      canonicalizePlayerName("Ronald Acuna Jr."),
    );

    // Other common accents
    expect(canonicalizePlayerName("Peña")).toBe("pena");
    expect(canonicalizePlayerName("Suárez")).toBe("suarez");
    expect(canonicalizePlayerName("Yoán Moncada")).toBe("yoan moncada");
  });

  it("strips apostrophe variants (straight + curly + backtick)", () => {
    expect(canonicalizePlayerName("O'Brien")).toBe("obrien");
    expect(canonicalizePlayerName("O’Brien")).toBe("obrien"); // curly right single quote U+2019
    expect(canonicalizePlayerName("O‘Brien")).toBe("obrien"); // curly left single quote U+2018
    expect(canonicalizePlayerName("O`Brien")).toBe("obrien"); // backtick
  });

  it("preserves hyphens — Sosa-Lopez is a distinct real name", () => {
    expect(canonicalizePlayerName("Sosa-Lopez")).toBe("sosa-lopez");
    // not collapsed to "sosalopez"
    expect(canonicalizePlayerName("Sosa-Lopez")).not.toBe(canonicalizePlayerName("Sosalopez"));
  });

  it("drops all common suffix forms with or without period", () => {
    expect(canonicalizePlayerName("Ken Griffey Jr.")).toBe("ken griffey");
    expect(canonicalizePlayerName("Cal Ripken Sr")).toBe("cal ripken");
    expect(canonicalizePlayerName("Ken Griffey II")).toBe("ken griffey");
    expect(canonicalizePlayerName("Ken Griffey III.")).toBe("ken griffey");
    expect(canonicalizePlayerName("Some Player IV")).toBe("some player");
  });

  it("collapses multi-space and trims leading/trailing whitespace", () => {
    expect(canonicalizePlayerName("  Mike   Trout  ")).toBe("mike trout");
    expect(canonicalizePlayerName("\tBobby Witt Jr.\n")).toBe("bobby witt");
  });

  it("regression: clean stored names canonicalize to a stable lowercase form", () => {
    // Sampled from the actual 76 stored players in player_trends as of
    // 2026-05-28. None of these should mismatch the existing storage.
    expect(canonicalizePlayerName("Mike Trout")).toBe("mike trout");
    expect(canonicalizePlayerName("Aaron Judge")).toBe("aaron judge");
    expect(canonicalizePlayerName("Shohei Ohtani")).toBe("shohei ohtani");
    expect(canonicalizePlayerName("Greg Maddux")).toBe("greg maddux");
    expect(canonicalizePlayerName("Wander Franco")).toBe("wander franco");
    expect(canonicalizePlayerName("Caleb Bonemer")).toBe("caleb bonemer");
    expect(canonicalizePlayerName("Bobby Cox")).toBe("bobby cox");
  });

  it("handles empty / null / undefined / whitespace-only without throwing", () => {
    expect(canonicalizePlayerName("")).toBe("");
    expect(canonicalizePlayerName(null)).toBe("");
    expect(canonicalizePlayerName(undefined)).toBe("");
    expect(canonicalizePlayerName("   ")).toBe("");
  });

  it("is deterministic across repeated calls (same input → same output)", () => {
    const inputs = [
      "Bobby Witt Jr.",
      "Ronald Acuña Jr.",
      "Mike Trout",
      "",
      "  Caleb Bonemer  ",
    ];
    for (const input of inputs) {
      const first = canonicalizePlayerName(input);
      for (let i = 0; i < 50; i++) {
        expect(canonicalizePlayerName(input)).toBe(first);
      }
    }
  });

  it("case-insensitivity: upper / lower / mixed case all produce the same output", () => {
    expect(canonicalizePlayerName("BOBBY WITT JR.")).toBe("bobby witt");
    expect(canonicalizePlayerName("bobby witt jr.")).toBe("bobby witt");
    expect(canonicalizePlayerName("Bobby Witt Jr.")).toBe("bobby witt");
  });
});
