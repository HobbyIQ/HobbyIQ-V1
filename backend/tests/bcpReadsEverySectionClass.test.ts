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
