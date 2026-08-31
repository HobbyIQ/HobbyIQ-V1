// CF-CARD-SAVE-FAST (Drew, 2026-08-31). The edit modal now closes on this
// merge instead of on the server's response, so this function decides what the
// user sees the moment they press Save. What it must never do is claim a value
// the server was not asked to save, or invent a price.

import { describe, it, expect } from "vitest";
import { mergeOptimistic } from "./optimisticHolding";
import type { PortfolioHolding } from "@/lib/api";

const STORED = {
  id: "h-1",
  playerName: "Mookie Betts",
  cardYear: 2020,
  product: "Panini Prizm",
  parallel: "Base",
  cardNumber: "275",
  gradeCompany: "PSA",
  gradeValue: 10,
  quantity: 1,
  notes: "original note",
  // Server-owned, derived. Nothing in this form computes these.
  canonicalFmv: 412.5,
  hobbyiqCardId: "hiq:baseball:2020:panini-prizm:275:base",
} as unknown as PortfolioHolding;

const merged = (patch: Record<string, unknown>) =>
  mergeOptimistic(STORED, patch) as unknown as Record<string, unknown>;

describe("what the user typed shows immediately", () => {
  it("applies an edited field", () => {
    expect(merged({ notes: "new note" }).notes).toBe("new note");
  });

  it("applies several fields at once", () => {
    const out = merged({ parallel: "Silver", cardNumber: "276", quantity: 3 });
    expect(out.parallel).toBe("Silver");
    expect(out.cardNumber).toBe("276");
    expect(out.quantity).toBe(3);
  });

  it("keeps the fields the edit did not mention", () => {
    const out = merged({ notes: "new note" });
    expect(out.playerName).toBe("Mookie Betts");
    expect(out.cardYear).toBe(2020);
  });
});

describe("undefined is 'not sent', null is 'clear it'", () => {
  it("an undefined value leaves the stored value standing", () => {
    // The form builds its patch with `x.trim() || undefined`, so an untouched
    // optional field arrives as undefined. Treating that as a clear would blank
    // fields the user never edited.
    expect(merged({ playerName: undefined }).playerName).toBe("Mookie Betts");
  });

  it("a null value clears the field — the grade going back to Raw", () => {
    const out = merged({ gradeCompany: null, gradeValue: null });
    expect(out.gradeCompany).toBeNull();
    expect(out.gradeValue).toBeNull();
  });

  it("an empty patch changes nothing", () => {
    expect(merged({})).toEqual(STORED);
  });

  it("keeps a legitimately falsy value the user chose", () => {
    // 0 and "" are values, not absences.
    expect(merged({ quantity: 0 }).quantity).toBe(0);
    expect(merged({ notes: "" }).notes).toBe("");
    expect(merged({ isAuto: false }).isAuto).toBe(false);
  });
});

describe("it never invents a price", () => {
  it("passes the stored FMV through untouched", () => {
    // The deferred reprice may move this. The form must not guess at it — a
    // number on screen has to come from the one valuation path, never a merge.
    expect(merged({ parallel: "Gold" }).canonicalFmv).toBe(412.5);
  });

  it("does not derive identity — the catalog rebind is the server's answer", () => {
    const out = merged({ parallel: "Gold", cardNumber: "999" });
    expect(out.hobbyiqCardId).toBe("hiq:baseball:2020:panini-prizm:275:base");
  });

  it("adds no keys beyond the stored shape and the patch", () => {
    const out = merged({ notes: "n" });
    const extra = Object.keys(out).filter(
      (k) => !(k in (STORED as unknown as Record<string, unknown>)),
    );
    expect(extra).toEqual([]);
  });
});

describe("the merge does not mutate its input", () => {
  it("leaves the stored holding alone", () => {
    const before = JSON.stringify(STORED);
    mergeOptimistic(STORED, { notes: "changed" });
    // The caller keeps `holding` to restore on failure; mutating it would make
    // that rollback a no-op.
    expect(JSON.stringify(STORED)).toBe(before);
  });
});
