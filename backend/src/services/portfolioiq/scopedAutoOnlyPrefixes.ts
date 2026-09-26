// CF-SCOPED-AUTO-ONLY-PREFIXES (stamp-fix batch 2, 2026-09-26, review round 2).
//
// THE ONE TABLE. Originally this data was written twice -- once inside
// parseTitleIdentity.service.ts's SCOPED_AUTO_PREFIX and once inside
// hobbyIqCardId.service.ts's SCOPED_AUTO_ONLY_CARDNUMBER_PREFIX -- because
// parseTitleIdentity.service.ts imports `slugify` FROM hobbyIqCardId.service.ts,
// so neither file could import a table defined in the other without a cycle.
// Review flagged the duplication: nothing pinned the two copies equal, so the
// next person to add a scoped prefix to one and forget the other would ship a
// silent drift no test would catch.
//
// THE FIX IS A THIRD FILE WITH NO IMPORTS. Plain data (a Map literal) and one
// pure lookup function, zero dependencies -- so BOTH services import this one
// module instead of each other, and the cycle this table exists to route
// around never had anywhere to start. One update site, by construction.
//
// Keys are `${sport}|${year}|${setKey}` with setKey as normalizeSetKey /
// computeHobbyIqCardId spell it. See the individual entries below for
// per-product provenance -- do not delete an entry's comment when adding a
// sibling; the provenance is what the next reviewer checks against a fresh
// source read, not a bare letter combination.
export const SCOPED_AUTO_ONLY_PREFIXES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // 2025 Topps Chrome Update Series -- Autographs, Rookie Debut Autographs,
  // Chromeography, Chrome Legends Autographs. Source: checklistcenter /
  // baseballcardpedia product-page autograph sections, confirmed 2026-09-21.
  ["baseball|2025|topps-chrome-update-series", new Set(["AC-", "CRDA-", "CHRU-", "CLA-"])],
  // 2025 Topps Series 1/2 (+ Update, folded into "topps") -- Baseball Stars
  // Autographs S2, City Connect Swatch Collection Autograph Relics S2, World
  // Champion Dual Autographs, First Pitch/Finest Personality Autographs,
  // 1990 Topps Autographs, 1990 Chrome All-Stars Autographs. Source:
  // checklistcenter / beckett-scraped product-page autograph sections,
  // confirmed 2026-09-21.
  ["baseball|2025|topps", new Set(["BSA2-", "CCA2-", "WCDA-", "FPA-", "90AU-", "90CAS-"])],
  // 2026 Bowman Mega Box -- Bowman Mega Autographs, Rookie Mega Autographs.
  // CF-R75-BOWMAN-MEGA-BOX-SPLIT (hobbyIqCardId.service.ts): from 2026 a
  // title reading "Bowman Mega Box" WITHOUT "chrome" resolves to the distinct
  // `bowman-mega` key, not `bowman-chrome-mega-box` -- confirmed against real
  // sold_comps rows (e.g. "2026 Bowman Mega Box Baseball #BMA-KW Base" ->
  // hiq:baseball:2026:bowman-mega:bma-kw:...), where `bowman-mega` carries
  // the overwhelming majority of 2026 BMA-/RMA- rows (1,777 / 242) and the
  // identical defective-source split (no-auto only from
  // checklistinsider-2026-08-27; auto from checklistinsider-2026-09-21 /
  // beckett-s3-2026-09-19). Source: checklistcenter / beckett-checklist
  // product-page autograph sections, confirmed 2026-09-21.
  ["baseball|2026|bowman-mega", new Set(["BMA-", "RMA-"])],
  // 2026 Bowman CHROME Mega Box -- a DIFFERENT product sharing the same
  // BMA-/RMA- numbering convention (different roster at the same numbers,
  // per R75). Verified separately: 119 (BMA-) / 30 (RMA-) strict :auto rows
  // from beckett-scraped-2026-08-13 / ingest-auto-seed, ZERO no-auto rows
  // from any source under this exact setKey+year. Kept as its own entry.
  ["baseball|2026|bowman-chrome-mega-box", new Set(["BMA-", "RMA-"])],
  // 2026 Topps Chrome Black -- Ivory Autographs. Source: checklistinsider
  // 2026-09-21 / checklistcenter product-page autograph section.
  ["baseball|2026|topps-chrome-black", new Set(["IVA-"])],
  // 2025 Panini Prizm (base flagship) -- Sensational Signatures, a
  // same-numbered AUTOGRAPH-ONLY insert. AUTO_SETNAME_RE (in
  // parseTitleIdentity.service.ts) already recognizes the phrase
  // "sensational signatures" in title TEXT, but most real sale titles are
  // generic vendor listings ("#SS-JW Base") that never say the insert name,
  // so the cardNumber prefix has to carry the signal too.
  //
  // Scoped, not global: "SS-" is a card-number-INITIALS token with no auto
  // meaning on OTHER products -- e.g. "2020 Panini Prizm Basketball
  // #SS-AEW Base" (wrestling initials; see inferSportFromTitle's own
  // comment on this exact card) -- a global add would mislabel every one
  // of those.
  //
  // Evidence: C:/tmp/prizm_ss_trace_1422/RESULT.md, 2026-09-26 -- 7,058
  // sold_comps rows under `hiq:baseball:2025:panini-prizm:ss-*`, 86% stored
  // isAuto=false while checklist rows for the same cardNumber+parallel are
  // already :auto (SS-JL, SS-HK, SS-JG, SS-CK, SS-CE, etc.).
  ["baseball|2025|panini-prizm", new Set(["SS-"])],
]);

/** Additive-only lookup: a miss (unscoped call, or a (sport, year, setKey)
 *  not in the table) always reads false, so this can only ADD a positive on
 *  top of a caller's own global rule, never remove one. Case/hyphen
 *  insensitive on the cardNumber, matching the global rules' own convention. */
export function isScopedAutoOnlyPrefix(
  cardNumber: string | null | undefined,
  scope?: { sport?: string | null; year?: number | null; setKey?: string | null } | null,
): boolean {
  if (!cardNumber || !scope) return false;
  const sport = String(scope.sport ?? "").toLowerCase().trim();
  const year = scope.year;
  const setKey = String(scope.setKey ?? "").toLowerCase().trim();
  if (!sport || !year || !setKey) return false;
  const prefixes = SCOPED_AUTO_ONLY_PREFIXES.get(`${sport}|${year}|${setKey}`);
  if (!prefixes) return false;
  const cn = String(cardNumber).toUpperCase().replace(/^#/, "");
  for (const p of prefixes) {
    if (cn.startsWith(p)) return true;
  }
  return false;
}
