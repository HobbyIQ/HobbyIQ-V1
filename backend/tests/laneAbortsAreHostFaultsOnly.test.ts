import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const HERE = path.join(__dirname, "..", "scripts");
const driver = path.join(HERE, "ingest-universe-driver.cjs");
const scraper = path.join(HERE, "scrape-bcp-ladders.cjs");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { streakAfter, gateStagedEntry } = require(driver);

/**
 * PIN — THE STREAK MAY CONCLUDE EXACTLY ONE THING: THE HOST IS DOWN.
 *
 * Two full-lane applies on 2026-09-04 aborted on a 3-streak built almost
 * entirely out of verdicts we could only have reached by successfully fetching
 * and parsing the page:
 *
 *   scc  33870669723  intended 198, 176 unattempted. Entries 20-21-22 were
 *        REFUSED(zero base) / FAILED(green ingest, 0 landed) / REFUSED(zero
 *        base) -- the "...Refractors" half of each 2000-01 Topps Chrome subset
 *        pair, which correctly has no base cards of its own.
 *   bcp  33869931267  intended 119, aborted on parser-gap / green-ingest /
 *        short-ingest.
 *
 * #1735 drew the line for hobbymonitor. These are the same line, on two more
 * lanes, and they are pinned as BEHAVIOUR (streakAfter over a real gate result)
 * rather than as a source-text match, so deleting the flag reddens the test.
 */
describe("a per-entry answer never votes the lane down", () => {
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "hiq-lane-pin-"));
  const write = (name: string, rows: string[]) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, ["category,cardNumber,parallel,isAuto,printRun,player", ...rows].join("\n"));
    return p;
  };

  it("zero-base is a CONTENT refusal — it proves the lane is up and resets the streak", () => {
    // The exact shape of scc entry [10/198]: a Refractors-only subset page.
    const csv = write("refractors-only.csv", [
      "base,1,Refractor,false,,Kobe Bryant",
      "base,2,Refractor,false,,Tim Duncan",
      "base,3,Refractor,false,,Kevin Garnett",
    ]);
    const gate = gateStagedEntry([csv], "sportscardchecklist");
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/zero base cards/);
    // THE FLAG. Before the fix this return set no `contentRefusal` at all, so
    // `laneProvenHealthy` was false and the refusal advanced the streak.
    expect(gate.contentRefusal).toBe(true);

    // And through the tripwire's own arithmetic: two of these in a row do not
    // build a streak, because each one reset it.
    const verdict = { status: "failed", laneProvenHealthy: gate.contentRefusal === true };
    expect(streakAfter(0, verdict)).toBe(0);
    expect(streakAfter(2, verdict)).toBe(0);
  });

  it("the scc abort sequence 20-21-22 no longer reaches the tripwire", () => {
    const zeroBase = { status: "failed", laneProvenHealthy: true };   // REFUSED — zero base cards
    const greenZero = { status: "failed", laneProvenHealthy: true };  // FAILED — green ingest, 0 landed
    let streak = 0;
    for (const v of [zeroBase, greenZero, zeroBase]) streak = streakAfter(streak, v);
    expect(streak).toBe(0);
  });

  it("a missing staged file is NOT a content refusal — a broken pipe still trips", () => {
    // The one refusal that means acquisition delivered nothing. It must keep
    // its vote, or a genuinely dead lane runs to the end of its budget.
    const gate = gateStagedEntry([], "bcp");
    expect(gate.ok).toBe(false);
    expect(gate.contentRefusal).toBe(false);
    expect(streakAfter(2, { status: "failed", laneProvenHealthy: gate.contentRefusal === true })).toBe(3);
  });

  it("a bcp parser gap carries the flag on the thrown error", () => {
    const src = fs.readFileSync(driver, "utf8");
    // The wiki served the page and we read every byte; we simply did not
    // understand a heading level. That is evidence the host is UP.
    expect(src).toMatch(/e\.laneProvenHealthy = true;\s*\n\s*throw e;/);
    // ...and the catch that builds the verdict must carry it through.
    expect(src).toMatch(/\.\.\.\(e\?\.laneProvenHealthy \? \{ laneProvenHealthy: true \} : \{\}\)/);
  });

  it("post-ingest failures are per-entry: the ingest ran, so the host answered", () => {
    const src = fs.readFileSync(driver, "utf8");
    // "green ingest, 0 rows landed" and "cannot verify by read" both sit AFTER
    // a successful fetch, stage and child run.
    expect(src).toMatch(/reason: "ingest reported success but the catalog holds 0 rows for this product"[^\n]*laneProvenHealthy: true/);
    expect(src).toMatch(/reason: "cannot verify by read[^"]*"[^\n]*laneProvenHealthy: true/);
  });

  it("failed and unreachable still advance — the tripwire is not disarmed", () => {
    expect(streakAfter(0, { status: "failed" })).toBe(1);
    expect(streakAfter(2, { status: "unreachable" })).toBe(3);
    // `empty` still neither advances nor resets.
    expect(streakAfter(2, { status: "empty" })).toBe(2);
  });
});

/**
 * PIN — ONE CANONICAL KEY PER PRODUCT, AND THE COUNT READS THE KEY THE CHILD
 * WROTE.
 *
 * `finest -> topps-finest` is a normalizeSetKey alias (#1699). The driver
 * counted `finest` while the child wrote `topps-finest`, so on the whole bcp
 * Finest family the verification read a key the ingest never touches. Measured
 * read-only against prod on 2026-09-04:
 *
 *   2026  finest 0       topps-finest 39,480  (18,876 of them this very run)
 *   2023  finest 628     topps-finest 20,367
 *   2025  finest 2,467   topps-finest 91,015
 */
describe("the catalog is read with the key the ingest writes", () => {
  it("the driver resolves its count key through normalizeSetKey — at BOTH read sites", () => {
    const src = fs.readFileSync(driver, "utf8");
    // BOTH, counted. countCatalogRows and catalogIdentities each read the
    // catalog for this entry, and a key resolved in one but not the other puts
    // the count and the identity diff on different products -- which is the
    // defect, restated. A `toMatch` passes on either one alone, so the pin is
    // the COUNT.
    //
    // CF-THE-CHILD-MAY-WRITE-EITHER-KEY (2026-09-04) widened the resolution
    // from one key to the CANDIDATE LIST, because the child honours a stated
    // manifest setKey verbatim (`m.setKey || normalizeSetKey(m.setName)`) and
    // only normalizes when the manifest omits one. The invariant this pin
    // protects is unchanged and still counted: both read sites resolve the key
    // THE SAME WAY, and neither goes back to the bare slug. Only the name of
    // the resolver moved.
    // THREE, not two. countCatalogRowsBySource is a third read of the same
    // product and it was still on the BARE slug -- no alias resolution at all
    // -- which this pin's own `not.toMatch` was catching all along. It now
    // resolves like the other two, so the count is raised to three.
    expect(src.match(/const keys = setKeyCandidates\(entry\);/g) ?? []).toHaveLength(3);
    // setKeyCandidates is itself built on canonicalSetKey, so the alias table
    // is still consulted -- a candidate list that skipped it would put the two
    // sites back on different products for every aliased key.
    expect(src).toMatch(/const canon = canonicalSetKey\(raw\);/);
    // And no read site may go back to the raw slug alone.
    expect(src).not.toMatch(/const setKey = setKeyFor\(entry\);/);
    expect(src).toMatch(/normalizeSetKey: _normalizeSetKey/);
  });

  it("the bcp scraper emits the canonical key, so one product stages under one name", () => {
    const src = fs.readFileSync(scraper, "utf8");
    expect(src).toMatch(/return canonicalSetKeyOf\(slug\);/);
  });

  it("finest and topps-finest are ONE product to normalizeSetKey", () => {
    // The alias itself, so a vocabulary change that split them again reddens
    // here rather than silently re-staging two spellings.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { normalizeSetKey } = require(path.join(__dirname, "..", "dist/services/portfolioiq/hobbyIqCardId.service.js"));
    expect(normalizeSetKey("finest")).toBe("topps-finest");
    expect(normalizeSetKey("topps-finest")).toBe("topps-finest");
  });
});
