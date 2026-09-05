/**
 * CF-AN-ALIAS-IS-NOT-A-SECOND-POOL -- the alias reslug lane, pinned.
 *
 * #1783 declared `bellingham`, `1987-bellingham-baseball` and
 * `bellingham-mariners-team-issue` aliases of `bellingham-mariners`. That fixed
 * the deriver and moved no stored row, because post-alias the census compares a
 * row's stored identity against `normalizeSetKey(setName)`, finds them EQUAL,
 * calls the row AGREE -- and AGREE is never written. The pool stays split on
 * the old segment while the holding re-derives onto the ruled key.
 *
 * Four properties are pinned here, each with the mutation that must turn it
 * red:
 *
 *   1. an alias segment resolves to its ruled key;
 *   2. a NON-alias key is untouched, however similar it looks;
 *   3. ONLY the setKey segment changes -- number, parallel, auto, subset and
 *      print run are carried byte for byte (D28);
 *   4. an empty or inherited scope REFUSES, before a Cosmos client exists.
 *
 * Plus the guarantee the report mode has to carry: driven against a
 * call-recording fake container, a dry run performs NO container call at all --
 * not an upsert, not a read, not a delete.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lane = require("../scripts/reslug-ruled-alias.cjs");
const { slugParts, setKeyOfSlug, withSetKeySegment, ruledKeyForSlug, planAliasReslug } = lane;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { relocateSoldComp, stripSystem, contentHashOf } = require("../scripts/lib/relocate-sold-comp.cjs");

const RULED = "bellingham-mariners";
/** The exact table #1783 declared, as the lane narrows it: Map<alias, ruled>. */
const aliasMap = new Map<string, string>([
  ["bellingham", RULED],
  ["1987-bellingham-baseball", RULED],
  ["bellingham-mariners-team-issue", RULED],
]);

/** The three stored spellings of the 1987 Bellingham Mariners Griffey #15. */
const GRIFFEY_LONG = "hiq:baseball:1987:1987-bellingham-baseball:15:base:no-auto";
const GRIFFEY_TOWN = "hiq:baseball:1987:bellingham:15:base:no-auto";
const GRIFFEY_TEAM = "hiq:baseball:1987:bellingham-mariners-team-issue:15:base:no-auto";
const GRIFFEY_RULED = "hiq:baseball:1987:bellingham-mariners:15:base:no-auto";

describe("1. an alias segment resolves to the ruled key", () => {
  it("all three declared spellings land on the ruled slug", () => {
    for (const from of [GRIFFEY_LONG, GRIFFEY_TOWN, GRIFFEY_TEAM]) {
      const plan = planAliasReslug({ cardId: from, hobbyiqCardId: from, aliasMap });
      expect(plan.move).toBe(true);
      expect(plan.target).toBe(GRIFFEY_RULED);
      expect(plan.ruledKey).toBe(RULED);
    }
  });

  it("the alias it moved FROM is reported, so the banner can group by it", () => {
    expect(planAliasReslug({ cardId: GRIFFEY_TOWN, hobbyiqCardId: GRIFFEY_TOWN, aliasMap }).aliasWas)
      .toBe("bellingham");
    expect(planAliasReslug({ cardId: GRIFFEY_LONG, hobbyiqCardId: GRIFFEY_LONG, aliasMap }).aliasWas)
      .toBe("1987-bellingham-baseball");
  });

  it("a row ALREADY at the ruled key is not a move -- it is not double-counted", () => {
    const plan = planAliasReslug({ cardId: GRIFFEY_RULED, hobbyiqCardId: GRIFFEY_RULED, aliasMap });
    expect(plan.move).toBe(false);
  });

  it("BOTH identity fields are considered: an alias on EITHER puts the row in scope", () => {
    // The exact-pool reader ORs cardId and hobbyiqCardId, so a row matching on
    // either one is in the old pool and must move.
    const viaIdentity = planAliasReslug({ cardId: "tca-ebay::123", hobbyiqCardId: GRIFFEY_TOWN, aliasMap });
    expect(viaIdentity.move).toBe(true);
    expect(viaIdentity.target).toBe(GRIFFEY_RULED);
    // A legacy vendor partition key is preserved, never silently dropped.
    expect(viaIdentity.vendorCardIdWas).toBe("tca-ebay::123");

    // The partition key carries the alias while the identity field does not.
    const viaPartition = planAliasReslug({ cardId: GRIFFEY_TOWN, hobbyiqCardId: "", aliasMap });
    expect(viaPartition.move).toBe(true);
    expect(viaPartition.target).toBe(GRIFFEY_RULED);
  });

  it("a THIRD SLUG -- two hiq fields naming different cards -- is reported, not silently normalised", () => {
    const plan = planAliasReslug({ cardId: GRIFFEY_LONG, hobbyiqCardId: GRIFFEY_TOWN, aliasMap });
    expect(plan.move).toBe(true);
    expect(plan.target).toBe(GRIFFEY_RULED);
    expect(plan.thirdSlug).toBe(GRIFFEY_LONG);
  });
});

describe("2. a NON-alias key is untouched", () => {
  it("a key absent from the table is never rewritten, however similar it looks", () => {
    for (const other of [
      "hiq:baseball:1987:topps:15:base:no-auto",
      "hiq:baseball:1987:donruss:15:base:no-auto",
      // Similar-looking and NOT declared: the lane reads the table, it does not
      // pattern-match on the word "bellingham".
      "hiq:baseball:1987:bellingham-mariners-team-set:15:base:no-auto",
      "hiq:baseball:1988:bellinghams:15:base:no-auto",
    ]) {
      const plan = planAliasReslug({ cardId: other, hobbyiqCardId: other, aliasMap });
      expect(plan.move, `${other} must not move`).toBe(false);
      expect(ruledKeyForSlug(other, aliasMap)).toBeNull();
    }
  });

  it("MUTATION: a substring rule instead of a table lookup turns the above red", () => {
    // The tempting shortcut -- "if the key contains the ruled key's stem, fold
    // it" -- swallows `bellingham-mariners-team-set`, a key nobody ruled.
    const buggy = (slug: string) => {
      const k = setKeyOfSlug(slug);
      return k && k.includes("bellingham") && k !== RULED ? RULED : null;
    };
    const undeclared = "hiq:baseball:1987:bellingham-mariners-team-set:15:base:no-auto";
    expect(buggy(undeclared)).toBe(RULED);              // <- the bug
    expect(ruledKeyForSlug(undeclared, aliasMap)).toBeNull(); // <- the lane
  });

  it("an unrelated sport/year carrying a declared alias still resolves -- the table is the scope", () => {
    // The alias table is not year-scoped; the YEARS/SPORTS filters are applied
    // by the sweep, not by the predicate. Pinned so the two stay distinct.
    const other = "hiq:baseball:1988:bellingham:15:base:no-auto";
    expect(planAliasReslug({ cardId: other, hobbyiqCardId: other, aliasMap }).target)
      .toBe("hiq:baseball:1988:bellingham-mariners:15:base:no-auto");
  });
});

describe("3. ONLY the setKey segment changes (D28: surgery, never a recompute)", () => {
  const cases: Array<[string, string]> = [
    // plain
    [GRIFFEY_TOWN, GRIFFEY_RULED],
    // a parallel and an auto flag the current resolver might spell differently
    ["hiq:baseball:1987:bellingham:15:gold-refractor:auto",
     "hiq:baseball:1987:bellingham-mariners:15:gold-refractor:auto"],
    // a print run rides along untouched
    ["hiq:baseball:1987:bellingham:15:gold-refractor:auto:num-499",
     "hiq:baseball:1987:bellingham-mariners:15:gold-refractor:auto:num-499"],
    // a subset segment sits between setKey and number and must survive
    ["hiq:baseball:1987:bellingham:sub-team:15:base:no-auto",
     "hiq:baseball:1987:bellingham-mariners:sub-team:15:base:no-auto"],
    // a 1/1
    ["hiq:baseball:1987:bellingham:15:black-prism-refractor:no-auto:num-1",
     "hiq:baseball:1987:bellingham-mariners:15:black-prism-refractor:no-auto:num-1"],
  ];

  it("every other segment is carried byte for byte", () => {
    for (const [from, want] of cases) {
      expect(withSetKeySegment(from, RULED)).toBe(want);
      // Segment-by-segment: only index 3 may differ.
      const a = String(from).split(":");
      const b = String(want).split(":");
      expect(b.length).toBe(a.length);
      for (let i = 0; i < a.length; i++) {
        if (i === 3) expect(b[i]).toBe(RULED);
        else expect(b[i], `segment ${i} must be untouched`).toBe(a[i]);
      }
    }
  });

  it("the parallel is NEVER re-derived -- a gold refractor stays gold", () => {
    // The Bowman Draft re-slug turned `gold-refractor` into `refractor` by
    // re-deriving from the title, caught in dry run. A vendor title routinely
    // omits the parallel the existing slug already captured correctly.
    const from = "hiq:baseball:1987:bellingham:15:gold-refractor:auto:num-499";
    const plan = planAliasReslug({ cardId: from, hobbyiqCardId: from, aliasMap });
    expect(plan.target).toContain(":gold-refractor:");
    expect(plan.target).not.toContain(":refractor:");
  });

  it("MUTATION: dropping the 'only segment 3' restriction turns this red", () => {
    // The mutation is a rebuild that also normalises the parallel -- the exact
    // shape of a full recompute riding along on a product move.
    const buggy = (slug: string, setKey: string) => {
      const p = String(slug).split(":");
      p[3] = setKey;
      p[5] = String(p[5]).replace(/^.*-refractor$/, "refractor"); // <- the extra write
      return p.join(":");
    };
    const from = "hiq:baseball:1987:bellingham:15:gold-refractor:auto:num-499";
    const want = "hiq:baseball:1987:bellingham-mariners:15:gold-refractor:auto:num-499";
    expect(withSetKeySegment(from, RULED)).toBe(want);
    expect(buggy(from, RULED)).not.toBe(want);
    expect(buggy(from, RULED)).toContain(":refractor:");
  });

  it("MUTATION: writing the ruled key to the wrong index turns this red", () => {
    const buggy = (slug: string, setKey: string) => {
      const p = String(slug).split(":");
      p[4] = setKey; // the card number, not the setKey
      return p.join(":");
    };
    expect(withSetKeySegment(GRIFFEY_TOWN, RULED)).toBe(GRIFFEY_RULED);
    expect(buggy(GRIFFEY_TOWN, RULED)).not.toBe(GRIFFEY_RULED);
  });

  it("a WRONG card number is carried across, not quietly corrected", () => {
    // Observed live: the pool's highest-priced sale ($6,151 PSA 10) is a
    // genuine #15 Griffey filed at `:1:`, because the number parser read the
    // draft position out of "*87 #1 Pick** Bellingham Team #15 XRC".
    //
    // This lane must NOT fix it. Rewriting a segment because it looks wrong is
    // a recompute wearing a re-key's clothes -- exactly what D28 forbids. The
    // row moves product and keeps its (wrong) number; the cardNumber repair is
    // its own lane.
    const from = "hiq:baseball:1987:bellingham:1:base:no-auto";
    const plan = planAliasReslug({ cardId: from, hobbyiqCardId: from, aliasMap });
    expect(plan.target).toBe("hiq:baseball:1987:bellingham-mariners:1:base:no-auto");
    expect(plan.target).toContain(":1:");
    expect(plan.target).not.toContain(":15:");
  });

  it("a malformed or foreign id is refused rather than mangled", () => {
    for (const bad of ["", "not-a-slug", "hiq:baseball:1987", "tca-ebay::12345",
      "hiq:baseball:19x7:bellingham:15:base:no-auto", "hiq:baseball:1987::15:base:no-auto"]) {
      expect(slugParts(bad), bad).toBeNull();
      expect(withSetKeySegment(bad, RULED), bad).toBeNull();
    }
  });
});

describe("4. an empty or inherited scope REFUSES", () => {
  const scriptPath = join(__dirname, "..", "scripts", "reslug-ruled-alias.cjs");

  it("empty, 'refractor' and 'all' each exit 1 before any Cosmos client", () => {
    for (const bad of ["", "refractor", "all"]) {
      const r = spawnSync(process.execPath, [scriptPath], {
        // No connection string: the scope refusal must come FIRST, so a bad
        // scope can never reach a connected client even by accident.
        env: { ...process.env, SCOPE: bad, COSMOS_CONNECTION_STRING: "", BACKFILL_APPLY: "true" },
        encoding: "utf8",
      });
      expect(r.status, `SCOPE=${bad}`).toBe(1);
      expect(String(r.stderr)).toContain("SCOPE is required and names the RULED KEY");
      // It refused for the RIGHT reason -- not because Cosmos was missing.
      expect(String(r.stderr)).not.toContain("COSMOS_CONNECTION_STRING");
    }
  });

  it("a scope that is not a ruled destination refuses too, and names the valid ones", () => {
    const r = spawnSync(process.execPath, [scriptPath], {
      env: { ...process.env, SCOPE: "not-a-ruled-key", COSMOS_CONNECTION_STRING: "", BACKFILL_APPLY: "true" },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(String(r.stderr)).toContain("is not a ruled alias destination");
    // A scope that matches nothing must refuse, never sweep nothing and report green.
    expect(String(r.stderr)).toContain("Ruled destinations");
  });

  it("the RULED scope passes the guards and stops only for want of a connection", () => {
    const r = spawnSync(process.execPath, [scriptPath], {
      env: { ...process.env, SCOPE: RULED, COSMOS_CONNECTION_STRING: "", BACKFILL_APPLY: "" },
      encoding: "utf8",
    });
    expect(String(r.stderr)).toContain("COSMOS_CONNECTION_STRING not set");
    expect(String(r.stderr)).not.toContain("is not a ruled alias destination");
  });
});

/** A call-RECORDING stand-in for a Cosmos container. Every method appends to
 *  `calls` before doing anything, so "no write happened" is provable as "no
 *  call happened at all" rather than inferred from an unchanged store. */
function recordingPool(seed: Record<string, unknown>[]) {
  const key = (id: string, cardId: string) => `${cardId} ${id}`;
  const store = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  for (const d of seed) store.set(key(String(d.id), String(d.cardId)), { ...d });
  const notFound = () => Object.assign(new Error("NotFound"), { code: 404 });
  return {
    store,
    calls,
    item(id: string, cardId: string) {
      return {
        read: async () => {
          calls.push(`read ${key(id, cardId)}`);
          const r = store.get(key(id, cardId));
          if (!r) throw notFound();
          return { resource: { ...r } };
        },
        delete: async () => {
          calls.push(`delete ${key(id, cardId)}`);
          if (!store.delete(key(id, cardId))) throw notFound();
          return {};
        },
      };
    },
    items: {
      upsert: async (doc: Record<string, unknown>) => {
        calls.push(`upsert ${key(String(doc.id), String(doc.cardId))}`);
        store.set(key(String(doc.id), String(doc.cardId)), { ...doc });
        return { resource: { ...doc } };
      },
    },
  };
}

/** The lane's per-row write, exactly as the script performs it. */
async function runLaneMove(
  pool: ReturnType<typeof recordingPool>,
  row: Record<string, unknown>,
  dryRun: boolean,
) {
  const plan = planAliasReslug({ cardId: row.cardId, hobbyiqCardId: row.hobbyiqCardId, aliasMap });
  const keep = stripSystem(row);
  if (plan.vendorCardIdWas) keep.vendorCardIdWas = plan.vendorCardIdWas;
  keep.cardId = plan.target;
  keep.hobbyiqCardId = plan.target;
  keep.setKey = plan.ruledKey;
  keep.normalizedSetKey = plan.ruledKey;
  keep.rekeyedSetKeyWas = plan.aliasWas;
  keep.rekeyedFrom = plan.identityWas;
  keep.rekeyedAt = new Date().toISOString();
  keep.rekeyedReason = lane.REASON;
  keep.contentHash = contentHashOf(keep);
  const res = await relocateSoldComp(pool, {
    keep,
    drop: [{ id: row.id, cardId: row.cardId }],
    verifyFields: ["cardId", "hobbyiqCardId", "setKey", "contentHash", "rekeyedFrom"],
    dryRun,
  });
  return { res, plan, keep };
}

const griffeyRow = () => ({
  id: "tca-ebay::EBAY-v1|1987bellingham|0",
  cardId: GRIFFEY_LONG,
  hobbyiqCardId: GRIFFEY_LONG,
  title: "1987 Bellingham Mariners Team Issue #15 Ken Griffey Jr. RC",
  setName: "1987 Bellingham Baseball",
  price: 1250,
  soldAt: "2026-08-21T06:25:43.000Z",
  parallel: "Base",
  isAuto: false,
});

describe("the dry run is provably write-free", () => {
  it("a report-mode move performs NO container call at all", async () => {
    const pool = recordingPool([griffeyRow()]);
    const { res } = await runLaneMove(pool, griffeyRow(), /* dryRun */ true);

    expect(res.stage).toBe("dry-run");
    expect(res.ok).toBe(true);
    // The guarantee, stated as the absence of every call -- not as an
    // unchanged store, which a compensating pair of writes could also produce.
    expect(pool.calls).toEqual([]);
    expect(pool.store.size).toBe(1);
    expect([...pool.store.values()][0].cardId).toBe(GRIFFEY_LONG);
    expect([...pool.store.values()][0].hobbyiqCardId).toBe(GRIFFEY_LONG);
  });

  it("the SAME row in apply mode moves both fields and drops the old row", async () => {
    // The counterfactual: identical input, dryRun off. If this did not write,
    // the test above would prove nothing.
    const pool = recordingPool([griffeyRow()]);
    const { res, keep } = await runLaneMove(pool, griffeyRow(), /* dryRun */ false);

    expect(res.ok).toBe(true);
    expect(res.stage).toBe("done");
    expect(res.duplicatesLeft).toHaveLength(0);
    // upsert -> read back -> delete, in that order: a sale is never lost.
    expect(pool.calls.filter((c) => c.startsWith("upsert"))).toHaveLength(1);
    expect(pool.calls.filter((c) => c.startsWith("delete"))).toHaveLength(1);
    expect(pool.calls.findIndex((c) => c.startsWith("upsert")))
      .toBeLessThan(pool.calls.findIndex((c) => c.startsWith("delete")));

    const rows = [...pool.store.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0].cardId).toBe(GRIFFEY_RULED);
    expect(rows[0].hobbyiqCardId).toBe(GRIFFEY_RULED);
    // The old pool no longer reaches it by EITHER field.
    expect(rows[0].cardId).not.toBe(GRIFFEY_LONG);
    expect(rows[0].hobbyiqCardId).not.toBe(GRIFFEY_LONG);
    // The ledger is stamped.
    expect(rows[0].rekeyedFrom).toBe(GRIFFEY_LONG);
    expect(rows[0].rekeyedSetKeyWas).toBe("1987-bellingham-baseball");
    expect(rows[0].rekeyedReason).toBe(lane.REASON);
    expect(String(rows[0].rekeyedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The sale itself is carried across untouched.
    expect(rows[0].price).toBe(1250);
    expect(rows[0].title).toBe(griffeyRow().title);
    // THE HASH FOLLOWS THE ADDRESS -- cardId is its first component.
    expect(rows[0].contentHash).toBe(keep.contentHash);
    expect(rows[0].contentHash).not.toBe(contentHashOf(griffeyRow()));
  });

  it("MUTATION: a hash left at the old address is invisible to pre-write dedup", () => {
    const moved = { ...griffeyRow(), cardId: GRIFFEY_RULED, hobbyiqCardId: GRIFFEY_RULED };
    expect(contentHashOf(moved)).not.toBe(contentHashOf(griffeyRow()));
  });
});

describe("the lane source keeps its guarantees", () => {
  const script = readFileSync(join(__dirname, "..", "scripts", "reslug-ruled-alias.cjs"), "utf8");
  const body = script.slice(script.indexOf("async function main()"));

  it("APPLY comes from BACKFILL_APPLY -- the runner exports that, not APPLY", () => {
    expect(script).toContain('String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true"');
  });

  it("every partition move goes through relocateSoldComp, never a hand-rolled delete", () => {
    // CF-A-SALE-IS-NEVER-LOST (D19) owns the upsert-verify-delete ordering.
    expect(script).toContain("relocateSoldComp");
    expect(body).not.toMatch(/pool\.item\([^)]*\)\.delete\(/);
  });

  it("BOTH identity fields are verified on the relocate call", () => {
    const vf = /verifyFields:\s*\[([^\]]*)\]/.exec(script)?.[1] ?? "";
    expect(vf).toContain('"cardId"');
    expect(vf).toContain('"hobbyiqCardId"');
    expect(vf).toContain('"contentHash"');
  });

  it("the contentHash is computed AFTER both identity fields are final", () => {
    const pk = body.indexOf("keep.cardId = plan.target");
    const hiq = body.indexOf("keep.hobbyiqCardId = plan.target");
    const hash = body.indexOf("keep.contentHash = contentHashOf(keep)");
    expect(pk).toBeGreaterThan(-1);
    expect(hash).toBeGreaterThan(pk);
    expect(hash).toBeGreaterThan(hiq);
  });

  it("the alias table is READ from ruledAliases(), never retyped", () => {
    expect(script).toContain("ruledAliases");
    // No hardcoded destination anywhere in the executable body -- the ruling
    // lives in setKeyReconciliation and a copy here could drift from it.
    expect(body).not.toContain('"bellingham-mariners"');
  });

  it("the catalog side is reported and never written", () => {
    expect(script).toContain("REPORTED, NEVER WRITTEN");
    // No catalog mutation of any kind.
    expect(body).not.toMatch(/cat\.item\([^)]*\)\.(patch|delete|replace)\(/);
    expect(body).not.toMatch(/cat\.items\.(upsert|create)\(/);
  });

  it("the reconciliation closes: intended = written + skipped + failed", () => {
    expect(script).toContain("reconciled: intended");
    expect(script).toContain("reportWrites({ job: \"reslug-ruled-alias\"");
  });

  it("sharding is OPT-IN through the shared helper, not an inherited default", () => {
    // CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD: slot=0/slots=16 is the
    // runner's default and must sweep EVERY row.
    expect(script).toContain("runnerShardScope");
    expect(script).not.toMatch(/Number\(process\.env\.SLOTS[^)]*\)\s*\|\|\s*16/);
  });
});

describe("the runner can dispatch this script", () => {
  const repoRoot = join(__dirname, "..", "..");
  const runner = readFileSync(join(repoRoot, ".github", "workflows", "backfill-runner.yml"), "utf8");

  it("is on the script whitelist -- the dropdown IS the gate", () => {
    expect(runner.replace(/\r\n/g, "\n")).toContain("          - reslug-ruled-alias\n");
  });

  it("the exec is generic, which is what makes the dropdown the gate", () => {
    expect(runner).toContain('node "backend/scripts/${{ inputs.script }}.cjs"');
  });

  it("the runner passes SCOPE through, so the ruled key is dispatchable", () => {
    expect(runner).toMatch(/SCOPE:\s*\$\{\{\s*inputs\.scope\s*\}\}/);
  });

  it("adds no new runner input -- the lane rides the 24 that exist", () => {
    // CF-THE-RUNNER-HAS-24-INPUTS: workflow_dispatch caps at 25.
    const dispatchBlock = runner.slice(runner.indexOf("  workflow_dispatch:"), runner.indexOf("jobs:"));
    const inputNames = [...dispatchBlock.matchAll(/^      ([a-z_]+):$/gm)].map((m) => m[1]);
    expect(inputNames.length).toBeLessThanOrEqual(25);
    expect(inputNames).toContain("scope");
    expect(inputNames).toContain("apply");
    expect(inputNames).toContain("years");
    expect(inputNames).toContain("sports");
  });
});
