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
};

const GRADE_COMPANY_SYNONYMS: Record<string, string[]> = {
  PSA: ["psa", "professional sports authenticator"],
  BGS: ["bgs", "beckett", "beckett grading"],
  SGC: ["sgc", "sportscard guaranty", "sportscard guaranty corporation"],
  CGC: ["cgc", "cgc cards", "certified guaranty"],
  RAW: ["raw", "ungraded"],
};

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
  };
}
