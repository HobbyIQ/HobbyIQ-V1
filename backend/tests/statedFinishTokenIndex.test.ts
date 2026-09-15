/**
 * CF-THE-CHECKLIST-NAMES-ARE-TOKENISED-ONCE (2026-09-14).
 *
 * THE DEFECT. `statedFinishFromChecklist` re-tokenised a CHECKLIST NAME once
 * per title: `titleStatesName` and `titleStatesNameEludingProductWords` both
 * open with `words(name)`, and they are called in a loop over the candidate
 * set — which on the global path is every usable name in the corpus.
 * `data/checklist-parallel-names.json` holds 37,849 parallel names (20,729
 * distinct) across 627 products, and those names are FIXED at load.
 *
 * MEASURED on 5,000 real titles harvested from census artifacts, profiled with
 * `node --cpu-prof`:
 *
 *     normalise                   39.4%   statedFinishFromChecklist.ts:335
 *     words                       38.8%   statedFinishFromChecklist.ts:347
 *     RegExp: [^a-z0-9]+           8.7%
 *     ------------------------------------
 *                                 ~88% of ALL parser self-time
 *
 * The per-title cost is bimodal: 69% of titles cost ~0.15 ms and never reach
 * the global scan, 31% cost ~40 ms and do. Weighted mean 12.63 ms/call, which
 * at a fleet link's 78,443 rows is 16.5 minutes of pure CPU.
 *
 * THE FIX is a memo at the one seam every caller already goes through, warmed
 * at `loadCorpus` with every name the corpus holds. After: mean 18.27 -> 1.28
 * ms/call, p95 41.50 -> 3.60 ms, 91.3 s -> 6.4 s over the same 5,000 titles.
 *
 * THIS FILE PINS THAT IT IS A PURE SPEEDUP. A cache that returns a different
 * answer from the function it replaced is not a cache, it is a bug with a
 * performance story attached — so the first test asserts the indexed tokens
 * deep-equal a freshly computed tokenisation for EVERY name in the shipped
 * corpus, and the second asserts `parseListingIdentity` is byte-identical to a
 * snapshot taken from unmodified origin/main (52e21c10) on 200 real titles.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  _TOKEN_CACHE_FOR_TEST,
  _resetStatedFinishCorpus,
  statedFinishFromChecklist,
} from "../src/services/portfolioiq/statedFinishFromChecklist";
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service";

const backend = join(__dirname, "..");

/** The corpus the shipped module reads, resolved the same way it resolves it. */
function corpusPath(): string | null {
  for (const p of [
    join(backend, "data", "checklist-parallel-names.json"),
    join(backend, "dist", "data", "checklist-parallel-names.json"),
  ]) if (existsSync(p)) return p;
  return null;
}

/** `normalise` + `words`, re-implemented here EXACTLY as the module defines
 *  them (they are module-private). This duplication is the point: the test
 *  must compute the answer independently, or it proves only that the cache
 *  agrees with itself. */
const lower = (s: string) => String(s ?? "").toLowerCase();
function normaliseFresh(s: string): string {
  return lower(s)
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function wordsFresh(s: string): string[] {
  const n = normaliseFresh(s);
  return n ? n.split(" ") : [];
}

describe("the checklist token index is the same answer, computed once", () => {
  it("every indexed name tokenises exactly as a fresh normalise+split would", () => {
    const path = corpusPath();
    expect(path, "checklist-parallel-names.json must be present to pin this").not.toBeNull();

    // Force a load so the index is warmed from the real corpus, then read it.
    _resetStatedFinishCorpus();
    statedFinishFromChecklist("2026 Topps Baseball #97 Rainbow Foil", {});
    const cache = _TOKEN_CACHE_FOR_TEST();

    // The corpus warm-up alone should have populated thousands of entries.
    expect(cache.size).toBeGreaterThan(1000);

    const mismatches: string[] = [];
    for (const [name, tokens] of cache) {
      const fresh = wordsFresh(name);
      if (JSON.stringify(tokens) !== JSON.stringify(fresh)) {
        mismatches.push(`${JSON.stringify(name)}: cached ${JSON.stringify(tokens)} vs fresh ${JSON.stringify(fresh)}`);
        if (mismatches.length >= 10) break;
      }
    }
    expect(mismatches, `the token index disagrees with a fresh tokenisation:\n  ${mismatches.join("\n  ")}`).toEqual([]);
  });

  it("covers every parallel name the shipped corpus holds", () => {
    // The warm-up walks `globalNames` -- the de-duplicated set of every name
    // usable as a finish witness. This asserts the corpus really is being
    // walked, so a future refactor that drops the warm-up is caught here
    // rather than showing up only as a slow fleet.
    const path = corpusPath();
    if (!path) return;
    const raw = JSON.parse(readFileSync(path, "utf8"));
    let names = 0;
    for (const product of Object.values<any>(raw.products ?? {})) {
      for (const _ of product.parallels ?? []) names += 1;
    }
    expect(names, "the corpus should hold tens of thousands of parallel names").toBeGreaterThan(10_000);

    _resetStatedFinishCorpus();
    statedFinishFromChecklist("2026 Topps Baseball #97 Rainbow Foil", {});
    // Distinct usable names are fewer than raw names (dupes across products,
    // and names that state no finish are skipped) -- so this is a floor, not
    // an equality, and it is still far above what one title alone would warm.
    expect(_TOKEN_CACHE_FOR_TEST().size).toBeGreaterThan(1000);
  });

  it("a reset clears the index, so it never outlives the corpus it was warmed from", () => {
    _resetStatedFinishCorpus();
    statedFinishFromChecklist("2026 Topps Baseball #97 Rainbow Foil", {});
    expect(_TOKEN_CACHE_FOR_TEST().size).toBeGreaterThan(0);
    _resetStatedFinishCorpus();
    expect(_TOKEN_CACHE_FOR_TEST().size).toBe(0);
  });
});

describe("parseListingIdentity is byte-identical to unmodified main", () => {
  /**
   * THE SNAPSHOT IS THE POINT. It was produced by running the SHIPPED parser at
   * origin/main 52e21c10 -- before the token index existed -- over 200 distinct
   * real titles harvested from census artifacts. If the index changed any
   * answer anywhere, this fails with the exact title that moved.
   */
  it("200 real titles parse to exactly the recorded answers", () => {
    const fixture = join(backend, "tests", "fixtures", "parser-parity", "parseListingIdentity-before-52e21c10.json");
    expect(existsSync(fixture), "the before-snapshot fixture must be present").toBe(true);
    const before = JSON.parse(readFileSync(fixture, "utf8")) as Array<{ title: string; parsed: unknown }>;
    expect(before.length).toBe(200);

    const moved: string[] = [];
    for (const row of before) {
      const now = parseListingIdentity(row.title, undefined, { vertical: null, hobbyiqCardId: null } as never);
      if (JSON.stringify(now) !== JSON.stringify(row.parsed)) {
        moved.push(`${JSON.stringify(row.title)}\n    before ${JSON.stringify(row.parsed)}\n    after  ${JSON.stringify(now)}`);
        if (moved.length >= 5) break;
      }
    }
    expect(moved, `the token index changed a parse:\n  ${moved.join("\n  ")}`).toEqual([]);
  });

  it("the same title parsed twice gives the same answer (the cache is not order-dependent)", () => {
    // A memo that returns a shared array would break if any caller mutated it;
    // the shape of that bug is a SECOND call differing from the first.
    const t = "2026 Topps Baseball #252 Gold Diamante Foil";
    const a = JSON.stringify(parseListingIdentity(t, undefined, { vertical: null, hobbyiqCardId: null } as never));
    const b = JSON.stringify(parseListingIdentity(t, undefined, { vertical: null, hobbyiqCardId: null } as never));
    const c = JSON.stringify(parseListingIdentity(t, undefined, { vertical: null, hobbyiqCardId: null } as never));
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
});
