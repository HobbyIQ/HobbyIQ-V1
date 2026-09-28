import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * census-sold-comp-copies.cjs -- per sport:year GENERATOR of dedupe
 * candidates for dedupe-sold-comp-copies-by-list.cjs (Drew, 2026-09-28
 * ~00:50Z: "Build it; start with hockey 2025 REPORT").
 *
 * Modeled on duplicateSaleIdsCensusExit.test.ts's own shape: the real
 * script is driven against a stubbed @azure/cosmos via a require()-hooking
 * shim, because a unit test of the keeper-selection rule alone would not
 * catch a lane that cannot reach its own last line (the #1942 class of
 * defect that file exists to pin).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(here, "..");
const script = path.join(backend, "scripts", "census-sold-comp-copies.cjs");
const runner = path.join(backend, "..", ".github", "workflows", "backfill-runner.yml");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "censusdupes-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const SPORT = "hockey";
const YEAR = "2025";
const CELL = `${SPORT}:${YEAR}`;

const KEEP_ID = "hiq:hockey:2025:upper-deck:1:base:no-auto";
const STRAY_ID = "1234567890"; // raw vendor cardId, no hobbyiqCardId prefix at all -- the ~86% shape

type Doc = { id: string; cardId: string; hobbyiqCardId: string };

/**
 * A stub honouring:
 *   - STARTSWITH(c.hobbyiqCardId, prefix)  -- PASS 1
 *   - ARRAY_CONTAINS(@ids, c.id)           -- PASS 2
 *   - card_catalog point reads at (id, id) and (id, NonePk)
 */
function shimOf(opts: { pass1Docs: Doc[]; allDocs: Doc[]; catalog: Array<{ id: string; source: string; cardId?: string }> }): string {
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const src = [
    'const Module = require("module");',
    `const PASS1_DOCS = ${JSON.stringify(opts.pass1Docs)};`,
    `const ALL_DOCS = ${JSON.stringify(opts.allDocs)};`,
    `const CATALOG = ${JSON.stringify(opts.catalog)};`,
    "",
    "function catalogRead(id, pk) {",
    "  const row = CATALOG.find((r) => r.id === id);",
    "  if (!row) { const e = new Error('not found'); e.code = 404; throw e; }",
    "  const hasCardId = row.cardId !== undefined;",
    "  const pkIsNone = pk && typeof pk === 'object' && Object.keys(pk).length === 0;",
    "  if (hasCardId && pk !== row.cardId) { const e = new Error('not found'); e.code = 404; throw e; }",
    "  if (!hasCardId && !pkIsNone) { const e = new Error('not found'); e.code = 404; throw e; }",
    "  return row;",
    "}",
    "",
    "const catalogContainer = {",
    "  item: (id, pk) => ({",
    "    read: async () => ({ resource: catalogRead(id, pk) }),",
    "  }),",
    "};",
    "",
    "const poolContainer = {",
    "  items: {",
    "    query(spec, opts2) {",
    "      const params = Object.fromEntries((spec.parameters || []).map((x) => [x.name, x.value]));",
    "      let rows = [];",
    "      if (String(spec.query).includes('STARTSWITH')) {",
    "        const prefix = params['@prefix'];",
    "        rows = PASS1_DOCS.filter((d) => String(d.hobbyiqCardId || '').startsWith(prefix));",
    "      } else if (String(spec.query).includes('ARRAY_CONTAINS')) {",
    "        const wanted = new Set(params['@ids']);",
    "        rows = ALL_DOCS.filter((d) => wanted.has(d.id));",
    "      }",
    "      let drained = false;",
    "      return {",
    "        hasMoreResults: () => !drained,",
    "        fetchNext: async () => { drained = true; return { resources: rows, requestCharge: 1 }; },",
    "        fetchAll: async () => ({ resources: rows, requestCharge: 1 }),",
    "      };",
    "    },",
    "  },",
    "};",
    "",
    "const stub = {",
    "  CosmosClient: class {",
    "    dispose() {}",
    "    database() {",
    "      return {",
    "        container: (name) => {",
    "          if (name === 'sold_comps') return poolContainer;",
    "          if (name === 'card_catalog') return catalogContainer;",
    "          throw new Error('unknown container ' + name);",
    "        },",
    "      };",
    "    }",
    "  },",
    "};",
    "const realLoad = Module._load;",
    "Module._load = function (request) {",
    "  if (String(request) === '@azure/cosmos') return stub;",
    "  return realLoad.apply(this, arguments);",
    "};",
    "",
  ].join("\n");
  fs.writeFileSync(p, src);
  return p;
}

function drive(env: Record<string, string>, opts: Parameters<typeof shimOf>[0]) {
  const shim = shimOf(opts);
  const planOut = path.join(tmp, `plan-${Math.random().toString(36).slice(2)}`);
  try {
    const stdout = execFileSync(process.execPath, [script], {
      cwd: backend,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
        NODE_OPTIONS: `--require ${JSON.stringify(shim)}`,
        COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
        PLAN_OUT: planOut,
        RUN_MINUTES: "60",
        ...env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { code: 0, out: stdout, planOut };
  } catch (e: any) {
    return { code: e.status as number, out: String(e.stdout ?? "") + String(e.stderr ?? ""), planOut };
  }
}

function readArtifact(planOut: string, slotSuffix = ""): any {
  const p = path.join(planOut, `dedupe-candidates-${SPORT}-${YEAR}${slotSuffix}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ── the runner contract ──────────────────────────────────────────────────

describe("the lane is dispatchable and carries no new input", () => {
  it("is in the runner's script choice list", () => {
    expect(fs.readFileSync(runner, "utf8")).toMatch(/^ {10}- census-sold-comp-copies\r?$/m);
  });

  it("rides the existing SCOPE passthrough -- no new workflow_dispatch input", () => {
    const yml = fs.readFileSync(runner, "utf8");
    expect(yml).toMatch(/SCOPE:\s*\$\{\{\s*inputs\.scope\s*\}\}/);
  });

  it("has a relaunch step modeled on a REPORT-only census lane's own block", () => {
    const yml = fs.readFileSync(runner, "utf8");
    expect(yml).toContain("inputs.script == 'census-sold-comp-copies'");
    expect(yml).toContain("uses: ./.github/actions/relaunch-on-marker");
  });

  it("the shared relaunch action exists and is not itself edited by this change", () => {
    const action = path.join(backend, "..", ".github", "actions", "relaunch-on-marker", "action.yml");
    expect(fs.existsSync(action)).toBe(true);
  });

  it("the workflow stays under GitHub's 512 KB dispatch limit", () => {
    const bytes = Buffer.byteLength(fs.readFileSync(runner, "utf8"), "utf8");
    expect(bytes).toBeLessThan(512 * 1024);
  });

  it("never writes to Cosmos -- no upsert/patch/delete calls in the script", () => {
    const src = fs.readFileSync(script, "utf8");
    expect(src).not.toContain(".upsert(");
    expect(src).not.toContain(".patch(");
    expect(src).not.toContain(".delete(");
  });
});

// ── the artifact-name colon defect (run 36370366955) ─────────────────────

describe("the upload-artifact NAME never carries the scope's raw colon", () => {
  // Run 36370366955 (scope=hockey:2025) completed the census cleanly --
  // banner reconciled, exit 0 -- and still lost PLAN_OUT: the upload step's
  // `name:` interpolated `${{ inputs.scope }}` directly, and every legitimate
  // scope for this lane is `sport:year`, so upload-artifact@v4 rejected the
  // name ("The artifact name is not valid... Colon :") on every dispatch.
  it("the upload step's name: does not interpolate inputs.scope directly", () => {
    const yml = fs.readFileSync(runner, "utf8");
    const nameLine = yml.match(/name: census-sold-comp-copies-.*$/m)?.[0];
    expect(nameLine, "could not find the census-sold-comp-copies upload artifact name: line").toBeTruthy();
    expect(nameLine).not.toContain("${{ inputs.scope }}");
    expect(nameLine).not.toMatch(/\$SCOPE\b/);
  });

  it("the upload step's name: is built from a sanitized scope variable instead", () => {
    const yml = fs.readFileSync(runner, "utf8");
    const nameLine = yml.match(/name: census-sold-comp-copies-.*$/m)?.[0];
    expect(nameLine).toMatch(/\$\{\{\s*env\.SCOPE_SLUG\s*\}\}|\$SCOPE_SLUG\b/);
  });

  it("a step ahead of the upload exports SCOPE_SLUG with every artifact-invalid character replaced", () => {
    const yml = fs.readFileSync(runner, "utf8");
    const idx = yml.indexOf("Upload the census-sold-comp-copies candidate list");
    expect(idx).toBeGreaterThan(-1);
    const before = yml.slice(Math.max(0, idx - 2000), idx);
    expect(before).toMatch(/SCOPE_SLUG/);
    // the sanitizer step must run for this lane specifically, not a blanket rule
    expect(before).toContain("inputs.script == 'census-sold-comp-copies'");
  });

  it("the runtime SCOPE passthrough to the script itself is still forwarded verbatim (unsanitized)", () => {
    // The FIX is scoped to the artifact NAME only -- the running script must
    // still see the real sport:year cell with its colon intact.
    const yml = fs.readFileSync(runner, "utf8");
    expect(yml).toMatch(/SCOPE:\s*\$\{\{\s*inputs\.scope\s*\}\}/);
  });

  it("the relaunch dispatch still forwards scope verbatim (no download/name coupling in the relaunch path)", () => {
    const yml = fs.readFileSync(runner, "utf8");
    expect(yml).toContain(`-f scope="${"${{ inputs.scope }}"}"`);
    // relaunch-on-marker re-dispatches a fresh workflow run; it never
    // downloads this lane's artifact by name, so no mismatch is possible there.
    expect(fs.readFileSync(path.join(backend, "..", ".github", "actions", "relaunch-on-marker", "action.yml"), "utf8"))
      .not.toContain("download-artifact");
  });
});

// ── the scope refusal ────────────────────────────────────────────────────

describe("SCOPE must name one sport:year cell", () => {
  it("REFUSES an empty scope", () => {
    const r = drive({ SCOPE: "" }, { pass1Docs: [], allDocs: [], catalog: [] });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/FATAL: SCOPE is REQUIRED/);
  });

  it("REFUSES the runner's inherited 'refractor' default", () => {
    const r = drive({ SCOPE: "refractor" }, { pass1Docs: [], allDocs: [], catalog: [] });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/FATAL: SCOPE is REQUIRED/);
  });

  it("REFUSES a malformed cell", () => {
    const r = drive({ SCOPE: "hockey" }, { pass1Docs: [], allDocs: [], catalog: [] });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/not a sport:year cell/);
  });
});

// ── keeper selection ──────────────────────────────────────────────────────

describe("keeper selection", () => {
  it("single canonical keeper -> emits one entry per other doc", () => {
    const pass1Docs: Doc[] = [{ id: "sale::A", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID }];
    const allDocs: Doc[] = [
      { id: "sale::A", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID },
      { id: "sale::A", cardId: STRAY_ID, hobbyiqCardId: KEEP_ID },
    ];
    const catalog = [{ id: KEEP_ID, cardId: KEEP_ID, source: "checklistinsider-2026-08-27" }];

    const r = drive({ SCOPE: CELL }, { pass1Docs, allDocs, catalog });
    expect(r.out).not.toMatch(/FATAL|ReferenceError|TypeError/);
    expect(r.code).toBe(0);
    const doc = readArtifact(r.planOut);
    expect(doc.forLane).toBe("dedupe-sold-comp-copies-by-list");
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0]).toMatchObject({ saleId: "sale::A", keepCardId: KEEP_ID, deleteCardId: STRAY_ID });
    expect(doc.entries[0].reason).toBeTruthy();
    expect(doc.census.needsRuling).toHaveLength(0);
  });

  it("two canonical keepers -> ambiguous, filed under needsRuling, nothing emitted", () => {
    const KEEP_ID_2 = "hiq:hockey:2025:upper-deck:1:young-guns:no-auto";
    const pass1Docs: Doc[] = [{ id: "sale::B", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID }];
    const allDocs: Doc[] = [
      { id: "sale::B", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID },
      { id: "sale::B", cardId: KEEP_ID_2, hobbyiqCardId: KEEP_ID_2 },
    ];
    const catalog = [
      { id: KEEP_ID, cardId: KEEP_ID, source: "checklistinsider-2026-08-27" },
      { id: KEEP_ID_2, cardId: KEEP_ID_2, source: "checklistinsider-2026-08-27" },
    ];

    const r = drive({ SCOPE: CELL }, { pass1Docs, allDocs, catalog });
    expect(r.code).toBe(0);
    const doc = readArtifact(r.planOut);
    expect(doc.entries).toHaveLength(0);
    expect(doc.census.needsRuling).toHaveLength(1);
    expect(doc.census.needsRuling[0].reason).toBe("multiple-checklist-grade-coherent-docs");
    expect(doc.census.needsRuling[0].docs).toHaveLength(2);
  });

  it("no canonical keeper (neither coherent doc is checklist-grade) -> needsRuling", () => {
    const pass1Docs: Doc[] = [{ id: "sale::C", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID }];
    const allDocs: Doc[] = [
      { id: "sale::C", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID },
      { id: "sale::C", cardId: STRAY_ID, hobbyiqCardId: KEEP_ID },
    ];
    // Vendor-authority row, never checklist -- CF-CATALOG-AUTHORITY.
    const catalog = [{ id: KEEP_ID, cardId: KEEP_ID, source: "cardhedge" }];

    const r = drive({ SCOPE: CELL }, { pass1Docs, allDocs, catalog });
    expect(r.code).toBe(0);
    const doc = readArtifact(r.planOut);
    expect(doc.entries).toHaveLength(0);
    expect(doc.census.needsRuling).toHaveLength(1);
    expect(doc.census.needsRuling[0].reason).toBe("no-checklist-grade-coherent-doc");
  });

  it("a single-doc id with no drift is not a candidate and not needsRuling", () => {
    const pass1Docs: Doc[] = [{ id: "sale::D", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID }];
    const allDocs: Doc[] = [{ id: "sale::D", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID }];
    const catalog = [{ id: KEEP_ID, cardId: KEEP_ID, source: "checklistinsider-2026-08-27" }];

    const r = drive({ SCOPE: CELL }, { pass1Docs, allDocs, catalog });
    expect(r.code).toBe(0);
    const doc = readArtifact(r.planOut);
    expect(doc.entries).toHaveLength(0);
    expect(doc.census.needsRuling).toHaveLength(0);
    expect(doc.census.single).toBe(1);
    expect(doc.census.grouped).toBe(0);
    expect(doc.census.intraDocDriftIds).toBe(0);
  });

  it("a single-doc id whose cardId != hobbyiqCardId is counted as intra-doc drift only, never a candidate", () => {
    const pass1Docs: Doc[] = [{ id: "sale::E", cardId: STRAY_ID, hobbyiqCardId: KEEP_ID }];
    const allDocs: Doc[] = [{ id: "sale::E", cardId: STRAY_ID, hobbyiqCardId: KEEP_ID }];
    const catalog = [{ id: KEEP_ID, cardId: KEEP_ID, source: "checklistinsider-2026-08-27" }];

    const r = drive({ SCOPE: CELL }, { pass1Docs, allDocs, catalog });
    expect(r.code).toBe(0);
    const doc = readArtifact(r.planOut);
    expect(doc.entries).toHaveLength(0);
    expect(doc.census.intraDocDriftIds).toBe(1);
    expect(doc.census.grouped).toBe(0);
  });
});

// ── second-pass discovery of an out-of-scope stray ────────────────────────

describe("second pass finds a stray filed under a completely different address", () => {
  it("PASS 1 sees only the in-scope keeper; PASS 2's ARRAY_CONTAINS finds the raw-vendor-id stray", () => {
    // PASS 1's own STARTSWITH would never see the stray at all -- it carries
    // no hobbyiqCardId in scope (a raw vendor cardId, the ~86% shape). Only
    // because PASS 2 re-queries by id (ARRAY_CONTAINS) does it surface.
    const pass1Docs: Doc[] = [{ id: "sale::F", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID }];
    const allDocs: Doc[] = [
      { id: "sale::F", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID },
      { id: "sale::F", cardId: "9999999999", hobbyiqCardId: "" }, // no hobbyiqCardId at all
    ];
    const catalog = [{ id: KEEP_ID, cardId: KEEP_ID, source: "checklistinsider-2026-08-27" }];

    const r = drive({ SCOPE: CELL }, { pass1Docs, allDocs, catalog });
    expect(r.code).toBe(0);
    const doc = readArtifact(r.planOut);
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0].deleteCardId).toBe("9999999999");
    expect(doc.census.shapeHistogram["malformed-legacy-slug"]).toBeGreaterThanOrEqual(1);
  });
});

// ── no cursor: a relaunch reruns the whole shard from the top ────────────

describe("no cursor -- a budget stop reruns the WHOLE shard from the top on relaunch", () => {
  it("never writes or reads any cursor file, in PLAN_OUT or elsewhere", () => {
    const src = fs.readFileSync(script, "utf8");
    expect(src).not.toContain("CURSOR_OUT");
    expect(src.toLowerCase()).not.toContain("cursor.json");
  });

  it("a budget stop during PASS 1 prints that the relaunch re-reads from the top, with no cursor", () => {
    const pass1Docs: Doc[] = [{ id: "sale::G1", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID }];
    const allDocs: Doc[] = pass1Docs;
    const catalog = [{ id: KEEP_ID, cardId: KEEP_ID, source: "checklistinsider-2026-08-27" }];

    const r = drive({ SCOPE: CELL, RUN_MINUTES: "1", BUDGET_MS: "0", RESERVE_MS: "1" }, { pass1Docs, allDocs, catalog });
    expect(r.out).not.toMatch(/FATAL|ReferenceError|TypeError/);
    expect(r.out).toMatch(/stopped at the 1-minute budget/);
    expect(r.out).toMatch(/during PASS 1/);
    expect(r.out).toMatch(/re-reads this shard from the top \(no cursor/);
  });

  it("re-running the SAME shard from the top (simulating a relaunch) reproduces the identical artifact -- the walk is idempotent", () => {
    const pass1Docs: Doc[] = [{ id: "sale::G2", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID }];
    const allDocs: Doc[] = [
      { id: "sale::G2", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID },
      { id: "sale::G2", cardId: STRAY_ID, hobbyiqCardId: KEEP_ID },
    ];
    const catalog = [{ id: KEEP_ID, cardId: KEEP_ID, source: "checklistinsider-2026-08-27" }];

    const first = drive({ SCOPE: CELL }, { pass1Docs, allDocs, catalog });
    const second = drive({ SCOPE: CELL }, { pass1Docs, allDocs, catalog });
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const firstDoc = readArtifact(first.planOut);
    const secondDoc = readArtifact(second.planOut);
    expect(secondDoc.entries).toEqual(firstDoc.entries);
    expect(secondDoc.census.idsScanned).toBe(firstDoc.census.idsScanned);
  });
});

// ── artifact loads through the dedupe lane's real list loader ────────────

describe("the artifact loads through dedupe-sold-comp-copies-by-list's real classifyEntry", () => {
  it("every emitted entry passes the consuming lane's own validation", () => {
    const dedupeLane = path.join(backend, "scripts", "dedupe-sold-comp-copies-by-list.cjs");
    const { classifyEntry } = require(dedupeLane) as { classifyEntry: (e: unknown) => { ok: boolean; why?: string } };

    const pass1Docs: Doc[] = [{ id: "sale::H", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID }];
    const allDocs: Doc[] = [
      { id: "sale::H", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID },
      { id: "sale::H", cardId: STRAY_ID, hobbyiqCardId: KEEP_ID },
    ];
    const catalog = [{ id: KEEP_ID, cardId: KEEP_ID, source: "checklistinsider-2026-08-27" }];

    const r = drive({ SCOPE: CELL }, { pass1Docs, allDocs, catalog });
    expect(r.code).toBe(0);
    const doc = readArtifact(r.planOut);
    expect(doc.entries.length).toBeGreaterThan(0);
    for (const e of doc.entries) {
      const c = classifyEntry(e);
      expect(c.ok, `entry failed classifyEntry: ${JSON.stringify(e)} -- ${c.why}`).toBe(true);
    }
  });
});

// ── budget marker + exit ──────────────────────────────────────────────────

describe("budget marker and exit", () => {
  it("a clean finished run does not print the budget marker, and exits 0 with finishLane", () => {
    const pass1Docs: Doc[] = [{ id: "sale::I", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID }];
    const allDocs: Doc[] = [{ id: "sale::I", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID }];
    const catalog = [{ id: KEEP_ID, cardId: KEEP_ID, source: "checklistinsider-2026-08-27" }];

    const r = drive({ SCOPE: CELL }, { pass1Docs, allDocs, catalog });
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/stopped at the \d+-minute budget/);
    expect(r.out).toMatch(/finishLane: exiting code 0/);
    expect(r.out).not.toMatch(/FATAL|ReferenceError|TypeError/);
  });
});
