/**
 * MUTATION PINS for CF-UNPARSED-IS-NOT-UNNUMBERED (Drew, 2026-09-04).
 *
 * A guard nothing tests is a guard that gets deleted. Each pin here REVERTS one
 * half of the fix in an isolated copy of the real source and asserts the
 * original damage comes back. If a pin ever passes with the mutation IN PLACE,
 * that guard has stopped working.
 *
 * Two mutations, one per defect:
 *
 *   1. `!s` restored in isUnnumberedCardNumber -- a BLANK cardNumber is read as
 *      "this card has no number" again, and the identity falls to the
 *      `player-<name>` pseudo-number instead of refusing.
 *   2. `??` restored in the player reconciliation -- the VENDOR's attributed
 *      player wins over the title's again, which is how a Greg Maddux sale came
 *      to be keyed to Todd Worrell.
 *
 * The mutants are written to a temp file and loaded from there. The real source
 * is never touched.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(backend, "src", "services", "portfolioiq");

/** Compile one mutated TS module in isolation and import it. */
async function loadMutant(relFile: string, mutate: (src: string) => string) {
  const real = path.join(SRC, relFile);
  const src = fs.readFileSync(real, "utf8");
  const mutated = mutate(src);
  expect(mutated, `the mutation did not change ${relFile} -- the guard it targets is gone`).not.toBe(src);
  const tmp = path.join(SRC, `.mutant-${process.pid}-${relFile}`);
  fs.writeFileSync(tmp, mutated);
  try {
    return await import(/* @vite-ignore */ `file://${tmp.replace(/\\/g, "/")}?t=${Date.now()}`);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

describe("MUTATION 1: restoring `!s` makes a parse failure look unnumbered again", () => {
  it("the real module refuses a blank cardNumber; the mutant mints `player-<name>`", async () => {
    const real = await import("../src/services/portfolioiq/hobbyIqCardId.service.js");

    // The line the fix changed. `!s` used to make an EMPTY cardNumber report as
    // "the source said this card has no number".
    const GUARD = "  if (!s) return false;                      // absence is not an answer";
    const realSrc = fs.readFileSync(path.join(SRC, "hobbyIqCardId.service.ts"), "utf8");
    expect(realSrc).toContain(GUARD);

    const mutant = await loadMutant("hobbyIqCardId.service.ts", (s) =>
      s.replace(GUARD, "  if (!s) return true;   // MUTANT: the original defect"));

    const maddux = {
      sport: "baseball", year: 1987, setKey: "Topps Traded Tiffany",
      cardNumber: "", parallel: "Base", isAuto: false,
      playerName: "Todd Worrell",
    };

    // REAL: refuses. There is no identity to give a row whose number nobody read.
    expect(() => real.computeHobbyIqCardId(maddux)).toThrow(/unparsed/i);

    // MUTANT: mints exactly the slug the defect produced in production.
    const bad = mutant.computeHobbyIqCardId(maddux);
    expect(bad).toBe("hiq:baseball:1987:topps-traded-tiffany:player-todd-worrell:base:no-auto");
    expect(bad).toContain("player-todd-worrell");
  });

  it("the mutant ALSO breaks the guard's separate refusal reason", async () => {
    const realSrc = fs.readFileSync(path.join(SRC, "slugGuard.service.ts"), "utf8");
    const GUARD = 'if (!assertedUnnumbered) reasons.push("cardnumber-unparsed");';
    expect(realSrc).toContain(GUARD);

    const real = await import("../src/services/portfolioiq/slugGuard.service.js");
    const mutant = await loadMutant("slugGuard.service.ts", (s) =>
      s.replace(GUARD, "if (false) reasons.push(\"cardnumber-unparsed\");"));

    const input = {
      sport: "baseball", year: 1987, normalizedSetKey: "topps",
      cardNumber: "", playerName: "Todd Worrell",
    };
    // REAL: the blank is named and refused.
    expect(real.guardSlugInputs(input).ok).toBe(false);
    expect(real.guardSlugInputs(input).reasons).toContain("cardnumber-unparsed");
    // MUTANT: the row sails through on the strength of a player alone.
    expect(mutant.guardSlugInputs(input).ok).toBe(true);
  });
});

describe("MUTATION 2: restoring `vendor ?? title` lets the wrong player key the row", () => {
  it("the real module refuses the disagreement; the mutant adopts the vendor's", async () => {
    const real = await import("../src/services/portfolioiq/playerTheTitleAllows.js");

    // The whole point of the module: the irreconcilable branch. Reverting it to
    // "the vendor wins" is precisely what `??` did.
    const GUARD = 'return { player: null, outcome: "irreconcilable", vendorOverruled: true, vendorPlayer: v, titlePlayer: t };';
    const realSrc = fs.readFileSync(path.join(SRC, "playerTheTitleAllows.ts"), "utf8");
    expect(realSrc).toContain(GUARD);

    const mutant = await loadMutant("playerTheTitleAllows.ts", (s) =>
      s.replace(GUARD, 'return { player: v, outcome: "agree", vendorOverruled: false };  // MUTANT: `vendor ?? title`'));

    // REAL: two different people, so NEITHER is adopted. Absent beats wrong.
    const realD = real.playerTheTitleAllows("Todd Worrell", "Greg Maddux");
    expect(realD.outcome).toBe("irreconcilable");
    expect(realD.player).toBeNull();

    // MUTANT: TCA's mis-attribution wins, and it is the name that would have
    // become the card's identity.
    const badD = mutant.playerTheTitleAllows("Todd Worrell", "Greg Maddux");
    expect(badD.player).toBe("Todd Worrell");
  });

  it("the ingest still uses the reconciliation, not `??`", () => {
    // The literal defect, pinned by absence: if this expression comes back the
    // vendor's player is again adopted without ever consulting the title.
    const persist = fs.readFileSync(path.join(SRC, "persistVendorSalesToPool.service.ts"), "utf8");
    expect(persist).not.toContain("identity.playerName ?? guessPlayerFromTitle(title)");
    expect(persist).toContain("playerTheTitleAllows(identity.playerName, titlePlayer)");
  });

  it("deriveHobbyIqSlug still reconciles rather than trusting the stored field", () => {
    const store = fs.readFileSync(path.join(SRC, "soldCompsStore.service.ts"), "utf8");
    expect(store).toContain("playerTheTitleAllows(");
    // The slug must be built from the RECONCILED player, never the raw input.
    expect(store).toContain("playerName: playerForSlug,");
  });
});
