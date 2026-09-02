/**
 * D30-R3 — DIFFERENT sourceExternalId IS TWO REAL SALES, AND MUST NOT BLOCK.
 *
 * THE DEFECT THIS PINS. After the full TRUE-DUPE flagging pass (179 groups /
 * 189 rows, made invisible to the pre-flight by D5's `flaggedWrong` predicate),
 * ALL EIGHT football/2024 dry-run slots STILL refused. The residual measured
 * 729 collisions of one shape: rows with DISTINCT eBay itemIds that hash
 * identically because the same card genuinely sold at the same price on the
 * same day. contentHash — (cardId, parallel, isAuto, grade, price, soldAt) —
 * carries no field that can separate two such sales.
 *
 * Standing doctrine (af14c29c, and collision-triage's own sameness proof):
 * different sourceExternalId = two REAL sales = NEVER collapsed. FATALing on
 * them calls corroborated data corruption and blocks the fold PERMANENTLY —
 * no triage pass can ever clear them, because nothing about them is wrong.
 *
 * THE SHAPE OF THE PROOF. Both directions are pinned against the real script,
 * changing only the external ids on otherwise identical colliding rows:
 *
 *   (a) two rows SHARING source+externalId, unflagged  -> still FATAL
 *   (b) three rows, three DISTINCT externalIds          -> 0 blocking, fold
 *                                                          proceeds, all 3 move
 *   (c) flagged rows are still skipped                  -> the D5 predicate holds
 *
 * (a) and (b) differ in exactly one field, so the count moving is the criterion.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hiq-d30-corroborated-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

// Two catalog rows groupKeyOf puts in ONE group and decideDuplicateGroup folds:
// `base-uncommon` glues onto `uncommon`, the checklist source outranks the vendor.
const WINNER = "hiq:football:2024:topps-finest:197:uncommon:no-auto";
const LOSER = "hiq:football:2024:topps-finest:197:base-uncommon:no-auto";

const CATALOG = [
  { id: WINNER, cardId: WINNER, source: "beckett", sport: "football", year: 2024, setKey: "topps-finest", cardNumber: "197", parallelSlug: "uncommon", isAuto: false, printRun: null, playerName: "Caleb Williams" },
  { id: LOSER, cardId: LOSER, source: "tca-ebay", sport: "football", year: 2024, setKey: "topps-finest", cardNumber: "197", parallelSlug: "base-uncommon", isAuto: false, printRun: null, playerName: "Caleb Williams" },
];

/** Every sale below is IDENTICAL on every contentHash axis — same parallel,
 *  price, soldAt, grade, isAuto — so they all collide in the winner's
 *  partition. The ONLY thing that varies between fixtures is the external id
 *  (and, for (c), the flag). That is what makes the criterion the variable. */
type Sale = Record<string, unknown>;
const sale = (id: string, slug: string, source: string, ext: string, extra: Sale = {}): Sale => ({
  id, cardId: slug, hobbyiqCardId: slug, source, sourceExternalId: ext,
  title: "2024 Topps Finest Caleb Williams #197 Uncommon", parallel: "Uncommon", cardNumber: "197",
  price: 40, soldAt: "2026-08-14T23:30:00Z", observedAt: "2026-08-15T01:00:00Z",
  gradeCompany: null, gradeValue: null, isAuto: false, printRun: null, ...extra,
});

/** (a) ONE listing ingested twice under one source: an unresolved TRUE dupe. */
const SHARED_ID: Sale[] = [
  sale("tca-ebay::777", WINNER, "tca-ebay", "777"),
  sale("tca-ebay::777-dup", LOSER, "tca-ebay", "777"),
];

/** (b) THREE listings, three distinct item ids: three REAL sales of one card at
 *  one price on one day. Corroboration, not corruption. */
const DISTINCT_IDS: Sale[] = [
  sale("tca-ebay::111", WINNER, "tca-ebay", "111"),
  sale("tca-ebay::222", LOSER, "tca-ebay", "222"),
  sale("tca-ebay::333", LOSER, "tca-ebay", "333"),
];

/** (c) the shared-id true dupe, with the loser's copy already triaged. */
const SHARED_ID_FLAGGED: Sale[] = [
  sale("tca-ebay::777", WINNER, "tca-ebay", "777"),
  sale("tca-ebay::777-dup", LOSER, "tca-ebay", "777", {
    flaggedWrong: true, flaggedReason: "dedup-superseded", dedupSupersededBy: "tca-ebay::777",
    dedupReason: "contenthash-triage:shared-sourceExternalId", dedupAt: "2026-09-02T00:00:00Z",
  }),
];

/**
 * A stub @azure/cosmos injected with `--require`, so the module cache is patched
 * before the script loads. It HONOURS THE WHERE CLAUSE: the flaggedWrong
 * predicate is applied here by reading the query text, so a stub cannot pass a
 * test whose subject is a SQL filter.
 */
const stubFor = (sales: Sale[]) => `
const Module = require("module");
const CATALOG = ${JSON.stringify(CATALOG)};
const SALES = ${JSON.stringify(sales)};
const writes = [];
const iter = (rows) => { let done = false; return {
  hasMoreResults: () => !done,
  fetchNext: async () => { done = true; return { resources: rows }; },
}; };
class CosmosClient {
  constructor() {}
  database() { return { container: (name) => ({
    items: {
      query: (q) => {
        const text = typeof q === "string" ? q : q.query;
        if (text.includes("c.parallelSlug")) return iter(CATALOG);
        if (text.includes("c.holdings")) return iter([{ id: "u1", userId: "u1", holdings: {} }]);
        if (text.includes("c.hobbyiqCardId = @s")) {
          const slug = (q.parameters.find((p) => p.name === "@s") || {}).value;
          let rows = SALES.filter((s) => s.hobbyiqCardId === slug || String(s.hobbyiqCardId).startsWith(slug + ":"));
          if (text.includes("c.flaggedWrong != true")) rows = rows.filter((s) => s.flaggedWrong !== true);
          return iter(rows);
        }
        return iter([]);
      },
      upsert: async (doc) => { writes.push({ container: name, id: doc.id, pk: doc.cardId, op: "UPSERT", doc }); return { resource: doc }; },
      create: async (doc) => { writes.push({ container: name, id: doc.id, pk: doc.cardId, op: "CREATE", doc }); return { resource: doc }; },
    },
    item: (id, pk) => ({
      patch: async (ops) => { writes.push({ container: name, id, pk, op: "PATCH", ops }); return {}; },
      delete: async () => { writes.push({ container: name, id, pk, op: "DELETE" }); throw new Error("must never delete"); },
      read: async () => ({ resource: SALES.find((s) => s.id === id) || null }),
      replace: async (doc) => { writes.push({ container: name, id, pk, op: "REPLACE", doc }); return {}; },
    }),
  }) }; }
}
process.on("exit", () => { require("fs").writeFileSync(process.env.WRITES_OUT, JSON.stringify(writes)); });
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@azure/cosmos") return { CosmosClient };
  return realLoad.apply(this, arguments);
};
`;

type Write = { container: string; id: string; pk?: string; op?: string; ops?: { path: string; value: unknown }[]; doc?: Record<string, unknown> };

function runD30(sales: Sale[], env: Record<string, string> = {}): { out: string; code: number | null; writes: Write[] } {
  const stubPath = path.join(tmp, `stub-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(stubPath, stubFor(sales));
  const writesOut = path.join(tmp, `writes-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(writesOut, "[]");

  let out = "";
  let code: number | null = 0;
  try {
    out = execFileSync(process.execPath, ["--require", stubPath, path.join(backend, "scripts", "consolidate-catalog-duplicates.cjs")], {
      cwd: backend,
      env: {
        PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "",
        COSMOS_CONNECTION_STRING: "AccountEndpoint=https://x/;AccountKey=x==;",
        SPORTS: "football", YEARS: "2024",
        AMBIGUOUS_OUT: path.join(tmp, "ambiguous.json"),
        WRITES_OUT: writesOut,
        ...env,
      },
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    code = err.status ?? null;
    out = String(err.stdout ?? "") + String(err.stderr ?? "");
  }
  return { out, code, writes: JSON.parse(fs.readFileSync(writesOut, "utf8")) };
}

/** The pre-flight's BLOCKING line: `COLLISIONS  N in M group(s)`. */
const blockingIn = (out: string): number => {
  const m = /COLLISIONS\s+([\d,]+) in ([\d,]+) group\(s\)/.exec(out);
  if (!m) throw new Error(`no pre-flight COLLISIONS line in output:\n${out.slice(0, 4000)}`);
  return Number(m[1].replace(/,/g, ""));
};

/** The non-blocking line: `corroborated (non-blocking) N in M group(s)`. */
const corroboratedIn = (out: string): number => {
  const m = /corroborated \(non-blocking\)\s+([\d,]+) in ([\d,]+) group\(s\)/.exec(out);
  if (!m) throw new Error(`no corroborated line in output:\n${out.slice(0, 4000)}`);
  return Number(m[1].replace(/,/g, ""));
};

describe("(a) a SHARED sourceExternalId is an unresolved true dupe — still FATAL", () => {
  it("the pre-flight counts it as BLOCKING", () => {
    const { out } = runD30(SHARED_ID);
    // Guard the fixture: a zero below must mean "not blocking", never "nothing examined".
    expect(out).toMatch(/groups planned\s+1/);
    expect(blockingIn(out)).toBe(1);
  });

  it("APPLY refuses with exit 2 and writes nothing", () => {
    const { out, code, writes } = runD30(SHARED_ID, { BACKFILL_APPLY: "true" });
    expect(code).toBe(2);
    expect(out).toMatch(/BLOCKING contentHash collisions across/);
    expect(out).toMatch(/NOTHING HAS BEEN WRITTEN/);
    expect(writes.filter((w) => w.container === "sold_comps")).toEqual([]);
  });
});

describe("(b) DISTINCT sourceExternalIds are corroborated sales — the fold proceeds", () => {
  it("a 3-row identity-identical group counts 0 BLOCKING", () => {
    const { out } = runD30(DISTINCT_IDS);
    expect(out).toMatch(/groups planned\s+1/);
    expect(blockingIn(out)).toBe(0);
  });

  it("they are still COUNTED, on the non-blocking line — not silently dropped", () => {
    // Three rows on one hash = two collisions beyond the first. The number must
    // stay visible: this is data Drew is told about, just not refused over.
    const { out } = runD30(DISTINCT_IDS);
    expect(corroboratedIn(out)).toBe(2);
  });

  it("APPLY proceeds — exit 0, no FATAL", () => {
    const { out, code } = runD30(DISTINCT_IDS, { BACKFILL_APPLY: "true" });
    expect(code).toBe(0);
    expect(out).not.toMatch(/FATAL:/);
    expect(out).toMatch(/APPLIED/);
  });

  it("ALL THREE rows survive the move — none is collapsed or dropped", () => {
    // The doctrine is that these are three REAL sales. A fold that carried only
    // one forward would collapse them by the back door, which is the outcome
    // af14c29c forbids.
    const { writes } = runD30(DISTINCT_IDS, { BACKFILL_APPLY: "true" });
    const pool = writes.filter((w) => w.container === "sold_comps");
    for (const id of ["tca-ebay::222", "tca-ebay::333"]) {
      expect(pool.find((w) => w.id === id), `${id} never moved. pool writes: ${JSON.stringify(pool)}`).toBeTruthy();
    }
    expect(pool.filter((w) => w.op === "DELETE")).toEqual([]);
  });

  it("(a) vs (b) differ only in the external ids, so 1 -> 0 is the criterion", () => {
    expect(blockingIn(runD30(SHARED_ID).out)).toBe(1);
    expect(blockingIn(runD30(DISTINCT_IDS).out)).toBe(0);
  });
});

describe("(c) the D5 flaggedWrong skip survives the R3 merge", () => {
  it("a flagged shared-id dupe is resolved, so it does not block", () => {
    const { out } = runD30(SHARED_ID_FLAGGED);
    expect(out).toMatch(/groups planned\s+1/);
    expect(blockingIn(out)).toBe(0);
  });

  it("APPLY proceeds, and the flagged row still travels with its partition", () => {
    const { out, code, writes } = runD30(SHARED_ID_FLAGGED, { BACKFILL_APPLY: "true" });
    expect(code).toBe(0);
    expect(out).toMatch(/APPLIED/);
    const pool = writes.filter((w) => w.container === "sold_comps");
    expect(pool.find((w) => w.id === "tca-ebay::777-dup"), `the flagged row was never moved: ${JSON.stringify(pool)}`).toBeTruthy();
    // and nothing re-adjudicates it
    for (const w of pool) {
      for (const op of w.ops ?? []) expect(op.path).not.toBe("/flaggedWrong");
      if (w.doc && "flaggedWrong" in w.doc) expect(w.doc.flaggedWrong).toBe(true);
    }
  });
});
