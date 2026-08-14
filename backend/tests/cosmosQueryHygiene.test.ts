// CF-TOP-N-NEEDS-ORDER-BY (Drew, 2026-08-14: "should we clean the code so it
// doesn't do it again?").
//
// `SELECT TOP n` without an `ORDER BY` returns an ARBITRARY n rows in Cosmos —
// whatever the scan reaches first. It is not "the first n", it is not stable
// between calls, and it silently produces a plausible wrong answer rather than
// an error.
//
// This shape produced four separate wrong results in one day:
//
//   pricing lookup      TOP 60  — sampled an arbitrary comp set
//   catalog search      TOP 500 — arbitrary results, ranked after the fact
//   fuzzy-parallel      TOP 10  — picked an arbitrary parallel of the card,
//                                 filing a Mojo Refractor as a plain Refractor
//   family-fallback     TOP 5   — took resources[0] across a set boundary
//
// The last two corrupted 14.33% of promoted sales before they were caught.
//
// A `TOP 1` lookup on a unique key is fine (there is only one row, so order is
// meaningless), which is most of the existing occurrences. Rather than rewrite
// 46 call sites at once, this test RATCHETS: the current offenders are recorded
// as a baseline, and the count may only go DOWN. A new unordered TOP lands as a
// failing test with this comment attached.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Query text often spans lines, so scan a window after each TOP for ORDER BY. */
function unorderedTopCount(source: string): number {
  let count = 0;
  const re = /SELECT\s+TOP\s+(\d+|\$\{[^}]+\}|@\w+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    // TOP 1 on a unique key is order-independent — there is only one row.
    if (m[1] === "1") continue;
    // Look ahead far enough to clear a long projection list.
    const window = source.slice(m.index, m.index + 900);
    // Stop at the end of the query literal so we do not borrow a neighbour's
    // ORDER BY from further down the file.
    const endOfQuery = window.search(/["'`]\s*[,)}]/);
    const scope = endOfQuery > 0 ? window.slice(0, endOfQuery) : window;
    if (!/ORDER\s+BY/i.test(scope)) count++;
  }
  return count;
}

describe("Cosmos query hygiene", () => {
  it("does not add new `SELECT TOP n` queries without ORDER BY", () => {
    const total = walk(SRC).reduce((n, f) => n + unorderedTopCount(readFileSync(f, "utf8")), 0);

    // Baseline measured 2026-08-14. This number may only go DOWN.
    // If you are here because this test failed: your query needs an ORDER BY,
    // or a comment explaining why arbitrary row selection is correct. If you
    // FIXED some and the count dropped, lower the baseline.
    const BASELINE = 46;

    expect(
      total,
      `Unordered "SELECT TOP n" count is ${total}, baseline ${BASELINE}. ` +
      "If this went UP you added one — Cosmos returns an arbitrary n rows without ORDER BY, " +
      "which is how a Mojo Refractor got filed as a plain Refractor. " +
      "If it went DOWN, lower BASELINE to lock in the win.",
    ).toBeLessThanOrEqual(BASELINE);
  });

  it("the two matcher queries that caused real corruption are ordered", () => {
    // These are the specific ones that mis-identified 14.33% of promoted sales.
    // NB: do not truncate at the first quote — Cosmos SQL embeds quotes
    // (`c.cardNumber ?? ''`), so a quote-terminated window ends before the
    // ORDER BY and reports a false positive. Scan a fixed window instead.
    const matcher = readFileSync(join(SRC, "services", "catalog", "catalogMatcher.service.ts"), "utf8");
    const re = /SELECT\s+TOP\s+\d+/gi;
    let m: RegExpExecArray | null;
    let checked = 0;
    while ((m = re.exec(matcher)) !== null) {
      const window = matcher.slice(m.index, m.index + 600);
      expect(/ORDER\s+BY/i.test(window), `unordered query in catalogMatcher near: ${window.slice(0, 110)}`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);   // guard against the regex silently matching nothing
  });
});
