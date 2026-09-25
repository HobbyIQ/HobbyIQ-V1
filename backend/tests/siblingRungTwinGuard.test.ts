/**
 * CF-A-SIBLING-KEY-IS-STILL-THE-SAME-RUNG (Drew, 2026-09-25).
 *
 * Unit tests for the PURE half of the rung-level sibling guard --
 * `scripts/lib/sibling-rung-twin.cjs` -- with fakes, so the branch logic is
 * pinned independent of any Cosmos container shape. The end-to-end wiring
 * through the real ingest script (exact-id checklist skip, exact-id derived
 * write, sibling-twin skip with an example, no-twin write, and the balanced
 * reconciliation) is covered separately in
 * tests/ingestSkipsExactIdChecklistAndSiblingRungTwins.test.ts, which drives
 * the actual script as a child process.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { slugify } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { catalogAuthorityOf } from "../src/services/catalog/catalogAuthority.service.js";

const libPath = path.resolve(__dirname, "..", "scripts", "lib", "sibling-rung-twin.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require(libPath);

const parallelSlugOf = (p: string) => slugify(p || "Base");

// A mutant copy needs its OWN name-agreement.cjs resolvable beside it (the
// module does `require("./name-agreement.cjs")`), so it is written into the
// real lib/ directory as a sibling temp file, never under os.tmpdir() -- the
// same convention csvIngestSourceDuplicatesDeclaredToReconciler.test.ts uses
// for its own mutant script.
const mutantDir = path.dirname(libPath);
const mutantFiles: string[] = [];
function writeMutant(src: string): string {
  const p = path.join(mutantDir, `mutant-sibling-rung-twin.${Date.now()}.${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(p, src);
  mutantFiles.push(p);
  return p;
}
afterAll(() => { for (const p of mutantFiles) { try { fs.rmSync(p, { force: true }); } catch { /* best effort */ } } });

describe("siblingRungTwinQuery", () => {
  it("filters by sport, year (or cardYear) and cardNumber only -- never COUNT/GROUP BY", () => {
    const q = lib.siblingRungTwinQuery({ sport: "baseball", year: 1990, cardNumber: "232" });
    expect(q.query).toMatch(/SELECT c\.id, c\.setKey, c\.parallel, c\.isAuto, c\.printRun, c\.source, c\.playerName/);
    expect(q.query).not.toMatch(/COUNT|GROUP BY/i);
    expect(q.query).toMatch(/c\.sport = @sport/);
    expect(q.query).toMatch(/c\.year = @year OR c\.cardYear = @year/);
    expect(q.query).toMatch(/c\.cardNumber = @cardNumber/);
    expect(q.parameters).toEqual([
      { name: "@sport", value: "baseball" },
      { name: "@cardNumber", value: "232" },
      { name: "@year", value: 1990 },
    ]);
  });

  it("uppercases the card number the same way the write path stores it", () => {
    const q = lib.siblingRungTwinQuery({ sport: "baseball", year: 1990, cardNumber: "cpa-br" });
    expect(q.parameters.find((p: { name: string }) => p.name === "@cardNumber").value).toBe("CPA-BR");
  });
});

describe("isSiblingRungTwin", () => {
  const staged = { cardNumber: "1", parallel: "Silver Prizm", isAuto: "false", printRun: "", player: "Alpha Player" };

  it("is a twin: same rung, checklist authority, different setKey, same player", () => {
    const row = { setKey: "bowman-chrome", parallel: "Silver Prizm", isAuto: false, printRun: null, source: "sportscardchecklist", playerName: "Alpha Player" };
    expect(lib.isSiblingRungTwin(row, staged, { setKey: "bowman", parallelSlugOf, catalogAuthorityOf })).toBe(true);
  });

  it("is NOT a twin at the SAME setKey -- that is the exact-id case, handled separately", () => {
    const row = { setKey: "bowman", parallel: "Silver Prizm", isAuto: false, printRun: null, source: "sportscardchecklist", playerName: "Alpha Player" };
    expect(lib.isSiblingRungTwin(row, staged, { setKey: "bowman", parallelSlugOf, catalogAuthorityOf })).toBe(false);
  });

  it("is NOT a twin when the sibling row is DERIVED, not checklist -- a self-confirming row is not evidence", () => {
    const row = { setKey: "bowman-chrome", parallel: "Silver Prizm", isAuto: false, printRun: null, source: "ingest-auto-seed", playerName: "Alpha Player" };
    expect(lib.isSiblingRungTwin(row, staged, { setKey: "bowman", parallelSlugOf, catalogAuthorityOf })).toBe(false);
  });

  it("is NOT a twin when the parallel differs, even under the same spelling rules", () => {
    const row = { setKey: "bowman-chrome", parallel: "Gold Prizm", isAuto: false, printRun: null, source: "sportscardchecklist", playerName: "Alpha Player" };
    expect(lib.isSiblingRungTwin(row, staged, { setKey: "bowman", parallelSlugOf, catalogAuthorityOf })).toBe(false);
  });

  it("folds parallel through the SAME slug function on both sides -- case and spacing never matter", () => {
    const row = { setKey: "bowman-chrome", parallel: "silver   prizm", isAuto: false, printRun: null, source: "sportscardchecklist", playerName: "Alpha Player" };
    expect(lib.isSiblingRungTwin(row, staged, { setKey: "bowman", parallelSlugOf, catalogAuthorityOf })).toBe(true);
  });

  it("is NOT a twin when isAuto disagrees", () => {
    const row = { setKey: "bowman-chrome", parallel: "Silver Prizm", isAuto: true, printRun: null, source: "sportscardchecklist", playerName: "Alpha Player" };
    expect(lib.isSiblingRungTwin(row, staged, { setKey: "bowman", parallelSlugOf, catalogAuthorityOf })).toBe(false);
  });

  it("is NOT a twin when printRun disagrees", () => {
    const row = { setKey: "bowman-chrome", parallel: "Silver Prizm", isAuto: false, printRun: 99, source: "sportscardchecklist", playerName: "Alpha Player" };
    expect(lib.isSiblingRungTwin(row, staged, { setKey: "bowman", parallelSlugOf, catalogAuthorityOf })).toBe(false);
  });

  it("blank parallel on both sides (Base vs Base) still matches when the player agrees", () => {
    const baseStaged = { cardNumber: "1", parallel: "", isAuto: "false", printRun: "", player: "Alpha Player" };
    const row = { setKey: "topps-series-1", parallel: null, isAuto: false, printRun: null, source: "beckett", playerName: "Alpha Player" };
    expect(lib.isSiblingRungTwin(row, baseStaged, { setKey: "topps", parallelSlugOf, catalogAuthorityOf })).toBe(true);
  });

  // CF-A-SHARED-NUMBER-IS-NOT-A-SHARED-CARD (review finding, PR #2422).
  it("is NOT a twin when the SAME rung under a sibling key names a DIFFERENT player -- two distinct products sharing a numbering scheme", () => {
    const row = { setKey: "topps-chrome", parallel: "Silver Prizm", isAuto: false, printRun: null, source: "sportscardchecklist", playerName: "Beta Player" };
    expect(lib.isSiblingRungTwin(row, { ...staged, cardNumber: "1" }, { setKey: "topps-series-1", parallelSlugOf, catalogAuthorityOf })).toBe(false);
  });

  it("IS a twin when the same player is spelled with a Jr. suffix on one side and a subset tag on the other", () => {
    const row = { setKey: "bowman-chrome", parallel: "Silver Prizm", isAuto: false, printRun: null, source: "sportscardchecklist", playerName: "Bobby Witt Jr." };
    const stagedTagged = { ...staged, player: "Bobby Witt RCup" };
    expect(lib.isSiblingRungTwin(row, stagedTagged, { setKey: "bowman", parallelSlugOf, catalogAuthorityOf })).toBe(true);
  });

  it("mutation check: removing the name comparison lets a different-player pair read as a twin", () => {
    const src = fs.readFileSync(libPath, "utf8");
    const marker = /if \(!namesAgree\(row\.playerName, staged\.player\)\) return false;/;
    expect(src).toMatch(marker);
    const mutated = src.replace(marker, "");
    expect(mutated).not.toBe(src);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mutantPath = writeMutant(mutated);
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mutantLib = require(mutantPath);
      const row = { setKey: "topps-chrome", parallel: "Silver Prizm", isAuto: false, printRun: null, source: "sportscardchecklist", playerName: "Beta Player" };
      // Without the name comparison, the different-player pair the test
      // above correctly refuses now reads as a twin -- the mutation is caught.
      expect(mutantLib.isSiblingRungTwin(row, { ...staged, cardNumber: "1" }, { setKey: "topps-series-1", parallelSlugOf, catalogAuthorityOf })).toBe(true);
    } finally {
      fs.rmSync(mutantPath, { force: true });
    }
  });
});

describe("findSiblingRungTwins", () => {
  function fakeContainer(rows: unknown[]) {
    return {
      items: {
        query() {
          let done = false;
          return {
            hasMoreResults: () => !done,
            fetchNext: async () => { done = true; return { resources: rows }; },
          };
        },
      },
    };
  }

  it("returns every match across a single page", async () => {
    const staged = { cardNumber: "1", parallel: "Silver Prizm", isAuto: "false", printRun: "", player: "Alpha" };
    const container = fakeContainer([
      { id: "a", setKey: "bowman-chrome", parallel: "Silver Prizm", isAuto: false, printRun: null, source: "sportscardchecklist", playerName: "Alpha" },
      { id: "b", setKey: "bowman", parallel: "Silver Prizm", isAuto: false, printRun: null, source: "sportscardchecklist", playerName: "Alpha" },
      { id: "c", setKey: "bowman-paper", parallel: "Gold Prizm", isAuto: false, printRun: null, source: "sportscardchecklist", playerName: "Alpha" },
    ]);
    const twins = await lib.findSiblingRungTwins(container, staged, {
      sport: "baseball", year: 2020, setKey: "bowman", parallelSlugOf, catalogAuthorityOf,
    });
    expect(twins.map((t: { id: string }) => t.id)).toEqual(["a"]);
  });

  it("pages a multi-page result to completion -- never breaks on an empty page", async () => {
    const staged = { cardNumber: "1", parallel: "", isAuto: "false", printRun: "", player: "Alpha" };
    let call = 0;
    const container = {
      items: {
        query() {
          return {
            hasMoreResults: () => call < 3,
            fetchNext: async () => {
              call++;
              if (call === 1) return { resources: [] }; // empty page, NOT done
              if (call === 2) return { resources: [{ setKey: "bowman-chrome", parallel: null, isAuto: false, printRun: null, source: "sportscardchecklist", playerName: "Alpha" }] };
              return { resources: [] };
            },
          };
        },
      },
    };
    const twins = await lib.findSiblingRungTwins(container, staged, {
      sport: "baseball", year: 2020, setKey: "bowman", parallelSlugOf, catalogAuthorityOf,
    });
    expect(twins).toHaveLength(1);
    expect(call).toBe(3);
  });

  it("returns empty when nothing matches", async () => {
    const staged = { cardNumber: "1", parallel: "Silver Prizm", isAuto: "false", printRun: "", player: "Alpha" };
    const container = fakeContainer([]);
    const twins = await lib.findSiblingRungTwins(container, staged, {
      sport: "baseball", year: 2020, setKey: "bowman", parallelSlugOf, catalogAuthorityOf,
    });
    expect(twins).toEqual([]);
  });

  it("passes a `retry` wrapper through to every fetchNext call, defaulting to a passthrough", async () => {
    const staged = { cardNumber: "1", parallel: "Silver Prizm", isAuto: "false", printRun: "", player: "Alpha" };
    const container = fakeContainer([]);
    let retryCalls = 0;
    const retry = async (fn: () => Promise<unknown>) => { retryCalls++; return fn(); };
    await lib.findSiblingRungTwins(container, staged, {
      sport: "baseball", year: 2020, setKey: "bowman", parallelSlugOf, catalogAuthorityOf, retry,
    });
    expect(retryCalls).toBeGreaterThan(0);
  });
});

describe("createSemaphore", () => {
  it("caps in-flight callers at the given limit -- a limit of 2 never runs a 3rd until one finishes", async () => {
    const sem = lib.createSemaphore(2);
    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers: Array<() => void> = [];
    const task = () => sem.run(() => new Promise<void>((resolve) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      resolvers.push(() => { inFlight--; resolve(); });
    }));

    const p1 = task();
    const p2 = task();
    const p3 = task();
    // Give the microtask queue a tick to let the first two start.
    await new Promise((r) => setTimeout(r, 10));
    expect(maxInFlight).toBe(2);
    expect(sem.active).toBe(2);
    expect(sem.queued).toBe(1);

    resolvers[0]();
    await p1;
    await new Promise((r) => setTimeout(r, 10));
    expect(maxInFlight).toBe(2); // never exceeded the cap, even after a slot freed and the 3rd started

    resolvers[1]();
    resolvers[2]();
    await Promise.all([p2, p3]);
    expect(sem.active).toBe(0);
    expect(sem.queued).toBe(0);
  });

  it("propagates a rejection to the right caller without blocking the queue", async () => {
    const sem = lib.createSemaphore(1);
    const p1 = sem.run(() => Promise.reject(new Error("boom")));
    const p2 = sem.run(() => Promise.resolve("ok"));
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBe("ok");
  });
});
