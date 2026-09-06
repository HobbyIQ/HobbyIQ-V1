/**
 * THE STAMP'S SCOPE IS THE OUTPUT, NOT THE FILE.
 *
 * #1875 added `converterVersion` so that fixing a converter defect re-opens the
 * stale verdicts recorded under the broken one, without an operator having to
 * remember MODE=refetch for a population nobody has listed. It was stamped v2
 * for two defects in fetchSportsCardChecklist.cjs.
 *
 * THE VERY NEXT WRITER FIX WALKED STRAIGHT PAST IT. #1878 changed the CSV->
 * catalog writer's clash rule ("Base Set" is a page heading, not a subset), so
 * 407 checklist rows per product that had been refused against themselves would
 * now land. Nothing in the FETCHER changed, so the stamp stayed v2, so every
 * stale `partial` stayed closed -- and a pending-only walk for baseball 1957
 * reported "nothing intended" against the exact entries the fix was written to
 * re-open. The mechanism built to prevent that failure produced it, because its
 * scope was drawn around one FILE instead of one OUTPUT.
 *
 * A staged CSV is produced by the fetcher, but what a re-ingest of that CSV
 * actually LANDS is decided downstream:
 *
 *   fetchSportsCardChecklist.cjs      parsing, slug canonicalisation, verdicts
 *   ingest-checklist-csv-to-catalog.cjs   the clash / merge / write rules
 *   lib/subset-identity.cjs           what a row CLAIMS, and the rung key
 *
 * A change to any of the three changes the rows a stale verdict was recorded
 * against. So the version covers the whole pipe, and this pin makes that
 * enforceable rather than a comment someone has to remember.
 *
 * HOW IT IS ENFORCED. The decision-making FUNCTIONS are hashed -- not whole
 * files, which churn on every prose edit and would make the pin a nuisance that
 * gets deleted. Comments and whitespace are stripped before hashing, so
 * documentation changes freely and only BEHAVIOUR moves the hash. When one
 * moves, this test fails with the old and new hash and one instruction: bump
 * CONVERTER_VERSION (and LANE_CONVERTER_VERSION with it) if the change alters
 * what a re-ingest produces, then update the recorded hash here.
 *
 * DELIBERATELY A TRIPWIRE, NOT AN ORACLE. It cannot know whether a given edit
 * changes output; it knows the code that decides output moved and that a human
 * must answer the question. A refactor with identical behaviour updates the
 * hash and leaves the version alone -- and says so in its commit message.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, "..", "scripts");
const FETCHER = path.join(SCRIPTS, "fetchSportsCardChecklist.cjs");
const DRIVER = path.join(SCRIPTS, "ingest-universe-driver.cjs");
const WRITER = path.join(SCRIPTS, "ingest-checklist-csv-to-catalog.cjs");
const SUBSET = path.join(SCRIPTS, "lib", "subset-identity.cjs");

const { CONVERTER_VERSION } = require_(FETCHER);
const { LANE_CONVERTER_VERSION } = require_(DRIVER);

/**
 * The source of one top-level `function NAME(...) {...}`, found by brace
 * matching so a nested `}` inside a string or a block does not truncate it.
 */
function functionSource(src: string, name: string): string | null {
  const re = new RegExp(String.raw`(?:^|\n)(?:async\s+)?function\s+${name}\s*\(`);
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf("{", m.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  return null;
}

/** Comments and whitespace removed: prose churn must not move the hash. */
function behaviourOnly(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * THE FUNCTIONS THAT DECIDE WHAT A RE-INGEST PRODUCES, with the hash recorded
 * at the version named beside them. A name that disappears fails loudly rather
 * than silently hashing nothing.
 */
const WATCHED: Array<{ file: string; label: string; fn: string; hash: string }> = [
  // What a row CLAIMS, and therefore whether two rows clash. #1878 changed
  // exactly this, and it is the reason the pin exists.
  { file: SUBSET, label: "subset-identity", fn: "claimedSubsetOf", hash: "" },
  { file: SUBSET, label: "subset-identity", fn: "isBaseSectionLabel", hash: "" },
  { file: SUBSET, label: "subset-identity", fn: "foldSubsetText", hash: "" },
  { file: SUBSET, label: "subset-identity", fn: "rungKey", hash: "" },
  // The fetcher's own output decisions.
  { file: FETCHER, label: "fetcher", fn: "zeroCardReason", hash: "" },
  { file: FETCHER, label: "fetcher", fn: "canonicalSlug", hash: "" },
  { file: FETCHER, label: "fetcher", fn: "parseSetUrl", hash: "" },
  { file: FETCHER, label: "fetcher", fn: "buildRows", hash: "" },
  { file: FETCHER, label: "fetcher", fn: "splitParentAndSubset", hash: "" },
  { file: FETCHER, label: "fetcher", fn: "parallelFromSlug", hash: "" },
];

/** The recorded behaviour hash for each watched function, at CONVERTER_VERSION 4. */
const RECORDED: Record<string, string> = {
  "subset-identity:claimedSubsetOf": "def8b0f7187288a3",
  "subset-identity:isBaseSectionLabel": "5f89a5eff2a078ec",
  "subset-identity:foldSubsetText": "4c33bdf4b3715ea5",
  "subset-identity:rungKey": "9526fcf87cecbb79",
  "fetcher:zeroCardReason": "eba4eeac8e75c68b",
  "fetcher:canonicalSlug": "f0c397eb06ab28ca",
  "fetcher:parseSetUrl": "97144f0493f00e31",
  "fetcher:buildRows": "96799fa6888560a4",
  "fetcher:splitParentAndSubset": "17f62334a02e1960",
  "fetcher:parallelFromSlug": "fd2bea5160dd904e",
};

const keyOf = (w: { label: string; fn: string }) => `${w.label}:${w.fn}`;

/** Every watched function's current behaviour hash. */
function currentHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const w of WATCHED) {
    const src = fs.readFileSync(w.file, "utf8");
    const code = functionSource(src, w.fn);
    expect(code, `${keyOf(w)} must exist — if it was renamed or inlined, update WATCHED and answer the version question`).toBeTruthy();
    out[keyOf(w)] = sha(behaviourOnly(code as string));
  }
  return out;
}

// ── the bump itself ──────────────────────────────────────────────────────────

describe("the SCC converter is at v4 — bumped again by the soft-block work", () => {
  it("the fetcher stamps v4", () => {
    expect(CONVERTER_VERSION).toBe(4);
  });

  it("the driver's lane table agrees -- a disagreement re-opens nothing", () => {
    // These are read from two different files at two different times. If they
    // drift, the driver compares staged files against a version the fetcher
    // never writes, and either everything or nothing is stale.
    expect(LANE_CONVERTER_VERSION.sportscardchecklist).toBe(CONVERTER_VERSION);
  });

  it("v3 names #1878 as its reason, in the file a reader lands on", () => {
    const src = fs.readFileSync(FETCHER, "utf8");
    expect(src).toContain("#1878");
    expect(src).toContain("Base Set");
  });

  it("the version history is append-only -- v1 and v2 keep their entries", () => {
    // A history that gets rewritten cannot be used to reason about which staged
    // files are stale and why.
    const src = fs.readFileSync(FETCHER, "utf8");
    expect(src).toContain("1  original vintage lane");
    expect(src).toContain("#1848");
    expect(src).toContain("#1875");
  });

  it("the comment states the WHOLE-PIPE scope, naming all three files", () => {
    const src = fs.readFileSync(FETCHER, "utf8");
    for (const f of ["ingest-checklist-csv-to-catalog.cjs", "subset-identity.cjs"]) {
      expect(src, `the scope note must name ${f}`).toContain(f);
    }
  });

  it("no other lane is versioned -- staged-wins is unchanged for them", () => {
    expect(Object.keys(LANE_CONVERTER_VERSION)).toEqual(["sportscardchecklist"]);
  });
});

// ── the tripwire ─────────────────────────────────────────────────────────────

describe("a change to the deciding code cannot land without answering the version question", () => {
  it("every watched function still exists and is extractable", () => {
    const now = currentHashes();
    expect(Object.keys(now).sort()).toEqual(Object.keys(RECORDED).sort());
  });

  it("no watched function has moved since v3 was recorded", () => {
    const now = currentHashes();
    const moved = Object.keys(RECORDED)
      .filter((k) => now[k] !== RECORDED[k])
      .map((k) => `${k}: recorded ${RECORDED[k]} -> now ${now[k]}`);
    expect(
      moved,
      [
        "",
        "The code that decides what an SCC re-ingest PRODUCES has changed.",
        "",
        moved.join("\n"),
        "",
        "If the change alters what a re-ingest lands (rows written, clashes",
        "resolved, verdicts reached), BUMP CONVERTER_VERSION in",
        "scripts/fetchSportsCardChecklist.cjs and LANE_CONVERTER_VERSION in",
        "scripts/ingest-universe-driver.cjs, add a history line naming the PR,",
        "and update RECORDED below. Stale verdicts then re-open on their own.",
        "",
        "If it is a pure refactor with identical behaviour, update RECORDED",
        "only -- and say so in the commit message.",
        "",
      ].join("\n"),
    ).toEqual([]);
  });

  it("the hash ignores comments and whitespace, so prose churn is free", () => {
    // Proves the pin is not a nuisance: the same code with different
    // documentation hashes identically, so nobody is tempted to delete it.
    const a = "function f(a) {\n  // explain\n  return a + 1;\n}";
    const b = "function f(a) {\n  /* a much longer\n     explanation */\n  return a + 1;\n}";
    expect(sha(behaviourOnly(a))).toBe(sha(behaviourOnly(b)));
  });

  it("...but a real behaviour change does move it", () => {
    const a = "function f(a) { return a + 1; }";
    const b = "function f(a) { return a + 2; }";
    expect(sha(behaviourOnly(a))).not.toBe(sha(behaviourOnly(b)));
  });

  it("a URL inside the code is not mistaken for a comment", () => {
    // The `//` in "https://..." must not truncate the body being hashed.
    const withUrl = 'function f() { return "https://example.com/x"; }';
    expect(behaviourOnly(withUrl)).toContain("https://example.com/x");
  });

  it("the watched set covers the writer's clash rules, not just the fetcher", () => {
    // The whole point of v3: a fetcher-only watch is what let #1878 through.
    const labels = new Set(WATCHED.map((w) => w.label));
    expect(labels.has("subset-identity")).toBe(true);
    expect(WATCHED.some((w) => w.fn === "claimedSubsetOf")).toBe(true);
  });

  it("the writer itself is watched for its clash call site", () => {
    // subset-identity decides the claim; the writer decides what to DO with a
    // clash. A change to the refusal branch is a change to what lands.
    const src = fs.readFileSync(WRITER, "utf8");
    expect(src).toContain("claimedSubsetOf");
    expect(src).toContain("subsetCollision++");
  });
});

// ── the bump actually re-opens verdicts ──────────────────────────────────────

/**
 * THE HALF THAT WAS MISSING. #1875 read the stamp inside acquireFromStaging --
 * which only runs for an entry that already reached the queue -- while the
 * queue filter dropped every terminal verdict first. So the stamp could pass
 * over a stale staged FILE and never re-open a stale VERDICT, and a converter
 * fix changed nothing for the entries it was written for.
 */
describe("a converter bump re-opens the verdicts recorded under the old one", () => {
  const src = fs.readFileSync(DRIVER, "utf8");

  it("the queue filter consults the converter version, not just the status", () => {
    expect(src).toContain("if (!staleByConverter(prior)) continue;");
  });

  it("a verdict at the CURRENT version stays terminal -- the bump costs once", () => {
    // Without this a re-opened entry re-opens on every subsequent run.
    expect(src).toContain("return !(Number.isFinite(at) && at >= current);");
  });

  it("the control doc records the version that reached the verdict", () => {
    // The other half: a verdict that never records its version can never
    // become current, so the entry would re-open forever.
    expect(src).toContain("converterVersion: LANE_CONVERTER_VERSION[entry.lane] ?? null,");
  });

  it("the prior-verdict query actually SELECTs it", () => {
    // Cosmos returns only the projected fields. Omitting it here would make
    // every verdict read as unstamped and re-open the whole lane, every run.
    expect(src).toContain("SELECT c.entryId, c.status, c.attempts, c.converterVersion FROM c");
  });

  it("the `failed` attempts ceiling is untouched", () => {
    // A lane broken for its own reasons must still stop after three tries; the
    // bump re-opens terminal verdicts, never the retry budget.
    expect(src).toContain('prior.status === "failed" && (prior.attempts || 0) >= 3');
  });

  it("an unversioned lane is unaffected -- no lane but SCC can be re-opened", () => {
    const { staleByConverterProbe } = { staleByConverterProbe: (lane: string, prior: any) => {
      const current = (LANE_CONVERTER_VERSION as Record<string, number>)[lane];
      if (!current || !prior) return false;
      const at = Number(prior.converterVersion);
      return !(Number.isFinite(at) && at >= current);
    } };
    // The rule, applied exactly as the driver applies it.
    expect(staleByConverterProbe("bcp", { status: "partial" })).toBe(false);
    expect(staleByConverterProbe("beckett", { status: "partial", converterVersion: 1 })).toBe(false);
    // ...and for SCC: unstamped and older re-open, current does not.
    // Expressed RELATIVE to the current version, never as literals: the whole
    // point of this file is that the version moves, and a pin that hardcodes it
    // breaks on the next bump for no reason (it did, on v3 -> v4).
    const cur = CONVERTER_VERSION;
    expect(staleByConverterProbe("sportscardchecklist", { status: "partial" })).toBe(true);
    expect(staleByConverterProbe("sportscardchecklist", { status: "partial", converterVersion: cur - 1 })).toBe(true);
    expect(staleByConverterProbe("sportscardchecklist", { status: "partial", converterVersion: cur })).toBe(false);
    expect(staleByConverterProbe("sportscardchecklist", { status: "partial", converterVersion: cur + 1 })).toBe(false);
  });

  it("the run says how many it re-opened, so the effect is visible", () => {
    expect(src).toContain("re-opened ${f(reopened)} terminal verdict(s) recorded by an older converter");
  });
});
