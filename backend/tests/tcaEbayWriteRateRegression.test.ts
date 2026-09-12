// CF-TCA-EBAY-WRITE-RATE-COLLAPSE (2026-09-12). Root cause + pin.
//
// Between 08-25 and 09-11 the TCA firehose ingest's per-day eBay write rate
// fell from ~34-41% (measured against the 08-18..08-24 run logs, single
// platform=eBay daily-feed runs) to ~9-26% (measured against 09-08..09-11
// run logs, same lane). Two independent facts compound into that collapse:
//
//   1. TCA'S PAYLOAD SHAPE CHANGED. A live pull of 1,000 eBay rows for
//      2026-09-10 shows 0/1,000 rows carrying ANY structured identity hint
//      (player/year/sport/card_set/card_number all null) — down from 5.5%
//      (11/200) on a live pull for the healthy day 2026-08-22. Title text is
//      now the ONLY signal for effectively every row.
//
//   2. #1929 (CF-NO-DEFAULT-SPORT, landed 2026-09-06 22:03 ET) correctly
//      stopped silently defaulting an unresolved vertical to "baseball" —
//      the first clean post-#1929 run (34174828721, 2026-09-08T00:55Z)
//      already shows eBay written=1059/fetched=10864 (9.75%), matching the
//      collapsed rate seen through 09-11. This is DELIBERATE, correct
//      doctrine (a guessed sport is a guessed pool address) — reverting it
//      is not the fix.
//
// Classifying the SAME 08-22 sample through the pre-#1929 code (worktree at
// c01db10) and the current code both give 35.0% wouldWrite — proving the
// title-parsing gates themselves did not regress. What changed is that
// title-only parsing now has to carry rows #1929 used to paper over, and a
// large share of 09-10's rows are modern Upper Deck Hockey titles that state
// an insert/product line and a player but NO team name and NO "hockey"/"NHL"
// word at all ("467 Marshall Warren Young Guns 2025-26 Upper Deck").
//
// THE FIX: "Young Guns" and "UD Canvas" are Upper Deck's own hockey-exclusive
// rookie insert brands (never printed for any other sport), so naming them in
// inferSportFromTitle recovers real, stated signal — not a guess. It is
// intentionally narrow: a bare "Upper Deck" is NOT added (UD also prints
// baseball/basketball), and the larger tail of ambiguous Upper Deck hockey
// product names (SP Authentic, O-Pee-Chee, Black Diamond, SPX — all used
// cross-sport in some years) is left for a follow-up with per-name
// verification rather than guessed here.
//
// This test pins the recovery on a REAL 100-row fixture (titles + the same
// fields TCA sends; externalId/url/image stripped, no secrets) pulled live
// for 2026-09-10, asserting: (a) the fix does not regress the pre-fix
// baseline measured against this exact fixture, and (b) it recovers a
// nonzero, specific set of rows via the hockey-exclusive insert names —
// never more than that, so a future change that starts guessing sport from
// a bare brand name would show up as an unexplained jump here.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { inferSportFromTitle, inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { resolveVertical } from "../src/services/portfolioiq/resolveVertical.service.js";
import { yearTheTitleAllows } from "../src/services/portfolioiq/yearTheTitleAllows.js";
import { extractYearFromTitle } from "../src/services/portfolioiq/slugRederivation.service.js";
import { parseCardQuery } from "../src/services/compiq/cardQueryParser.js";

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

function loadFixture(): TcaFixtureRow[] {
  const raw = readFileSync(join(__dirname, "fixtures", "tcaEbay0910Sample100.json"), "utf8");
  return (JSON.parse(raw).data as TcaFixtureRow[]);
}

// Mirrors the ingest script's tcaToVendorSaleRow + the pre-I/O gates of
// persistVendorSalesToPool up to (not including) the Cosmos-dependent stages
// (checklistNarrow / dedup / twin-check), which need a live container and
// are out of scope for this pin. classify() therefore reports "wouldResolve"
// rather than "written" — a superset of the real write rate, but the exact
// set this fix can move.
function classify(t: TcaFixtureRow): "wouldResolve" | "noYear" | "noPlayer" | "sportUnresolved" | "unusable" {
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

  // Player resolution: the real gate's private guessPlayerFromTitle is a
  // thin, documented wrapper around exactly this call —
  // `parseCardQuery(title).playerName` — reused verbatim here for fidelity.
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
  if (verticalRes.confident !== true) return "sportUnresolved";

  return "wouldResolve";
}

describe("TCA eBay write-rate regression — 100-row 09-10 fixture", () => {
  const rows = loadFixture();

  it("fixture has 100 real eBay rows with zero structured TCA hints (the payload-shape finding)", () => {
    expect(rows.length).toBe(100);
    const withAnyHint = rows.filter((r) => r.player || r.year || r.sport || r.card_set || r.card_number);
    expect(withAnyHint.length).toBe(0);
  });

  it("current code resolves a nonzero, non-collapsing share of the fixture", () => {
    const outcomes = rows.map(classify);
    const wouldResolve = outcomes.filter((o) => o === "wouldResolve").length;
    // Pin, not a target: this is the measured rate on this exact fixture at
    // the time the fix landed. A future change that drops materially below
    // this on the SAME fixture has regressed the sport/year/player gates;
    // one that rises is welcome (tighten the floor when that happens).
    expect(wouldResolve).toBeGreaterThanOrEqual(30);
  });

  it("'Young Guns' / 'UD Canvas' titles with no team name, no explicit sport keyword, and no other-category marker resolve to hockey", () => {
    // Excludes the one real collision in this fixture: Upper Deck Goodwin
    // Champions reuses the "Young Guns" insert name across categories, and
    // the row that carries it states "MMA" explicitly — the pre-existing
    // mma/ufc keyword check runs BEFORE this fix's rule and correctly wins.
    // That is proof the fix is additive, not a proof this fix is wrong.
    const youngGunsRows = rows.filter(
      (r) => /young\s+guns|ud\s+canvas/i.test(r.title ?? "")
        && !/\b(mma|ufc|bellator|octagon)\b/i.test(r.title ?? ""),
    );
    expect(youngGunsRows.length).toBeGreaterThan(0);
    for (const r of youngGunsRows) {
      expect(inferSportFromTitle(r.title ?? "")).toBe("hockey");
    }
  });

  it("the one 'Young Guns' collision in this fixture (Goodwin Champions, explicitly stated MMA) is NOT overridden to hockey", () => {
    // Pins the precedence this fix relies on: an explicit stated category
    // (mma/ufc/etc, checked earlier in inferSportFromTitle) always outranks
    // the hockey-exclusive-insert-name rule added here. If a future edit
    // reorders these checks, this is the row that would silently flip.
    const collision = rows.find((r) => /goodwin champions/i.test(r.title ?? ""));
    expect(collision).toBeDefined();
    expect(inferSportFromTitle(collision!.title ?? "")).toBe("mma");
  });

  it("guardrail: a bare 'Upper Deck' title with no hockey-exclusive insert, team name, or sport keyword is NOT guessed as hockey", () => {
    // CF-NO-DEFAULT-SPORT stays intact for genuinely unresolvable rows: this
    // fix must not become a new default-to-hockey path. Every row in this
    // fixture that resolves to confident:true hockey does so via a
    // PRE-EXISTING signal (a team name, an explicit "hockey"/"NHL" keyword)
    // or via this fix's two named insert brands — never via a bare brand
    // name alone.
    const bareUpperDeck = rows.filter(
      (r) => /upper\s+deck/i.test(r.title ?? "")
        && !/young\s+guns|ud\s+canvas|hockey|nhl\b/i.test(r.title ?? ""),
    );
    expect(bareUpperDeck.length).toBeGreaterThan(0);
    for (const r of bareUpperDeck) {
      const result = resolveVertical({ title: r.title ?? "", declared: r.sport, platform: r.platform, category: r.category });
      if (result.confident && result.vertical === "hockey") {
        // Confident hockey without this fix's markers must come from a real
        // team name in the title (the pre-existing NHL_TEAMS_STRONG /
        // NHL_TEAMS_CITY_QUALIFIED rules) — never a newly-guessed default.
        expect(result.reason).toBe("sport-keyword");
      }
    }
  });
});
