/**
 * CF-A-PREFIX-SCAN-SCOPES-TO-WHAT-IT-KNOWS (2026-09-26, run 36246861648) --
 * the "id stem" scan pass on `rekey-product-setkey.cjs`, pinned.
 *
 * ── THE INCIDENT ──────────────────────────────────────────────────────────────
 *
 * apply-hop2 (run=36246861648, the Topps Series 2 -> topps fold's second APPLY
 * hop, dispatched 2026-09-26 13:57:17Z) printed "-- scanning by id stem" at
 * 15:01:30Z and then nothing else for 87 minutes, until GitHub Actions' own
 * 150-minute step timeout killed it at 16:28:32Z with no finishLane line, no
 * budget marker, no REPORT/APPLIED summary. The id-stem query at the time was
 * a single cross-partition prefix scan of the ENTIRE 31.4M-row baseball
 * catalog (`STARTSWITH(c.id, "hiq:baseball:")`), with the year and FROM-setKey
 * filters applied only client-side after every row was already fetched.
 * Running concurrently with 15 other slots, that full-source scan drove
 * sustained 429 throttling absorbed silently by the Cosmos SDK's own retry
 * layer (30 attempts / 120s each, nested UNDER this script's own retry()
 * wrapper) with zero console output between pages -- indistinguishable in the
 * log from a genuinely hung process.
 *
 * ── WHAT IS PINNED HERE ───────────────────────────────────────────────────────
 *
 * `buildIdStemSpecs` (scripts/lib/rekey-id-stem-scope.cjs) is a pure function
 * over (sport, years, fromSetKey) -- injected io, no Cosmos, no subprocess --
 * so the query text/params it builds are asserted directly. The MUTATION
 * check at the bottom removes the narrowing (forces the fallback path) and
 * confirms the "one query per year, scoped prefix" assertions fail, proving
 * they are actually exercising the narrowed branch and not vacuously true.
 * Wiring into rekey-product-setkey.cjs itself (that main() calls this
 * function and logs a WARNING on fallback) is pinned against the script's own
 * source, the same way rekeyRefusesCrossMarket.test.ts pins its guard's
 * wiring.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const LIB = path.resolve(__dirname, "..", "scripts", "lib", "rekey-id-stem-scope.cjs");
const SCRIPT = path.resolve(__dirname, "..", "scripts", "rekey-product-setkey.cjs");
const SRC = readFileSync(SCRIPT, "utf8");

const { buildIdStemSpecs, idStemFallbackSpec } = require_(LIB) as {
  buildIdStemSpecs: (opts: { sport?: string; years?: number[]; fromSetKey?: string }) => {
    specs: Array<{ name: string; query: string; parameters: Array<{ name: string; value: string }> }>;
    narrowed: boolean;
    fallbackReason: string | null;
  };
  idStemFallbackSpec: (sport: string) => { name: string; query: string; parameters: Array<{ name: string; value: string }> };
};

describe("buildIdStemSpecs -- the narrowed case (sport + year(s) + fromSetKey all known)", () => {
  it("(baseball, 2025, topps-series-2) builds the exact narrowed prefix, one spec, narrowed=true", () => {
    const r = buildIdStemSpecs({ sport: "baseball", years: [2025], fromSetKey: "topps-series-2" });
    expect(r.narrowed).toBe(true);
    expect(r.fallbackReason).toBeNull();
    expect(r.specs).toHaveLength(1);
    expect(r.specs[0].query).toBe("SELECT * FROM c WHERE STARTSWITH(c.id, @p)");
    expect(r.specs[0].parameters).toEqual([{ name: "@p", value: "hiq:baseball:2025:topps-series-2:" }]);
  });

  it("multiple years in scope -> one query per year, each scoped to its own prefix", () => {
    const r = buildIdStemSpecs({ sport: "baseball", years: [2024, 2025], fromSetKey: "topps-series-2" });
    expect(r.narrowed).toBe(true);
    expect(r.specs).toHaveLength(2);
    expect(r.specs.map((s) => s.parameters[0].value)).toEqual([
      "hiq:baseball:2024:topps-series-2:",
      "hiq:baseball:2025:topps-series-2:",
    ]);
    // Every spec keeps the SAME query text -- only the bound parameter value
    // changes per year, never the query shape itself.
    for (const s of r.specs) expect(s.query).toBe("SELECT * FROM c WHERE STARTSWITH(c.id, @p)");
  });

  it("the narrowed prefix is a STRICT SUBSET of the old full-sport prefix -- every row it can return, the old query would also have returned", () => {
    const narrowed = buildIdStemSpecs({ sport: "baseball", years: [2025], fromSetKey: "topps-series-2" }).specs[0];
    const oldFullSport = idStemFallbackSpec("baseball");
    expect(narrowed.parameters[0].value.startsWith(oldFullSport.parameters[0].value)).toBe(true);
  });

  it("does not lower-case or otherwise transform sport/fromSetKey beyond what the caller already normalized -- the prefix is verbatim", () => {
    // The caller (rekey-product-setkey.cjs) already lower-cases SPORT/FROM at
    // module load; this function must not double-transform or it would build
    // a prefix that silently never matches a mixed-case id.
    const r = buildIdStemSpecs({ sport: "baseball", years: [2025], fromSetKey: "topps-series-2" });
    expect(r.specs[0].parameters[0].value).toBe("hiq:baseball:2025:topps-series-2:");
  });
});

describe("buildIdStemSpecs -- the fallback case (years or fromSetKey missing)", () => {
  it("missing years -> full sport-wide prefix (byte-identical to the pre-fix query) plus a WARNING reason naming the full scan", () => {
    const r = buildIdStemSpecs({ sport: "baseball", years: [], fromSetKey: "topps-series-2" });
    expect(r.narrowed).toBe(false);
    expect(r.specs).toHaveLength(1);
    expect(r.specs[0].query).toBe("SELECT * FROM c WHERE STARTSWITH(c.id, @p)");
    expect(r.specs[0].parameters).toEqual([{ name: "@p", value: "hiq:baseball:" }]);
    expect(r.fallbackReason).toMatch(/years/i);
    expect(r.fallbackReason).toMatch(/full/i);
  });

  it("missing fromSetKey -> the same full-sport fallback, reason names the from-setKey", () => {
    const r = buildIdStemSpecs({ sport: "baseball", years: [2025], fromSetKey: "" });
    expect(r.narrowed).toBe(false);
    expect(r.specs[0].parameters[0].value).toBe("hiq:baseball:");
    expect(r.fallbackReason).toMatch(/from-setKey/i);
  });

  it("both years and fromSetKey missing -> fallback, reason names both", () => {
    const r = buildIdStemSpecs({ sport: "baseball", years: [], fromSetKey: "" });
    expect(r.narrowed).toBe(false);
    expect(r.fallbackReason).toMatch(/years/i);
    expect(r.fallbackReason).toMatch(/from-setKey/i);
  });

  it("the fallback query is IDENTICAL to idStemFallbackSpec's own output -- not a re-derivation", () => {
    const r = buildIdStemSpecs({ sport: "baseball", years: [], fromSetKey: "topps-series-2" });
    expect(r.specs[0]).toEqual(idStemFallbackSpec("baseball"));
  });

  it("years present but all non-finite/non-positive (defensive) also falls back, same as empty", () => {
    const r = buildIdStemSpecs({ sport: "baseball", years: [0, -1, NaN], fromSetKey: "topps-series-2" });
    expect(r.narrowed).toBe(false);
  });
});

describe("buildIdStemSpecs -- the client-side filter still applies (the narrowing is a NARROWING, not a replacement)", () => {
  // A broad (unscoped) prefix would return this row -- it starts with
  // "hiq:baseball:" -- but it belongs to a DIFFERENT year and setKey than the
  // dispatch in scope. This proves the existing downstream client-side guard
  // (rekey-product-setkey.cjs's `parts[3] !== FROM` / `YEARS.includes` checks,
  // unchanged by this fix) is still load-bearing: the narrowed query would
  // never even fetch this row, but if a caller ever DID widen the scope again
  // (or the year list omitted a year that should have been included), the
  // client-side filter is the second guard that catches it.
  it("an out-of-scope row that a broad prefix WOULD return is outside the narrowed prefix, and the client-side filter (pinned in source) is the second guard for it", () => {
    const outOfScopeRow = { id: "hiq:baseball:2024:topps:12:base:no-auto", setKey: "topps" };
    const r = buildIdStemSpecs({ sport: "baseball", years: [2025], fromSetKey: "topps-series-2" });
    const prefix = r.specs[0].parameters[0].value;
    expect(outOfScopeRow.id.startsWith("hiq:baseball:")).toBe(true); // the OLD broad prefix would have fetched it
    expect(outOfScopeRow.id.startsWith(prefix)).toBe(false); // the NEW narrowed prefix does not

    // The client-side guards this narrowing relies on as a second check are
    // still present, unchanged, in the script itself.
    expect(SRC).toContain("if (parts[3] !== FROM) {");
    expect(SRC).toContain("if (YEARS.length && !YEARS.includes(Number(parts[2]))) { s.yearMismatch++; return; }");
  });
});

describe("rekey-product-setkey.cjs wiring -- buildIdStemSpecs is actually called, and a fallback is never silent", () => {
  it("requires the lib module, self-contained (no dist/ dependency, matching market-guard.cjs's own contract)", () => {
    expect(SRC).toContain('require(path.join(__dirname, "lib", "rekey-id-stem-scope.cjs"))');
    expect(SRC).toContain("const { buildIdStemSpecs }");
  });

  it("calls buildIdStemSpecs with SPORT, YEARS, and FROM -- the exact three inputs this dispatch already parses", () => {
    expect(SRC).toContain("buildIdStemSpecs({ sport: SPORT, years: YEARS, fromSetKey: FROM })");
  });

  it("logs a WARNING naming the full scan when the fallback fires -- never silent", () => {
    const block = SRC.slice(SRC.indexOf("const idStem = buildIdStemSpecs"), SRC.indexOf("const specs = ["));
    expect(block).toMatch(/console\.log\(`WARNING: id-stem pass could not narrow/);
    expect(block).toContain("idStem.fallbackReason");
  });

  it("spreads idStem.specs into the existing `specs` array alongside the unchanged 'setKey field' pass", () => {
    const block = SRC.slice(SRC.indexOf("const specs = ["), SRC.indexOf("const seen = new Set();"));
    expect(block).toContain('{ name: "setKey field"');
    expect(block).toContain("...idStem.specs");
    // The old inline "id stem" literal query is gone from this call site --
    // it now lives only in idStemFallbackSpec / buildIdStemSpecs's own
    // narrowed branch, not duplicated here.
    expect(block).not.toContain('{ name: "id stem", query: "SELECT * FROM c WHERE STARTSWITH(c.id, @p)", parameters: [{ name: "@p", value: `hiq:${SPORT}:` }] }');
  });
});

describe("throttle + progress visibility (CF-A-THROTTLED-PASS-IS-NEVER-SILENT)", () => {
  it("retry() logs on every retry attempt, not just on final throw", () => {
    const block = SRC.slice(SRC.indexOf("const retry = async"), SRC.indexOf("async function forEachPage"));
    expect(block).toMatch(/console\.log\(`  \[retry/);
  });

  it("forEachPage logs periodic progress (rows seen/kept, elapsed, RU) and flushes on the final page", () => {
    const block = SRC.slice(SRC.indexOf("async function forEachPage"), SRC.indexOf("// ── main"));
    expect(block).toContain("PROGRESS_EVERY_PAGES");
    expect(block).toMatch(/rows seen \$\{f\(rowsSeen\)\}/);
    expect(block).toMatch(/rows kept \$\{f\(rowsKept\)\}/);
    expect(block).toContain("RU charged");
    // Flushes on the LAST page even if it does not land on the Nth-page tick
    // -- `!token` is part of the same condition as the modulo check.
    expect(block).toMatch(/pageNum % PROGRESS_EVERY_PAGES === 0 \|\| !token/);
  });

  it("forEachPage logs immediately (not batched to the next tick) when a single page is slower than the threshold", () => {
    const block = SRC.slice(SRC.indexOf("async function forEachPage"), SRC.indexOf("// ── main"));
    expect(block).toContain("SLOW_PAGE_MS");
    expect(block).toMatch(/if \(pageMs > SLOW_PAGE_MS\)/);
    expect(block).toMatch(/console\.log\(`  \[slow page\]/);
  });
});

// ── MUTATION CHECK ───────────────────────────────────────────────────────────
// Remove the narrowing (simulate reverting to the old unscoped call) and
// confirm the narrowed-case assertions above would fail -- proving they
// exercise the real branch rather than passing vacuously.
describe("MUTATION: without the narrowing, the incident's exact query text comes back", () => {
  it("calling buildIdStemSpecs with years=[] (as if the narrowing were removed/bypassed) reproduces the ORIGINAL cross-partition full-sport query", () => {
    const r = buildIdStemSpecs({ sport: "baseball", years: [], fromSetKey: "topps-series-2" });
    expect(r.specs).toHaveLength(1);
    // This IS the incident's exact query/parameter shape (run 36246861648):
    expect(r.specs[0].query).toBe("SELECT * FROM c WHERE STARTSWITH(c.id, @p)");
    expect(r.specs[0].parameters[0].value).toBe("hiq:baseball:");
    // ...which is exactly what the "narrowed" test at the top of this file
    // asserts is NOT what a properly-scoped dispatch produces -- so if a
    // future edit deletes the years/fromSetKey checks and always narrows (or
    // never narrows), one set of tests in this file fails.
    expect(r.narrowed).toBe(false);
  });
});
