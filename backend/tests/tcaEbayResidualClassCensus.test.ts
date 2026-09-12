// CF-A-RESIDUAL-CLASS-CENSUS (2026-09-12). Follow-up to #2084 (the TCA eBay
// write-rate collapse fix). #2084 measured a live 100-row 2026-09-10 sample
// and fixed the largest single pattern it found (Young Guns / UD Canvas
// hockey inserts with no team name or sport word). This PR's task was to
// take a wider 1,000-row live sample of the same day, classify every row
// through the SAME title-only path, and tabulate the residual skip classes
// by fixable pattern — per the task brief, ranked and fixed only where a
// fix does not require guessing.
//
// CENSUS RESULT on this exact 1,000-row fixture, current code (post-#2084,
// pre this PR):
//   wouldResolve         493 (49.3%)
//   sportUnresolved       325 (32.5%) — dominated by:
//     - 147 rows: 2025 Panini Select football rookies, player name is the
//       ONLY signal (Cam Skattebo, Jaxson Dart, Tyler Shough, Cam Ward...) —
//       not fixable without either (a) hand-adding every 2025 draft-class
//       name to PLAYER_SPORT_HINTS (an open-ended, high-maintenance list the
//       existing curated table deliberately avoids), or (b) a checklist-
//       backed player-index lookup bounded to the stated year+product (the
//       kind of lookup #2064's sibling-checklist rule does, on a branch not
//       merged to main per the task brief) — LEFT AS BACKLOG.
//     - 55 rows: modern (2025-26) Upper Deck Hockey titles naming an insert
//       line (Encore, SP Authentic, Ultimate Collection, Black Diamond,
//       Allure, O-Pee-Chee, SPX...) this repo's vocabulary doesn't know.
//       Every one of these names is ALSO a historically cross-sport Upper
//       Deck brand (SP Authentic prints baseball/basketball/football/golf;
//       O-Pee-Chee printed baseball/basketball; even "Encore" — the
//       single name that looked safest — turned out to have shipped as a
//       multi-sport line circa 1999-2001: `splitIdentitySportSegmentTranche2
//       .test.ts` already carries a checklist-backed BASEBALL ruling for
//       "2000 Upper Deck Encore #254 Tom Brady", which an unresearched
//       "Encore == hockey" rule would have re-flipped). None of these names
//       were added here — LEFT AS BACKLOG, one per-name historical check at
//       a time, same rigor #2084 used for Young Guns / UD Canvas.
//   noPlayer              182 (18.2%) — dominated by:
//     - ~45 rows: hobby-box/lot/case/break listings with no single card and
//       genuinely no player — correctly unresolved, not a defect.
//     - ~14+ rows: a distinct, FIXED-HERE parser bug — see below.
//
// THE FIX (small, mechanical, zero guessing): "UD" is Upper Deck's own
// shorthand for its own insert names ("UD Canvas", "UD Exclusives", "UD
// Update") and was never in cardQueryParser's NOISE list. It survived the
// residue strip as a bare 2-letter token, and playerSegmentIsAPerson's
// trailing-token length check then refused the WHOLE player name over that
// one stray token — not just the token. Real, already-stated player names
// ("Tyler Seguin", "Connor Bedard", "Kaapo Kakko") were lost entirely on
// titles like "C-206 Tyler Seguin UD Canvas 2025-26 Upper Deck". Adding "ud"
// to NOISE fixes it structurally (same mechanism as the existing "canvas" /
// "spx" entries) rather than by pattern-matching each title shape.
//
// A second, smaller leak surfaced ONCE the above fix let previously-
// unreachable rows fall through to the player-name gate: "Encore" itself was
// also never in NOISE, so "Timo Meier Encore 2025-26 Upper Deck" resolved a
// player name of "Timo Meier Encore" — the insert-line name stitched onto a
// real player. This never showed up before because #2084's own fix, and this
// one, only fixed WHICH rows reach the player-name stage; a wrong player
// name reaching sold_comps is worse than the row staying unresolved, so
// "encore" is stripped as NOISE too. (Note: since the Encore rows in this
// fixture stay sportUnresolved per the backlog above, this second fix has no
// effect on the fixture's wouldResolve count today — it is here so that
// whichever future PR safely adds "Encore" to inferSportFromTitle inherits a
// clean player name instead of a fresh defect.)
//
// MEASURED RECOVERY, this exact 1,000-row fixture:
//   before this PR (post-#2084 code): 493/1000 (49.3%) wouldResolve
//   after this PR:                    497/1000 (49.7%) wouldResolve
//
// MEASURED ON #2084's OWN 100-ROW FIXTURE (must not regress):
//   before this PR (post-#2084 code): 35/100 (35%) wouldResolve
//   after this PR:                    39/100 (39%) wouldResolve
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
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

function loadFixture(name: string): TcaFixtureRow[] {
  const raw = readFileSync(join(__dirname, "fixtures", name), "utf8");
  return (JSON.parse(raw).data as TcaFixtureRow[]);
}

// Identical to tcaEbayWriteRateRegression.test.ts's classify() — reused
// verbatim (not reimplemented) so both tests measure the exact same path.
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

describe("TCA eBay residual-class census — 1,000-row 09-10 fixture", () => {
  const rows = loadFixture("tcaEbay0910Sample1000.json");

  it("fixture has 1,000 real eBay rows with zero structured TCA hints", () => {
    expect(rows.length).toBe(1000);
    const withAnyHint = rows.filter((r) => r.player || r.year || r.sport || r.card_set || r.card_number);
    expect(withAnyHint.length).toBe(0);
  });

  it("current code resolves a nonzero, non-collapsing share of the 1,000-row fixture", () => {
    const outcomes = rows.map(classify);
    const wouldResolve = outcomes.filter((o) => o === "wouldResolve").length;
    // Pin, not a target: measured on this exact fixture after this PR's "ud"/
    // "encore" NOISE fix. Was 493 before this PR (still resolvable via the
    // #2084 test's own floor); this floor is specific to the code in THIS
    // PR. A future change that drops below it on this fixture has regressed
    // either #2084's sport-inference fix or this PR's player-name fix.
    expect(wouldResolve).toBeGreaterThanOrEqual(497);
  });

  it("'UD Canvas' / 'UD Exclusives' titles with a leading or trailing card-number token keep their stated player", () => {
    const udRows = rows.filter((r) => /\bUD\s+(canvas|exclusives|update)\b/i.test(r.title ?? ""));
    expect(udRows.length).toBeGreaterThan(0);
    for (const r of udRows) {
      const p = parseCardQuery(r.title ?? "");
      // Every row in this bucket names a real player in the title text, so a
      // null playerName here means the "UD" abbreviation ate it again.
      expect(p.playerName).not.toBeNull();
    }
  });

  it("bare 'UD' does not swallow the whole player name in a title with no Canvas/Exclusives insert word either", () => {
    const p = parseCardQuery("Tyler Seguin UD 2025-26 Upper Deck");
    expect(p.playerName).toBe("Tyler Seguin");
  });

  it("guardrail: an 'Encore' row with no OTHER hockey signal stays sportUnresolved (no un-researched sport guess was added)", () => {
    // "Jack Hughes" is excluded here: he is already a pre-existing, curated
    // entry in PLAYER_SPORT_HINTS (unrelated to this PR), so his Encore row
    // legitimately resolves via the full-name hint, not via any Encore rule.
    // The point of this guardrail is the OTHER Encore rows, which carry no
    // team name and no PLAYER_SPORT_HINTS entry — those must stay unresolved.
    const encoreRows = rows.filter(
      (r) => /\bencore\b/i.test(r.title ?? "") && !/jack\s+hughes/i.test(r.title ?? ""),
    );
    expect(encoreRows.length).toBeGreaterThan(0);
    for (const r of encoreRows) {
      const outcome = classify(r);
      // Without a stated-product rule for "Encore" (deliberately not added —
      // see the file header: it collides with a real 2000-era multi-sport
      // Encore ruling) these rows must stay sportUnresolved, not silently
      // resolve to hockey.
      expect(outcome).toBe("sportUnresolved");
    }
  });

  it("guardrail: an 'Encore' player name never carries the insert-line word, if it ever does resolve", () => {
    // Belt-and-suspenders for the day someone DOES add a researched, gated
    // "Encore" sport rule: the player-name leak this PR fixed must stay fixed
    // regardless of which gate decides the vertical.
    const p = parseCardQuery("E-18 Timo Meier Encore 2025-26 Upper Deck");
    expect(p.playerName).toBe("Timo Meier");
  });

  it("does not regress #2084's own 100-row fixture floor", () => {
    const fixture100 = loadFixture("tcaEbay0910Sample100.json");
    const outcomes = fixture100.map(classify);
    const wouldResolve = outcomes.filter((o) => o === "wouldResolve").length;
    // #2084's pin was >= 30. This PR measured 39/100 after its own fix —
    // still comfortably above the original floor.
    expect(wouldResolve).toBeGreaterThanOrEqual(30);
  });
});
