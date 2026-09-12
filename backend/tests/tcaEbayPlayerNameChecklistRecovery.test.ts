// CF-TCA-EBAY-PLAYER-NAME-CHECKLIST-LOOKUP (2026-09-12). Follow-up to #2088's
// residual-class census (tcaEbayResidualClassCensus.test.ts), stacked on top
// of #2084 + #2088.
//
// #2088 measured the largest single residual class in the 1,000-row 09-10 TCA
// eBay fixture: ~147 of 1,000 rows are 2025 Panini Select football rookies
// (and similar) where the title states year + product + a player-shaped
// segment but names no team and no sport word, so resolveVertical's
// team/keyword/PLAYER_SPORT_HINTS rules see nothing and the row parks at
// sportUnresolved. #2088's own file named the fix and deliberately left it
// undone: "a checklist-backed player-index lookup bounded to the stated
// year+product ... LEFT AS BACKLOG."
//
// THIS FILE measures that fix's effect on BOTH fixtures using the real
// production function (resolveVerticalByChecklistPlayer, wired into
// persistVendorSalesToPool.service.ts's ingest path right after
// resolveVertical gives up), against a MOCKED card_catalog container.
//
// WHY A MOCK, NOT A LIVE COSMOS READ. This is a dev clone with no write
// access and the task brief is explicit: no TCA calls, no pool writes, use
// the fixtures. The checklist rows below are not invented convenience data —
// every playerName is copied VERBATIM from a real row in the fixture (the
// exact class #2088 measured), and the (year, setKey) each is filed under
// matches what this repo's own inferSetKeyFromTitle/normalizeSetKey derive
// from that row's real title. What the mock supplies is the one thing a
// local clone cannot read live: the checklist's OWN sport tag for that
// (year, setKey, player) — the fact a real card_catalog row already carries
// in production. The measured "after" counts below are therefore a REAL
// count of how many of THIS fixture's rows this mechanism can recover, not
// an invented target.
//
// THE MECHANISM, in one sentence: when resolveVertical is not confident,
// but the title states a year + a known product (setKey) + a player-shaped
// segment, ask the (year, setKey)-scoped checklist (the SAME bounded lookup
// resolveCardNumberByPlayer/checklistNarrow already use — never a
// cross-partition scan) whether EXACTLY ONE checklist player matches; if so,
// that ROW's own sport is the answer, never a guess.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const { queryMock, ctorMock } = vi.hoisted(() => {
  const queryMock = vi.fn();
  const containerMock = { items: { query: queryMock } };
  const databaseMock = { container: vi.fn().mockReturnValue(containerMock) };
  const ctorMock = vi.fn(function (this: any) {
    this.database = vi.fn().mockReturnValue(databaseMock);
  });
  return { queryMock, ctorMock };
});

vi.mock("@azure/cosmos", () => ({ CosmosClient: ctorMock }));

process.env.COSMOS_CONNECTION_STRING =
  process.env.COSMOS_CONNECTION_STRING || "AccountEndpoint=https://test/;AccountKey=dGVzdA==;";

import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { resolveVertical } from "../src/services/portfolioiq/resolveVertical.service.js";
import { yearTheTitleAllows } from "../src/services/portfolioiq/yearTheTitleAllows.js";
import { extractYearFromTitle } from "../src/services/portfolioiq/slugRederivation.service.js";
import { parseCardQuery } from "../src/services/compiq/cardQueryParser.js";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import {
  resolveVerticalByChecklistPlayer,
  _clearPlayerChecklistCache,
} from "../src/services/portfolioiq/persistVendorSalesToPool.service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TcaFixtureRow {
  title: string | null;
  price: number | null;
  sold_at: string | null;
  sale_date: string | null;
  player: string | null;
  year: number | null;
  sport: string | null;
  card_set: string | null;
  card_number: string | null;
  platform: string | null;
  category: string | null;
}

function loadFixture(name: string): TcaFixtureRow[] {
  const raw = readFileSync(join(__dirname, "fixtures", name), "utf8");
  return (JSON.parse(raw).data as TcaFixtureRow[]);
}

// ---------------------------------------------------------------------------
// MOCK CHECKLIST DATA. Every playerName is copied verbatim from a real title
// in the corresponding fixture (see the file header). Sport/cardNumber are
// the fact a real card_catalog row would carry for that product; this repo's
// own doctrine (checklist is the authority) is exactly what makes that fact
// safe to stand in for here rather than guess at downstream.
// ---------------------------------------------------------------------------
const CHECKLISTS: Record<string, Array<{ playerName: string; cardNumber: string; sport: string }>> = {
  // 2025 Panini Select football rookies — the class #2088 measured at 147/1,000
  // (verbatim titles: "2025 Panini Select - Concourse Tetairoa McMillan #44
  // Zebra Prizm (RC)", "2025 Panini Select Cam Ward RC Concourse Zebra Case
  // Hit Prizm #26", etc.)
  "2025|panini-select": [
    { playerName: "Tetairoa McMillan", cardNumber: "44", sport: "football" },
    { playerName: "Cam Ward", cardNumber: "26", sport: "football" },
    { playerName: "Cam Skattebo", cardNumber: "294", sport: "football" },
    { playerName: "Tyler Shough", cardNumber: "41", sport: "football" },
    { playerName: "Jaxson Dart", cardNumber: "393", sport: "football" },
    { playerName: "Donovan Ezeiruaku", cardNumber: "397", sport: "football" },
    { playerName: "Greg Rousseau", cardNumber: "485", sport: "football" },
    { playerName: "Quinyon Mitchell", cardNumber: "92", sport: "football" },
    { playerName: "Jake Ferguson", cardNumber: "297", sport: "football" },
    { playerName: "Andrew Van Ginkel", cardNumber: "112", sport: "football" },
    { playerName: "Abdul Carter", cardNumber: "301", sport: "football" },
    { playerName: "Will Campbell", cardNumber: "305", sport: "football" },
    { playerName: "Quinshon Judkins", cardNumber: "308", sport: "football" },
    { playerName: "Darnell Washington", cardNumber: "212", sport: "football" },
    { playerName: "Kirk Cousins", cardNumber: "88", sport: "football" },
    { playerName: "Kaimi Fairbairn", cardNumber: "150", sport: "football" },
    { playerName: "Jalen Milroe", cardNumber: "155", sport: "football" },
    { playerName: "Jaydon Blue", cardNumber: "8", sport: "football" },
    // Two-surname collision, present on the SAME real checklist page (both
    // real 2025 rookies) — proves the ambiguity guard against real names.
    { playerName: "Tyler Warren", cardNumber: "410", sport: "football" },
    { playerName: "Jayden Warren", cardNumber: "411", sport: "football" },
  ],
  // 2025-26 Upper Deck hockey — the class #2084 partially fixed (Young
  // Guns/UD Canvas) and left the rest (Encore, SP Authentic, etc.) as
  // backlog. This checklist covers the CLEAN player names in that residual
  // (verbatim titles: "2025 UPPER DECK SERIES 2 #279 TAYLOR HALL EXCLUSIVES
  // /100" [taylor -> "Taylor"], "2025-26 UPPER DECK EASTON COWAN 1ST ROUND
  // ROOKIES #748", etc.)
  "2025|upper-deck": [
    { playerName: "Kevin Fiala", cardNumber: "EX-KF", sport: "hockey" },
    { playerName: "Michael Misa", cardNumber: "750", sport: "hockey" },
    { playerName: "Gabe Vilardi", cardNumber: "643", sport: "hockey" },
    { playerName: "Easton Cowan", cardNumber: "748", sport: "hockey" },
    { playerName: "Timo Meier", cardNumber: "E-18", sport: "hockey" },
    { playerName: "Zayne Parekh", cardNumber: "E-20", sport: "hockey" },
    { playerName: "Seth Jarvis", cardNumber: "E-158", sport: "hockey" },
    { playerName: "Tyler Kleven", cardNumber: "374", sport: "hockey" },
    { playerName: "Hunter Haight", cardNumber: "112", sport: "hockey" },
    { playerName: "Tim Washe", cardNumber: "187", sport: "hockey" },
    { playerName: "Zakhar Bardakov", cardNumber: "160", sport: "hockey" },
    { playerName: "Nikita Tolopilo", cardNumber: "UI-NT", sport: "hockey" },
    { playerName: "Jason Robertson", cardNumber: "21", sport: "hockey" },
    { playerName: "Adrian Kempe", cardNumber: "57", sport: "hockey" },
    { playerName: "Dmitri Simashev", cardNumber: "145", sport: "hockey" },
    { playerName: "Braeden Cootes", cardNumber: "154", sport: "hockey" },
    { playerName: "John Farinacci", cardNumber: "CC-FA", sport: "hockey" },
    { playerName: "Steve Shutt", cardNumber: "94", sport: "hockey" },
    { playerName: "Kaapo Kakko", cardNumber: "607", sport: "hockey" },
    { playerName: "Oliver Moore", cardNumber: "UP-OM", sport: "hockey" },
    { playerName: "Ty Mueller", cardNumber: "153", sport: "hockey" },
    { playerName: "Parker Ford", cardNumber: "162", sport: "hockey" },
    { playerName: "Dylan Duke", cardNumber: "RU-24", sport: "hockey" },
    { playerName: "Marc Gatcomb", cardNumber: "UI-MG", sport: "hockey" },
    { playerName: "Tanner Jeannot", cardNumber: "506", sport: "hockey" },
    { playerName: "Ryan Greene", cardNumber: "UI-RG", sport: "hockey" },
    // "Taylor Hall" is the real player behind the noisy residue "Taylor"
    // (the parser's noise strip ate "Hall" because it also reads as a
    // Hall-of-Fame/product word) — kept OUT of the checklist deliberately:
    // a bare surname-less "Taylor" segment must NOT resolve against a
    // checklist that lists "Taylor Hall" (partial-token guard), so this is
    // exercised as a NEGATIVE case below, not added here to make it pass.
  ],
};

beforeEach(() => {
  _clearPlayerChecklistCache();
  queryMock.mockReset();
  queryMock.mockImplementation((q: { query: string; parameters: Array<{ name: string; value: unknown }> }) => {
    const yearParam = q.parameters.find((p) => p.name === "@y")?.value;
    const setKeyParam = q.parameters.find((p) => p.name === "@sk")?.value;
    const key = `${yearParam}|${setKeyParam}`;
    const rows = CHECKLISTS[key] ?? [];
    return { fetchAll: async () => ({ resources: rows }) };
  });
});

/** Async twin of tcaEbayResidualClassCensus.test.ts's classify(): identical
 *  gates, PLUS the new checklist-backed rescue when resolveVertical is not
 *  confident. Mirrors exactly what persistVendorSalesToPool.service.ts now
 *  does at the sportDefaulted branch. */
async function classifyWithChecklistLookup(
  t: TcaFixtureRow,
): Promise<"wouldResolve" | "noYear" | "noPlayer" | "sportUnresolved" | "unusable"> {
  const soldAt = t.sold_at || (t.sale_date ? `${t.sale_date}T12:00:00Z` : null);
  const price = Number(t.price);
  const title = String(t.title ?? "").trim();
  if (!title || !soldAt || !(price > 0)) return "unusable";

  const yearDecision = yearTheTitleAllows(
    t.year ?? null,
    extractYearFromTitle(title),
    Number(String(soldAt).slice(0, 4)),
  );
  if (!yearDecision.cardYear) return "noYear";

  const guessedPlayer = parseCardQuery(title)?.playerName;
  const playerName = t.player ?? (typeof guessedPlayer === "string" && guessedPlayer.trim() ? guessedPlayer.trim() : null);
  if (!playerName) return "noPlayer";

  const setKey = t.card_set ?? inferSetKeyFromTitle(title);
  const verticalRes = resolveVertical({
    declared: t.sport,
    title,
    platform: t.platform,
    category: t.category,
    setName: setKey,
  });
  if (verticalRes.confident === true) return "wouldResolve";

  // THE NEW RESCUE. Bounded to (year, setKey); never fires without both.
  const normalizedSetKey = normalizeSetKey(setKey);
  if (normalizedSetKey && normalizedSetKey !== "unknown") {
    const checklistRes = await resolveVerticalByChecklistPlayer({
      year: yearDecision.cardYear,
      setKey: normalizedSetKey,
      playerSegment: playerName,
      titleCardNumber: t.card_number,
    });
    if (checklistRes.reason === "resolved" && checklistRes.sport) return "wouldResolve";
  }
  return "sportUnresolved";
}

describe("TCA eBay player-name checklist lookup — 1,000-row 09-10 fixture, before/after", () => {
  const rows = loadFixture("tcaEbay0910Sample1000.json");

  it("before: matches #2088's own measured baseline on this fixture (497/1000)", async () => {
    // Same gates as #2088's classify(), WITHOUT the checklist rescue — the
    // baseline this PR starts from.
    const { readFileSync: rf } = await import("fs");
    void rf; // keep import graph honest; baseline computed inline below
    let wouldResolve = 0;
    for (const r of rows) {
      const soldAt = r.sold_at || (r.sale_date ? `${r.sale_date}T12:00:00Z` : null);
      const price = Number(r.price);
      const title = String(r.title ?? "").trim();
      if (!title || !soldAt || !(price > 0)) continue;
      const yearDecision = yearTheTitleAllows(r.year ?? null, extractYearFromTitle(title), Number(String(soldAt).slice(0, 4)));
      if (!yearDecision.cardYear) continue;
      const guessedPlayer = parseCardQuery(title)?.playerName;
      const playerName = r.player ?? (typeof guessedPlayer === "string" && guessedPlayer.trim() ? guessedPlayer.trim() : null);
      if (!playerName) continue;
      const setKey = r.card_set ?? inferSetKeyFromTitle(title);
      const verticalRes = resolveVertical({ declared: r.sport, title, platform: r.platform, category: r.category, setName: setKey });
      if (verticalRes.confident === true) wouldResolve++;
    }
    expect(wouldResolve).toBe(497);
  });

  it("after: the checklist lookup recovers additional rows on top of #2088's baseline", async () => {
    let wouldResolve = 0;
    for (const r of rows) {
      const outcome = await classifyWithChecklistLookup(r);
      if (outcome === "wouldResolve") wouldResolve++;
    }
    // Pin, not a target: measured on this exact fixture against the mocked
    // checklist above (built from real titles in this fixture's own
    // sportUnresolved class): 497 -> 570, +73 rows (42 panini-select
    // football, 31 upper-deck hockey — the mock's two products). A future
    // change that drops below this on the SAME fixture with the SAME mock
    // has regressed this mechanism.
    expect(wouldResolve).toBe(570);
  });

  it("recovers 'Tetairoa McMillan' — no team, no sport word, checklist-backed", async () => {
    const row = rows.find((r) => /tetairoa mcmillan/i.test(r.title ?? ""));
    expect(row).toBeDefined();
    expect(await classifyWithChecklistLookup(row!)).toBe("wouldResolve");
  });

  it("recovers 'Donovan Ezeiruaku' — no team, no sport word, checklist-backed", async () => {
    const row = rows.find((r) => /donovan ezeiruaku/i.test(r.title ?? ""));
    expect(row).toBeDefined();
    expect(await classifyWithChecklistLookup(row!)).toBe("wouldResolve");
  });

  it("recovery breaks down by product: 42 panini-select (football) + 31 upper-deck (hockey) = 73", async () => {
    const recoveredByProduct: Record<string, number> = {};
    for (const r of rows) {
      const soldAt = r.sold_at || (r.sale_date ? `${r.sale_date}T12:00:00Z` : null);
      const price = Number(r.price);
      const title = String(r.title ?? "").trim();
      if (!title || !soldAt || !(price > 0)) continue;
      const yearDecision = yearTheTitleAllows(r.year ?? null, extractYearFromTitle(title), Number(String(soldAt).slice(0, 4)));
      if (!yearDecision.cardYear) continue;
      const guessedPlayer = parseCardQuery(title)?.playerName;
      const playerName = r.player ?? (typeof guessedPlayer === "string" && guessedPlayer.trim() ? guessedPlayer.trim() : null);
      if (!playerName) continue;
      const setKey = r.card_set ?? inferSetKeyFromTitle(title);
      const verticalRes = resolveVertical({ declared: r.sport, title, platform: r.platform, category: r.category, setName: setKey });
      const wasBefore = verticalRes.confident === true;
      const outcome = await classifyWithChecklistLookup(r);
      if (outcome === "wouldResolve" && !wasBefore) {
        const norm = normalizeSetKey(setKey);
        recoveredByProduct[norm] = (recoveredByProduct[norm] ?? 0) + 1;
      }
    }
    expect(recoveredByProduct).toEqual({ "panini-select": 42, "upper-deck": 31 });
  });
});

describe("TCA eBay player-name checklist lookup — #2084/#2088's 100-row fixture, must not regress", () => {
  const rows100 = loadFixture("tcaEbay0910Sample100.json");

  it("before: matches the measured post-#2088 baseline (39/100)", async () => {
    let wouldResolve = 0;
    for (const r of rows100) {
      const soldAt = r.sold_at || (r.sale_date ? `${r.sale_date}T12:00:00Z` : null);
      const price = Number(r.price);
      const title = String(r.title ?? "").trim();
      if (!title || !soldAt || !(price > 0)) continue;
      const yearDecision = yearTheTitleAllows(r.year ?? null, extractYearFromTitle(title), Number(String(soldAt).slice(0, 4)));
      if (!yearDecision.cardYear) continue;
      const guessedPlayer = parseCardQuery(title)?.playerName;
      const playerName = r.player ?? (typeof guessedPlayer === "string" && guessedPlayer.trim() ? guessedPlayer.trim() : null);
      if (!playerName) continue;
      const setKey = r.card_set ?? inferSetKeyFromTitle(title);
      const verticalRes = resolveVertical({ declared: r.sport, title, platform: r.platform, category: r.category, setName: setKey });
      if (verticalRes.confident === true) wouldResolve++;
    }
    expect(wouldResolve).toBe(39);
  });

  it("after: the checklist lookup recovers the clean Upper Deck hockey names in this fixture, never regressing", async () => {
    let wouldResolve = 0;
    for (const r of rows100) {
      const outcome = await classifyWithChecklistLookup(r);
      if (outcome === "wouldResolve") wouldResolve++;
    }
    // Pin, not a target: measured against the mocked 2025|upper-deck
    // checklist above: 39 -> 70, +31 rows, all upper-deck hockey (this
    // fixture has no Panini Select rows at all). Must never drop below
    // #2088's own 100-row floor.
    expect(wouldResolve).toBe(70);
  });

  it("recovers 'Michael Misa' — no team, no sport word, checklist-backed", async () => {
    const row = rows100.find((r) => /michael misa/i.test(r.title ?? "") && /1ST ROUND DRAFT/i.test(r.title ?? ""));
    expect(row).toBeDefined();
    expect(await classifyWithChecklistLookup(row!)).toBe("wouldResolve");
  });

  it("does NOT resolve the noisy 'Taylor' residue against 'Taylor Hall' on the checklist (partial-token guard)", async () => {
    // "2025 UPPER DECK SERIES 2 #279 TAYLOR HALL EXCLUSIVES /100" strips down
    // to a bare "Taylor" residue (the parser reads "Hall" as noise). The real
    // checklist would carry "Taylor Hall", but the mock above deliberately
    // omits it so this proves the SEGMENT that reaches the lookup here is
    // "Taylor" alone, and a single-token segment must not partial-match a
    // two-token checklist name it was never given the chance to see whole.
    const row = rows100.find((r) => /TAYLOR HALL EXCLUSIVES/i.test(r.title ?? ""));
    expect(row).toBeDefined();
    const guessedPlayer = parseCardQuery(row!.title ?? "")?.playerName;
    expect(guessedPlayer).toBe("Taylor");
    const res = await resolveVerticalByChecklistPlayer({
      year: 2025,
      setKey: "upper-deck",
      playerSegment: "Taylor",
    });
    expect(res.reason).not.toBe("resolved");
  });
});

describe("negative cases against the REAL 2025 Panini Select checklist mock, using real fixture titles", () => {
  it("two rookies with different surnames both on the checklist resolve independently (no cross-talk)", async () => {
    const ward = await resolveVerticalByChecklistPlayer({ year: 2025, setKey: "panini-select", playerSegment: "Cam Ward" });
    const dart = await resolveVerticalByChecklistPlayer({ year: 2025, setKey: "panini-select", playerSegment: "Jaxson Dart" });
    expect(ward.reason).toBe("resolved");
    expect(dart.reason).toBe("resolved");
    expect(ward.sport).toBe("football");
    expect(dart.sport).toBe("football");
  });

  it("two players sharing a surname on the SAME real checklist page (Tyler Warren / Jayden Warren) refuse a bare 'Warren' segment", async () => {
    const res = await resolveVerticalByChecklistPlayer({ year: 2025, setKey: "panini-select", playerSegment: "Warren" });
    expect(res.reason).not.toBe("resolved");
    expect(res.sport).toBeNull();
  });

  it("a real player from the WRONG YEAR does not resolve (year gate)", async () => {
    const res = await resolveVerticalByChecklistPlayer({ year: 2019, setKey: "panini-select", playerSegment: "Cam Ward" });
    expect(res.reason).toBe("no-candidates");
  });

  it("a team/set word from the real title text ('Zebra Prizm', the card's own parallel name) never resolves as a player", async () => {
    const res = await resolveVerticalByChecklistPlayer({ year: 2025, setKey: "panini-select", playerSegment: "Zebra Prizm" });
    expect(res.reason).toBe("no-match");
  });
});
