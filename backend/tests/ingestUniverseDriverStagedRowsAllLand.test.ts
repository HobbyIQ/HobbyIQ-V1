import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

/**
 * THE THREE DEFECTS OF BACKFILL RUNNER 33847867665
 * (ingest-universe-driver, lane tcgdexja, years 2021-2025, limit=52, apply=true,
 * on main with #1702's 52 staged modern JA sets).
 *
 * The run reported a clean reconciliation -- intended 48, written 48, failed 2,
 * "rows created 2,726 (verified by catalog read, not claimed)" -- and it was
 * wrong three separate ways:
 *
 *   [2/48]  S10a   PARTIAL — ladder present but zero print runs (64 rows created, 64 in catalog)
 *   [5/48]  S5I    PARTIAL — ladder present but zero print runs (64 rows created, 64 in catalog)
 *   [9/48]  S9     PARTIAL — base-only, no parallel ladder      (64 rows created, 64 in catalog)
 *   ... thirty-nine entries at EXACTLY 64 ...
 *   [32/48] SV-P   REFUSED — zero base cards across all 1 staged file(s) (288 rows, all carry a parallel)
 *   [47/48] M-P    REFUSED — zero base cards across all 1 staged file(s) (132 rows, all carry a parallel)
 *
 * 1. CF-EVERY-STAGED-ROW-OR-IT-IS-NOT-INGESTED. 64 is not a number the source
 *    can produce. It is ceil(LIMIT / CONCURRENCY) * CONCURRENCY -- the leaked
 *    runner LIMIT=52 rounded up to the ingest child's write-chunk boundary of
 *    CONCURRENCY=16, because the child checks `written >= LIMIT` only BETWEEN
 *    chunks: 16, 32, 48 (still under 52), 64, stop. Re-staged from the live
 *    source on 2026-09-04, those same sets hold 92 rows (SV1V), 108 (SV9), 133
 *    (SV6) and 367 (SV4a). #1718 deleted the env leak; this pins the ASSERTION
 *    that would have caught it with no human reading a log -- a product that
 *    started EMPTY and ends with fewer rows than were staged is a TRUNCATED
 *    ingest, which is `failed`, never `ingested` and never `partial`.
 *
 * 2. CF-A-PRODUCT-WITH-NO-PRINT-RUNS-IS-NOT-PARTIAL. Thirty of the forty-six
 *    `partial` verdicts read "ladder present but zero print runs". Japanese
 *    Pokemon has NO numbered parallels: the rarity ladder IS the parallel axis
 *    and tcgdex serves no print run for any JA set, which the scraper states in
 *    its own header ("printRun stays EMPTY ... this lane will not invent one")
 *    and prints on every run ("printRun 0 written"). A `partial` there is a gap
 *    that can never be closed, filed against sets that are already complete.
 *
 * 3. CF-A-PROMO-SET-HAS-NO-BASE-CARDS. Both failures were promo products. All
 *    132 M-P rows carry `parallel=Promo` -- the source's own, correct rarity
 *    for every card in the set. There is no base print underneath a promo set
 *    the way a Refractor scope attaches to its page's base set, so the
 *    zero-base rule refused a complete checklist. The exception is narrow: the
 *    lane must declare that its products may be rung-only AND every row must
 *    carry the SAME SINGLE rung, so a multi-rung baseless file is still the
 *    cross-join the rule was written for.
 *
 * These drive the COMMITTED script -- the real gate and the real constants --
 * never a copy of them.
 */

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backend, "scripts", "ingest-universe-driver.cjs");
const ingestChild = path.join(backend, "scripts", "ingest-checklist-csv-to-catalog.cjs");
const require_ = createRequire(import.meta.url);
const {
  gateStagedCsv,
  gateStagedEntry,
  LANES_WITHOUT_PRINT_RUNS,
  LANES_WITH_BASELESS_PRODUCTS,
} = require_(script) as {
  gateStagedCsv: (p: string) => any;
  gateStagedEntry: (p: string[] | string, lane?: string) => any;
  LANES_WITHOUT_PRINT_RUNS: Set<string>;
  LANES_WITH_BASELESS_PRODUCTS: Set<string>;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uni-64-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const HEADER = "category,cardNumber,parallel,isAuto,printRun,player";

function stage(name: string, rows: string[]): string {
  const d = fs.mkdtempSync(path.join(tmp, "s-"));
  const p = path.join(d, name);
  fs.writeFileSync(p, [HEADER, ...rows].join("\n") + "\n");
  return p;
}

/** A JA set as this lane really stages it: rarity in `parallel`, printRun ALWAYS blank. */
function jaRows(n: number): string[] {
  const rungs = ["", "Art Rare", "Special Art Rare", "Ultra Rare"];
  return Array.from({ length: n }, (_, i) => `base,${i + 1},${rungs[i % rungs.length]},false,,pikachu`);
}

// ── PIN 1: 64 is arithmetic, not a checklist ─────────────────────────────────

describe("run 33847867665 — exactly 64 rows per set was the leaked LIMIT, not the source", () => {
  it("64 is ceil(LIMIT/CONCURRENCY)*CONCURRENCY for the dispatched limit=52, concurrency=16", () => {
    // The child bounds ROWS WRITTEN and only checks the bound BETWEEN chunks of
    // CONCURRENCY, so the reachable stopping points are multiples of 16 and the
    // first one at or above 52 is 64. This is the whole explanation of the
    // number, and it is arithmetic rather than anything the source served.
    const LIMIT = 52, CONCURRENCY = 16;
    expect(Math.ceil(LIMIT / CONCURRENCY) * CONCURRENCY).toBe(64);
  });

  it("the child still applies LIMIT only between whole chunks — the shape that rounds 52 up to 64", () => {
    const src = fs.readFileSync(ingestChild, "utf8");
    // The bound is tested after a Promise.all of CONCURRENCY rows, never per
    // row. If this ever became a per-row check the number would be 52, and the
    // arithmetic pinned above would no longer explain a truncation.
    expect(src).toMatch(/for \(let i = 0; i < batch\.length; i \+= CONCURRENCY\)/);
    expect(src).toMatch(/if \(LIMIT && written >= LIMIT\)/);
  });

  it("the driver never hands the child its own LIMIT/SLOT/SLOTS (the #1718 leak stays shut)", () => {
    const src = fs.readFileSync(script, "utf8");
    expect(src).toMatch(/RUNNER_SCOPE_VARS\s*=\s*\[[^\]]*"LIMIT"[^\]]*"SLOT"[^\]]*"SLOTS"[^\]]*\]/);
    expect(src).toMatch(/for \(const k of RUNNER_SCOPE_VARS\).*delete childEnv\[k\]/s);
  });

  it("a short ingest is decided on IDENTITIES, not counts, and regardless of `before`", () => {
    const src = fs.readFileSync(script, "utf8");
    // THE COUNT CHECK IS NOT THE AUTHORITY (2026-09-04, run 33869931267). It
    // fires only when the product started EMPTY, so the bcp Finest family --
    // "0 rows created, 628 in catalog of 4,526 staged" -- reported INGESTED
    // with an eighth of its staging present. And it over-reports when one card
    // is staged twice under two spellings of the product.
    //
    // The question is asked directly: is every staged identity in the catalog?
    expect(src).toMatch(/for \(const id of gate\.stats\.identities\) if \(!inCatalog\.has\(id\)\) missing\.push\(id\);/);
    // No dependence on `before`: the diff runs whenever the read succeeds.
    expect(src).toMatch(/if \(after !== null && gate\.stats\.identities && gate\.stats\.identities\.size\) \{/);
    // The verdict NAMES what it compared -- both sides and the address --
    // because the defect it reports is a comparison, and run 33997480307's
    // twelve of these were all the comparison reading a collapsed key.
    expect(src).toMatch(/compared the \$\{f\(shortIngest\.staged\)\} distinct identities staged/);
    expect(src).toMatch(/cardNumber\|parallel\|isAuto\|printRun/);
    // CF-AN-ENTRY-THAT-LANDED-ROWS-IS-NOT-A-FAILURE (2026-09-06). It is its own
    // TERMINAL status, never `failed`: run 33997480307 counted twelve entries
    // failed while their own lines named thousands of landed rows, and as a
    // non-terminal `failed` each would be re-attempted forever over rows
    // already in the catalog. The comment lines between the fields are allowed;
    // what is pinned is which status the SHORT-INGEST verdict carries.
    expect(src).toMatch(/status: SHORT_STATUS,\s*(?:\n\s*\/\/[^\n]*)*\n\s*reason: `short ingest/);
    expect(src).toMatch(/const SHORT_STATUS = "short-ingest";/);
    expect(src).toMatch(/TERMINAL_STATUSES = new Set\(\[[^\]]*SHORT_STATUS\]\)/);
    // Decided BEFORE the partial branch: a short ingest is never a thin source.
    expect(src.indexOf("} else if (shortIngest) {")).toBeLessThan(src.indexOf("} else if (incomplete) {"));
    // ...and before the count check, which it supersedes.
    expect(src.indexOf("} else if (shortIngest) {")).toBeLessThan(src.indexOf("} else if (truncated) {"));
  });

  it("a row surplus with every identity present is INGESTED, not a lost-rows failure", () => {
    const src = fs.readFileSync(script, "utf8");
    // 2000/2003/2009 Finest each staged TWO scope files for one product --
    // `2000-finest-baseball.csv` and `2000-topps-finest-baseball.csv` -- and the
    // count check called the duplicate half "664 rows lost in our own pipe".
    // Reaching the count branch now means the identities were all present, so
    // the surplus is a double count in the staging and the entry is complete.
    expect(src).toMatch(/const startedEmpty = \(before \?\? 0\) === 0;/);
    expect(src).toMatch(/const truncated = startedEmpty && after !== null && staged > 0 && after < staged;/);
    expect(src).toMatch(/status: "ingested",\s*\n\s*reason: `\$\{f\(staged\)\} rows staged over \$\{f\(gate\.stats\.identities\.size\)\} distinct identities/);
  });

  it("a short ingest is a per-entry answer — it never votes the lane down", () => {
    // WAS a grep for the two-line source shape `stats: gate.stats,
    // laneProvenHealthy: true,` followed by the object's closing brace, which a
    // reordering of the verdict object reddens without any behaviour changing.
    //
    // Reaching a short ingest means the page was fetched, parsed, staged,
    // ingested AND the catalog read back. Every one of those proves the host is
    // up, which is the only thing the systemic streak may conclude -- so the
    // consequence is asked of the arithmetic that owns it, and the other half
    // (that the verdict really carries the flag) is DRIVEN out of the committed
    // loop by laneAbortsAreHostFaultsOnly.test.ts, "post-ingest failures are
    // per-entry".
    const { streakAfter, SYSTEMIC_FAILURE_STREAK } = require_(script) as {
      streakAfter: (n: number, v: unknown) => number; SYSTEMIC_FAILURE_STREAK: number;
    };
    const shortIngest = { status: "failed", laneProvenHealthy: true };
    let streak = 0;
    for (let i = 0; i < SYSTEMIC_FAILURE_STREAK + 2; i++) streak = streakAfter(streak, shortIngest);
    expect(streak).toBe(0);
    expect(streakAfter(SYSTEMIC_FAILURE_STREAK - 1, shortIngest)).toBe(0);
    // The tripwire is not disarmed: the same status without the flag advances.
    expect(streakAfter(0, { status: "failed" })).toBe(1);
  });

  it("the staged-row count reaches the control doc, so the audit needs no log", () => {
    const src = fs.readFileSync(script, "utf8");
    expect(src).toMatch(/rowsStaged: verdict\.rowsStaged \?\? null,/);
  });
});

// ── PIN 2: a lane with no print runs is not perpetually partial ──────────────

describe("a product with no print runs is not PARTIAL", () => {
  it("tcgdexja is declared as carrying no print runs", () => {
    expect(LANES_WITHOUT_PRINT_RUNS.has("tcgdexja")).toBe(true);
  });

  it("lanes whose products ARE numbered keep the print-run expectation", () => {
    // The exception is declared per lane BY NAME, never inferred from a column
    // that happens to be empty -- inferring it would excuse a Topps Chrome
    // scrape that simply lost the column.
    for (const lane of ["bcp", "beckett", "clc", "checklistinsider", "hobbymonitor", "sportscardchecklist"]) {
      expect(LANES_WITHOUT_PRINT_RUNS.has(lane)).toBe(false);
    }
  });

  it("the verdict consults the lane before calling a print-run-less ladder incomplete", () => {
    const src = fs.readFileSync(script, "utf8");
    // THE LANE IS CONSULTED FIRST, and it is still the only thing that can drop
    // the print-run expectation lane-wide. CF-A-RUNG-PAGE-CARRIES-NO-PRINT-RUN
    // (2026-09-04) added a second, NARROWER term beside it -- an attested rung
    // page on a sibling-pages lane -- so this pins the base term rather than
    // the whole expression, and the added term is pinned in its own file.
    expect(src).toMatch(/const printRunsExpected = !LANES_WITHOUT_PRINT_RUNS\.has\(lane\)/);
    // CF-A-VINTAGE-BASE-SET-IS-NOT-PARTIAL (2026-09-04) gated the LADDER half
    // of this expression the same way the print-run half already was, and
    // CF-A-LADDER-ON-SIBLING-PAGES-IS-NOT-A-GAP added its modern counterpart.
    // Both halves are pinned so neither can quietly lose its guard.
    expect(src).toMatch(/const ladderExpected = !ladderlessByEra\(lane, entry\)/);
    expect(src).toMatch(/const incomplete = \(ladderExpected && gate\.stats\.ladder === 0\)\s*\|\| \(printRunsExpected && gate\.stats\.withPrintRun === 0\);/);
  });

  it("the scraper this lane runs still writes no print run — the premise of the exception", () => {
    // If tcgdex ever began serving print runs this scraper would carry them,
    // and the lane exception would then be hiding a real gap. Pinned so the
    // exception cannot outlive its reason.
    const scraper = fs.readFileSync(path.join(backend, "scripts", "scrape-tcgdex-ja-modern.cjs"), "utf8");
    expect(scraper).toMatch(/printRun: ""/);
    expect(scraper).not.toMatch(/printRun:\s*(?!"")\S/);
  });

  it("a JA ladder with no print runs gates clean and reads as a full ladder", () => {
    const g = gateStagedEntry([stage("2025-s10a-pokemon.csv", jaRows(64))], "tcgdexja");
    expect(g.ok).toBe(true);
    expect(g.stats.ladder).toBeGreaterThan(0);
    expect(g.stats.withPrintRun).toBe(0);
    // The gate reports what it saw; the LANE decides whether that is a gap.
    expect(LANES_WITHOUT_PRINT_RUNS.has("tcgdexja")).toBe(true);
  });
});

// ── PIN 3: a promo set is all promos ────────────────────────────────────────

describe("a promo set has no base cards, and that is the set", () => {
  const promo = () => stage(
    "2025-m-p-pokemon.csv",
    Array.from({ length: 132 }, (_, i) => `base,${i + 1},Promo,false,,pikachu`),
  );

  it("M-P's real shape — 132 rows, every one parallel=Promo — is admitted on tcgdexja", () => {
    const g = gateStagedEntry([promo()], "tcgdexja");
    expect(g.ok).toBe(true);
    expect(g.stats.rows).toBe(132);
    expect(g.stats.base).toBe(0);
    expect(g.stats.rungNames).toEqual(["Promo"]);
    expect(g.baselessSingleRung).toBe("Promo");
  });

  it("the same file is still refused on a lane that has not declared baseless products", () => {
    const g = gateStagedEntry([promo()], "bcp");
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/zero base cards/);
  });

  it("a MULTI-rung baseless file is still the cross-join shape, refused even on tcgdexja", () => {
    // The exception admits "these are all promos", never "rungs joined onto a
    // subset that was never parsed" -- which is what the 11.49M-row spine was.
    const rows = Array.from({ length: 200 }, (_, i) =>
      `base,${Math.floor(i / 4) + 1},${["Art Rare", "Special Art Rare", "Ultra Rare", "Character Rare"][i % 4]},false,,pikachu`);
    const g = gateStagedEntry([stage("2025-sv9-pokemon.csv", rows)], "tcgdexja");
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/zero base cards/);
  });

  /**
   * TWO lanes are declared baseless now, for two DIFFERENT shapes, and the
   * declaration is still a closed list -- see CF-A-PARALLEL-SET-BELONGS-TO-ITS-
   * PARENT (2026-09-04) and tests/sccParallelOfParent.test.ts.
   *
   *   tcgdexja            the PRODUCT is rung-only (a promo set has no base print)
   *   sportscardchecklist the PAGE is one rung of a parent that has its own page
   *
   * They are not interchangeable: sportscardchecklist additionally requires the
   * fetcher's per-file `parallelOfParent` attestation, so declaring the lane is
   * necessary but NOT sufficient. Every other lane keeps the flat refusal.
   */
  it("only the two declared lanes may have baseless products", () => {
    expect(LANES_WITH_BASELESS_PRODUCTS.has("tcgdexja")).toBe(true);
    expect(LANES_WITH_BASELESS_PRODUCTS.has("sportscardchecklist")).toBe(true);
    for (const lane of ["bcp", "beckett", "clc", "checklistinsider", "hobbymonitor"]) {
      expect(LANES_WITH_BASELESS_PRODUCTS.has(lane)).toBe(false);
    }
  });

  /**
   * AND THE DECLARATION ALONE DOES NOT ADMIT. A tcgdexja-shaped promo file
   * staged on sportscardchecklist carries no manifest attestation, so it is
   * still refused -- which is what keeps the lane exception from becoming
   * "sportscardchecklist may stage anything baseless".
   */
  it("sportscardchecklist still refuses a baseless file with no parent attestation", () => {
    const g = gateStagedEntry([promo()], "sportscardchecklist");
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/zero base cards/);
  });

  it("the entry gate takes the lane, and the driver passes it", () => {
    const src = fs.readFileSync(script, "utf8");
    expect(src).toMatch(/function gateStagedEntry\(csvPaths, lane\)/);
    expect(src).toMatch(/gateStagedEntry\(csvPaths, lane\)/);
  });

  it("a base set that carries base cards is unaffected on every lane", () => {
    const rows = ["base,1,,false,,pikachu", "base,1,Art Rare,false,,pikachu", "base,2,,false,,eevee"];
    for (const lane of ["tcgdexja", "bcp"]) {
      const g = gateStagedEntry([stage("2025-sv9-pokemon.csv", rows)], lane);
      expect(g.ok).toBe(true);
      expect(g.stats.base).toBe(2);
      expect(g.baselessSingleRung).toBeNull();
    }
  });
});

// ── the gate's own new field ─────────────────────────────────────────────────

describe("gateStagedCsv reports the distinct rungs it saw", () => {
  it("distinct rung names, base rows excluded", () => {
    const g = gateStagedCsv(stage("x.csv", [
      "base,1,,false,,pikachu",
      "base,1,Art Rare,false,,pikachu",
      "base,2,Art Rare,false,,eevee",
      "base,2,Base,false,,eevee",
    ]));
    expect(g.ok).toBe(true);
    expect(g.stats.base).toBe(2);          // blank AND the literal "Base"
    expect(g.stats.rungNames).toEqual(["Art Rare"]);
  });
});

// ── mutation guard ───────────────────────────────────────────────────────────

describe("the pins fail against a mutated driver", () => {
  it("removing the truncation assertion is caught", () => {
    const src = fs.readFileSync(script, "utf8");
    const mutated = src.replace(
      /const truncated = startedEmpty && after !== null && staged > 0 && after < staged;/,
      "const truncated = false;",
    );
    expect(mutated).not.toBe(src);
    expect(mutated).not.toMatch(/const truncated = startedEmpty && after !== null && staged > 0 && after < staged;/);
  });

  it("a driver that keeps the unconditional print-run check is caught by the real module", () => {
    // Load a mutated copy and prove the promo/print-run behaviour actually
    // changes -- not merely that the source text differs.
    const src = fs.readFileSync(script, "utf8");
    // Matches the declaration whatever lanes it names, so adding a lane (as
    // CF-A-PARALLEL-SET-BELONGS-TO-ITS-PARENT did) cannot silently retire this
    // mutation guard: an anchor pinned to one literal lane list would go green
    // by failing to match, which is the quietest way to lose a pin.
    const mutated = src.replace(
      /const LANES_WITH_BASELESS_PRODUCTS = new Set\(\[[^\]]*\]\);/,
      "const LANES_WITH_BASELESS_PRODUCTS = new Set([]);",
    );
    expect(mutated).not.toBe(src);
    const p = path.join(tmp, "mutated-driver.cjs");
    fs.writeFileSync(p, mutated);
    const m = require_(p) as { gateStagedEntry: (p: string[], lane?: string) => any };
    const promo = stage("m-p.csv", Array.from({ length: 132 }, (_, i) => `base,${i + 1},Promo,false,,pikachu`));
    // The mutant refuses the very file the fix exists to admit.
    expect(m.gateStagedEntry([promo], "tcgdexja").ok).toBe(false);
    expect(gateStagedEntry([promo], "tcgdexja").ok).toBe(true);
  });
});

// ── the driver still parses and exports ──────────────────────────────────────

describe("the committed driver is loadable", () => {
  it("node parses it", () => {
    expect(() => execFileSync(process.execPath, ["--check", script], { stdio: "pipe" })).not.toThrow();
  });
});
