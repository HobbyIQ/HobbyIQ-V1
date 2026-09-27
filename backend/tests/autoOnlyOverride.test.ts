/**
 * autoOnlyOverride (lib/auto-only-override.cjs) -- Drew ruling R-0927d
 * (2026-09-27 ~02:50Z). Unit + mutation tests for the gate module in
 * isolation from the lane's own end-to-end suite
 * (repointSalesIsAutoFlip.test.ts covers the wired-in behavior).
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  autoOnlyOverride, isAutoOnlyPrefix, isKnownUnsignedMintingSource,
  defectiveSourcePrefixes, AUTO_ONLY_CARDNUMBER_PREFIX,
} = require(path.join(backend, "scripts", "lib", "auto-only-override.cjs"));

// Real namesAgree, not a stub -- the gate's own contract names the REAL
// function as what production wires in.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { namesAgree } = require(path.join(backend, "scripts", "lib", "name-agreement.cjs"));

const SCOPE = { sport: "baseball", year: 2024, setKey: "bowman-chrome" };
const fakeScopedAutoOnlyPrefix = (cardNumber: string, scope: any) =>
  scope?.sport === "baseball" && scope?.year === 2024 && scope?.setKey === "bowman-mega"
    ? /^BMA-/i.test(cardNumber)
    : false;

const baseArgs = (over: Record<string, unknown> = {}) => ({
  direction: "no-auto-to-auto",
  cardNumber: "CPA-JS",
  scope: SCOPE,
  noAutoSource: "checklistinsider-2026-08-27",
  saleName: "Jane Smith",
  autoRowName: "Jane Smith",
  isScopedAutoOnlyPrefix: fakeScopedAutoOnlyPrefix,
  namesAgree,
  ...over,
});

describe("auto-only-override -- the allowlist file", () => {
  it("loads backend/data/auto-only-override-defective-sources.json and includes the census-named tags", () => {
    const prefixes = defectiveSourcePrefixes();
    expect(prefixes).toContain("checklistinsider-2026-08-27");
    expect(prefixes).toContain("bccp");
    expect(prefixes).toContain("checklist-batch-fill");
  });

  it("cites R-0927d in the file's own comment", () => {
    const raw = fs.readFileSync(
      path.join(backend, "data", "auto-only-override-defective-sources.json"),
      "utf8",
    );
    expect(raw).toMatch(/R-0927D/i);
  });
});

describe("auto-only-override -- gate 1: direction", () => {
  it("NEVER reverses -- auto-to-no-auto is refused regardless of every other condition", () => {
    const result = autoOnlyOverride(baseArgs({ direction: "auto-to-no-auto" }));
    expect(result.move).toBe(false);
    expect(result.reason).toBe("wrong-direction");
  });

  it("an unrecognized direction string is refused the same way", () => {
    const result = autoOnlyOverride(baseArgs({ direction: "sideways" }));
    expect(result.move).toBe(false);
    expect(result.reason).toBe("wrong-direction");
  });
});

describe("auto-only-override -- gate 2: cardNumber is auto-only for (sport, year, setKey)", () => {
  it("moves on a GLOBAL auto-only prefix (CPA-, the CPA- 2024 fixture)", () => {
    const result = autoOnlyOverride(baseArgs({ cardNumber: "CPA-JS" }));
    expect(result.move).toBe(true);
    expect(result.reason).toBe("auto-only-override");
  });

  it("moves on a SCOPED auto-only prefix via the injected isScopedAutoOnlyPrefix", () => {
    const result = autoOnlyOverride(baseArgs({
      cardNumber: "BMA-KW",
      scope: { sport: "baseball", year: 2024, setKey: "bowman-mega" },
    }));
    expect(result.move).toBe(true);
  });

  it("moves when the :auto row's own category says autograph, even off both prefix tables", () => {
    const result = autoOnlyOverride(baseArgs({
      cardNumber: "NOT-A-KNOWN-PREFIX",
      autoRowCategory: "auto-rookie-signature",
    }));
    expect(result.move).toBe(true);
  });

  it("refuses a MIXED insert -- neither prefix table nor category says auto-only", () => {
    const result = autoOnlyOverride(baseArgs({
      cardNumber: "BASE-JS",
      autoRowCategory: "base",
    }));
    expect(result.move).toBe(false);
    expect(result.reason).toBe("not-auto-only-prefix");
  });

  it("AUTO_ONLY_CARDNUMBER_PREFIX mirrors hobbyIqCardId.service.ts's own regex byte-for-byte (drift guard)", () => {
    const liveSourcePath = path.join(backend, "src", "services", "portfolioiq", "hobbyIqCardId.service.ts");
    const src = fs.readFileSync(liveSourcePath, "utf8");
    const m = src.match(/const AUTO_ONLY_CARDNUMBER_PREFIX = (\/.*\/i);/);
    expect(m, "could not find AUTO_ONLY_CARDNUMBER_PREFIX in hobbyIqCardId.service.ts -- update the mirror in lib/auto-only-override.cjs").not.toBeNull();
    expect(AUTO_ONLY_CARDNUMBER_PREFIX.toString()).toBe(m![1]);
  });
});

describe("auto-only-override -- gate 3: the :no-auto row's source must be in the allowlist", () => {
  it("refuses a no-auto row from a NON-listed source", () => {
    const result = autoOnlyOverride(baseArgs({ noAutoSource: "baseballcardpedia-ladders-2026-09-04" }));
    expect(result.move).toBe(false);
    expect(result.reason).toBe("source-not-in-allowlist");
  });

  it("accepts each of the three census-named tags", () => {
    for (const source of ["checklistinsider-2026-08-27", "bccp", "checklist-batch-fill"]) {
      const result = autoOnlyOverride(baseArgs({ noAutoSource: source }));
      expect(result.move, `expected a move for source ${source}`).toBe(true);
    }
  });

  it("accepts a -graded twin of a listed source (inherits its parent's provenance)", () => {
    const result = autoOnlyOverride(baseArgs({ noAutoSource: "checklistinsider-2026-08-27-graded" }));
    expect(result.move).toBe(true);
  });

  it("isKnownUnsignedMintingSource is case-insensitive", () => {
    expect(isKnownUnsignedMintingSource("CHECKLISTINSIDER-2026-08-27")).toBe(true);
  });
});

describe("auto-only-override -- gate 4: namesAgree", () => {
  it("refuses when the sale's player disagrees with the :auto row's player", () => {
    const result = autoOnlyOverride(baseArgs({ saleName: "Jane Smith", autoRowName: "John Doe" }));
    expect(result.move).toBe(false);
    expect(result.reason).toBe("name-disagrees");
  });

  it("agrees through a name-shape artefact (a generational suffix on one side only), matching namesAgree's own contract", () => {
    const result = autoOnlyOverride(baseArgs({ saleName: "Vladimir Guerrero Jr.", autoRowName: "Vladimir Guerrero" }));
    expect(result.move).toBe(true);
  });
});

describe("auto-only-override -- all four gates required together (integration)", () => {
  it("the CPA- 2024 fixture from PR #2453's census moves", () => {
    const result = autoOnlyOverride({
      direction: "no-auto-to-auto",
      cardNumber: "CPA-JS",
      scope: { sport: "baseball", year: 2024, setKey: "bowman-chrome" },
      noAutoSource: "checklistinsider-2026-08-27",
      saleName: "John Smith",
      autoRowName: "John Smith",
      isScopedAutoOnlyPrefix: fakeScopedAutoOnlyPrefix,
      namesAgree,
    });
    expect(result.move).toBe(true);
  });

  it("failing ONE gate is enough to refuse, even when the other three pass", () => {
    const passing = baseArgs();
    expect(autoOnlyOverride(passing).move).toBe(true);
    expect(autoOnlyOverride({ ...passing, direction: "auto-to-no-auto" }).move).toBe(false);
    expect(autoOnlyOverride({ ...passing, cardNumber: "BASE-1", autoRowCategory: "base" }).move).toBe(false);
    expect(autoOnlyOverride({ ...passing, noAutoSource: "cardhedge" }).move).toBe(false);
    expect(autoOnlyOverride({ ...passing, autoRowName: "Someone Else" }).move).toBe(false);
  });
});

// ── MUTATION CHECKS: gates 2 and 3, per the task's explicit ask.
describe("auto-only-override -- MUTATION: gate 2 (auto-only prefix) is load-bearing", () => {
  it("a mutated isAutoOnlyPrefix that always returns true would wrongly move a MIXED-insert sale", () => {
    // The regressed behavior: skip gate 2 entirely (as if isAutoOnlyPrefix
    // always returned true). Proves gate 2 is what stops a MIXED insert
    // (base + auto variants both exist, so a no-auto row is legitimate).
    const mixedInsertArgs = baseArgs({ cardNumber: "BASE-1", autoRowCategory: "base" });
    const real = autoOnlyOverride(mixedInsertArgs);
    expect(real.move, "the REAL gate must refuse a mixed insert").toBe(false);

    const regressedIsAutoOnlyPrefixAlwaysTrue = () => true;
    const wouldHaveMoved = regressedIsAutoOnlyPrefixAlwaysTrue() &&
      isKnownUnsignedMintingSource(mixedInsertArgs.noAutoSource) &&
      namesAgree(mixedInsertArgs.saleName, mixedInsertArgs.autoRowName);
    expect(wouldHaveMoved, "the mutation (gate 2 always true) would incorrectly move this sale, proving gate 2 is the guard that stops it").toBe(true);
  });
});

describe("auto-only-override -- MUTATION: gate 3 (source allowlist) is load-bearing", () => {
  it("a mutated isKnownUnsignedMintingSource that always returns true would wrongly move a non-listed-source sale", () => {
    const nonListedArgs = baseArgs({ noAutoSource: "baseballcardpedia-ladders-2026-09-04" });
    const real = autoOnlyOverride(nonListedArgs);
    expect(real.move, "the REAL gate must refuse a non-listed source").toBe(false);
    expect(real.reason).toBe("source-not-in-allowlist");

    const regressedSourceGateAlwaysTrue = () => true;
    const wouldHaveMoved = isAutoOnlyPrefix(nonListedArgs.cardNumber, nonListedArgs.scope, fakeScopedAutoOnlyPrefix, undefined) &&
      regressedSourceGateAlwaysTrue() &&
      namesAgree(nonListedArgs.saleName, nonListedArgs.autoRowName);
    expect(wouldHaveMoved, "the mutation (gate 3 always true) would incorrectly move this sale, proving gate 3 is the guard that stops it").toBe(true);
  });
});
