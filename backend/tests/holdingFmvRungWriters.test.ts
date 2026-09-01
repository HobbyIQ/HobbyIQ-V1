// CF-RUNG-LABEL (D4 "one valuation path", PR 1 — 2026-08-29).
//
// Every holding write in portfolioStore spreads `...holding`, so a rung label
// stamped by one pricing pass would silently survive a later pass by an
// engine that does not name its rung — and the digest would then trust a
// label that describes a price that no longer exists. The rule is therefore:
// every write that sets fairMarketValue sets fmvRung in the same literal (a
// name, or an explicit null), and every mutation of .fairMarketValue is
// followed by a mutation of .fmvRung.
//
// This is a source pin, not a behaviour test — the module is 9,000 lines and
// its write sites are reachable only through Cosmos. The pin is what makes a
// forgotten site fail loudly in CI instead of failing quietly in the digest.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, "../src/services/portfolioiq/portfolioStore.service.ts");
const src = fs.readFileSync(FILE, "utf8");
const lineOf = (idx: number) => src.slice(0, idx).split(/\r?\n/).length;

/** The object literal enclosing `idx`: walk back to the unmatched `{`, then
 *  forward to its match. Good enough for this file's literals, which are
 *  brace-balanced inside strings and templates. */
function enclosingLiteral(idx: number): { start: number; end: number } | null {
  let depth = 0;
  let start = -1;
  for (let i = idx; i >= 0; i--) {
    const ch = src[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) { start = i; break; }
      depth--;
    }
  }
  if (start < 0) return null;
  depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return { start, end: i + 1 }; }
  }
  return null;
}

describe("portfolioStore — every fairMarketValue writer also writes fmvRung", () => {
  it("every holding literal (spreads ...holding) that sets fairMarketValue: also sets fmvRung:", () => {
    const re = /^[ \t]+fairMarketValue: /gm;
    const offenders: string[] = [];
    let checked = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const lit = enclosingLiteral(m.index);
      if (!lit) continue;
      const body = src.slice(lit.start, lit.end);
      // Only holding writes spread the holding; log objects and type
      // declarations do not.
      if (!/\.\.\.holding\b/.test(body)) continue;
      checked++;
      if (!/^[ \t]+fmvRung: /m.test(body)) offenders.push(`line ${lineOf(m.index)}`);
    }
    expect(checked, "the pin found no holding writes — the file changed shape, fix the pin").toBeGreaterThanOrEqual(10);
    expect(offenders, "fairMarketValue written without fmvRung at").toEqual([]);
  });

  it("every `.fairMarketValue = ` mutation is followed by a `.fmvRung = ` mutation", () => {
    const re = /\.fairMarketValue = /g;
    const offenders: string[] = [];
    let checked = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      checked++;
      const window = src.slice(m.index, m.index + 600);
      if (!/\.fmvRung = /.test(window)) offenders.push(`line ${lineOf(m.index)}`);
    }
    expect(checked).toBeGreaterThanOrEqual(3);
    expect(offenders, ".fairMarketValue mutated without .fmvRung at").toEqual([]);
  });

  it("the digest record loop hands the label to the gate", () => {
    expect(src).toMatch(/fmvRung: \(h as \{ fmvRung\?: string \| null \}\)\.fmvRung \?\? null/);
  });
});

// CF-RUNG-LABEL, second vocabulary (2026-09-01).
//
// `pricingSourceMeta.method` is READ as a rung label: the web's
// holdingProvenance() (apps/web/src/lib/rung.ts) prefers it over the flat
// `fmvRung`, and describeRung() only knows the closed FmvRungLabel vocabulary.
// The our-pool writers were stamping `ourPool.method` there instead — the
// HobbyIqFmvMethod vocabulary, whose `direct-slug` is deliberately NOT a rung
// name (fmvRung.ts: `Exclude<HobbyIqFmvMethod, "direct-slug">`, because the
// exact pool's rung is `exact-pool-*`, named by aggregation).
//
// Live symptom (2026-09-01): the one live holding stamped with the wrong
// vocabulary was 2024 Bowman Draft #CPA-MS (pricingSource our-pool, correct
// fmvRung exact-pool-leading-edge one field away); its provenance chip read
//   ? unknown - unknown rung "direct-slug"
// on a number that was in fact the strongest rung the engine has.
//
// So: the persisted meta carries `rungLabel`, never `method`. The telemetry
// and `updates[].reason` strings may still name the ladder method — they are
// not read as rung labels.
describe("portfolioStore — pricingSourceMeta.method carries the RUNG vocabulary", () => {
  it("no persisted pricingSourceMeta literal stamps `method: ourPool.method`", () => {
    const re = /pricingSourceMeta[\s]*[:=][\s]*\{/g;
    const offenders: string[] = [];
    let checked = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const lit = enclosingLiteral(m.index + m[0].length - 1);
      if (!lit) continue;
      checked++;
      const body = src.slice(lit.start, lit.end);
      // `.method` on the our-pool / unified result is the ladder METHOD.
      // Only `.rungLabel` (or a literal rung string) belongs here.
      if (/method:\s*\w+\.method\b/.test(body)) offenders.push(`line ${lineOf(m.index)}`);
    }
    expect(checked, "the pin found no pricingSourceMeta literals — fix the pin").toBeGreaterThanOrEqual(2);
    expect(offenders, "pricingSourceMeta stamped a ladder method instead of a rung label at").toEqual([]);
  });

  it("the our-pool reprice writer stamps ourPool.rungLabel", () => {
    expect(src).toMatch(/pricingSourceMeta:\s*\{\s*\n\s*slug: ourPool\.slug,\s*\n\s*method: ourPool\.rungLabel,/);
  });

  it("the ourPoolMeta assignment stamps ourPool.rungLabel", () => {
    expect(src).toMatch(/ourPoolMeta = \{ slug: ourPool\.slug, method: ourPool\.rungLabel, compsUsed: ourPool\.compsUsed \}/);
  });
});
