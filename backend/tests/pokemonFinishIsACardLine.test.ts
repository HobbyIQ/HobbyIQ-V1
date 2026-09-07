/**
 * CF-A-FINISH-IS-A-CARD-LINE (Drew, 2026-09-07).
 *
 * A Pokemon FINISH -- Holofoil / Reverse Holofoil / Normal, and the era
 * equivalents ("Cosmos Holo", "Cracked Ice") -- is a DISTINCT CARD LINE with
 * its own catalog row and its own pool. tcgdex checklists carry no finish, so
 * the finish is only ever written down by the MARKET, and a finish row is
 * therefore a checklist-backed identity PLUS AN ATTESTED ATTRIBUTE -- never an
 * identity minted from sales.
 *
 * WHAT THESE TESTS PIN, and why each one is here rather than left to review:
 *
 *   1. ONE TOKEN PER FINISH. The whole-pool census of 2026-09-06 (3,262,614
 *      Pokemon sold_comps rows) found ONE physical reverse finish split three
 *      ways -- reverse-holo 215,231 / reverse-foil 71,094 / reverse 12,712 --
 *      and the holo family split two ways (holofoil 3,915 / holo 280). Five
 *      pools for two cards. The vocabulary folds them; these tests assert the
 *      fold is total and that it is the ONLY fold.
 *
 *   2. REVERSE NEVER COLLAPSES ONTO HOLO. The single most damaging thing this
 *      vocabulary could do. A Reverse Holofoil and a Holofoil are different
 *      cards at different prices, and 215,231 reverse sales folded into a holo
 *      pool would be a silent, corpus-wide FMV corruption. Asserted as a
 *      FAMILY-WIDE property, not a spot check.
 *
 *   3. THE DISPLAY NAME IS A FIXED POINT THROUGH THE LIVE SLUG BUILDER. The
 *      lane writes `parallel: "Reverse Holofoil"` and the row's address is
 *      `:reverse-holofoil:`. If `normalizeParallel` ever disagreed, the row
 *      would be minted at one address and looked up at another -- the
 *      multi-home defect CF-ONE-CARD-ONE-ROW-ONE-POOL exists to prevent. This
 *      drives the REAL function, so a future edit to the slug builder breaks
 *      here rather than in production.
 *
 *   4. WHAT IS NOT A FINISH STAYS OUT. `1st-edition` is a separate axis by the
 *      ruling's own words; `full-art` is a card type; `master-ball` is a stamp.
 *      Admitting any of them would mint catalog rows for a distinction this
 *      ruling did not make.
 *
 *   5. THE LANE READS THE SHARED VOCABULARY. One list decides the question. A
 *      re-typed copy inside the lane would drift, and the drift would show up
 *      as the lane minting rows this file says it never mints.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { normalizeParallel } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

const require_ = createRequire(__filename);
const VOCAB_LIB = join(__dirname, "..", "scripts", "lib", "pokemon-finish-vocab.cjs");
const LANE = join(__dirname, "..", "scripts", "mint-attested-finish-rows.cjs");

const V = require_(VOCAB_LIB) as {
  FINISH_TOKENS: Readonly<Record<string, string>>;
  FINISH_DISPLAY: Readonly<Record<string, string>>;
  finishOf: (segment: string) => string | null;
  titleMarket: (title: string) => "en" | "ja" | null;
};

describe("CF-A-FINISH-IS-A-CARD-LINE — the vocabulary", () => {
  it("folds every market spelling of one finish onto ONE token", () => {
    // The reverse family: three spellings, 299,037 census sales, one card line.
    for (const spelling of ["reverse-holofoil", "reverse-holo", "reverse-foil", "reverse",
                            "reverse-holofoils", "reverse-holos", "reverse-foils"]) {
      expect(V.finishOf(spelling), `${spelling} must fold`).toBe("reverse-holofoil");
    }
    // The holo family: the census split these across two pools.
    for (const spelling of ["holofoil", "holo", "holofoils", "holos", "holo-rare", "foil", "foils"]) {
      expect(V.finishOf(spelling), `${spelling} must fold`).toBe("holofoil");
    }
    // Era finishes, each its own line.
    for (const spelling of ["cosmos-holo", "cosmos"]) expect(V.finishOf(spelling)).toBe("cosmos-holo");
    for (const spelling of ["cracked-ice", "cracked-ice-holo", "cracked-ice-holofoil"]) {
      expect(V.finishOf(spelling)).toBe("cracked-ice");
    }
    expect(V.finishOf("normal")).toBe("normal");
  });

  it("finishFamiliesStayApart — a reverse spelling NEVER answers holofoil", () => {
    // The property, not a spot check: every key naming a reverse must answer a
    // reverse, and no key naming a plain holo may answer a reverse. 215,231
    // reverse sales folded into a holo pool is a silent FMV corruption.
    for (const [spelling, token] of Object.entries(V.FINISH_TOKENS)) {
      if (/^reverse/.test(spelling)) {
        expect(token, `${spelling} leaked out of the reverse family`).toBe("reverse-holofoil");
      } else {
        expect(token, `${spelling} leaked INTO the reverse family`).not.toBe("reverse-holofoil");
      }
    }
    expect(V.finishOf("reverse-holo")).not.toBe(V.finishOf("holo"));
    expect(V.finishOf("reverse-holofoil")).not.toBe(V.finishOf("holofoil"));
  });

  it("finishDisplayNamesAreFixedPoints — the written name slugs back to the row's own address", () => {
    // Drives the REAL slug builder. A row minted with parallel "Reverse
    // Holofoil" must live at `:reverse-holofoil:` and be found there again.
    for (const [token, display] of Object.entries(V.FINISH_DISPLAY)) {
      expect(normalizeParallel(display), `"${display}" must slug to ${token}`).toBe(token);
      // And the token itself must survive a second pass unchanged, or a
      // re-derivation would walk the row to a new address.
      expect(normalizeParallel(token), `${token} must be a fixed point`).toBe(token);
    }
  });

  it("every canonical token has a display name, and every display name a token", () => {
    const canonical = new Set(Object.values(V.FINISH_TOKENS));
    for (const token of canonical) {
      expect(V.FINISH_DISPLAY[token], `${token} has no display name to write`).toBeTruthy();
    }
    for (const token of Object.keys(V.FINISH_DISPLAY)) {
      expect(canonical.has(token), `${token} is a display name nothing folds to`).toBe(true);
    }
  });

  it("what is NOT a finish stays out — the ruling's own boundaries", () => {
    // 1st Edition is a SEPARATE AXIS by the ruling's words. The rest are card
    // types, stamps and distribution channels the census found in the pool.
    for (const notAFinish of [
      "1st-edition", "shadowless", "unlimited", "1st-edition-shadowless",
      "full-art", "illustration-rare", "special-illustration-rare", "double-rare", "secret-rare",
      "master-ball", "poke-ball", "stamped", "no-symbol", "no-rarity",
      "gamestop", "toys-r-us", "pokemon-center", "prerelease",
      "base", "ssp", "gold-star", "blue-back", "green-back", "jumbo", "promo",
    ]) {
      expect(V.finishOf(notAFinish), `${notAFinish} must NOT be minted as a finish`).toBeNull();
    }
  });

  it("titleMarket reads only an EXPLICIT market word", () => {
    expect(V.titleMarket("Radiant Charizard Crown Zenith 020/159 Holo PSA 9 English (2023)")).toBe("en");
    expect(V.titleMarket("Pikachu VMAX Japanese Promo Holo")).toBe("ja");
    // A guard that REFUSES a mint must not fire on silence: a title stating no
    // market is unknown, and unknown is never a mismatch.
    expect(V.titleMarket("Eevee V - SWSH: Crown Zenith - Holofoil")).toBeNull();
    expect(V.titleMarket("")).toBeNull();
  });
});

describe("CF-A-FINISH-IS-A-CARD-LINE — the lane's contract", () => {
  const src = readFileSync(LANE, "utf8");

  it("reads the SHARED vocabulary rather than re-typing it", () => {
    // One list decides the question; a copy would drift, and the drift would
    // show up as the lane minting rows the tests above say it never mints.
    expect(src).toContain('require(path.join(__dirname, "lib", "pokemon-finish-vocab.cjs"))');
    // The fold must not be re-implemented inline.
    expect(src).not.toMatch(/const\s+FINISH_TOKENS\s*=\s*Object\.freeze/);
  });

  it("refuses a whole-scope APPLY — a corpus-wide mint needs its name said out loud", () => {
    // CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME, and the refusal sits ABOVE the
    // connection string so a mis-dispatch dies on its arguments.
    expect(src).toMatch(/if\s*\(APPLY\s*&&\s*!YEARS\.length\s*&&\s*!SETKEYS\.length\)/);
    expect(src.indexOf("REFUSED: BACKFILL_APPLY=true"))
      .toBeLessThan(src.indexOf("COSMOS_CONNECTION_STRING not set"));
  });

  it("never mints an unbacked identity — the checklist card must exist", () => {
    expect(src).toContain("noChecklistCard");
    // The parent is read, and its ABSENCE is what stops the mint.
    expect(src).toMatch(/const\s+parentRow\s*=\s*await\s+readRow\(w\.parent\)/);
    expect(src).toMatch(/if\s*\(!parentRow\)\s*\{[\s\S]{0,200}noChecklistCard\+\+/);
    // The identity comes from the PARENT, never from a seller's word.
    expect(src).toMatch(/playerName:\s*parentRow\.playerName/);
  });

  it("records the attestation on the row it mints", () => {
    expect(src).toMatch(/source:\s*`finish-attested:\$\{topSource\}`/);
    expect(src).toContain("attestationCount");
    expect(src).toContain("attestedBy");
    expect(src).toContain("parentSlug");
  });

  it("is idempotent, and never restates another source's provenance", () => {
    // A re-run refreshes only a row THIS LANE minted. A checklist-sourced or
    // user-ruled row at the same address is left alone.
    expect(src).toMatch(/String\(existing\.source \?\? ""\)\.startsWith\("finish-attested:"\)/);
  });

  it("carries the runner contract — budget, shard scope, one exit path, reconciliation", () => {
    expect(src).toContain('runnerShardScope({ label: "mint-attested-finish-rows" })');
    expect(src).toContain("RELAUNCH_NEEDED=");
    expect(src).toMatch(/finishLane\(process\.exitCode \|\| 0\)/);
    expect(src).toMatch(/reportWrites\(\{[\s\S]{0,240}job:\s*"mint-attested-finish-rows"/);
    // Every refusal is DECLARED as skipped, so it stays out of the shortfall.
    expect(src).toMatch(/const skipped\s*=\s*stats\.belowFloor \+ stats\.noChecklistCard \+ stats\.marketMismatch/);
  });

  it("refuses a JA<->EN market mismatch, and only on a POSITIVE disagreement", () => {
    expect(src).toMatch(/if\s*\(slugMarket\s*&&\s*stated\s*&&\s*slugMarket\s*!==\s*stated\)/);
    expect(src).toContain("marketMismatch");
  });
});
