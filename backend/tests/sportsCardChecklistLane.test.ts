/**
 * CF-SPORTSCARDCHECKLIST-VINTAGE-LANE (2026-09-04).
 *
 * The seventh lane, and the one that reaches vintage football, basketball and
 * hockey. Three sets are pinned here, one per sport and one per era, each at its
 * EXACT published card count:
 *
 *   1972 Topps Football      set-11959   351 cards
 *   1979-80 O-Pee-Chee Hockey set-12229  396 cards
 *   1957 Topps Basketball    set-12027    80 cards
 *
 * An exact count is the assertion because every failure this lane can suffer
 * shows up as a WRONG COUNT, never as an exception: a parser that reads the
 * hidden input instead of the header mis-splits the leader cards, a year regex
 * that assumes one form drops every split-season set, and a subset tag written
 * into the parallel column splits the base pool without changing the row total
 * at all. The last one is why the counts are joined by per-column assertions.
 *
 * TWO MUTATIONS ARE PINNED EXPLICITLY, because the survey named both as traps
 * and a guard nobody has mutation-checked is a guard nobody has tested:
 *
 *   1. DROP THE SPLIT-YEAR BRANCH -> the hockey and basketball URLs stop
 *      parsing. This is the false negative that made a live source look absent:
 *      basketball 1991-2009 and ALL of hockey report zero sets.
 *   2. TAG AS PARALLEL -> "LL"/"DP" land in the parallel column. The row count
 *      is unchanged, so only a column-level assertion can see it, and the
 *      consequence is a rung named after a subset splitting the base pool.
 *
 * The fixtures are the live pages trimmed to their card headers and hidden
 * inputs (119 KB / 143 KB / 27 KB), fetched 2026-09-04. Both anchors are kept so
 * the parser's own anchor-agreement check is exercised by the fixture.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  parseSetUrl, parallelFromSlug, splitCardHeader, buildRows, toCsv,
  unescapeCell, autoEvidence, SET_URL_RE,
} = require("../scripts/fetchSportsCardChecklist.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setKeyFor, gateStagedCsv, LANE_ALIASES } = require("../scripts/ingest-universe-driver.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { classify, setNameFrom, CELLS } = require("../scripts/discoverSportsCardChecklistSets.cjs");
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

const FIX = join(__dirname, "fixtures", "sportscardchecklist");
const html = (n: string) => readFileSync(join(FIX, `${n}.trimmed.html`), "utf8");
const B = "https://www.sportscardchecklist.com";

interface Row {
  category: string; cardNumber: string; parallel: string; isAuto: string;
  printRun: string; player: string; subset: string;
}

const SETS = [
  {
    name: "1972 Topps Football",
    fixture: "1972-topps-football",
    url: `${B}/set-11959/1972-topps-football-trading-card-checklist`,
    cards: 351, sport: "football", year: 1972, season: "1972", setKey: "topps",
    first: { cardNumber: "1", player: "Floyd Little/Larry Csonka/Marv Hubbard", subset: "1971 AFC Rushing Leaders" },
    last: { cardNumber: "351", player: "Ken Willard", subset: "In Action" },
  },
  {
    name: "1979-80 O-Pee-Chee Hockey",
    fixture: "1979-80-o-pee-chee-hockey",
    url: `${B}/set-12229/1979-80-o-pee-chee-hockey-trading-card-checklist`,
    cards: 396, sport: "hockey", year: 1979, season: "1979-80", setKey: "o-pee-chee",
    first: { cardNumber: "1", player: "Mike Bossy/Marcel Dionne/Guy Lafleur", subset: "League Leaders" },
    last: { cardNumber: "396", player: "Lars-Erik Sjoberg", subset: "" },
  },
  {
    name: "1957 Topps Basketball",
    fixture: "1957-topps-basketball",
    url: `${B}/set-12027/1957-topps-basketball-trading-card-checklist`,
    cards: 80, sport: "basketball", year: 1957, season: "1957", setKey: "topps",
    first: { cardNumber: "1", player: "Nat Clifton", subset: "Double Print" },
    last: { cardNumber: "80", player: "Dick Schnittker", subset: "" },
  },
] as const;

describe("sportscardchecklist lane — the three sampled sets", () => {
  for (const s of SETS) {
    describe(s.name, () => {
      const rows: Row[] = buildRows(html(s.fixture), {}).rows;

      it("emits EXACTLY the published card count", () => {
        expect(rows.length).toBe(s.cards);
      });

      it("agrees with the page's own second anchor (no shape drift)", () => {
        const stats = buildRows(html(s.fixture), {}).stats;
        expect(stats.headers).toBe(s.cards);
        expect(stats.hiddenRows).toBe(s.cards);
        expect(stats.anchorMismatch).toBe(false);
        expect(stats.skipped).toBe(0);
      });

      it("pins the first and last card", () => {
        expect(rows[0].cardNumber).toBe(s.first.cardNumber);
        expect(rows[0].player).toBe(s.first.player);
        expect(rows[0].subset).toBe(s.first.subset);
        const last = rows[rows.length - 1];
        expect(last.cardNumber).toBe(s.last.cardNumber);
        expect(last.player).toBe(s.last.player);
        expect(last.subset).toBe(s.last.subset);
      });

      it("card numbers are verbatim and unique", () => {
        expect(rows.every((r) => r.cardNumber.length > 0)).toBe(true);
        expect(rows.every((r) => !r.cardNumber.startsWith("#"))).toBe(true);
        expect(new Set(rows.map((r) => r.cardNumber)).size).toBe(s.cards);
      });

      // THE RULE THIS LANE EXISTS TO KEEP. printRun blank means unknown, never a
      // guess; parallel blank means plain, never the string "Base".
      it("printRun is blank on every row, and parallel is never the word Base", () => {
        expect(rows.every((r) => r.printRun === "")).toBe(true);
        expect(rows.every((r) => r.parallel === "")).toBe(true);
        expect(rows.some((r) => /^base$/i.test(r.parallel))).toBe(false);
      });

      // isAuto FROM EVIDENCE ONLY. All three are pre-1990 vintage and carry no
      // autograph badge and no autograph word, so all three are false.
      it("isAuto is false — no autograph evidence on the page", () => {
        expect(autoEvidence(html(s.fixture), s.name)).toBe(false);
        expect(rows.every((r) => r.isAuto === "false")).toBe(true);
      });

      it("the URL parses, split-year included, and the year is the FIRST year", () => {
        const p = parseSetUrl(s.url);
        expect(p).not.toBeNull();
        expect(p.year).toBe(s.year);
        expect(p.season ?? p.seasonLabel).toBe(s.season);
        expect(p.sport).toBe(s.sport);
      });

      it("setKeyFor gives the cell key, and it is a normalizeSetKey FIXED POINT", () => {
        const k = setKeyFor({ setName: s.name, year: s.year, lane: "sportscardchecklist" });
        expect(k).toBe(s.setKey);
        expect(normalizeSetKey(k)).toBe(k);
      });

      it("passes the driver's per-entry cleanliness gate", () => {
        const tmp = join(
          process.env.TEMP || process.env.TMPDIR || "/tmp",
          `scc-gate-${s.fixture}.csv`,
        );
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("node:fs").writeFileSync(tmp, toCsv(rows));
        const g = gateStagedCsv(tmp);
        expect(g.reason ?? null).toBeNull();
        expect(g.ok).toBe(true);
        expect(g.stats.rows).toBe(s.cards);
      });
    });
  }
});

describe("subset tags are subsets, never parallels", () => {
  it("1979-80 O-Pee-Chee: LL/AS/CL/RB/TC land in the category, and the parallel column stays empty", () => {
    const rows: Row[] = buildRows(html("1979-80-o-pee-chee-hockey"), {}).rows;
    const cats = new Set(rows.map((r) => r.category));
    expect(cats.has("insert-league-leaders")).toBe(true);
    expect(cats.has("insert-all-star")).toBe(true);
    expect(cats.has("insert-checklist")).toBe(true);
    expect(cats.has("insert-record-breaker")).toBe(true);
    expect(cats.has("insert-team-checklist")).toBe(true);
    // THE MUTATION. If a tag were written to the parallel column the row count
    // would not move at all — only this assertion sees it.
    expect(rows.every((r) => r.parallel === "")).toBe(true);
    const tagged = rows.filter((r) => r.subset);
    expect(tagged.length).toBe(45);
    expect(tagged.every((r) => r.parallel === "")).toBe(true);
  });

  it("1957 Topps: 47 Double Prints are a subset, not a finish", () => {
    const rows: Row[] = buildRows(html("1957-topps-basketball"), {}).rows;
    expect(rows.filter((r) => r.category === "insert-double-print").length).toBe(47);
    expect(rows.filter((r) => r.category === "base").length).toBe(33);
    expect(rows.every((r) => r.parallel === "")).toBe(true);
  });

  it("1972 Topps: In Action and Pro Action are subsets; the leader phrases are too", () => {
    const rows: Row[] = buildRows(html("1972-topps-football"), {}).rows;
    expect(rows.filter((r) => r.category === "insert-in-action").length).toBe(42);
    expect(rows.filter((r) => r.category === "insert-pro-action").length).toBe(24);
    expect(rows.filter((r) => r.category === "insert-1971-afc-rushing-leaders").length).toBe(1);
    expect(rows.every((r) => r.parallel === "")).toBe(true);
  });

  // UER describes a PRINTING MISTAKE on a card that is otherwise the same card.
  // Folding it into the category would split that card's pool in two.
  it("UER is stripped from the player name and files nothing", () => {
    const c = splitCardHeader("42 Bob Smith UER");
    expect(c.player).toBe("Bob Smith");
    expect(c.subset).toBe("");
    const rows: Row[] = buildRows(html("1972-topps-football"), {}).rows;
    expect(rows.some((r) => /\bUER\b/.test(r.player))).toBe(false);
    expect(rows.some((r) => r.category.includes("uer"))).toBe(false);
  });

  it("a two-letter surname-like token is not mistaken for a tag", () => {
    // "XX" is not in the vocabulary, so it stays part of the name.
    expect(splitCardHeader("7 Bobby XX").player).toBe("Bobby XX");
    expect(splitCardHeader("7 Bobby XX").subset).toBe("");
  });
});

describe("MUTATION: dropping the split-year branch turns a live source into an absent one", () => {
  // The regex WITHOUT the optional -YY season group — the exact shape the survey
  // recorded as reporting zero sets for basketball 1991-2009 and all of hockey.
  const SINGLE_YEAR_ONLY =
    /\/set-(\d+)\/(\d{4})-(.+?)-(football|basketball|hockey|baseball)-trading-card-checklist\/?$/;

  const SPLIT = [
    `${B}/set-12229/1979-80-o-pee-chee-hockey-trading-card-checklist`,
    `${B}/set-12437/1992-93-topps-gold-basketball-trading-card-checklist`,
    `${B}/set-142130/1999-00-topps-impact-refractors-basketball-trading-card-checklist`,
  ];

  it("the shipped regex accepts every split-year URL", () => {
    for (const u of SPLIT) expect(SET_URL_RE.test(u), u).toBe(true);
  });

  it("the mutated regex REJECTS them — this is the red the pin buys", () => {
    for (const u of SPLIT) {
      // It either fails outright, or (worse) mis-reads the season as the brand.
      const m = SINGLE_YEAR_ONLY.exec(u);
      const shipped = SET_URL_RE.exec(u)!;
      const misread = m !== null && m[3] !== shipped[4];
      expect(m === null || misread, `${u} must not parse correctly without the split-year branch`).toBe(true);
    }
  });

  it("the FIRST year is the cell year, never the second", () => {
    expect(parseSetUrl(`${B}/set-12229/1979-80-o-pee-chee-hockey-trading-card-checklist`).year).toBe(1979);
    expect(parseSetUrl(`${B}/set-12437/1992-93-topps-gold-basketball-trading-card-checklist`).year).toBe(1992);
    // 1999-00: the second half rolls the century, and the first year still wins.
    expect(parseSetUrl(`${B}/set-142130/1999-00-topps-impact-refractors-basketball-trading-card-checklist`).year).toBe(1999);
  });

  it("single-year football still parses (the branch is additive)", () => {
    expect(parseSetUrl(`${B}/set-11959/1972-topps-football-trading-card-checklist`).year).toBe(1972);
    expect(parseSetUrl(`${B}/set-11959/1972-topps-football-trading-card-checklist`).year2).toBeNull();
  });
});

describe("a parallel comes from the slug, or it is blank", () => {
  it("names the rung only where the slug states it", () => {
    expect(parallelFromSlug("topps-gold")).toBe("Gold");
    expect(parallelFromSlug("topps-impact-refractors")).toBe("Refractor");
    expect(parallelFromSlug("donruss-artist-proof")).toBe("Artist Proof");
  });

  it("never invents one for a plain vintage set", () => {
    expect(parallelFromSlug("topps-football")).toBe("");
    expect(parallelFromSlug("o-pee-chee")).toBe("");
    // "golden-greats" is a PRODUCT NAME, not a Gold rung — the match is anchored
    // to the slug tail precisely so this stays blank.
    expect(parallelFromSlug("topps-golden-greats")).toBe("");
  });
});

describe("the page's own escaping is undone", () => {
  it("an apostrophe survives the addslashes pass", () => {
    expect(unescapeCell("Jim O\\'Brien")).toBe("Jim O'Brien");
    expect(unescapeCell("Ed O&#39;Bradovich")).toBe("Ed O'Bradovich");
  });

  it("1972 Topps carries real apostrophe names, unescaped", () => {
    const rows: Row[] = buildRows(html("1972-topps-football"), {}).rows;
    const obrien = rows.find((r) => r.cardNumber === "56");
    expect(obrien!.player).toBe("Jim O'Brien");
    expect(rows.some((r) => r.player.includes("\\"))).toBe(false);
  });
});

describe("the CSV is the one checklist format", () => {
  it("header is the canonical six columns plus the two optional ones", () => {
    const csv: string = toCsv(buildRows(html("1957-topps-basketball"), {}).rows);
    const header = csv.split("\n")[0];
    expect(header.startsWith("category,cardNumber,parallel,isAuto,printRun,player")).toBe(true);
    expect(header).toBe("category,cardNumber,parallel,isAuto,printRun,player,parallelNote,rarity");
  });

  it("a comma in a player name is quoted, not a column break", () => {
    const csv: string = toCsv([{
      category: "base", cardNumber: "1", parallel: "", isAuto: "false",
      printRun: "", player: "Griffey Jr., Ken", parallelNote: "", rarity: "",
    }] as never);
    expect(csv.split("\n")[1]).toBe('base,1,,false,,"Griffey Jr., Ken",,');
  });
});

describe("the lane is wired into the driver", () => {
  it("both the long and short alias resolve", () => {
    expect(LANE_ALIASES.sportscardchecklist).toBe("sportscardchecklist");
    expect(LANE_ALIASES.scc).toBe("sportscardchecklist");
  });
});

describe("discovery: every emitted setKey is a normalizeSetKey fixed point", () => {
  it("classifies the three sampled URLs into their cells", () => {
    for (const s of SETS) {
      const c = classify(s.url);
      expect(c, s.url).not.toBeNull();
      expect(c.sport).toBe(s.sport);
      expect(c.year).toBe(s.year);
      expect(c.season).toBe(s.season);
    }
  });

  it("the derived name round-trips to the cell's setKey for a flagship set", () => {
    for (const s of SETS) {
      const c = classify(s.url);
      const name = setNameFrom(c.season, c.rest, c.sport);
      const k = normalizeSetKey(setKeyFor({ setName: name, year: c.year, lane: "sportscardchecklist" }));
      expect(k, name).toBe(s.setKey);
    }
  });

  // THE PIN THAT KEEPS ROWS FINDABLE. A specialized set derives its own key
  // ("fleer-all-stars"), which the vocabulary collapses to "fleer" — so the
  // entry must carry the CANONICAL key, or the rows land under a key the
  // catalog never uses and no search reaches them (#1614).
  it("normalizeSetKey is idempotent on the derived keys, so the canonical form is always a fixed point", () => {
    for (const derived of [
      "topps", "o-pee-chee", "fleer", "upper-deck", "skybox",
      "topps-chrome", "skybox-premium", "upper-deck-mvp",
      "fleer-all-stars", "fleer-authentix-autographs-25", "topps-felt-backs", "topps-magic",
    ]) {
      const canonical = normalizeSetKey(derived);
      expect(normalizeSetKey(canonical), derived).toBe(canonical);
    }
  });

  it("every manifest entry for this lane carries a fixed-point setKey", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const manifest = require("../data/ingest-universe.json");
    const entries = manifest.entries.filter((e: { lane: string }) => e.lane === "sportscardchecklist");
    expect(entries.length).toBeGreaterThan(5000);
    const bad = entries.filter((e: { setKey?: string }) => !e.setKey || normalizeSetKey(e.setKey) !== e.setKey);
    expect(bad.map((e: { id: string }) => e.id).slice(0, 5)).toEqual([]);
    // Every entry is addressable and verifiable: an id, a URL, a year, a sport.
    expect(entries.every((e: { sourceRef: string }) => e.sourceRef.startsWith(`${B}/set-`))).toBe(true);
    expect(entries.every((e: { year: number }) => Number.isFinite(e.year))).toBe(true);
  });

  it("all eight cells are represented", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const manifest = require("../data/ingest-universe.json");
    const entries = manifest.entries.filter((e: { lane: string }) => e.lane === "sportscardchecklist");
    for (const cell of CELLS) {
      const n = entries.filter((e: { seededNote: string }) => e.seededNote.includes(`cell ${cell.label}`)).length;
      expect(n, cell.label).toBeGreaterThan(0);
    }
  });
});
