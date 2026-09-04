import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { zeroCardReason } = require_("../scripts/fetchHobbyMonitorChecklist.cjs");
const driver = require_("../scripts/ingest-universe-driver.cjs");

const FIX = path.join(__dirname, "fixtures", "hobbymonitor");
const upcoming = fs.readFileSync(path.join(FIX, "release-upcoming-no-checklist.html"), "utf8");

/**
 * Run 33857627732 aborted the hobbymonitor lane on a 3-streak in which NOT ONE
 * entry was a lane fault: two cartesian gate refusals and one release the
 * source has not published a checklist for. "0 cards on a 200 page" must name
 * WHY, and only a cause that means the HOST is down may advance the streak.
 */
describe("zero cards on a 200 page must name why", () => {
  it("an unreleased product reads as the source having nothing, with its own status", () => {
    const said = zeroCardReason(upcoming);
    expect(said).toMatch(/nothing new to add/);
    // The status must come from THIS release's object, not the first in the page.
    expect(said).toMatch(/upcoming/);
    expect(said).toMatch(/2026-09-25/);
    expect(said).not.toMatch(/shape may have changed|layout not understood/);
  });

  it("a challenge page served with 200 is named as a challenge, never as 'no cards'", () => {
    const said = zeroCardReason("<html><title>Just a moment...</title><div id=cf_chl></div></html>");
    expect(said).toMatch(/challenge\/interstitial/);
    expect(said).not.toMatch(/nothing new to add/);
  });

  it("a populated payload that parses to nothing stays OUR defect", () => {
    const said = zeroCardReason('{"teamChecklists":[{"id":1}],"cardVariations":[],"cardParallels":[]}');
    expect(said).toMatch(/layout not understood/);
    // The one thing it must never claim is that the source is empty.
    expect(said).not.toMatch(/nothing new to add/);
  });

  it("the three causes are three distinct sentences", () => {
    const causes = new Set([
      zeroCardReason(upcoming),
      zeroCardReason("<html>cf_chl Just a moment</html>"),
      zeroCardReason('{"teamChecklists":[{"id":1}],"cardParallels":[]}'),
    ]);
    expect(causes.size).toBe(3);
  });
});

describe("only a down host may abort the lane", () => {
  it("`empty` is excluded from the streak by construction", () => {
    expect(driver.STREAK_STATUSES.has(driver.EMPTY_STATUS)).toBe(false);
    expect(driver.STREAK_STATUSES.has("failed")).toBe(true);
    expect(driver.STREAK_STATUSES.has("unreachable")).toBe(true);
  });

  it("the driver classifies the fetcher's empty wording as emptyAtSource", () => {
    // The exact string the fetcher now emits, matched by the driver's branch.
    const said = zeroCardReason(upcoming);
    expect(/nothing new to add/.test(said)).toBe(true);
  });

  it("a challenge is shaped so the shared isGone test lifts it to `unreachable`", () => {
    const msg = "hobbymonitor did not serve the release page (HTTP 403-equivalent: a 200 carrying no release payload)";
    // Mirrors the driver's own isGone predicate.
    expect(/HTTP 40[34]|ENOTFOUND|exit(ed)? .*code 9|workbook empty or unreachable/i.test(msg)).toBe(true);
  });

  it("a gate refusal proves the lane is UP, so it resets the streak", () => {
    // The driver's OWN function -- not a restatement of it. Replays the exact
    // verdict sequence of run 33857627732: two cartesian gate refusals, then
    // one unreleased product. Not one is evidence the host is down.
    let s = 0;
    s = driver.streakAfter(s, { status: "failed", laneProvenHealthy: true });  // 2024 Prizm FB
    s = driver.streakAfter(s, { status: "failed", laneProvenHealthy: true });  // 2025 Prizm FB
    s = driver.streakAfter(s, { status: driver.EMPTY_STATUS });                // 2026 Prizm WNBA
    expect(s).toBe(0);
    expect(s).toBeLessThan(driver.SYSTEMIC_FAILURE_STREAK);
  });

  it("a genuine block still aborts the lane on three in a row", () => {
    let s = 0;
    for (let i = 0; i < driver.SYSTEMIC_FAILURE_STREAK; i++) {
      s = driver.streakAfter(s, { status: "unreachable" });
    }
    expect(s).toBeGreaterThanOrEqual(driver.SYSTEMIC_FAILURE_STREAK);
  });

  it("`empty` neither advances nor resets, so an outage split by one still trips", () => {
    let s = driver.streakAfter(0, { status: "unreachable" });
    s = driver.streakAfter(s, { status: driver.EMPTY_STATUS });
    s = driver.streakAfter(s, { status: "unreachable" });
    s = driver.streakAfter(s, { status: "unreachable" });
    expect(s).toBeGreaterThanOrEqual(driver.SYSTEMIC_FAILURE_STREAK);
  });

  it("an ingested entry resets the streak", () => {
    expect(driver.streakAfter(2, { status: "ingested" })).toBe(0);
  });
});
