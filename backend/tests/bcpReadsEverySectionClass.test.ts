/**
 * CF-A-SECTION-CLASS-IS-A-CARD-TYPE — the bcp lane reads every card-type
 * section its pages carry, not only Base_Set / Parallels / Inserts.
 *
 * The finding: 2011 Topps Chrome Freddie Freeman #173 is an AUTOGRAPH with its
 * own nine-rung ladder, printed on the page, and the catalog had no row for it.
 * Every sale of that card orphaned onto a :auto pool with no ladder to price
 * against. The cause was structural, not a parse miss — `main` sliced three
 * sections and wrote the literal string "false" into the isAuto column of every
 * row it emitted, so the lane could not mint a signed card even in principle.
 *
 * These pins drive the COMMITTED emission path over saved fixtures (the same
 * subprocess harness bcpPrintRunIsScoped uses), so they assert the CSV the
 * scraper actually writes. Re-implementing the filters here would pin nothing.
 *
 * The three fixtures are the real pages, fetched 2026-09-04, chosen for the
 * shapes they carry between them:
 *
 *   2011 Topps Chrome   §Autographs > §Autographed Rookies — BASE-NUMBERED
 *                       autographs (the Freeman card), plus a plate rung
 *   2021 Topps Chrome   §Relics, §Autographs and §Autographed Relics side by
 *                       side — the discrimination case: "Captain's Cloth
 *                       Relics" must NOT be signed, "Captain's Cloth Relic
 *                       Autographs" must be
 *   2005 Topps Chrome   §"Autographs & Game-Used" — ONE heading over two card
 *                       types, plus an <h4> holding its own separate card list
 *   2022 Topps Chrome   NO PAPER SCOPE that emits — its two scopes are
 *                       "Standard Chrome" and "Sonic", both sharing the stem,
 *                       so nobody took the bare filename and the page's whole
 *                       autograph and insert yield was written to no file
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const L = require_(path.resolve(__dirname, "../scripts/scrape-bcp-ladders.cjs"));

const fixture = (n: string) =>
  fs.readFileSync(path.resolve(__dirname, `fixtures/bcp/${n}.trimmed.html`), "utf8");

type Row = {
  category: string;
  num: string;
  parallel: string;
  isAuto: string;
  run: string;
  player: string;
  note: string;
  rarity: string;
};

const OUT = path.resolve(
  fs.mkdtempSync(path.join(require_("node:os").tmpdir(), "bcp-sections-pin-")),
);

{
  const { execFileSync } = require_("node:child_process") as typeof import("node:child_process");
  execFileSync(process.execPath, [
    path.resolve(__dirname, "helpers/runBcpLaddersOverFixtures.cjs"), OUT,
    "2011_Topps_Chrome=2011-topps-chrome",
    "2021_Topps_Chrome=2021-topps-chrome",
    "2005_Topps_Chrome=2005-topps-chrome",
    "2022_Topps_Chrome=2022-topps-chrome",
  ], { stdio: "pipe" });
}

function splitCsv(line: string): string[] {
  const f: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { f.push(cur); cur = ""; }
    else cur += ch;
  }
  f.push(cur);
  return f;
}

/** NEVER hardcode the emitted filename — the stem comes from the vocabulary. */
function csvForScope(year: number, scope: string | null): string {
  const manifests = fs.readdirSync(OUT).filter((f) => f.endsWith(".manifest.json"));
  const hit = manifests.find((m) => {
    const j = JSON.parse(fs.readFileSync(path.join(OUT, m), "utf8")) as { scope?: string | null; year?: number };
    if (Number(j.year) !== year) return false;
    const s = j.scope ?? null;
    return scope === null ? s === null : String(s ?? "").toLowerCase() === scope.toLowerCase();
  });
  if (!hit) {
    throw new Error(`no manifest for ${year} scope ${JSON.stringify(scope)} — emitted: ${manifests.join(", ") || "(nothing)"}`);
  }
  return hit.replace(/\.manifest\.json$/, ".csv");
}

function rowsOf(year: number, scope: string | null = null): Row[] {
  const text = fs.readFileSync(path.join(OUT, csvForScope(year, scope)), "utf8").trim().split("\n").slice(1);
  return text.map((line) => {
    const f = splitCsv(line);
    return {
      category: f[0] ?? "", num: f[1] ?? "", parallel: f[2] ?? "", isAuto: f[3] ?? "",
      run: f[4] ?? "", player: f[5] ?? "", note: f[6] ?? "", rarity: f[7] ?? "",
    };
  });
}

const r2011 = rowsOf(2011);
const r2021 = rowsOf(2021);
const r2005 = rowsOf(2005);
// 2022 Topps Chrome has no emitting PAPER scope, so the bare-stem file is
// held by "Standard Chrome" — which is the whole point of the pin below.
const r2022 = rowsOf(2022, "Standard Chrome");

describe("the section the finding was about — 2011 Topps Chrome #173", () => {
  const freeman = r2011.filter((r) => r.category.startsWith("auto-") && r.num === "173");

  it("mints the Freddie Freeman autograph the page prints, and marks it signed", () => {
    expect(freeman.length).toBeGreaterThan(0);
    expect(freeman.every((r) => r.isAuto === "true")).toBe(true);
    expect(freeman.every((r) => r.player === "Freddie Freeman")).toBe(true);
  });

  it("carries the page's own nine-rung ladder, print runs and all", () => {
    const byName = new Map(freeman.map((r) => [r.parallel, r.run]));
    // <ul> on the page: Refractor /499 ... Super-Fractor 1/1, Printing Plates.
    expect(byName.get("Refractor")).toBe("499");
    expect(byName.get("Blue Refractor")).toBe("199");
    expect(byName.get("Sepia Refractor")).toBe("99");
    expect(byName.get("Gold Refractor")).toBe("50");
    expect(byName.get("Red Refractor")).toBe("25");
    expect(byName.get("Super-Fractor")).toBe("1");
    // The plain signed card itself: blank parallel, never the string "Base".
    expect(byName.get("")).toBe("");
  });

  it("CF-A-PRINTING-PLATE-IS-A-ONE-OF-ONE — 'four-for-each' is four cards at /1", () => {
    const plate = freeman.find((r) => /printing plates/i.test(r.parallel));
    expect(plate?.run).toBe("1");
    // The page's own words are kept, so the figure stays auditable.
    expect(plate?.note).toMatch(/four-for-each/i);
  });

  it("strips the redemption marker from the player, so the row is matchable", () => {
    // The page writes "173 Freddie Freeman EXCH". EXCH is a fact about the
    // COPY; left in, no parsed sale title could ever match this row.
    expect(r2011.some((r) => /EXCH/i.test(r.player))).toBe(false);
  });
});

describe("CF-THE-SECTION-SAYS-SIGNED-OR-IT-IS-NOT", () => {
  it("2021 Topps Chrome: the relic subset is NOT signed, its autograph sibling is", () => {
    // Two h3s, one word apart, under two different h2s. Getting this wrong in
    // either direction splits or merges a comp pool.
    const relics = r2021.filter((r) => r.category === "insert-captain-s-cloth-relics");
    const autos = r2021.filter((r) => r.category === "auto-captain-s-cloth-relic-autographs");
    expect(relics.length).toBeGreaterThan(0);
    expect(autos.length).toBeGreaterThan(0);
    expect(relics.every((r) => r.isAuto === "false")).toBe(true);
    expect(autos.every((r) => r.isAuto === "true")).toBe(true);
  });

  it("2005 Topps Chrome: one heading over two card types is split by SUBSECTION", () => {
    // §"Autographs & Game-Used" holds "The Game Relics" (unsigned) and
    // "Dem Bums Autographs" (signed). Reading the h2 alone would attest every
    // relic card as autographed.
    const demBums = r2005.filter((r) => r.category === "auto-dem-bums-autographs");
    const gameRelics = r2005.filter((r) => r.category.startsWith("insert-the-game-relics"));
    expect(demBums.length).toBe(5);
    expect(demBums.every((r) => r.isAuto === "true")).toBe(true);
    expect(gameRelics.length).toBeGreaterThan(0);
    expect(gameRelics.every((r) => r.isAuto === "false")).toBe(true);
  });

  it("every signed row traces to a section the manifest recorded as signed", () => {
    for (const year of [2011, 2021, 2005]) {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(OUT, csvForScope(year, null).replace(/\.csv$/, ".manifest.json")), "utf8"),
      ) as { sections?: { category: string; isAuto: boolean }[] };
      const signedCats = new Set((manifest.sections ?? []).filter((s) => s.isAuto).map((s) => s.category));
      // Only `auto` is ever a signed category — never `insert`, never `base`.
      expect([...signedCats].every((c) => c === "auto")).toBe(true);
      for (const r of rowsOf(year)) {
        if (r.isAuto === "true") expect(r.category.startsWith("auto-")).toBe(true);
      }
    }
  });
});

describe("a page without the section yields none of its rows", () => {
  it("2011 Topps Chrome has no Relics heading, so no relic subset is emitted", () => {
    // The page's h2s are exactly Base_Set | Parallels | Inserts | Autographs.
    expect(fixture("2011-topps-chrome")).not.toMatch(/<h2 id="Relics"/);
    // MUTATION: make parseTypedSection emit for an absent section and this goes
    // red. Rows come from the page or they do not exist.
    expect(L.parseTypedSection(fixture("2011-topps-chrome"), { id: "Relics", prefix: "insert", signed: false })).toEqual([]);
    expect(L.parseTypedSection(fixture("2011-topps-chrome"), { id: "Autographed_Relics", prefix: "auto", signed: true })).toEqual([]);
  });

  it("2005 Topps Chrome has no bare Autographs heading, and mints none from it", () => {
    expect(fixture("2005-topps-chrome")).not.toMatch(/<h2 id="Autographs">/);
    expect(L.parseTypedSection(fixture("2005-topps-chrome"), { id: "Autographs", prefix: "auto", signed: true })).toEqual([]);
  });
});

describe("the sections do not cross-join", () => {
  it("no (category, cardNumber, parallel) is emitted twice on any fixture", () => {
    // The cross-join signature this file has fixed three times: a card line
    // read as a rung, or a nested heading read twice. 2011's §Autographs
    // CONTAINS §Autographed Rookies, and an <h4> under 2005's §The Game Relics
    // holds a SECOND card list — both would duplicate without the guards.
    //
    // Scoped to the categories this change is responsible for. `base` is
    // EXCLUDED deliberately, and not because it is clean: 2021 Topps Chrome
    // emits 624 duplicate base rows today, because two scopes of that page
    // share a stem and both write the paper card list. That is a real defect
    // and it is NOT this one — the golden pin next door proves every base row
    // here is byte-identical to the pre-change output, so asserting it in this
    // file would fail on someone else's bug and hide the regression this test
    // exists to catch. Filed as its own finding rather than fixed in passing.
    for (const rows of [r2011, r2021, r2005]) {
      const seen = new Set<string>();
      const dupes: string[] = [];
      for (const r of rows) {
        if (r.category === "base") continue;
        const k = `${r.category},${r.num},${r.parallel}`;
        if (seen.has(k)) dupes.push(k);
        seen.add(k);
      }
      expect(dupes.slice(0, 5)).toEqual([]);
    }
  });

  it("2005's <h4> card list is its own subset, not appended to its parent", () => {
    // §The Game Relics prints 11 cards; its <h4>Patch</h4> prints 24 different
    // ones limited to 70 copies. Flattened, AR/JB/SS/TH/MPI appear twice and
    // the Patch cards inherit the parent's odds.
    const parent = new Set(r2005.filter((r) => r.category === "insert-the-game-relics").map((r) => r.num));
    const patch = new Set(r2005.filter((r) => r.category === "insert-the-game-relics-patch").map((r) => r.num));
    expect(parent.size).toBe(11);
    expect(patch.size).toBe(24);
    // They genuinely overlap by card number — which is exactly why they must
    // not share a category.
    expect([...parent].some((n) => patch.has(n))).toBe(true);
  });

  it("an odds legend is a rarity statement, never a parallel", () => {
    // The page prints "A: 1:15/boxes" as a <li> above the card list. As a rung
    // it lands on every card in the subset as a parallel named "A".
    expect(r2005.some((r) => /^[A-Z]\s*:/.test(r.parallel))).toBe(false);
    expect(r2005.some((r) => /boxes|packs/i.test(r.parallel))).toBe(false);
  });

  it("an initials card line is a card, not a rung", () => {
    // "CE Carl Erskine" is card CE. parseLadder's card-line defences are all
    // number-based, so widening parseTypedCards to READ these lines is what
    // makes them available to be misread as rungs.
    const demBums = r2005.filter((r) => r.category === "auto-dem-bums-autographs");
    expect(demBums.map((r) => r.num).sort()).toEqual(["CE", "CL", "DS", "DZ", "JP"]);
    expect(demBums.every((r) => r.parallel === "")).toBe(true);
  });
});

describe("CF-THE-CATEGORY-PREFIX-IS-A-HYPHEN", () => {
  it("no row carries the colon form the ingester silently drops", () => {
    // ingest-scraped-checklist.cjs accepts "base", "insert-*" and "auto-*" and
    // does `else { skipped++; continue; }` for everything else. This lane wrote
    // "insert:<slug>", so every insert row it ever staged was dropped at the
    // door — read from the page, written to the CSV, never reaching the catalog.
    for (const rows of [r2011, r2021, r2005]) {
      expect(rows.some((r) => r.category.includes(":"))).toBe(false);
      expect(rows.every((r) => r.category === "base" || /^(insert|auto)-.+/.test(r.category))).toBe(true);
    }
  });

  it("the manifest declares the parallel column authoritative", () => {
    // Without the flag the ingester derives the parallel from the CATEGORY
    // SLUG, which bakes the subset name into the rung: every Freeman auto rung
    // would become "Autographed Rookies" and the /499 Refractor and the /50
    // Gold would collapse onto one slug.
    const m = JSON.parse(
      fs.readFileSync(path.join(OUT, csvForScope(2011, null).replace(/\.csv$/, ".manifest.json")), "utf8"),
    ) as { parallelColumnAuthoritative?: boolean };
    expect(m.parallelColumnAuthoritative).toBe(true);
  });
});

/**
 * CF-THE-BARE-STEM-ALWAYS-LANDS (2026-09-04, found closing this PR).
 *
 * The filename suffix rule was gated on `!sc.isPaper`, which assumed every page
 * has a paper scope to take the bare stem. 2022 Topps Chrome does not: its
 * paper scope carries ZERO rungs, so the loop's own guard skips it before it
 * ever writes, and its two emitting scopes ("Standard Chrome" and "Sonic")
 * both share the stem `topps-chrome` and both took a suffix. The bare
 * `2022-topps-chrome-baseball.csv` was never written at all.
 *
 * That is not cosmetic. Inserts and typed sections are emitted by the scope
 * that owns the page's own product, so with nobody holding the bare stem they
 * had nowhere to go: 260 base cards, 273 typed-section cards (238 SIGNED) and
 * 145 insert cards read from the page, counted in the run summary, written to
 * no file. The lane reported "12,480 rows across 2 product(s)" while the whole
 * autograph yield of the page evaporated.
 */
describe("CF-THE-BARE-STEM-ALWAYS-LANDS", () => {
  it("writes the bare-stem file even when no paper scope emits", () => {
    // MUTATION: elect the holder among ALL scopes rather than the EMITTING
    // ones (the pre-fix behaviour) and this throws — no manifest, no file.
    expect(r2022.length).toBeGreaterThan(0);
    const emitted = fs.readdirSync(OUT).filter((f) => f.endsWith(".csv"));
    expect(emitted).toContain("2022-topps-chrome-baseball.csv");
    // The qualified scope still gets its own file: the collision rule that
    // stopped Sonic overwriting Standard Chrome is untouched.
    expect(emitted).toContain("2022-topps-chrome-baseball--sonic.csv");
  });

  it("the page's autographs and inserts land, instead of being written nowhere", () => {
    const signed = r2022.filter((r) => r.isAuto === "true");
    const inserts = r2022.filter((r) => r.category.startsWith("insert-"));
    // Three whole autograph subsets the page states (Rookie, Veteran, and the
    // named ones) plus their ladders. Before the fix this was exactly zero.
    expect(signed.length).toBeGreaterThan(2_000);
    expect(inserts.length).toBeGreaterThan(400);
    // The signed cards the page actually lists, not a cross-join artefact.
    const signedCards = new Set(signed.map((r) => `${r.num} ${r.player}`));
    expect(signedCards.size).toBe(238);
    // And the base rows still land in the same file.
    expect(r2022.some((r) => r.category === "base")).toBe(true);
  });

  it("exactly one scope of a page holds the bare stem", () => {
    // The guarantee the fix adds. Two scopes taking it would mean one silently
    // overwriting the other — the CF-ONE-FILE-PER-SCOPE failure, inverted.
    const stems = fs.readdirSync(OUT)
      .filter((f) => f.endsWith(".csv") && !f.includes("--"))
      .map((f) => f.replace(/\.csv$/, ""));
    expect(new Set(stems).size).toBe(stems.length);
  });
});

/**
 * CF-AN-INSERT-SECTION-IS-NOT-A-SIGNATURE — the mutation this suite could not
 * see (found by the #1703 verifier).
 *
 * Flipping the §Inserts branch to signed relabels 50 "Vintage Chrome" insert
 * rows as auto-* with isAuto=true, and every assertion in this file stayed
 * green: the isAuto pins all name autograph sections, so nothing was watching
 * the unsigned lane from the other side. A false isAuto splits a pool on a
 * fact that is not true and no only-improve sweep can ever see it.
 */
describe("an insert section never yields a signed row", () => {
  it("no insert-category row is ever isAuto=true", () => {
    // MUTATION: `parseInserts(html).map((i) => ({ ...i, signed: true, ... }))`
    // in main() goes red here, on every fixture.
    for (const rows of [r2011, r2021, r2005, r2022]) {
      const insertRows = rows.filter((r) => r.category.startsWith("insert-"));
      expect(insertRows.length).toBeGreaterThan(0);
      expect(insertRows.every((r) => r.isAuto === "false")).toBe(true);
    }
  });

  it("a signed row is always in an auto- category, and vice versa", () => {
    // The two columns are one decision. They cannot disagree.
    for (const rows of [r2011, r2021, r2005, r2022]) {
      for (const r of rows) {
        expect(r.isAuto === "true").toBe(r.category.startsWith("auto-"));
      }
    }
  });

  it("the §Inserts subsets keep their own names and stay unsigned", () => {
    // Named directly, so the pin above cannot pass vacuously on a run that
    // emitted no inserts at all. These are 2021 Topps Chrome's own §Inserts
    // subsets, and the retro one ("1986 Topps") is a throwback DESIGN, not a
    // signature — exactly the kind of set the flipped branch relabelled auto-.
    for (const name of ["1986-topps", "future-stars", "prismic-power", "beisbol"]) {
      const sub = r2021.filter((r) => r.category === `insert-${name}`);
      expect(sub.length, `2021 §Inserts subset ${name}`).toBeGreaterThan(0);
      expect(sub.every((r) => r.isAuto === "false")).toBe(true);
    }
    // "Captain's Cloth Relics" is the discrimination case: it sits beside
    // "Captain's Cloth Relic Autographs" and only the latter is signed.
    const relics = r2021.filter((r) => r.category === "insert-captain-s-cloth-relics");
    expect(relics.length).toBeGreaterThan(0);
    expect(relics.every((r) => r.isAuto === "false")).toBe(true);
  });
});

/**
 * CF-A-SPELLED-RUN-IS-STILL-A-RUN, over the section lane (2026-09-04).
 *
 * #1700 fixed `splitAnnotation`'s digit-only alternations on main while this
 * branch was open. The alternations require \d, so "Atomic Refractor
 * (serial-numbered to ten copies)" yielded run=null: the rung is real, the
 * number is stated on the page in words, and the lane dropped it.
 *
 * Both PRs edit the same reader, so the fix reaches THIS lane's emission path
 * too — but "the shared function was fixed" is not the same claim as "every
 * row this lane emits now carries the run", and the second is what matters:
 * 355 of these rows are AUTO rows that only exist because of this PR, and they
 * did not exist when #1700's own pins were written. A blank print run on a
 * signed rung is the well-formed-wrong row `only-improve` can never see.
 *
 * So the count is pinned from the emitted CSV, not from the parser.
 */
describe("a print run stated in words is emitted as a number", () => {
  const spelled = /numbered to (?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|twenty-five)\b/i;
  const rowsStatingASpelledRun = [...r2011, ...r2021, ...r2005]
    .filter((r) => spelled.test(r.note));

  it("leaves no row that states a spelled run with a blank one", () => {
    // MUTATION: drop `if (n == null) n = spelledRun(note);` from parseLadder
    // and all 882 of these go blank.
    expect(rowsStatingASpelledRun).toHaveLength(882);
    expect(rowsStatingASpelledRun.every((r) => r.run !== "")).toBe(true);
  });

  it("emits the number the page actually states, never a guess", () => {
    const byRun: Record<string, number> = {};
    for (const r of rowsStatingASpelledRun) byRun[r.run] = (byRun[r.run] ?? 0) + 1;
    expect(byRun).toEqual({ "5": 853, "10": 29 });
    // Each row's run agrees with its OWN note — a blanket fill would pass the
    // count above while writing /5 onto every "to ten" rung.
    for (const r of rowsStatingASpelledRun) {
      if (/numbered to ten\b/i.test(r.note)) expect(r.run).toBe("10");
      if (/numbered to five\b/i.test(r.note)) expect(r.run).toBe("5");
    }
  });

  it("covers the signed rows this PR is what creates", () => {
    // The reason this pin lives here and not only in #1700's suite. Freeman's
    // Atomic Refractor auto is "serial-numbered to ten" — a rung that did not
    // exist on main before this PR read the Autographs section.
    const auto = rowsStatingASpelledRun.filter((r) => r.isAuto === "true");
    expect(auto).toHaveLength(355);
    const freemanAtomic = r2011.find(
      (r) => r.isAuto === "true" && r.num === "173" && r.parallel === "Atomic Refractor");
    expect(freemanAtomic?.run).toBe("10");
  });
});
