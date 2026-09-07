// CF-A-PARKED-TWIN-IS-NOT-A-TWIN (#1953) — the twin rule at the sold_comps
// write door.
//
// WHAT BROKE. The hourly "Promote Staging Pending" job ran to 0 inserts for
// hours: run 34133391955 (2026-09-07 14:31Z) scanned 6,557 rows, wrote none,
// and reported `WORK VANISHED — UNACCOUNTED 6,557 (100.00%)`. Every row was
// refused by the twin-address guard, whose whole implementation was:
//
//     const twin = elsewhere.find((r) => r.cardId !== doc.cardId);
//     if (twin) { ...refuse... }
//
// Two defects in one line, each pinned below, and each verified by mutation:
// restoring the old predicate turns the matching test red.
//
// MEASURED, on 200 of the 461 distinct refused ids probed live against
// sold_comps:
//     110  resident AT the staged address, every other copy already PARKED
//      14  resident AT the staged address, a live twin elsewhere
//      76  NOT resident, a live twin elsewhere   <- the only true refusals
// and 131 of the 139 parked copies carried `dedupSupersededBy` pointing at
// EXACTLY the address the promoter was trying to write.

import { describe, it, expect } from "vitest";
import { decideTwinAddress, isParked } from "../src/services/portfolioiq/twinAddressRule.js";

const BASE = "hiq:baseball:2017:topps:87:base:no-auto";
const CHROME = "hiq:baseball:2017:topps-chrome:87-aj:base:no-auto";
const THIRD = "hiq:baseball:2017:bowman:87:base:no-auto";

describe("DEFECT 1 — a copy at THIS address is not a twin, it is this row", () => {
  it("folds when the sale is already resident at the address being written", () => {
    // The measured majority case (124 of 200). The query returns BOTH copies;
    // the old `.find(r => r.cardId !== writingAt)` stepped over the one at the
    // write address and refused on the other. But the write is an upsert into
    // a partition that already holds this id — Cosmos scopes id uniqueness per
    // partition, so it REPLACES. It cannot mint a second document, which is
    // the only thing the guard exists to prevent.
    const v = decideTwinAddress(CHROME, [
      { cardId: CHROME },
      { cardId: BASE, flaggedWrong: true, dedupSupersededBy: CHROME },
    ]);
    expect(v.action).toBe("fold");
  });

  it("a fold still NAMES a live twin elsewhere rather than hiding it", () => {
    // The 14-of-200 case. The write here is safe — it touches one partition —
    // but a live copy at another address is a real split pool, and the dedup
    // lane cannot adjudicate what nothing reports.
    const v = decideTwinAddress(CHROME, [{ cardId: CHROME }, { cardId: BASE }]);
    expect(v.action).toBe("fold");
    expect(v.liveTwinAt).toBe(BASE);
  });

  it("reports no twin when the only copy is the row itself", () => {
    const v = decideTwinAddress(CHROME, [{ cardId: CHROME }]);
    expect(v.action).toBe("fold");
    expect(v.liveTwinAt).toBeNull();
  });
});

describe("DEFECT 2 — a PARKED copy is out of every pool, so it is not a rival", () => {
  it("writes when the only other copy was parked by the dedup lane (#1942)", () => {
    // #1942 parks the losing copy with flaggedWrong + dedupSupersededBy naming
    // the WINNER. Here that winner is the address being written, so the guard
    // was blocking the write its own repair lane had authorised.
    const v = decideTwinAddress(CHROME, [
      { cardId: BASE, flaggedWrong: true, dedupSupersededBy: CHROME },
    ]);
    expect(v.action).toBe("write");
  });

  it("also treats identityUnverified as parked", () => {
    // The write guard's marker (CF-ONE-WRITE-PATH-FOR-SOLD-COMPS) means the
    // same thing for this rule's purposes: the row is not pricing a card.
    const v = decideTwinAddress(CHROME, [{ cardId: BASE, identityUnverified: true }]);
    expect(v.action).toBe("write");
  });

  it("isParked reads both markers, and neither by accident", () => {
    expect(isParked({ cardId: BASE, flaggedWrong: true })).toBe(true);
    expect(isParked({ cardId: BASE, identityUnverified: true })).toBe(true);
    expect(isParked({ cardId: BASE })).toBe(false);
    // Explicit false is a live row, not a parked one.
    expect(isParked({ cardId: BASE, flaggedWrong: false, identityUnverified: false })).toBe(false);
  });
});

describe("THE GUARD STILL GUARDS — a live twin elsewhere is still refused", () => {
  it("refuses when a live copy holds a different address and this row is not resident", () => {
    // The 76-of-200 case, and the reason the guard exists. Writing here would
    // be the second document: one sale, two pools, a double count in both.
    const v = decideTwinAddress(CHROME, [{ cardId: BASE }]);
    expect(v.action).toBe("refuse");
    expect(v.liveTwinAt).toBe(BASE);
  });

  it("refuses on the LIVE copy even when a parked copy is also present", () => {
    // The parked row must not be allowed to mask a genuine rival by being
    // found first — the rule has to skip it and keep looking.
    const v = decideTwinAddress(CHROME, [
      { cardId: THIRD, flaggedWrong: true },
      { cardId: BASE },
    ]);
    expect(v.action).toBe("refuse");
    expect(v.liveTwinAt).toBe(BASE);
  });

  it("writes a brand-new sale that exists nowhere", () => {
    expect(decideTwinAddress(CHROME, []).action).toBe("write");
  });
});

describe("the three actions are exhaustive — every id lands in exactly one", () => {
  it("reconciles: no input shape falls through without a verdict", () => {
    // CF-EVERY-WRITE-RECONCILES at the level of the rule itself. The promoter's
    // ledger is `tried = inserted + deduped + skipped + catalogUnmatched +
    // twinFolded + twinRefused + errored`; if a shape could return nothing,
    // that equation would silently fail to balance again.
    const shapes: Array<Parameters<typeof decideTwinAddress>[1]> = [
      [],
      [{ cardId: CHROME }],
      [{ cardId: BASE }],
      [{ cardId: BASE, flaggedWrong: true }],
      [{ cardId: CHROME }, { cardId: BASE }],
      [{ cardId: CHROME }, { cardId: BASE, flaggedWrong: true }],
      [{ cardId: BASE, flaggedWrong: true }, { cardId: THIRD }],
      [{ cardId: BASE, identityUnverified: true }, { cardId: THIRD, flaggedWrong: true }],
    ];
    for (const copies of shapes) {
      const v = decideTwinAddress(CHROME, copies);
      expect(["write", "fold", "refuse"]).toContain(v.action);
      // A refusal must always name where the rival is — a refusal nobody can
      // act on is how the backlog became permanent.
      if (v.action === "refuse") expect(v.liveTwinAt).toBeTruthy();
    }
  });
});

describe("a fold WRITES but does not INSERT — one row, one bucket", () => {
  it("the fold verdict is distinguishable from write, so the write door can skip inserted++", () => {
    // The trap this pins. A fold falls THROUGH to the upsert (it must — the
    // replace is the point), and the write door ends with `result.inserted++`.
    // If both moved for one row, the promoter's ledger
    //   tried = inserted + deduped + skipped + catalogUnmatched
    //         + twinFolded + twinRefused + errored
    // would OVER-account, and reportWrites treats over-accounting as loudly as
    // a shortfall — correctly, because it means a counter is being incremented
    // on a path it does not own.
    //
    // So "fold" must be its own action rather than a flavour of "write": the
    // write door reads it to decide whether the row is a NEW sale.
    const fold = decideTwinAddress(CHROME, [{ cardId: CHROME }]);
    const write = decideTwinAddress(CHROME, []);
    expect(fold.action).toBe("fold");
    expect(write.action).toBe("write");
    expect(fold.action).not.toBe(write.action);
  });
});
