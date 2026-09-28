/**
 * CENSUS BACKING -- CELL FROM IDENTITY, NOT STORED FIELDS (2026-09-27).
 *
 * THE DEFECT. The CENSUS_BACKING block classified a sale's backing cell off
 * `stored.sport`/`stored.year`/`stored.setKey` -- and `stored.setKey`
 * (storedIdentity(), scripts/lib/rematch-derive-identity.cjs) is computed
 * FRESH from `row.setName` via `normalizeSetKey(setName, sport?)`, which
 * takes NO YEAR. A pre-1990 Donruss sale's setName "Donruss" therefore
 * normalises to the MODERN spelling `panini-donruss`, while the sale's own
 * `hobbyiqCardId` was minted WITH the year (via `spellForEra`) and correctly
 * says `donruss`. The preload queried, and the lookup map keyed, the WRONG
 * cell -- so a sale with a real, strict-backed catalog row at its own id
 * landed in `panini-donruss`'s (empty) map and was bucketed `noRow`.
 * Measured 2026-09-27: baseball|1987|panini-donruss showed 21,882 unbacked
 * (all noRow) while only 1,122 sales actually carry panini-donruss in
 * hobbyiqCardId.
 *
 * THE FIX. The cell (and the preload query, and the lookup map) is now read
 * off `row.hobbyiqCardId`'s OWN segments, via the repo's own reverse parser
 * (`hic.parseHobbyIqCardId`) -- never `stored`. A NEW, purely informational
 * `storedFieldDrift` counter (bySport/byCell) records how often the id and
 * the setName-derived stored triple disagree, so a heal pass has a
 * worklist; it never influences backedStrict/rowExistsNonStrict/noRow/etc.
 *
 * THIS FILE PINS THREE THINGS A UNIT TEST OF THE PURE HELPERS CANNOT:
 *   1. A sale with a DRIFTED stored setKey but a backed hobbyiqCardId counts
 *      backedStrict (not noRow) -- the cell comes from the id.
 *   2. That same sale bumps storedFieldDrift -- once, per sport and per its
 *      OWN (id-derived) cell.
 *   3. A sale whose stored triple AGREES with its id (the control) never
 *      bumps storedFieldDrift, even though it has no catalog row (noRow).
 *   4. A sale with no hobbyiqCardId at all stays unparseable, and does not
 *      bump storedFieldDrift either (there is no id-side answer to compare).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const backend = join(__dirname, "..");
const SCRIPT = join(backend, "scripts", "rematch-sold-comps.cjs");
const PRELOAD = join(backend, "tests", "fixtures", "census-backing-drift-e2e", "fake-cosmos-backing-drift.cjs");
const DIST_EXISTS = existsSync(join(backend, "dist", "services", "portfolioiq", "parseTitleIdentity.service.js"));
const itIfBuilt = DIST_EXISTS ? it : it.skip;
const TEST_TIMEOUT_MS = 60_000;

function runCensus(opts: { censusOut: string; controlStateFile: string }) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MODE: "census",
    SLOT: "0",
    SLOTS: "32",
    SOURCES: "backing",
    COSMOS_CONNECTION_STRING: "AccountEndpoint=https://fake.invalid:443/;AccountKey=ZmFrZQ==;",
    RUN_MINUTES: "10",
    CENSUS_OUT: opts.censusOut,
    CONTROL_STATE_FILE: opts.controlStateFile,
  };
  return spawnSync(process.execPath, ["-r", PRELOAD, SCRIPT], {
    cwd: backend, env, encoding: "utf8", timeout: TEST_TIMEOUT_MS,
  });
}

describe("rematch-sold-comps.cjs MODE=census SOURCES=backing -- the cell comes from hobbyiqCardId, drift is counted separately", () => {
  const dirs: string[] = [];
  function freshPaths() {
    const dir = mkdtempSync(join(tmpdir(), "census-backing-drift-e2e-"));
    dirs.push(dir);
    return { censusOut: join(dir, "census"), controlStateFile: join(dir, "control-state.json") };
  }
  afterEach(() => {
    while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  itIfBuilt("a drifted-setKey sale with a backed hobbyiqCardId counts backedStrict under the ID's cell, and bumps storedFieldDrift", () => {
    const { censusOut, controlStateFile } = freshPaths();
    const res = runCensus({ censusOut, controlStateFile });
    expect(res.status).toBe(0);

    const artifact = JSON.parse(readFileSync(join(censusOut, "census-slot-0.json"), "utf8"));
    expect(artifact.backing).not.toBeNull();

    // THE FIX ITSELF: the sale's own id (hiq:baseball:1953:donruss:35:...)
    // decides the cell, so its catalog row (also at the donruss cell) is
    // found and counted backedStrict -- never noRow, even though the
    // sale's stored setName "Donruss" would have normalised (era-blind) to
    // "panini-donruss", a DIFFERENT cell with no catalog row at all.
    const donrussCell = artifact.backing.byCell["baseball|1953|donruss"];
    expect(donrussCell).toEqual({
      backedStrict: 1, rowExistsNonStrict: 0, noRow: 0, unparseable: 0,
      parked: 0, notPricedFlagged: 0, unknown: 0,
    });
    // The WRONG (stored-derived) cell was never even queried, let alone
    // populated -- nothing lands there.
    expect(artifact.backing.byCell["baseball|1953|panini-donruss"]).toBeUndefined();

    // THE DRIFT COUNTER: this exact sale is the one whose stored triple
    // (baseball, 1953, panini-donruss) disagrees with its id's own
    // (baseball, 1953, donruss) -- recorded once, under the SALE'S OWN
    // (id-derived) cell, for both bySport and byCell.
    expect(artifact.backing.storedFieldDrift).toBeTruthy();
    expect(artifact.backing.storedFieldDrift.bySport.baseball).toBe(1);
    expect(artifact.backing.storedFieldDrift.byCell["baseball|1953|donruss"]).toBe(1);
    expect(artifact.backing.storedFieldDrift.topCells).toEqual([
      { cell: "baseball|1953|donruss", driftedSales: 1 },
    ]);
  }, TEST_TIMEOUT_MS);

  itIfBuilt("a sale whose stored triple AGREES with its id counts noRow and does NOT bump storedFieldDrift (the control)", () => {
    const { censusOut, controlStateFile } = freshPaths();
    const res = runCensus({ censusOut, controlStateFile });
    expect(res.status).toBe(0);

    const artifact = JSON.parse(readFileSync(join(censusOut, "census-slot-0.json"), "utf8"));
    const toppsCell = artifact.backing.byCell["baseball|1953|topps"];
    // d2 (topps, agrees, no catalog row) and d3 (topps, no id at all) share
    // this cell key on the ARTIFACT's byCell table -- d3 falls back to its
    // OWN stored fields for bucketing (there is no id to prefer), landing
    // in the same "baseball|1953|topps" cell as d2's noRow, but counted
    // unparseable instead.
    expect(toppsCell).toEqual({
      backedStrict: 0, rowExistsNonStrict: 0, noRow: 1, unparseable: 1,
      parked: 0, notPricedFlagged: 0, unknown: 0,
    });

    // d2 agrees (setName "Topps" normalises to "topps", matching its id) --
    // it must NOT be counted as drift. d3 has no hobbyiqCardId at all -- no
    // id-side answer exists to disagree with `stored`, so it must not be
    // counted as drift either. storedFieldDrift's total stays exactly 1
    // (only d1, pinned by the sibling test above), never 2 or 3.
    expect(artifact.backing.storedFieldDrift.bySport.baseball).toBe(1);
  }, TEST_TIMEOUT_MS);

  itIfBuilt("a sale with no hobbyiqCardId stays unparseable and is excluded from storedFieldDrift", () => {
    const { censusOut, controlStateFile } = freshPaths();
    const res = runCensus({ censusOut, controlStateFile });
    expect(res.status).toBe(0);

    const artifact = JSON.parse(readFileSync(join(censusOut, "census-slot-0.json"), "utf8"));
    // d3's own contribution: unparseable, counted at the sport level too.
    expect(artifact.backing.bySport.baseball.unparseable).toBe(1);
  }, TEST_TIMEOUT_MS);
});
