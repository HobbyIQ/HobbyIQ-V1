// CF-CUSTOM-TIERS (Drew, 2026-08-17: "maybe make people select their own tiers
// of what they want to own? That way they can build it their way").
//
// A user-defined tier is a NAME, a TARGET SHARE, and a set of RULES that decide
// which holdings land in it. The rules are the load-bearing half: a bucket
// without them is just a label with nothing in it, and a portfolio tool whose
// categories are empty is worse than one with opinionated defaults.
//
// FIRST MATCH WINS, IN ORDER. A holding belongs to the first tier whose rules
// all pass. That makes the tier list a priority list the user controls, which
// is the only model that stays predictable once buckets overlap — and they
// always overlap ("vintage" and "graded" both match a 1955 PSA 4). Anything
// matching no tier lands in Unassigned rather than being force-fitted, so the
// user can SEE what their rules missed instead of it being silently absorbed.
//
// EVERY PREDICATE IS OPTIONAL AND ANDED. An empty rule set matches everything,
// which makes a catch-all tier trivial to express (put it last).
//
// Deliberately NOT a general expression language. Predicates map to the facts
// this system can actually read off a holding; anything richer would invite
// rules whose data does not exist — print run is parsed from text and is
// frequently unknown, and population data is not on the holding at all.

export interface TierRule {
  /** Inclusive. Print run is PARSED from card text and is often unknown; a
   *  holding with no readable print run never satisfies a printRun predicate
   *  rather than defaulting into one. */
  printRunMax?: number;
  printRunMin?: number;
  yearMax?: number;
  yearMin?: number;
  /** true = must be graded, false = must be raw. Omitted = don't care. */
  graded?: boolean;
  isAuto?: boolean;
  /** Case-insensitive substring over setName / cardName / parallel. */
  productContains?: string;
  /** Case-insensitive substring over playerName. Works for characters too. */
  nameContains?: string;
  valueMin?: number;
  valueMax?: number;
}

export interface CustomTier {
  id: string;
  name: string;
  /** 0..1. The UI enforces a sum of 1 across tiers; the analysis does not
   *  depend on it summing, so a mid-edit state cannot break the screen. */
  targetShare: number;
  /** ALL rules must pass (AND). An empty array matches everything. */
  rules: TierRule[];
  /** Optional user note, shown under the tier name. */
  blurb?: string;
}

export const UNASSIGNED_TIER_ID = "__unassigned__";

/** Facts a rule can be evaluated against. Built once per holding by the caller
 *  so the same parse is not repeated per tier. */
export interface TierFacts {
  printRun: number | null;
  year: number | null;
  graded: boolean;
  isAuto: boolean;
  product: string;
  name: string;
  value: number;
}

function ruleMatches(rule: TierRule, f: TierFacts): boolean {
  // Print run is unknown far more often than people expect, so an unknown
  // NEVER satisfies a print-run bound. Treating unknown as "passes" would put
  // tersely described cards into a scarcity tier they may not belong in — the
  // direction that flatters a portfolio.
  if (rule.printRunMax !== undefined) {
    if (f.printRun === null || f.printRun > rule.printRunMax) return false;
  }
  if (rule.printRunMin !== undefined) {
    if (f.printRun === null || f.printRun < rule.printRunMin) return false;
  }
  if (rule.yearMax !== undefined) {
    if (f.year === null || f.year > rule.yearMax) return false;
  }
  if (rule.yearMin !== undefined) {
    if (f.year === null || f.year < rule.yearMin) return false;
  }
  if (rule.graded !== undefined && f.graded !== rule.graded) return false;
  if (rule.isAuto !== undefined && f.isAuto !== rule.isAuto) return false;
  if (rule.productContains) {
    if (!f.product.includes(rule.productContains.toLowerCase())) return false;
  }
  if (rule.nameContains) {
    if (!f.name.includes(rule.nameContains.toLowerCase())) return false;
  }
  if (rule.valueMin !== undefined && f.value < rule.valueMin) return false;
  if (rule.valueMax !== undefined && f.value > rule.valueMax) return false;
  return true;
}

/** A tier matches when ALL its rules pass. No rules = matches everything. */
export function tierMatches(tier: CustomTier, f: TierFacts): boolean {
  return tier.rules.every((r) => ruleMatches(r, f));
}

/** First tier whose rules all pass, else UNASSIGNED_TIER_ID. */
export function assignTier(tiers: CustomTier[], f: TierFacts): string {
  for (const t of tiers) if (tierMatches(t, f)) return t.id;
  return UNASSIGNED_TIER_ID;
}

/**
 * Validate a user-submitted tier set. Returns the cleaned list, or an error
 * string the API can hand straight back.
 *
 * Rejects rather than repairs where a silent repair would change meaning — a
 * tier whose target the user mistyped should come back as an error, not be
 * quietly renormalised into something they did not ask for.
 */
export function validateTiers(input: unknown): { tiers: CustomTier[] } | { error: string } {
  if (!Array.isArray(input)) return { error: "tiers must be an array" };
  if (input.length === 0) return { error: "at least one tier is required" };
  if (input.length > 12) return { error: "at most 12 tiers" };

  const seen = new Set<string>();
  const tiers: CustomTier[] = [];

  for (const raw of input) {
    if (!raw || typeof raw !== "object") return { error: "each tier must be an object" };
    const t = raw as Record<string, unknown>;
    const id = String(t.id ?? "").trim();
    const name = String(t.name ?? "").trim();
    if (!id) return { error: "each tier needs an id" };
    if (!name) return { error: `tier ${id} needs a name` };
    if (id === UNASSIGNED_TIER_ID) return { error: `${UNASSIGNED_TIER_ID} is reserved` };
    if (seen.has(id)) return { error: `duplicate tier id: ${id}` };
    seen.add(id);

    const targetShare = Number(t.targetShare);
    if (!Number.isFinite(targetShare) || targetShare < 0 || targetShare > 1) {
      return { error: `tier ${name} targetShare must be between 0 and 1` };
    }

    const rulesRaw = t.rules;
    if (rulesRaw !== undefined && !Array.isArray(rulesRaw)) {
      return { error: `tier ${name} rules must be an array` };
    }
    const rules: TierRule[] = [];
    for (const rr of (rulesRaw as unknown[]) ?? []) {
      if (!rr || typeof rr !== "object") return { error: `tier ${name} has a malformed rule` };
      const r = rr as Record<string, unknown>;
      const rule: TierRule = {};
      const num = (k: keyof TierRule) => {
        const v = r[k as string];
        if (v === undefined || v === null || v === "") return true;
        const n = Number(v);
        if (!Number.isFinite(n)) return false;
        (rule as Record<string, unknown>)[k as string] = n;
        return true;
      };
      for (const k of ["printRunMax", "printRunMin", "yearMax", "yearMin", "valueMin", "valueMax"] as const) {
        if (!num(k)) return { error: `tier ${name}: ${k} must be a number` };
      }
      for (const k of ["graded", "isAuto"] as const) {
        if (typeof r[k] === "boolean") rule[k] = r[k] as boolean;
      }
      for (const k of ["productContains", "nameContains"] as const) {
        const v = r[k];
        if (typeof v === "string" && v.trim()) rule[k] = v.trim();
      }
      rules.push(rule);
    }

    const blurb = typeof t.blurb === "string" ? t.blurb.trim().slice(0, 200) : undefined;
    tiers.push({ id, name: name.slice(0, 60), targetShare, rules, ...(blurb ? { blurb } : {}) });
  }

  const total = tiers.reduce((s, t) => s + t.targetShare, 0);
  // Tolerance covers ordinary rounding from a percentage UI (four 25% inputs
  // stored as 0.25 each). A real mistake still fails.
  if (Math.abs(total - 1) > 0.02) {
    return { error: `targets must total 100% (currently ${Math.round(total * 100)}%)` };
  }

  return { tiers };
}

/** The HobbyIQ defaults, expressed AS custom tiers.
 *
 *  Shipping the defaults through the same rule engine the user edits means
 *  there is no privileged built-in path that behaves differently from a
 *  hand-made one — "reset to defaults" lands on something the user could have
 *  written themselves, and can then tweak. It also means the default mix is
 *  reviewable as data rather than buried in a switch.
 *
 *  ORDER MATTERS: supply first, then player, mirroring the built-in precedence.
 */
export function defaultTiers(): CustomTier[] {
  return [
    {
      id: "true-scarcity",
      name: "True Scarcity",
      blurb: "Vintage, low serial numbers, low pop — supply that is genuinely constrained",
      targetShare: 0.30,
      rules: [{ printRunMax: 25 }],
    },
    {
      id: "vintage",
      name: "Vintage",
      blurb: "Pre-1980, where supply is fixed and only survivorship varies",
      targetShare: 0.10,
      rules: [{ yearMax: 1979 }],
    },
    {
      id: "emerging-upside",
      name: "Emerging Upside",
      blurb: "Unproven but high-quality positions taken early",
      targetShare: 0.20,
      rules: [{ printRunMax: 499 }],
    },
    {
      id: "established-icons",
      name: "Established Icons",
      blurb: "Proven names and characters with durable collector demand",
      targetShare: 0.30,
      rules: [{ graded: true }],
    },
    {
      id: "speculation",
      name: "Speculation",
      blurb: "Everything else — momentum plays and cards held to resell",
      targetShare: 0.10,
      rules: [],           // catch-all, last on purpose
    },
  ];
}
