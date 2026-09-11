/**
 * I9 REFERENCE STAMP — the pins (GO-LIVE P1, 2026-09-07).
 *
 * CF-AN-ALARM-COMPARES-LIKE-WITH-LIKE + CF-A-REFERENCE-MUST-SAY-WHAT-IT-WAS-
 * MEASURED-UNDER.
 *
 * THE DEFECT. On 2026-09-07 I9 breached — vintage CONFLICT 62.2% vs its census
 * 31.9% (+30.3pp), modern 59.3% vs 41.8% (+17.5pp) — and the audit could not
 * say whether the corpus had regressed or the REFERENCE had gone stale. It was
 * the reference: `data/rematch-census-shares.json` was measured in the window
 * closing 2026-09-06T02:49Z, and between then and the breaching run EIGHT
 * commits changed the classifier and eleven more changed the parser vocabulary
 * (#1886 absent-year fold, #1897 ruled scopes + grade, #1914 Chrome Draft,
 * #1918/#1923 soccer keys, #1926 sport predicate, #1932 CH vertical, #1934
 * Halloween, #1937/#1938 Pokemon finish). Every one is an INTENDED change to
 * what a re-derivation says.
 *
 * THE FIX, AND THE LINE IT MUST NOT CROSS. The reference now carries the
 * DERIVATION STAMP it was measured under, and the alarm compares only against a
 * reference at the current stamp. This must NEVER become a way to silence a
 * real regression, so the pins are deliberately two-sided:
 *
 *   - a stamp MISMATCH suppresses the alarm and emits a re-baseline finding
 *   - a stamp MATCH leaves the alarm exactly as it was — a regression under
 *     today's derivation still breaches, and reverting the guard to
 *     "always suppress" makes that test red
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INV = require_(path.join(backend, "scripts", "lib", "corpus-invariants.cjs"));
const DV = require_(path.join(backend, "scripts", "lib", "derivation-version.cjs"));
const TABLE = require_(path.join(backend, "data", "rematch-census-shares.json"));

/** The two classes that actually breached on the 2026-09-07 artifact. */
const BREACHING_FRAME = [
  { sportClass: "modern", sampledApprox: 1086.6, shareOfFrame: 0.6195, conflict: { sampled: 0.593245, census: 0.417793, delta: 0.175452 } },
  { sportClass: "vintage", sampledApprox: 490.6, shareOfFrame: 0.2797, conflict: { sampled: 0.622259, census: 0.319243, delta: 0.303016 } },
  { sportClass: "pokemon", sampledApprox: 176.7, shareOfFrame: 0.1008, conflict: { sampled: 0.571813, census: 0.596306, delta: -0.024493 } },
];

const AGREES = { comparable: true, reason: null, referenceStamp: "dX+c", currentStamp: "dX+c" };
const DISAGREES = { comparable: false, reason: "stamp-changed", referenceStamp: "dOLD+no-contract", currentStamp: "dNEW+2026-09-06.a" };

describe("the derivation stamp names what a measurement was taken under", () => {
  it("hashes the six files that decide a derivation, and no others", () => {
    // ADDING A FILE HERE IS A DELIBERATE ACT — a file that can change a verdict
    // and is not listed makes the stamp lie by omission.
    //
    // CF-A-DERIVATION-STAMP-MUST-NOT-HASH-PLUMBING (2026-09-11, run
    // 34360565942 follow-up). This list used to carry the literal entry
    // "scripts/rematch-sold-comps.cjs" — the WHOLE script, worker pool,
    // write ledger, budget clock, finishLane exit code and all — so any
    // change anywhere in that file invalidated the I9 reference exactly as
    // if a row's VERDICT had changed, even for plumbing that decides nothing.
    // storedIdentity/deriveIdentity — the two functions that actually decide
    // a row's identity — were extracted, pure, to
    // scripts/lib/rematch-derive-identity.cjs, and that is what is hashed
    // instead now. See tests/derivationStampNarrowedToIdentity.test.ts for
    // the two properties this split exists to prove.
    expect(DV.DERIVATION_INPUTS).toEqual([
      "scripts/lib/rematch-classify.cjs",
      "scripts/lib/rematch-derive-identity.cjs",
      "src/services/portfolioiq/parseTitleIdentity.service.ts",
      "src/services/portfolioiq/hobbyIqCardId.service.ts",
      "src/services/portfolioiq/slugGuard.service.ts",
      "src/services/portfolioiq/slugRederivation.service.ts",
    ]);
    expect(DV.missingInputs()).toEqual([]);
  });

  it("computes a stamp for this tree, and it is stable across two reads", () => {
    const a = DV.currentStamp();
    const b = DV.currentStamp();
    expect(a.derivation).toMatch(/^d[0-9a-f]{12}$/);
    expect(a.combined).toBe(b.combined);
    expect(a.contract).toBe("2026-09-06.a");
  });

  it("MUTATION: a changed classifier is a changed stamp", () => {
    // THE WHOLE POINT. If editing the classifier did not move the stamp, a
    // reference measured under the old one would compare EQUAL and the stale
    // comparison this PR exists to stop would go on happening silently.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "i9stamp-"));
    for (const rel of DV.DERIVATION_INPUTS) {
      const dst = path.join(root, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(backend, rel), dst);
    }
    const pcRel = path.join("src", "services", "portfolioiq", "pricingContract.ts");
    fs.mkdirSync(path.dirname(path.join(root, pcRel)), { recursive: true });
    fs.copyFileSync(path.join(backend, pcRel), path.join(root, pcRel));

    const before = DV.derivationStamp(root);
    expect(before).toMatch(/^d[0-9a-f]{12}$/);
    const classifier = path.join(root, "scripts", "lib", "rematch-classify.cjs");
    fs.appendFileSync(classifier, "\n// a rule changed\n");
    const after = DV.derivationStamp(root);
    expect(after).not.toBe(before);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("is stable across line endings — a CRLF laptop and an LF runner agree", () => {
    // THE NIGHTLY MEASURES ON AN LF RUNNER; A RE-BASELINE IS USUALLY COMPUTED ON
    // A CRLF CHECKOUT. Without the normalisation the stamps would differ on
    // every file, the reference would read as stale every single night, and the
    // alarm would never speak again — a silencer by accident.
    const mk = (eol: "lf" | "crlf") => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `i9eol-${eol}-`));
      for (const rel of DV.DERIVATION_INPUTS) {
        const dst = path.join(root, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        let c = fs.readFileSync(path.join(backend, rel), "utf8").replace(/\r\n/g, "\n");
        if (eol === "crlf") c = c.replace(/\n/g, "\r\n");
        fs.writeFileSync(dst, c);
      }
      return root;
    };
    const lf = mk("lf"); const crlf = mk("crlf");
    expect(DV.derivationStamp(lf)).toBe(DV.derivationStamp(crlf));
    expect(DV.derivationStamp(lf)).toMatch(/^d[0-9a-f]{12}$/);
    fs.rmSync(lf, { recursive: true, force: true });
    fs.rmSync(crlf, { recursive: true, force: true });
  });

  it("refuses a stamp it cannot stand behind rather than hashing what is there", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "i9stamp-empty-"));
    expect(DV.derivationStamp(root)).toBeNull();
    expect(DV.missingInputs(root).length).toBe(DV.DERIVATION_INPUTS.length);
    // And a null stamp is NEVER comparable — "I don't know" must not read as agreement.
    expect(DV.stampsAgree("dANY+c", { derivation: null, contract: null, combined: null }).comparable).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("an unstamped reference is NOT comparable — silence is not agreement", () => {
    // Every reference recorded before 2026-09-07 carries no stamp. Its units
    // are unknown, so nothing may be concluded by comparing against it.
    const v = DV.stampsAgree(null);
    expect(v.comparable).toBe(false);
    expect(v.reason).toBe("reference-unstamped");
  });
});

describe("the shipped reference carries its stamp", () => {
  it("records the stamp and the commit the census was measured under", () => {
    expect(TABLE.measuredUnder).toBeTruthy();
    expect(TABLE.measuredUnder.stamp).toMatch(/^d[0-9a-f]{12}\+/);
    // e32b8481 — the tree the wave-2 census artifacts were re-baselined against.
    expect(TABLE.measuredUnder.commit).toBe("e32b84814c253a71f141362b67fac08947ee315b");
    // pricingContract.ts exists now, so the stamp carries its version.
    expect(TABLE.measuredUnder.contract).toBe("2026-09-06.a");
    // The 32-slot reference stays 32 slots (#1888 stands).
    expect(TABLE.slotCount).toBe(32);
    expect(TABLE.classifiedTotal).toBeGreaterThan(11_000_000);
    expect(INV.CENSUS_REFERENCE_SHARES.CONFLICT).toBeCloseTo(0.430, 2);
  });

  it("says WHAT FRACTION of the corpus it saw, and which slots are partial", () => {
    // A REFERENCE BUILT FROM BUDGET-STOPPED WALKS IS STILL A REFERENCE, BUT IT
    // MUST SAY SO. 18 of the 32 wave-2 slots hit their budget before finishing,
    // so this reference is 72% of the expected corpus and its partial slots
    // describe a PREFIX of their rows. Recording `classified` alone would have
    // presented a 34%-walked slot and a finished one as equally authoritative.
    expect(TABLE.coverage.classified).toBe(TABLE.classifiedTotal);
    expect(TABLE.coverage.coverage).toBeCloseTo(0.72, 2);
    expect(TABLE.coverage.partialSlots).toHaveLength(18);
    expect(TABLE.coverage.completedSlots).toHaveLength(14);
    // Every slot carries its own coverage, so a reader never has to guess.
    for (const s of TABLE.slots) {
      expect(typeof s.expectedRows, `slot ${s.slot} expectedRows`).toBe("number");
      expect(typeof s.coverage, `slot ${s.slot} coverage`).toBe("number");
      expect(typeof s.stoppedAtBudget, `slot ${s.slot} stoppedAtBudget`).toBe("boolean");
      expect(s.coverage).toBeCloseTo(s.classified / s.expectedRows, 3);
    }
    // The partial list is exactly the slots flagged, never a hand-kept copy.
    expect(TABLE.coverage.partialSlots)
      .toEqual(TABLE.slots.filter((s) => s.stoppedAtBudget).map((s) => s.slot));
    // And the _doc window is the artifacts' real generatedAt span.
    expect(TABLE._doc).toContain(`${TABLE.coverage.window.from.slice(0, 16)}Z`);
    expect(TABLE._doc).toContain(`${TABLE.coverage.window.to.slice(0, 16)}Z`);
  });

  it("and that stamp IS this tree's — the re-baseline re-armed the alarm", () => {
    // THE POINT OF THE RE-BASELINE. Before it, the reference predated every
    // classifier change of 09-06/09-07 and I9's alarm was suppressed. Recorded
    // under THIS tree's stamp, the comparison is honest again and a drift from
    // here on is a real corpus finding rather than a re-baseline owed.
    const v = INV.referenceStampAgreement();
    expect(v.comparable).toBe(true);
    expect(v.reason).toBeNull();
    expect(v.referenceStamp).toBe(TABLE.measuredUnder.stamp);
    expect(v.currentStamp).toBe(DV.currentStamp().combined);
  });
});

describe("the alarm compares only like with like", () => {
  it("SUPPRESSES the alarm when the reference was measured under other rules", () => {
    const d = INV.evaluateDrift("I9", {
      byClassFrame: BREACHING_FRAME, sample: 1754, breaches: 906, stampAgreement: DISAGREES,
    });
    expect(d).toBeNull();
  });

  it("MUTATION: the SAME frame still breaches at a MATCHING stamp", () => {
    // THE PIN THAT STOPS THIS BECOMING A SILENCER. The only difference between
    // this case and the one above is the stamp verdict. Change
    // `evaluateDrift`'s guard to suppress unconditionally and this goes red.
    const d = INV.evaluateDrift("I9", {
      byClassFrame: BREACHING_FRAME, sample: 1754, breaches: 906, stampAgreement: AGREES,
    });
    expect(d).not.toBeNull();
    expect(d.worstClass).toBe("vintage");
    expect(d.classes.map((c: { sportClass: string }) => c.sportClass).sort()).toEqual(["modern", "vintage"]);
    expect(d.classes[0].delta).toBeCloseTo(0.303, 3);
    expect(d.message).toMatch(/drifted more than 5pp/);
  });

  it("a legitimately clean night is still clean at a matching stamp", () => {
    const clean = [{ sportClass: "modern", sampledApprox: 900, conflict: { sampled: 0.43, census: 0.417793, delta: 0.012207 } }];
    expect(INV.evaluateDrift("I9", { byClassFrame: clean, sample: 900, breaches: 10, stampAgreement: AGREES })).toBeNull();
  });

  it("omitting the stamp entirely preserves the OLD behaviour — the alarm fires", () => {
    // Backwards compatibility is not a nicety here: a caller that has not been
    // taught about stamps must keep alarming, never fall silent.
    const d = INV.evaluateDrift("I9", { byClassFrame: BREACHING_FRAME, sample: 1754, breaches: 906 });
    expect(d).not.toBeNull();
    expect(d.worstClass).toBe("vintage");
  });

  it("a class under the row floor still never gates, stamp or no stamp", () => {
    const thin = [{ sportClass: "vintage", sampledApprox: 9, conflict: { sampled: 0.9, census: 0.319243, delta: 0.580757 } }];
    const d = INV.evaluateDrift("I9", { byClassFrame: thin, sample: 9, breaches: 8, stampAgreement: AGREES });
    expect(d).toBeNull();
  });
});

describe("a stale reference is a FINDING that names the re-baseline owed", () => {
  it("reports the same numbers the alarm would have, labelled as a re-baseline", () => {
    // NOTHING IS HIDDEN. The +30.3pp that breached is still printed — as data,
    // with the stamp that makes it incomparable, and the stamp owed next.
    const f = INV.describeReferenceDrift("I9", { byClassFrame: BREACHING_FRAME, stampAgreement: DISAGREES });
    expect(f).not.toBeNull();
    expect(f.kind).toBe("reference-rebaseline");
    expect(f.reason).toBe("stamp-changed");
    expect(f.rebaselineOwed).toBe(DISAGREES.currentStamp);
    expect(f.classes[0].sportClass).toBe("vintage");
    expect(f.classes[0].delta).toBeCloseTo(0.303, 3);
    // It names which classes WOULD have breached, so the number is never lost.
    expect(f.wouldHaveBreached.sort()).toEqual(["modern", "vintage"]);
    expect(f.message).toMatch(/NOT COMPARABLE/);
    expect(f.message).toMatch(/re-arms the alarm/);
  });

  it("emits NOTHING when the reference is comparable — a finding is not a second alarm", () => {
    expect(INV.describeReferenceDrift("I9", { byClassFrame: BREACHING_FRAME, stampAgreement: AGREES })).toBeNull();
    expect(INV.describeReferenceDrift("I9", { byClassFrame: BREACHING_FRAME })).toBeNull();
  });

  it("is not a warning shape — it must never page anybody", () => {
    const f = INV.describeReferenceDrift("I9", { byClassFrame: BREACHING_FRAME, stampAgreement: DISAGREES });
    // `evaluateThreshold`/`evaluateDrift` warnings carry `thresholdKind`; the
    // digest keys the BREACH status off that. A re-baseline carries none.
    expect(f.thresholdKind).toBeUndefined();
  });
});

describe("the re-baseline recorder refuses to launder a regression", () => {
  const script = path.join(backend, "scripts", "rebaseline-i9-reference.cjs");
  const REC = require_(script);

  it("computes row-weighted shares the same way the census does", () => {
    const slots = [
      { classified: 100, shares: { AGREE: 0.5, IMPROVE: 0, CONFLICT: 0.5, UNDERIVABLE: 0 } },
      { classified: 900, shares: { AGREE: 0.1, IMPROVE: 0, CONFLICT: 0.9, UNDERIVABLE: 0 } },
    ];
    const { weighted, total } = REC.weightedOf(slots);
    expect(total).toBe(1000);
    // ROW-weighted, not slot-averaged: the 900-row slot dominates.
    expect(weighted.CONFLICT).toBeCloseTo(0.86, 3);
    expect(weighted.AGREE).toBeCloseTo(0.14, 3);
  });

  it("shares are a count over the classified total", () => {
    expect(REC.sharesOf({ AGREE: 25, CONFLICT: 75 }, 100).AGREE).toBeCloseTo(0.25, 6);
    expect(REC.sharesOf({ AGREE: 1 }, 0).AGREE).toBe(0);
  });

  it("REFUSES to re-record a reference already at the current stamp", () => {
    // THE REFUSAL THAT KEEPS THE FIX HONEST. If the derivation did not change,
    // a drift is a REAL corpus finding — and overwriting the baseline with a
    // fresh sample would convert that finding into the new normal.
    const src = fs.readFileSync(script, "utf8");
    expect(src).toMatch(/if \(agreement\.comparable && !forceStamp\)/);
    expect(src).toMatch(/laundering a regression|launder that finding/i);
    expect(src).toMatch(/process\.exit\(3\)/);
  });

  it("keeps the MIN_ROWS refusal — a sample is not a corpus reference", () => {
    const src = fs.readFileSync(script, "utf8");
    expect(src).toMatch(/MIN_ROWS/);
    expect(src).toMatch(/that is a sample, not a corpus reference/);
    expect(src).toMatch(/process\.exit\(4\)/);
  });

  it("buckets a unit by the SAME vintage boundary the shipped reference used", () => {
    // THE BOUNDARY IS PART OF THE REFERENCE. Re-bucketing the corpus under a
    // different cutoff would leave two references that share class NAMES and
    // measure different populations — incomparable while looking comparable.
    // 2000 is the cutoff recovered by reproducing all 32 classMix entries of
    // the 2026-09-06 reference exactly; 1990 or 2001 each mismatch a slot.
    expect(REC.VINTAGE_BEFORE).toBe(2000);
    expect(REC.classOfUnit({ sportClass: "pokemon", year: 2025 })).toBe("pokemon");
    expect(REC.classOfUnit({ sportClass: null, year: 1999 })).toBe("vintage");
    expect(REC.classOfUnit({ sportClass: null, year: 2000 })).toBe("modern");
    // A yearless unit is not vintage by default — absence is not a date.
    expect(REC.classOfUnit({ sportClass: null, year: null })).toBe("modern");
  });

  it("apportions a slot's class mix BY ROWS, never counting it whole into each", () => {
    // Slot 0's shape: 484,940 pokemon rows beside 39,000 rows of 1953 — 93/7.
    const mix = REC.classMixOf([
      { sportClass: "pokemon", year: 2025, rows: 484940 },
      { sportClass: null, year: 1953, rows: 39000 },
    ]);
    expect(mix.pokemon).toBeCloseTo(0.9256, 3);
    expect(mix.vintage).toBeCloseTo(0.0744, 3);
    expect(Object.values(mix).reduce((a: number, b) => a + Number(b), 0)).toBeCloseTo(1, 3);
    expect(REC.classMixOf([])).toBeNull();
    expect(REC.classMixOf(undefined)).toBeNull();
  });

  it("derives bySportClass from THESE artifacts, not the previous reference", () => {
    // Carrying the old per-class block forward would describe last week's frame
    // with this week's counts — the same structural blindness as a single-slot
    // reference, one level up.
    const src = fs.readFileSync(script, "utf8");
    expect(src).toMatch(/bySportClass: bySportClassOf\(slots\)/);
    const by = REC.bySportClassOf([
      { slot: 0, classified: 1000, shares: { AGREE: 0, IMPROVE: 0, CONFLICT: 1, UNDERIVABLE: 0 }, classMix: { pokemon: 1 } },
      { slot: 1, classified: 1000, shares: { AGREE: 1, IMPROVE: 0, CONFLICT: 0, UNDERIVABLE: 0 }, classMix: { modern: 1 } },
    ]);
    expect(by.pokemon.shares.CONFLICT).toBe(1);
    expect(by.pokemon.classified).toBe(1000);
    expect(by.modern.shares.AGREE).toBe(1);
    // A slot is listed under its DOMINANT class only.
    expect(by.pokemon.slots).toEqual([0]);
    expect(by.modern.slots).toEqual([1]);
  });

  it("never writes without APPLY, and never writes Cosmos at all", () => {
    const src = fs.readFileSync(script, "utf8");
    expect(src).toMatch(/if \(!APPLY\)/);
    // A repo file, in a PR, reviewed like any other diff — no container writes.
    expect(src).not.toMatch(/\.(upsert|replace|create|patch|delete)\(/);
    expect(src).not.toMatch(/CosmosClient/);
  });
});
