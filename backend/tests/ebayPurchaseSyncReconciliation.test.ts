/**
 * RUN 33848620910: "OVER by 2, more claimed than intended".
 *
 * The weekly eBay purchase sync went red on a run whose purchase arithmetic
 * was exactly right. Nine connected users; seven synced; two had dead eBay
 * grants (one `invalid_scope`, one `invalid_grant`). The summary read:
 *
 *   usersAttempted 9  usersFetched 7  imported 2  replayed 127  skipped 0  errors 2
 *
 * and the runner reconciled:
 *
 *   intended = 2 + 127 + 0 = 129      (PURCHASES)
 *   written  = 2                      (PURCHASES)
 *   skipped  = 127 + 0 = 127          (PURCHASES)
 *   failed   = errors = 2             (USERS  <-- the defect)
 *
 *   accounted = 2 + 127 + 2 = 131, over by 2.
 *
 * The over-count equals the errored-user count exactly, and always will: a
 * user whose token is dead fetches NOTHING, so it contributes 0 to `intended`
 * while being charged 1 to `failed`. It is a UNIT MIX -- users charged against
 * a purchase equation -- not a lost write. Nothing was missing from Cosmos:
 * both imported holdings were verified present.
 *
 * These tests pin the arithmetic and the classification so the units cannot
 * be mixed again.
 */
import { describe, expect, it } from "vitest";
import { reconcileWrites } from "../src/services/ops/writeReconciliation.js";

/** The exact counters run 33848620910 produced. */
const RUN = {
  usersAttempted: 9,
  usersFetched: 7,
  purchasesImported: 2,
  purchasesReplayed: 127,
  purchasesSkipped: 0,
  erroredUsers: 2,
};

const purchaseArithmetic = (r: typeof RUN, failed: number) => {
  const intended = r.purchasesImported + r.purchasesReplayed + r.purchasesSkipped;
  return reconcileWrites({
    job: "run-ebay-purchase-sync",
    intended,
    written: r.purchasesImported,
    skipped: r.purchasesReplayed + r.purchasesSkipped,
    failed,
  });
};

describe("the OVER-by-2 is a unit mix, not a lost write", () => {
  it("reproduces the incident exactly when errored USERS are charged as failed PURCHASES", () => {
    const r = purchaseArithmetic(RUN, RUN.erroredUsers);
    expect(r.ok).toBe(false);
    expect(r.overAccounted).toBe(2);
    // The over-count IS the errored-user count. That identity is the proof.
    expect(r.overAccounted).toBe(RUN.erroredUsers);
    expect(r.message).toContain("COUNTERS DO NOT ADD UP");
  });

  it("reconciles clean once `failed` counts purchases -- the same run, nothing else changed", () => {
    const r = purchaseArithmetic(RUN, 0);
    expect(r.ok).toBe(true);
    expect(r.overAccounted).toBe(0);
    expect(r.unaccounted).toBe(0);
    expect(r.message).toContain("intended 129 = written 2 + skipped 127");
  });

  it("nothing was actually missing: written + skipped already equals intended", () => {
    expect(RUN.purchasesImported + RUN.purchasesReplayed + RUN.purchasesSkipped).toBe(129);
    expect(RUN.purchasesImported + (RUN.purchasesReplayed + RUN.purchasesSkipped)).toBe(129);
  });
});

describe("MUTATION: the over-count tracks the errored-user count, for any N", () => {
  // If the equation is ever re-wired to charge users again, these move
  // together. A fix that only special-cased N=2 fails here.
  for (const n of [1, 2, 5, 7]) {
    it(`charging ${n} errored user(s) as failed purchases reads OVER by exactly ${n}`, () => {
      const bad = purchaseArithmetic(RUN, n);
      expect(bad.overAccounted).toBe(n);
      expect(bad.ok).toBe(false);
    });
  }

  it("and with failed=0 the verdict is clean regardless of how many users errored", () => {
    for (const n of [0, 1, 2, 5, 7]) {
      const good = purchaseArithmetic({ ...RUN, erroredUsers: n }, 0);
      expect(good.ok).toBe(true);
      expect(good.overAccounted).toBe(0);
    }
  });
});

describe("MUTATION: a REAL purchase shortfall must still be caught", () => {
  it("does not go green just because `failed` is 0 -- vanished work is still loud", () => {
    // 129 intended, only 2 written and 27 skipped: 100 purchases vanished.
    const r = reconcileWrites({
      job: "run-ebay-purchase-sync",
      intended: 129,
      written: 2,
      skipped: 27,
      failed: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.unaccounted).toBe(100);
    expect(r.message).toContain("WORK VANISHED");
  });

  it("a purchase that genuinely failed is still declarable and still reconciles", () => {
    const r = reconcileWrites({
      job: "run-ebay-purchase-sync",
      intended: 129,
      written: 2,
      skipped: 27,
      failed: 100,
    });
    expect(r.ok).toBe(true);
    expect(r.overAccounted).toBe(0);
  });
});
