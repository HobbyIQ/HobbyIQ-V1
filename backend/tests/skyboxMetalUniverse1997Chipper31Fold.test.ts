/**
 * CASE B (key-twins-marconi-chipper-0912): 1997 Skybox Metal Universe
 * Chipper Jones #31 (holding 69eab153-8285-4b6a-8aa1-c20d8a089729) is pinned
 * to hiq:baseball:1997:skybox-metal-universe:31:base:no-auto -- a
 * self-derived row (source=user-verified, isSelfDerivedIdentity=true, per
 * identityBacking.ts). A real, checklist-backed twin already exists at
 * hiq:baseball:1997:metal-universe:31:base:no-auto (source
 * sportscardchecklist-2026-09-06, transcribed from
 * backend/data/checklists/scraped/1997-metal-universe-baseball.csv --
 * sportscardchecklist.com, scraped 2026-09-04, 250-card base set including
 * `base,31,,false,,Chipper Jones,,`).
 *
 * TWO PASSES, ORDER LOAD-BEARING:
 *   1. relocate-pool-rows-by-list moves the sales off the self-derived
 *      address onto the checklist address.
 *   2. relocate-catalog-rows-by-list retires the now-empty self-derived row.
 *
 * These pins hold both list files' SHAPE and lean on each lane's own
 * exported helpers (planRelocatedIdentity, classifyEntry) rather than a
 * re-implementation, plus a fixture proving the destination checklist row is
 * real (present in the scraped CSV on disk, not invented for this PR).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

const POOL_FILE = "2026-09-12-skybox-metal-universe-1997-chipper-31-repoint.json";
const POOL_DIR = join(process.cwd(), "data", "pool-relocations");
const CATALOG_FILE = "2026-09-12-skybox-metal-universe-1997-self-derived-retire.json";
const CATALOG_DIR = join(process.cwd(), "data", "catalog-relocations");
const CHECKLIST_CSV = join(process.cwd(), "data", "checklists", "scraped", "1997-metal-universe-baseball.csv");

type PoolEntry = { id: string; fromCardId: string; toCardId: string; price?: number; evidence?: string };
type PoolList = {
  forLane: string;
  applyOrder: string;
  reportOnlyUntil: string;
  finding: string;
  rulings: string[];
  excluded: Array<{ id: string; fromCardId: string; title?: string; excludeReason: string }>;
  entries: PoolEntry[];
};

type CatalogEntry = { id: string; action: string; to?: string; reason: string; evidence?: string };
type CatalogList = {
  forLane: string;
  applyOrder: string;
  reportOnlyUntil: string;
  finding: string;
  rulings: string[];
  entries: CatalogEntry[];
};

const poolDoc = JSON.parse(readFileSync(join(POOL_DIR, POOL_FILE), "utf8")) as PoolList;
const catalogDoc = JSON.parse(readFileSync(join(CATALOG_DIR, CATALOG_FILE), "utf8")) as CatalogList;

const { planRelocatedIdentity } = require_("../scripts/relocate-pool-rows-by-list.cjs") as {
  planRelocatedIdentity: (a: { storedHobbyiqCardId: string | null; from: string; to: string }) => {
    hobbyiqCardId: string;
    thirdSlug: string | null;
  };
};
const { classifyEntry } = require_("../scripts/relocate-catalog-rows-by-list.cjs") as {
  classifyEntry: (e: unknown) => { ok: boolean; action?: string; to?: string; why?: string };
};

describe("the destination checklist row is real -- on disk, not invented for this PR", () => {
  const csv = readFileSync(CHECKLIST_CSV, "utf8");
  const lines = csv.trim().split("\n");

  it("the checklist file exists and is a base-set transcription (source sportscardchecklist)", () => {
    expect(lines[0]).toBe("category,cardNumber,parallel,isAuto,printRun,player,parallelNote,rarity");
  });

  it("card #31 is Chipper Jones, base, no print run, not an auto", () => {
    const row = lines.find((l) => l.startsWith("base,31,"));
    expect(row).toBe("base,31,,false,,Chipper Jones,,");
  });

  it("the set is the full 250-card 1997 Metal Universe base set", () => {
    expect(lines.length - 1).toBe(250);
  });
});

describe("pool list (pass 1): shape relocate-pool-rows-by-list accepts", () => {
  it("targets the right lane and stays report-only", () => {
    expect(poolDoc.forLane).toBe("relocate-pool-rows-by-list");
    expect(poolDoc.reportOnlyUntil).toMatch(/no apply is authorized/i);
  });

  it("states the applyOrder gate naming pass 1 of 2", () => {
    expect(poolDoc.applyOrder).toMatch(/1 of 2/);
    expect(poolDoc.applyOrder).toMatch(/RUNS FIRST/);
  });

  it("has exactly 2 entries: the two Chipper Jones #31 sales at the self-derived address", () => {
    expect(poolDoc.entries).toHaveLength(2);
  });

  it("every entry moves from skybox-metal-universe:31 to metal-universe:31, same card", () => {
    for (const e of poolDoc.entries) {
      expect(e.fromCardId).toBe("hiq:baseball:1997:skybox-metal-universe:31:base:no-auto");
      expect(e.toCardId).toBe("hiq:baseball:1997:metal-universe:31:base:no-auto");
    }
  });

  it("includes the holding's own eBay-purchase sale and the PSA 9 tca-ebay sale", () => {
    const ids = poolDoc.entries.map((e) => e.id);
    expect(ids).toContain("ebay-user-purchase::398008421282-10087868414521");
    expect(ids).toContain("tca-ebay::158100982036");
  });

  it("addresses each (id, fromCardId) pair at most once", () => {
    const keys = poolDoc.entries.map((e) => `${e.id}|${e.fromCardId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every entry an evidence line naming the checklist source", () => {
    for (const e of poolDoc.entries) {
      expect(String(e.evidence ?? "").length).toBeGreaterThan(20);
      expect(e.evidence).toMatch(/sportscardchecklist/);
    }
  });

  it("planRelocatedIdentity lands both entries' hobbyiqCardId at the checklist address", () => {
    for (const e of poolDoc.entries) {
      const r = planRelocatedIdentity({ storedHobbyiqCardId: e.fromCardId, from: e.fromCardId, to: e.toCardId });
      expect(r.hobbyiqCardId).toBe("hiq:baseball:1997:metal-universe:31:base:no-auto");
    }
  });
});

describe("the Shannon Sharpe football collision is excluded, never folded in as Chipper Jones", () => {
  it("excludes tca-ebay::206470795807 with a different-card reason", () => {
    const ex = poolDoc.excluded.find((e) => e.id === "tca-ebay::206470795807");
    expect(ex).toBeTruthy();
    expect(ex!.title).toMatch(/Shannon Sharpe/);
    expect(ex!.excludeReason).toMatch(/[Ff]ootball/);
  });

  it("the excluded id never appears in entries", () => {
    expect(poolDoc.entries.some((e) => e.id === "tca-ebay::206470795807")).toBe(false);
  });
});

describe("catalog list (pass 2): shape relocate-catalog-rows-by-list accepts", () => {
  it("targets the right lane and stays report-only", () => {
    expect(catalogDoc.forLane).toBe("relocate-catalog-rows-by-list");
    expect(catalogDoc.reportOnlyUntil).toMatch(/no apply is authorized/i);
  });

  it("states the applyOrder gate naming pass 2 of 2, after the pool list", () => {
    expect(catalogDoc.applyOrder).toMatch(/2 of 2/);
    expect(catalogDoc.applyOrder).toMatch(/RUNS SECOND/);
    expect(catalogDoc.applyOrder).toContain(POOL_FILE);
  });

  it("has exactly one entry: retiring the self-derived skybox-metal-universe row", () => {
    expect(catalogDoc.entries).toHaveLength(1);
    expect(catalogDoc.entries[0].id).toBe("hiq:baseball:1997:skybox-metal-universe:31:base:no-auto");
  });

  it("classifyEntry (the lane's own validator) accepts the entry as a retire", () => {
    const v = classifyEntry(catalogDoc.entries[0]);
    expect(v.ok, v.why).toBeTruthy();
    expect(v.action).toBe("retire");
  });

  it("the reason names the checklist twin and the self-derived source", () => {
    expect(catalogDoc.entries[0].reason).toMatch(/user-verified/);
    expect(catalogDoc.entries[0].reason).toMatch(/hiq:baseball:1997:metal-universe:31:base:no-auto/);
  });

  it("does not name a `to` -- a retire stays put and never moves", () => {
    expect(catalogDoc.entries[0].to ?? "").toBe("");
  });
});
