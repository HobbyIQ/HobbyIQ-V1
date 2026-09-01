/**
 * THE WHOLE SCRIPT, END TO END, AGAINST A FAKE POOL.
 *
 * The contract tests assert structure; this one runs the actual entrypoint --
 * scope gate, catalog grouping, contentHash re-derivation, classification,
 * report -- against an in-memory Cosmos, and reads the classification off its
 * stdout. Without it, "the classifier is correct" and "the script uses the
 * classifier correctly" are two different claims and only one is tested.
 *
 * The fixture is the real shape of the collisions that blocked D30: one
 * partition holding a genuine cross-source duplicate (shared item id), and a
 * `Uncommon` / `Uncommon Refractor` pair that only collides because the
 * retracted normalization squashed them.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hiq-triage-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

// The two catalog rows D30 folds together. `base-uncommon` and `uncommon` are
// ONE group under groupKeyOf (the base-glue kind: cleanParallelSlug strips the
// `base-` prefix), which is why the fold brings their sales into one partition
// and the pre-flight hashes them against each other.
//
// NOTE the shape this fixture had to take. Two catalog rows spelled `uncommon`
// and `uncommon-refractor` are NOT one group -- groupKeyOf keeps them apart, so
// D30 never folds them and no collision arises there. The DISTINCT-CARDS
// hazard is a property of the SALES: two sales whose own raw `parallel` fields
// are `Uncommon` and `Uncommon Refractor`, landing in one partition through a
// fold decided on the catalog rows' slugs.
const WINNER = "hiq:football:2024:topps-finest:197:uncommon:no-auto";
const LOSER = "hiq:football:2024:topps-finest:197:base-uncommon:no-auto";

/** Two catalog rows D30 groups together, and four sales beneath them. */
const CATALOG = [
  { id: WINNER, cardId: WINNER, source: "beckett", sport: "football", year: 2024, setKey: "topps-finest", cardNumber: "197", parallelSlug: "uncommon", isAuto: false, printRun: null, playerName: "Caleb Williams" },
  { id: LOSER, cardId: LOSER, source: "checklistinsider", sport: "football", year: 2024, setKey: "topps-finest", cardNumber: "197", parallelSlug: "base-uncommon", isAuto: false, printRun: null, playerName: "Caleb Williams" },
];

const SALES = [
  // TRUE-DUPE: one physical sale, two vendors, SAME eBay item id.
  { id: "tca-ebay::777", cardId: WINNER, hobbyiqCardId: WINNER, source: "tca-ebay", sourceExternalId: "777",
    title: "2024 Topps Finest Caleb Williams #197 Uncommon", parallel: "Uncommon", cardNumber: "197",
    price: 40, soldAt: "2026-08-14T23:30:00Z", observedAt: "2026-08-15T01:00:00Z", gradeCompany: null, gradeValue: null, isAuto: false, printRun: null },
  { id: "cardhedge::777", cardId: WINNER, hobbyiqCardId: WINNER, source: "cardhedge", sourceExternalId: "777",
    title: "Caleb Williams Finest Uncommon", parallel: "Uncommon", cardNumber: "197",
    price: 40, soldAt: "2026-08-14T23:30:00Z", observedAt: "2026-08-16T01:00:00Z", gradeCompany: null, gradeValue: null, isAuto: false, printRun: null },
  // DISTINCT-CARDS: two different cards, different item ids, same price+day.
  // These collide ONLY because the retracted strip squashed the parallel.
  { id: "tca-ebay::111", cardId: WINNER, hobbyiqCardId: WINNER, source: "tca-ebay", sourceExternalId: "111",
    title: "2024 Topps Finest #197 Uncommon", parallel: "Uncommon", cardNumber: "197",
    price: 99, soldAt: "2026-08-20T10:00:00Z", observedAt: "2026-08-20T11:00:00Z", gradeCompany: null, gradeValue: null, isAuto: false, printRun: null },
  { id: "tca-ebay::222", cardId: LOSER, hobbyiqCardId: LOSER, source: "tca-ebay", sourceExternalId: "222",
    title: "2024 Topps Finest #197 Uncommon Refractor", parallel: "Uncommon Refractor", cardNumber: "197",
    price: 99, soldAt: "2026-08-20T10:00:00Z", observedAt: "2026-08-20T11:00:00Z", gradeCompany: null, gradeValue: null, isAuto: false, printRun: null },
];

/**
 * A stub @azure/cosmos. It is injected with `--require`, which patches the
 * module cache BEFORE the script runs: NODE_PATH does not work here, because
 * the real @azure/cosmos is installed in backend/node_modules and resolves
 * first, so the script would open a real network connection and hang.
 *
 * It answers the two queries the script makes and records every write, so a
 * write in report mode would be caught rather than merely unasserted.
 */
const STUB = `
const Module = require("module");
const CATALOG = ${JSON.stringify(CATALOG)};
const SALES = ${JSON.stringify(SALES)};
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
        if (text.includes("card_catalog") || text.includes("c.parallelSlug")) return iter(CATALOG);
        if (text.includes("c.hobbyiqCardId = @s")) {
          const slug = (q.parameters.find((p) => p.name === "@s") || {}).value;
          return iter(SALES.filter((s) => s.hobbyiqCardId === slug || String(s.hobbyiqCardId).startsWith(slug + ":")));
        }
        return iter([]);
      },
    },
    item: (id, pk) => ({
      patch: async (ops) => { writes.push({ container: name, id, pk, ops }); return {}; },
      delete: async () => { writes.push({ container: name, id, pk, op: "DELETE" }); throw new Error("must never delete"); },
      read: async () => ({ resource: null }),
    }),
  }) }; }
}
process.on("exit", () => {
  require("fs").writeFileSync(process.env.WRITES_OUT, JSON.stringify(writes));
});
// Intercept the require BEFORE the script runs, whatever is installed on disk.
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@azure/cosmos") return { CosmosClient };
  return realLoad.apply(this, arguments);
};
`;

function runTriage(env: Record<string, string>): { out: string; writes: unknown[] } {
  const stubPath = path.join(tmp, "cosmos-stub.cjs");
  fs.writeFileSync(stubPath, STUB);
  const writesOut = path.join(tmp, `writes-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(writesOut, "[]");

  let out = "";
  try {
    out = execFileSync(process.execPath, ["--require", stubPath, path.join(backend, "scripts", "triage-contenthash-collisions.cjs")], {
      cwd: backend,
      env: {
        PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "",
        COSMOS_CONNECTION_STRING: "AccountEndpoint=https://x/;AccountKey=x==;",
        TRIAGE_OUT: path.join(tmp, "triage.json"),
        WRITES_OUT: writesOut,
        ...env,
      },
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    out = String(err.stdout ?? "") + String(err.stderr ?? "");
  }
  return { out, writes: JSON.parse(fs.readFileSync(writesOut, "utf8")) };
}

describe("the triage classifies a real collision pair end to end", () => {
  const { out, writes } = runTriage({ SPORTS: "football", YEARS: "2024", MODE: "report" });

  it("runs to a report", () => {
    expect(out).toMatch(/REPORT ONLY -- nothing written/);
  });

  it("finds the collisions D30 would refuse over", () => {
    expect(out).toMatch(/COLLISIONS\s+2/);
  });

  it("classifies the shared-item-id pair as TRUE-DUPE and names a survivor", () => {
    expect(out).toMatch(/\[TRUE-DUPE\]/);
    expect(out).toMatch(/shared-sourceExternalId-cross-source/);
    expect(out).toMatch(/SURVIVOR/);
    // the richer real-id row survives; the other is listed to flag
    expect(out).toMatch(/FLAG\s+\S+/);
  });

  it("classifies the Uncommon / Uncommon Refractor pair as DISTINCT-CARDS", () => {
    expect(out).toMatch(/\[DISTINCT-CARDS\]/);
    expect(out).toMatch(/COLLAPSED AXIS\s+parallel: "Uncommon"\s+vs\s+"Uncommon Refractor"/);
  });

  it("finds the DISTINCT-CARDS pair via the LEGACY hash, and says so", () => {
    // The whole reason both hash forms are probed. Post-D31 the parallel is
    // hashed WHOLE, so these two no longer collide on the fresh hash -- only
    // on the pre-D31 hash the stored rows still carry. A fresh-hash-only probe
    // (which is all D30's pre-flight computes) sees none of this population.
    expect(out).toMatch(/\[legacy-only\]/);
    expect(out).toMatch(/of which legacy-only\s+1/);
  });

  it("D6: BOTH rows here are checklist-backed and disagree, so the destination is UNRESOLVED", () => {
    // The fixture is `beckett` vs `checklistinsider` -- two checklist sources
    // naming two different addresses for one card. Neither outranks the other,
    // so no row present has the authority to name the destination and the
    // honest answer is a checklist ruling from a person.
    //
    // The FIRST build printed a confident slug here, derived from whichever id
    // was the longer string (`base-uncommon`, by four characters). That was a
    // destination nobody had vouched for, offered to the D31 relocation lane as
    // though it had been decided.
    expect(out).toMatch(/RELOCATE/);
    expect(out).toMatch(/move, never delete/);
    expect(out).toMatch(/BASIS\s+unresolved: 2 checklist-backed rows disagree/);
    expect(out).toMatch(/UNRESOLVED -- checklist ruling needed/);
    // and it never invents one
    expect(out).not.toMatch(/->\s+hiq:football:2024:topps-finest:197:base-uncommon:no-auto\s/);
  });

  it("REPORT MODE WRITES NOTHING — not a patch, not a delete", () => {
    expect(writes).toEqual([]);
  });

  it("the summary counts one cluster in each class and reconciles", () => {
    expect(out).toMatch(/TRUE-DUPE\s+1/);
    expect(out).toMatch(/DISTINCT-CARDS\s+1/);
    expect(out).toMatch(/RECONCILES\s+2 clusters classified.*OK/);
  });
});

describe("apply-true-dupes flags ONLY the class it proved", () => {
  const { out, writes } = runTriage({
    SPORTS: "football", YEARS: "2024", MODE: "apply-true-dupes", BACKFILL_APPLY: "true",
  });

  it("writes exactly one flag — the TRUE-DUPE loser", () => {
    expect(out).toMatch(/APPLIED \(TRUE-DUPE flags only\)/);
    expect(writes).toHaveLength(1);
  });

  it("the write is a flaggedWrong patch with provenance, never a delete", () => {
    const w = writes[0] as { ops: { path: string; value: unknown }[]; op?: string };
    expect(w.op).not.toBe("DELETE");
    const paths = w.ops.map((o) => o.path);
    expect(paths).toContain("/flaggedWrong");
    expect(paths).toContain("/dedupSupersededBy");
    expect(paths).toContain("/dedupReason");
    expect(paths).toContain("/dedupAt");
    expect(w.ops.find((o) => o.path === "/flaggedWrong")?.value).toBe(true);
  });

  it("it flags a LOSER and never the survivor", () => {
    const w = writes[0] as { id: string };
    const survivor = /SURVIVOR\s+(\S+)/.exec(out)?.[1];
    expect(survivor).toBeTruthy();
    expect(w.id).not.toBe(survivor);
    // both rows of the true-dupe pair carry item id 777
    expect(["tca-ebay::777", "cardhedge::777"]).toContain(w.id);
  });

  it("neither DISTINCT-CARDS row is touched", () => {
    const ids = (writes as { id: string }[]).map((w) => w.id);
    expect(ids).not.toContain("tca-ebay::111");
    expect(ids).not.toContain("tca-ebay::222");
  });

  it("it reconciles what it intended against what it wrote", () => {
    expect(out).toMatch(/reconciled: intended 1 = written 1 \+ skipped 0 \+ failed 0/);
  });
});
