/**
 * CF-A-SHARED-CARD-NUMBER-IS-STILL-AN-AUTOGRAPH (2026-09-04) -- Drew's 2011
 * Topps Chrome Freddie Freeman rookie autograph.
 *
 * The scraper anchored on Base_Set + Parallels and never read the Autographs
 * section, so a product whose autographs share the BASE card numbers produced
 * 5,026 catalog rows with isAuto=false on every one of them and NO ROW for
 * the signed #173 that actually sells. Sales for it are tagged auto by the
 * title parser, so they landed on `:auto` slugs with nothing behind them.
 *
 * The trap these pins exist to hold shut is the one that makes this hard:
 * THE AUTO LADDER IS NOT THE BASE LADDER. On this page the base Blue
 * Refractor is /99 and the AUTOGRAPHED Blue Refractor is /199. Emitting auto
 * rows against the base ladder's runs would write a confidently wrong print
 * run onto a card that shares its number with the base -- the two would be
 * indistinguishable except by a figure that is wrong, which per `only-improve
 * hides well-formed wrong rows` no later sweep would ever find.
 *
 * These drive the COMMITTED emission path (main() over a stubbed fetch) and
 * assert the CSV it writes, not a reimplementation of its filters.
 *
 * Fixture: the real http://www.baseballcardpedia.com/index.php/2011_Topps_Chrome
 * fetched 2026-09-04, trimmed to the parser-output div.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const L = require_(path.resolve(__dirname, "../scripts/scrape-bcp-ladders.cjs"));

type Row = {
  category: string; num: string; parallel: string;
  isAuto: boolean; run: number | null; player: string;
};

const OUT = path.resolve(
  fs.mkdtempSync(path.join(require_("node:os").tmpdir(), "bcp-autos-pin-")),
);

/** Parse the emitted CSV, honouring quoted fields. */
function parseCsv(file: string): Row[] {
  const text = fs.readFileSync(file, "utf8").trim();
  const [, ...lines] = text.split("\n");
  return lines.filter(Boolean).map((line) => {
    const cells: string[] = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    return {
      category: cells[0] ?? "", num: cells[1] ?? "", parallel: cells[2] ?? "",
      isAuto: cells[3] === "true",
      run: cells[4] ? Number(cells[4]) : null,
      player: cells[5] ?? "",
    };
  });
}

let rows: Row[];
beforeAll(() => {
  const { execFileSync } = require_("node:child_process") as typeof import("node:child_process");
  execFileSync(process.execPath, [
    path.resolve(__dirname, "helpers/runBcpLaddersOverFixtures.cjs"), OUT,
    "2011_Topps_Chrome=2011-topps-chrome",
  ], { stdio: "pipe" });
  rows = parseCsv(path.join(OUT, "2011-topps-chrome-baseball.csv"));
}, 180_000);

describe("the Autographs section is read", () => {
  it("emits the 29 autographed rookies the page lists", () => {
    const autoPlayers = new Set(
      rows.filter((r) => r.isAuto).map((r) => `${r.num} ${r.player}`),
    );
    expect(autoPlayers.size).toBe(29);
    // The page's own first, last, and the card that started this.
    expect([...autoPlayers]).toContain("173 Freddie Freeman");
    expect([...autoPlayers]).toContain("33 Danny Espinosa");
    expect([...autoPlayers]).toContain("220 Aaron Crow");
  });

  it("gives every auto the page's nine-rung ladder, with the AUTO print runs", () => {
    const freeman = rows.filter((r) => r.isAuto && r.num === "173");
    // 9 ladder rungs + the unparalleled signed card itself.
    expect(freeman).toHaveLength(10);
    const byName = new Map(freeman.map((r) => [r.parallel, r.run]));
    expect(Object.fromEntries(byName)).toEqual({
      "": null,                            // the signed card, no parallel
      "Refractor": 499,
      "Blue Refractor": 199,
      "Black-Bordered Refractor": 100,
      "Sepia Refractor": 99,
      "Gold Refractor": 50,
      "Red Refractor": 25,
      "Atomic Refractor": 10,              // "serial-numbered to ten"
      "Super-Fractor": 1,
      // CF-A-PRINTING-PLATE-IS-A-ONE-OF-ONE (#1703, merged 2026-09-04). This
      // read `null` when #1700 landed, because RUN_NOTE sees no serial in
      // "four-for-each". #1703 rules that four plates of one card are four
      // DIFFERENT cards at /1 -- the "four" counts colours, not copies -- so
      // the page's strongest scarcity claim is stated, not left as unknown.
      "Printing Plates": 1,
    });
  });

  /**
   * The heart of it. Same card NUMBER, two different cards, two different
   * ladders -- and the print runs are what tell them apart.
   */
  it("never lets the auto ladder inherit the base ladder's print runs", () => {
    const runOf = (auto: boolean, parallel: string) =>
      rows.find((r) => r.num === "173" && r.isAuto === auto && r.parallel === parallel)?.run ?? null;
    // The page states both, and they disagree. This is the whole defect.
    expect(runOf(false, "Blue Refractors")).toBe(99);
    expect(runOf(true, "Blue Refractor")).toBe(199);
    // A rung that exists ONLY on the auto ladder must not appear on the base
    // rows, and vice versa.
    expect(runOf(true, "Black-Bordered Refractor")).toBe(100);
    expect(runOf(true, "Canary Diamond Refractor")).toBeNull();
  });

  it("leaves every base row unsigned", () => {
    const base = rows.filter((r) => r.category === "base");
    expect(base.length).toBeGreaterThan(2_000);
    expect(base.every((r) => r.isAuto === false)).toBe(true);
    // #173 is a base rookie AND an autographed rookie; both rows exist.
    expect(base.some((r) => r.num === "173" && r.parallel === "Base")).toBe(true);
  });

  /**
   * `no synthetic parallels -- actuals only`. Two of this page's three
   * autograph subsections state no checklist of their own: the USA Baseball
   * autos say theirs "is identical to that of the unautographed insert (see
   * above)", and the 60th Anniversary autos are a link to another page. A
   * cross-reference is not a checklist, so they emit NOTHING rather than
   * cross-joining a ladder over cards we never read.
   */
  it("emits nothing for an autograph section that only cross-references", () => {
    const subsets = L.parseTypedSections(
      fs.readFileSync(path.resolve(__dirname, "fixtures/bcp/2011-topps-chrome.trimmed.html"), "utf8"),
    );
    expect(subsets.map((s: { name: string }) => s.name)).toEqual(["Autographed Rookies"]);
    // The USA autos DO have a ladder on the page (7 rungs) -- it is the CARDS
    // we lack, and a ladder with no cards is exactly the cross-join to refuse.
    expect(rows.some((r) => r.parallel === "Diamond Die-Cut Atomic Refractor")).toBe(false);
  });
});

describe("a page with no autograph section", () => {
  /**
   * The mutation guard. If `parseAutographs` ever emits on a page that has no
   * autograph section, this goes red -- the "emit autos anyway" mutation.
   */
  it("yields zero autographs, and zero auto rows", () => {
    for (const name of ["1993-finest", "1999-black-diamond", "2020-bowman"]) {
      const html = fs.readFileSync(
        path.resolve(__dirname, `fixtures/bcp/${name}.trimmed.html`), "utf8");
      expect(
        L.parseTypedSections(html).filter((sub: { signed: boolean }) => sub.signed),
        `${name} states no autograph checklist`,
      ).toEqual([]);
    }
  });
});

describe("a relic section is not an autograph section", () => {
  /**
   * A memorabilia scope lists REAL cards, so the "zero cards" refusal above
   * does not catch it -- and calling a relic signed would tag an unsigned
   * card as an auto, splitting a pool on a fact that is not true. The scope
   * is emitted honestly under its own type instead of being folded in or
   * silently dropped. No 2011 subsection is a relic, so this drives the
   * parser directly over the shape.
   */
  const page = (heading: string) => `<div class="mw-heading mw-heading2"><h2 id="Autographs">Autographs</h2></div>
<div class="mw-heading mw-heading3"><h3 id="X">${heading}</h3></div>
<ul><li>Refractor (serial-numbered to 99 copies)</li>
<li>10 Chipper Jones</li><li>11 Greg Maddux</li><li>12 Tom Glavine</li></ul>
<div id="catlinks"></div>`;

  it("reads a signed scope as an auto", () => {
    const [scope] = L.parseTypedSections(page("Rookie Autographs"));
    expect(scope.prefix).toBe("auto");
    expect(scope.signed).toBe(true);
    expect(scope.cards).toHaveLength(3);
  });

  it("reads a bare relic scope as a relic, never as an auto", () => {
    // Under an Autographs h2, a subsection whose OWN heading names only
    // memorabilia is UNSIGNED -- the h2 attests for the subsections that do
    // not speak for themselves, and this one has. Calling it signed would tag
    // unsigned cards as autos and split their pool on a fact that is not true.
    //
    // Having refused the signature it takes the unsigned lane, where the
    // §Inserts collision guard applies: a card numbered by a bare integer
    // inside a memorabilia subset would collide with the base set's own
    // numbering, so these three (10, 11, 12) yield no rows at all. Whichever
    // way it lands, what must NEVER happen is an isAuto=true row.
    const scopes = L.parseTypedSections(page("Game-Used Relics"));
    expect(scopes.every((sc: { signed: boolean }) => sc.signed === false)).toBe(true);
    expect(scopes.some((sc: { prefix: string }) => sc.prefix === "auto")).toBe(false);
    // The same heading with LETTERED card numbers is read, and still unsigned.
    const lettered = L.parseTypedSections(
      page("Game-Used Relics").replace(/<li>1(\d) /g, "<li>GU$1 "));
    expect(lettered).toHaveLength(1);
    expect(lettered[0].signed).toBe(false);
    expect(lettered[0].prefix).toBe("insert");
    expect(lettered[0].cards).toHaveLength(3);
  });

  it("reads a scope naming BOTH as an auto", () => {
    // "Autograph Relics" are signed; the auto word decides.
    const [scope] = L.parseTypedSections(page("Autograph Relics"));
    expect(scope.signed).toBe(true);
  });
});

describe("the scope guards that keep the auto rows honest", () => {
  it("does not read the subset heading as a parallel of itself", () => {
    // "Autographed Rookies" is the section's own name. Emitting it as a rung
    // would make every signed card a parallel of itself, at /499.
    expect(rows.some((r) => r.parallel === "Autographed Rookies")).toBe(false);
  });

  it("strips the EXCH redemption marker from the player name", () => {
    // The page writes "173 Freddie Freeman EXCH" -- a fulfilment state, not a
    // name. Carrying it would mint a second Freddie Freeman.
    expect(rows.some((r) => /EXCH/i.test(r.player))).toBe(false);
    expect(rows.some((r) => r.isAuto && r.player === "Freddie Freeman")).toBe(true);
  });
});
