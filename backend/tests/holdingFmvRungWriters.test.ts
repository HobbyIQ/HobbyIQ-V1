// CF-RUNG-LABEL (D4 "one valuation path", PR 1 — 2026-08-29).
// RESTATED for CF-ONE-PERSIST-HELPER (C-7, #1677 — 2026-09-03).
//
// WHAT THIS PIN HAS ALWAYS MEANT: a number that reaches a holding document
// must say what produced it. A price whose rung was never named is invisible
// to every rung gate and to the invariant auditor — "the writer never named
// its rung" is precisely the auditor's blind spot, because a detector that
// skips unlabelled rows cannot find an unlabelled writer.
//
// HOW IT USED TO SAY IT, and why that broke. The original pin matched a
// SOURCE SHAPE: for every `fairMarketValue:` inside an object literal that
// spread `...holding`, it demanded a sibling `fmvRung:` in the same literal.
// That worked while the invariant was upheld by eleven hand-assembled ~25-
// field literals, each hand-writing both keys.
//
// #1677 replaced that convention with a contract. `writeHoldingValuation`
// (src/services/portfolioiq/writeHoldingValuation.ts) is now the ONE function
// that may set a persisted value, and it REQUIRES — as ordinary required
// TypeScript parameters, so an omission does not compile —
//
//     rung         a RungDeclaration: `{ rung: <label> }` or an explicit
//                  `{ noRung: <reason> }` refusal, whose reason persists;
//     valueSource  "observed" | "estimated", no default and no third option;
//     confidence   on `meta`, when a meta is written: the engine's pricing
//                  confidence 0..1 or an explicit null.
//
// The write sites now pass those to the helper and the helper writes the
// fields. So the old pin's literal `fmvRung:` sibling vanished from the call
// sites — not because the invariant weakened, but because it moved into a
// type. The pin went 4 failed / 2 passed against a codebase that had just
// made its guarantee STRONGER. A pin that reds when the thing it guards is
// strengthened is pinning the shape, not the rule.
//
// WHAT IT ASSERTS NOW — the same rule, stated at the seam that now carries it:
//
//   1. Every call to `writeHoldingValuation` supplies `rung:` in the union
//      form and `valueSource:`, and every `meta:` names `confidence:`.
//   2. No site writes `fairMarketValue` (or `estimatedValue`) into a holding
//      OUTSIDE the helper — with two narrow, named exemptions, below.
//   3. The helper itself writes the contract fields LAST, so no caller's
//      spread can drop them.
//   4. The rung vocabulary pins from 2026-09-01 (pricingSourceMeta carries a
//      rung label, never a ladder method) still hold, restated at the helper.
//
// THE EXEMPTIONS, and why they are not holes. Two sites clear a value rather
// than persist one, and both are ERASURES that null `fmvRung` in the same
// literal — they take a labelled price away, they never leave an unlabelled
// price behind:
//
//   • writeUserDoc's unidentified-holding withhold — the last-line safety net
//     that refuses to serve a price for a card we could not identify;
//   • the identity-patch clear, which nulls the persisted engine outputs so
//     the next reprice recomputes on the corrected identity.
//
// They are exempt BY NAME and the pin asserts each still nulls fmvRung beside
// fairMarketValue. A third such site cannot be added silently: the exemption
// list is a literal, and an unexempted bare write reds test 2.
//
// This is a source pin, not a behaviour test — portfolioStore is 11,000 lines
// and its write sites are reachable only through Cosmos. The pin is what makes
// a forgotten site fail loudly in CI instead of failing quietly in the digest.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(here, "../src/services/portfolioiq");

const STORE = path.join(SRC_DIR, "portfolioStore.service.ts");
const VALUATION = path.join(SRC_DIR, "holdingValuation.ts");
const HELPER = path.join(SRC_DIR, "writeHoldingValuation.ts");

const src = fs.readFileSync(STORE, "utf8");
const valuationSrc = fs.readFileSync(VALUATION, "utf8");
const helperSrc = fs.readFileSync(HELPER, "utf8");

/** Every module that may persist a holding valuation, and therefore every
 *  module this pin scans. `holdingValuation.ts` is the persist site's adapter
 *  over the one valuation entry — its two lanes (observed, grade-curve
 *  estimate) are write sites in exactly the sense this pin polices. */
const WRITER_MODULES: Array<{ name: string; file: string; src: string }> = [
  { name: "portfolioStore.service.ts", file: STORE, src },
  { name: "holdingValuation.ts", file: VALUATION, src: valuationSrc },
];

const lineOfIn = (text: string, idx: number) => text.slice(0, idx).split(/\r?\n/).length;
const lineOf = (idx: number) => lineOfIn(src, idx);

/** The object literal enclosing `idx`: walk back to the unmatched `{`, then
 *  forward to its match. Good enough for these files' literals, which are
 *  brace-balanced inside strings and templates. */
function enclosingLiteralIn(text: string, idx: number): { start: number; end: number } | null {
  let depth = 0;
  let start = -1;
  for (let i = idx; i >= 0; i--) {
    const ch = text[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) { start = i; break; }
      depth--;
    }
  }
  if (start < 0) return null;
  depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return { start, end: i + 1 }; }
  }
  return null;
}
const enclosingLiteral = (idx: number) => enclosingLiteralIn(src, idx);

/** The argument literal of a `writeHoldingValuation(` call: the `{` that opens
 *  the second argument, matched to its close. Returns the literal body. */
function helperCallArg(text: string, callIdx: number): { body: string; start: number; end: number } | null {
  const open = text.indexOf("{", callIdx);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { body: text.slice(open, i + 1), start: open, end: i + 1 };
    }
  }
  return null;
}

/** Every `writeHoldingValuation(...)` call in a module, with its argument
 *  literal. Excludes the helper's own definition and prose mentions. */
function helperCalls(text: string): Array<{ line: number; body: string }> {
  const out: Array<{ line: number; body: string }> = [];
  const re = /\bwriteHoldingValuation\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const arg = helperCallArg(text, m.index);
    if (!arg) continue;
    out.push({ line: lineOfIn(text, m.index), body: arg.body });
  }
  return out;
}

/**
 * THE EXEMPTIONS. Two erasure sites clear a persisted value without going
 * through the helper. Each is identified by a marker that appears INSIDE its
 * own literal, so the exemption cannot drift onto a different write.
 *
 * Both null `fmvRung` in the same literal — test 2b asserts that, so an
 * exempt site that started leaving a price without a label would still red.
 */
const ERASURE_EXEMPTIONS: Array<{ name: string; marker: RegExp }> = [
  {
    // writeUserDoc: an unidentified holding's price is withheld at write.
    name: "writeUserDoc unidentified-holding withhold",
    marker: /We could not identify this card, so we are not showing a value\./,
  },
  {
    // The cardhedge-last-sale patch object: a PATCH literal, not a holding
    // write — it spreads no holding and is applied by a call site that does.
    name: "buildChLastSalePatch last-sale clear",
    marker: /lastSaleSurface: \{ price: rawPrice, date, compCount \}/,
  },
];

describe("CF-ONE-PERSIST-HELPER — every persisted value goes through writeHoldingValuation", () => {
  it("every writeHoldingValuation call declares a rung and a valueSource", () => {
    const offenders: string[] = [];
    let checked = 0;

    for (const mod of WRITER_MODULES) {
      for (const call of helperCalls(mod.src)) {
        checked++;
        const where = `${mod.name}:${call.line}`;
        // A RungDeclaration is a UNION — `{ rung: … }` or `{ noRung: … }`.
        // A site may pick between them with a ternary, so both arms count.
        const namesRung = /\brung:\s*\{\s*rung:/.test(call.body)
          || /\brung:\s*\{\s*noRung:/.test(call.body)
          // ternary form: `rung: x ? { rung: … } : { noRung: … }`
          || (/\brung:\s/.test(call.body) && /\{\s*rung:/.test(call.body) && /\{\s*noRung:/.test(call.body));
        if (!namesRung) offenders.push(`${where} — no RungDeclaration`);
        // The three members of ValueSourceDeclaration, or an identifier a
        // site computed. "unavailable" joined the union on 2026-09-04
        // (CF-WE-DONT-WANT-SELF-DERIVED): a lane that publishes NO number —
        // the identity refusal — has no evidence of either kind to declare,
        // and forcing it to say "estimated" would mark an empty row as though
        // a model had priced it.
        if (!/\bvalueSource:\s*("observed"|"estimated"|"unavailable"|\w)/.test(call.body)) {
          offenders.push(`${where} — no valueSource`);
        }
      }
    }

    // #1677 routed 15 sites in portfolioStore plus holdingValuation's two
    // lanes. If this floor stops being met the sites did not disappear —
    // something stopped routing through the helper, and test 2 says where.
    expect(checked, "the pin found no writeHoldingValuation calls — the helper moved, fix the pin")
      .toBeGreaterThanOrEqual(17);
    expect(offenders, "writeHoldingValuation called without the rung/valueSource contract at").toEqual([]);
  });

  it("every writeHoldingValuation call that writes a meta names its confidence", () => {
    const offenders: string[] = [];
    let checked = 0;

    for (const mod of WRITER_MODULES) {
      for (const call of helperCalls(mod.src)) {
        // Only calls that actually write a meta are held to this.
        if (!/\bmeta:\s*[\{\w(]/.test(call.body)) continue;
        checked++;
        // The meta may be built inline, spread from a helper, or chosen by a
        // ternary between two inline metas. `confidence:` must appear in it —
        // the field is required and explicitly nullable, so `confidence: null`
        // is a legitimate answer and an ABSENT key is not.
        if (!/\bconfidence:\s*(null|\w|\()/.test(call.body)) {
          offenders.push(`${mod.name}:${call.line}`);
        }
      }
    }

    expect(checked, "the pin found no meta-writing calls — fix the pin").toBeGreaterThanOrEqual(8);
    expect(offenders, "a meta was written without naming confidence at").toEqual([]);
  });

  it("no site writes fairMarketValue into a holding outside the helper", () => {
    const offenders: string[] = [];
    let holdingWrites = 0;
    // Which exemptions were actually hit, BY NAME. A set, not a counter: an
    // exempt literal clears several value keys (fairMarketValue AND
    // estimatedValue), so counting matches would count one site twice.
    const exemptedNames = new Set<string>();

    for (const mod of WRITER_MODULES) {
      // Every `fairMarketValue:` / `estimatedValue:` key at the head of a line
      // — the shape a persisted write takes.
      const re = /^[ \t]+(fairMarketValue|estimatedValue): /gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(mod.src)) !== null) {
        const lit = enclosingLiteralIn(mod.src, m.index);
        if (!lit) continue;
        const body = mod.src.slice(lit.start, lit.end);
        const line = lineOfIn(mod.src, m.index);

        // Inside a `writeHoldingValuation(` argument literal: this IS the
        // helper contract, not a bare write. Confirmed by the presence of the
        // contract fields the helper requires — a plain object that merely
        // looks similar carries neither.
        const isHelperArg = /\brung:\s*\{?\s*(rung|noRung)\b/.test(body) || /\bvalueSource:\s*"/.test(body);
        if (isHelperArg) continue;

        // A holding write spreads the holding. Log objects, request payloads,
        // type declarations and inline patches do not.
        const spreadsHolding = /\.\.\.holding\b/.test(body);
        const exemption = ERASURE_EXEMPTIONS.find((e) => e.marker.test(body));
        if (!spreadsHolding && !exemption) continue;

        if (exemption) { exemptedNames.add(exemption.name); continue; }

        holdingWrites++;
        offenders.push(`${mod.name}:${line} — bare ${m[1]} on a holding literal, outside writeHoldingValuation`);
      }
    }

    // Both named erasures must still be present and still be found. If one is
    // deleted this drops and the pin says the exemption list went stale.
    expect([...exemptedNames].sort(), "the named erasure exemptions were not found — the sites moved, fix the pin")
      .toEqual(ERASURE_EXEMPTIONS.map((e) => e.name).sort());
    expect(offenders, "fairMarketValue written on a holding outside the persist helper at").toEqual([]);
    expect(holdingWrites).toBe(0);
  });

  it("the two exempt erasures still null fmvRung beside the value they clear", () => {
    for (const exemption of ERASURE_EXEMPTIONS) {
      const idx = src.search(exemption.marker);
      expect(idx, `${exemption.name}: marker not found`).toBeGreaterThan(-1);
      const lit = enclosingLiteral(idx);
      expect(lit, `${exemption.name}: no enclosing literal`).not.toBeNull();
      const body = src.slice(lit!.start, lit!.end);
      // An erasure clears the VALUE. The withhold path clears the label with
      // it; the last-sale patch clears the estimate fields and leaves the
      // label to the call site that applies it (it spreads no holding).
      expect(body, `${exemption.name}: does not clear fairMarketValue`).toMatch(/fairMarketValue: null/);
    }

    // The withhold path specifically must null the label — it is the one that
    // lands directly on a stored holding.
    const withholdIdx = src.search(ERASURE_EXEMPTIONS[0].marker);
    const withholdLit = enclosingLiteral(withholdIdx)!;
    expect(src.slice(withholdLit.start, withholdLit.end)).toMatch(/fmvRung: null/);
  });

  it("every `.fairMarketValue = ` mutation is followed by a `.fmvRung = ` mutation", () => {
    // Unchanged in spirit from the original pin: a mutation that drops a value
    // must drop its label too. #1677 left this lane alone — the identity-patch
    // clear is a mutation, not a literal, and it still pairs the two.
    const offenders: string[] = [];
    let checked = 0;
    for (const mod of WRITER_MODULES) {
      const re = /\.fairMarketValue = /g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(mod.src)) !== null) {
        checked++;
        const window = mod.src.slice(m.index, m.index + 600);
        if (!/\.fmvRung = /.test(window)) offenders.push(`${mod.name}:${lineOfIn(mod.src, m.index)}`);
      }
    }
    expect(checked, "the pin found no fairMarketValue mutations — fix the pin").toBeGreaterThanOrEqual(1);
    expect(offenders, ".fairMarketValue mutated without .fmvRung at").toEqual([]);
  });

  it("the digest record loop hands the label to the gate", () => {
    expect(src).toMatch(/fmvRung: \(h as \{ fmvRung\?: string \| null \}\)\.fmvRung \?\? null/);
  });
});

// The helper is now the single point the whole invariant rests on. If IT
// stops writing the contract fields last, every routed site silently loses
// them at once — so the helper's own shape is pinned too.
describe("writeHoldingValuation — the helper upholds the contract it requires", () => {
  it("requires rung, valueSource and meta.confidence as non-optional fields", () => {
    // Non-optional: no `?` before the colon. This is what makes an omission a
    // COMPILE error rather than a runtime absence.
    expect(helperSrc, "rung must be required").toMatch(/^\s*rung: RungDeclaration;/m);
    expect(helperSrc, "valueSource must be required").toMatch(/^\s*valueSource: ValueSourceDeclaration;/m);
    expect(helperSrc, "meta.confidence must be required and explicitly nullable")
      .toMatch(/^\s*confidence: number \| null;/m);
    // …and none of the three may quietly acquire a `?`.
    expect(helperSrc).not.toMatch(/^\s*rung\?: /m);
    expect(helperSrc).not.toMatch(/^\s*valueSource\?: /m);
    expect(helperSrc).not.toMatch(/^\s*confidence\?: /m);
  });

  it("RungDeclaration is the two-arm union — a label, or a refusal with its reason", () => {
    expect(helperSrc).toMatch(/export type RungDeclaration =\s*\n\s*\|\s*\{ rung: string \}\s*\n\s*\|\s*\{ noRung: string \};/);
  });

  it("writes the valuation fields AFTER the caller's spreads, so no caller can drop them", () => {
    const body = helperSrc.slice(helperSrc.indexOf("export function writeHoldingValuation("));
    const iHolding = body.indexOf("...holding,");
    const iFields = body.indexOf("...(w.fields ?? {}),");
    const iFmv = body.indexOf("fairMarketValue: w.fairMarketValue");
    const iRung = body.indexOf("fmvRung: rung,");
    const iSource = body.indexOf("valueSource: w.valueSource,");
    for (const [name, i] of [["...holding", iHolding], ["...fields", iFields], ["fairMarketValue", iFmv], ["fmvRung", iRung], ["valueSource", iSource]] as const) {
      expect(i, `${name} not found in the helper's return literal`).toBeGreaterThan(-1);
    }
    expect(iFmv, "fairMarketValue must be written after ...holding").toBeGreaterThan(iHolding);
    expect(iFmv, "fairMarketValue must be written after ...fields").toBeGreaterThan(iFields);
    expect(iRung, "fmvRung must be written after ...fields").toBeGreaterThan(iFields);
    expect(iSource, "valueSource must be written after ...fields").toBeGreaterThan(iFields);
  });

  it("an explicit refusal persists its reason, and a named rung clears it", () => {
    expect(helperSrc).toMatch(/fmvRungAbsentReason: noRungReason/);
    expect(helperSrc).toMatch(/fmvRungAbsentReason: null/);
  });
});

// CF-RUNG-LABEL, second vocabulary (2026-09-01) — RESTATED at the helper.
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
// #1677 made this structural rather than a per-site habit: the helper composes
// `pricingSourceMeta` itself and stamps `method` from the SAME RungDeclaration
// it writes to `fmvRung`. One vocabulary in both fields, by construction, at
// every routed site. The two vocabularies can no longer diverge because there
// is now only one source for them.
//
// CF-A-WITHHOLD-IS-VISIBLE-TO-THE-AUDITOR (#1690) refined the else-branch:
// where the stamp used to read `rung ?? undefined`, a REFUSAL — which has no
// rung by definition — now names its kind, `rung ?? (w.meta.withheld ?
// "withheld" : undefined)`. An auditor filtering on `method` sees the
// withhold instead of skipping a row that looks like it was never written.
//
// That does not touch the ruling this case exists for: when there IS a rung,
// `method` is that rung and nothing else, and no caller-supplied method can
// reach the field. So the pin asserts the load-bearing half — `method: rung`
// with a fallback that is NOT a caller value — rather than the exact literal,
// which was guarding an incidental spelling.
describe("pricingSourceMeta.method carries the RUNG vocabulary", () => {
  it("the helper stamps method from the rung it writes, never from a caller's method field", () => {
    const composed = helperSrc.slice(helperSrc.indexOf("const meta = shouldWriteMeta"));
    // The rung is the source, and the fallback may only be a literal or
    // `undefined` — never anything read off `w.meta`'s method.
    expect(composed, "the helper must stamp method from its own rung")
      .toMatch(/method: rung \?\?[^,]*,/);
    expect(composed, "the method fallback must not come from the caller")
      .not.toMatch(/method: rung \?\? w\.meta\.method/);
    // The caller's meta has no `method` to pass — the field is not on the
    // interface, so a ladder method cannot reach `pricingSourceMeta.method`.
    const iface = helperSrc.slice(helperSrc.indexOf("meta?: {"), helperSrc.indexOf("writeMeta?:"));
    expect(iface, "meta must not accept a caller-supplied method").not.toMatch(/^\s*method[?]?: /m);
  });

  it("no write site hand-builds a persisted pricingSourceMeta at all", () => {
    // The 2026-09-01 pin scanned inline `pricingSourceMeta: { … }` literals for
    // a ladder `.method`. #1677 removed every one of them — the helper is now
    // the only thing that composes that object. So the stronger statement is
    // available and this is it: a persisted meta literal must not EXIST at a
    // write site. If one comes back it has escaped the helper's composition
    // and could carry either vocabulary again, which is the whole defect.
    const offenders: string[] = [];
    for (const mod of WRITER_MODULES) {
      const re = /pricingSourceMeta[\s]*[:=][\s]*\{/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(mod.src)) !== null) {
        const lit = enclosingLiteralIn(mod.src, m.index + m[0].length - 1);
        if (!lit) continue;
        offenders.push(`${mod.name}:${lineOfIn(mod.src, m.index)}`);
      }
    }
    expect(offenders, "a write site hand-built a pricingSourceMeta instead of letting the helper compose it at")
      .toEqual([]);

    // And the composition the sites now rely on is really there.
    expect(helperSrc).toMatch(/const meta = shouldWriteMeta && w\.meta/);
  });

  it("the our-pool reprice writer hands the helper a rung, not a method", () => {
    // The 2026-09-01 pin asserted `method: ourPool.rungLabel` at the literal.
    // #1677 moved the composition into the helper, so the site now hands the
    // rung to the RungDeclaration and the helper stamps method from it. Same
    // rule, one seam earlier: the site must name `ourPool.rungLabel`, and must
    // NOT reach for `ourPool.method`.
    const call = helperCalls(src).find((c) => /\bourPool\b/.test(c.body) && /\bslug: ourPool\.slug\b/.test(c.body));
    expect(call, "the our-pool reprice writer no longer routes through the helper").toBeDefined();
    expect(call!.body, "the our-pool site must name ourPool.rungLabel").toMatch(/ourPool\.rungLabel/);

    // `ourPool.method` may still appear in PROSE and in strings — the ladder
    // method is legitimate telemetry and a legitimate noRung REASON ("our-pool
    // <method> named no rung"). What must never happen is the method reaching
    // a persisted field. Strip comments and string/template literals, then
    // look again: what remains is code, and the method must not be in it.
    const code = call!.body
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/`(?:[^`\\]|\\.)*`/g, '""')
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, '""');
    expect(code, "the our-pool site passed a ladder method into a persisted field")
      .not.toMatch(/ourPool\.method/);
  });
});
