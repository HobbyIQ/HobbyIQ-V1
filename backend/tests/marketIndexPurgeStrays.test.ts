/**
 * CF-MARKET-INDEXES purge (Drew's ruling, 2026-09-03).
 *
 * Nine basket documents were minted into prod on 2026-09-03 between
 * 14:12Z and 14:36Z by rebuild runs whose "report-only" mode was not
 * write-free. Drew ruled they are to be DELETED and every quarter's
 * basket recreated from that quarter's own history.
 *
 * These pin the three properties that make a delete lane safe to hand a
 * production container:
 *
 *   PIN-1  report mode performs ZERO writes over a fixture with the
 *          stray-basket shape. Asserted with a fake container that
 *          RECORDS calls, so "no writes" is measured, not trusted.
 *   PIN-2  apply deletes exactly the listed ids and nothing else -- the
 *          list is the scope, never a predicate re-derived at delete time.
 *   PIN-3  the yml option parses, and the lane rides the 24 existing
 *          runner inputs.
 *
 * The identification rule itself is pinned too, because it is the part
 * that decides what gets destroyed: a doc is condemned only when BOTH
 * markers agree (cited by no point, AND carrying no builtBy stamp). A
 * date alone is never sufficient -- it says when a doc was written, not
 * what wrote it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureBasket } from "../src/services/insights/marketIndexCompute.service.js";

const repoRoot = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");
const script = read("backend/scripts/rebuild-market-indexes.cjs");
const runner = read(".github/workflows/backfill-runner.yml");

/**
 * The nine documents Drew ruled on, exactly as they stand in prod
 * (measured 2026-09-03 via a read-only Cosmos query). Quoted here so the
 * fixture is the real population and not an invented shape.
 */
const PROD_STRAYS = [
  { id: "basket::baseball::2026-Q1", sport: "baseball", epoch: "2026-Q1", ts: 1788444777, members: 100 },
  { id: "basket::hockey::2026-Q1", sport: "hockey", epoch: "2026-Q1", ts: 1788445357, members: 21 },
  { id: "basket::basketball::2026-Q1", sport: "basketball", epoch: "2026-Q1", ts: 1788445366, members: 100 },
  { id: "basket::football::2026-Q1", sport: "football", epoch: "2026-Q1", ts: 1788445367, members: 100 },
  { id: "basket::pokemon::2026-Q1", sport: "pokemon", epoch: "2026-Q1", ts: 1788445367, members: 100 },
  { id: "basket::basketball::2026-Q2", sport: "basketball", epoch: "2026-Q2", ts: 1788445536, members: 100 },
  { id: "basket::football::2026-Q2", sport: "football", epoch: "2026-Q2", ts: 1788445536, members: 100 },
  { id: "basket::pokemon::2026-Q2", sport: "pokemon", epoch: "2026-Q2", ts: 1788445567, members: 4 },
  { id: "basket::baseball::2026-Q2", sport: "baseball", epoch: "2026-Q2", ts: 1788446159, members: 100 },
];

/** The five legitimate baskets the nightly apply built on 2026-09-02. */
const PROD_KEEPERS = [
  { id: "basket::baseball::2026-Q3", sport: "baseball", epoch: "2026-Q3", ts: 1788373441, members: 100 },
  { id: "basket::basketball::2026-Q3", sport: "basketball", epoch: "2026-Q3", ts: 1788374162, members: 100 },
  { id: "basket::football::2026-Q3", sport: "football", epoch: "2026-Q3", ts: 1788374328, members: 100 },
  { id: "basket::hockey::2026-Q3", sport: "hockey", epoch: "2026-Q3", ts: 1788374467, members: 43 },
  { id: "basket::pokemon::2026-Q3", sport: "pokemon", epoch: "2026-Q3", ts: 1788374483, members: 100 },
];

/**
 * A container that RECORDS every call. Deletes are recorded by (id, pk)
 * so a test can assert exactly which documents were destroyed -- the
 * only way to pin "and nothing else".
 */
function recordingContainer(docs: { id: string; sport: string }[] = []) {
  const deleted: { id: string; pk: unknown }[] = [];
  const writes: { method: string; id?: string }[] = [];
  const stored = new Map(docs.map((d) => [d.id, d]));
  return {
    deleted,
    writes,
    items: {
      query: () => {
        let served = false;
        return {
          hasMoreResults: () => !served,
          fetchNext: () => {
            served = true;
            return Promise.resolve({ resources: [] });
          },
        };
      },
      upsert: (d: { id?: string }) => {
        writes.push({ method: "items.upsert", id: d?.id });
        return Promise.resolve({ resource: d });
      },
      create: (d: { id?: string }) => {
        writes.push({ method: "items.create", id: d?.id });
        return Promise.resolve({ resource: d });
      },
    },
    item: (id: string, pk: unknown) => ({
      read: () => Promise.resolve({ resource: stored.get(id) }),
      replace: (d: { id?: string }) => {
        writes.push({ method: "item.replace", id: d?.id });
        return Promise.resolve({ resource: d });
      },
      patch: () => {
        writes.push({ method: "item.patch", id });
        return Promise.resolve({ resource: {} });
      },
      delete: () => {
        if (!stored.has(id)) {
          const err = new Error("NotFound") as Error & { code: number };
          err.code = 404;
          return Promise.reject(err);
        }
        stored.delete(id);
        deleted.push({ id, pk });
        writes.push({ method: "item.delete", id });
        return Promise.resolve({});
      },
    }),
  };
}

/**
 * The script's own purge helpers, exercised directly. They are defined in
 * a .cjs the runner execs, so they are lifted out by evaluating the file
 * in a module scope -- the alternative is re-implementing the rule in the
 * test, which pins nothing.
 */
function loadPurgeHelpers() {
  const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
  // Strip the bottom-of-file `main()` invocation so evaluating the file
  // does not try to run the job.
  const body = script
    // A `#!` shebang is legal in a script Node execs and a syntax error
    // inside `new Function`, so it goes first.
    .replace(/^#![^\n]*\n/, "")
    .replace(/main\(\)\.catch\([\s\S]*$/, "");
  const factory = new Function(
    "module",
    "exports",
    "require",
    "process",
    "console",
    "__dirname",
    `${body}\n;module.exports = { identifyStrays, purgeStrays, STRAY_WINDOW_START_TS, STRAY_WINDOW_END_TS };`,
  );
  factory(
    moduleObj,
    moduleObj.exports,
    require,
    process,
    console,
    join(repoRoot, "backend", "scripts"),
  );
  return moduleObj.exports as unknown as {
    identifyStrays: (
      baskets: unknown[],
      referenced: Set<string>,
      sports: string[],
    ) => {
      strays: { id: string; sport: string; marker: string }[];
      kept: { id: string; keptBecause?: string }[];
    };
    purgeStrays: (
      series: unknown,
      strays: { id: string; sport: string }[],
    ) => Promise<{ deleted: string[]; skipped: { id: string; reason: string }[] }>;
    STRAY_WINDOW_START_TS: number;
    STRAY_WINDOW_END_TS: number;
  };
}

const helpers = loadPurgeHelpers();

/** The prod basket population, in the shape readAllBaskets returns. */
function prodBaskets() {
  return [...PROD_KEEPERS, ...PROD_STRAYS].map((b) => ({
    id: b.id,
    sport: b.sport,
    epoch: b.epoch,
    baseDate:
      b.epoch === "2026-Q1" ? "2026-01-01" : b.epoch === "2026-Q2" ? "2026-04-01" : "2026-07-01",
    computedAt: new Date(b.ts * 1000).toISOString(),
    memberCount: b.members,
    _ts: b.ts,
    // None of the fourteen carries a stamp: the field did not exist when
    // any of them was written. This is the prod truth, verified by a
    // key-set read of all fourteen docs on 2026-09-03.
    builtBy: undefined as string | undefined,
  }));
}

/** What prod's points actually cite: 2026-Q3 for all five sports. */
const REFERENCED = new Set(
  ["baseball", "basketball", "football", "hockey", "pokemon"].map((s) => `${s}::2026-Q3`),
);

const ALL_SPORTS = ["baseball", "basketball", "football", "hockey", "pokemon"];

describe("the nine strays are identified precisely, and only those nine", () => {
  it("names exactly the nine documents Drew ruled on", () => {
    const { strays } = helpers.identifyStrays(prodBaskets(), REFERENCED, ALL_SPORTS);
    expect(strays.map((s) => s.id).sort()).toEqual(PROD_STRAYS.map((s) => s.id).sort());
    expect(strays).toHaveLength(9);
  });

  it("keeps every basket the published series is actually computed against", () => {
    const { kept } = helpers.identifyStrays(prodBaskets(), REFERENCED, ALL_SPORTS);
    for (const k of PROD_KEEPERS) {
      expect(kept.map((x) => x.id)).toContain(k.id);
    }
  });

  it("condemns on TWO markers, never on the date alone", () => {
    // A basket inside the incident window that IS cited by points is
    // kept. If the rule were a date sweep, this would be destroyed.
    const baskets = prodBaskets().map((b) =>
      b.id === "basket::pokemon::2026-Q3"
        ? { ...b, _ts: helpers.STRAY_WINDOW_START_TS + 60 }
        : b,
    );
    const { strays, kept } = helpers.identifyStrays(baskets, REFERENCED, ALL_SPORTS);
    expect(strays.map((s) => s.id)).not.toContain("basket::pokemon::2026-Q3");
    expect(kept.find((k) => k.id === "basket::pokemon::2026-Q3")).toBeTruthy();
  });

  it("an apply-stamped basket is never purged, even unreferenced", () => {
    // This is what protects a NEW quarter's basket in the window between
    // its creation and the first point that cites it.
    const baskets = prodBaskets().map((b) =>
      b.id === "basket::pokemon::2026-Q1" ? { ...b, builtBy: "apply" } : b,
    );
    const { strays } = helpers.identifyStrays(baskets, REFERENCED, ALL_SPORTS);
    expect(strays.map((s) => s.id)).not.toContain("basket::pokemon::2026-Q1");
    expect(strays).toHaveLength(8);
  });

  it("a sport the dispatch did not name is reported but never deleted", () => {
    const { strays, kept } = helpers.identifyStrays(prodBaskets(), REFERENCED, ["pokemon"]);
    expect(strays.map((s) => s.id).sort()).toEqual([
      "basket::pokemon::2026-Q1",
      "basket::pokemon::2026-Q2",
    ]);
    // The others are still NAMED, with the reason they survived.
    expect(kept.filter((k) => k.keptBecause === "out-of-scope-for-this-run")).toHaveLength(7);
  });

  it("the marker is recorded on every stray, so the report says WHY", () => {
    const { strays } = helpers.identifyStrays(prodBaskets(), REFERENCED, ALL_SPORTS);
    for (const s of strays) {
      expect(s.marker).toContain("unreferenced+unstamped");
    }
  });
});

describe("PIN-2: apply deletes exactly the listed ids and nothing else", () => {
  it("deletes the nine and leaves the five keepers untouched", async () => {
    const series = recordingContainer([...PROD_KEEPERS, ...PROD_STRAYS]);
    const { strays } = helpers.identifyStrays(prodBaskets(), REFERENCED, ALL_SPORTS);

    const result = await helpers.purgeStrays(series, strays);

    expect(result.deleted.slice().sort()).toEqual(PROD_STRAYS.map((s) => s.id).sort());
    expect(result.skipped).toEqual([]);
    // AND NOTHING ELSE: every recorded call is a delete, and every
    // deleted id is one of the nine.
    expect(series.writes.every((w) => w.method === "item.delete")).toBe(true);
    expect(series.deleted).toHaveLength(9);
    for (const k of PROD_KEEPERS) {
      expect(series.deleted.map((d) => d.id)).not.toContain(k.id);
    }
  });

  it("deletes on the doc's OWN partition key, never a guessed one", async () => {
    const series = recordingContainer([...PROD_STRAYS]);
    const { strays } = helpers.identifyStrays(prodBaskets(), REFERENCED, ALL_SPORTS);
    await helpers.purgeStrays(series, strays);
    for (const d of series.deleted) {
      const sport = d.id.split("::")[1];
      expect(d.pk).toBe(`index::${sport}`);
    }
  });

  it("an already-absent doc is SKIPPED, so the run still reconciles", async () => {
    // Container holds only 8 of the 9 -- a re-run after a partial purge.
    const present = PROD_STRAYS.slice(1);
    const series = recordingContainer(present);
    const { strays } = helpers.identifyStrays(prodBaskets(), REFERENCED, ALL_SPORTS);

    const result = await helpers.purgeStrays(series, strays);

    expect(result.deleted).toHaveLength(8);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      id: "basket::baseball::2026-Q1",
      reason: "already-absent",
    });
    // intended == deleted + skipped, which is the banner's assertion.
    expect(strays.length).toBe(result.deleted.length + result.skipped.length);
  });

  it("an empty stray list deletes nothing at all", async () => {
    const series = recordingContainer([...PROD_KEEPERS]);
    const result = await helpers.purgeStrays(series, []);
    expect(result.deleted).toEqual([]);
    expect(series.writes).toEqual([]);
  });
});

describe("PIN-1: report mode performs zero writes over the stray shape", () => {
  it("ensureBasket persist:false mints nothing for an epoch with no stored basket", async () => {
    // The exact prod shape that minted basket::pokemon::2026-Q2.
    const series = recordingContainer([]);
    const soldComps = {
      items: {
        query: () => {
          const rows: { cardId: string; price: number; soldAt: string }[] = [];
          for (let c = 0; c < 30; c++) {
            for (let s = 0; s < 12; s++) {
              rows.push({
                cardId: `card-${c}`,
                price: 100 + c,
                soldAt: `2026-02-${String((s % 28) + 1).padStart(2, "0")}`,
              });
            }
          }
          let served = false;
          return {
            hasMoreResults: () => !served,
            fetchNext: () => {
              served = true;
              return Promise.resolve({ resources: rows });
            },
          };
        },
      },
    };

    const out = await ensureBasket(
      soldComps as never,
      series as never,
      "pokemon",
      "2026-04-15",
      { persist: false },
    );

    expect(out).not.toBeNull();
    expect(out!.persisted).toBe(false);
    expect(series.writes).toEqual([]);
    expect(series.deleted).toEqual([]);
  });

  it("EVERY purgeStrays call sits under apply", () => {
    // The guard is structural: a purge outside `if (apply ...)` is the
    // defect this PR closes, re-introduced.
    //
    // There are two delete lanes now - the stray BASKETS, and the points
    // dated before the recompute span (2026-09-03: the four
    // point::<sport>::2026-03-07 docs the walk can never reach). Counting
    // call sites would red on the second lane merely for existing, so the
    // pin asserts the property that actually matters: each call is inside
    // an `if (apply` block, and none stands outside one.
    expect(script).toContain("if (apply && strays.length > 0) {");
    expect(script).toContain("purge = await purgeStrays(series, strays);");
    expect(script).toContain("prePurge = await purgeStrays(series, prePoints);");

    const lines = script.split("\n");
    const callLines = lines
      .map((line, i) => ({ line, i }))
      .filter((x) => /await purgeStrays\(/.test(x.line));
    expect(callLines.length).toBeGreaterThanOrEqual(2);
    for (const { i } of callLines) {
      // The nearest preceding control line must be an apply gate. Walking
      // back a couple of lines is enough: both lanes gate immediately
      // above the call.
      const preceding = lines.slice(Math.max(0, i - 3), i).join("\n");
      expect(preceding).toMatch(/if \(apply/);
    }
  });

  it("a report that somehow deleted something FAILS the run", () => {
    expect(script).toContain("market_index_purge_deleted_in_report_mode");
    expect(script).toContain("if (!apply && !reconciled) {");
  });

  it("report mode still drives the recompute through the write-refusing facade", () => {
    // #1675's guarantee, unchanged by the purge landing on top of it.
    expect(script).toContain("const guard = readOnlyContainer(series);");
    expect(script).toContain("guard.__writes.length > 0");
  });
});

describe("the purge reconciles, and the run verifies by READ", () => {
  it("the banner asserts intended == deleted + skipped for an apply", () => {
    expect(script).toContain("market_index_purge_reconcile");
    expect(script).toContain("strays.length === purge.deleted.length + purge.skipped.length");
    expect(script).toContain("market_index_purge_did_not_reconcile");
  });

  it("a non-reconciling apply exits before rebuilding on top of it", () => {
    const idx = script.indexOf("market_index_purge_did_not_reconcile");
    expect(idx).toBeGreaterThan(-1);
    const after = script.slice(idx, idx + 400);
    expect(after).toContain("process.exit(2)");
    // It must come BEFORE the recompute, or the rebuild has already run.
    expect(idx).toBeLessThan(script.indexOf("compute.runMarketIndexJob"));
  });

  it("verify-by-read asserts the three post-conditions", () => {
    expect(script).toContain("async function verifyByRead(");
    // basket count per sport/epoch
    expect(script).toContain("basketsPerSportEpoch");
    // no basket under the ruled floor
    expect(script).toContain("b.memberCount < minBasketSize");
    // no published point below the ruled usedWeight floor
    expect(script).toContain("c.usedWeight < @floor");
    expect(script).toContain("NOT IS_DEFINED(c.stale) OR c.stale = false");
    // and no stray left standing
    expect(script).toContain("remainingStrayCount");
  });

  it("verify quotes the RULED constants rather than hardcoding copies", () => {
    expect(script).toContain(
      "verifyByRead(series, sports, svc.MIN_BASKET_SIZE, svc.MIN_USED_WEIGHT)",
    );
  });

  it("a failed verify fails an apply run", () => {
    expect(script).toContain("if (apply && !verify.ok) {");
    expect(script).toContain("market_index_rebuild_verify_failed");
  });

  it("baskets recreated are reported per sport and epoch", () => {
    expect(script).toContain("market_index_baskets_recreated");
    expect(script).toContain("perSportEpoch");
  });
});

describe("PIN-3: the yml option parses and the lane rides the existing inputs", () => {
  it("is on the script whitelist", () => {
    expect(runner.replace(/\r\n/g, "\n")).toContain("          - rebuild-market-indexes\n");
  });

  it("the exec is generic, which is what makes the dropdown the gate", () => {
    expect(runner).toContain('node "backend/scripts/${{ inputs.script }}.cjs"');
  });

  it("adds NO new runner input -- workflow_dispatch caps at 25", () => {
    const dispatchBlock = runner.slice(
      runner.indexOf("  workflow_dispatch:"),
      runner.indexOf("jobs:"),
    );
    const inputNames = [...dispatchBlock.matchAll(/^      ([a-z_]+):$/gm)].map((m) => m[1]);
    expect(inputNames.length).toBeLessThanOrEqual(25);
    // The lane rides these three; it claims none of its own.
    expect(inputNames).toContain("apply");
    expect(inputNames).toContain("sports");
    expect(inputNames).toContain("script");
  });

  it("BACKFILL_APPLY gates the writes, and the script honours it", () => {
    expect(runner).toMatch(
      /BACKFILL_APPLY:\s*\$\{\{\s*inputs\.apply == true && 'true' \|\| 'false'\s*\}\}/,
    );
    expect(script).toContain('envTrue("BACKFILL_APPLY")');
    // Report is the DEFAULT: apply is only ever true by explicit request.
    expect(script).toContain('args.includes("--apply") || envTrue("BACKFILL_APPLY")');
  });

  it("SPORTS narrows the scope, and an unknown sport is refused", () => {
    expect(runner).toMatch(/SPORTS:\s*\$\{\{\s*inputs\.sports\s*\}\}/);
    expect(script).toContain("unknown sport(s)");
  });

  it("the presence check covers the COMPILED services the lane drives", () => {
    expect(runner).toContain('if [ "${{ inputs.script }}" = "rebuild-market-indexes" ]; then');
    expect(runner).toContain("marketIndexCompute.service.js");
    expect(runner).toContain("would purge baskets and then have nothing to recreate them with");
  });

  it("the banner gate greps the reconcile line and the mode binding", () => {
    expect(runner).toContain("The rebuild banner reconciles");
    expect(runner).toContain('"reconciled":true');
    expect(runner).toContain("market_index_rebuild_write_in_report_mode");
  });

  it("the report is uploaded as an artifact", () => {
    expect(runner).toContain("Upload the market-index rebuild report");
    expect(runner).toContain("/tmp/market-index-rebuild/report.json");
    expect(runner).toMatch(/REPORT_OUT:\s*\/tmp\/market-index-rebuild\/report\.json/);
  });
});

describe("the ruled thresholds are stated as rulings, not assumptions", () => {
  const svc = read("backend/src/services/insights/marketIndex.service.ts");

  it("MIN_USED_WEIGHT 0.50 and MIN_BASKET_SIZE 25 are RULED 2026-09-03", () => {
    expect(svc).toContain("RULED 2026-09-03");
    expect(svc).toContain("export const MIN_USED_WEIGHT = 0.5;");
    expect(svc).toContain("export const MIN_BASKET_SIZE = 25;");
  });

  it("no 'ASSUMPTION, not a Drew ruling' wording survives", () => {
    expect(svc).not.toContain("ASSUMPTION, not a Drew ruling");
    expect(svc).not.toContain("Drew has not ruled");
  });
});

describe("provenance: the apply path stamps what it writes", () => {
  it("ensureBasket stamps builtBy on the persisting path only", () => {
    const compute = read("backend/src/services/insights/marketIndexCompute.service.ts");
    expect(compute).toContain('builtBy: "apply" as const');
    // The dry-run return happens BEFORE the stamp, so an in-memory doc
    // never carries it.
    const stampIdx = compute.indexOf('builtBy: "apply"');
    const dryReturnIdx = compute.indexOf("if (!persist) return { basket: doc");
    expect(dryReturnIdx).toBeGreaterThan(-1);
    expect(dryReturnIdx).toBeLessThan(stampIdx);
  });

  it("the basket type carries the provenance field", () => {
    const svc = read("backend/src/services/insights/marketIndex.service.ts");
    expect(svc).toContain('builtBy?: "apply";');
  });
});
