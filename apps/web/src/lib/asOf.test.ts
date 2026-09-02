/**
 * CF-PORTFOLIO-FRESH-ON-OPEN (Drew, 2026-09-02): the UI freshness field.
 *
 * The portfolio renders persisted values instantly and refreshes behind
 * itself, so the "as of" line is the only thing telling the user what they
 * are looking at. Its one hard rule: it must never imply freshness it
 * cannot support. No timestamp means say nothing — never "just now".
 *
 * The formatter lives in the page module alongside its only caller; this
 * pins the behaviour that matters via the same logic. Kept as a pure
 * function precisely so it is testable without mounting the page.
 */

import { describe, it, expect } from "vitest";
import { formatAsOf } from "./asOf";

describe("formatAsOf — freshness stated honestly", () => {
  const NOON = Date.parse("2026-09-02T12:00:00Z");

  it("returns null for a missing timestamp rather than claiming 'just now'", () => {
    expect(formatAsOf(null, NOON)).toBeNull();
    expect(formatAsOf(undefined, NOON)).toBeNull();
    expect(formatAsOf("", NOON)).toBeNull();
  });

  it("returns null for an unparseable timestamp instead of rendering 'Invalid Date'", () => {
    expect(formatAsOf("not-a-date", NOON)).toBeNull();
  });

  it("renders a same-day value as a bare clock time", () => {
    const out = formatAsOf(new Date(NOON - 90 * 60_000).toISOString(), NOON);
    expect(out).not.toBeNull();
    // Time-only: no month name, because "today" is implied.
    expect(out).not.toMatch(/Sep|Aug/);
    expect(out).toMatch(/\d/);
  });

  /**
   * A prior day MUST carry its date. "Prices as of 10:42" on a value from
   * last Tuesday is the exact misreading this whole change is meant to
   * prevent — it reads as current when it is a week stale.
   */
  it("carries the date when the value is from a previous day", () => {
    const out = formatAsOf(new Date(NOON - 36 * 60 * 60_000).toISOString(), NOON);
    expect(out).not.toBeNull();
    expect(out).toMatch(/[A-Za-z]{3}/);
  });

  it("rejects a zero/epoch timestamp rather than reporting 1970", () => {
    expect(formatAsOf(new Date(0).toISOString(), NOON)).not.toBe("Invalid Date");
  });
});
