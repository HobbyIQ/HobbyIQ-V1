/**
 * CF-A-JAPANESE-CARD-IS-NOT-AN-ENGLISH-CARD (2026-09-06) -- the market guard on
 * the re-key lane, pinned.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * `rekey-product-setkey MODE=catalog` had ONE refusal: a DIFFERENT PLAYER at
 * the destination (CF-A-FOLD-NEVER-CHANGES-THE-PLAYER). Player is the wrong
 * axis for a market error, because both markets print the SAME Pokemon at the
 * SAME number.
 *
 * Measured read-only on the cell the ruling names -- pokemon/2023, setKey
 * `151` -> `sv03-5` (the ENGLISH tcgdex code for Scarlet & Violet 151):
 *
 *     715 catalog rows carry setKey `151`, across three setNames:
 *       398  "2023 151 Pokemon"
 *       169  "2023 Pokemon Scarlet & Violet 151"           ENGLISH
 *       148  "2023 Pokemon Japanese Scarlet & Violet 151"  JAPANESE
 *
 * All 148 Japanese rows share a card number with an English row naming the
 * SAME PLAYER -- 148 of 148, zero different-player pairs -- so the player
 * guard had nothing to say and report run 34061675440 refused 0. 146 of those
 * rows would have minted fresh ENGLISH identities under `sv03-5`.
 *
 * ── WHAT IS PINNED HERE ─────────────────────────────────────────────────────
 *
 * The guard is a pure function over a row and a destination key, so it is
 * tested DIRECTLY rather than through a Cosmos run -- and the fixtures are the
 * real shapes measured in the cell above, not invented ones. The lane's WIRING
 * (that the guard is consulted before the slug is formed, that its refusals
 * are counted and reconciled) is pinned against the script source, the same
 * way rekeyRetireUntwinned.test.ts pins its branch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const SCRIPT = path.resolve(__dirname, "..", "scripts", "rekey-product-setkey.cjs");
const SRC = readFileSync(SCRIPT, "utf8");

const guard = require_(path.resolve(__dirname, "..", "scripts", "lib", "market-guard.cjs")) as {
  marketOfKey: (k: unknown) => string | null;
  marketOfRow: (r: unknown) => string | null;
  marketVerdict: (r: unknown, to: unknown, sport?: unknown) => {
    allowed: boolean; reason: string | null; rowMarket: string | null; toMarket: string | null;
  };
};

/** The English tcgdex code for Scarlet & Violet 151, and the Japanese one. */
const EN_151 = "sv03-5";
const JA_151 = "sv2a";

/** Real rows from the cell, verbatim in the fields the guard reads. */
const JA_ROW = {
  id: "hiq:pokemon:2023:151:93:master-ball:no-auto",
  setKey: "151",
  setName: "2023 Pokemon Japanese Scarlet & Violet 151",
  playerName: "Haunter",
  cardNumber: "93",
  parallel: "Master Ball",
  sport: "pokemon",
};
const EN_ROW = {
  id: "hiq:pokemon:2023:151:4:reverse-foil:no-auto",
  setKey: "151",
  setName: "2023 Pokemon Scarlet & Violet 151",
  playerName: "Charmander",
  cardNumber: "4",
  parallel: "Reverse Foil",
  sport: "pokemon",
};

// ── 1. the code tables still say what the guard depends on ──────────────────

describe("the two 151s are different products in different markets", () => {
  it("sv03-5 is ENGLISH and sv2a is JAPANESE", () => {
    expect(guard.marketOfKey(EN_151)).toBe("en");
    expect(guard.marketOfKey(JA_151)).toBe("ja");
  });

  it("the bare spelling `151` states NO market -- which is why the cell was mixed", () => {
    // `151` is a set NAME both markets use, not a code. If it ever started
    // stating a market this guard's whole premise would need re-deriving.
    expect(guard.marketOfKey("151")).toBeNull();
  });
});

// ── 2. THE RULING: a row may never cross the market line ────────────────────

describe("a Japanese row may never be re-keyed onto an English code", () => {
  it("REFUSES the JA-named row onto sv03-5, with a NAMED reason", () => {
    const v = guard.marketVerdict(JA_ROW, EN_151, "pokemon");
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("cross-market");
    expect(v.rowMarket).toBe("ja");
    expect(v.toMarket).toBe("en");
  });

  it("...AND VICE VERSA -- an English row onto the Japanese code", () => {
    // The ruling is symmetric. A guard that only blocked one direction would
    // let the reverse dispatch pool English cards into the Japanese pool.
    const v = guard.marketVerdict({ ...EN_ROW, setKey: EN_151 }, JA_151, "pokemon");
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("cross-market");
    expect(v.rowMarket).toBe("en");
    expect(v.toMarket).toBe("ja");
  });

  it("ALLOWS an English row onto the English code -- the lane still works", () => {
    // The point of the guard is to subtract WRONG moves, not to stop the lane.
    expect(guard.marketVerdict(EN_ROW, EN_151, "pokemon").allowed).toBe(true);
  });

  it("ALLOWS the Japanese row onto the JAPANESE code -- where it belongs", () => {
    expect(guard.marketVerdict(JA_ROW, JA_151, "pokemon").allowed).toBe(true);
  });
});

// ── 3. the two witnesses, and the silence that is not a witness ─────────────

describe("what fixes a row's market", () => {
  it("the SET NAME, which is the resolver's own test (hobbyIqCardId:1817)", () => {
    expect(guard.marketOfRow({ setName: "2023 Pokemon Japanese Scarlet & Violet 151" })).toBe("ja");
  });

  it("a sale's TITLE -- the pool lane's rows carry no setName", () => {
    expect(guard.marketOfRow({ title: "2023 Pokemon Japanese 151 Charizard Master Ball PSA 10" })).toBe("ja");
  });

  it("the STORED KEY, when the name says nothing", () => {
    expect(guard.marketOfRow({ setName: "2023 151 Pokemon", setKey: JA_151 })).toBe("ja");
  });

  it("the `japanese-<code>` minter artefact states JA outright", () => {
    expect(guard.marketOfKey("japanese-sv2a")).toBe("ja");
  });

  it("SILENCE IS NOT AN ACCUSATION -- an unmarked row still moves", () => {
    // 398 rows in the live cell are named "2023 151 Pokemon" and state no
    // market at all. A guard that refused those would refuse most of its
    // corpus and be switched off, which protects nothing.
    const row = { setName: "2023 151 Pokemon", setKey: "151", id: "hiq:pokemon:2023:151:9:base:no-auto" };
    expect(guard.marketOfRow(row)).toBeNull();
    expect(guard.marketVerdict(row, EN_151, "pokemon").allowed).toBe(true);
  });

  it("an AMBIGUOUS code states no market -- both markets use it differently", () => {
    // `neo1`, `sm1`, `xy2` ... name different products in the two markets,
    // which is why AMBIGUOUS_MARKET_CODES exists.
    expect(guard.marketOfKey("neo1")).toBeNull();
    expect(guard.marketOfKey("sm1")).toBeNull();
  });

  it("is POKEMON-ONLY -- every other sport is untouched", () => {
    // The EN/JA split is a Pokemon fact and these are Pokemon tables. A
    // baseball row saying "Japanese" must not change this lane's behaviour.
    expect(guard.marketVerdict({ setName: "Japanese whatever" }, EN_151, "baseball").allowed).toBe(true);
  });
});

// ── 4. THE FIXTURE THE DEFECT WAS MEASURED ON ───────────────────────────────

describe("the 151 cell, as measured 2026-09-06", () => {
  /** The three setNames the live cell holds, with their real counts. */
  const CELL: Array<{ setName: string; n: number; market: string | null }> = [
    { setName: "2023 151 Pokemon", n: 398, market: null },
    { setName: "2023 Pokemon Scarlet & Violet 151", n: 169, market: null },
    { setName: "2023 Pokemon Japanese Scarlet & Violet 151", n: 148, market: "ja" },
  ];

  it("715 rows, and ONLY the 148 Japanese ones are refused onto sv03-5", () => {
    let refused = 0;
    let allowed = 0;
    for (const c of CELL) {
      const v = guard.marketVerdict({ setName: c.setName, setKey: "151" }, EN_151, "pokemon");
      if (v.allowed) allowed += c.n; else refused += c.n;
    }
    expect(refused).toBe(148);
    expect(allowed).toBe(567);
    expect(refused + allowed).toBe(715);
  });

  it("each setName's market reading is what the census measured", () => {
    for (const c of CELL) {
      expect(guard.marketOfRow({ setName: c.setName }), c.setName).toBe(c.market);
    }
  });
});

// ── 5. THE WIRING: the guard is consulted, counted and reconciled ───────────

describe("the lane actually consults the guard", () => {
  it("MODE=catalog asks BEFORE the destination slug is formed", () => {
    // If the guard moved below `parts[3] = TO`, a refused row would already
    // have a destination and a later edit could act on it.
    const call = SRC.indexOf("const mv = marketVerdict(d, TO, SPORT);");
    const slug = SRC.indexOf("parts[3] = TO;");
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(slug);
  });

  it("MODE=pool asks too -- a JA sale must never price an EN card", () => {
    expect(SRC).toContain("const mv = marketVerdict(row, TO, SPORT);");
  });

  it("a refusal RETURNS -- it must not fall through into the move", () => {
    const branch = SRC.slice(SRC.indexOf("const mv = marketVerdict(d, TO, SPORT);"), SRC.indexOf("parts[3] = TO;"));
    expect(branch).toContain("s.refusedCrossMarket++;");
    expect(branch).toContain("return;");
  });

  it("the refusal is COUNTED in both lanes' banners", () => {
    const banners = SRC.split("REFUSED (cross-market)").length - 1;
    // once per lane's banner line, plus the per-row report lines
    expect(banners).toBeGreaterThanOrEqual(4);
    expect(SRC).toContain("refusedCrossMarket: 0,");
  });

  it("the refusal is RECONCILED as a SKIP -- the arithmetic must still close", () => {
    // A refusal is not a write and not a failure. Left out of the skipped
    // term, reportWrites would flag a correct run as a mismatch.
    expect(SRC).toContain("+ s.refusedDifferentPlayer + s.refusedCrossMarket;");
    expect(SRC).toContain("s.notIdentityRow + s.notReached + s.refusedCrossMarket, s.failed);");
  });
});

// ── MUTATION CHECKS ─────────────────────────────────────────────────────────

describe("MUTATION: the market guard", () => {
  it("a mutant that DROPPED the guard would move all 148 -- this goes red", () => {
    // The single check that fails if the call is deleted from either lane.
    expect(SRC).toContain("marketVerdict(d, TO, SPORT)");
    expect(SRC).toContain("marketVerdict(row, TO, SPORT)");
    expect(guard.marketVerdict(JA_ROW, EN_151, "pokemon").allowed).toBe(false);
  });

  it("a mutant that only read the KEY would miss all 148 -- they are keyed `151`", () => {
    // Every one of the 148 carries setKey `151`, which states NO market. A
    // guard reading only the stored key would refuse none of them, reproduce
    // run 34061675440's 0-refusals exactly, and look like it worked.
    expect(guard.marketOfKey(JA_ROW.setKey)).toBeNull();
    expect(guard.marketOfRow(JA_ROW)).toBe("ja");
  });

  it("a mutant that refused on ONE side speaking would refuse the whole corpus", () => {
    // Both sides must speak AND disagree. If a silent row were refused, the
    // 398 "2023 151 Pokemon" rows would refuse too and the lane would stall.
    expect(guard.marketVerdict({ setName: "2023 151 Pokemon" }, EN_151, "pokemon").allowed).toBe(true);
    expect(guard.marketVerdict(JA_ROW, "some-key-with-no-market", "pokemon").allowed).toBe(true);
  });

  it("a mutant that made the guard one-directional would still pool EN into JA", () => {
    const a = guard.marketVerdict(JA_ROW, EN_151, "pokemon").allowed;
    const b = guard.marketVerdict({ setKey: EN_151, setName: "x" }, JA_151, "pokemon").allowed;
    expect(a).toBe(false);
    expect(b).toBe(false);
  });

  it("a mutant that treated an AMBIGUOUS code as a market would misroute 24 products", () => {
    // Reading `neo1` as English (it is in the EN table too) would refuse every
    // Japanese neo1 row onto a destination that is equally Japanese.
    expect(guard.marketOfKey("neo1")).toBeNull();
    expect(guard.marketVerdict({ setKey: "neo1", setName: "x" }, JA_151, "pokemon").allowed).toBe(true);
  });
});
