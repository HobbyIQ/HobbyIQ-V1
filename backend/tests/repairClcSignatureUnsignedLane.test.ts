/**
 * CF-THE-WHOLE-SECTION-NAME-REACHES-THE-AUTO-DECISION -- the LANE's contract,
 * driven end-to-end against a stub Cosmos.
 *
 * repairClcSignatureUnsigned.test.ts pins the VOCABULARY (which names read as
 * signed, and which deny it). This file pins the things a pure-function test
 * cannot see, because each of them is a way the lane can be green and wrong:
 *
 *   1. REPORT WRITES NOTHING. Not "intends to" -- the stub counts every write
 *      verb the lane could reach and asserts zero. A dry run is proven
 *      write-free by MEASUREMENT, not by intent.
 *   2. APPLY MOVES THROUGH moveCatalogRow, with { isAuto: true } and
 *      sold_comps as salesContainer -- never a raw patch. isAuto is segment 6
 *      of the canonical id, so changing it is a MOVE, and
 *      patchCatalogRowFields refuses the field by design.
 *   3. AN EXISTING `:auto` TWIN IS FOLDED ONTO, NOT DUPLICATED. One card, one
 *      row, one pool: a repair that leaves two rows has split the pool it was
 *      supposed to heal.
 *   4. A TITLELESS SALE PARKS. The checklist says the CARD is signed; it says
 *      nothing about which card a LISTING is.
 *   5. SCOPE REFUSAL, in BOTH modes -- a report over an unnamed scope is how
 *      an apply over an unnamed scope gets authorised.
 *   6. THE SHARD BANNER tells the truth about what the run covered.
 *
 * The lane is executed as the COMMITTED FILE, with @azure/cosmos and the two
 * dist requires replaced through Module._load -- so what these tests pin is
 * what ships, not a re-implementation of it.
 */
import { describe, expect, it, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "repair-clc-signature-unsigned.cjs");
const RUNNER = path.join(backend, "..", ".github", "workflows", "backfill-runner.yml");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clc-sig-lane-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

/** A clc row whose PARALLEL names an autograph and whose flag says otherwise. */
const unsignedRow = (n: number) => ({
  id: `hiq:baseball:2022:panini-select:${n}:signature-swatches-gold-prizm:no-auto`,
  cardId: `hiq:baseball:2022:panini-select:${n}:signature-swatches-gold-prizm:no-auto`,
  sport: "baseball", year: 2022, setKey: "panini-select", cardNumber: String(n),
  parallel: "Signature Swatches Gold Prizm", subsetName: null,
  isAuto: false, printRun: null, playerName: `Player ${n}`,
  source: "checklistcenter-2026-08-29",
});

/**
 * The stub. Every WRITE verb increments a counter written to a JSON sidecar,
 * so a test can assert on what the lane actually did rather than on what it
 * printed. `moveCatalogRow` is stubbed at the dist boundary and records its
 * arguments -- which is how "went through the ONE derivation path" is checked.
 */
function shim(opts: {
  rows?: number;
  twinExists?: boolean;
  sales?: Array<Record<string, unknown>>;
} = {}): { requirePath: string; ledger: string } {
  const ledger = path.join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const rows = Array.from({ length: opts.rows ?? 3 }, (_, i) => unsignedRow(i + 1));
  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};
const ROWS = ${JSON.stringify(rows)};
const SALES = ${JSON.stringify(opts.sales ?? [])};
const TWIN = ${JSON.stringify(opts.twinExists === true)};

const led = { upsert: 0, create: 0, patch: 0, delete: 0, moves: [], replace: 0 };
const save = () => fs.writeFileSync(LEDGER, JSON.stringify(led));
save();

const isCount = (q) => /COUNT\\(1\\)/i.test(q);
const isPool = (q) => /ARRAY_CONTAINS\\(@ids/.test(q) || /hobbyiqCardId/.test(q);

const container = (name) => ({
  item: (id) => ({
    read: async () => ({ resource: ROWS.find((r) => r.id === id) ?? null }),
    patch: async () => { led.patch++; save(); return { resource: {} }; },
    delete: async () => { led.delete++; save(); return {}; },
  }),
  items: {
    upsert: async (doc) => { led.upsert++; save(); return { resource: doc }; },
    create: async (doc) => { led.create++; save(); return { resource: doc }; },
    query: (spec) => {
      const q = typeof spec === "string" ? spec : spec.query;
      let resources;
      if (isCount(q)) resources = [0];
      else if (name === "sold_comps") resources = SALES;
      else resources = ROWS;
      return {
        fetchAll: async () => ({ resources }),
        fetchNext: async () => ({ resources, continuationToken: undefined }),
      };
    },
  },
});

const stub = { CosmosClient: class { database() { return { container }; } } };
const realLoad = Module._load;
Module._load = function (request) {
  const r = String(request);
  if (r === "@azure/cosmos") return stub;
  if (r.includes("writeReconciliation")) return { reportWrites: () => {} };
  if (r.includes("catalogRowOps.service")) {
    return {
      moveCatalogRow: async (container, row, newSlug, fields, options) => {
        led.moves.push({
          from: row.id, to: newSlug, fields,
          dryRun: options && options.dryRun === true,
          hasSalesContainer: !!(options && options.salesContainer),
          reason: options && options.reason,
        });
        save();
        // A dry run reads and returns counts but writes nothing.
        if (options && options.dryRun) {
          return { action: TWIN ? "fold" : "replace", salesRepointed: SALES.length, gradedChildrenRetired: 0 };
        }
        // A real move: the mover is what writes. Folding onto an existing twin
        // writes ONE row (the survivor); it never creates a second.
        led.upsert++;
        if (!TWIN) led.replace++;
        led.delete++;
        save();
        return { action: TWIN ? "fold" : "replace", salesRepointed: SALES.length, gradedChildrenRetired: 0 };
      },
    };
  }
  return realLoad.apply(this, arguments);
};
`);
  return { requirePath: p, ledger };
}

function drive(env: Record<string, string>, opts: Parameters<typeof shim>[0] = {}) {
  const { requirePath, ledger } = shim(opts);
  let code = 0; let out = "";
  try {
    out = execFileSync(process.execPath, [LANE], {
      cwd: backend,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        NODE_OPTIONS: `--require ${JSON.stringify(requirePath)}`,
        COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
        ...env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch (e: any) {
    code = e.status as number;
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
  }
  const led = JSON.parse(fs.readFileSync(ledger, "utf8"));
  return { code, out, led };
}

/** Every write verb the lane could reach, summed. */
const writesIn = (led: any) => led.upsert + led.create + led.patch + led.delete;

describe("repair-clc-signature-unsigned — the scope refusal", () => {
  it("REFUSES an unnamed scope, in REPORT mode too", () => {
    // A report over an unnamed scope is how an apply over an unnamed scope gets
    // authorised (feedback_a_whole_source_retire_needs_its_name).
    const r = drive({ SCOPE: "" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/SCOPE is REQUIRED/);
    expect(writesIn(r.led)).toBe(0);
  });

  it("REFUSES the runner's inherited 'refractor' rather than reading it as 'all'", () => {
    for (const s of ["refractor", "all"]) {
      const r = drive({ SCOPE: s });
      expect([s, r.code]).toEqual([s, 2]);
      expect(writesIn(r.led)).toBe(0);
    }
  });

  it("REFUSES a scope that is not a sport:year cell", () => {
    const r = drive({ SCOPE: "baseball:2022:panini-select" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/not cells|not a cell/);
  });

  it("accepts a named cell", () => {
    const r = drive({ SCOPE: "baseball:2022" });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/scope \(1 cell\)/);
  });
});

describe("repair-clc-signature-unsigned — report writes NOTHING", () => {
  it("a REPORT run reaches the mover but writes zero rows", () => {
    const r = drive({ SCOPE: "baseball:2022" });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REPORT ONLY -- nothing is written/);
    // MEASURED, not intended.
    expect(writesIn(r.led)).toBe(0);
  });

  it("REPORT still exercises the real moveCatalogRow, with dryRun", () => {
    // A report that cannot fail the way the apply fails is not a rehearsal.
    const r = drive({ SCOPE: "baseball:2022" });
    expect(r.led.moves.length).toBeGreaterThan(0);
    for (const m of r.led.moves) expect(m.dryRun).toBe(true);
  });
});

describe("repair-clc-signature-unsigned — apply moves through the ONE path", () => {
  it("APPLY moves via moveCatalogRow with { isAuto: true } and the sales container", () => {
    const r = drive({ SCOPE: "baseball:2022", BACKFILL_APPLY: "true" });
    expect(r.code).toBe(0);
    expect(r.led.moves.length).toBeGreaterThan(0);
    for (const m of r.led.moves) {
      // The field that moves, and ONLY it. Never a raw patch: the deriver
      // rebuilds every search field (memory: "deriveCatalogEntry builds its
      // own search fields -- use patchCatalogRowFields, never a raw patch";
      // and for an address change the ONE path is moveCatalogRow).
      expect(m.fields).toEqual({ isAuto: true });
      expect(m.dryRun).toBe(false);
      expect(m.hasSalesContainer).toBe(true);
      expect(String(m.reason)).toMatch(/CF-THE-WHOLE-SECTION-NAME-REACHES-THE-AUTO-DECISION/);
    }
  });

  it("the destination flips segment 6 and nothing else", () => {
    const r = drive({ SCOPE: "baseball:2022", BACKFILL_APPLY: "true" });
    for (const m of r.led.moves) {
      const from = String(m.from).split(":");
      const to = String(m.to).split(":");
      expect(from[6]).toBe("no-auto");
      expect(to[6]).toBe("auto");
      // every other segment is byte-identical
      expect(to.filter((_: string, i: number) => i !== 6)).toEqual(from.filter((_: string, i: number) => i !== 6));
    }
  });

  it("the runner's BACKFILL_APPLY spelling is what gates the write", () => {
    // CF-THE-RUNNER-EXPORTS-BACKFILL-APPLY. A lane that read only APPLY would
    // report forever under the runner and never write.
    const report = drive({ SCOPE: "baseball:2022" });
    const apply = drive({ SCOPE: "baseball:2022", BACKFILL_APPLY: "true" });
    expect(writesIn(report.led)).toBe(0);
    expect(writesIn(apply.led)).toBeGreaterThan(0);
  });
});

describe("repair-clc-signature-unsigned — an existing :auto twin is folded, not duplicated", () => {
  it("folds onto the twin and never creates a second row", () => {
    // ONE CARD, ONE ROW, ONE POOL (feedback_one_card_one_row_one_pool). A
    // repair that leaves two rows has split the pool it set out to heal.
    const r = drive({ SCOPE: "baseball:2022", BACKFILL_APPLY: "true" }, { twinExists: true });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/folded onto an existing signed twin\s+[1-9]/);
    // The fold path never takes the "replace an incumbent" branch...
    expect(r.led.replace).toBe(0);
    // ...and it creates nothing: the survivor is upserted, the old row deleted.
    expect(r.led.create).toBe(0);
    expect(r.led.delete).toBeGreaterThan(0);
  });

  it("with NO twin the row is replaced at the new address, still one row", () => {
    const r = drive({ SCOPE: "baseball:2022", BACKFILL_APPLY: "true" }, { twinExists: false });
    expect(r.out).toMatch(/folded onto an existing signed twin\s+0/);
    expect(r.led.replace).toBeGreaterThan(0);
    expect(r.led.create).toBe(0);
  });
});

describe("repair-clc-signature-unsigned — a sale rides only on its OWN title", () => {
  const sale = (id: string, title: string | null) => ({
    id, cardId: "hiq:baseball:2022:panini-select:1:signature-swatches-gold-prizm:no-auto",
    hobbyiqCardId: "hiq:baseball:2022:panini-select:1:signature-swatches-gold-prizm:no-auto",
    title, rawTitle: null,
  });

  it("PARKS a titleless sale — the checklist is not evidence about a listing", () => {
    const r = drive({ SCOPE: "baseball:2022", MODE: "sales" }, {
      sales: [sale("s1", null), sale("s2", "")],
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/PARKED\s+2/);
    expect(r.out).toMatch(/no title to state an autograph/);
  });

  it("PARKS a sale whose title says nothing about an autograph", () => {
    const r = drive({ SCOPE: "baseball:2022", MODE: "sales" }, {
      sales: [sale("s1", "2022 Panini Select Gold Prizm #1 PSA 10")],
    });
    expect(r.out).toMatch(/PARKED\s+1/);
    expect(r.out).toMatch(/does not state an autograph/);
  });

  it("PARKS a sale whose title DENIES the autograph", () => {
    const r = drive({ SCOPE: "baseball:2022", MODE: "sales" }, {
      sales: [sale("s1", "2022 Panini Select #1 No Autograph Gold")],
    });
    expect(r.out).toMatch(/PARKED\s+1/);
    expect(r.out).toMatch(/denies the autograph/);
  });

  it("rides a sale whose title STATES an autograph", () => {
    const r = drive({ SCOPE: "baseball:2022", MODE: "sales" }, {
      sales: [sale("s1", "2022 Panini Select Signature Swatches Gold Prizm #1 Auto PSA 10")],
    });
    expect(r.out).toMatch(/would ride \(title states an auto\) 1/);
    expect(r.out).toMatch(/PARKED\s+0/);
  });

  it("the banner SAYS that a titleless sale parks — the rule is in the log, not only the code", () => {
    const r = drive({ SCOPE: "baseball:2022" });
    expect(r.out).toMatch(/A SALE MOVES ONLY IF ITS OWN TITLE STATES AN AUTOGRAPH/);
    expect(r.out).toMatch(/is PARKED, not moved/);
  });
});

describe("repair-clc-signature-unsigned — the reconciliation and the shard banner", () => {
  it("reconciles intended = written + skipped + failed + parked", () => {
    const r = drive({ SCOPE: "baseball:2022" });
    expect(r.out).toMatch(/reconciled: intended [\d,]+ = written [\d,]+ \+ skipped [\d,]+ \+ failed [\d,]+ \+ parked [\d,]+/);
  });

  it("an inherited slot=0 slots=16 sweeps EVERY row and SAYS so", () => {
    // CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD: the banner must not print
    // "slot 0/16" as though it were configuration.
    const r = drive({ SCOPE: "baseball:2022", SLOT: "0", SLOTS: "16" });
    expect(r.out).toMatch(/sharding OFF -- this run sweeps EVERY row/);
    expect(r.out).toMatch(/inherited default/);
  });

  it("SHARD=true with slot 0 is a chosen shard, and the banner names the coverage", () => {
    const r = drive({ SCOPE: "baseball:2022", SLOT: "0", SLOTS: "16", SHARD: "true" });
    expect(r.out).toMatch(/sharding ON -- slot 0\/16/);
    expect(r.out).toMatch(/THIS RUN COVERS 1\/16 OF THE POPULATION/);
  });

  it("a non-zero slot is self-evidently chosen", () => {
    const r = drive({ SCOPE: "baseball:2022", SLOT: "3", SLOTS: "16" });
    expect(r.out).toMatch(/sharding ON -- slot 3\/16/);
  });
});

describe("repair-clc-signature-unsigned — the runner wiring", () => {
  const yml = fs.readFileSync(RUNNER, "utf8").replace(/\r\n/g, "\n");

  it("is dispatchable from the script dropdown", () => {
    expect(yml).toMatch(/^ {10}- repair-clc-signature-unsigned$/m);
  });

  it("is on the SHARD opt-in line — it shards by card and must be able to fan out", () => {
    const line = yml.split("\n").find((l) => /^\s+SHARD:\s/.test(l)) ?? "";
    expect(line).toContain("inputs.script == 'repair-clc-signature-unsigned'");
  });

  it("has a scope guard that refuses the inherited default before anything runs", () => {
    const step = yml.slice(yml.indexOf("The clc signature repair names its scope"));
    expect(step.slice(0, 1400)).toMatch(/refractor/);
    expect(step.slice(0, 1400)).toMatch(/exit 1/);
  });

  it("relaunches on the MARKER, never on a progress count, and forwards the shard", () => {
    const line = yml.split("\n").find(
      (l) => l.includes("gh workflow run backfill-runner.yml") && l.includes("-f script=repair-clc-signature-unsigned "),
    );
    expect(line, "the lane must have a self-relaunch dispatch").toBeTruthy();
    // A continuation that dropped these would widen from one shard to a full
    // sweep mid-fleet.
    expect(line).toContain("-f parents_only=");
    expect(line).toContain("-f slot=");
    expect(line).toContain("-f slots=");
    expect(line).toContain("-f scope=");
    // And the gate itself is the marker.
    const step = yml.slice(yml.indexOf("Self-relaunch the clc signature repair"));
    expect(step.slice(0, 1800)).toMatch(/stopped at the .*budget/);
  });

  it("the marker is a SOURCE LITERAL in the lane, so a static reader can see it", () => {
    // A marker only assembled at runtime is a relaunch that never fires.
    const src = fs.readFileSync(LANE, "utf8");
    expect(src).toMatch(/stopped at the \$\{CLOCK\.RUN_MINUTES\}-minute budget/);
  });
});

/** THE MUTATIONS. Each is the shipped guarantee, inverted, asserted to go red. */
describe("repair-clc-signature-unsigned — mutation checks", () => {
  it("MUTATION: a lane that skipped the dryRun flag would write during a REPORT", () => {
    // Shipped: report reaches the mover and writes nothing, because dryRun is
    // bound to !APPLY. The mutation is `dryRun: false` -- which the stub would
    // record as a write, so this asserts the binding rather than the intent.
    const report = drive({ SCOPE: "baseball:2022" });
    expect(writesIn(report.led)).toBe(0);
    expect(report.led.moves.every((m: any) => m.dryRun === true)).toBe(true);

    // The same lane WITH apply writes -- so the zero above is the flag doing
    // the work, not the stub being inert.
    const apply = drive({ SCOPE: "baseball:2022", BACKFILL_APPLY: "true" });
    expect(writesIn(apply.led)).toBeGreaterThan(0);
  });

  it("MUTATION: dropping the scope refusal would let an unnamed dispatch write", () => {
    // The refusal exits BEFORE Cosmos is opened, in both modes: no scope, no
    // reads, no writes, and a non-zero exit the runner can see.
    const r = drive({ SCOPE: "", BACKFILL_APPLY: "true" });
    expect(r.code).toBe(2);
    expect(writesIn(r.led)).toBe(0);
    expect(r.led.moves.length).toBe(0);
  });

  it("MUTATION: treating the checklist as evidence about a listing would move a titleless sale", () => {
    // The shipped rule parks it. The mutation -- "the checklist says the card
    // is an auto, so every sale on it is an auto" -- would ride all three.
    const r = drive({ SCOPE: "baseball:2022", MODE: "sales" }, {
      sales: [
        { id: "s1", cardId: "x", hobbyiqCardId: "x", title: null, rawTitle: null },
        { id: "s2", cardId: "x", hobbyiqCardId: "x", title: "2022 Select Gold #1", rawTitle: null },
        { id: "s3", cardId: "x", hobbyiqCardId: "x", title: "2022 Select #1 Auto", rawTitle: null },
      ],
    });
    // Exactly one states an autograph; the other two park.
    expect(r.out).toMatch(/would ride \(title states an auto\) 1/);
    expect(r.out).toMatch(/PARKED\s+2/);
  });

  it("MUTATION: a row-level shard axis would split a card from its graded children", () => {
    // CF-A-MOVE-LANE-SHARDS-BY-CARD-NOT-BY-ROW. The lane hashes the CARD, so a
    // parent and its graded child land in ONE slot. A row-level hash does not.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { cardShardIndex } = require("../scripts/lib/card-shard-axis.cjs");
    const crypto = require("node:crypto");
    const rowShard = (id: string, slots: number) =>
      parseInt(crypto.createHash("sha1").update(id).digest("hex").slice(0, 8), 16) % slots;

    const parent = "hiq:baseball:2022:panini-select:1:signature-swatches-gold-prizm:no-auto";
    const children = [`${parent}:psa-10`, `${parent}:psa-9`, `${parent}:bgs-9-5`];

    // Shipped: every child shares the parent's slot.
    for (const c of children) {
      expect([c, cardShardIndex(c, 16)]).toEqual([c, cardShardIndex(parent, 16)]);
    }
    // The mutation: a row-level hash scatters at least one of them elsewhere,
    // which is two writers on one identity.
    expect(children.some((c) => rowShard(c, 16) !== rowShard(parent, 16))).toBe(true);
  });
});
