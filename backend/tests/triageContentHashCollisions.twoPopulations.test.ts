/**
 * D7 — TWO POPULATIONS, LABELLED HONESTLY, AND A SCOPE THAT REFUSES.
 *
 * THE FALSE CLAIM. The triage's header said it re-derives "EXACTLY the
 * population D30 refuses over". It did not. It iterated EVERY multi-row identity
 * group, while D30's plan filters each one through `kindInMode`, the D23
 * rename-owned skip, the mid-rename address check and `decideDuplicateGroup` —
 * most groups never reach D30's pre-flight at all. It also bucketed on the
 * LEGACY hash, which D30's pre-flight never computes. Both differences widen the
 * report, which is the safe direction, but a number that cannot be reconciled
 * against the 278/103 cannot unblock the thing that refused with 278/103.
 *
 * So the report names both sets and counts them apart:
 *   (a) D30-REFUSAL SET     D30's own plan, fresh hash, live rows
 *   (b) FULL COLLISION SET  every multi-row group, legacy hashes included
 *
 * THE SCOPE. `SCOPE` is only ever tested `!== "all"` — in this script AND in
 * D30. It narrows nothing in either, so the eight football shards' historical
 * `-f scope=refractor` narrowed nothing there either. A silently ignored scope
 * makes the run's own banner a lie, so a non-'all' value is now REFUSED.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hiq-triage-pops-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

// GROUP 1 — the base-glue pair D30 DOES fold. Its sales carry the TRUE-DUPE
// (shared item id 777) and the DISTINCT-CARDS pair (Uncommon vs Uncommon
// Refractor, which collides only under the legacy hash).
const W1 = "hiq:football:2024:topps-finest:197:uncommon:no-auto";
const L1 = "hiq:football:2024:topps-finest:197:base-uncommon:no-auto";
// GROUP 2 — ONE identity group under groupKeyOf that D30's plan REFUSES to
// fold: two checklist-backed rows naming two different print runs of one
// product (`two-checklist-print-runs-one-product` -> ambiguous, straight to
// Drew). Its sales still collide, so it is in the FULL set and out of the
// REFUSAL set — which is the entire point of separating the two.
// The two ids are SIBLINGS, not prefix-extensions of each other: `salesUnder`
// reads `id OR STARTSWITH(id + ':')`, so an id that extends its groupmate would
// have both rows' sales probed twice and inflate the FULL count for a reason
// that has nothing to do with the populations under test.
const W2 = "hiq:football:2024:topps-finest:5:base-99:no-auto";
const L2 = "hiq:football:2024:topps-finest:5:base-25:no-auto";

const CATALOG = [
  { id: W1, cardId: W1, source: "beckett", sport: "football", year: 2024, setKey: "topps-finest", cardNumber: "197", parallelSlug: "uncommon", isAuto: false, printRun: null, playerName: "Caleb Williams" },
  { id: L1, cardId: L1, source: "tca-ebay", sport: "football", year: 2024, setKey: "topps-finest", cardNumber: "197", parallelSlug: "base-uncommon", isAuto: false, printRun: null, playerName: "Caleb Williams" },
  { id: W2, cardId: W2, source: "beckett", sport: "football", year: 2024, setKey: "topps-finest", cardNumber: "5", parallelSlug: "base", isAuto: false, printRun: 99, playerName: "Rome Odunze" },
  { id: L2, cardId: L2, source: "checklistinsider", sport: "football", year: 2024, setKey: "topps-finest", cardNumber: "5", parallelSlug: "base", isAuto: false, printRun: 25, playerName: "Rome Odunze" },
];

const sale = (over: Record<string, unknown>) => ({
  gradeCompany: null, gradeValue: null, isAuto: false, printRun: null,
  observedAt: "2026-08-15T01:00:00Z", ...over,
});

const SALES = [
  // group 1, TRUE-DUPE: one listing, two vendors, identity agrees
  sale({ id: "tca-ebay::777", cardId: W1, hobbyiqCardId: W1, source: "tca-ebay", sourceExternalId: "777",
    title: "2024 Topps Finest Caleb Williams #197 Uncommon", parallel: "Uncommon", cardNumber: "197",
    price: 40, soldAt: "2026-08-14T23:30:00Z" }),
  sale({ id: "cardhedge::777", cardId: L1, hobbyiqCardId: L1, source: "cardhedge", sourceExternalId: "777",
    title: "Caleb Williams Finest Uncommon", parallel: "Uncommon", cardNumber: "197",
    price: 40, soldAt: "2026-08-14T23:30:00Z", observedAt: "2026-08-16T01:00:00Z" }),
  // group 1, DISTINCT-CARDS: legacy hash only
  sale({ id: "tca-ebay::111", cardId: W1, hobbyiqCardId: W1, source: "tca-ebay", sourceExternalId: "111",
    title: "2024 Topps Finest #197 Uncommon", parallel: "Uncommon", cardNumber: "197",
    price: 99, soldAt: "2026-08-20T10:00:00Z" }),
  sale({ id: "tca-ebay::222", cardId: L1, hobbyiqCardId: L1, source: "tca-ebay", sourceExternalId: "222",
    title: "2024 Topps Finest #197 Uncommon Refractor", parallel: "Uncommon Refractor", cardNumber: "197",
    price: 99, soldAt: "2026-08-20T10:00:00Z" }),
  // group 2, a collision inside a group D30's plan never reaches
  sale({ id: "tca-ebay::888", cardId: W2, hobbyiqCardId: W2, source: "tca-ebay", sourceExternalId: "888",
    title: "2024 Topps Chrome Rome Odunze #5", parallel: "Base", cardNumber: "5",
    price: 12, soldAt: "2026-08-18T12:00:00Z" }),
  sale({ id: "cardhedge::888", cardId: L2, hobbyiqCardId: L2, source: "cardhedge", sourceExternalId: "888",
    title: "Rome Odunze Chrome", parallel: "Base", cardNumber: "5",
    price: 12, soldAt: "2026-08-18T12:00:00Z", observedAt: "2026-08-19T01:00:00Z" }),
];

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
        if (text.includes("c.parallelSlug")) return iter(CATALOG);
        if (text.includes("c.hobbyiqCardId = @s")) {
          const slug = (q.parameters.find((p) => p.name === "@s") || {}).value;
          return iter(SALES.filter((s) => s.hobbyiqCardId === slug || String(s.hobbyiqCardId).startsWith(slug + ":")));
        }
        return iter([]);
      },
    },
    item: (id, pk) => ({
      patch: async (ops) => { writes.push({ id, pk, ops }); return {}; },
      delete: async () => { writes.push({ id, pk, op: "DELETE" }); throw new Error("must never delete"); },
      read: async () => ({ resource: null }),
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

function runTriage(env: Record<string, string>): { out: string; code: number | null; findings: Record<string, unknown> } {
  const stubPath = path.join(tmp, "stub.cjs");
  fs.writeFileSync(stubPath, STUB);
  const writesOut = path.join(tmp, `writes-${Math.random().toString(36).slice(2)}.json`);
  const outJson = path.join(tmp, `triage-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(writesOut, "[]");

  let out = "";
  let code: number | null = 0;
  try {
    out = execFileSync(process.execPath, ["--require", stubPath, path.join(backend, "scripts", "triage-contenthash-collisions.cjs")], {
      cwd: backend,
      env: {
        PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "",
        COSMOS_CONNECTION_STRING: "AccountEndpoint=https://x/;AccountKey=x==;",
        TRIAGE_OUT: outJson, WRITES_OUT: writesOut, ...env,
      },
      encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    code = err.status ?? null;
    out = String(err.stdout ?? "") + String(err.stderr ?? "");
  }
  let findings: Record<string, unknown> = {};
  try { findings = JSON.parse(fs.readFileSync(outJson, "utf8")); } catch { /* refusals write none */ }
  return { out, code, findings };
}

describe("D7 — the two populations are counted apart", () => {
  const { out, findings } = runTriage({ SPORTS: "football", YEARS: "2024", MODE: "report" });

  it("both sets are named in the report", () => {
    expect(out).toMatch(/\(a\) D30-REFUSAL SET/);
    expect(out).toMatch(/\(b\) FULL COLLISION SET/);
  });

  it("the FULL set sees both groups' collisions", () => {
    // group 1: the true-dupe pair and the legacy-only distinct pair.
    // group 2: the pair inside the group D30 skips.
    expect(out).toMatch(/\(b\) FULL COLLISION SET\s+<-[\s\S]*?COLLISIONS\s+3/);
  });

  it("the REFUSAL set sees ONLY what D30's own plan would hash", () => {
    // D30 plans group 1 (base-glue) and skips group 2 (id-setkey-drift, and its
    // ids disagree with its setKey fields -> the mid-rename address check).
    // Within group 1, only the TRUE-DUPE pair collides under the FRESH hash.
    const m = /\(a\) D30-REFUSAL SET\s+\[[^\]]*\]\s+<-[\s\S]*?COLLISIONS\s+(\d+) in (\d+) group/.exec(out);
    expect(m, `no refusal-set COLLISIONS line:\n${out.slice(0, 3000)}`).toBeTruthy();
    expect(Number(m![1])).toBe(1);
    expect(Number(m![2])).toBe(1);
  });

  it("the refusal set is SMALLER than the full set, and the report says why", () => {
    // Anchor on the SECTION headers (the ones ending in `<-`), not on the
    // banner lines that merely mention both names — a non-greedy scan from the
    // banner finds section (a)'s count under section (b)'s label.
    const refusal = Number(/\(a\) D30-REFUSAL SET\s+\[[^\]]*\]\s+<-[\s\S]*?COLLISIONS\s+(\d+)/.exec(out)![1]);
    const full = Number(/\(b\) FULL COLLISION SET\s+<-[\s\S]*?COLLISIONS\s+(\d+)/.exec(out)![1]);
    expect(refusal).toBeLessThan(full);
    expect(out).toMatch(/WHY THE TWO DIFFER/);
    expect(out).toMatch(/Relocating those CANNOT lower \(a\)/);
  });

  it("it names, by reason, the groups D30's plan skips", () => {
    expect(out).toMatch(/groups D30's plan SKIPS/);
    expect(out).toMatch(/mid-rename-address|d23-rename-owned|not-a-group|ambiguous|out-of-mode/);
  });

  it("every finding says which population it is in", () => {
    const list = (findings as { findings: { class: string; inD30RefusalSet: boolean; d30Unreachable: string | null }[] }).findings;
    expect(list.length).toBeGreaterThan(0);
    for (const f of list) expect(typeof f.inD30RefusalSet).toBe("boolean");
    // the DISTINCT-CARDS cluster collides only on the legacy hash, so it is in
    // the full set and NOT in the refusal set -- the compound point: relocating
    // it cannot lower D30's count, because D30 never counted it.
    const distinct = list.find((f) => f.class === "DISTINCT-CARDS");
    expect(distinct).toBeTruthy();
    expect(distinct!.inD30RefusalSet).toBe(false);
  });

  it("the JSON carries both populations for reconciliation against the 278/103", () => {
    const pops = (findings as { populations: Record<string, Record<string, number>> }).populations;
    expect(pops.d30RefusalSet.collisions).toBe(1);
    expect(pops.fullCollisionSet.collisions).toBe(3);
    expect(pops.fullCollisionSet.legacyOnly).toBe(1);
  });
});

describe("D7 — D30_MODE selects which of D30's kinds the refusal set replicates", () => {
  it("D30_MODE=numbered reaches none of these groups, so the refusal set is empty", () => {
    const { out } = runTriage({ SPORTS: "football", YEARS: "2024", D30_MODE: "numbered" });
    expect(out).toMatch(/D30_MODE=numbered/);
    expect(out).toMatch(/\(a\) D30-REFUSAL SET\s+\[[^\]]*\]\s+<-[\s\S]*?COLLISIONS\s+0 in 0 group/);
    // the FULL set is unchanged -- it is not a function of D30's mode
    expect(out).toMatch(/\(b\) FULL COLLISION SET\s+<-[\s\S]*?COLLISIONS\s+3/);
  });

  it("an unknown D30_MODE is refused rather than silently defaulted", () => {
    const { code, out } = runTriage({ SPORTS: "football", D30_MODE: "not-a-mode" });
    expect(code).toBe(1);
    expect(out).toMatch(/D30_MODE="not-a-mode" is not one of/);
  });

  it("the default is `all` — what the eight football shards actually dispatched", () => {
    const { out } = runTriage({ SPORTS: "football", YEARS: "2024" });
    expect(out).toMatch(/D30_MODE=all/);
  });
});

describe("D6 — end to end: one checklist row in the group DOES name a destination", () => {
  // GROUP 1's loser here is `tca-ebay` (a VENDOR), so exactly one row is
  // checklist-backed and it names the address — even though its id is the
  // SHORTER of the two, which is what the retracted longest-string rule got
  // backwards.
  const { out } = runTriage({ SPORTS: "football", YEARS: "2024", MODE: "report" });

  it("the basis is the checklist row, and it is named", () => {
    expect(out).toMatch(/BASIS\s+checklist-backed: checklist-backed catalog row \[beckett\] names the address/);
  });

  it("the destination is the CHECKLIST row's address, not the longer vendor id", () => {
    // W1 (checklist, beckett) is four characters SHORTER than L1 (vendor,
    // tca-ebay). The retracted rule picked the longer string and would have
    // named L1 here.
    expect(W1.length).toBeLessThan(L1.length);
    expect(out).toMatch(/->\s+hiq:football:2024:topps-finest:197:uncommon:no-auto\s+\(D31 lane/);
  });

  it("a row already carrying its OWN distinct slug keeps it, flagged for verification", () => {
    // `tca-ebay::222` sits at L1, which is not the basis and does not extend it,
    // so the pre-existing rule applies: that slug IS the answer, and it is
    // handed to a human to check rather than silently rewritten. The basis
    // decides where a row with NO distinct address of its own belongs.
    expect(out).toMatch(/->\s+hiq:football:2024:topps-finest:197:base-uncommon:no-auto\s+\(already distinct -- verify against the checklist\)/);
  });
});

describe("D7 — SCOPE cannot filter, so it REFUSES instead of lying", () => {
  it("SCOPE=refractor is refused, loudly, with exit 1", () => {
    // The value the eight football shards were dispatched with. It narrowed
    // nothing then, in D30 or here, and pretending otherwise misattributes the
    // 278 to a slice it was never measured on.
    const { code, out } = runTriage({ SPORTS: "football", YEARS: "2024", SCOPE: "refractor" });
    expect(code).toBe(1);
    expect(out).toMatch(/SCOPE="refractor" cannot narrow anything/);
    expect(out).toMatch(/SPORTS, YEARS and SLOT\/SLOTS/);
  });

  it("it says D30 has the same defect, so nobody re-derives it", () => {
    const { out } = runTriage({ SPORTS: "football", SCOPE: "refractor" });
    expect(out).toMatch(/consolidate-catalog-duplicates is the same/);
  });

  it("for 'refractor' specifically it names the runner default as the cause", () => {
    // The runner's `scope` input DEFAULTS to "refractor". An operator hitting
    // this refusal has inherited the value, not chosen it, and the message has
    // to say so or the refusal reads as a bug in the dispatch.
    const { out } = runTriage({ SPORTS: "football", YEARS: "2024", SCOPE: "refractor" });
    expect(out).toMatch(/DEFAULTS to "refractor"/);
    expect(out).toMatch(/-f scope=all/);
  });

  it("SCOPE=all is still accepted — it is the whole-catalog opt-in", () => {
    const { code, out } = runTriage({ SCOPE: "all" });
    expect(code).toBe(0);
    expect(out).toMatch(/SCOPE=all/);
  });

  it("an EMPTY scope with SPORTS/YEARS is fine — scope is not required", () => {
    const { code } = runTriage({ SPORTS: "football", YEARS: "2024", SCOPE: "" });
    expect(code).toBe(0);
  });

  it("the banner tells the operator which axes actually narrow a run", () => {
    const { out } = runTriage({ SPORTS: "football", YEARS: "2024" });
    expect(out).toMatch(/SCOPE narrows NOTHING in this script or in D30/);
  });
});
