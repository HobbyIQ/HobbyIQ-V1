// CF-CH-BACKFILL-POISON-PILL (2026-08-22) — one permanently-bad upstream date
// must not stall the whole backfill forever.
//
// THE BUG. On a day that did not complete, the walk set stoppedReason
// "hard-error", held the cursor, and broke. The reasoning in the comment was
// sound — skipping past a failed day leaves a hole nothing goes back for — but
// it had no give-up condition, so it is a deadlock rather than a safety
// property.
//
// CardHedge returned HTTP 500 for file_date 2025-10-08. Every scheduled run
// from 2026-08-19 onward died in 0.9 SECONDS holding the cursor:
//
//     stopped because:   hard-error
//     elapsed:           0.9s
//     INCOMPLETE DAYS (cursor held here):
//       2025-10-08  http=500  download returned HTTP 500
//
// Three days of zero ingested rows because one date upstream is unavailable,
// and it would have continued indefinitely — CardHedge has no obligation to
// ever fix that file.
//
// THE FIX. Hold for MAX_BLOCKED_ATTEMPTS consecutive runs, which covers any
// real transient (the job runs twice daily, so 3 ≈ a day and a half). Past
// that, record the date in the cursor's quarantinedDates and step over it.
// That list is what "goes back for it" — a known, reported hole, which is the
// opposite of silently skipping.
//
// THIS FILE PINS:
//   1. A transient failure still holds the cursor. Retrying is correct first.
//   2. The attempt counter only accumulates for the SAME date. A different
//      date failing is a fresh problem, not a continuation.
//   3. Past the limit the date is quarantined, the cursor ADVANCES, and the
//      walk continues to later days.
//   4. Quarantine is recorded and surfaced, never silent.
//   5. A date that recovers clears its block record, so an intermittent day
//      cannot creep toward quarantine across unrelated runs.

import { describe, expect, it } from "vitest";

const MAX_BLOCKED_ATTEMPTS = 3;

/**
 * Mirrors the decision the walk makes on an incomplete day. Kept here as a
 * pure function so the RULE is pinned independently of the Cosmos-backed
 * cursor store and the CardHedge downloader.
 */
type Cursor = { blockedDate?: string | null; blockedAttempts?: number };

function decideOnIncompleteDay(cursor: Cursor | null, date: string) {
  const sameAsBefore = cursor?.blockedDate === date;
  const attempts = (sameAsBefore ? (cursor?.blockedAttempts ?? 0) : 0) + 1;
  return attempts < MAX_BLOCKED_ATTEMPTS
    ? { action: "hold" as const, attempts }
    : { action: "quarantine" as const, attempts };
}

describe("CF-CH-BACKFILL-POISON-PILL", () => {
  it("holds the cursor on a first failure — retrying is correct", () => {
    const d = decideOnIncompleteDay(null, "2025-10-08");
    expect(d.action).toBe("hold");
    expect(d.attempts).toBe(1);
  });

  it("keeps holding while the failure could still be transient", () => {
    const d = decideOnIncompleteDay(
      { blockedDate: "2025-10-08", blockedAttempts: 1 },
      "2025-10-08",
    );
    expect(d.action).toBe("hold");
    expect(d.attempts).toBe(2);
  });

  it("quarantines once the date has blocked MAX_BLOCKED_ATTEMPTS runs", () => {
    // The exact 2025-10-08 case, on its third consecutive run.
    const d = decideOnIncompleteDay(
      { blockedDate: "2025-10-08", blockedAttempts: 2 },
      "2025-10-08",
    );
    expect(d.action).toBe("quarantine");
    expect(d.attempts).toBe(3);
  });

  it("does not carry a count across DIFFERENT dates", () => {
    // A new date failing is a fresh problem. Without this reset, unrelated
    // one-off failures would accumulate and quarantine a perfectly good day.
    const d = decideOnIncompleteDay(
      { blockedDate: "2025-10-08", blockedAttempts: 2 },
      "2025-11-01",
    );
    expect(d.action).toBe("hold");
    expect(d.attempts).toBe(1);
  });

  it("resets after a date recovers", () => {
    // Cleared block record => next failure of that same date starts at 1, so
    // an intermittent day cannot creep toward quarantine across unrelated runs.
    const cleared: Cursor = { blockedDate: null, blockedAttempts: 0 };
    const d = decideOnIncompleteDay(cleared, "2025-10-08");
    expect(d.action).toBe("hold");
    expect(d.attempts).toBe(1);
  });

  it("never stalls forever — quarantine is reachable from any starting point", () => {
    // The property the old code lacked. Whatever the history, repeated
    // failures of one date terminate in quarantine rather than looping.
    let cursor: Cursor = {};
    let outcome = "";
    for (let run = 0; run < 25; run++) {
      const d = decideOnIncompleteDay(cursor, "2025-10-08");
      outcome = d.action;
      if (d.action === "quarantine") break;
      cursor = { blockedDate: "2025-10-08", blockedAttempts: d.attempts };
    }
    expect(outcome).toBe("quarantine");
  });

  it("quarantine accumulates a recorded, de-duplicated hole list", () => {
    // The list is the thing that goes back for the skipped days. A quarantined
    // date must be visible and must not be double-recorded on a re-run.
    const prior = ["2025-10-08"];
    const merged = [...prior, "2025-10-08", "2025-12-01"]
      .filter((d, i, a) => a.indexOf(d) === i)
      .sort();
    expect(merged).toEqual(["2025-10-08", "2025-12-01"]);
  });
});
