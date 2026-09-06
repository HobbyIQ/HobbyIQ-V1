/**
 * CF-AN-UNNUMBERED-ROSTER-IS-NOT-A-BROKEN-CONVERTER (2026-09-06).
 *
 * MEASURED, run 33997480307 (clc lane, sports=hockey,soccer, years 2019-2022,
 * pending only, APPLY). The lane took 85 entries, reached 18, and aborted:
 *
 *   [16/85] topps real sociedad team set soccer   FAILED — clc converter produced no CSV
 *   [17/85] topps barcelona team set soccer       FAILED — clc converter produced no CSV
 *   [18/85] topps merlin heritage 97 uefa soccer  FAILED — clc converter produced no CSV
 *   ABORTING THE LANE — 3 consecutive entries failed or were unreachable
 *
 * 67 entries were never attempted and 252 stayed open. All three of those URLs
 * answer HTTP 200 with a complete page (re-fetched 2026-09-06: 69,909 / 67,886
 * / 78,690 bytes), and the same source's football/basketball walk was creating
 * 156k rows a pass in the same hour. The host was never down.
 *
 * What those pages are: checklistcenter serves team sets and the Merlin /
 * Inception / Deco UEFA titles as a `<ul><li>` roster of BARE PLAYER NAMES --
 * "Marc-Andre ter Stegen", "Ansu Fati / Pedri" -- instead of the `<p>...<br>`
 * numbered card lines ("1 Erling Haaland") every other page uses. parseHtml
 * finds the sections and the csColumns, finds no card LINE in either markup,
 * and every subset drops out.
 *
 * The catalog keys a card by cardNumber and ingest-checklist-csv-to-catalog
 * drops any row without one (`if (!cardNumber || !player) { skippedRow++ }`),
 * so reading these would mean INVENTING numbers the source never published --
 * which `no synthetic parallels — actuals only` forbids. There is nothing to
 * parse here even in principle. It is the SOURCE answering "I have no keyable
 * card for this product", which is EMPTY: a terminal verdict about the entry,
 * excluded from the systemic streak. That is the identical ruling the bcp lane
 * already carries as CF-A-CHECKLIST-WITHOUT-CARD-NUMBERS-IS-NOT-A-PARSER-GAP.
 *
 * These pins fail without the fix in three independent places:
 *   1. the converter must NAME the shape (it returned a bare null);
 *   2. it must not name it for a page that DOES carry card lines, or a real
 *      converter gap would be laundered into "the source has nothing";
 *   3. the driver must map that word to `empty`, and `empty` must be
 *      streak-neutral -- which is the half that actually saves the lane.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const conv = require("../scripts/convertChecklistCenterToChecklistCsv.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const driver = require("../scripts/ingest-universe-driver.cjs");

const FIX = path.join(__dirname, "fixtures", "clc");
const html = (n: string) => fs.readFileSync(path.join(FIX, n), "utf8");

/** The real 2021-22 Topps Barcelona Team Set page, trimmed to its two card
 *  sections with each roster cut to 14 names. Every line is text from the
 *  page as served on 2026-09-06. */
const ROSTER = "2021-topps-barcelona-team-set-soccer.trimmed.html";
/** The control: a page of the SAME lane, same era, that carries real numbered
 *  card lines. It must keep converting exactly as before. */
const NUMBERED = "2020-topps-series-1.trimmed.html";

describe("an unnumbered roster is the source having no keyable card, not a broken converter", () => {
  it("names the shape instead of returning a bare null", () => {
    const out = conv.convertHtml(html(ROSTER), { sourceSlug: "2021-22-topps-barcelona-team-set-soccer-card-checklist", year: 2021, sport: "soccer" });
    // Without the fix this is `null` and the caller can only say "no CSV".
    expect(out).not.toBeNull();
    expect(out.unnumberedRoster).toBe(true);
    // It is a VERDICT, not a conversion: nothing is emitted.
    expect(out.rows).toBeUndefined();
  });

  it("the page really does state no card number anywhere — that is why nothing is emitted", () => {
    const { subsets } = conv.parseHtml(html(ROSTER), {});
    expect(subsets.length).toBe(0);
    const names = [...html(ROSTER).matchAll(/<li[^>]*>([\s\S]*?)(?=<li|<\/ul>)/gi)]
      .map((m) => String(m[1]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect(names.length).toBeGreaterThanOrEqual(5);
    expect(names.some((n) => /^#?\d/.test(n))).toBe(false);
    expect(names).toContain("Gerard Piqué");
  });

  it("does NOT call a page with real card lines an unnumbered roster", () => {
    // MUTATION CHECK. Relax unnumberedRoster to `subsets.length === 0` alone,
    // or drop the "no numbered name" clause, and a genuine converter gap on a
    // numbered page becomes "the source has nothing" -- the exact way a defect
    // goes quiet. This page converts, so it must never reach the classifier.
    const out = conv.convertHtml(html(NUMBERED), { sourceSlug: "2020-topps-series-1", year: 2020, sport: "baseball" });
    expect(out.unnumberedRoster).toBeUndefined();
    expect(out.rows.length).toBeGreaterThan(0);
    expect(conv.unnumberedRoster(html(NUMBERED), conv.parseHtml(html(NUMBERED), {}).subsets)).toBe(false);
  });

  it("numbered <li> that we failed to read stays OUR defect, never 'the source has nothing'", () => {
    // MUTATION CHECK, and the one that matters most. The page yields no subset
    // -- so the first guard passes -- but its <li> ARE numbered. That is our
    // parser missing real card lines, and it must keep the anonymous refusal
    // that brings someone back to it. Drop the "no numbered name" clause and
    // this page is laundered into `empty`, which is how a converter gap goes
    // permanently quiet: `empty` is terminal, so pending-only passes skip it
    // forever and the rows are never acquired.
    const numbered = "<div class=\"csColumn\"><ul>" +
      ["1 Lionel Messi", "2 Neymar Jr", "3 Kylian Mbappe", "4 Erling Haaland", "5 Pedri", "6 Gavi"]
        .map((n) => `<li>${n}</li>`).join("") + "</ul></div>";
    expect(conv.parseHtml(numbered, {}).subsets.length).toBe(0);
    expect(conv.unnumberedRoster(numbered, [])).toBe(false);
    expect(conv.convertHtml(numbered, { sourceSlug: "x", year: 2021, sport: "soccer" })).toBeNull();
  });

  it("a handful of chrome <li> is not a roster", () => {
    // Site nav is <li> too. Four bare names are not a checklist, and calling
    // them one would hand `empty` to a page that failed for another reason.
    const chrome = "<div class=\"csColumn\"><ul><li>Home</li><li>About</li><li>Contact</li></ul></div>";
    expect(conv.unnumberedRoster(chrome, [])).toBe(false);
  });
});

describe("the driver gives that shape a streak-neutral verdict", () => {
  it("empty does not advance the systemic streak, and failed does", () => {
    // THE HALF THAT SAVES THE LANE. Three `failed` in a row abort; three
    // `empty` do not. streakAfter is the tripwire's whole arithmetic.
    expect(driver.streakAfter(2, { status: "failed" })).toBe(3);
    expect(driver.streakAfter(2, { status: driver.EMPTY_STATUS })).toBe(2);
    expect(driver.STREAK_STATUSES.has(driver.EMPTY_STATUS)).toBe(false);
  });

  it("the three consecutive rosters of run 33997480307 no longer reach the tripwire", () => {
    // Real Sociedad, Barcelona, Merlin Heritage 97 -- back to back, the exact
    // sequence that aborted the lane. As `empty` the streak never advances.
    let streak = 0;
    for (const _ of ["real sociedad", "barcelona", "merlin heritage 97"]) {
      streak = driver.streakAfter(streak, { status: driver.EMPTY_STATUS });
    }
    expect(streak).toBeLessThan(driver.SYSTEMIC_FAILURE_STREAK);

    // And the control: the same three as `failed` DO abort, which is why the
    // verdict change is the fix rather than loosening the tripwire.
    let asFailed = 0;
    for (const _ of ["real sociedad", "barcelona", "merlin heritage 97"]) {
      asFailed = driver.streakAfter(asFailed, { status: "failed" });
    }
    expect(asFailed).toBeGreaterThanOrEqual(driver.SYSTEMIC_FAILURE_STREAK);
  });

  it("empty stays terminal, so a later pending-only pass does not re-fetch these pages", () => {
    expect(driver.TERMINAL_STATUSES.has(driver.EMPTY_STATUS)).toBe(true);
  });

  it("the clc lane actually WIRES the converter's word to emptyAtSource", () => {
    // MUTATION CHECK for the driver half. streakAfter being right saves
    // nothing if the clc lane never reaches for `empty`, and `acquire` is not
    // exported (it shells out to two children and needs a live fetch), so the
    // wiring is pinned at the source. Delete the classification and the lane
    // silently returns to calling a 200-serving page a broken pipe -- the
    // exact regression that cost run 33997480307 its 252 remaining entries.
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "ingest-universe-driver.cjs"), "utf8");
    const lane = src.slice(src.indexOf('case "clc": {'), src.indexOf('case "tcgdexja": {'));
    expect(lane).toContain("UNNUMBERED ROSTER");
    expect(lane).toContain("emptyAtSource = true");
    // The converter's stdout must be CAPTURED, not discarded -- the word only
    // arrives on stdout, and `run(...)` without an assignment reads nothing.
    expect(lane).toMatch(/=\s*run\("convertChecklistCenterToChecklistCsv\.cjs"/);
    // And the other cause keeps its own, different wording and stays `failed`.
    expect(lane).toContain("clc converter produced no CSV");
  });
});
