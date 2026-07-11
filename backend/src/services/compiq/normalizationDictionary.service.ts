const PARALLEL_SYNONYMS: Record<string, string[]> = {
  base: ["base", "paper", "standard"],
  refractor: ["refractor", "ref", "silver refractor"],
  prism_silver: ["silver", "silver prizm", "prizm silver", "prism silver"],
  raywave_blue: ["blue raywave", "blue wave", "raywave blue"],
  mojo: ["mojo", "mega box mojo", "mojo refractor"],
  gold: ["gold", "gold refractor", "gold /50"],
  orange: ["orange", "orange refractor", "orange /25"],
  red: ["red", "red refractor", "red /5"],
  superfractor: ["superfractor", "super", "1/1", "one of one"],
  // CF-GUM-BALL-BUBBLEGUM (2026-07-08, Drew): CH catalogs the Bowman
  // Draft Chrome retail-exclusive "snackpack" parallel as "Gum Ball
  // Refractor" (or just "Gum Ball" on the auto version). Users search
  // for it as "bubblegum" or "bubble gum" (hobby vernacular). Canonical
  // key is "gum ball" (space, no underscore) so the returned token is
  // CH-friendly downstream — the cardTitle constructor uses this
  // string directly against CH's fuzzy search.
  "gum ball": ["gum ball", "bubblegum", "bubble gum", "snackpack", "snack pack"],
};

const GRADE_COMPANY_SYNONYMS: Record<string, string[]> = {
  PSA: ["psa", "professional sports authenticator"],
  BGS: ["bgs", "beckett", "beckett grading"],
  SGC: ["sgc", "sportscard guaranty", "sportscard guaranty corporation"],
  CGC: ["cgc", "cgc cards", "certified guaranty"],
  RAW: ["raw", "ungraded"],
};

/**
 * CF-SET-NAME-SYNONYMS (2026-07-08, Drew): hobby shorthand → canonical
 * CH set names. Users type "BDC" for Bowman Draft Chrome, "BCP" for
 * Bowman Chrome Prospects, etc. Without normalization, CH's fuzzy
 * search picks up the token literally and returns junk. Canonical
 * value here is the CH-friendly product name so downstream cardTitle
 * construction hits CH's actual index. Alias matching is
 * case-insensitive; whole-token, so "BDC" matches but "BDCs" doesn't.
 */
const SET_NAME_SYNONYMS: Record<string, string[]> = {
  "bowman draft chrome": ["bdc", "bowman draft chrome", "bowman draft chr"],
  "bowman draft": ["bd", "bowman draft"],
  "bowman draft sapphire": ["bds", "bowman draft sapphire", "bowman draft saph"],
  "bowman chrome prospects": ["bcp", "bowman chrome prospects", "bowman chr prospects"],
  "bowman chrome": ["bc", "bowman chrome", "bow chrome"],
  "bowman sterling": ["bstg", "bowman sterling"],
  "bowman sapphire": ["bsapph", "bowman sapphire"],
  "bowmans best": ["bb", "bowman's best", "bowmans best", "bowman best"],
  "topps chrome": ["tc", "topps chrome"],
  "topps chrome update": ["tcu", "topps chrome update", "topps update chrome"],
  "topps update": ["tu", "topps update"],
  "topps chrome sapphire": ["tcs", "topps chrome sapphire"],
  "topps finest": ["tf", "topps finest"],
  "topps tribute": ["tt", "topps tribute"],
  "topps heritage": ["th", "topps heritage"],
  "topps stadium club": ["tsc", "topps stadium club", "stadium club"],
  "panini prizm": ["pp", "panini prizm", "prizm"],
  "panini prizm draft picks": ["ppdp", "prizm draft picks", "prizm draft"],
  "panini select": ["ps", "panini select", "select"],
  "panini mosaic": ["pm", "panini mosaic", "mosaic"],
  "panini donruss": ["pdon", "panini donruss", "donruss"],
  "donruss optic": ["do", "donruss optic", "optic"],
  // CF-NO-NULL-PRICING FOLLOWUP (2026-07-11): modern Panini SetDocs — the
  // reference-catalog carries these but SET_NAME_SYNONYMS didn't. Adding
  // both the "panini X" and bare "X" aliases so parser normalization,
  // CH resolution, and cardsearch matcher all see the same canonical.
  "panini origins": ["porig", "panini origins", "origins"],
  "panini absolute": ["pabs", "panini absolute", "absolute"],
  "panini playbook": ["pplay", "panini playbook", "playbook"],
  "panini three and two": ["ptat", "panini three and two", "three and two"],
  "panini prospect edition": ["ppe", "panini prospect edition", "prospect edition"],
  "panini chronicles": ["pc", "panini chronicles", "chronicles"],
  "panini diamond kings": ["pdk", "panini diamond kings", "diamond kings"],
  "panini immaculate": ["pim", "panini immaculate", "immaculate"],
  "panini impeccable": ["pimp", "panini impeccable", "impeccable"],
  "panini contenders": ["pcnt", "panini contenders", "contenders"],
  "panini national treasures": ["pnt", "panini national treasures", "national treasures"],
  "panini flawless": ["pfl", "panini flawless", "flawless"],
  "panini usa baseball stars & stripes": ["pusa", "panini usa baseball", "stars and stripes"],
};

/**
 * Normalize a set/product token. Preserves original when no synonym
 * matches so downstream layers can still handle unusual set names.
 * Only expands SHORT tokens (<=8 chars, no spaces) as the shorthand
 * ambiguity risk grows with token length — "TC" is TopsChrome, "topps
 * chrome sapphire" needs no shortening.
 */
export function normalizeSetName(set?: string): string | undefined {
  if (!set) return undefined;
  const key = normalizeToken(set);
  if (!key) return undefined;

  // Exact match first (canonical returned as-is).
  for (const [canonical, aliases] of Object.entries(SET_NAME_SYNONYMS)) {
    if (aliases.some((alias) => normalizeToken(alias) === key)) {
      return canonical;
    }
  }

  // No match → return the trimmed lowercase input verbatim so
  // downstream CH search still runs on the raw string. Never null.
  return set.trim();
}

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeParallel(parallel?: string): string | undefined {
  if (!parallel) return undefined;
  const key = normalizeToken(parallel);
  if (!key) return undefined;

  // Exact alias match → collapse to canonical (e.g. "ref" → "refractor").
  for (const [canonical, aliases] of Object.entries(PARALLEL_SYNONYMS)) {
    if (aliases.some((alias) => normalizeToken(alias) === key)) {
      return canonical;
    }
  }

  // Fuzzy "includes" collapse is ONLY safe for single-token inputs.
  // Multi-token inputs like "blue refractor auto" carry distinguishing
  // color/auto/serial information that must be preserved for the downstream
  // parallel filter — collapsing to just "refractor" would let base
  // refractors flood the comp pool and crater the FMV.
  const tokens = key.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    for (const [canonical, aliases] of Object.entries(PARALLEL_SYNONYMS)) {
      if (aliases.some((alias) => key.includes(normalizeToken(alias)))) {
        return canonical;
      }
    }
  }

  return key;
}

export function normalizeGradeCompany(company?: string): string | undefined {
  if (!company) return undefined;
  const key = normalizeToken(company);
  if (!key) return undefined;

  for (const [canonical, aliases] of Object.entries(GRADE_COMPANY_SYNONYMS)) {
    if (aliases.some((alias) => normalizeToken(alias) === key)) {
      return canonical;
    }
  }

  for (const [canonical, aliases] of Object.entries(GRADE_COMPANY_SYNONYMS)) {
    if (aliases.some((alias) => key.includes(normalizeToken(alias)))) {
      return canonical;
    }
  }

  return company.trim().toUpperCase();
}

export function getNormalizationDictionary() {
  return {
    parallel: PARALLEL_SYNONYMS,
    gradeCompanies: GRADE_COMPANY_SYNONYMS,
    setNames: SET_NAME_SYNONYMS,
  };
}
