// CF-WITHHELD-SAYS-WHY (Drew, 2026-09-05).
//
// The copy rules, pinned. These are node-environment tests: the module is
// pure (no DOM, no fetch, no React), so it runs in the existing vitest lane.
//
// What is actually being defended here is the invariant the audit found
// broken: FOUR causes must produce FOUR explanations, and the refused number
// must never escape the sentence that says it was refused.

import { describe, it, expect } from "vitest";
import type { PortfolioHolding } from "./api";
import {
  withheldOf,
  withheldShort,
  withheldUnlock,
  withheldSentence,
  withheldPoolNote,
  showsCheckingPrice,
  type WithheldReason,
  type WithheldBlock,
} from "./withheld";

const ALL: WithheldReason[] = [
  "cost-basis-floor",
  "no-checklist-match",
  "identity-not-in-catalog",
  "pool-migrating",
  "no-exact-pool",
  "ladder-timeout",
];

function holding(withheld: unknown): PortfolioHolding {
  return {
    id: "h1",
    quantity: 1,
    pricing: { provenance: { withheld } },
  } as unknown as PortfolioHolding;
}

describe("withheldOf: reads the envelope, invents nothing", () => {
  it("returns the block when the wire sent one", () => {
    const w = withheldOf(holding({ reason: "pool-migrating", proposed: null }));
    expect(w?.reason).toBe("pool-migrating");
  });

  it("returns null for a published row", () => {
    expect(withheldOf({ id: "h", quantity: 1 } as PortfolioHolding)).toBeNull();
  });

  it("returns null when the worker predates the field — absent is not a reason", () => {
    expect(withheldOf(holding(undefined))).toBeNull();
    expect(withheldOf(holding(null))).toBeNull();
  });
});

describe("Rule 1: six causes, six different sentences", () => {
  it("gives every reason its own short label", () => {
    const seen = new Set(ALL.map((r) => withheldShort(r)));
    // The bug: all four collapsed to "cost-basis check". Six distinct
    // strings (now that no-exact-pool and ladder-timeout have joined the
    // union) is the assertion that cannot pass if they ever re-collapse.
    expect(seen.size).toBe(6);
  });

  it("gives every reason its own unlock line", () => {
    expect(new Set(ALL.map((r) => withheldUnlock(r))).size).toBe(6);
  });

  it("never leaks the engine's vocabulary onto the glass", () => {
    for (const r of ALL) {
      const words = `${withheldShort(r)} ${withheldUnlock(r)}`;
      // The machine words are the INPUT to the mapping, never its output.
      expect(words).not.toContain("cost-basis-floor");
      expect(words).not.toContain("no-checklist-match");
      expect(words).not.toContain("identity-not-in-catalog");
      expect(words).not.toContain("pool-migrating");
      expect(words).not.toContain("no-exact-pool");
      expect(words).not.toContain("ladder-timeout");
    }
  });

  it("does not tell a no-checklist-match holding its cost basis blocked it", () => {
    // The exact defect from the audit, stated as a test.
    const words = `${withheldShort("no-checklist-match")} ${withheldUnlock("no-checklist-match")}`;
    expect(words.toLowerCase()).not.toContain("cost");
    expect(words.toLowerCase()).not.toContain("basis");
  });
});

describe("Rule 2: every reason says what would unlock it", () => {
  it("names a next step or an owner for all four", () => {
    for (const r of ALL) {
      expect(withheldUnlock(r).length).toBeGreaterThan(10);
      expect(withheldUnlock(r)).toMatch(/[.]$/);
    }
  });

  it("asks the owner to act only where the owner CAN act", () => {
    // Confirming card details fixes a missing checklist match. It does
    // nothing for a cost-basis floor, and sending them on that errand
    // would be worse than saying nothing.
    expect(withheldUnlock("no-checklist-match").toLowerCase()).toContain("confirm");
    expect(withheldUnlock("cost-basis-floor").toLowerCase()).not.toContain("confirm");
    // no-exact-pool is the same shape as the cost-basis floor: the card is
    // known, and nothing the owner confirms produces a sale that has not
    // happened. Time is the only unlock.
    expect(withheldUnlock("no-exact-pool").toLowerCase()).not.toContain("confirm");
    // ladder-timeout is not even the owner's card to fix — the engine ran
    // out of time, not out of evidence. No card-detail action applies.
    expect(withheldUnlock("ladder-timeout").toLowerCase()).not.toContain("confirm");
  });
});

describe("Rule 3: the refused number is evidence, never a price", () => {
  it("quotes the market number AND the basis it was refused against", () => {
    const s = withheldSentence(
      { reason: "cost-basis-floor", proposed: 2, retained: 29.45, blockingId: null, blockingCount: 4, retentionRefused: null },
      { costBasis: 29.45 },
    );
    expect(s).toContain("$2.00");
    expect(s).toContain("$29.45");
    // It must read as a refusal, not as a valuation.
    expect(s.toLowerCase()).toContain("do not publish");
  });

  it("never quotes a number the engine did not compute", () => {
    const s = withheldSentence({
      reason: "identity-not-in-catalog",
      proposed: null,
      retained: null,
      blockingId: null,
      blockingCount: null,
      retentionRefused: null,
    });
    expect(s).not.toMatch(/\$\d/);
  });

  it("still refuses cleanly when there is no cost basis to compare against", () => {
    const s = withheldSentence(
      { reason: "cost-basis-floor", proposed: 2, retained: null, blockingId: null, blockingCount: null, retentionRefused: null },
      { costBasis: null },
    );
    expect(s).toContain("$2.00");
    expect(s.toLowerCase()).toContain("below your cost");
  });

  it("gives a sentence for every reason", () => {
    for (const r of ALL) {
      const s = withheldSentence({
        reason: r, proposed: null, retained: null, blockingId: null, blockingCount: null, retentionRefused: null,
      });
      expect(s.length).toBeGreaterThan(20);
    }
  });

  it("ladder-timeout does NOT claim no sale exists — that is no-exact-pool's claim, not this one's", () => {
    // The whole reason ladder-timeout exists as its OWN reason (rather than
    // folding into no-exact-pool) is that the ladder made no determination
    // about the pool at all. The copy must say so EXPLICITLY (a disclaimer),
    // never state absence as a bare, undisclaimed fact the way no-exact-pool
    // legitimately does.
    const s = withheldSentence({
      reason: "ladder-timeout", proposed: null, retained: null, blockingId: null, blockingCount: null, retentionRefused: null,
    });
    expect(s.toLowerCase()).toContain("not a statement that no sale exists");
    // Contrast: no-exact-pool's sentence states absence plainly, with no
    // such disclaimer — the two reasons must read differently.
    const noExactPool = withheldSentence({
      reason: "no-exact-pool", proposed: null, retained: null, blockingId: null, blockingCount: null, retentionRefused: null,
    });
    expect(noExactPool.toLowerCase()).not.toContain("not a statement that no sale exists");
  });
});

describe("pool note: a refusal from 4 sales differs from one from none", () => {
  const base = { reason: "pool-migrating" as const, proposed: null, retained: null, blockingId: null, retentionRefused: null };

  it("counts sales, singular and plural", () => {
    expect(withheldPoolNote({ ...base, blockingCount: 1 })).toBe("1 sale in this pool");
    expect(withheldPoolNote({ ...base, blockingCount: 4 })).toBe("4 sales in this pool");
  });

  it("says nothing rather than '0 sales'", () => {
    expect(withheldPoolNote({ ...base, blockingCount: 0 })).toBeNull();
    expect(withheldPoolNote({ ...base, blockingCount: null })).toBeNull();
  });
});

// ─── The "mostly withheld" threshold (audit item 9) ────────────────────
//
// A portfolio whose cards are all present but mostly unpriced is not the
// empty state. The banner's rule lives in the page, but the SHAPE of the
// decision is pinned here: it is a proportion of the list, and it is never
// triggered by a fully priced portfolio.
describe("mostly-withheld is a proportion, not a count", () => {
  const mostly = (withheld: number, total: number) => withheld > 0 && withheld >= total / 2;

  it("fires when withheld rows are at least half", () => {
    expect(mostly(10, 20)).toBe(true);
    expect(mostly(71, 131)).toBe(true); // the platform-wide split
  });

  it("stays quiet for a few refusals in a healthy portfolio", () => {
    // Drew's own: 10 withheld of 43. Those rows speak for themselves.
    expect(mostly(10, 43)).toBe(false);
  });

  it("never fires on a fully priced portfolio", () => {
    expect(mostly(0, 43)).toBe(false);
    expect(mostly(0, 0)).toBe(false);
  });
});

// ─── CF-REPRICE-IS-VISIBLE-PER-ROW (Drew, 2026-09-05), audit item 6 ────
//
// The reprice is already async + polled; the gap was that the LIST said
// nothing while it ran. The rule for WHICH rows show a pending marker is the
// interesting part, so it is pinned here.
describe("per-row pending: only rows a run could change", () => {
  const pending = (repricing: boolean, value: number | null) => repricing && value == null;

  it("marks an unpriced row while a run is in flight", () => {
    expect(pending(true, null)).toBe(true);
  });

  it("leaves a PRICED row alone — a spinner on a good price reads as broken", () => {
    // The run may confirm the same number. Putting a pending marker on every
    // row would make a healthy portfolio look broken for the ~40s it takes.
    expect(pending(true, 1415)).toBe(false);
  });

  it("marks nothing when no run is in flight", () => {
    expect(pending(false, null)).toBe(false);
    expect(pending(false, 1415)).toBe(false);
  });
});

/**
 * CF-WITHHELD-OUTLIVES-THE-SPINNER (2026-09-08).
 *
 * Six eBay-imported holdings sat on "CHECKING PRICE…" with VALUE "—" and no
 * reason shown, though the engine had already refused to price them and had
 * written `no-checklist-match` to every row. The spinner was masking a
 * verdict that existed. These pin the precedence.
 */
describe("showsCheckingPrice — the spinner never masks a decided row", () => {
  // The incident's shape, as stored on the six holdings.
  const w: WithheldBlock = {
    reason: "no-checklist-match",
    blockingId: "hiq:baseball:2005:bowman-chrome:bdp129:base:no-auto",
    blockingCount: 1,
    proposed: null,
    retained: null,
    retentionRefused: "no-prior-value",
  };

  it("does NOT show the spinner over a withheld row, even mid-run", () => {
    // The incident, exactly: run in flight, no value, but a reason exists.
    // The reason must win — it is an answer, the spinner is only a promise.
    expect(showsCheckingPrice({ repricing: true, value: null, withheld: w })).toBe(false);
  });

  it("shows the spinner on an undecided valueless row mid-run", () => {
    // No verdict of any kind: "we are looking" is the honest claim here.
    expect(showsCheckingPrice({ repricing: true, value: null, withheld: null })).toBe(true);
  });

  it("never shows the spinner over a published price", () => {
    // A working portfolio must not look broken for the ~40s a run takes.
    expect(showsCheckingPrice({ repricing: true, value: 259, withheld: null })).toBe(false);
  });

  it("shows nothing when no run is in flight", () => {
    expect(showsCheckingPrice({ repricing: false, value: null, withheld: null })).toBe(false);
    expect(showsCheckingPrice({ repricing: false, value: null, withheld: w })).toBe(false);
  });

  it("holds for every withheld reason, not just the incident's", () => {
    const reasons: WithheldBlock["reason"][] = [
      "cost-basis-floor",
      "no-checklist-match",
      "identity-not-in-catalog",
      "pool-migrating",
      "no-exact-pool",
      "ladder-timeout",
    ];
    for (const reason of reasons) {
      expect(showsCheckingPrice({ repricing: true, value: null, withheld: { ...w, reason } })).toBe(
        false,
      );
    }
  });
});
