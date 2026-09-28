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

type Doc = { id: string; cardId: string; hobbyiqCardId: string; title?: string; playerName?: string };

// A title that plainly names KEEP_ID's own catalog playerName below ("Connor
// McDavid") -- used by every fixture whose whole point is keeper-selection
// MECHANICS (address coherence, checklist-grade, grouping), not the new
// keeper-name gate this suite also pins separately (PR #2490 review). Every
// coherent+checklist-grade catalog row fixture below now carries a matching
// `playerName`, and every sale `Doc` that is meant to be ELIGIBLE as a keeper
// carries this SAME-player `title`, so the gate this PR adds passes cleanly
// and these pre-existing tests keep exercising what they always tested.
const KEEPER_TITLE = "2025 Upper Deck Connor McDavid Base #1";
const KEEPER_PLAYER = "Connor McDavid";

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

  // Review on #2481: `echo "$X" | tr -c ... '-'` maps echo's OWN trailing
  // newline to a trailing `-` too, so a naive `echo`-based sanitizer turns
  // scope=hockey:2025 into SCOPE_SLUG=hockey-2025- (trailing dash) and the
  // artifact name census-sold-comp-copies-hockey-2025--slot-0-<id> (double
  // dash). The sanitizer must use `printf '%s'`, which emits no trailing
  // newline, not `echo`.
  it("the sanitizer uses printf '%s', never echo, so no trailing newline reaches tr", () => {
    const yml = fs.readFileSync(runner, "utf8");
    const idx = yml.indexOf("Sanitize the scope for the census-sold-comp-copies artifact name");
    expect(idx).toBeGreaterThan(-1);
    const block = yml.slice(idx, idx + 2000);
    const runLine = block.match(/^\s*echo "SCOPE_SLUG=.*$/m)?.[0];
    expect(runLine, "could not find the SCOPE_SLUG export line").toBeTruthy();
    expect(runLine).toMatch(/printf '%s' "\$\{\{\s*inputs\.scope\s*\}\}"/);
    expect(runLine).not.toMatch(/echo "\$\{\{\s*inputs\.scope\s*\}\}"/);
  });

  it("running the real sanitizer line against scope=hockey:2025 yields the exact expected name, no trailing/double dash", () => {
    const yml = fs.readFileSync(runner, "utf8");
    const idx = yml.indexOf("Sanitize the scope for the census-sold-comp-copies artifact name");
    const block = yml.slice(idx, idx + 2000);
    const runLine = block.match(/^\s*echo "SCOPE_SLUG=.*$/m)?.[0]?.trim();
    expect(runLine).toBeTruthy();

    // Substitute the workflow-expression placeholder with a real shell
    // variable the way GitHub Actions would substitute the literal scope
    // text, then execute the ACTUAL line (not a reimplementation) under bash,
    // pointing $GITHUB_ENV at a real temp file exactly the way the runner's
    // own env does, then source it back to read SCOPE_SLUG.
    const scope = "hockey:2025";
    const shellLine = runLine!.replace(/\$\{\{\s*inputs\.scope\s*\}\}/g, scope);
    const envFile = path.join(tmp, `github_env-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(envFile, "");
    execFileSync("bash", ["-c", shellLine], { encoding: "utf8", env: { ...process.env, GITHUB_ENV: envFile } });
    const out = fs.readFileSync(envFile, "utf8").trim(); // "SCOPE_SLUG=hockey-2025"

    expect(out).toBe("SCOPE_SLUG=hockey-2025");
    const scopeSlug = out.slice("SCOPE_SLUG=".length);
    const artifactName = `census-sold-comp-copies-${scopeSlug}-slot-0-36370366955`;
    expect(artifactName).toBe("census-sold-comp-copies-hockey-2025-slot-0-36370366955");
    expect(artifactName).not.toMatch(/-{2,}/); // no double dash from a trailing-newline artifact
    expect(scopeSlug).not.toMatch(/-$/); // the #2481 regression: echo's trailing newline -> trailing dash
    expect(artifactName).not.toContain(":");
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
    const pass1Docs: Doc[] = [{ id: "sale::A", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID, title: KEEPER_TITLE }];
    const allDocs: Doc[] = [
      { id: "sale::A", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID, title: KEEPER_TITLE },
      { id: "sale::A", cardId: STRAY_ID, hobbyiqCardId: KEEP_ID, title: KEEPER_TITLE },
    ];
    const catalog = [{ id: KEEP_ID, cardId: KEEP_ID, source: "checklistinsider-2026-08-27", playerName: KEEPER_PLAYER }];

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
    // Both candidate addresses are given the SAME player as the sale's own
    // title, so both pass the new name-agreement gate and the ambiguity this
    // test pins is still the genuine "two checklist-grade coherent docs"
    // shape, not a side effect of one of them failing on name instead.
    const pass1Docs: Doc[] = [{ id: "sale::B", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID, title: KEEPER_TITLE }];
    const allDocs: Doc[] = [
      { id: "sale::B", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID, title: KEEPER_TITLE },
      { id: "sale::B", cardId: KEEP_ID_2, hobbyiqCardId: KEEP_ID_2, title: KEEPER_TITLE },
    ];
    const catalog = [
      { id: KEEP_ID, cardId: KEEP_ID, source: "checklistinsider-2026-08-27", playerName: KEEPER_PLAYER },
      { id: KEEP_ID_2, cardId: KEEP_ID_2, source: "checklistinsider-2026-08-27", playerName: KEEPER_PLAYER },
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

// ── CF-COLLISION-IS-NOT-A-DUPLICATE: the keeper-name gate (PR #2490 review,
// https://github.com/HobbyIQ/HobbyIQ-V1/pull/2490#issuecomment-5871669672) ─

describe("the keeper-name gate refuses a bare #cardNumber collision that names a different player", () => {
  it("Skattebo/Acuña shape: a football sale colliding with a baseball checklist row -> needsRuling, no entry", () => {
    // The exact real-world shape the review found: sale tca-ebay::198458636920
    // is a "Cam Skattebo" football card; its coherent + checklist-grade
    // address is hiq:baseball:2025:bowman:21:base:no-auto, whose catalog row
    // playerName is "Ronald Acuña Jr." -- a bare card-number (#21) collision
    // across a sport boundary, never a genuine duplicate. This generator's
    // own PASS 1 discovers ids by STARTSWITH(hobbyiqCardId, PREFIX) for the
    // scope's own sport/year, so the fixture's "wrong" address is filed under
    // THIS SUITE's own scope (hockey:2025, the CELL constant) -- exactly the
    // shape the real census run is scoped to -- while the sale's own title
    // and the catalog row's own playerName carry the real collision (a
    // football sale's content sitting at an address whose row names a
    // baseball player).
    const WRONG_ID = "hiq:hockey:2025:upper-deck:21:base:no-auto";
    const SKATTEBO_TITLE = "2025 Panini Rookies & Stars Cam Skattebo Crusade Silver #21 Giants Rookie RC";
    const pass1Docs: Doc[] = [{ id: "tca-ebay::198458636920", cardId: WRONG_ID, hobbyiqCardId: WRONG_ID, title: SKATTEBO_TITLE }];
    const allDocs: Doc[] = [
      { id: "tca-ebay::198458636920", cardId: WRONG_ID, hobbyiqCardId: WRONG_ID, title: SKATTEBO_TITLE },
      { id: "tca-ebay::198458636920", cardId: STRAY_ID, hobbyiqCardId: WRONG_ID, title: SKATTEBO_TITLE },
    ];
    const catalog = [{ id: WRONG_ID, cardId: WRONG_ID, source: "checklistinsider-2026-08-27", playerName: "Ronald Acuña Jr." }];

    const r = drive({ SCOPE: CELL }, { pass1Docs, allDocs, catalog });
    expect(r.out).not.toMatch(/FATAL|ReferenceError|TypeError/);
    expect(r.code).toBe(0);
    const doc = readArtifact(r.planOut);
    expect(doc.entries).toHaveLength(0);
    expect(doc.census.needsRuling).toHaveLength(1);
    expect(doc.census.needsRuling[0].reason).toBe("keeper-name-disagrees");
    expect(doc.census.needsRuling[0].nameDisagreements).toHaveLength(1);
    expect(doc.census.needsRuling[0].nameDisagreements[0]).toMatchObject({
      cardId: WRONG_ID,
      saleName: SKATTEBO_TITLE,
      keeperName: "Ronald Acuña Jr.",
    });
  });

  it("same-sport collision (Connor Bedard sale vs Bryan Rust row) -> needsRuling, no entry", () => {
    // Review's own same-sport example shape: a Connor Bedard sale colliding,
    // by bare card number, with a checklist row for Bryan Rust -- same sport
    // (hockey), still a completely different player, still refused.
    const BEDARD_ID = "hiq:hockey:2025:o-pee-chee:8:base:no-auto";
    const BEDARD_TITLE = "2025-26 O-Pee-Chee Connor Bedard #8 Blackhawks";
    const pass1Docs: Doc[] = [{ id: "tca-ebay::147339415515", cardId: BEDARD_ID, hobbyiqCardId: BEDARD_ID, title: BEDARD_TITLE }];
    const allDocs: Doc[] = [
      { id: "tca-ebay::147339415515", cardId: BEDARD_ID, hobbyiqCardId: BEDARD_ID, title: BEDARD_TITLE },
      { id: "tca-ebay::147339415515", cardId: STRAY_ID, hobbyiqCardId: BEDARD_ID, title: BEDARD_TITLE },
    ];
    const catalog = [{ id: BEDARD_ID, cardId: BEDARD_ID, source: "checklistinsider-2026-08-27", playerName: "Bryan Rust" }];

    const r = drive({ SCOPE: CELL }, { pass1Docs, allDocs, catalog });
    expect(r.out).not.toMatch(/FATAL|ReferenceError|TypeError/);
    expect(r.code).toBe(0);
    const doc = readArtifact(r.planOut);
    expect(doc.entries).toHaveLength(0);
    expect(doc.census.needsRuling).toHaveLength(1);
    expect(doc.census.needsRuling[0].reason).toBe("keeper-name-disagrees");
    expect(doc.census.needsRuling[0].nameDisagreements[0]).toMatchObject({
      cardId: BEDARD_ID,
      saleName: BEDARD_TITLE,
      keeperName: "Bryan Rust",
    });
  });

  it("a good group -- the sale's own title names the keeper's player -> emits the entry exactly as before", () => {
    const pass1Docs: Doc[] = [{ id: "sale::GOOD", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID, title: KEEPER_TITLE }];
    const allDocs: Doc[] = [
      { id: "sale::GOOD", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID, title: KEEPER_TITLE },
      { id: "sale::GOOD", cardId: STRAY_ID, hobbyiqCardId: KEEP_ID, title: KEEPER_TITLE },
    ];
    const catalog = [{ id: KEEP_ID, cardId: KEEP_ID, source: "checklistinsider-2026-08-27", playerName: KEEPER_PLAYER }];

    const r = drive({ SCOPE: CELL }, { pass1Docs, allDocs, catalog });
    expect(r.code).toBe(0);
    const doc = readArtifact(r.planOut);
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0]).toMatchObject({ saleId: "sale::GOOD", keepCardId: KEEP_ID, deleteCardId: STRAY_ID });
    expect(doc.entries[0].reason).toContain("name-agreeing");
    expect(doc.census.needsRuling).toHaveLength(0);
  });

  it("a DIFFERENT copy in the group at a checklist-grade address whose row player agrees IS the keeper", () => {
    // The address that fails the name test is address-coherent + checklist-
    // grade but names the wrong player; a SECOND coherent + checklist-grade
    // doc in the SAME group whose own row agrees with the sale's title must
    // still be selected as keeper -- the generator never gives up on the
    // whole group just because one candidate failed. WRONG_ID is filed under
    // THIS SUITE's own scope (hockey:2025, the CELL constant) so PASS 1's
    // own STARTSWITH discovers the id at all; RIGHT_ID is the genuinely
    // correct address PASS 2's cross-partition lookup then also finds.
    const WRONG_ID = "hiq:hockey:2025:upper-deck:21:base:no-auto";
    const RIGHT_ID = "hiq:football:2025:panini-rookies-and-stars:21:crusade-silver:no-auto";
    const SKATTEBO_TITLE = "2025 Panini Rookies & Stars Cam Skattebo Crusade Silver #21 Giants Rookie RC";
    const pass1Docs: Doc[] = [{ id: "sale::TWOCAND", cardId: WRONG_ID, hobbyiqCardId: WRONG_ID, title: SKATTEBO_TITLE }];
    const allDocs: Doc[] = [
      { id: "sale::TWOCAND", cardId: WRONG_ID, hobbyiqCardId: WRONG_ID, title: SKATTEBO_TITLE },
      { id: "sale::TWOCAND", cardId: RIGHT_ID, hobbyiqCardId: RIGHT_ID, title: SKATTEBO_TITLE },
    ];
    const catalog = [
      { id: WRONG_ID, cardId: WRONG_ID, source: "checklistinsider-2026-08-27", playerName: "Ronald Acuña Jr." },
      { id: RIGHT_ID, cardId: RIGHT_ID, source: "checklistinsider-2026-08-27", playerName: "Cam Skattebo" },
    ];

    const r = drive({ SCOPE: CELL }, { pass1Docs, allDocs, catalog });
    expect(r.out).not.toMatch(/FATAL|ReferenceError|TypeError/);
    expect(r.code).toBe(0);
    const doc = readArtifact(r.planOut);
    expect(doc.census.needsRuling).toHaveLength(0);
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0]).toMatchObject({ saleId: "sale::TWOCAND", keepCardId: RIGHT_ID, deleteCardId: WRONG_ID });
  });
});

// ── second-pass discovery of an out-of-scope stray ────────────────────────

describe("second pass finds a stray filed under a completely different address", () => {
  it("PASS 1 sees only the in-scope keeper; PASS 2's ARRAY_CONTAINS finds the raw-vendor-id stray", () => {
    // PASS 1's own STARTSWITH would never see the stray at all -- it carries
    // no hobbyiqCardId in scope (a raw vendor cardId, the ~86% shape). Only
    // because PASS 2 re-queries by id (ARRAY_CONTAINS) does it surface.
    const pass1Docs: Doc[] = [{ id: "sale::F", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID, title: KEEPER_TITLE }];
    const allDocs: Doc[] = [
      { id: "sale::F", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID, title: KEEPER_TITLE },
      { id: "sale::F", cardId: "9999999999", hobbyiqCardId: "", title: KEEPER_TITLE }, // no hobbyiqCardId at all
    ];
    const catalog = [{ id: KEEP_ID, cardId: KEEP_ID, source: "checklistinsider-2026-08-27", playerName: KEEPER_PLAYER }];

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
    const pass1Docs: Doc[] = [{ id: "sale::G2", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID, title: KEEPER_TITLE }];
    const allDocs: Doc[] = [
      { id: "sale::G2", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID, title: KEEPER_TITLE },
      { id: "sale::G2", cardId: STRAY_ID, hobbyiqCardId: KEEP_ID, title: KEEPER_TITLE },
    ];
    const catalog = [{ id: KEEP_ID, cardId: KEEP_ID, source: "checklistinsider-2026-08-27", playerName: KEEPER_PLAYER }];

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

    const pass1Docs: Doc[] = [{ id: "sale::H", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID, title: KEEPER_TITLE }];
    const allDocs: Doc[] = [
      { id: "sale::H", cardId: KEEP_ID, hobbyiqCardId: KEEP_ID, title: KEEPER_TITLE },
      { id: "sale::H", cardId: STRAY_ID, hobbyiqCardId: KEEP_ID, title: KEEPER_TITLE },
    ];
    const catalog = [{ id: KEEP_ID, cardId: KEEP_ID, source: "checklistinsider-2026-08-27", playerName: KEEPER_PLAYER }];

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
