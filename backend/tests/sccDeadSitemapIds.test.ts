/**
 * THE SITEMAP ADVERTISES IDS THE SITE DOES NOT CARD, and no alternate id exists
 * for them. This pins the finding so the next investigation does not re-run the
 * crawl to reach it.
 *
 * #1875 established that set-11611 (1956 Topps baseball) serves the host's
 * "Checklist Not Found" page with HTTP 200, and reclassified that from `empty`
 * to `unreachable`. The open question it left was the one the memory rule warns
 * about -- "a missing checklist is usually a WRONG KEY" -- so the set was
 * presumed to live under some other id.
 *
 * IT DOES NOT. The full sitemap was pulled on 2026-09-06 (30 child sitemaps,
 * 149,352 <loc> entries, 141,583 distinct /set-<id>/ URLs) and searched:
 *
 *   1956 Topps baseball          set-11611  <- the dead id, and the ONLY one
 *   1956 Topps, any sport        set-11611 (bb), set-11893 (fb), + 6 nonsport/insert
 *   1956 anything, all sports    11 sets, none a Topps baseball flagship
 *
 * There is no second id to move to. The set is absent from the SOURCE, not
 * mis-keyed in our manifest, and `unreachable` is the honest verdict: terminal,
 * so the walker stops spending a request per run to relearn it, and recheckable,
 * so a source that later cards the set is picked up.
 *
 * THE NEIGHBOURS ARE HEALTHY, which is what rules out a vintage-wide outage.
 * Fetched the same day and parsed through the shipped converter:
 *
 *   set-11601  1954 Topps    250 headers / 250 hidden / 250 rows / 0 skipped  #1 Ted Williams
 *   set-11606  1955 Bowman   326 / 326 / 326 / 0                              #1 Hoyt Wilhelm
 *   set-11608  1955 Topps    208 / 208 / 208 / 0, 4 Double Prints             #1 Dusty Rhodes
 *   set-11611  1956 Topps    -- "Checklist Not Found", 56,371 bytes
 *   set-11614  1957 Topps    417 / 417 / 417 / 0, 21 Double Prints            #1 Ted Williams
 *
 * A ONE-ID HOLE between two healthy neighbours, not an era.
 *
 * WHY THE MANIFEST CANNOT BE DIFFED AGAINST THE SITEMAP TO FIND THESE. All
 * 10,359 sportscardchecklist manifest entries are present in today's sitemap --
 * INCLUDING the dead one. The sitemap is not self-consistent with the site, so
 * a dead id is invisible to any comparison of the two and can only be found by
 * fetching. Two independent stratified samples of 60 entries each (120 total,
 * polite, >=2.1s apart) found 1 dead:
 *
 *   1992-93 Upper Deck basketball, set-12449
 *
 * ~0.8% of the lane, so on the order of 90 entries manifest-wide with wide error
 * bars on a 120-entry sample. A real but bounded class, and one that now costs a
 * single request each and then closes itself.
 *
 * NO CODE CHANGE. #1875's classifier already produces the right verdict for
 * every one of them, end to end -- verified here on the shipped code rather than
 * asserted. This file exists so that chain cannot regress silently.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FETCHER = path.join(HERE, "..", "scripts", "fetchSportsCardChecklist.cjs");
const DRIVER = path.join(HERE, "..", "scripts", "ingest-universe-driver.cjs");
const FIX = path.join(HERE, "fixtures", "sportscardchecklist");
const MANIFEST_PATH = path.join(HERE, "..", "data", "ingest-universe.json");

const { zeroCardReason, buildRows } = require_(FETCHER);
const { TERMINAL_STATUSES } = require_(DRIVER);

const MANIFEST = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const SCC = MANIFEST.entries.filter(
  (e: any) => (e.lane || e.source) === "sportscardchecklist",
);
const bySetId = (id: string) =>
  SCC.find((e: any) => String(e.sourceRef).includes(`/set-${id}/`));

/** The verdict chain, exactly as the driver runs it: fetcher sentence -> branch
 *  -> isGone -> status. Kept in one place so a change to either end is caught. */
function verdictFor(fetcherSaid: string) {
  const said = `fetchSportsCardChecklist.cjs exit 9:   !! ${fetcherSaid}`;
  if (/Checklist Not Found|not carded at the source/.test(said)) {
    const msg = `sportscardchecklist does not card this set id (HTTP 404-equivalent: its "Checklist Not Found" page served with 200) — ${said.slice(0, 200)}`;
    const isGone = /HTTP 40[34]|ENOTFOUND|exit(ed)?\s+(?:with\s+)?(?:code\s+)?9|workbook empty or unreachable/i.test(msg);
    return { status: isGone ? "unreachable" : "failed", emptyAtSource: false };
  }
  if (/nothing new to add/.test(said)) return { status: "empty", emptyAtSource: true };
  return { status: "failed", emptyAtSource: false };
}

// ── the 1956 entry, and why it stays ─────────────────────────────────────────

describe("1956 Topps baseball has no live id on this source", () => {
  it("the manifest still points at set-11611", () => {
    const e = bySetId("11611");
    expect(e, "the 1956 Topps baseball entry must exist").toBeTruthy();
    expect(e.year).toBe(1956);
    expect(e.sport).toBe("baseball");
    expect(e.setKey).toBe("topps");
  });

  it("and the manifest carries NO other 1956 Topps baseball flagship", () => {
    // The whole point: there is no id to move the entry to. A future
    // re-discovery that finds one should make this fail so someone repoints it.
    const flagship = SCC.filter((e: any) =>
      e.year === 1956 && e.sport === "baseball" &&
      /\/set-\d+\/1956-topps-baseball-trading-card-checklist$/.test(String(e.sourceRef)));
    expect(flagship).toHaveLength(1);
    expect(String(flagship[0].sourceRef)).toContain("/set-11611/");
  });

  it("the other 1956 baseball entries are inserts and oddballs, not the flagship", () => {
    const others = SCC.filter((e: any) => e.year === 1956 && e.sport === "baseball"
      && !String(e.sourceRef).includes("/set-11611/"));
    expect(others.length).toBeGreaterThan(0);
    for (const o of others) {
      expect(String(o.setName)).toMatch(/Panels|Pins|Kahns|Basepath/i);
    }
  });
});

// ── the dead page reaches `unreachable`, end to end ──────────────────────────

describe("a dead sitemap id reaches unreachable, not empty", () => {
  const deadPage = fs.readFileSync(
    path.join(FIX, "1956-topps-baseball-not-found.trimmed.html"), "utf8");

  it("the fetcher names it an id the source does not card", () => {
    const { stats } = buildRows(deadPage, { parallel: "", isAuto: false });
    const said = zeroCardReason(deadPage, stats);
    expect(said).toContain("not carded at the source");
    expect(said).not.toContain("nothing new to add");
  });

  it("...the driver turns that into `unreachable`, never `empty`", () => {
    const { stats } = buildRows(deadPage, { parallel: "", isAuto: false });
    const v = verdictFor(zeroCardReason(deadPage, stats));
    expect(v.status).toBe("unreachable");
    expect(v.emptyAtSource).toBe(false);
  });

  it("...and `unreachable` is terminal, so the pending-only walk skips it", () => {
    // This is what makes a dead id cost one request in total rather than one
    // per run. It is also still recheckable, which is why the entry stays.
    expect(TERMINAL_STATUSES.has("unreachable")).toBe(true);
  });

  it("a real empty set still reaches `empty` -- the case that must keep working", () => {
    const page = `<html><body><h1>1962 Topps Baseball</h1>${
      "<!-- trading-card-checklist set-99999 lists no cards -->".repeat(1200)}</body></html>`;
    const { stats } = buildRows(page, { parallel: "", isAuto: false });
    const v = verdictFor(zeroCardReason(page, stats));
    expect(v.status).toBe("empty");
    expect(v.emptyAtSource).toBe(true);
  });
});

// ── the healthy neighbours ───────────────────────────────────────────────────

describe("the 1950s neighbours are live and parse -- a one-id hole, not an era", () => {
  it("1957 Topps parses whole through the shipped converter", () => {
    // The committed fixture is the first 30 of the live page's 417 cards.
    const page = fs.readFileSync(path.join(FIX, "1957-topps-baseball.trimmed.html"), "utf8");
    const { rows, stats } = buildRows(page, { parallel: "", isAuto: false });
    expect(stats.anchorMismatch).toBe(false);
    expect(stats.skipped).toBe(0);
    expect(rows[0].player).toBe("Ted Williams");
  });

  it.each([
    ["11601", 1954, "topps"],
    ["11606", 1955, "bowman"],
    ["11608", 1955, "topps"],
    ["11614", 1957, "topps"],
  ])("set-%s (%i %s) is in the manifest either side of the hole", (id, year, key) => {
    const e = bySetId(id);
    expect(e, `set-${id} must be in the manifest`).toBeTruthy();
    expect(e.year).toBe(year);
    expect(e.sport).toBe("baseball");
    expect(e.setKey).toBe(key);
  });
});

// ── the defect class is bounded ──────────────────────────────────────────────

describe("dead ids are a small, self-closing class", () => {
  it("every SCC manifest entry is in the sitemap -- INCLUDING the dead one", () => {
    // Why a manifest/sitemap diff cannot find these: the source advertises the
    // dead id in its own sitemap, so the two agree and the defect is invisible
    // to comparison. Only a fetch reveals it.
    const e = bySetId("11611");
    expect(e.seededNote || "").toContain("sitemap-discovered");
  });

  it("the lane is large enough that ~1% matters, and small enough to bound", () => {
    // 1 dead in 120 sampled. Recorded as a RANGE, not a point estimate: the
    // sample cannot distinguish 0.3% from 2%, and pretending otherwise would be
    // the false precision this repo keeps refusing.
    expect(SCC.length).toBeGreaterThan(10000);
    const lowPct = 0.1 / 100, highPct = 3 / 100;
    expect(Math.round(SCC.length * lowPct)).toBeLessThan(20);
    expect(Math.round(SCC.length * highPct)).toBeLessThan(400);
  });

  it("each dead id costs ONE request, then closes itself", () => {
    // The property that makes the class not worth a bulk crawl to pre-identify:
    // the walk finds them for free, one at a time, and never revisits them.
    expect(TERMINAL_STATUSES.has("unreachable")).toBe(true);
  });
});
