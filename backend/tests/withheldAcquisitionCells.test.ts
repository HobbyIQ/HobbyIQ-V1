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
    expect(SCRIPT).toMatch(/budget\(\{\s*minutes:\s*\d+,\s*reserveMs:[^}]*verifyMs:/s);
  });

  it("GATE 1: the driver APPLY is gated on a reconciled report with rows > 0", () => {
    const step = WF.split(/^      - name: "?/m).find((s) => /^Gate: the ingest report/.test(s));
    expect(step, "the ingest report gate step must exist").toBeTruthy();
    expect(step).toMatch(/RECONCILED/);
    expect(step).toMatch(/ingested|partial/);
  });

  it("GATE 2: the rederive only runs after an INGESTED verdict", () => {
    const step = WF.split(/^      - name: "?/m).find((s) => /^Gate: the ingest apply landed rows/.test(s));
    expect(step, "the ingest apply gate step must exist").toBeTruthy();
    expect(step).toMatch(/ingested|partial/);
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
