/**
 * CF-LASTSALE-SCAFFOLD (2026-06-10) — pickLastSale unit tests.
 *
 * The picker operates on a RawComp[] pool that comptueEstimate sources
 * from `fetched.comps` — already post-(selectSalesByGrade →
 * filterRecordsByParallel) per CF-FACTPACK-SUB-MARKET-ISOLATION +
 * CF-FILTER-CONSOLIDATION. By construction the picker inherits sub-
 * market isolation: if the caller filters the input by parallel /
 * grade BEFORE handing it in, the picked record is from the filtered
 * pool.
 *
 * Tests:
 *  1) Parallel scoping — when the input is the parallel-filtered pool,
 *     the pick is from the parallel pool. (Property of the input, not
 *     the picker — covered by passing pre-filtered records.)
 *  2) Null-parallel exclusion — the picker has no awareness of
 *     parallel_id; the filtering is done upstream. Test that with a
 *     base-only pool the pick is base.
 *  3) Older-than-14d sale present + no recent → pick survives (the
 *     unwindowed-by-construction property).
 *  4) Same-record invariant — newestTs derived from the picked record
 *     matches the picked record's soldDate (timestamps consistent).
 */
import { describe, it, expect } from "vitest";
import { pickLastSale } from "../src/services/compiq/compiqEstimate.service";

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function comp(
  price: number,
  soldDateOrDaysAgo: string | number,
  opts: { title?: string; listingType?: "fixed" | "auction" | null; imageUrl?: string | null } = {},
) {
  const soldDate =
    typeof soldDateOrDaysAgo === "number" ? isoDaysAgo(soldDateOrDaysAgo) : soldDateOrDaysAgo;
  return {
    price,
    title: opts.title ?? "x",
    soldDate,
    listingType: opts.listingType ?? "fixed",
    imageUrl: opts.imageUrl ?? null,
  };
}

describe("pickLastSale", () => {
  it("(1) parallel scoping by input — pre-filtered parallel pool → pick from that pool", () => {
    // Simulate computeEstimate: fetched.comps was already filtered by
    // filterRecordsByParallel (CF-FACTPACK-SUB-MARKET-ISOLATION). With
    // a parallel-only input the picker returns a parallel-pool record.
    const parallelPool = [
      comp(1000, 5),
      comp(1100, 2),
      comp(1200, 1, { title: "Gold parallel newest" }),
    ];
    const last = pickLastSale(parallelPool);
    expect(last).not.toBeNull();
    expect(last!.price).toBe(1200);
    expect(last!.title).toBe("Gold parallel newest");
  });

  it("(2) null-parallel exclusion by input — base-only pool → pick is base", () => {
    // Mirror behavior: caller upstream filtered to records WITHOUT a
    // parallel_id. The picker sees only base records and picks the
    // newest base record. No leak of parallel-tagged sales possible
    // because they're not in the input.
    const basePool = [
      comp(400, 5, { title: "base raw 1" }),
      comp(450, 3, { title: "base raw 2 newest" }),
      comp(420, 4, { title: "base raw 3" }),
    ];
    const last = pickLastSale(basePool);
    expect(last).not.toBeNull();
    expect(last!.price).toBe(450);
    expect(last!.title).toBe("base raw 2 newest");
  });

  it("(3) older-than-14d sale present + nothing within the 14d window → pick survives (unwindowed)", () => {
    // The price-by-id Market Read fact pack windows at 14 days; the
    // lastSale picker does NOT window. Even when every sale is older
    // than 14d, the picker still returns the most-recent record so
    // iOS can render "last sold $X, N ago" instead of an empty screen.
    const oldOnly = [
      comp(95, 45, { title: "way old" }),
      comp(110, 30, { title: "old" }),
      comp(105, 21, { title: "still outside window" }),
    ];
    const last = pickLastSale(oldOnly);
    expect(last).not.toBeNull();
    expect(last!.price).toBe(105);
    expect(last!.title).toBe("still outside window");
    const ageDays = Math.floor((Date.now() - Date.parse(last!.soldDate)) / (24 * 3600 * 1000));
    expect(ageDays).toBeGreaterThanOrEqual(20); // older than the 14d window
  });

  it("(4) same-record invariant — picked record's soldDate IS the max timestamp in the pool", () => {
    // The brief requires lastSale + daysSinceNewestComp derive from the
    // SAME record. computeEstimate now does this by picking once and
    // deriving both from the pick. Verify the picker's contract: the
    // returned record's soldDate is the maximum parseable timestamp in
    // the pool — there is no second reduce that could pick a different
    // record on a tie.
    const pool = [
      comp(100, 10),
      comp(200, 7),
      comp(300, 3, { title: "real newest" }),
      comp(150, 4),
      comp(250, 5),
    ];
    const last = pickLastSale(pool);
    expect(last).not.toBeNull();
    const lastTs = Date.parse(last!.soldDate);
    const maxTs = Math.max(
      ...pool.map((c) => Date.parse(c.soldDate)).filter((t) => Number.isFinite(t)),
    );
    expect(lastTs).toBe(maxTs);
    expect(last!.title).toBe("real newest");
  });

  it("returns null when no record has a parseable, positive soldDate", () => {
    const garbage = [
      { price: 100, title: "x", soldDate: "", listingType: "fixed", imageUrl: null },
      { price: 200, title: "y", soldDate: "not-a-date", listingType: "auction", imageUrl: null },
    ];
    expect(pickLastSale(garbage)).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(pickLastSale([])).toBeNull();
  });

  it("listingType passes through {fixed, auction}; anything else normalized to null", () => {
    const onlyFixed = [comp(100, 3, { listingType: "fixed" })];
    expect(pickLastSale(onlyFixed)!.listingType).toBe("fixed");

    const onlyAuction = [comp(200, 2, { listingType: "auction" })];
    expect(pickLastSale(onlyAuction)!.listingType).toBe("auction");

    // Garbage listingType (off-spec wire value) → normalized to null.
    const garbageType = [
      { price: 100, title: "x", soldDate: isoDaysAgo(1), listingType: "buy-it-later" as unknown as null, imageUrl: null },
    ];
    expect(pickLastSale(garbageType)!.listingType).toBeNull();
  });

  it("imageUrl + title pass through when present; null when absent", () => {
    const pool = [
      { price: 100, title: "with image", soldDate: isoDaysAgo(2), listingType: "fixed" as const, imageUrl: "https://example/img.jpg" },
      { price: 200, title: "newest no image", soldDate: isoDaysAgo(1), listingType: "fixed" as const, imageUrl: null },
    ];
    const last = pickLastSale(pool);
    expect(last!.title).toBe("newest no image");
    expect(last!.imageUrl).toBeNull();

    const olderHasImage = pickLastSale([pool[0]]);
    expect(olderHasImage!.imageUrl).toBe("https://example/img.jpg");
  });
});
