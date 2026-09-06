// CF-IF-KNOWN-WE-SHOULD-BE-ABLE-TO-FIGURE-IT-OUT (Drew, 2026-09-05) — the pins.
//
// The lane that joins withheld holdings to checklist acquisition has five
// decisions worth pinning, and each pin is written so that DELETING the rule it
// guards turns it red (a pin that passes against a mutated rule is decoration):
//
//   1. CELL RANKING          holdings first, sales second, name third
//   2. MANIFEST MATCHING     alias/era spellings match; a CONTESTED pair never
//                            matches across
//   3. THE GATES             no APPLY without a reconciled report; no rederive
//                            without an ingested verdict  (in the workflow)
//   4. THE NIGHTLY CAP       bounded per night, idempotent
//   5. WRITE-FREE            the lane has no apply path at all
//
// The matching rule is exercised against the REAL 16,746-entry manifest, not a
// fixture: a matcher that works on three invented entries and misses every real
// one is the failure this program cannot afford (project_catalog_match_rate_is
// _self_confirming — a match proves nothing unless it is the real corpus).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require_ = createRequire(__filename);
const ROOT = path.join(__dirname, "..", "..");
const BACKEND = path.join(ROOT, "backend");
const read = (...p: string[]) =>
  fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");

const lib = require_(path.join(BACKEND, "scripts/lib/withheld-acquisition-cells.cjs"));
const {
  ACTIONABLE_REASONS, CONTESTED, setKeyForEntry, groupIntoCells,
  rankCells, contested, matchCellToManifest,
} = lib;

const MANIFEST = JSON.parse(read("backend", "data", "ingest-universe.json")) as {
  entries: Array<Record<string, unknown>>;
};

// ── 0. THE COPIED RULE MAY NOT DRIFT ──────────────────────────────────────
//
// `setKeyForEntry` is the driver's `setKeyFor`, copied because the driver is a
// 2,000-line script that cannot be imported without running it. A copy with no
// pin is a fork waiting to happen, so the two are compared as SOURCE.
describe("the manifest key rule is the driver's own, not a second opinion", () => {
  const driver = read("backend", "scripts", "ingest-universe-driver.cjs");

  const bodyOf = (src: string, name: string): string => {
    const at = src.indexOf(`function ${name}(entry)`);
    expect(at, `${name} must exist`).toBeGreaterThan(-1);
    const from = src.slice(at);
    let depth = 0; let end = -1;
    for (let i = from.indexOf("{"); i < from.length; i++) {
      if (from[i] === "{") depth++;
      else if (from[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    return from.slice(0, end + 1)
      // Comments and blank lines are prose; the RULE is the code.
      .replace(/^\s*\/\/.*$/gm, "").replace(/\n\s*\n/g, "\n").trim();
  };

  it("setKeyForEntry is character-identical to the driver's setKeyFor", () => {
    const mine = bodyOf(read("backend", "scripts/lib/withheld-acquisition-cells.cjs"), "setKeyForEntry")
      .replace("function setKeyForEntry(entry)", "function setKeyFor(entry)");
    expect(mine).toBe(bodyOf(driver, "setKeyFor"));
  });

  it("the driver's SPORT_SUFFIX vocabulary is the one this lane strips", () => {
    const re = /const SPORT_SUFFIX = (\/.*\/);/;
    expect(re.exec(read("backend", "scripts/lib/withheld-acquisition-cells.cjs"))?.[1])
      .toBe(re.exec(driver)?.[1]);
  });
});

// ── 1. CELL RANKING ───────────────────────────────────────────────────────
describe("cell ranking: holdings first, sales second, name third", () => {
  const cell = (setKey: string, holdings: number, salesVolume: number) => ({
    cell: `baseball|2026|${setKey}`, sport: "baseball", year: 2026, setKey,
    holdings, salesVolume, subsets: [], holdingIds: [], users: [], slugs: [], reasons: {},
  });

  it("more holdings outranks more sales — a dark card beats a busy pool", () => {
    const out = rankCells([cell("a", 1, 999_999), cell("b", 5, 1)]);
    expect(out.map((c: { setKey: string }) => c.setKey)).toEqual(["b", "a"]);
  });

  it("sales break a holdings tie", () => {
    const out = rankCells([cell("a", 3, 10), cell("b", 3, 900)]);
    expect(out.map((c: { setKey: string }) => c.setKey)).toEqual(["b", "a"]);
  });

  it("the order is TOTAL — the same input ranks the same way twice", () => {
    // Without the name tie-break the nightly cap would take an arbitrary N of
    // the tied cells and a different N tomorrow, so no cell would ever finish.
    const input = [cell("z", 2, 5), cell("a", 2, 5), cell("m", 2, 5)];
    expect(rankCells(input).map((c: { setKey: string }) => c.setKey))
      .toEqual(rankCells([...input].reverse()).map((c: { setKey: string }) => c.setKey));
    expect(rankCells(input).map((c: { setKey: string }) => c.setKey)).toEqual(["a", "m", "z"]);
  });
});

// ── 2. GROUPING ───────────────────────────────────────────────────────────
describe("grouping: the actionable reasons, and what is unaddressable", () => {
  const h = (over: Record<string, unknown> = {}) => ({
    hid: "h1", user: "u1", withheldReason: "no-checklist-match",
    sport: "baseball", year: 2026, setKey: "bowman-chrome", ...over,
  });

  it("pool-migrating is NOT queued — a re-key is not a missing checklist", () => {
    expect(ACTIONABLE_REASONS.has("pool-migrating")).toBe(false);
    expect(groupIntoCells([h({ withheldReason: "pool-migrating" })]).cells).toHaveLength(0);
  });

  it("both identity reasons ARE queued", () => {
    for (const r of ["no-checklist-match", "identity-not-in-catalog"]) {
      expect(groupIntoCells([h({ withheldReason: r })]).cells).toHaveLength(1);
    }
  });

  it("a holding with no readable (sport, year, setKey) is named, not dropped", () => {
    const { cells, unaddressable } = groupIntoCells([h({ setKey: null })]);
    expect(cells).toHaveLength(0);
    expect(unaddressable).toHaveLength(1);
    expect(unaddressable[0].have).toMatchObject({ sport: "baseball", setKey: null });
  });

  it("subset rides along and never splits the cell — one page is one fetch", () => {
    const { cells } = groupIntoCells([h({ hid: "a", subset: "insert-x" }), h({ hid: "b" })]);
    expect(cells).toHaveLength(1);
    expect(cells[0].holdings).toBe(2);
    expect(cells[0].subsets).toEqual(["insert-x"]);
  });

  it("holdings from several users land in ONE cell — the checklist is bought once", () => {
    const { cells } = groupIntoCells([h({ hid: "a", user: "u1" }), h({ hid: "b", user: "u2" })]);
    expect(cells).toHaveLength(1);
    expect(cells[0].users).toEqual(["u1", "u2"]);
  });
});

// ── 3. MANIFEST MATCHING ──────────────────────────────────────────────────
describe("manifest matching against the real universe", () => {
  const cellFor = (sport: string, year: number, setKey: string) => ({
    cell: `${sport}|${year}|${setKey}`, sport, year, setKey,
    holdings: 1, salesVolume: 0, subsets: [], holdingIds: [], users: [], slugs: [], reasons: {},
  });

  it("the manifest under test is the real one, not a stub", () => {
    expect(MANIFEST.entries.length).toBeGreaterThan(10_000);
  });

  it("1952 Topps Baseball matches on `topps` — the year and sport are columns", () => {
    // #1738's lesson, as a match: `topps-baseball` counted 0 against 6,115.
    const { matches } = matchCellToManifest(cellFor("baseball", 1952, "topps"), MANIFEST.entries);
    expect(matches.length).toBeGreaterThan(0);
    // The MATCH is on the key, never on the display spelling: a bcp setName is
    // the bare "Topps" (its year is a column too) while hobbymonitor's is
    // "1952 Topps Baseball". Both resolve to `topps`, which is the point.
    expect(matches.every((m: { matchedOn: string }) => m.matchedOn === "topps")).toBe(true);
    expect(matches.map((m: { setName: string }) => m.setName)).toContain("Topps");
    // ...and the sibling products of the same year do NOT come along.
    expect(matches.map((m: { setName: string }) => m.setName)).not.toContain("Bowman");
    expect(matches.map((m: { setName: string }) => m.setName)).not.toContain("Topps Mickey Mantle");
  });

  it("the wrong YEAR never matches — a neighbouring year is a different set", () => {
    const { matches } = matchCellToManifest(cellFor("baseball", 1953, "topps"), MANIFEST.entries);
    for (const m of matches) expect(m.setName).not.toMatch(/1952/);
  });

  it("the alias spelling matches: `finest` finds the product `topps-finest` serves", () => {
    // #1738 again, from the other side of the alias table. With a normalizer
    // the union covers both; without dist/ the raw key still matches its own
    // spelling — which is why this asserts a match under BOTH conditions.
    const norm = (k: string) => (k === "finest" ? "topps-finest" : k);
    const withNorm = matchCellToManifest(
      cellFor("baseball", 2023, "finest"), MANIFEST.entries, { canonicalSetKey: norm },
    );
    const raw = matchCellToManifest(cellFor("baseball", 2023, "finest"), MANIFEST.entries);
    expect(withNorm.matches.length + raw.matches.length).toBeGreaterThan(0);
  });

  it("a cell with no entry is NEEDS-A-SOURCE, never a guess", () => {
    const { matches } = matchCellToManifest(
      cellFor("baseball", 1888, "a-set-that-does-not-exist"), MANIFEST.entries,
    );
    expect(matches).toEqual([]);
  });

  it("GO sources outrank the rest — sportscardchecklist before beckett", () => {
    const entries = [
      { id: "b", lane: "beckett", sport: "baseball", year: 2020, setName: "2020 Topps Baseball" },
      { id: "s", lane: "sportscardchecklist", sport: "baseball", year: 2020, setName: "2020 Topps Baseball" },
    ];
    const { matches, corroborated } = matchCellToManifest(cellFor("baseball", 2020, "topps"), entries);
    expect(matches[0].lane).toBe("sportscardchecklist");
    expect(corroborated).toBe(true);
  });
});

// ── 4. THE CONTESTED PAIRS ────────────────────────────────────────────────
describe("a contested pair never matches across", () => {
  // project_bowman_setkey_taxonomy + #1715: a flagship key swallowing its
  // specialization is how Tiffany sales landed in a base pool and published
  // $148 against a $1,500 market. Alias widening is exactly the mechanism that
  // would do it here.
  it("bowman and bowman-chrome are ruled distinct", () => {
    expect(contested("bowman", "bowman-chrome")).toBe(true);
    expect(contested("bowman-chrome", "bowman")).toBe(true);
  });

  it("topps and topps-traded-tiffany are ruled distinct", () => {
    expect(contested("topps", "topps-traded-tiffany")).toBe(true);
  });

  it("a key is never contested with itself", () => {
    expect(contested("bowman", "bowman")).toBe(false);
  });

  it("a normalizer that collapses bowman-chrome onto bowman is REFUSED", () => {
    // The mutation this pin exists for: normalizeSetKey gaining an opinion
    // that folds a specialization into its flagship (project_normalize
    // SetKeyCollapsesProducts). Without the deny list the cell would match and
    // a base-set checklist would be acquired for a Chrome card.
    const collapsing = (k: string) => (k === "bowman-chrome" ? "bowman" : k);
    const entries = [{
      id: "e", lane: "bcp", sport: "baseball", year: 2021, setName: "2021 Bowman Baseball",
    }];
    const cell = {
      cell: "baseball|2021|bowman-chrome", sport: "baseball", year: 2021, setKey: "bowman-chrome",
      holdings: 3, salesVolume: 0, subsets: [], holdingIds: [], users: [], slugs: [], reasons: {},
    };
    expect(matchCellToManifest(cell, entries, { canonicalSetKey: collapsing }).matches).toEqual([]);
  });

  it("every contested pair is a real pair of two distinct non-empty keys", () => {
    for (const [a, b] of CONTESTED as Array<[string, string]>) {
      expect(a && b && a !== b, `bad pair ${a}/${b}`).toBe(true);
    }
  });
});

// ── 5. THE LANE IS WRITE-FREE, AND THE WORKFLOW HOLDS THE GATES ───────────
describe("the lane writes nothing and the workflow gates every dispatch", () => {
  const SCRIPT = read("backend", "scripts", "acquire-for-withheld-holdings.cjs");
  const WF = read(".github", "workflows", "acquire-for-withheld-holdings.yml");

  it("the script has no Cosmos write call at all", () => {
    // Proven by absence of the whole write vocabulary, not by intent.
    for (const w of ["items.upsert", "items.create", ".replace(", ".patch(", ".delete("]) {
      expect(SCRIPT.includes(w), `the plan lane must not call ${w}`).toBe(false);
    }
  });

  it("an apply dispatch is REFUSED loudly, not ignored", () => {
    expect(SCRIPT).toMatch(/BACKFILL_APPLY/);
    expect(SCRIPT).toMatch(/REFUSING: acquire-for-withheld-holdings has no apply mode/);
    expect(SCRIPT).toMatch(/process\.exit\(3\)/);
  });

  it("the lane declares the three budget constants through the shared helper", () => {
    expect(SCRIPT).toMatch(/require\(path\.join\(__dirname, "lib\/runner-budget\.cjs"\)\)/);
    expect(SCRIPT).toMatch(/budget\(\{\s*minutes:[^}]*reserveMs:[^}]*verifyMs:/s);
    // NAMED, not inline. runnerBudgetMargin.test.ts enumerates the whitelist and
    // keeps only lanes whose source names RUN_MINUTES — a lane that passes
    // literals is silently SKIPPED by that census and its margin against the
    // 150-minute ceiling is never computed. Naming them is what puts this lane
    // under the pin, so the naming is itself pinned here.
    expect(SCRIPT).toMatch(/const RUN_MINUTES = Number\(process\.env\.RUN_MINUTES \|\| \d+\)/);
    expect(SCRIPT).toMatch(/const RESERVE_MS = Number\(process\.env\.RESERVE_MS \|\|/);
    expect(SCRIPT).toMatch(/const VERIFY_MS = Number\(process\.env\.VERIFY_MS \|\|/);
  });



  it("GATE 3: the rederive APPLY is gated on its own report's verdicts", () => {
    const step = WF.split(/^      - name: "?/m).find((s) => /^Gate: the rederive report/.test(s));
    expect(step, "the rederive report gate step must exist").toBeTruthy();
    expect(step).toMatch(/UNVERIFIED|would re-point|REDERIVE/);
  });

  it("every dispatch is captured by created-after + the script marker, never `latest`", () => {
    // feedback_a_merged_fix_does_not_reach_running_fleets / the run-capture
    // discipline: `gh run list --limit 1` picks up somebody else's fleet run,
    // and this repo runs enough of them that it routinely would.
    //
    // THE PIN READS THE HELPER, NOT THE FILE. Asserting the strings appear
    // ANYWHERE in the workflow is satisfied by the header comment that
    // describes the discipline — so deleting the actual grep left this green.
    // The helper's body is the only thing that captures a run, so it is what
    // gets asserted.
    const helper = WF.slice(WF.indexOf("cat > /tmp/bin/dispatch"), WF.indexOf("HELPER\n          chmod"));
    expect(helper.length, "the dispatch helper must exist").toBeGreaterThan(200);

    // (a) the window: only runs created after we dispatched are candidates.
    expect(helper, "the capture must bound candidates by creation time").toMatch(
      /gh run list[\s\S]{0,300}?--created ">=\$SINCE"/,
    );
    // (b) the lane: the run must name the script we asked for...
    expect(helper, "the capture must confirm the script by its runner banner").toMatch(
      /grep -aq "Script confirmed: backend\/scripts\/\$\{SCRIPT\}\.cjs"/,
    );
    // (c) ...and the scope: the marker we passed. Either proof alone is
    // satisfied by a stranger's run of the same lane.
    expect(helper, "the capture must confirm the scope marker").toMatch(
      /grep -aqF "\$MARKER"/,
    );
    // (d) and it must REFUSE rather than fall back to whatever it found.
    expect(helper).toMatch(/could not identify our \$SCRIPT run by marker/);
    expect(helper).toMatch(/exit 1/);
  });

  it("the nightly cap is bounded, stated, and is what the plan is given", () => {
    const m = /NIGHTLY_CAP:\s*['"]?(\d+)['"]?/.exec(WF);
    expect(m, "the workflow must state its nightly cap").toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(0);
    expect(Number(m![1])).toBeLessThanOrEqual(10);
    // The cap must actually REACH the lane. A stated cap the plan step never
    // reads is decoration, and the plan is what the chain executes.
    expect(WF).toMatch(/TOP:\s*\$\{\{\s*env\.NIGHTLY_CAP\s*\}\}/);
  });

  it("it is SCHEDULED, and the schedule is a cron in its own `on:` block", () => {
    // Sliced rather than matched across the file: the header comments mention
    // `schedule:` and `cron` in prose, and a pin that a comment can satisfy is
    // not a pin.
    const on = WF.slice(WF.indexOf("\non:"), WF.indexOf("\npermissions:"));
    expect(on).toMatch(/^  schedule:$/m);
    expect(on).toMatch(/^\s*- cron: "[^"]+"$/m);
  });

  it("the plan step runs the lane with apply OFF", () => {
    const step = WF.split(/^      - name: "?/m).find((s) => /^Plan: read/.test(s));
    expect(step).toBeTruthy();
    expect(step).not.toMatch(/BACKFILL_APPLY:\s*(?:"?true"?|1)/);
  });
});

// ── 6. THE REPRICE SCOPE ──────────────────────────────────────────────────
//
// The chain reprices whoever owned the withheld cards. Before this lane there
// was no way to say so: `REPRICE_USER_ID` was pinned to Drew's id and the only
// escape (mode=all) is a corpus sweep. The rewire routes the EXISTING `titles`
// input through — no new workflow_dispatch input — and the pin here is that it
// stays backward compatible, because every existing dispatch of that lane
// passes no titles and must keep the id it always had.
describe("reprice can be scoped to a named user without a new input", () => {
  const RUNNER = read(".github", "workflows", "backfill-runner.yml");
  const line = /^\s*REPRICE_USER_ID:\s*(.+)$/m.exec(RUNNER)?.[1] ?? "";

  it("a reprice dispatch that names a user in `titles` reprices that user", () => {
    expect(line).toMatch(/inputs\.script == 'reprice-user-holdings'/);
    expect(line).toMatch(/inputs\.titles != ''/);
    expect(line).toMatch(/&& inputs\.titles \|\|/);
  });

  it("a dispatch that names none keeps the pin it always had", () => {
    // The mutation this catches: dropping the fallback would silently turn
    // every existing reprice dispatch into a no-user run.
    expect(line).toMatch(/user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4/);
    expect(line).toMatch(/inputs\.mode == ''/);
  });

  it("no new workflow_dispatch input was added to carry it", () => {
    const inputs = RUNNER.slice(RUNNER.indexOf("  workflow_dispatch:"), RUNNER.indexOf("permissions:"));
    for (const bad of ["reprice_user", "user_id:", "holding_ids:"]) {
      expect(inputs.includes(bad), `the runner must not grow a ${bad} input`).toBe(false);
    }
  });

  it("the acquisition lane is whitelisted so it can be dispatched at all", () => {
    expect(RUNNER).toMatch(/^\s+- acquire-for-withheld-holdings$/m);
  });
});

// ── 7. THE WORKFLOW MUST PARSE ────────────────────────────────────────────
//
// Not a formality. The first draft of this workflow was INVALID YAML in two
// ways that no amount of reading catches: a step name containing ": " is a
// nested mapping, and a `--body` whose continuation lines sit flush-left ends
// the block scalar early. GitHub does not run an unparseable workflow and does
// not tell you why in a place you would look, so a scheduled chain would simply
// never have fired. There is no yaml parser in backend/, so this pin proves the
// two SHAPES that broke it rather than the parse itself.
describe("the workflow is well-formed where it silently would not be", () => {
  const WF = read(".github", "workflows", "acquire-for-withheld-holdings.yml");

  it("every step name containing a colon-space is quoted", () => {
    for (const m of WF.matchAll(/^      - name: (.*)$/gm)) {
      const name = m[1];
      if (!name.includes(": ")) continue;
      expect(
        name.startsWith('"') && name.endsWith('"'),
        `step name must be quoted, it contains ": " -> ${name}`,
      ).toBe(true);
    }
  });

  it("no line inside a run: block scalar is flush-left", () => {
    // A zero-indented line ends the scalar and takes the rest of the file with
    // it. The `gh issue create --body` heredoc did exactly that.
    const lines = WF.split("\n");
    let inRun = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s+run: \|/.test(l)) { inRun = true; continue; }
      if (!inRun) continue;
      if (l.trim() === "") continue;
      if (/^ /.test(l)) continue;
      // A non-indented, non-empty line: the scalar has ended. That is only
      // legal at a new top-level key, which this file has none of mid-job.
      expect(/^[a-z]+:/.test(l), `flush-left line ${i + 1} ends a run: block -> ${l}`).toBe(true);
      inRun = false;
    }
  });

  it("the issue body is passed as a file, never as a multi-line argument", () => {
    expect(WF).toMatch(/gh issue create[\s\S]{0,200}--body-file/);
    expect(WF, "an inline multi-line --body is the shape that broke the parse")
      .not.toMatch(/gh issue create[^\n]*--body \\n/);
  });
});

// ── 8. NORMALIZATION MAY NOT PROMOTE A SUBSET ─────────────────────────────
//
// Found by running the matcher against prod on 2026-09-05, not by reading it.
// `normalizeSetKey` maps BOTH "finest" and "finest-jackie-robinson-u-s-mint"
// onto "topps-finest": the first is #1738's alias (the reason the union
// exists), the second is project_normalizesetkey_collapses_products (a distinct
// subset product folding into its flagship). Unguarded, the union offered the
// Jackie Robinson U.S. Mint page as a candidate for a plain 1997 Finest card.
describe("an alias may widen a key, but it may not promote a subset", () => {
  const cell = (sport: string, year: number, setKey: string) => ({
    cell: `${sport}|${year}|${setKey}`, sport, year, setKey,
    holdings: 1, salesVolume: 0, subsets: [], holdingIds: [], users: [], slugs: [], reasons: {},
  });
  // The real collapse, as measured.
  const norm = (k: string) => (/^finest/.test(k) ? "topps-finest" : k);

  it("the flagship alias still matches — #1738 is not undone by the guard", () => {
    const entries = [{ id: "f", lane: "bcp", sport: "baseball", year: 1997, setName: "Finest" }];
    const { matches } = matchCellToManifest(cell("baseball", 1997, "topps-finest"), entries, {
      canonicalSetKey: norm,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].setName).toBe("Finest");
  });

  it("the SUBSET page is refused for the flagship cell", () => {
    const entries = [{
      id: "j", lane: "bcp", sport: "baseball", year: 1997,
      setName: "Finest Jackie Robinson U.S. Mint",
    }];
    const { matches } = matchCellToManifest(cell("baseball", 1997, "topps-finest"), entries, {
      canonicalSetKey: norm,
    });
    expect(matches, "a subset product must not be acquired for its flagship's cell").toEqual([]);
  });

  it("a cell that ASKS for the subset still gets it — the guard is directional", () => {
    // The guard refuses promotion, not the subset itself. A holding whose own
    // key is the subset must still be able to acquire its page.
    const entries = [{
      id: "j", lane: "bcp", sport: "baseball", year: 1997,
      setName: "Finest Jackie Robinson U.S. Mint",
    }];
    const { matches } = matchCellToManifest(
      cell("baseball", 1997, "finest-jackie-robinson-u-s-mint"), entries,
    );
    expect(matches).toHaveLength(1);
  });

  it("prod's own 1997 topps-finest cell now resolves to exactly the flagship page", () => {
    // The end-to-end check against the REAL manifest, which is where this was
    // found. Whatever else matches, no candidate may be a narrower product.
    const { matches } = matchCellToManifest(
      cell("baseball", 1997, "topps-finest"), MANIFEST.entries as never[],
      { canonicalSetKey: norm },
    );
    for (const m of matches as Array<{ setName: string }>) {
      expect(m.setName, `${m.setName} is narrower than the cell asked for`)
        .not.toMatch(/Jackie Robinson/i);
    }
  });
});

// ── 9. THE AZURE LOGIN USES THIS REPO'S SECRET NAMES ──────────────────────
//
// Run 33991711284 failed at "Login to Azure" with
//
//   Login failed with Error: Using auth-type: SERVICE_PRINCIPAL.
//   Not all values are present. Ensure 'client-id' and 'tenant-id' are supplied.
//
// which reads like an OIDC-trust or permissions fault and was neither:
// `permissions: id-token: write` was already correct. The block named
// AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_SUBSCRIPTION_ID -- the names the
// azure/login README uses, and names this repo does not have. An UNDEFINED
// SECRET IS NOT AN ERROR in Actions: it renders as the empty string, so the
// step ran with no client-id at all. 67 other workflow logins here use the
// AZUREAPPSERVICE_*_<GUID> spellings; this was the only file that invented its
// own, which is why no other scheduled job caught it.
describe("the workflow authenticates the way the rest of the repo does", () => {
  const WF = read(".github", "workflows", "acquire-for-withheld-holdings.yml");
  const RUNNER = read(".github", "workflows", "backfill-runner.yml");

  const loginBlock = (src: string) => {
    const at = src.indexOf("uses: azure/login@v3");
    expect(at, "an azure/login step must exist").toBeGreaterThan(-1);
    return src.slice(at, at + 500);
  };

  it("it uses the SAME three secret names backfill-runner does", () => {
    const mine = loginBlock(WF);
    for (const re of [
      /client-id: \$\{\{ secrets\.(AZUREAPPSERVICE_CLIENTID_[A-Z0-9]+) \}\}/,
      /tenant-id: \$\{\{ secrets\.(AZUREAPPSERVICE_TENANTID_[A-Z0-9]+) \}\}/,
      /subscription-id: \$\{\{ secrets\.(AZUREAPPSERVICE_SUBSCRIPTIONID_[A-Z0-9]+) \}\}/,
    ]) {
      const m = re.exec(mine);
      expect(m, `the login block must supply ${re.source.split(":")[0]}`).toBeTruthy();
      // The name must be the one the runner actually uses, not merely
      // well-shaped: a plausible-looking GUID that does not exist resolves
      // empty and fails exactly the way run 33991711284 did.
      expect(RUNNER, `${m![1]} is not a secret any other workflow uses`)
        .toContain(`secrets.${m![1]}`);
    }
  });

  it("the README's generic names appear nowhere — they resolve to empty here", () => {
    for (const bad of ["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID"]) {
      expect(WF.includes(`secrets.${bad}`), `secrets.${bad} does not exist in this repo`).toBe(false);
    }
  });

  it("id-token: write is present — OIDC needs it even with the right names", () => {
    const perms = WF.slice(WF.indexOf("\npermissions:"), WF.indexOf("\nconcurrency:"));
    expect(perms).toMatch(/id-token: write/);
  });
});

// ── 10. A CATCH-ALL KEY IS NOT A PRODUCT ──────────────────────────────────
//
// Drew, 2026-09-05. `draft` and `flagship` are the #1715 catch-all buckets a
// mis-parse lands in when no MAKER could be read. They must never be minted,
// and no publisher has a page for them. The first prod run reported three
// holdings under them as "needs a source" -- an acquisition work item that
// would send someone hunting a 2025 "Draft" checklist that does not exist.
describe("a #1715 catch-all key parks its holdings, it does not queue them", () => {
  const SCRIPT = read("backend", "scripts", "acquire-for-withheld-holdings.cjs");

  it("draft and flagship are catch-all keys", () => {
    expect(lib.isCatchAllSetKey("draft")).toBe(true);
    expect(lib.isCatchAllSetKey("flagship")).toBe(true);
    expect(lib.isCatchAllSetKey("DRAFT")).toBe(true);
    expect(lib.isCatchAllSetKey(" flagship ")).toBe(true);
  });

  it("a real product is NOT one — the bucket must stay narrow", () => {
    for (const k of ["bowman-draft", "topps", "bowman-chrome", "draft-picks", ""]) {
      expect(lib.isCatchAllSetKey(k), `${k} is a product, not a catch-all`).toBe(false);
    }
  });

  it("the lane reports them UNREADABLE and never as needing a source", () => {
    expect(SCRIPT).toMatch(/isCatchAllSetKey\(c\.setKey\)/);
    // The two flags are set explicitly and oppositely: the whole ruling is that
    // these are a DIFFERENT finding from "needs a source", so collapsing them
    // would defeat it.
    const branch = SCRIPT.slice(SCRIPT.indexOf("if (isCatchAllSetKey(c.setKey))"), SCRIPT.indexOf("const { matches, corroborated }"));
    expect(branch).toMatch(/unreadable: true/);
    expect(branch).toMatch(/needsSource: false/);
    expect(branch).toMatch(/source: null/);
  });

  it("an unreadable cell is never dispatched", () => {
    // `actionable` is what the workflow's matrix executes.
    expect(SCRIPT).toMatch(/planned\.filter\(\(p\) => !p\.needsSource && !p\.unreadable\)/);
  });

  it("the manifest is not even asked — there is no product to look for", () => {
    const branch = SCRIPT.slice(SCRIPT.indexOf("if (isCatchAllSetKey(c.setKey))"), SCRIPT.indexOf("const { matches, corroborated }"));
    expect(branch).not.toMatch(/matchCellToManifest/);
  });

  it("it has its own count and its own heading", () => {
    expect(SCRIPT).toMatch(/unreadable: unreadable\.length/);
    expect(SCRIPT).toMatch(/UNREADABLE \(\$\{f\(unreadable\.length\)\}\)/);
    expect(SCRIPT).toMatch(/unreadableCells:/);
  });

  it("the ranked print tests `unreadable` FIRST, or it dereferences a null source", () => {
    // An unreadable cell has needsSource=false and source=null. A two-branch
    // ternary falls through to p.source.lane and throws.
    const at = SCRIPT.indexOf("const src = ");
    const src = SCRIPT.slice(at, at + 400);
    expect(src.indexOf("p.unreadable")).toBeGreaterThan(-1);
    expect(src.indexOf("p.unreadable")).toBeLessThan(src.indexOf("p.source.lane"));
  });
});

// ── 11. GATE 1 IS THREE-WAY, AND "0 ROWS" IS NOT "NOTHING TO DO" ──────────
//
// Run 33993803531 went green end to end and acquired NOTHING: all ten cells
// stopped at "0 rows — nothing to land". The gate required `rows > 0` from a
// dispatch run with apply=false, and `rows created` counts only what an APPLY
// wrote — so the condition was UNSATISFIABLE and the chain could never reach a
// rederive for any cell, ingested or not. The Bowman's Best report said:
//
//   catalog now: 3,810 rows   seeded=missing   prior=partial
//   rows created        0   (verified by catalog read, not claimed)
//   RECONCILED          yes
//
// 3,810 rows ARE the checklist. The gate read the dry run's zero as an empty
// catalog and conflated two OPPOSITE states.
describe("gate 1 tells an empty catalog from an already-ingested one", () => {
  const WF = read(".github", "workflows", "acquire-for-withheld-holdings.yml");
  const gate = WF.split(/^      - name: "?/m).find((s) => /^Gate: acquire, already-ingested/.test(s)) ?? "";

  it("the gate exists and names all three outcomes", () => {
    expect(gate.length, "the three-way gate 1 step must exist").toBeGreaterThan(200);
    for (const mode of ["already-ingested", "acquire", "needs-a-source"]) {
      expect(gate, `gate 1 must be able to conclude ${mode}`).toContain(mode);
    }
  });

  it("it reads `catalog now:`, which a REPORT prints, not `rows created`", () => {
    // The whole defect: `rows created` is an APPLY's number. A gate on it can
    // never pass from a report.
    expect(gate).toMatch(/catalog now/);
    expect(gate, "gate 1 must not gate on a count only an apply can produce")
      .not.toMatch(/rows created/);
  });

  it("a non-empty catalog proceeds as already-ingested", () => {
    expect(gate).toMatch(/IN_CATALOG.*-gt 0/s);
    expect(gate).toMatch(/MODE=already-ingested; PROCEED=yes/);
  });

  it("an unreadable count is NOT treated as an empty catalog", () => {
    // "(setKey/year not derivable — verify would refuse)" yields no digits.
    // Calling that zero would send the chain to acquire a product it cannot
    // even verify (feedback_never_dismiss_small_numbers_as_noise).
    expect(gate).toMatch(/-z "\$IN_CATALOG"/);
    expect(gate).toMatch(/not derivable/);
  });

  it("a failed reconciliation still refuses, ahead of every other branch", () => {
    const rec = gate.indexOf('RECONCILED" = "no"');
    const cat = gate.indexOf("-gt 0");
    expect(rec).toBeGreaterThan(-1);
    expect(rec, "the reconcile check must precede the catalog branch").toBeLessThan(cat);
  });

  it("needs-a-source survives unchanged: empty catalog AND no source", () => {
    expect(gate).toMatch(/catalog is empty and no source serves this set/);
  });
});

// ── 12. THE APPLY RUNS ONLY IN ACQUIRE MODE ───────────────────────────────
describe("an already-ingested cell skips the ingest apply and still proceeds", () => {
  const WF = read(".github", "workflows", "acquire-for-withheld-holdings.yml");
  const step = (re: RegExp) => WF.split(/^      - name: "?/m).find((s) => re.test(s)) ?? "";

  it("the apply is conditioned on mode == acquire, not on proceed", () => {
    const apply = step(/^Ingest apply/);
    expect(apply).toMatch(/if: \$\{\{ steps\.gate_ingest\.outputs\.mode == 'acquire' \}\}/);
    // Gating it on `proceed` would re-fetch a publisher page to mint nothing
    // for every already-ingested cell (CF-RECHECK-IS-NOT-REFETCH).
    expect(apply).not.toMatch(/if: \$\{\{ steps\.gate_ingest\.outputs\.proceed == 'yes' \}\}/);
  });

  it("gate 2 passes an already-ingested cell through on gate 1's catalog read", () => {
    const g2 = step(/^Gate: the ingest apply landed rows/);
    expect(g2).toMatch(/already-ingested/);
    expect(g2).toMatch(/proceed=yes/);
    // ...and still judges a real apply the old way when there was one.
    expect(g2).toMatch(/RECONCILED \+NO/);
    expect(g2).toMatch(/ingested\|partial/);
  });

  it("gate 3 is UNCHANGED — the rederive still refuses UNVERIFIED destinations", () => {
    const g3 = step(/^Gate: the rederive report proposes/);
    expect(g3).toMatch(/UNVERIFIED/);
    expect(g3).toMatch(/PROCEED=no/);
  });

  it("the rederive still runs for an already-ingested cell", () => {
    // It hangs off gate 2, which now says yes for both modes — that is the
    // whole point of the fix.
    const rr = step(/^Rederive report/);
    expect(rr).toMatch(/if: \$\{\{ steps\.gate_apply\.outputs\.proceed == 'yes' \}\}/);
  });
});

// ── 13. A STUCK HOLDING SAYS WHAT WOULD UNSTICK IT ────────────────────────
describe("holdings that do not re-point are classified by what unlocks them", () => {
  const WF = read(".github", "workflows", "acquire-for-withheld-holdings.yml");
  const step = WF.split(/^      - name: "?/m).find((s) => /^Classify the holdings/.test(s)) ?? "";
  it("the classify step exists and is report-only", () => {
    expect(step.length).toBeGreaterThan(200);
    // It must not produce a `proceed` that anything gates on: naming why one
    // holding is stuck must not decide whether others continue.
    expect(step).not.toMatch(/echo "proceed=/);
  });

  it("each distinct rederive verdict maps to the lane that fixes it", () => {
    // The vocabulary is read from the script's own prose rather than restated.
    for (const [phrase, unlock] of [
      ["no catalog row backs it", "retire-self-derived-identities"],
      ["player mismatch", "parked"],
      ["destination does not carry it", "parked"],
    ] as Array<[string, string]>) {
      expect(step, `${phrase} must be classified`).toContain(phrase);
      expect(step, `${phrase} must name its unlock`).toContain(unlock);
    }
    expect(step, "a blank-field no-match is the #1811 field-recovery lane")
      .toMatch(/#1811/);
  });


  it("the reasons reach the ledger and the outcome table", () => {
    expect(WF).toMatch(/"stuckReasons": "\$\{\{ steps\.classify\.outputs\.reasons \}\}"/);
    expect(WF).toMatch(/what is still stuck/);
    expect(WF).toMatch(/\.stuckReasons/);
  });

  it("the outcome table reports the MODE and the catalog count, not a dead `rows`", () => {
    expect(WF).toMatch(/\.gate1\.mode/);
    expect(WF).toMatch(/\.gate1\.inCatalog/);
    expect(WF, "gate1.rows no longer exists").not.toMatch(/\.gate1\.rows/);
  });
});

// ── 14. THE CLASSIFY STEP'S SHELL, PINNED ON THE REAL LOG SHAPES ──────────
//
// Run 33998562094: all ten cells FAILED at classify with
//
//   line 9: 0
//   0: syntax error in expression (error token is "0")
//   line 22: NM_FIELDS: unbound variable
//
// `grep -c` prints 0 AND EXITS 1 when nothing matches, so `$(grep -c ... ||
// echo 0)` ran the fallback TOO and produced the two-line string "0\n0";
// `$(( ))` then choked on it. The `|| echo 0` written to guarantee a number
// was the thing that destroyed it.
//
// The cost was not a cosmetic one: classify failed AFTER gate 3 said yes, and
// the rederive APPLY and the reprice were SKIPPED — ten cells' work lost to a
// step that only describes outcomes.
describe("the classify step counts with integers and cannot fail its cell", () => {
  const WF = read(".github", "workflows", "acquire-for-withheld-holdings.yml");
  const step = WF.split(/^      - name: "?/m).find((s) => /^Classify the holdings/.test(s)) ?? "";
  // The step's comments deliberately QUOTE the broken idiom in order to
  // explain it, so a shell-shape assertion must read CODE lines only —
  // otherwise the pin fails on its own documentation.
  const code = step.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

  it("no counter uses the `|| echo 0` idiom that produced \"0\n0\"", () => {
    expect(step.length).toBeGreaterThan(200);
    expect(code, 'grep -c prints 0 AND exits 1, so `|| echo 0` appends a SECOND zero')
      .not.toMatch(/grep -ac?[EF]?[^\n]*\|\|\s*echo 0/);
  });

  it("every count goes through one helper that yields digits or nothing", () => {
    // tr -cd '0-9' after head -1 makes a non-integer impossible by
    // construction, which is stronger than defending each call site.
    expect(step).toMatch(/num\(\)\s*\{/);
    expect(step).toMatch(/head -1[^\n]*tr -cd '0-9'/);
    expect(step).toMatch(/\[ -n "\$n" \] \|\| n=0/);
  });

  it("a classify fault can never fail the cell", () => {
    // The step describes an outcome; it must not be able to prevent one.
    expect(step).toMatch(/continue-on-error: true/);
    // `set -u` killed it on NM_FIELDS; `set -e` would kill it on any miscount.
    expect(step).toMatch(/set \+eu/);
    expect(step, "an -e/-u shell here loses the apply it was only describing")
      .not.toMatch(/set -euo|set -eu\b|set -uo pipefail/);
  });

  it("the blank/populated no-match split is real arithmetic, not two names", () => {
    // NM_BLANK=0; NM_FIELDS=0 would keep the names and silently drop every
    // no-match. One must be MEASURED, the other the REMAINDER.
    expect(step).toMatch(/NM_BLANK=\$\(grep[\s\S]{0,200}?NO MATCH/);
    expect(step).toMatch(/NM_FIELDS=\$\(\(\s*NM_ALL\s*-\s*NM_BLANK\s*\)\)/);
    expect(step).toMatch(/NM_FIELDS[^\n]*-lt 0[^\n]*NM_FIELDS=0/);
  });

  it("AGREE is counted — the verdict ten of ten cells actually returned", () => {
    // Run 33998562094's reports were almost entirely AGREE, and the table said
    // nothing about it. "already on the right identity" is a finding.
    expect(step).toMatch(/AGREE=\$\(num/);
    expect(step).toMatch(/REDERIVE=\$\(num/);
    expect(step).toMatch(/already on the right identity/);
  });
});

// ── 15. GATE 3 READS A VERDICT, NEVER A BANNER ────────────────────────────
//
// Run 33998562094 reported gate 3 = yes on all ten cells. Nine of them had
// only AGREE verdicts and one had a single NO-MATCH; not one proposed a
// re-point. The gate's `grep -i "...|REDERIVE"` was matching the lane's OWN
// banner — "MODE: rederive", "[mode] rederive — report only", and the script
// name in "Script confirmed: .../rederive-holding-identity.cjs". It was
// reading the dispatch, not the outcome.
describe("gate 3 gates on the rederive VERDICTS", () => {
  const WF = read(".github", "workflows", "acquire-for-withheld-holdings.yml");
  const gate = WF.split(/^      - name: "?/m).find((s) => /^Gate: the rederive report proposes/.test(s)) ?? "";
  const gateCode = gate.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

  it("the verdict match is anchored and case-sensitive", () => {
    expect(gate.length).toBeGreaterThan(200);
    expect(gate).toMatch(/\^\[\[:space:\]\]\*REDERIVE /);
    expect(gateCode, "a case-insensitive REDERIVE matches `MODE: rederive`")
      .not.toMatch(/grep -aqiE[^\n]*REDERIVE/);
  });

  it("the three real log shapes decide correctly", () => {
    // Reproduced from run 33998562094's own reports.
    const banner = '[mode]   rederive — report only\nScript confirmed: backend/scripts/rederive-holding-identity.cjs\n';
    const verdictRe = /^[ \t]*REDERIVE |"REDERIVE":[ \t]*[1-9]/m;
    const agreeRe = /^[ \t]*AGREE /m;

    const agreeLog = `${banner}  AGREE      Derek Jeter  1997 #BBP4  hiq:x\nSUMMARY  {"AGREE":2}\n`;
    const rederiveLog = `${banner}  REDERIVE   Conor Essenburg  2025 #CPA-CE\nSUMMARY  {"REDERIVE":1}\n`;
    const noMatchLog = `${banner}  NO MATCH   Somebody  2025 #X  from=null\nSUMMARY  {"NO-MATCH":1}\n`;

    // Only the real re-point proceeds.
    expect(verdictRe.test(rederiveLog)).toBe(true);
    expect(verdictRe.test(agreeLog), "an AGREE-only report must not proceed").toBe(false);
    expect(verdictRe.test(noMatchLog), "a NO-MATCH report must not proceed").toBe(false);
    // And the banner alone never satisfies it — the actual defect.
    expect(verdictRe.test(banner), "the lane's own banner is not a verdict").toBe(false);
    expect(agreeRe.test(agreeLog)).toBe(true);
  });

  it("an all-AGREE cell is reported as such, not as a failure", () => {
    // "already carries the right identity" is a legitimate outcome and the
    // operator needs to see it named, not read `no` and guess.
    expect(gate).toMatch(/AGREE/);
    expect(gate).toMatch(/nothing to re-point/);
  });

  it("UNVERIFIED still refuses, ahead of everything", () => {
    expect(gate).toMatch(/UNVERIFIED/);
  });
});

// ── 6. IN MODE=json, STDOUT IS THE DOCUMENT AND NOTHING ELSE ───────────────
//
// CF-A-DATA-CHANNEL-IS-NOT-A-LOG (#1846). Run 34019169292 — the first
// unattended night this workflow ran — planned correctly and then died on the
// step that reads the plan:
//
//   jq: parse error: Invalid literal at line 739, column 11
//   ##[error]Process completed with exit code 5
//
// Line 739 was `finishLane: exiting code 0`. The JSON closed on 738. Ten
// matched cells went unacquired because a log line was appended to a document.
//
// laneExitsWhenWorkIsDone.test.ts pins the HELPER's half (the exit line and the
// verify-cap notice take the fd the lane names, default stdout). This pins the
// LANE's half, and it does it by RUNNING the real script's MODE=json path
// against a fake Cosmos rather than by reading its source: a source scan for
// `console.log` cannot tell a suppressed call from a live one, and the defect
// that actually shipped was not in this file's source at all.
describe("MODE=json emits ONE parseable document on stdout", () => {
  /** The lane, run for real, with @azure/cosmos swapped for a fake. The
   *  require is intercepted through the module cache under the exact absolute
   *  specifier the lane resolves, so no path in the script changes. */
  function runLaneAsJson(extraSource = ""): { stdout: string; stderr: string; status: number | null } {
    const cosmosPath = require_.resolve(path.join(BACKEND, "node_modules/@azure/cosmos"));
    const probe = `
      const Module = require("node:module");
      const COSMOS = ${JSON.stringify(cosmosPath)};
      // Two portfolio docs, one holding each, both withheld on identity
      // grounds — enough to produce cells, a ranking and a tonight[] list.
      const HOLDINGS = {
        h1: { id: "h1", year: 2026, setKey: "bowman-chrome", sport: "baseball",
              playerName: "Some Player", cardNumber: "BCP-1",
              hobbyiqCardId: "hiq:baseball:2026:bowman-chrome:bcp-1",
              pricingSourceMeta: { withheld: { reason: "no-checklist-match" } } },
      };
      const DOCS = [
        { id: "u1", userId: "u1", holdings: HOLDINGS },
        { id: "u2", userId: "u2", holdings: { h2: { ...HOLDINGS.h1, id: "h2" } } },
      ];
      const answer = (sql) => /COUNT/i.test(String(sql && sql.query || sql)) ? [7] : DOCS;
      const container = () => ({
        items: { query: (q) => ({ fetchAll: async () => ({ resources: answer(q) }) }) },
      });
      require.cache[COSMOS] = new Module(COSMOS, null);
      require.cache[COSMOS].filename = COSMOS;
      require.cache[COSMOS].loaded = true;
      require.cache[COSMOS].exports = {
        CosmosClient: class { database() { return { container }; } dispose() {} },
      };
      ${extraSource}
      require(${JSON.stringify(path.join(BACKEND, "scripts", "acquire-for-withheld-holdings.cjs"))});
    `;
    const file = path.join(
      fs.mkdtempSync(path.join(require("node:os").tmpdir(), "acq-json-")),
      "probe.cjs",
    );
    fs.writeFileSync(file, probe);
    const r = spawnSync(process.execPath, [file], {
      encoding: "utf8",
      timeout: 60_000,
      killSignal: "SIGKILL",
      cwd: BACKEND,
      env: {
        ...process.env,
        MODE: "json",
        TOP: "10",
        OUT: "",
        BACKFILL_APPLY: "",
        COSMOS_CONNECTION_STRING: "AccountEndpoint=https://fake.invalid:443/;AccountKey=Zm9v;",
      },
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
  }

  it("the whole of stdout is the plan — JSON.parse, the way the workflow's jq reads it", () => {
    const r = runLaneAsJson();
    expect(r.status, r.stderr.slice(-2000)).toBe(0);

    let plan: { tonight: unknown[]; counts: Record<string, number> } | null = null;
    expect(
      () => { plan = JSON.parse(r.stdout) as typeof plan; },
      "stdout must be ONE document. Run 34019169292 died here on `jq: parse error: "
        + "Invalid literal at line 739, column 11` — line 739 being the helper's exit line.",
    ).not.toThrow();
    expect(plan, "the parse produced no plan").not.toBeNull();
    expect(Array.isArray(plan!.tonight), "the workflow slices .tonight with jq").toBe(true);
    expect(plan!.counts, "the ledger step reads .counts").toBeTruthy();
  });

  it("the banner, the reconcile AND the exit line all went to stderr instead", () => {
    const r = runLaneAsJson();
    // Not merely absent from stdout — PRESENT on stderr. A fix that silenced
    // the lane would pass a stdout-only assertion and blind the operator.
    expect(r.stderr).toContain("acquire-for-withheld-holdings");
    expect(r.stderr).toContain("RECONCILED");
    expect(r.stderr, "CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE still needs its proof")
      .toContain("finishLane: exiting code");
    expect(r.stdout).not.toContain("RECONCILED");
    expect(r.stdout).not.toContain("finishLane: exiting code");
  });

  // MUTATION. The pin the task asked for: any stray line on stdout in json
  // mode — a debug print, a library banner, a helper that ignores the mode —
  // must turn this red. It is injected rather than committed, so the mutation
  // is exercised on every run instead of living in a comment.
  it("MUTATION: one stray console.log on stdout and the document stops parsing", () => {
    const r = runLaneAsJson(`console.log("  scanned 131 holdings");`);
    expect(
      () => JSON.parse(r.stdout),
      "a stray stdout line did NOT break the parse, so this pin would not have caught "
        + "run 34019169292",
    ).toThrow();
  });
});
