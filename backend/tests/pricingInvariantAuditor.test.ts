/**
 * PRICING INVARIANT AUDITOR — the seeded-defect pins.
 *
 * CF-NEVER-AGAIN (Drew, 2026-09-02). Six pricing defects were found the week of
 * 2026-08-27..09-02, every one of them by Drew's eyeballs. This suite seeds each
 * shape into a fake pool and asserts the auditor catches it — so the auditor
 * itself is the thing that is tested, not just the code it audits.
 *
 * A machine that has never been shown a defect it can catch is a machine nobody
 * has tested. Each `it` below names a real holding and a real PR.
 *
 * The seventh and eighth pins are the ones that keep it honest: a HEALTHY
 * holding must pass clean (an auditor that flags everything is noise), and the
 * badge write must be only-improve — the marker field alone, never a price.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { isExactPoolRung } from "../src/services/compiq/fmvRung.js";
import { parseGradeLabel } from "../src/services/portfolioiq/gradeParser.js";

const require_ = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inv = require_(path.join(backend, "scripts", "lib", "pricing-invariants.cjs"));

const leaf = { isExactPoolRung, parseGradeLabel };
const NOW = Date.parse("2026-09-02T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86400000).toISOString();

type Row = Record<string, unknown>;

const CHROME = "hiq:baseball:2026:topps-chrome:ra-jc:refractor:auto:num-499";
const DRAFT = "hiq:baseball:2024:bowman-draft:ra-jc:refractor:auto";

/** A pool row under an identity, at a price and an age. */
const sale = (over: Row = {}): Row => ({
  id: `tca-ebay::${Math.random().toString(36).slice(2, 10)}`,
  hobbyiqCardId: CHROME,
  cardId: CHROME,
  title: "2026 Topps Chrome RA-JC Refractor Auto /499",
  price: 200,
  soldAt: daysAgo(10),
  source: "tca-ebay",
  parallel: "Refractor",
  printRun: 499,
  gradeCompany: null,
  gradeValue: null,
  userId: null,
  ...over,
});

/**
 * A holding, priced.
 *
 * CF-A-HEALTHY-FIXTURE-CARRIES-THE-CONTRACT (C-8, 2026-09-03). This fixture
 * had no `valueSource` key, and #1683 made a missing `valueSource` a
 * RUNG-HONESTY finding — so EVERY holding this factory built became a
 * violation, three tests in this suite went red, and the "value-carries-no-rung"
 * signal fired on the healthy baseline as loudly as on a real defect. A
 * detector that flags its own control is not a detector; it is noise, and it is
 * why the four live holdings Drew found were not surfaced by this suite.
 *
 * A healthy holding now carries the full C-7 contract — a rung AND the kind of
 * evidence behind it — so "healthy passes clean" means what it says, and the
 * absence pins below fail for the one reason they are about.
 */
const holding = (over: Row = {}): Row => ({
  id: "9b971b03",
  hobbyiqCardId: CHROME,
  cardId: CHROME,
  fairMarketValue: 200,
  fmvRung: "exact-pool-projection",
  valueSource: "observed",
  pricingSourceMeta: { slug: CHROME, method: "unified-market-value", compsUsed: 4, confidence: 0.8 },
  gradeCompany: null,
  gradeValue: null,
  quantity: 1,
  ...over,
});

const run = (h: Row, o: { basisRows?: Row[]; poolRows?: Row[]; previous?: unknown } = {}) =>
  inv.auditHolding(h, {
    basisRows: o.basisRows ?? [],
    poolRows: o.poolRows ?? [],
    previous: o.previous ?? null,
    nowMs: NOW,
    userId: "user-drew",
    gradeMultipliers: { "PSA 10": 5, "PSA 9": 2 },
    leaf,
  });

const kinds = (res: { findings: Array<{ kind: string }> }) => res.findings.map((f) => f.kind);
const invariants = (res: { findings: Array<{ invariant: string }> }) =>
  [...new Set(res.findings.map((f) => f.invariant))];

// ── The healthy baseline ─────────────────────────────────────────────────────

describe("a healthy holding passes clean", () => {
  const healthyPool = [
    sale({ id: "s1", price: 198, soldAt: daysAgo(5) }),
    sale({ id: "s2", price: 202, soldAt: daysAgo(20) }),
    sale({ id: "s3", price: 195, soldAt: daysAgo(40) }),
    sale({ id: "s4", price: 205, soldAt: daysAgo(60) }),
  ];

  it("exact pool, matching identity, value in line -> no findings", () => {
    const res = run(holding({ fairMarketValue: 200 }), {
      basisRows: healthyPool,
      poolRows: healthyPool,
    });
    expect(res.findings).toEqual([]);
    expect(res.shadowRung).toBe("exact-pool-projection");
  });

  it("an auditor that flags a healthy holding is noise — the shadow agrees within the band", () => {
    const res = run(holding({ fairMarketValue: 200 }), { basisRows: healthyPool, poolRows: healthyPool });
    expect(res.shadowValue).toBeGreaterThan(150);
    expect(res.shadowValue).toBeLessThan(260);
  });

  /**
   * REGRESSION (found by the fake-Cosmos smoke run, not by a unit pin).
   *
   * readBasisRows originally keyed the basis query `hobbyiqCardId = @s OR
   * cardId = @s`. That OR pulls in rows that merely MENTION the cited slug in
   * their other id field — a different card whose cardId happens to equal this
   * holding's hobbyiqCardId — and the healthy holding above was flagged
   * cross-product by a Bowman Draft row its price never read.
   *
   * The basis is what the price CITED. A row keyed to another card is not in
   * it, however it references this one.
   */
  it("a row merely REFERENCING the holding's slug is not part of its basis", () => {
    const foreign = sale({
      id: "x1", hobbyiqCardId: DRAFT, cardId: CHROME, price: 20.6,
      title: "2024 Bowman Draft RA-JC",
    });
    // The basis contains only rows keyed to the cited slug — the foreign row,
    // which the corrected query would never return, is absent.
    const res = run(holding({ fairMarketValue: 200 }), {
      basisRows: healthyPool,
      poolRows: [...healthyPool, foreign],
    });
    // THE CLAIM OF THIS PIN: the BASIS invariants stay silent. The foreign row
    // is not what the price cited, so it must not produce a cross-product.
    expect(kinds(res)).not.toContain("cross-product");
    for (const i of ["BASIS-IDENTITY", "RUNG-HONESTY", "SUBSTITUTION", "DETERMINISM"]) {
      expect(invariants(res)).not.toContain(i);
    }

    // ...but it is NOT silent overall any more, and that is a fix rather than a
    // regression (Drew 2026-09-02). This fixture's `foreign` row -- cardId
    // CHROME, hobbyiqCardId DRAFT -- is a textbook SPLIT-IDENTITY row: the
    // pool reader ORs both fields, so it really is read into this holding's
    // pool while naming a different card. The original pin asserted total
    // silence because at the time nothing could see that; IDENTITY-COHERENCE
    // now can, and reporting it is the point. The basis claim above is the
    // part of this pin that was ever about readBasisRows.
    expect(invariants(res)).toEqual(["IDENTITY-COHERENCE"]);
  });
});

// ── SHAPE 1: NaN grade -> wrong tier (#1640, holding 6fc204f7 Maddux) ────────

describe("SHAPE 1 — an unreadable grade must never be priced as another tier (#1640)", () => {
  const MADDUX = "hiq:baseball:1987:topps-traded-tiffany:70t:base:no-auto";
  const psa10 = [
    { ...sale({ id: "m1", hobbyiqCardId: MADDUX, cardId: MADDUX, price: 1900, soldAt: daysAgo(7), gradeCompany: "PSA", gradeValue: 10, parallel: "Base", printRun: null }) },
    { ...sale({ id: "m2", hobbyiqCardId: MADDUX, cardId: MADDUX, price: 1850, soldAt: daysAgo(2), gradeCompany: "PSA", gradeValue: 10, parallel: "Base", printRun: null }) },
  ];
  const psa9 = [
    { ...sale({ id: "m3", hobbyiqCardId: MADDUX, cardId: MADDUX, price: 136, soldAt: daysAgo(9), gradeCompany: "PSA", gradeValue: 9, parallel: "Base", printRun: null }) },
    { ...sale({ id: "m4", hobbyiqCardId: MADDUX, cardId: MADDUX, price: 130, soldAt: daysAgo(19), gradeCompany: "PSA", gradeValue: 9, parallel: "Base", printRun: null }) },
    { ...sale({ id: "m5", hobbyiqCardId: MADDUX, cardId: MADDUX, price: 140, soldAt: daysAgo(29), gradeCompany: "PSA", gradeValue: 9, parallel: "Base", printRun: null }) },
  ];

  it("a PSA 10 priced off the PSA 9 tier is BASIS-IDENTITY cross-grade", () => {
    const h = holding({
      id: "6fc204f7", hobbyiqCardId: MADDUX, cardId: MADDUX,
      gradeCompany: "PSA", gradeValue: 10,
      fairMarketValue: 361.49, fmvRung: "exact-pool-projection",
      pricingSourceMeta: { slug: MADDUX, method: "unified-market-value", compsUsed: 3 },
    });
    const res = run(h, { basisRows: psa9, poolRows: [...psa10, ...psa9] });
    expect(kinds(res)).toContain("cross-grade");
    expect(invariants(res)).toContain("BASIS-IDENTITY");
    // and the shadow finds the RIGHT number off the real PSA 10 pair
    expect(res.shadowValue).toBeGreaterThan(1500);
  });

  it("the NaN grade itself refuses to price — never silently a tier", () => {
    const h = holding({
      hobbyiqCardId: MADDUX, cardId: MADDUX,
      gradeCompany: "PSA", gradeValue: Number.NaN,
      fairMarketValue: 361.49, fmvRung: "exact-pool-projection",
    });
    const res = run(h, { basisRows: [], poolRows: [...psa10, ...psa9] });
    expect(res.shadowRung).toBe("no-basis");
    expect(res.shadowValue).toBeNull();
    expect(res.notes.join(" ")).toMatch(/unreadable/i);
    // an exact-pool rung over a pool the shadow cannot read is dishonest
    expect(kinds(res)).toContain("rung-claims-empty-pool");
  });
});

// ── SHAPE 2: pool-twin cross-product merge (#1627, holding 9b971b03) ────────

describe("SHAPE 2 — a union is one card (#1627)", () => {
  const mixedPool = [
    sale({ id: "c1", price: 212, soldAt: daysAgo(3) }),
    sale({ id: "c2", price: 213, soldAt: daysAgo(12) }),
    sale({ id: "d1", hobbyiqCardId: DRAFT, cardId: DRAFT, price: 20.6, soldAt: daysAgo(6), title: "2024 Bowman Draft RA-JC" }),
    sale({ id: "d2", hobbyiqCardId: DRAFT, cardId: DRAFT, price: 21.2, soldAt: daysAgo(16), title: "2024 Bowman Draft RA-JC" }),
  ];

  it("two products in one basis is BASIS-IDENTITY cross-product", () => {
    const h = holding({ cardId: DRAFT, hobbyiqCardId: CHROME, fairMarketValue: 21.25 });
    const res = run(h, { basisRows: mixedPool, poolRows: mixedPool });
    const crossProduct = res.findings.filter((f: { kind: string }) => f.kind === "cross-product");
    expect(crossProduct.length).toBe(2);
    expect(crossProduct[0].detail).toMatch(/2024:bowman-draft/);
  });

  it("the shadow refuses the union and prices single-sided from its own slug", () => {
    const h = holding({ cardId: DRAFT, hobbyiqCardId: CHROME, fairMarketValue: 21.25 });
    const res = run(h, { basisRows: mixedPool, poolRows: mixedPool });
    expect(res.notes.join(" ")).toMatch(/union-refused/);
    // priced off the two Chrome sales (~212), NOT the Bowman Draft half (~21)
    expect(res.shadowValue).toBeGreaterThan(150);
    // ...which makes the persisted $21.25 a substitution finding
    expect(invariants(res)).toContain("SUBSTITUTION");
  });
});

// ── SHAPE 3: base autos in a refractor pool (#1624 GREAT REMATCH) ───────────

describe("SHAPE 3 — base autos must not price a refractor (#1624)", () => {
  const BASE_AUTO = "hiq:baseball:2026:topps-chrome:ra-jc:base:auto";
  it("a base-parallel comp under a refractor holding is cross-parallel", () => {
    const basis = [
      sale({ id: "b1", hobbyiqCardId: BASE_AUTO, cardId: BASE_AUTO, price: 40, parallel: "Base", printRun: null }),
      sale({ id: "b2", hobbyiqCardId: BASE_AUTO, cardId: BASE_AUTO, price: 44, parallel: "Base", printRun: null }),
    ];
    const res = run(holding({ fairMarketValue: 42 }), { basisRows: basis, poolRows: basis });
    expect(kinds(res)).toContain("cross-parallel");
    expect(res.findings.find((f: { kind: string }) => f.kind === "cross-parallel").detail)
      .toMatch(/parallel "base".*holding is "refractor"/i);
  });

  it("a print-run mismatch under the same parallel is cross-printrun", () => {
    const OTHER_RUN = "hiq:baseball:2026:topps-chrome:ra-jc:refractor:auto:num-150";
    const basis = [sale({ id: "p1", hobbyiqCardId: OTHER_RUN, cardId: OTHER_RUN, printRun: 150, price: 900 })];
    const res = run(holding({ fairMarketValue: 900 }), { basisRows: basis, poolRows: basis });
    expect(kinds(res)).toContain("cross-printrun");
  });
});

// ── SHAPE 4: a stale write racing a sale (#1627 swing) ──────────────────────

describe("SHAPE 4 — unchanged provenance must not move the value (#1627)", () => {
  const basis = [sale({ id: "s1", price: 200 }), sale({ id: "s2", price: 205 }), sale({ id: "s3", price: 198 })];

  it("same comps, moved value -> DETERMINISM", () => {
    const fingerprint = inv.provenanceFingerprint(basis);
    const res = run(holding({ fairMarketValue: 212.95 }), {
      basisRows: basis,
      poolRows: basis,
      previous: { fingerprint, value: 20.625, at: daysAgo(1) },
    });
    expect(invariants(res)).toContain("DETERMINISM");
    expect(res.findings.find((f: { kind: string }) => f.kind === "nondeterministic-value").detail)
      .toMatch(/provenance unchanged/);
  });

  it("CHANGED comps moving the value is a market, not a defect", () => {
    const res = run(holding({ fairMarketValue: 212.95 }), {
      basisRows: basis,
      poolRows: basis,
      previous: { fingerprint: "9:deadbeef", value: 20.625, at: daysAgo(1) },
    });
    expect(invariants(res)).not.toContain("DETERMINISM");
  });

  it("the fingerprint is order-insensitive — a reordered read is not a change", () => {
    const a = inv.provenanceFingerprint(basis);
    const b = inv.provenanceFingerprint([...basis].reverse());
    expect(a).toBe(b);
  });
});

// ── SHAPE 5: phantom Pristine grades (#1625) ────────────────────────────────

describe("SHAPE 5 — Pristine is a product line, not a grade (#1625)", () => {
  const PRISTINE = "hiq:baseball:2024:topps-pristine:131:base:no-auto";
  it("raw product-line sales must not fill a graded holding's basis", () => {
    // The defect: "2024 Topps Pristine Baseball #131 Base" parsed as PSA 10, so
    // raw sales landed in a PSA 10 pool. The auditor reads the ROW's own grade
    // fields — a raw row is raw — and the tier mismatch surfaces.
    const basis = [
      sale({ id: "pr1", hobbyiqCardId: PRISTINE, cardId: PRISTINE, price: 12, gradeCompany: null, gradeValue: null, parallel: "Base", printRun: null }),
      sale({ id: "pr2", hobbyiqCardId: PRISTINE, cardId: PRISTINE, price: 14, gradeCompany: null, gradeValue: null, parallel: "Base", printRun: null }),
    ];
    const h = holding({
      hobbyiqCardId: PRISTINE, cardId: PRISTINE,
      gradeCompany: "PSA", gradeValue: 10, fairMarketValue: 13,
      pricingSourceMeta: { slug: PRISTINE, method: "unified-market-value", compsUsed: 2 },
    });
    const res = run(h, { basisRows: basis, poolRows: basis });
    expect(kinds(res)).toContain("cross-grade");
    expect(res.findings.find((f: { kind: string }) => f.kind === "cross-grade").detail).toMatch(/tier "raw"/);
  });

  it("the grade tokenizer is the leaf utility, so the product word never mints a tier", () => {
    // Reused, not reimplemented: gradeParser already rules on this.
    expect(parseGradeLabel("2024 Topps Pristine Baseball #131 Base")).toBeNull();
  });
});

// ── SHAPE 6: an empty identity pool priced from a self-comp (#1622) ─────────

describe("SHAPE 6 — a self-comp is labeled, never the market alone (#1622)", () => {
  it("a pool that is only the owner's own purchase does not read as observed", () => {
    const selfOnly = [
      sale({ id: "holding::9b971b03", source: "holding-import", userId: "user-drew", price: 5000, soldAt: daysAgo(4) }),
    ];
    const res = run(holding({ fairMarketValue: 5000, fmvRung: "exact-pool-projection" }), {
      basisRows: selfOnly, poolRows: selfOnly,
    });
    expect(res.shadowRung).toBe("self-comp-only");
    expect(kinds(res)).toContain("rung-over-self-comps");
    expect(res.notes.join(" ")).toMatch(/self-comp/);
  });

  it("an exact-pool rung over a genuinely empty pool is RUNG-HONESTY", () => {
    const res = run(holding({ fairMarketValue: 1109.44, fmvRung: "exact-pool-projection" }), {
      basisRows: [], poolRows: [],
    });
    expect(kinds(res)).toContain("rung-claims-empty-pool");
    expect(invariants(res)).toContain("RUNG-HONESTY");
  });

  it("a DECLARED fallback rung over an empty exact pool is honest, not a violation", () => {
    // sibling-estimate says "this came from another identity" — it never
    // claimed the exact pool, so RUNG-HONESTY has nothing to say.
    const res = run(holding({ fairMarketValue: 1109.44, fmvRung: "sibling-estimate", pricingSourceMeta: null }), {
      basisRows: [], poolRows: [],
    });
    expect(invariants(res)).not.toContain("RUNG-HONESTY");
  });
});

// ── SHAPE 7: a value that names no source (C-7 / C-8) ───────────────────────

/**
 * The live shape this suite could not see.
 *
 * Holding 277b05a3 (Cal Ripken Jr., PSA 8), read read-only from prod after
 * reprice run 33807265583 on deploy 6acd213 — the deploy that made
 * `valueSource` required at every lane:
 *
 *     fairMarketValue  49.99
 *     fmvRung          "exact-pool-weighted-median"     <- present and honest
 *     valueSource      (key ABSENT)                     <- the defect
 *     lastUpdated      2026-09-03T21:20:02Z
 *
 * A rung WITHOUT a valueSource is the interesting half, and it is the half
 * that had no pin: the auditor's `value-carries-no-rung` check ORs the two key
 * absences, so a test that only ever removed `fmvRung` leaves the
 * `valueSourceAbsent` clause free to be deleted with the suite still green.
 * These are mutation pins — each fails if its clause is removed from
 * checkRungHonesty.
 */
describe("SHAPE 7 — a persisted value always names its source (C-7, holding 277b05a3)", () => {
  /** `delete`, not `undefined`: the live defect is an ABSENT key. */
  const without = (h: Row, key: string): Row => {
    const next = { ...h };
    delete next[key];
    return next;
  };

  const healthyPool = [
    sale({ id: "p1", price: 198, soldAt: daysAgo(5) }),
    sale({ id: "p2", price: 202, soldAt: daysAgo(20) }),
    sale({ id: "p3", price: 195, soldAt: daysAgo(40) }),
  ];

  it("a value with an honest rung but NO valueSource is RUNG-HONESTY", () => {
    // The Ripken shape exactly: the rung is present, correct, and backed by a
    // real pool — only `valueSource` is missing. Every other check passes, so
    // this fails if and only if the valueSource clause is live.
    const res = run(without(holding({ fairMarketValue: 200 }), "valueSource"), {
      basisRows: healthyPool, poolRows: healthyPool,
    });
    expect(kinds(res)).toContain("value-carries-no-rung");
    expect(invariants(res)).toContain("RUNG-HONESTY");
    expect(res.findings.find((f: { kind: string }) => f.kind === "value-carries-no-rung").detail)
      .toMatch(/valueSource/);
  });

  it("a null valueSource is as absent as a missing key — neither is a source", () => {
    const res = run(holding({ fairMarketValue: 200, valueSource: null }), {
      basisRows: healthyPool, poolRows: healthyPool,
    });
    expect(kinds(res)).toContain("value-carries-no-rung");
  });

  it("a value with NO fmvRung key is RUNG-HONESTY (the other clause)", () => {
    const res = run(without(holding({ fairMarketValue: 200 }), "fmvRung"), {
      basisRows: healthyPool, poolRows: healthyPool,
    });
    expect(kinds(res)).toContain("value-carries-no-rung");
    expect(res.findings.find((f: { kind: string }) => f.kind === "value-carries-no-rung").detail)
      .toMatch(/fmvRung/);
  });

  it("a value shown via estimatedValue counts — the collector sees a number either way", () => {
    const res = run(
      without(holding({ fairMarketValue: null, estimatedValue: 241, fmvRung: "rare-card-anchor" }), "valueSource"),
      { basisRows: healthyPool, poolRows: healthyPool },
    );
    expect(kinds(res)).toContain("value-carries-no-rung");
  });

  it("a holding carrying BOTH keys is clean — the check is about absence, not about the rung", () => {
    const res = run(holding({ fairMarketValue: 200, valueSource: "observed" }), {
      basisRows: healthyPool, poolRows: healthyPool,
    });
    expect(kinds(res)).not.toContain("value-carries-no-rung");
  });

  it("an UNPRICED holding missing both keys is not a finding — there is no value to source", () => {
    // The withhold path: fairMarketValue null, nothing shown to anyone. A
    // finding here would flag every legitimately unpriced row in the corpus.
    const res = run(without(holding({ fairMarketValue: null, estimatedValue: null }), "valueSource"), {
      basisRows: [], poolRows: [],
    });
    expect(kinds(res)).not.toContain("value-carries-no-rung");
  });
});

// ── The doctrine rungs the shadow must honour ───────────────────────────────

describe("the shadow applies the doctrine ladder, not a median", () => {
  it("FMV is the projected next sale — a rising pool projects ABOVE its median", () => {
    const rising = [
      sale({ id: "r1", price: 100, soldAt: daysAgo(90) }),
      sale({ id: "r2", price: 150, soldAt: daysAgo(60) }),
      sale({ id: "r3", price: 200, soldAt: daysAgo(30) }),
      sale({ id: "r4", price: 250, soldAt: daysAgo(1) }),
    ];
    const res = run(holding({ fairMarketValue: 250 }), { basisRows: rising, poolRows: rising });
    expect(res.shadowValue).toBeGreaterThan(175); // the median of 100/150/200/250
  });

  it("a thin pool takes the LAST SALE, not an average", () => {
    const thin = [sale({ id: "t1", price: 500, soldAt: daysAgo(3) }), sale({ id: "t2", price: 100, soldAt: daysAgo(80) })];
    const res = run(holding({ fairMarketValue: 500 }), { basisRows: thin, poolRows: thin });
    expect(res.shadowRung).toBe("exact-pool-last-sale");
    expect(res.shadowValue).toBe(500);
  });

  it("GRADED-TO-RAW: an empty raw pool prices from its OWN graded children", () => {
    const RAWCARD = "hiq:baseball:2018:bowman-chrome:1:base:no-auto";
    const gradedChildren = [
      sale({ id: "g1", hobbyiqCardId: RAWCARD, cardId: RAWCARD, gradeCompany: "PSA", gradeValue: 10, price: 3000, soldAt: daysAgo(5), parallel: "Base", printRun: null }),
      sale({ id: "g2", hobbyiqCardId: RAWCARD, cardId: RAWCARD, gradeCompany: "PSA", gradeValue: 10, price: 3100, soldAt: daysAgo(15), parallel: "Base", printRun: null }),
      sale({ id: "g3", hobbyiqCardId: RAWCARD, cardId: RAWCARD, gradeCompany: "PSA", gradeValue: 10, price: 2900, soldAt: daysAgo(25), parallel: "Base", printRun: null }),
    ];
    const h = holding({ hobbyiqCardId: RAWCARD, cardId: RAWCARD, fairMarketValue: 600, fmvRung: "graded-pool-inverse", pricingSourceMeta: null });
    const res = run(h, { basisRows: [], poolRows: gradedChildren });
    expect(res.shadowRung).toBe("graded-pool-inverse");
    // PSA 10 ~3000 / the 5x empirical multiplier
    expect(res.shadowValue).toBeGreaterThan(400);
    expect(res.shadowValue).toBeLessThan(800);
  });

  it("graded-to-raw is same-identity only — another card's graded pool never fills it", () => {
    const RAWCARD = "hiq:baseball:2018:bowman-chrome:1:base:no-auto";
    const OTHER = "hiq:baseball:2018:bowman-chrome:99:base:no-auto";
    const otherCard = [
      sale({ id: "o1", hobbyiqCardId: OTHER, cardId: OTHER, gradeCompany: "PSA", gradeValue: 10, price: 3000, soldAt: daysAgo(5) }),
      sale({ id: "o2", hobbyiqCardId: OTHER, cardId: OTHER, gradeCompany: "PSA", gradeValue: 10, price: 3100, soldAt: daysAgo(15) }),
      sale({ id: "o3", hobbyiqCardId: OTHER, cardId: OTHER, gradeCompany: "PSA", gradeValue: 10, price: 2900, soldAt: daysAgo(25) }),
    ];
    const h = holding({ hobbyiqCardId: RAWCARD, cardId: RAWCARD, fairMarketValue: 600 });
    const res = run(h, { basisRows: [], poolRows: otherCard });
    expect(res.shadowRung).toBe("no-basis");
  });
});

// ── SUBSTITUTION band ───────────────────────────────────────────────────────

describe("SUBSTITUTION is a wide band — it hunts substitution, not rounding", () => {
  const pool = [
    sale({ id: "s1", price: 200, soldAt: daysAgo(5) }),
    sale({ id: "s2", price: 200, soldAt: daysAgo(15) }),
    sale({ id: "s3", price: 200, soldAt: daysAgo(25) }),
  ];
  it("a 10% difference is not a finding", () => {
    const res = run(holding({ fairMarketValue: 220 }), { basisRows: pool, poolRows: pool });
    expect(invariants(res)).not.toContain("SUBSTITUTION");
  });
  it("a 2x difference is a finding, and it is never auto-corrected", () => {
    const res = run(holding({ fairMarketValue: 400 }), { basisRows: pool, poolRows: pool });
    const finding = res.findings.find((f: { kind: string }) => f.kind === "value-divergence");
    expect(finding).toBeTruthy();
    expect(finding.detail).toMatch(/2\.00x/);
    // The auditor reports; it does not write a price.
    expect(res.persisted).toBe(400);
  });
});

// ── the grade-multiplier loader ─────────────────────────────────────────────
//
// THE RUNG WAS DEAD CODE AND NOTHING SAID SO. loadGradeMultipliers() flattened
// GRADE_CALIBRATION as if it were one level deep — `Object.entries(table)` and
// then `.multiplier ?? .ratio` off each value. But the top level is a FAMILY
// ("bowman"), whose value is a map of grading companies and carries neither
// field, so every entry evaluated to NaN, the finite-guard dropped all of them,
// and the loader returned {}. `gradeMultipliers=0` printed in the banner every
// run. The graded-to-raw rung tests `Number.isFinite(mult)` before it fires, so
// it could never fire for any holding: the rung above was live, tested, and
// unreachable in production.
//
// The `catch { return {} }` is what hid it — a malformed table and a missing
// one produced the identical empty map, so the safe-direction fallback silently
// swallowed a real shape error. That is why these pins assert against the LIVE
// shipped table rather than a fixture: a fixture would have been written to the
// shape the loader expected, and agreed with the bug.
describe("the grade multiplier loader reads the real GRADE_CALIBRATION shape", () => {
  const audit = require_(path.join(backend, "scripts", "audit-pricing-invariants.cjs"));
  const { GRADE_CALIBRATION } = require_(path.join(backend, "dist", "services", "compiq", "gradeCalibrationData.js"));

  it("the live table yields a NON-EMPTY multiplier map", () => {
    // The whole defect in one assertion. This was 0.
    const mult = audit.flattenGradeCalibration(GRADE_CALIBRATION);
    expect(Object.keys(mult).length).toBeGreaterThan(0);
  });

  it("the old one-level flatten yields nothing — the bug, pinned as the contrast", () => {
    // Reproduces the shipped loader verbatim against the live table, so that if
    // the table were ever reshaped to actually BE one level deep, this pin
    // fails and tells the next reader these two are no longer different.
    const old: Record<string, number> = {};
    for (const [k, v] of Object.entries(GRADE_CALIBRATION as Record<string, unknown>)) {
      const entry = v as { multiplier?: number; ratio?: number };
      const n = typeof v === "number" ? v : Number(entry?.multiplier ?? entry?.ratio ?? NaN);
      if (Number.isFinite(n) && n > 0) old[k.toUpperCase()] = n;
    }
    expect(Object.keys(old)).toEqual([]);
  });

  it("a known family/company/tier resolves to its empirical medianRatio", () => {
    const mult = audit.flattenGradeCalibration(GRADE_CALIBRATION);
    // PSA 10 is the most-sampled tier in the shipped table. The value must be
    // a real premium, and must be the number the table actually carries — not
    // a default, and not an invented constant (empirical-only doctrine).
    expect(mult["PSA 10"]).toBeGreaterThan(1);
    const psa10s = Object.values(GRADE_CALIBRATION as Record<string, Record<string, { byTier?: Record<string, { medianRatio: number }> }>>)
      .map((companies) => companies?.PSA?.byTier?.["10"]?.medianRatio)
      .filter((n): n is number => Number.isFinite(n));
    expect(psa10s).toContain(mult["PSA 10"]);
  });

  it("keys are in the tier format the shadow pricer looks up by", () => {
    // gradeTierOf builds "<COMPANY> <VALUE>". A loader keyed any other way
    // returns a populated map whose every lookup still misses — the rung stays
    // dead while the banner claims otherwise.
    const mult = audit.flattenGradeCalibration(GRADE_CALIBRATION);
    const tier = inv.gradeTierOf({ gradeCompany: "PSA", gradeValue: 10 }, parseGradeLabel);
    expect(tier).toBe("PSA 10");
    expect(mult[tier]).toBeGreaterThan(1);
  });

  it("only per-tier ratios are read — never the cross-tier company median", () => {
    // The company-level medianRatio averages a PSA 10 and a PSA 6 into one
    // number. Reading it would price a PSA 6 off a figure a PSA 10 dominates.
    const table = {
      fam: { PSA: { medianRatio: 99, sampleSize: 10000, byTier: { "9": { medianRatio: 2.5, sampleSize: 40 } } } },
    };
    const mult = audit.flattenGradeCalibration(table);
    expect(mult["PSA 9"]).toBe(2.5);
    expect(Object.values(mult)).not.toContain(99);
  });

  it("a malformed or absent table degrades to no multipliers, not to a wrong one", () => {
    for (const bad of [null, undefined, {}, 42, "nope", { fam: null }, { fam: { PSA: {} } }]) {
      expect(audit.flattenGradeCalibration(bad)).toEqual({});
    }
  });
});

// ── the rung, driven by the REAL multipliers ────────────────────────────────
describe("graded-to-raw prices an empty raw pool from its own graded children", () => {
  const audit = require_(path.join(backend, "scripts", "audit-pricing-invariants.cjs"));
  const { GRADE_CALIBRATION } = require_(path.join(backend, "dist", "services", "compiq", "gradeCalibrationData.js"));
  const real = audit.flattenGradeCalibration(GRADE_CALIBRATION) as Record<string, number>;

  it("a raw holding with 3 PSA 10 children prices off them, through the shipped multiplier", () => {
    // The end-to-end proof that the loader fix reaches the rung: this exact
    // holding returned `no-basis` before it, because gradeMultipliers was {}.
    const psa10 = real["PSA 10"];
    expect(psa10).toBeGreaterThan(1);
    const graded = [5, 15, 25].map((d, i) =>
      sale({ id: `g${i}`, gradeCompany: "PSA", gradeValue: 10, price: 710, soldAt: daysAgo(d) }));
    const res = inv.auditHolding(holding({ fairMarketValue: 100, fmvRung: "graded-pool-inverse" }), {
      basisRows: [], poolRows: graded, previous: null, nowMs: NOW,
      userId: "user-drew", gradeMultipliers: real, leaf,
    });
    expect(res.shadowRung).toBe("graded-pool-inverse");
    // ~710 / the empirical PSA 10 multiplier — the value, not a median.
    expect(res.shadowValue).toBeCloseTo(710 / psa10, 5);
    expect(res.notes.join(" ")).toMatch(/raw pool empty/);
  });

  it("with an EMPTY multiplier map the rung cannot fire — the shape of the bug", () => {
    const graded = [5, 15, 25].map((d, i) =>
      sale({ id: `g${i}`, gradeCompany: "PSA", gradeValue: 10, price: 710, soldAt: daysAgo(d) }));
    const res = inv.auditHolding(holding({ fairMarketValue: 100 }), {
      basisRows: [], poolRows: graded, previous: null, nowMs: NOW,
      userId: "user-drew", gradeMultipliers: {}, leaf,
    });
    expect(res.shadowRung).toBe("no-basis");
  });
});

// ── IDENTITY-COHERENCE ───────────────────────────────────────────────────────

/**
 * CF-A-SPLIT-ROW-POLLUTES-TWO-POOLS (Drew, 2026-09-02: "we need to go back and
 * check ALL this way").
 *
 * A comp row carries two identity fields and exactPoolReader.ts matches on
 * EITHER of them, so a row whose `cardId` and `hobbyiqCardId` name different
 * cards is read into BOTH pools -- one sale pricing two cards.
 *
 * The defect is invisible to BASIS-IDENTITY, and these pins say why: that check
 * reads `row.hobbyiqCardId ?? row.cardId`, so it only ever sees ONE of the two
 * identities -- and whichever it sees agrees with the holding, because that is
 * the field the OR-query matched on. The row looks like a perfectly ordinary
 * member of the pool it was asked for. Only reading BOTH fields off the SAME
 * row exposes the contradiction.
 */
describe("IDENTITY-COHERENCE — a comp row that contradicts itself", () => {
  /** A seeded split: partitioned under CHROME, slugged to the DRAFT card. */
  const splitComp = sale({ id: "split-1", cardId: CHROME, hobbyiqCardId: DRAFT, price: 200 });

  it("flags a comp whose two identity fields name different cards", () => {
    const res = run(holding(), { basisRows: [splitComp], poolRows: [splitComp] });
    expect(invariants(res)).toContain("IDENTITY-COHERENCE");
    const finding = res.findings.find((f: { invariant: string }) => f.invariant === "IDENTITY-COHERENCE");
    expect(finding).toBeTruthy();
    // The violation QUOTES THE ROW: a repair needs both addresses, because the
    // pool it sits in and the pool its slug names are each wrong by one row.
    expect(finding.kind).toBe("split-identity/HIQ-SPLIT");
    expect(finding.cardId).toBe(CHROME);
    expect(finding.hobbyiqCardId).toBe(DRAFT);
    expect(finding.compId).toBe("split-1");
    expect(finding.detail).toContain(CHROME);
    expect(finding.detail).toContain(DRAFT);
    // The segments name the KIND of damage -- here a different year and set.
    expect(finding.segments).toContain("setKey");
  });

  it("BASIS-IDENTITY alone would NOT have caught it — this is why the assert exists", () => {
    // The split row's hobbyiqCardId is the DRAFT card, so BASIS-IDENTITY does
    // fire here on the product axis. The point of THIS pin is the opposite
    // shape: a split whose slug half matches the holding exactly. BASIS sees
    // only that half and passes it; IDENTITY-COHERENCE still catches it.
    const stealthy = sale({ id: "split-2", cardId: DRAFT, hobbyiqCardId: CHROME, price: 200 });
    const res = run(holding(), { basisRows: [stealthy], poolRows: [stealthy] });
    expect(invariants(res)).not.toContain("BASIS-IDENTITY");
    expect(invariants(res)).toContain("IDENTITY-COHERENCE");
  });

  it("a healthy VENDOR-DESIGN row passes — the exemption is what keeps this usable", () => {
    // #1650: a CardHedge row is partitioned under the vendor's bubble id and
    // carries our slug beside it. 13.5M rows are shaped this way. Without the
    // exemption this invariant would fire on nearly every holding in the
    // portfolio and the real damage would never be seen.
    const vendorRow = sale({
      id: "ch-1", source: "cardhedge",
      cardId: "1778542173652x303328120692600800",
      hobbyiqCardId: CHROME,
    });
    const res = run(holding(), { basisRows: [vendorRow], poolRows: [vendorRow] });
    expect(invariants(res)).not.toContain("IDENTITY-COHERENCE");
  });

  it("an ordinary coherent pool raises nothing", () => {
    const clean = [sale({ id: "c1" }), sale({ id: "c2", price: 205 })];
    const res = run(holding(), { basisRows: clean, poolRows: clean });
    expect(invariants(res)).not.toContain("IDENTITY-COHERENCE");
  });

  it("reads poolRows, not basisRows — a split read but not cited still counts", () => {
    // The question is what the pool READ reached: every row the OR-query
    // returned, whether or not the persisted price ended up citing it. A split
    // row filtered out by a window or an anomaly flag is still in that pool.
    const clean = sale({ id: "c1" });
    const res = run(holding(), { basisRows: [clean], poolRows: [clean, splitComp] });
    expect(invariants(res)).toContain("IDENTITY-COHERENCE");
  });
});
