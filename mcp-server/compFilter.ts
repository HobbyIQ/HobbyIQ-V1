// Comp filtering for the MCP /predict path.
//
// Extracted from server.ts (CF-MCP-CARDNUMBER-ISOLATION, 2026-06-27) so the
// pure filtering logic is unit-testable without booting the Express server or
// loading the Application Insights / OpenAI runtimes that server.ts pulls in
// at import time. server.ts re-imports `filterCompsForCard` from here.
//
// Only the CardComp TYPE is imported (import type) so pricing.ts's
// module-load-time OpenAI client construction is never triggered.

import type { CardComp } from "./pricing.js";

// The comp pool fetched from /api/compiq/comps-by-player spans a whole
// player+product (every base prospect, parallel, and autograph), plus stray
// off-set noise. Hard-filter on title tokens before pricing so we never
// anchor on something like a $5 reprint of a $300 rookie.
//
// Rule: title must contain (a) the year, AND (b) at least one player
// surname token (≥3 chars). If a setName is provided, also require at
// least one set token. If the filtered set drops below 5 comps OR below
// 30% of the original, fall back to the unfiltered set so a sparse market
// doesn't get zeroed out.
//
// CF-MCP-CONDITION-EXCLUSION (2026-06-27): also drop condition-flawed comps
// (damaged, creased, altered, trimmed, water damage, "as-is", "read
// description", poor condition). A flawed copy sells far below a clean one,
// so leaving these in the pool drags the anchor median down and mis-low-
// prices the user's presumed-clean card. Graded condition is handled by the
// grade tier upstream.
//
// CF-MCP-CARDNUMBER-ISOLATION (2026-06-27): when a cardNumber is supplied,
// apply an AUTHORITATIVE second stage that keeps only titles containing the
// normalized card number (e.g. "CPA-EHA"). A single player+set+year can span
// dozens of distinct cards — base prospects, colored parallels, autographs —
// whose prices differ by 10-50x. Without card-number isolation the anchor
// median collapses onto whichever card sells most by COUNT (usually the cheap
// base prospect), mispricing a $125 auto as a $10 base. (Witnessed 2026-06-27:
// 2026 Eric Hartman base auto priced at $39 because all 268 player comps —
// dominated by $1-10 BCP-102 base prospects — were blended into one anchor.)
// The card-number stage deliberately BYPASSES the 30% ratio fallback below: a
// precise card-number match is authoritative, not heuristic, so isolating 51
// of 268 player comps is the intended outcome, not an over-filter to revert.
export function filterCompsForCard(
  comps: CardComp[],
  playerName: string,
  year: number,
  setName: string,
  cardNumber?: string,
): CardComp[] {
  if (!comps.length) return comps;

  const yearStr = String(year);
  const playerTokens = playerName
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  const setTokens = setName
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3 && t !== "the");

  const filtered = comps.filter((c) => {
    const title = (c.title ?? "").toLowerCase();
    if (!title) return false;
    if (!title.includes(yearStr)) return false;
    const hasPlayer = playerTokens.some((t) => title.includes(t));
    if (!hasPlayer) return false;
    if (setTokens.length) {
      const hasSet = setTokens.some((t) => title.includes(t));
      if (!hasSet) return false;
    }
    // Drop obvious reprint/non-original-card noise.
    if (/(reprint|custom|shoebox|aceo|art card|fan made|fan-made)/i.test(title)) {
      return false;
    }
    // CF-MCP-CONDITION-EXCLUSION (2026-06-27): drop damaged / altered /
    // "read description" comps. A creased, trimmed, water-damaged, or
    // "as-is" card sells for a fraction of a clean copy, so leaving these in
    // the pool drags the anchor median DOWN and mis-low-prices the user's
    // (presumed-clean) card. Conservative term list — only unambiguous flaw
    // indicators, and "read"/"please read" only as multi-word phrases so a
    // stray "read" in a player/set name can't false-match. Graded condition
    // is handled by the grade tier upstream, so these raw-flaw words rarely
    // appear in legit graded titles.
    if (
      /(damaged|crease[ds]?|\baltered\b|trimmed|miscut|mis-cut|water[\s-]?damage|ripped|\btorn\b|stain(?:ed|s)?|writing on|marker|\bdmg\b|\bas[\s-]?is\b|read desc|please read|read before|read the desc|poor condition)/i.test(
        title,
      )
    ) {
      return false;
    }
    return true;
  });

  // Card-number isolation (authoritative). Normalize both the supplied number
  // and each title to bare alphanumerics so "CPA-EHA", "#CPA-EHA" and
  // "CPA EHA" all collapse to "cpaeha" and match. Requires ≥3 normalized
  // chars (skip trivial/blank numbers) and ≥3 surviving comps (a lone fluke
  // title must not anchor the price). When satisfied, returns the
  // card-number-matched set REGARDLESS of the 30% ratio rule below.
  const normNum = (cardNumber ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normNum.length >= 3) {
    const byNumber = filtered.filter((c) => {
      const t = (c.title ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
      return t.includes(normNum);
    });
    if (byNumber.length >= 3) {
      return byNumber;
    }
  }

  if (filtered.length >= 5 && filtered.length >= comps.length * 0.3) {
    return filtered;
  }
  return comps;
}
