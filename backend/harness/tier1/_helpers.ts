/**
 * Tier 1 production-data harness — shared utilities.
 *
 * These tests hit the LIVE Azure App Service production endpoints by
 * design. They are gated behind the `HOBBYIQ_TIER1=1` env var (or
 * passing `--mode tier1`) so the default `vitest run` / `npm test`
 * never silently fires real HTTP requests.
 *
 * Layer A: targeted assertions on known properties of each case.
 * Layer B: snapshot diff vs the baseline JSON captured under
 *          backend/harness/tier1/baselines/<case-id>.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TIER1_ROOT = __dirname;
export const BASELINE_DIR = path.join(TIER1_ROOT, "baselines");

export const API_BASE =
  process.env.HOBBYIQ_API_BASE ??
  "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net";

/** Tier 1 only runs when explicitly enabled. */
export const TIER1_ENABLED =
  process.env.HOBBYIQ_TIER1 === "1" ||
  process.env.RUN_TIER1 === "1" ||
  process.env.npm_lifecycle_event === "test:harness:tier1";

/** Per-case wall-clock budget (Tier 1 spec). */
export const CASE_BUDGET_MS = 30_000;

// ---------------------------------------------------------------------------
// Test case definitions
// ---------------------------------------------------------------------------

export type CaseCategory =
  | "real-lookup"
  | "popular-baseline"
  | "vintage"
  | "non-baseball"
  | "pinned-id-hard";

export type CaseGrade = "Raw" | "PSA 8" | "PSA 9" | "PSA 10";
export type CaseSport = "MLB" | "NBA" | "NFL";

export interface TestCase {
  id: string;
  query: string;
  grade: CaseGrade;
  sport: CaseSport;
  category: CaseCategory;
  /** GitHub issue numbers gating soft assertions on this case. */
  blockedBy?: number[];
  /** When set, both grade variants of this card test as a pair. */
  gradePair?: string;
  baselineFile: string;
}

/** All 25 cases. Order matches cases.json. */
export const CASES: TestCase[] = [
  // ── real-lookup (cases 1-11) ───────────────────────────────────────────
  {
    id: "case-01-jacob-wilson-2023-bowman-draft-green-refractor-auto-psa10",
    query: "2023 Bowman Draft Green Refractor Auto Jacob Wilson PSA 10",
    grade: "PSA 10",
    sport: "MLB",
    category: "real-lookup",
    // Re-added 2026-05-15: PR #12 grade-token-stripping fix is correct in
    // scope but does not resolve the customer-visible variant-mismatch in
    // production. See issue #6 for full diagnosis. Will be removed when
    // issue #13 + companion cardMatchesTokens strengthening ships.
    blockedBy: [6],
    baselineFile: "case-01-jacob-wilson-2023-bowman-draft-green-refractor-auto-psa10.json",
  },
  {
    id: "case-02-leo-de-vries-2024-bowman-chrome-blue-raywave-auto-psa10",
    query: "2024 Bowman Chrome Blue Raywave Auto Leo De Vries PSA 10",
    grade: "PSA 10",
    sport: "MLB",
    category: "real-lookup",
    baselineFile: "case-02-leo-de-vries-2024-bowman-chrome-blue-raywave-auto-psa10.json",
  },
  {
    id: "case-03-gage-wood-2025-bowman-draft-chrome-gold-auto-psa9",
    query: "2025 Bowman Draft Chrome Gold Auto Gage Wood PSA 9",
    grade: "PSA 9",
    sport: "MLB",
    category: "real-lookup",
    baselineFile: "case-03-gage-wood-2025-bowman-draft-chrome-gold-auto-psa9.json",
  },
  {
    id: "case-04a-nick-kurtz-2024-bowman-draft-chrome-refractor-auto-raw",
    query: "2024 Bowman Draft Chrome Refractor Auto Nick Kurtz",
    grade: "Raw",
    sport: "MLB",
    category: "real-lookup",
    gradePair: "case-04",
    baselineFile: "case-04a-nick-kurtz-2024-bowman-draft-chrome-refractor-auto-raw.json",
  },
  {
    id: "case-04b-nick-kurtz-2024-bowman-draft-chrome-refractor-auto-psa10",
    query: "2024 Bowman Draft Chrome Refractor Auto Nick Kurtz PSA 10",
    grade: "PSA 10",
    sport: "MLB",
    category: "real-lookup",
    // Re-added 2026-05-15: PR #12 grade-token-stripping fix is correct in
    // scope but does not resolve the customer-visible variant-mismatch in
    // production. See issue #6 for full diagnosis. Will be removed when
    // issue #13 + companion cardMatchesTokens strengthening ships.
    blockedBy: [6],
    gradePair: "case-04",
    baselineFile: "case-04b-nick-kurtz-2024-bowman-draft-chrome-refractor-auto-psa10.json",
  },
  {
    id: "case-05-shohei-ohtani-2025-topps-transcendent-25-auto-raw",
    query: "2025 Topps Transcendent Auto Shohei Ohtani /25",
    grade: "Raw",
    sport: "MLB",
    category: "real-lookup",
    baselineFile: "case-05-shohei-ohtani-2025-topps-transcendent-25-auto-raw.json",
  },
  {
    id: "case-06a-caden-bodine-2024-bowman-draft-chrome-x-fractor-auto-raw",
    query: "2024 Bowman Draft Chrome X-Fractor Auto Caden Bodine",
    grade: "Raw",
    sport: "MLB",
    category: "real-lookup",
    gradePair: "case-06",
    baselineFile: "case-06a-caden-bodine-2024-bowman-draft-chrome-x-fractor-auto-raw.json",
  },
  {
    id: "case-06b-caden-bodine-2024-bowman-draft-chrome-x-fractor-auto-psa10",
    query: "2024 Bowman Draft Chrome X-Fractor Auto Caden Bodine PSA 10",
    grade: "PSA 10",
    sport: "MLB",
    category: "real-lookup",
    gradePair: "case-06",
    baselineFile: "case-06b-caden-bodine-2024-bowman-draft-chrome-x-fractor-auto-psa10.json",
  },
  {
    id: "case-07-josiah-hartshorn-2025-bowman-draft-chrome-red-lava-auto-psa9",
    query: "2025 Bowman Draft Chrome Red Lava Auto Josiah Hartshorn PSA 9",
    grade: "PSA 9",
    sport: "MLB",
    category: "real-lookup",
    baselineFile: "case-07-josiah-hartshorn-2025-bowman-draft-chrome-red-lava-auto-psa9.json",
  },
  {
    id: "case-08a-josh-hammond-2025-bowman-draft-chrome-blue-auto-raw",
    query: "2025 Bowman Draft Chrome Blue Auto Josh Hammond",
    grade: "Raw",
    sport: "MLB",
    category: "real-lookup",
    gradePair: "case-08",
    baselineFile: "case-08a-josh-hammond-2025-bowman-draft-chrome-blue-auto-raw.json",
  },
  {
    id: "case-08b-josh-hammond-2025-bowman-draft-chrome-blue-auto-psa10",
    query: "2025 Bowman Draft Chrome Blue Auto Josh Hammond PSA 10",
    grade: "PSA 10",
    sport: "MLB",
    category: "real-lookup",
    gradePair: "case-08",
    baselineFile: "case-08b-josh-hammond-2025-bowman-draft-chrome-blue-auto-psa10.json",
  },
  {
    id: "case-09-caleb-bonemer-2024-bowman-draft-chrome-blue-auto-raw",
    query: "2024 Bowman Draft Chrome Blue Auto Caleb Bonemer",
    grade: "Raw",
    sport: "MLB",
    category: "real-lookup",
    // Post-CardHedge-cutover: this narrow modern parallel returns
    // catalog-miss on CH (was variant-mismatch with 69 candidate comps
    // on the 2026-05-20 baseline). Same "not-priced" functional
    // outcome, but the snapshot shape differs. Track as CH thin
    // supply until CH indexes this parallel.
    blockedBy: [55],
    baselineFile: "case-09-caleb-bonemer-2024-bowman-draft-chrome-blue-auto-raw.json",
  },
  {
    id: "case-10-caleb-bonemer-2024-bowman-draft-chrome-gold-wave-auto-psa9",
    query: "2024 Bowman Draft Chrome Gold Wave Auto Caleb Bonemer PSA 9",
    grade: "PSA 9",
    sport: "MLB",
    category: "real-lookup",
    baselineFile: "case-10-caleb-bonemer-2024-bowman-draft-chrome-gold-wave-auto-psa9.json",
  },
  {
    id: "case-11-aaron-judge-2017-topps-chrome-catching-rc-psa10",
    query: "2017 Topps Chrome Aaron Judge Catching RC PSA 10",
    grade: "PSA 10",
    sport: "MLB",
    category: "real-lookup",
    baselineFile: "case-11-aaron-judge-2017-topps-chrome-catching-rc-psa10.json",
  },

  // ── popular-baseline (cases 12-14) ─────────────────────────────────────
  {
    id: "case-12-paul-skenes-2024-topps-chrome-rc-raw",
    query: "2024 Topps Chrome Paul Skenes RC",
    grade: "Raw",
    sport: "MLB",
    category: "popular-baseline",
    blockedBy: [8],
    baselineFile: "case-12-paul-skenes-2024-topps-chrome-rc-raw.json",
  },
  {
    id: "case-13-elly-de-la-cruz-2023-topps-update-rc-raw",
    query: "2023 Topps Update Elly De La Cruz RC",
    grade: "Raw",
    sport: "MLB",
    category: "popular-baseline",
    blockedBy: [8, 55],
    baselineFile: "case-13-elly-de-la-cruz-2023-topps-update-rc-raw.json",
  },
  {
    id: "case-14-wander-franco-2018-bowman-chrome-1st-auto-raw",
    query: "2018 Bowman Chrome Wander Franco 1st Auto",
    grade: "Raw",
    sport: "MLB",
    category: "popular-baseline",
    blockedBy: [55],
    baselineFile: "case-14-wander-franco-2018-bowman-chrome-1st-auto-raw.json",
  },

  // ── vintage (cases 15-16) ──────────────────────────────────────────────
  {
    id: "case-15-michael-jordan-1986-fleer-psa8",
    query: "1986 Fleer Michael Jordan PSA 8",
    grade: "PSA 8",
    sport: "NBA",
    category: "vintage",
    blockedBy: [7],
    baselineFile: "case-15-michael-jordan-1986-fleer-psa8.json",
  },
  {
    id: "case-16-ken-griffey-jr-1989-upper-deck-rc-psa9",
    query: "1989 Upper Deck Ken Griffey Jr RC PSA 9",
    grade: "PSA 9",
    sport: "MLB",
    category: "vintage",
    baselineFile: "case-16-ken-griffey-jr-1989-upper-deck-rc-psa9.json",
  },

  // ── non-baseball (cases 17-18) ─────────────────────────────────────────
  // case-17 depends on CH AI choosing a basketball card for the Luka query.
  // CH AI may flip to a baseball Luka card (2018 Donruss Optic Baseball) on
  // ch:match Redis cache miss, producing transient source="no-recent-comps"
  // instead of the baseline's source="unsupported_sport" with
  // detectedSport="Basketball". This is upstream CH variance, not a CompIQ
  // code regression. Treat fatal snapshot diffs on this case as known-flake;
  // do not auto-regenerate the baseline. Tracked for deterministic pinning
  // via cardHedgeCardId follow-up.
  {
    id: "case-17-luka-doncic-2018-panini-prizm-silver-psa10",
    query: "2018 Panini Prizm Silver Luka Doncic PSA 10",
    grade: "PSA 10",
    sport: "NBA",
    category: "non-baseball",
    baselineFile: "case-17-luka-doncic-2018-panini-prizm-silver-psa10.json",
  },
  {
    id: "case-18-justin-herbert-2020-panini-prizm-psa10",
    query: "2020 Panini Prizm Justin Herbert PSA 10",
    grade: "PSA 10",
    sport: "NFL",
    category: "non-baseball",
    baselineFile: "case-18-justin-herbert-2020-panini-prizm-psa10.json",
  },

  // ── pinned-id-hard (cases 19-20) ───────────────────────────────────────
  {
    id: "case-19a-eli-willits-2025-bowman-draft-chrome-green-refractor-auto-raw",
    query: "2025 Bowman Draft Chrome Green Refractor Auto Eli Willits",
    grade: "Raw",
    sport: "MLB",
    category: "pinned-id-hard",
    // Issue #18 — parallel disambiguation: /search and /price-by-id pick
    // different sibling parallels for this card (Green Refractor vs
    // Green Grass Refractor), causing marketTier to legitimately diverge
    // across endpoints. The cross-endpoint drift assertion in
    // pinnedIdHard.test.ts soft-skips until #18 ships.
    blockedBy: [18, 9],
    gradePair: "case-19",
    baselineFile:
      "case-19a-eli-willits-2025-bowman-draft-chrome-green-refractor-auto-raw.json",
  },
  {
    id: "case-19b-eli-willits-2025-bowman-draft-chrome-green-refractor-auto-psa10",
    query: "2025 Bowman Draft Chrome Green Refractor Auto Eli Willits PSA 10",
    grade: "PSA 10",
    sport: "MLB",
    category: "pinned-id-hard",
    // Re-added 2026-05-15: PR #12 grade-token-stripping fix is correct in
    // scope but does not resolve the customer-visible variant-mismatch in
    // production. See issue #6 for full diagnosis. Will be removed when
    // issue #13 + companion cardMatchesTokens strengthening ships.
    // Still blockedBy #9 for the cross-endpoint marketTier divergence
    // (/search synthesizes, /price-by-id refuses to synthesize on zero comps).
    blockedBy: [6, 9],
    gradePair: "case-19",
    baselineFile:
      "case-19b-eli-willits-2025-bowman-draft-chrome-green-refractor-auto-psa10.json",
  },
  // case-20a/20b — issue #9: cross-endpoint divergence.
  // /search returns a synthesized marketTier from neighbor synthesis (e.g. 82.28 / 3911.11),
  // while /price-by-id refuses to synthesize when the pinned card has zero direct comps
  // (returns marketTier.value=null with source=no-recent-comps). Same family as case-19b.
  // Confirmed reproducible across 5 consecutive calls per case at 10s spacing on 2026-05-15.
  {
    id: "case-20a-josh-hammond-2025-bowman-draft-chrome-gold-wave-auto-raw",
    query: "2025 Bowman Draft Chrome Gold Wave Auto Josh Hammond",
    grade: "Raw",
    sport: "MLB",
    category: "pinned-id-hard",
    blockedBy: [9],
    gradePair: "case-20",
    baselineFile: "case-20a-josh-hammond-2025-bowman-draft-chrome-gold-wave-auto-raw.json",
  },
  {
    id: "case-20b-josh-hammond-2025-bowman-draft-chrome-gold-wave-auto-psa10",
    query: "2025 Bowman Draft Chrome Gold Wave Auto Josh Hammond PSA 10",
    grade: "PSA 10",
    sport: "MLB",
    category: "pinned-id-hard",
    blockedBy: [9],
    gradePair: "case-20",
    baselineFile:
      "case-20b-josh-hammond-2025-bowman-draft-chrome-gold-wave-auto-psa10.json",
  },
];

export function casesIn(category: CaseCategory): TestCase[] {
  return CASES.filter((c) => c.category === category);
}

export function isBlocked(c: TestCase, issue?: number): boolean {
  if (!c.blockedBy || c.blockedBy.length === 0) return false;
  if (issue === undefined) return true;
  return c.blockedBy.includes(issue);
}

/**
 * Uniform snapshot-fatal handling across all Tier 1 test files.
 *
 * When the case has ANY tracked `blockedBy` issue, treat fatal drift as
 * a WARN (log + record, don't throw). The tracked issue is the durable
 * record; a fatal throw would just re-report what the issue already says.
 *
 * When the case has NO blockedBy, treat fatal drift as a real regression
 * and throw — those are the actionable signals we want Tier 1 to surface.
 *
 * CF-TIER1-BLOCKED-SNAPSHOT-SOFT (2026-06-30): pre-fix, `recentComps
 * emptied (baseline had N entries)` was fatal on every case, including
 * cases already blocked by issue #55 (CH supply thinned) — the exact
 * cause of the "emptied" state. Result: Tier 1 was permanent red on
 * cases everyone had already agreed were noise.
 */
export function handleSnapshotDiff(c: TestCase, diff: DiffResult): void {
  if (diff.warnings.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`  [SNAPSHOT WARN] ${c.id}: ${diff.warnings.join("; ")}`);
  }
  if (diff.fatal.length > 0) {
    if (isBlocked(c)) {
      // eslint-disable-next-line no-console
      console.warn(
        `  [SNAPSHOT WARN — soft, blocked by ${c.blockedBy!.map((n) => `#${n}`).join(", ")}] ${c.id}: ${diff.fatal.join("; ")}`,
      );
      return;
    }
    throw new Error(`snapshot fatal: ${diff.fatal.join("; ")}`);
  }
}

// ---------------------------------------------------------------------------
// Baseline loading
// ---------------------------------------------------------------------------

export interface Baseline {
  caseId: string;
  category: string;
  query: string;
  grade: string;
  capturedAt: string;
  search: Record<string, unknown> | null;
  searchError?: string | null;
  cardHedgeCardId: string | null;
  priceById: Record<string, unknown> | null;
  priceByIdError?: string | null;
  notes?: string[];
}

export function loadBaseline(c: TestCase): Baseline {
  const p = path.join(BASELINE_DIR, c.baselineFile);
  if (!fs.existsSync(p)) {
    throw new Error(`Baseline missing for ${c.id}: ${p}`);
  }
  // PowerShell `Out-File -Encoding utf8` emits a UTF-8 BOM that breaks JSON.parse.
  let raw = fs.readFileSync(p, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return JSON.parse(raw) as Baseline;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// CF-TIER1-HARNESS-SESSION (2026-06-30): the harness hits production
// `/api/compiq/*` routes, all of which are gated by requireSession (CF-
// PAYMENTS-A). Without an x-session-id header, every call returns 401
// and the harness has been chronically red on every PR for ~3 days.
//
// Fix: read TIER1_HARNESS_SESSION_ID from the env. The CI workflow
// exposes it from a GitHub Secret. Drew provisions the secret with a
// long-lived test session-id (one-time, then rotate as needed).
//
// Local dev: export TIER1_HARNESS_SESSION_ID=<your-own-session-id>
// to run the harness against prod from your machine.
const HARNESS_SESSION_ID = process.env.TIER1_HARNESS_SESSION_ID?.trim() ?? "";

async function postJson(
  pathName: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CASE_BUDGET_MS - 1_000);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (HARNESS_SESSION_ID) {
      headers["x-session-id"] = HARNESS_SESSION_ID;
    }
    const res = await fetch(`${API_BASE}${pathName}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      // CF-TIER1-HARNESS-SESSION: 401 most often means the secret isn't
      // set in the CI environment. Make the failure actionable.
      if (res.status === 401 && !HARNESS_SESSION_ID) {
        throw new Error(
          `${pathName} returned HTTP 401 because TIER1_HARNESS_SESSION_ID is not set ` +
            `(GitHub Secret in CI, env var locally). See backend/docs/runbooks/tier1-harness-session.md.`
        );
      }
      throw new Error(
        `${pathName} returned HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`
      );
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export function hitSearch(query: string): Promise<Record<string, unknown>> {
  return postJson("/api/compiq/search", { query });
}

export function hitPriceById(
  cardHedgeCardId: string,
  query: string,
  grade: CaseGrade
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { cardHedgeCardId, query };
  if (grade !== "Raw") {
    const [gradeCompany, gradeValueStr] = grade.split(/\s+/);
    body.gradeCompany = gradeCompany;
    body.gradeValue = Number(gradeValueStr);
  }
  return postJson("/api/compiq/price-by-id", body);
}

// ---------------------------------------------------------------------------
// Layer A assertion helpers
// ---------------------------------------------------------------------------

const ALLOWED_SOURCES = new Set([
  "live",
  "no-recent-comps",
  "variant-mismatch",
  "neighbor-synthesis",
  // Issue #7 fix: free-text queries that CH's AI identified as non-baseball
  // short-circuit to this source with all pricing fields nulled out.
  "unsupported_sport",
  // CF-LAUNCH-HARDENING (2026-06-02): free-text queries whose CardHedge
  // catalog search yields zero candidates short-circuit here. Distinct
  // from "no-recent-comps" (catalog HIT, no sales) — this is catalog MISS.
  // CH is the engine's sole comp vendor as of the CardHedge hard-cutover
  // (2026-05-30); prior Cardsight references in older comments are stale.
  "catalog-miss",
  // Pre-modern (< PRE_MODERN_YEAR_CUTOFF) cards intentionally out of launch
  // scope. Same iOS branch as unsupported_sport (both flag outOfScopeReason).
  "out-of-scope",
  // CF-SIBLING-POOL: when a pinned parallel has no direct comps but sibling
  // parallels of the same base card do, engine pools those siblings.
  "sibling-pool",
  // eBay-sourced pricing path (fallback when CH doesn't have the card).
  "ebay",
  // upstreamTimeout.helpers.ts: HTTP 200 short-circuit when an upstream
  // vendor (CardHedge, eBay) exceeds its budget. Distinct from the
  // caller-timeout / 5xx path.
  "upstream-timeout",
]);

export function expectWellFormed(
  resp: Record<string, unknown>,
  testStartMs: number
): void {
  expect(resp).toBeTypeOf("object");
  expect(resp).not.toBeNull();
  expect(resp.success).toBe(true);

  // Engine-emission contract.
  expect(typeof resp.engineVersion).toBe("string");
  expect((resp.engineVersion as string).length).toBeGreaterThan(0);
  expect(resp.pricingEngine).toBe("monolith");

  // computedAt parses as a valid recent ISO timestamp.
  // Tolerance: the response cache TTL is 15 min and we accept up to 30 min
  // of staleness to avoid flakes on cached responses.
  const computedAt = resp.computedAt;
  expect(typeof computedAt).toBe("string");
  const ts = Date.parse(computedAt as string);
  expect(Number.isFinite(ts)).toBe(true);
  expect(ts).toBeLessThanOrEqual(testStartMs + 60_000); // tolerate 1 min clock skew
  expect(testStartMs - ts).toBeLessThan(30 * 60_000); // not older than 30 min

  // Source must be one of the engine's known enum values.
  if (resp.source !== undefined && resp.source !== null) {
    expect(ALLOWED_SOURCES.has(resp.source as string)).toBe(true);
  }
}

export function expectLiveData(
  resp: Record<string, unknown>,
  opts: { minComps?: number; assertFmv?: boolean; minFmv?: number } = {}
): void {
  const { minComps = 5, assertFmv = true, minFmv = 0 } = opts;
  expect(resp.source).toBe("live");
  expect(typeof resp.compsUsed).toBe("number");
  expect(resp.compsUsed as number).toBeGreaterThanOrEqual(minComps);
  if (assertFmv) {
    expect(typeof resp.fairMarketValueLive).toBe("number");
    expect(resp.fairMarketValueLive as number).toBeGreaterThan(minFmv);
  }
}

export function expectPinnedIdAllowedSource(resp: Record<string, unknown>): void {
  const allowed = new Set(["live", "no-recent-comps", "neighbor-synthesis"]);
  expect(allowed.has(resp.source as string)).toBe(true);
  const vw = (resp.variantWarning as string[] | undefined) ?? [];
  expect(vw.includes("player_mismatch")).toBe(false);
}

// ---------------------------------------------------------------------------
// Layer B snapshot diff
// ---------------------------------------------------------------------------

/** Fields excluded from snapshot diff (volatile per request). */
const VOLATILE_FIELDS = new Set([
  "computedAt",
  "engineVersion",
]);

export function stripVolatile<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) {
    return obj.map((v) => stripVolatile(v)) as unknown as T;
  }
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (VOLATILE_FIELDS.has(k)) continue;
      out[k] = stripVolatile(v);
    }
    return out as unknown as T;
  }
  return obj;
}

export interface DiffResult {
  fatal: string[];
  warnings: string[];
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Snapshot diff for /search responses against a captured baseline.
 *
 * Live-data case: baseline.search.source === "live" — drift gets stricter.
 * Popular-baseline case: source MUST remain "live" or fatal.
 */
export function snapshotDiff(
  baselineResp: Record<string, unknown> | null | undefined,
  liveResp: Record<string, unknown>,
  opts: { isLiveDataCase: boolean; isPopularBaseline: boolean }
): DiffResult {
  const out: DiffResult = { fatal: [], warnings: [] };
  if (!baselineResp) {
    out.fatal.push("baseline missing — cannot diff");
    return out;
  }

  // Top-level shape: baseline keys must be a subset of live keys
  // (new fields on live are warnings, removed fields are fatal).
  const baseKeys = Object.keys(baselineResp).filter((k) => !VOLATILE_FIELDS.has(k));
  const liveKeys = Object.keys(liveResp).filter((k) => !VOLATILE_FIELDS.has(k));
  for (const k of baseKeys) {
    if (!(k in liveResp)) {
      out.fatal.push(`field removed from response: ${k}`);
    }
  }
  for (const k of liveKeys) {
    if (!baseKeys.includes(k)) {
      out.warnings.push(`new field appeared in response: ${k}`);
    }
  }

  // Error-field appearance is always fatal.
  if (typeof liveResp.error === "string" && liveResp.error.length > 0) {
    out.fatal.push(`new error field on live response: ${liveResp.error.slice(0, 120)}`);
  }
  if (liveResp.success === false && baselineResp.success !== false) {
    out.fatal.push("success flipped from true to false");
  }

  // source transition checks.
  const baseSource = baselineResp.source as string | undefined;
  const liveSource = liveResp.source as string | undefined;
  if (opts.isPopularBaseline) {
    if (baseSource === "live" && liveSource !== "live") {
      out.fatal.push(`popular-baseline source changed: live → ${liveSource}`);
    }
  }

  // compsUsed regression.
  const baseComps = asNumber((baselineResp as any).compsUsed);
  const liveComps = asNumber((liveResp as any).compsUsed);
  if (baseComps !== null && baseComps > 0 && liveComps !== null && liveComps === 0) {
    out.fatal.push(`compsUsed dropped from ${baseComps} to 0`);
  }

  // marketTier.value drift on live-data cases.
  const baseTier = (baselineResp.marketTier as any) ?? {};
  const liveTier = (liveResp.marketTier as any) ?? {};
  const baseVal = asNumber(baseTier.value);
  const liveVal = asNumber(liveTier.value);
  if (opts.isLiveDataCase && baseVal !== null && baseVal > 0) {
    if (liveVal === null) {
      out.fatal.push(`marketTier.value disappeared (was ${baseVal})`);
    } else {
      const pct = Math.abs(liveVal - baseVal) / baseVal;
      if (pct > 0.5) {
        out.fatal.push(
          `marketTier.value drift > 50%: ${baseVal} → ${liveVal} (${(pct * 100).toFixed(1)}%)`
        );
      } else if (pct > 0.1) {
        out.warnings.push(
          `marketTier.value drift ${(pct * 100).toFixed(1)}%: ${baseVal} → ${liveVal}`
        );
      }
    }
  }

  // recentComps regression.
  const baseRC = (baselineResp.recentComps as unknown[]) ?? [];
  const liveRC = (liveResp.recentComps as unknown[]) ?? [];
  if (baseRC.length > 0 && liveRC.length === 0) {
    out.fatal.push(`recentComps emptied (baseline had ${baseRC.length} entries)`);
  } else if (
    baseRC.length === liveRC.length &&
    baseRC.length > 0 &&
    JSON.stringify(stripVolatile(baseRC)) !== JSON.stringify(stripVolatile(liveRC))
  ) {
    out.warnings.push("recentComps content/order changed");
  }

  // neighborSynthesisDebug churn is always a warning.
  if (
    JSON.stringify((baselineResp as any).neighborSynthesisDebug ?? null) !==
    JSON.stringify((liveResp as any).neighborSynthesisDebug ?? null)
  ) {
    out.warnings.push("neighborSynthesisDebug changed");
  }

  return out;
}

// ---------------------------------------------------------------------------
// Progress reporter + global summary
// ---------------------------------------------------------------------------

interface CaseReport {
  id: string;
  passed: boolean;
  softAsserted: boolean;
  snapshotWarnings: string[];
  snapshotFatal: string[];
  durationMs: number;
  notes: string[];
}

const REPORTS = new Map<string, CaseReport>();
let CASE_INDEX = 0;
const TOTAL_CASES = CASES.length;

export function beginCase(c: TestCase): { startMs: number } {
  CASE_INDEX += 1;
  // eslint-disable-next-line no-console
  console.log(
    `\n── Tier 1 (production data) — case ${CASE_INDEX}/${TOTAL_CASES}: ${c.id}` +
      (c.blockedBy ? `   [blocked-by: ${c.blockedBy.map((n) => `#${n}`).join(", ")}]` : "")
  );
  return { startMs: Date.now() };
}

export function recordResult(
  c: TestCase,
  args: {
    startMs: number;
    passed: boolean;
    softAsserted: boolean;
    diff: DiffResult;
    notes?: string[];
  }
): void {
  REPORTS.set(c.id, {
    id: c.id,
    passed: args.passed,
    softAsserted: args.softAsserted,
    snapshotWarnings: args.diff.warnings,
    snapshotFatal: args.diff.fatal,
    durationMs: Date.now() - args.startMs,
    notes: args.notes ?? [],
  });
}

export function printFinalSummary(): void {
  if (REPORTS.size === 0) return;
  const reports = [...REPORTS.values()];
  const passed = reports.filter((r) => r.passed && r.snapshotFatal.length === 0).length;
  const failed = reports.filter((r) => !r.passed || r.snapshotFatal.length > 0).length;
  const soft = reports.filter((r) => r.softAsserted).length;
  const withWarn = reports.filter((r) => r.snapshotWarnings.length > 0).length;
  // eslint-disable-next-line no-console
  console.log(
    `\n══════ Tier 1 Summary ══════\n` +
      `  Total:              ${reports.length}\n` +
      `  Passed:             ${passed}\n` +
      `  Failed:             ${failed}\n` +
      `  Soft-asserted:      ${soft}\n` +
      `  Snapshot warnings:  ${withWarn}\n` +
      `  Avg duration:       ${(
        reports.reduce((a, r) => a + r.durationMs, 0) / reports.length
      ).toFixed(0)} ms\n` +
      `════════════════════════════\n`
  );
  for (const r of reports) {
    if (r.snapshotFatal.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`  [FATAL ] ${r.id}: ${r.snapshotFatal.join("; ")}`);
    } else if (r.snapshotWarnings.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`  [WARN  ] ${r.id}: ${r.snapshotWarnings.join("; ")}`);
    }
  }
}
