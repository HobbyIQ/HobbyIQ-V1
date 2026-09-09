// CF-A-COUNTER-NOBODY-CAN-READ-IS-NOT-A-COUNTER (#2006 follow-up, 2026-09-08).
//
// `skippedSportUnresolved` counts the rows that CF-NO-DEFAULT-SPORT parks: the
// vertical could not be resolved, so the slug has no first segment, so the row
// has no address and never enters a pool. It is the number that says whether a
// feed is landing at all.
//
// It was a function-LOCAL counter in persistVendorSalesToPool. It never
// reached VendorPersistResult, so no caller could read it, and it was logged
// only when `inserted + deduped + catalogUnmatched > 0` -- so a batch in which
// EVERY row was unresolved printed nothing whatsoever. That is exactly the
// shape of the first live TCGplayer batches: 3,898 of 12,000 rows silently
// dropped, and the logs showed a clean run.
//
// SUBSET, NOT SIBLING. These rows are also counted in `skipped`. A reconcile
// of the form `fetched = written + skipped + ... ` must NOT add this term as
// well -- doing so double-counts and drives `unaccounted` NEGATIVE, which
// looks like a missing outcome but is an invented one. This file pins both
// halves: the counter is reachable, and the identity still balances.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { VendorPersistResult } from "../src/services/portfolioiq/persistVendorSalesToPool.service.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.join(here, "..", "src", "services", "portfolioiq", "persistVendorSalesToPool.service.ts");
const FIREHOSE = path.join(here, "..", "scripts", "tca-firehose-ingest.cjs");

describe("skippedSportUnresolved reaches the caller", () => {
  it("is a declared field on VendorPersistResult", () => {
    // Type-level: this does not compile if the field is absent, which is the
    // regression being pinned.
    const r: VendorPersistResult = {
      inserted: 0, deduped: 0, skipped: 0, errors: 0, catalogUnmatched: 0,
      skippedSportUnresolved: 0,
    };
    expect(r.skippedSportUnresolved).toBe(0);
  });

  it("is initialised on the result object, not left undefined", () => {
    const src = readFileSync(SERVICE, "utf8");
    const init = src.match(/const result: VendorPersistResult = \{[^}]*\}/s)?.[0] ?? "";
    expect(init).toContain("skippedSportUnresolved: 0");
  });

  it("is written to the result at the skip site, beside result.skipped", () => {
    const src = readFileSync(SERVICE, "utf8");
    // The two must move together: the row is counted in `skipped` AND broken
    // out here. If a future edit increments only the local, the counter goes
    // back to being unreadable.
    expect(src).toMatch(/result\.skipped\+\+;[\s\S]{0,400}?result\.skippedSportUnresolved = skippedSportUnresolved;/);
  });
});

describe("an all-unresolved batch still logs", () => {
  it("the reconcile log fires on EVERY batch — there is no condition left to widen", () => {
    // This test used to require the emit predicate to contain
    // `skippedSportUnresolved > 0`, pinning the #2006 widening that admitted
    // all-unresolved batches. That widening was necessary and insufficient:
    // run 34262947046's TCGplayer lane skipped 25,991 rows at the year and
    // player gates, which set none of the predicate's four terms, and logged
    // nothing across 26 pages.
    //
    // The predicate is now GONE rather than widened again, so the assertion
    // becomes the stronger one it was always reaching for: a batch that ran
    // reports, whatever happened in it. Pinning the old substring here would
    // now pin the bug.
    const src = readFileSync(SERVICE, "utf8");
    const guarded = /if \([^)]*\)\s*\{\s*console\.log\(JSON\.stringify\(\{\s*event: "persist_vendor_sales"/;
    expect(guarded.test(src), "the persist_vendor_sales emit must not sit behind a condition").toBe(false);
    expect(src).toMatch(/\{\s*console\.log\(JSON\.stringify\(\{\s*event: "persist_vendor_sales"/);
  });

  it("the logged payload carries the counter", () => {
    const src = readFileSync(SERVICE, "utf8");
    const block = src.slice(src.indexOf('event: "persist_vendor_sales"'));
    expect(block.slice(0, 600)).toContain("skippedSportUnresolved,");
  });

  it("the logged payload names the OTHER skip reasons too", () => {
    // CF-A-SKIP-MUST-SAY-WHY. The year and player gates are the two that ate
    // the first TCGplayer day; a payload that reports a bare `skipped` cannot
    // tell that from a quiet feed.
    const src = readFileSync(SERVICE, "utf8");
    const block = src.slice(src.indexOf('event: "persist_vendor_sales"')).slice(0, 900);
    expect(block).toContain("skippedNoYear");
    expect(block).toContain("skippedNoPlayer");
  });

  it("the year and player gates each increment their own named counter", () => {
    const src = readFileSync(SERVICE, "utf8");
    expect(src).toMatch(/if \(!cardYear\) \{ result\.skipped\+\+; result\.skippedNoYear/);
    expect(src).toMatch(/if \(!playerName\) \{ result\.skipped\+\+; result\.skippedNoPlayer/);
  });
});

describe("the firehose reconcile counts it without double-counting", () => {
  const src = readFileSync(FIREHOSE, "utf8");

  it("accumulates the counter off the persist result", () => {
    expect(src).toContain("totalSkippedSportUnresolved += res.skippedSportUnresolved ?? 0;");
  });

  it("reports it in the reconcile output", () => {
    expect(src).toContain("skippedSportUnresolved=${totalSkippedSportUnresolved}");
  });

  it("does NOT add it into the accountedFor identity", () => {
    // The load-bearing assertion. `res.skipped` already includes these rows
    // (the service increments both), and this script folds `res.skipped` into
    // totalDedupSkipped -- so adding the breakdown term as well would make
    // `unaccounted` go negative on every run with unresolved rows.
    const accounted = src.match(/const accountedFor =[\s\S]*?;/)?.[0] ?? "";
    expect(accounted, "accountedFor must not sum the breakdown term").not.toContain("totalSkippedSportUnresolved");
    expect(accounted).toContain("totalDedupSkipped");
  });
});

describe("the reconcile identity balances arithmetically", () => {
  // A worked example with the real 2026-09-07 TCGplayer shape: 12,000 fetched,
  // of which 3,898 had no resolvable vertical. Those 3,898 land in `skipped`
  // AND in `skippedSportUnresolved`.
  const fetched = 12_000;
  const written = 6_000;
  const skippedSportUnresolved = 3_898;
  const otherSkipped = 1_500;
  const skipped = otherSkipped + skippedSportUnresolved; // as the service counts it
  const catalogUnmatched = 400;
  const twinFolded = 120;
  const twinRefused = 80;
  const errors = 2;

  it("balances to zero unaccounted when the breakdown is NOT summed", () => {
    const accountedFor = written + skipped + catalogUnmatched + twinFolded + twinRefused + errors;
    expect(fetched - accountedFor).toBe(0);
  });

  it("goes NEGATIVE if the breakdown term is wrongly added — the bug this pins", () => {
    const wrong = written + skipped + catalogUnmatched + twinFolded + twinRefused +
      skippedSportUnresolved + errors;
    expect(fetched - wrong).toBe(-skippedSportUnresolved);
    expect(fetched - wrong).toBeLessThan(0);
  });
});
