// CF-A-PLAYER-SEGMENT-IS-A-PERSON (Drew, 2026-09-04) -- the pins.
//
// A player segment must be a PERSON'S NAME, or nothing. The three rows below
// are the ones #1728's census surfaced, quoted verbatim from
// data/gap-reports/2026-09-04-player-pseudo-number-census.json's population:
//
//     player-kawhi-leonard-tie-dye     the PARALLEL is inside the name
//     player-mega-box-elly-de          the PRODUCT is inside the name, and
//                                      "Elly De La Cruz" was cut to "Elly De"
//     player-pokemon-swsh-fa-mew       not a person at all
//
// Each of them reproduced against the parser before the fix; the assertions
// here are the answers, not the observations.

import { describe, it, expect } from "vitest";
import { parseCardQuery } from "../src/services/compiq/cardQueryParser.js";
import { playerSegmentIsAPerson } from "../src/services/compiq/playerSegmentIsAPerson.js";

// ---------------------------------------------------------------------------
// 1. THE THREE CORRUPTED ROWS
// ---------------------------------------------------------------------------
describe("the three rows the census named", () => {
  it("a parallel is not part of the name -- Kawhi Leonard, not 'Kawhi Leonard Tie-Dye'", () => {
    // "Tie-Dye" is a real Panini Select parallel: 56 rows in our own checklist
    // corpus. The ~250-word NOISE list had never heard of it, so it was
    // promoted into the player's name.
    const p = parseCardQuery("2024 Panini Select Kawhi Leonard Tie-Dye Prizm #23 PSA 10");
    expect(p.playerName).toBe("Kawhi Leonard");
    expect(p.playerName).not.toMatch(/tie|dye/i);
  });

  it("a product is not part of the name, and the name is not cut -- 'Elly De La Cruz'", () => {
    // Two defects on one row: "Mega Box" (product) rode into the name, and the
    // `.slice(0, 4)` then cut the six-token residue mid-surname. The cut is the
    // half that made the result look plausible.
    const p = parseCardQuery("2023 Topps Chrome Mega Box Elly De La Cruz #150 Refractor");
    expect(p.playerName).toBe("Elly De La Cruz");
    expect(p.playerName).not.toMatch(/mega|box/i);
    // The specific truncation that was stored. A name ending on a particle is
    // always a cut, never a short name.
    expect(p.playerName).not.toBe("Mega Box Elly De");
    expect(p.playerName).not.toMatch(/\bde$/i);
  });

  it("a set code is not a person -- the pokemon row derives NOTHING, not a fake name", () => {
    // "SWSH" is Sword & Shield, "FA" is full art. Neither is a person, and
    // blank means unknown. The old parser produced "Pokemon Swsh Star Promo".
    const p = parseCardQuery("Pokemon SWSH Black Star Promo FA Mew VMAX #269");
    expect(p.playerName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. NEVER TRUNCATE
// ---------------------------------------------------------------------------
describe("a name that cannot be bounded is blank, never cut", () => {
  it("refuses rather than returning the first four words of a long residue", () => {
    // Set + player + team + fragment. There is no rule that recovers "Roy
    // Campanella" from this without guessing, so the answer is that we do not
    // know. Found by the census on a real stored row.
    const seg = playerSegmentIsAPerson("Berk Ross Campanella Brooklyn No", { year: 1952, setKey: null });
    expect(seg.player).toBeNull();
    expect(seg.reason).toBe("refused-unbounded");
  });

  it("a residue ending on a name particle is a CUT and is refused", () => {
    for (const cut of ["Elly De", "Vladimir Guerrero Van", "Jose De La"]) {
      expect(playerSegmentIsAPerson(cut, {}).player).toBeNull();
    }
  });

  it("keeps a real four-token name -- the ceiling refuses, it does not trim", () => {
    expect(playerSegmentIsAPerson("Elly De La Cruz", {}).player).toBe("Elly De La Cruz");
  });
});

// ---------------------------------------------------------------------------
// 3. THE CHECKLIST IS THE AUTHORITY
// ---------------------------------------------------------------------------
describe("the checklist outranks the title", () => {
  it("uses the checklist's player for the (year, setKey, cardNumber) when one exists", () => {
    const seg = playerSegmentIsAPerson("Elly Delacruz", {
      year: 2023, setKey: "topps-chrome", checklistPlayer: "Elly De La Cruz",
    });
    expect(seg.player).toBe("Elly De La Cruz");
    expect(seg.reason).toBe("checklist");
  });

  it("the checklist wins even when the title residue would have bounded cleanly", () => {
    const seg = playerSegmentIsAPerson("Mike Trout", {
      year: 2011, setKey: "topps-update", checklistPlayer: "Michael Nelson Trout",
    });
    expect(seg.player).toBe("Michael Nelson Trout");
  });
});

// ---------------------------------------------------------------------------
// 4. MULTI-PLAYER CARDS STAY ONE CARD
// ---------------------------------------------------------------------------
describe("a multi-player card is one card with several people on it", () => {
  it("keeps all three names -- the old parser cut this to two", () => {
    const p = parseCardQuery("1974-75 Topps Ken Dryden/Glenn Resch/Bernie Parent #1");
    expect(p.playerName).toBe("Ken Dryden/Glenn Resch/Bernie Parent");
  });

  it("does not keep a partial roster: if one side is not a person, the card is unknown", () => {
    // Minting "Ken Dryden" alone would key a three-player card onto the Dryden
    // single and merge two different cards' pools.
    const seg = playerSegmentIsAPerson("Ken Dryden/Superfractor", { year: 1974, setKey: "topps" });
    expect(seg.player).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. THE VINTAGE + SPLIT-SPELLING GAP
// ---------------------------------------------------------------------------
describe("finishes the 2020-floored corpus cannot supply", () => {
  it("strips Tiffany -- a Tiffany sale is a Tiffany card, not a base card", () => {
    const p = parseCardQuery("1987 Topps Traded Tiffany Greg Maddux #70T PSA 10");
    expect(p.playerName).toBe("Greg Maddux");
  });

  it("strips a finish the title spelled with a space -- 'X FRACTOR'", () => {
    const p = parseCardQuery("COOPER FLAGG 2025-26 Topps Chrome X FRACTOR Rookie PSA 10 gem mint");
    expect(p.playerName).toBe("Cooper Flagg");
  });
});

// ---------------------------------------------------------------------------
// 6. THE VOCABULARY IS ONE VOCABULARY
// ---------------------------------------------------------------------------
describe("the hand list mirrors the audit vocabulary and cannot drift", () => {
  it("every ADJUDICATED_FINISH_WORDS entry is in rematch-finish-vocab.cjs", async () => {
    // The mirror exists because src/ does not depend on scripts/. This asserts
    // it stays a SUBSET, so a word added here without being adjudicated there
    // is a RED -- add it to the vocabulary of record first.
    const { createRequire } = await import("node:module");
    const require_ = createRequire(import.meta.url);
    const VOCAB = require_("../scripts/lib/rematch-finish-vocab.cjs");
    const adjudicated = new Set<string>(
      [...VOCAB.CORE_FINISH_TOKENS, ...(VOCAB.HAND_SPELLINGS ?? []), ...(VOCAB.FINISH_FAMILY_TOKENS ?? [])]
        .map((w: string) => w.toLowerCase()),
    );
    const mirror = [
      "tiffany", "embossed", "glossy", "pennant", "premier", "photographers",
      "mahogany", "rapture", "peel", "reveal", "crusade", "unparalleled",
      "vector", "astral", "marvels", "unleashed", "proof", "proofs", "shield",
      "fractor", "refractor", "superfractor", "logofractor", "xfractor",
      "diecut", "holofoil",
    ];
    const strays = mirror.filter((w) => !adjudicated.has(w));
    expect(strays).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. THE SAMPLED REAL TITLES -- the fixture
// ---------------------------------------------------------------------------
describe("20 sampled real titles keep their players", () => {
  // Sampled from the sold_comps titles the census read on 2026-09-04. These are
  // the ROWS THAT WERE ALREADY RIGHT: the fix must not cost any of them, which
  // is the failure mode a stricter parser invites.
  const FIXTURE: [string, string | null][] = [
    ["2011 Topps Update Mike Trout Rookie #US175 PSA 10", "Mike Trout"],
    ["2018 Bowman Chrome Shohei Ohtani RC #BCP1 PSA 10", "Shohei Ohtani"],
    ["2023 Topps Chrome Julio Rodriguez Refractor #200", "Julio Rodriguez"],
    ["1989 Upper Deck Ken Griffey Jr. RC #1 PSA 9", "Ken Griffey Jr"],
    ["2024 Panini Prizm Victor Wembanyama Silver #1", "Victor Wembanyama"],
    ["2020 Topps Jose Altuve #150", "Jose Altuve"],
    ["1993 SP Derek Jeter Foil RC #279", "Derek Jeter"],
    ["1969 O-Pee-Chee Deckle #4 Roberto Clemente - Raw", "Roberto Clemente"],
    ["2024 Topps Chrome Paul Skenes Rookie #150 PSA 10", "Paul Skenes"],
    ["2003-04 Topps Chrome LeBron James Rookie #111", "Lebron James"],
    ["2017 Panini Prizm Patrick Mahomes Rookie #269", "Patrick Mahomes"],
    ["1986 Fleer Michael Jordan RC #57 PSA 8", "Michael Jordan"],
    ["2021 Topps Chrome Wander Franco Refractor #150", "Wander Franco"],
    ["2019 Bowman Chrome Bobby Witt Jr. Auto #CPA-BW", "Bobby Witt Jr"],
    ["2022 Topps Julio Rodriguez Rookie #650", "Julio Rodriguez"],
    ["2024 Bowman Chrome Jackson Holliday #BCP-1", "Jackson Holliday"],
    ["1998 Bowman Chrome Adrian Beltre Refractor #422", "Adrian Beltre"],
    ["2020 Panini Prizm Justin Herbert Rookie #325", "Justin Herbert"],
    ["2023 Bowman Chrome Jackson Chourio Auto #CPA-JC", "Jackson Chourio"],
    ["2015 Topps Kris Bryant Rookie #616 PSA 10", "Kris Bryant"],
  ];

  for (const [title, expected] of FIXTURE) {
    it(`keeps "${expected}" from: ${title.slice(0, 52)}`, () => {
      expect(parseCardQuery(title).playerName).toBe(expected);
    });
  }

  it("no fixture row derives a name carrying a vocabulary token", () => {
    for (const [title] of FIXTURE) {
      const n = parseCardQuery(title).playerName ?? "";
      expect(n).not.toMatch(/refractor|prizm|chrome|bowman|topps|panini|rookie|auto\b/i);
    }
  });
});
