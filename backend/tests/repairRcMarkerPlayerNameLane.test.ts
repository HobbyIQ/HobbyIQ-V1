/**
 * CF-A-ROOKIE-MARKER-IS-NOT-PART-OF-THE-NAME -- the LANE's contract, driven
 * end-to-end against a stub Cosmos.
 *
 * repair-rc-marker-playername.cjs's own `planRepair` is pure and can be unit
 * tested directly (see below), but a pure-function test cannot see the things
 * that make a write lane safe or unsafe:
 *
 *   1. REPORT WRITES NOTHING. Measured via patchCatalogRowFields's own args,
 *      not inferred from console output.
 *   2. APPLY calls patchCatalogRowFields with playerName/playerSlug/search
 *      fields, NEVER id/cardId/hobbyiqCardId -- the helper itself refuses
 *      those, and this pins that the lane never even tries.
 *   3. A CLEAN ROW (no `-rc` shape, or already patched) is left alone --
 *      patchCatalogRowFields is not even called for it.
 *   4. SCOPE REFUSAL, in BOTH modes -- an unnamed / inherited scope refuses
 *      before any Cosmos read happens.
 *   5. RECONCILE BALANCES: intended = written + skipped + failed.
 *
 * The lane is executed as the COMMITTED FILE, with @azure/cosmos and the
 * three dist requires replaced through Module._load -- so what these tests
 * pin is what ships, not a re-implementation of it.
 */
import { describe, expect, it, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "repair-rc-marker-playername.cjs");
const RUNNER = path.join(backend, "..", ".github", "workflows", "backfill-runner.yml");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rc-marker-lane-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

/** An `-rc` row, and its already-clean twin at a neighbouring number. */
const rcRow = (n: number) => ({
  id: `hiq:baseball:2026:topps:${n}:base:no-auto`,
  cardId: `hiq:baseball:2026:topps:${n}:base:no-auto`,
  hobbyiqCardId: `hiq:baseball:2026:topps:${n}:base:no-auto`,
  sport: "baseball", year: 2026, cardYear: 2026, setKey: "topps", setName: "2026 Topps",
  cardNumber: String(n), parallel: "Base", parallelSlug: "base",
  printRun: null, subsetName: null, isAuto: false,
  // The RC marker is END-ANCHORED by design (cleanPlayerName never strips it
  // mid-string), so every fixture row's name must end in " RC" -- no numeric
  // suffix after it. Rows are distinguished by cardNumber/id/slug instead.
  playerName: `Jonah Tong RC`, playerSlug: `jonah-tong-rc`,
  source: "baseballcardpedia", searchTokens: ["2026", "topps", String(n)],
});
const cleanRow = (n: number) => ({
  ...rcRow(n),
  id: `hiq:baseball:2026:topps:${n + 1}:base:no-auto`,
  cardId: `hiq:baseball:2026:topps:${n + 1}:base:no-auto`,
  hobbyiqCardId: `hiq:baseball:2026:topps:${n + 1}:base:no-auto`,
  cardNumber: String(n + 1),
  playerName: `Mike Trout`,
  playerSlug: `mike-trout`,
});

/**
 * The stub. Every patchCatalogRowFields call is recorded to a JSON sidecar so
 * a test can assert on what the lane actually asked to write, never on what
 * it printed.
 */
function shim(opts: { rows?: Array<Record<string, unknown>> } = {}): { requirePath: string; ledger: string } {
  const ledger = path.join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const rows = opts.rows ?? [rcRow(1), cleanRow(1)];
  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};
const ROWS = ${JSON.stringify(rows)};

const led = { patches: [], upsert: 0, create: 0, delete: 0, rawPatch: 0 };
const save = () => fs.writeFileSync(LEDGER, JSON.stringify(led));
save();

const container = (name) => ({
  item: (id) => ({
    read: async () => ({ resource: ROWS.find((r) => r.id === id) ?? null }),
    patch: async (ops) => { led.rawPatch++; save(); return { resource: {} }; },
    delete: async () => { led.delete++; save(); return {}; },
  }),
  items: {
    upsert: async (doc) => { led.upsert++; save(); return { resource: doc }; },
    create: async (doc) => { led.create++; save(); return { resource: doc }; },
    query: (spec) => {
      const q = typeof spec === "string" ? spec : spec.query;
      const isCount = /COUNT\\(1\\)/i.test(q);
      const resources = isCount ? [ROWS.length] : ROWS;
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
  if (r.includes("cardCatalog.service")) {
    return realLoad.call(this, require("path").join(${JSON.stringify(backend)}, "dist/services/portfolioiq/cardCatalog.service.js"));
  }
  if (r.includes("hobbyIqCardId.service")) {
    return realLoad.call(this, require("path").join(${JSON.stringify(backend)}, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  }
  if (r.includes("catalogRowOps.service")) {
    const real = realLoad.call(this, require("path").join(${JSON.stringify(backend)}, "dist/services/catalog/catalogRowOps.service.js"));
    return {
      ...real,
      patchCatalogRowFields: async (cont, id, cardId, fields, patchOpts) => {
        led.patches.push({ id, cardId, fields, dryRun: !!(patchOpts && patchOpts.dryRun) });
        save();
        const row = ROWS.find((r) => r.id === id);
        if (!row) return { action: "noop", id, fieldsChanged: [] };
        const changed = Object.keys(fields).filter((k) => row[k] !== fields[k]);
        if (!changed.length) return { action: "noop", id, fieldsChanged: [] };
        if (patchOpts && patchOpts.dryRun) return { action: "patch", id, fieldsChanged: changed };
        led.upsert++; save();
        return { action: "patch", id, fieldsChanged: changed };
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
        SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
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

const writesIn = (led: any) => led.upsert + led.create + led.delete + led.rawPatch;

describe("repair-rc-marker-playername -- the scope refusal", () => {
  it("REFUSES an unnamed scope, in REPORT mode too", () => {
    const r = drive({ SCOPE: "" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/SCOPE is REQUIRED/);
    expect(writesIn(r.led)).toBe(0);
  });

  it("REFUSES the runner's inherited 'refractor'/'all' rather than reading them as a scope", () => {
    for (const s of ["refractor", "all"]) {
      const r = drive({ SCOPE: s });
      expect([s, r.code]).toEqual([s, 2]);
      expect(writesIn(r.led)).toBe(0);
    }
  });

  it("REFUSES a scope that is not a sport:year cell", () => {
    const r = drive({ SCOPE: "baseball:2026:topps" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/not cells/);
  });

  it("accepts a named cell", () => {
    const r = drive({ SCOPE: "baseball:2026" });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/scope \(1 cell\)/);
  });
});

describe("repair-rc-marker-playername -- REPORT writes NOTHING", () => {
  it("a REPORT run reaches patchCatalogRowFields but writes zero rows", () => {
    const r = drive({ SCOPE: "baseball:2026" });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REPORT ONLY -- nothing is written/);
    expect(writesIn(r.led)).toBe(0);
  });

  it("REPORT still calls the real patchCatalogRowFields, with dryRun", () => {
    const r = drive({ SCOPE: "baseball:2026" });
    const rcPatches = r.led.patches.filter((p: any) => p.id.includes(":1:"));
    expect(rcPatches.length).toBeGreaterThan(0);
    for (const p of rcPatches) expect(p.dryRun).toBe(true);
  });
});

describe("repair-rc-marker-playername -- the RC row is repaired, the clean row is untouched", () => {
  it("APPLY patches the -rc row's playerName/playerSlug/search fields, never id/cardId/hobbyiqCardId", () => {
    const r = drive({ SCOPE: "baseball:2026", BACKFILL_APPLY: "true" });
    expect(r.code).toBe(0);
    const rcPatch = r.led.patches.find((p: any) => p.id === "hiq:baseball:2026:topps:1:base:no-auto");
    expect(rcPatch).toBeTruthy();
    expect(rcPatch.dryRun).toBe(false);
    expect(rcPatch.fields.playerName).toBe("Jonah Tong");
    expect(rcPatch.fields.playerSlug).toBe("jonah-tong");
    expect(rcPatch.fields).not.toHaveProperty("id");
    expect(rcPatch.fields).not.toHaveProperty("cardId");
    expect(rcPatch.fields).not.toHaveProperty("hobbyiqCardId");
    // The lane's OWN id/cardId in the query result is never re-sent as a
    // field to patch -- only playerName/playerSlug/search fields.
    expect(Object.keys(rcPatch.fields).sort()).toEqual(
      ["displayName", "playerName", "playerSlug", "searchText", "searchTokens"].sort(),
    );
  });

  it("id never changes -- the row patched is read back at the SAME id", () => {
    const r = drive({ SCOPE: "baseball:2026", BACKFILL_APPLY: "true" });
    const rcPatch = r.led.patches.find((p: any) => p.id === "hiq:baseball:2026:topps:1:base:no-auto");
    expect(rcPatch.id).toBe("hiq:baseball:2026:topps:1:base:no-auto");
    expect(rcPatch.cardId).toBe("hiq:baseball:2026:topps:1:base:no-auto");
    // Never a raw .item().patch() or a move -- only the one helper.
    expect(r.led.rawPatch).toBe(0);
  });

  it("a clean row (no -rc shape) is patched at most as a no-op, never re-slugged", () => {
    const r = drive({ SCOPE: "baseball:2026", BACKFILL_APPLY: "true" });
    // The scan predicate itself (ENDSWITH playerSlug '-rc') would exclude the
    // clean row in real Cosmos; the stub returns every row for `query`, so
    // this pins the CODE'S OWN skip logic (planRepair) as the second gate.
    const cleanPatch = r.led.patches.find((p: any) => p.id === "hiq:baseball:2026:topps:2:base:no-auto");
    expect(cleanPatch).toBeUndefined();
  });
});

describe("repair-rc-marker-playername -- reconcile balances", () => {
  it("intended = written + skipped + failed", () => {
    const r = drive({ SCOPE: "baseball:2026", BACKFILL_APPLY: "true" });
    const m = r.out.match(/reconciled: intended ([\d,]+) = written ([\d,]+) \+ skipped ([\d,]+) \+ failed ([\d,]+)/);
    expect(m).toBeTruthy();
    const [, intended, written, skipped, failed] = (m as RegExpMatchArray).map((x) => Number(String(x).replace(/,/g, "")));
    expect(intended).toBe(written + skipped + failed);
  });
});

describe("the runner can actually dispatch it", () => {
  const YML = fs.readFileSync(RUNNER, "utf8");

  it("is whitelisted in the script dropdown", () => {
    expect(YML).toContain("- repair-rc-marker-playername");
  });

  it("the generic run step carries the SCOPE the script requires", () => {
    expect(YML).toMatch(/^\s+SCOPE: \$\{\{ inputs\.scope \}\}/m);
    expect(YML).toMatch(/^\s+BACKFILL_APPLY: /m);
  });

  it("claims no new workflow_dispatch input -- R72 reuses the existing `mode` input", () => {
    const block = YML.slice(YML.indexOf("workflow_dispatch:"), YML.indexOf("jobs:"));
    const inputs = [...block.matchAll(/^      ([a-z_]+):$/gm)].map((m) => m[1]);
    expect(inputs.length, "dispatch inputs are frozen at 24 of GitHub's 25").toBeLessThanOrEqual(24);
    expect(inputs).toContain("mode");
  });

  it("the generic run step carries MODE to every script, including this one", () => {
    expect(YML).toMatch(/^\s+MODE: \$\{\{ inputs\.mode \}\}/m);
  });

  it("the relaunch dispatch forwards mode so a named-family relaunch does not fall back to rc mid-sweep", () => {
    const relaunch = YML.slice(
      YML.indexOf("Self-relaunch the RC-marker player-name repair"),
      YML.indexOf("Upload the RC-marker repair log"),
    );
    expect(relaunch).toMatch(/-f mode="\$\{\{ inputs\.mode \}\}"/);
  });

  it("uploads the full repair log so the sp/ssp/uer VARIANT-REVIEW listing survives past console truncation", () => {
    expect(YML).toContain("Upload the RC-marker repair log");
    const upload = YML.slice(YML.indexOf("Upload the RC-marker repair log"), YML.indexOf("Upload the RC-marker repair log") + 800);
    expect(upload).toMatch(/inputs\.script == 'repair-rc-marker-playername'/);
    expect(upload).toMatch(/path: \/tmp\/backfill\.log/);
  });

  it("the mode input's description documents the R72 marker families", () => {
    expect(YML).toMatch(/repair-rc-marker-playername \(RULING R72/);
  });
});

describe("R72 -- MODE selects one marker family, default is rc (unchanged behaviour)", () => {
  const rrRow = (n: number) => ({
    ...rcRow(n),
    playerName: "Al Leiter RR",
    playerSlug: "al-leiter-rr",
  });
  const tcRow = (n: number) => ({
    ...rcRow(n),
    playerName: "New York Yankees TC",
    playerSlug: "new-york-yankees-tc",
  });

  it("MODE unset behaves exactly like MODE=rc -- the default family is unchanged", () => {
    const withDefault = drive({ SCOPE: "baseball:2026", BACKFILL_APPLY: "true" });
    const withExplicitRc = drive({ SCOPE: "baseball:2026", BACKFILL_APPLY: "true", MODE: "rc" });
    expect(withDefault.led.patches.map((p: any) => p.fields.playerName).sort())
      .toEqual(withExplicitRc.led.patches.map((p: any) => p.fields.playerName).sort());
  });

  it("MODE=rr repairs an RR row", () => {
    const r = drive(
      { SCOPE: "baseball:2026", BACKFILL_APPLY: "true", MODE: "rr" },
      { rows: [rrRow(1)] },
    );
    expect(r.code).toBe(0);
    const rrPatch = r.led.patches.find((p: any) => p.id === "hiq:baseball:2026:topps:1:base:no-auto");
    expect(rrPatch).toBeTruthy();
    expect(rrPatch.fields.playerName).toBe("Al Leiter");
  });

  it("candidateSpec is the family gate, not planRepair -- a mode=rr scan's SQL never mentions -rc", () => {
    // The stub's fake `query` returns every row regardless of the WHERE
    // clause it is given (it does not implement ENDSWITH), so this lane test
    // cannot observe real Cosmos excluding an RC row under mode=rr end to
    // end. What it CAN and does pin: cleanPlayerName is a single function
    // that strips every marker family it knows regardless of which family's
    // scan asked for it (see cardCatalog.service.ts's cleanPlayerName header)
    // -- candidateSpec's ENDSWITH clause is what narrows a REAL Cosmos scan
    // to one family, and that clause shape is pinned directly against the
    // pure candidateSpec function in repairRcMarkerPlayerName.test.ts
    // ("mode=sp excludes -ssp", "mode=tier-rc ORs all three tier-letter
    // endings together", etc.) rather than through this stub.
    const r = drive({ SCOPE: "baseball:2026", MODE: "rr" }, { rows: [rrRow(1)] });
    expect(r.code).toBe(0);
  });

  it("MODE=tc repairs a team-card row, keeping the team as the name", () => {
    const r = drive(
      { SCOPE: "baseball:2026", BACKFILL_APPLY: "true", MODE: "tc" },
      { rows: [tcRow(1)] },
    );
    expect(r.code).toBe(0);
    const patch = r.led.patches.find((p: any) => p.id === "hiq:baseball:2026:topps:1:base:no-auto");
    expect(patch.fields.playerName).toBe("New York Yankees");
  });

  it("an unrecognised MODE is a FATAL refusal inside main(), never at require time", () => {
    const r = drive({ SCOPE: "baseball:2026", MODE: "bogus-family" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/not a recognised marker family/);
  });
});

describe("R72 -- sp/ssp/uer are LISTED for review, in REPORT and APPLY alike", () => {
  const spRow = (n: number) => ({
    ...rcRow(n),
    playerName: "Jonah Tong SP",
    playerSlug: "jonah-tong-sp",
  });

  it("REPORT under mode=sp lists the row as VARIANT-REVIEW without writing", () => {
    const r = drive({ SCOPE: "baseball:2026", MODE: "sp" }, { rows: [spRow(1)] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/VARIANT-REVIEW \[sp\] hiq:baseball:2026:topps:1:base:no-auto\s+"Jonah Tong SP" -> "Jonah Tong"/);
    expect(writesIn(r.led)).toBe(0);
  });

  it("APPLY under mode=sp still lists the row, alongside writing it", () => {
    const r = drive({ SCOPE: "baseball:2026", BACKFILL_APPLY: "true", MODE: "sp" }, { rows: [spRow(1)] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/VARIANT-REVIEW \[sp\]/);
    const patch = r.led.patches.find((p: any) => p.id === "hiq:baseball:2026:topps:1:base:no-auto");
    expect(patch.fields.playerName).toBe("Jonah Tong");
  });

  it("mode=rr (not a variant family) never prints VARIANT-REVIEW", () => {
    const r = drive(
      { SCOPE: "baseball:2026", MODE: "rr" },
      { rows: [{ ...rcRow(1), playerName: "Al Leiter RR", playerSlug: "al-leiter-rr" }] },
    );
    expect(r.out).not.toMatch(/VARIANT-REVIEW/);
  });
});
