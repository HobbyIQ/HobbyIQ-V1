/**
 * CENSUS BACKING COUNT -- the end-to-end pin (2026-09-19 census batch).
 *
 * Drives the REAL `main()` of rematch-sold-comps.cjs, MODE=census
 * SOURCES=backing, against a fake card_catalog holding a known cell: 5 sales
 * in (baseball, 1953, topps) -- 1953 is slot 0's OWN measured shard unit,
 * see data/rematch-shard-table.json -- one strict-backed catalog row, one
 * non-strict catalog row, one sale with no catalog row, one sale with no
 * hobbyiqCardId, one parked (identityUnverified) sale.
 *
 * WHAT THIS PROVES THAT A UNIT TEST OF THE PURE HELPERS CANNOT:
 *   1. `SOURCES=backing` actually arms the block (`backing` is present and
 *      non-null in the written census-slot-0.json, `null`/absent otherwise).
 *   2. The FIVE sales are answered from card_catalog queries THAT DO NOT
 *      SCALE WITH SALE COUNT -- never one point read per sale/id, which is
 *      the whole reason this design exists (see CENSUS_BACKING's own comment
 *      on the ~49 RU/point-read finding). The ORDINARY (non-backing)
 *      classify path already issues its own unconditional card_catalog query
 *      per row via `clashSubsetsFor(stored)` -- pre-existing, unrelated to
 *      this change -- so the pin is on the DELTA armed - baseline, which
 *      must be exactly 1 (one extra query, for the whole 5-sale cell), never
 *      on an assumed zero baseline.
 *   3. The bucket a sale lands in matches what its catalog row (or lack of
 *      one) says, including the parked/unparseable carve-outs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const backend = join(__dirname, "..");
const SCRIPT = join(backend, "scripts", "rematch-sold-comps.cjs");
const PRELOAD = join(backend, "tests", "fixtures", "census-backing-e2e", "fake-cosmos-backing.cjs");
const DIST_EXISTS = existsSync(join(backend, "dist", "services", "portfolioiq", "parseTitleIdentity.service.js"));
const itIfBuilt = DIST_EXISTS ? it : it.skip;
const TEST_TIMEOUT_MS = 60_000;

function runCensus(opts: { censusOut: string; controlStateFile: string; sources?: string }) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MODE: "census",
    SLOT: "0",
    SLOTS: "32",
    COSMOS_CONNECTION_STRING: "AccountEndpoint=https://fake.invalid:443/;AccountKey=ZmFrZQ==;",
    RUN_MINUTES: "10",
    CENSUS_OUT: opts.censusOut,
    CONTROL_STATE_FILE: opts.controlStateFile,
  };
  if (opts.sources !== undefined) env.SOURCES = opts.sources;
  else delete env.SOURCES;
  return spawnSync(process.execPath, ["-r", PRELOAD, SCRIPT], {
    cwd: backend, env, encoding: "utf8", timeout: TEST_TIMEOUT_MS,
  });
}

describe("rematch-sold-comps.cjs MODE=census SOURCES=backing -- end to end against a real card_catalog read", () => {
  const dirs: string[] = [];
  function freshPaths() {
    const dir = mkdtempSync(join(tmpdir(), "census-backing-e2e-"));
    dirs.push(dir);
    return { censusOut: join(dir, "census"), controlStateFile: join(dir, "control-state.json") };
  }
  afterEach(() => {
    while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  itIfBuilt("baseline (no SOURCES=backing): the pre-existing clashSubsetsFor query fires once, `backing` is null", () => {
    const { censusOut, controlStateFile } = freshPaths();
    const res = runCensus({ censusOut, controlStateFile }); // SOURCES unset
    expect(res.status).toBe(0);
    const out = res.stdout ?? "";

    const m = /FAKE_CATALOG_QUERY_COUNT (\d+)/.exec(out);
    expect(m).not.toBeNull();
    // The ordinary classify path's OWN unconditional card_catalog query
    // (clashSubsetsFor(stored), pre-existing and unrelated to this PR) fires
    // once per (year, setKey, sport) product -- all 5 sales share one, so
    // this baseline is 1, not 0. The NEXT test's job is proving backing adds
    // exactly one more, not that the total is zero.
    expect(Number(m![1])).toBe(1);

    const artifact = JSON.parse(readFileSync(join(censusOut, "census-slot-0.json"), "utf8"));
    expect(artifact.backing).toBeNull();
  });

  itIfBuilt("SOURCES=backing adds exactly ONE more catalog query (the cell preload) for all 5 sales, and writes a populated `backing` block", () => {
    const base = freshPaths();
    const baseline = runCensus(base);
    const baselineQueries = Number(/FAKE_CATALOG_QUERY_COUNT (\d+)/.exec(baseline.stdout ?? "")?.[1] ?? NaN);
    expect(Number.isFinite(baselineQueries)).toBe(true);

    const armed = freshPaths();
    const res = runCensus({ ...armed, sources: "backing" });
    expect(res.status).toBe(0);
    const out = res.stdout ?? "";

    // Proves the design point: the backing preload adds exactly ONE more
    // query on top of whatever the ordinary path already issues -- one
    // projected query served every sale in the cell, never a point read per
    // sale/id.
    const m = /FAKE_CATALOG_QUERY_COUNT (\d+)/.exec(out);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(baselineQueries + 1);

    const artifact = JSON.parse(readFileSync(join(armed.censusOut, "census-slot-0.json"), "utf8"));
    expect(artifact.backing).not.toBeNull();
    expect(artifact.backing.armedBy).toBe("SOURCES=backing");

    const sport = artifact.backing.bySport.baseball;
    expect(sport).toEqual({ backedStrict: 1, rowExistsNonStrict: 1, noRow: 1, unparseable: 1, parked: 1 });

    const cell = artifact.backing.byCell["baseball|1953|topps"];
    expect(cell).toEqual({ backedStrict: 1, rowExistsNonStrict: 1, noRow: 1, unparseable: 1, parked: 1 });

    // Exactly one backing-preload query, regardless of how many the baseline
    // path itself issued -- this is the metric the artifact carries so a
    // reader does not have to diff raw fixture query counts to see it.
    expect(artifact.backing.preload.distinctCellQueries).toBe(1);
    expect(artifact.backing.preload.catalogRowsRead).toBe(2); // the 2 catalog rows the fixture holds for this cell
  });

  itIfBuilt("a wrong SOURCES value (not literally 'backing') does not arm the block", () => {
    const { censusOut, controlStateFile } = freshPaths();
    const res = runCensus({ censusOut, controlStateFile, sources: "some-other-thing" });
    expect(res.status).toBe(0);
    const artifact = JSON.parse(readFileSync(join(censusOut, "census-slot-0.json"), "utf8"));
    expect(artifact.backing).toBeNull();
  });
});
