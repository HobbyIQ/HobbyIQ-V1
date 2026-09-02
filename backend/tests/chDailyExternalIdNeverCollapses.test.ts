// CF-CH-DAILY-EXTERNAL-ID (2026-09-02) — the ch-daily sameness proof, pinned
// against the rows that prompted the question.
//
// A report held that CardHedge daily ingest reuses ONE sourceExternalId across
// DISTINCT sales — that `ch-daily::162790851436` sat on four rows at four
// prices/grades ($1,850 PSA 10, $159 PSA 9, $150 PSA 9, $59.77 raw). That
// would poison the discriminator behind TRUE-DUPE (collision-triage's
// `externalIdOf`), because a shared id would stop meaning a shared sale.
//
// The census disproved it (scripts/census-ch-daily-external-id-reuse.cjs):
// those four rows carry four DIFFERENT composite ids of the shape
// `ch-daily::<cardId>::<soldAt>::<cents>`. What repeats is CardHedge's CARD
// id, not a sale id — one card id legitimately spans years of sales at every
// grade. Over the 40,000 most recent ch-daily rows, ZERO full ids sat on more
// than one row.
//
// So no hardening was applied. These pins are the regression guard on that
// conclusion: they fix the real rows into the real classifier, so that if an
// ingest change ever DOES start reusing a full id across distinct sales, or if
// anyone reduces an id to its base by splitting on "::", the quartet starts
// collapsing and these tests say so.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { classifyCollision, externalIdOf } = require_("../scripts/lib/collision-triage.cjs");

const MADDUX = "hiq:baseball:1987:topps-traded-tiffany:70t:base:no-auto";
const BASE = "1627908514367x488979553047805950";
// The four rows from the report, with the ids they ACTUALLY carry in prod.
const quartet = [
  { sourceExternalId: `ch-daily::${BASE}::2026-08-31T00:07:00+00:00::185000`, price: 1850, gradeCompany: "PSA", gradeValue: 10, soldAt: "2026-08-31T00:07:00+00:00", cardId: MADDUX, cardNumber: "70T", parallel: null, isAuto: false, source: "cardhedge" },
  { sourceExternalId: `ch-daily::${BASE}::2026-09-01T01:43:00+00:00::15900`, price: 159, gradeCompany: "PSA", gradeValue: 9, soldAt: "2026-09-01T01:43:00+00:00", cardId: MADDUX, cardNumber: "70T", parallel: null, isAuto: false, source: "cardhedge" },
  { sourceExternalId: `ch-daily::${BASE}::2026-09-01T01:43:00+00:00::15000`, price: 150, gradeCompany: "PSA", gradeValue: 9, soldAt: "2026-09-01T01:43:00+00:00", cardId: MADDUX, cardNumber: "70T", parallel: null, isAuto: false, source: "cardhedge" },
  { sourceExternalId: `ch-daily::${BASE}::2026-09-01T06:49:00+00:00::5977`, price: 59.77, gradeCompany: null, gradeValue: null, soldAt: "2026-09-01T06:49:00+00:00", cardId: MADDUX, cardNumber: "70T", parallel: null, isAuto: false, source: "cardhedge" },
];

describe("ch-daily composite external ids are per-sale, and never collapse", () => {
  it("the Maddux quartet carries FOUR distinct ids — the shared segment is the card id", () => {
    const ids = new Set(quartet.map((r) => externalIdOf(r)));
    expect(ids.size).toBe(4);
    // Every one of them shares the card id, which is exactly why a base-id
    // reading of these rows would wrongly call them one sale.
    expect(quartet.every((r) => r.sourceExternalId.includes(BASE))).toBe(true);
  });

  it("externalIdOf keeps the FULL id — it must never split on '::'", () => {
    // The load-bearing property. If this ever returns the base, the four rows
    // become one "sale" and three real sales are flagged away.
    expect(externalIdOf(quartet[0])).toBe(`ch-daily::${BASE}::2026-08-31T00:07:00+00:00::185000`);
    expect(externalIdOf(quartet[0])).not.toBe(`ch-daily::${BASE}`);
  });

  it("the quartet does NOT classify as TRUE-DUPE — no row is flagged away", () => {
    const verdict = classifyCollision(quartet);
    expect(verdict.class).not.toBe("TRUE-DUPE");
    expect(verdict.flag).toEqual([]);       // nothing auto-excluded
    expect(verdict.survivor).toBeNull();    // no winner picked over the others
  });

  it("the $1,850 PSA 10 and the $59.77 raw are never collapsed into one sale", () => {
    // The pricing consequence: collapsing these would delete the PSA 10 tier's
    // evidence and drop the holding onto a raw-derived number.
    const verdict = classifyCollision([quartet[0], quartet[3]]);
    expect(verdict.class).not.toBe("TRUE-DUPE");
    expect(verdict.flag).toEqual([]);
  });

  it("a genuinely shared id with an agreeing identity IS still a TRUE-DUPE", () => {
    // The guard must not have been loosened into uselessness: one sale stored
    // twice under two cardId partitions (measured: 4 such pairs under this very
    // card id) is still caught.
    const dupe = [
      { ...quartet[0], cardId: MADDUX },
      { ...quartet[0], cardId: BASE },
    ];
    const verdict = classifyCollision(dupe);
    expect(verdict.class).toBe("TRUE-DUPE");
    expect(verdict.flag.length).toBe(1);
  });
});
