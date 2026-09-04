// CF-PRICING-AUDIT-2026-09-03 — C-2 (reprice cadence), C-7 (the legacy
// key-absent writer) and H-9 (orphaned price trails).
//
// These are MUTATION pins, not coverage. Each one names the exact edit that
// must turn it red, because the defect in every case was a silence: a workflow
// that never repriced, a writer that never labelled, a delete that never
// reaped. A test that only asserts the happy path would have been green
// through all three.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { writeHoldingValuation } from "../src/services/portfolioiq/writeHoldingValuation.js";

const repoRoot = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(repoRoot, p), "utf8");

/**
 * A deliberately small YAML reader: enough structure to prove job wiring
 * (names, `needs`, `if`, step envs) without adding a dependency to the backend
 * for one test. It understands the subset GitHub workflow files actually use —
 * two-space nesting, block mappings, block sequences and scalars.
 */
function parseYaml(src: string): any {
  const lines = src.split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !/^\s*#/.test(l));

  function build(start: number, indent: number): [any, number] {
    let i = start;
    const isSeq = lines[i] !== undefined && /^\s*- /.test(lines[i])
      && lines[i].search(/\S/) === indent;
    const out: any = isSeq ? [] : {};

    while (i < lines.length) {
      const line = lines[i];
      const ind = line.search(/\S/);
      if (ind < indent) break;
      if (ind > indent) { i++; continue; }

      if (/^\s*- /.test(line)) {
        const rest = line.slice(ind + 2);
        const m = rest.match(/^([^:#]+):\s*(.*)$/);
        if (m) {
          // A sequence item that is itself a mapping (a workflow step).
          const item: any = {};
          const key = m[1].trim();
          const val = m[2].trim();
          if (val === "" || val === "|" || val === ">") {
            const [child, next] = build(i + 1, ind + 2);
            item[key] = val === "" ? child : String(child);
            i = next;
          } else { item[key] = scalar(val); i++; }
          // Continuation keys of the same mapping item.
          while (i < lines.length && lines[i].search(/\S/) === ind + 2
            && !/^\s*- /.test(lines[i])) {
            const [more, next] = build(i, ind + 2);
            Object.assign(item, more);
            i = next;
          }
          out.push(item);
        } else { out.push(scalar(rest.trim())); i++; }
        continue;
      }

      const m = line.match(/^\s*([^:#]+):\s*(.*)$/);
      if (!m) { i++; continue; }
      const key = m[1].trim();
      const val = m[2].trim();
      if (val === "" || val === "|" || val === ">" || val === "|-") {
        const nextInd = i + 1 < lines.length ? lines[i + 1].search(/\S/) : -1;
        if (nextInd > ind) {
          const [child, next] = build(i + 1, nextInd);
          out[key] = (val === "" ) ? child
            : (Array.isArray(child) ? child.join("\n") : String(child));
          i = next;
        } else { out[key] = null; i++; }
      } else { out[key] = scalar(val); i++; }
    }
    return [out, i];
  }

  function scalar(v: string): any {
    const s = v.replace(/\s+#.*$/, "").trim();
    if (/^["'].*["']$/.test(s)) return s.slice(1, -1);
    if (s === "true") return true;
    if (s === "false") return false;
    return s;
  }

  const firstInd = lines.length ? lines[0].search(/\S/) : 0;
  return build(0, firstInd)[0];
}

// ── C-2: the cadence ───────────────────────────────────────────────────────
describe("C-2 — a nightly reprice runs inside the daily refresh", () => {
  const path = ".github/workflows/daily-refresh.yml";
  const raw = read(path);
  const wf = parseYaml(raw);

  it("the refresh workflow parses and still carries both cron windows", () => {
    expect(wf).toBeTruthy();
    expect(wf.jobs).toBeTruthy();
    expect(Object.keys(wf.jobs)).toContain("deploy-and-refresh");
    // The ET-gated pair of UTC crons (EDT + EST) is the whole reason the
    // gate step exists; a reprice hung off a workflow with no schedule
    // would never run.
    expect(raw).toContain("cron: '0 9 * * *'");
    expect(raw).toContain("cron: '0 10 * * *'");
  });

  it("the reprice job exists and runs AFTER the refresh, not beside it", () => {
    const job = wf.jobs["reprice-holdings"];
    expect(job).toBeTruthy();
    // MUTATION: drop `needs`, and the reprice races the deploy — it would
    // price against yesterday's code, which is the ordering bug this whole
    // job exists to avoid.
    expect(job.needs).toBe("deploy-and-refresh");
  });

  it("a UTC trigger the ET gate closed reprices nothing", () => {
    const job = wf.jobs["reprice-holdings"];
    // Only one of the two cron entries is the real 5AM ET run. Without this
    // gate the other one would reprice the whole corpus a second time.
    expect(String(job.if)).toContain("needs.deploy-and-refresh.outputs.should_run");
    expect(wf.jobs["deploy-and-refresh"].outputs?.should_run).toBeTruthy();
  });

  it("the reprice sweeps EVERY user and is not silently pinned to one", () => {
    // MODE=all WINS over REPRICE_USER_ID (ALL_USERS is tested first), but the
    // job still sets no user id: relying on the script's internal ordering to
    // protect a corpus sweep is a coincidence, not a guarantee.
    // MUTATION: set REPRICE_USER_ID in this job.
    const repriceBlock = raw.slice(raw.indexOf("reprice-holdings:"));
    expect(repriceBlock).toContain("MODE: all");
    expect(repriceBlock).toContain("BACKFILL_APPLY: \"true\"");
    expect(repriceBlock).not.toMatch(/REPRICE_USER_ID:\s*user-/);
  });

  it("the RU / concurrency budget is set and stated", () => {
    const repriceBlock = raw.slice(raw.indexOf("reprice-holdings:"));
    expect(repriceBlock).toContain("REPRICE_CONCURRENCY");
    expect(repriceBlock).toContain("REPRICE_MAX_HOLDINGS");
    // The measured cost has to survive in the file — a budget nobody can
    // read is a budget nobody can revisit.
    expect(repriceBlock).toMatch(/RU/);
  });

  it("REPRICE_CONCURRENCY is READ by the script, not decorative", () => {
    // It was set in the workflow and read by nothing. A knob that appears to
    // bound a corpus sweep and does not is worse than no knob at all.
    //
    // MUTATION: delete the CONCURRENCY read from the script and this reds.
    const script = read("backend/scripts/reprice-user-holdings.cjs");
    expect(script).toContain("process.env.REPRICE_CONCURRENCY");
    // Only 1 is accepted; anything else refuses rather than being ignored.
    expect(script).toMatch(/CONCURRENCY !== 1/);
    expect(script).toMatch(/process\.exit\(1\)/);
  });

  it("the nightly lane skips fresh holdings whose pool has NOT grown", () => {
    // The bypass this closes: userThrottleMs:0 AND minHoldingAgeMs:0 on the
    // corpus sweep, so every holding was re-derived nightly whether or not
    // anything about it had changed.
    //
    // MUTATION: set minHoldingAgeMs back to 0 in the MODE=all branch and
    // this pin goes red.
    const script = read("backend/scripts/reprice-user-holdings.cjs");
    expect(script).toContain("NIGHTLY_MIN_HOLDING_AGE_MS");
    expect(script).toMatch(/20 \* 60 \* 60 \* 1000/);
    const allBranch = script.slice(script.indexOf("if (ALL_USERS)"), script.indexOf("console.log(`[reprice-user-holdings]`)"));
    expect(allBranch).toContain("minHoldingAgeMs: NIGHTLY_MIN_HOLDING_AGE_MS");
    expect(allBranch).toContain("skipFreshOnlyWhenPoolUnchanged: true");
    expect(allBranch).not.toMatch(/minHoldingAgeMs: 0/);
  });

  it("a MANUAL single-user dispatch keeps the full bypass", () => {
    // A human repricing after a calibration change is asking for every
    // number to be recomputed; a freshness skip there defeats the dispatch.
    const script = read("backend/scripts/reprice-user-holdings.cjs");
    const manualBranch = script.slice(script.indexOf("console.log(`[reprice-user-holdings]`)"));
    expect(manualBranch).toContain("minHoldingAgeMs: 0");
    expect(manualBranch).not.toContain("skipFreshOnlyWhenPoolUnchanged");
  });

  it("freshness never hides a market move: growth beats age", () => {
    // The guarantee that makes the skip safe. The service must re-check the
    // pool for every holding the age filter would drop, and must FAIL OPEN.
    //
    // MUTATION: delete the `live > 0` guard and a throttled Cosmos (which
    // returns 0 on a query error) starts reading as "nothing changed".
    const store = read("backend/src/services/portfolioiq/portfolioStore.service.ts");
    expect(store).toContain("skipFreshOnlyWhenPoolUnchanged");
    expect(store).toContain("countExactSalesInWindow");
    expect(store).toMatch(/poolUnchanged = live > 0 && live <= \(persistedCount as number\)/);
    // Any throw reprices rather than skipping.
    expect(store).toMatch(/catch \{\s*\n\s*poolUnchanged = false;/);
  });

  it("both workflows state the REAL precedence: MODE=all wins", () => {
    // The comments said the opposite of what the script does — the script
    // tests ALL_USERS first and returns from that branch, so MODE=all wins
    // and a REPRICE_USER_ID beside it is ignored. A wrong comment about
    // precedence is how a corpus sweep becomes a one-user run in someone's
    // head while the code is fine.
    const runner = read(".github/workflows/backfill-runner.yml");
    expect(runner).toMatch(/MODE=all WINS/);
    expect(runner).not.toMatch(/script prefers REPRICE_USER_ID over MODE/);
    expect(raw).toMatch(/MODE=all\n\s*#\s*WINS|MODE=all\s+WINS/);
    expect(raw).not.toMatch(/the script prefers it over MODE/);
    // And the script's own docblock agrees.
    const script = read("backend/scripts/reprice-user-holdings.cjs");
    expect(script).toMatch(/MODE=all WINS/);
  });

  it("secrets reach the job from App Service, never from the repo", () => {
    const repriceBlock = raw.slice(raw.indexOf("reprice-holdings:"));
    expect(repriceBlock).toContain("az webapp config appsettings list");
    expect(repriceBlock).toContain("::add-mask::");
    expect(repriceBlock).not.toMatch(/COSMOS_CONNECTION_STRING=[A-Za-z]/);
  });
});

// ── C-7: the legacy writer ─────────────────────────────────────────────────
describe("C-7 — every persisted value names its rung and its source", () => {
  const ebayAuto = read("backend/src/services/portfolioiq/ebayAutoHolding.service.ts");
  const reviewQueue = read("backend/src/services/portfolioiq/ebayReviewQueue.service.ts");
  const valuation = read("backend/src/services/portfolioiq/holdingValuation.ts");

  it("the eBay import writer routes through the one entry", () => {
    // Measured on prod 2026-09-03: ALL 52 key-absent holdings are
    // source="ebay-auto" / cardStatus="pending-review" — created by this
    // writer and never priced by anything.
    //
    // MUTATION: restore the old writer path — replace the
    // valueHoldingThroughOneEntry call with `doc.holdings[holding.id] =
    // holding;` — and this pin goes red, as does RUNG-HONESTY below.
    expect(ebayAuto).toContain("valueHoldingThroughOneEntry");
    expect(ebayAuto).toContain("doc.holdings[holding.id] = priced;");
    expect(ebayAuto).not.toMatch(/doc\.holdings\[holding\.id\] = holding;/);
  });

  it("confirming a review-queue holding prices what it activates", () => {
    // Confirm activates a pending-review import, so something must price it.
    // That something is repriceOneHolding, fired by BOTH confirm routes —
    // which runs autoPriceHolding and therefore stamps fmvRung/valueSource on
    // the sanctioned path. Pricing again inside confirmHoldingReview would be
    // a duplicate engine call per approval on the awaited path.
    //
    // MUTATION: delete either `void repriceOneHolding(...)` from the routes
    // and an approved holding goes live unpriced again.
    const routes = read("backend/src/routes/portfolioiq.erp.routes.ts");
    const confirmRoutes = routes.match(/repriceOneHolding/g) ?? [];
    expect(confirmRoutes.length).toBeGreaterThanOrEqual(2); // single + batch
    // And the service must NOT re-price on the awaited path.
    expect(reviewQueue).not.toContain("valueHoldingThroughOneEntry(holding");
  });

  it("both one-entry write shapes stamp valueSource beside fmvRung", () => {
    // valueSource was absent on all 129 live holdings: the engine computes
    // it and every holding writer dropped it. Both shapes now go through
    // writeHoldingValuation, which REQUIRES the pair.
    expect(valuation).toContain("writeHoldingValuation");
    expect(valuation).toMatch(/rung: \{ rung: v\.rungLabel \},\s*(\/\/[^\n]*\n\s*)*valueSource: "observed"/);
    // CF-RUNG-IS-THE-VOCABULARY (#1690): the estimate write no longer hardcodes
    // `grade-curve-estimate`. That literal named ONE fallback rung, and the
    // helper it feeds was then asked to persist every other one — a player-trend
    // estimate, a family baseline, a graded-to-raw rung — under a label that did
    // not describe them, which is how a priced card came back showing no price.
    // The write now carries `v.rungLabel`, so the rung the ladder actually
    // reached is the rung persisted.
    //
    // What C-7 pins is unchanged and is the pairing: a write that names a rung
    // names its valueSource in the same literal. So this asserts the estimated
    // write states BOTH, with the rung read from the valuation rather than
    // frozen to one label.
    expect(valuation).toMatch(/rung: \{ rung: v\.rungLabel \},\s*(\/\/[^\n]*\n\s*)*valueSource: "estimated"/);
  });

  it("valueSource is part of the holding contract, not an untyped extra", () => {
    const types = read("backend/src/types/portfolioiq.types.ts");
    expect(types).toContain("valueSource?:");
    expect(types).toMatch(/valueSource\?: "observed" \| "estimated" \| null/);
  });

  it("RUNG-HONESTY goes red on a value that carries no rung key", () => {
    const inv = read("backend/scripts/lib/pricing-invariants.cjs");
    // The check used to `return []` the instant a holding had no rung, so
    // the 53 key-absent holdings were the one shape it could never see.
    //
    // MUTATION: restore the early `if (rung === null) return violations;`
    // to the top of checkRungHonesty and this pin goes red.
    expect(inv).toContain("value-carries-no-rung");
    expect(inv).toContain('!("fmvRung" in holding)');
    const fn = inv.slice(inv.indexOf("function checkRungHonesty"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    // The missing-key finding must be pushed BEFORE the null-rung early
    // return, or it can never fire.
    expect(body.indexOf("value-carries-no-rung"))
      .toBeLessThan(body.indexOf("if (rung === null) return violations;"));
  });

  it("an explicit null rung stays legitimate and is NOT flagged", () => {
    const inv = read("backend/scripts/lib/pricing-invariants.cjs");
    // `fmvRung: null` is a lane HONESTLY naming no rung (the resolver
    // fallback, the ladder). Only an ABSENT key means a legacy writer.
    // Conflating the two would flag every honest lane as a defect.
    expect(inv).toContain("if (rung === null) return violations;");
  });

  // ── The helper itself: the contract, exercised rather than grepped ────────
  it("writeHoldingValuation stamps rung + valueSource on EVERY write", () => {
    // The behavioural core of C-7. A value cannot reach a holding without
    // both keys, because both are required arguments.
    const h = { id: "h1", playerName: "Devin Taylor" } as any;
    const observed = writeHoldingValuation(h, {
      fairMarketValue: 251,
      rung: { rung: "exact-pool-last-sale" },
      valueSource: "observed",
      nowIso: "2026-09-03T16:00:00.000Z",
      meta: { slug: "hiq:baseball:2025:bowman-chrome:cpa-dt:black-refractor:auto", compsUsed: 4 },
    });
    expect(observed.fairMarketValue).toBe(251);
    expect(observed.fmvRung).toBe("exact-pool-last-sale");
    expect(observed.valueSource).toBe("observed");
    // The meta's `method` is the SAME rung — one vocabulary in both fields,
    // which is what made the dashboard render `unknown rung "direct-slug"`.
    expect((observed as any).pricingSourceMeta.method).toBe("exact-pool-last-sale");
    expect((observed as any).fmvRungAbsentReason).toBeNull();
  });

  it("an explicit refusal persists null WITH its reason — never an absent key", () => {
    const h = { id: "h2" } as any;
    const refused = writeHoldingValuation(h, {
      fairMarketValue: 68.68,
      rung: { noRung: "resolver fallback (cardsight) names no rung" },
      valueSource: "estimated",
      nowIso: "2026-09-03T16:00:00.000Z",
      writeMeta: false,
    });
    // The KEY is present and null: the auditor's "honest lane" case, which
    // must stay unflagged, as distinct from a key that was never written.
    expect("fmvRung" in refused).toBe(true);
    expect(refused.fmvRung).toBeNull();
    expect("valueSource" in refused).toBe(true);
    expect(refused.valueSource).toBe("estimated");
    expect((refused as any).fmvRungAbsentReason).toContain("names no rung");
  });

  it("a caller's spread cannot overwrite the rung or the valueSource", () => {
    // The ordering guarantee. `fields` is merged UNDER the contract, so a
    // legacy literal carrying its own stale fmvRung cannot win — which is
    // exactly how eleven hand-assembled literals drifted apart.
    const h = { id: "h3", fmvRung: "stale-rung", valueSource: "observed" } as any;
    const out = writeHoldingValuation(h, {
      fairMarketValue: 10,
      rung: { rung: "sibling-estimate" },
      valueSource: "estimated",
      nowIso: "2026-09-03T16:00:00.000Z",
      writeMeta: false,
      fields: { fmvRung: "hijacked", valueSource: "observed" } as any,
    });
    expect(out.fmvRung).toBe("sibling-estimate");
    expect(out.valueSource).toBe("estimated");
  });

  it("every persisted-value writer in portfolioStore routes through the helper", () => {
    // MUTATION: restore any one hand-assembled literal — e.g. put
    // `fairMarketValue: match.price, fmvRung: "sibling-estimate",` back at
    // the sibling site — and this pin goes red.
    //
    // The census that motivates it: valueSource absent on 129/129 live
    // holdings, fmvRung key absent on 53, 73 holdings carrying a value with
    // one or both missing. Two of them (60a7cfcc, afbebf9c) were written
    // that same morning by these very sites.
    const store = read("backend/src/services/portfolioiq/portfolioStore.service.ts");
    // No raw `fairMarketValue:` assignment may sit in an object literal
    // beside a raw `fmvRung:` — that pairing IS the hand-assembled shape.
    //
    // `\r?\n`, not `\n`: this checkout stores the file CRLF, and the first
    // draft of this pin used `\n` and therefore matched NOTHING — it passed
    // against a deliberately re-broken sibling site. A pin that cannot fail
    // is not a pin. (Same CRLF trap as d38.addHoldingEmitCarriesBasis.)
    //
    // Two shapes are legitimately exempt and are NOT persisted values:
    //   `fairMarketValue: null as any` — a value CLEAR (the unidentified-card
    //      withhold), which writes no number and names its null rung; and
    //   `fairMarketValue: typeof h.fairMarketValue === "number" ? ...` — the
    //      read-only prior-state snapshots the alert sweep compares against.
    // Everything else pairing a written value with a hand-written `fmvRung:`
    // is the hand-assembled shape this pin forbids.
    const rawPairs = (store.match(/fairMarketValue: [^\r\n]*,\r?\n\s*fmvRung:/g) ?? [])
      .filter((m) => !/fairMarketValue: null as any,/.test(m))
      .filter((m) => !/fairMarketValue: typeof h\.fairMarketValue/.test(m));
    expect(rawPairs).toEqual([]);
    // And the helper is actually used at the sites the audit named.
    expect(store).toContain("writeHoldingValuation");
    // TWELVE sites, not the eleven the audit first named: the batch lane's
    // second unified write was found by an existing pin in
    // siblingEstimateNeverOutranksExactPool when the first pass missed it.
    const calls = store.match(/writeHoldingValuation\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(12);
  });

  it("RUNG-HONESTY sees a value carried by estimatedValue, not just FMV", () => {
    // C-7 verifier: reading only `fairMarketValue` reopened the blind spot.
    // Live proof, holding 0a9afe09: fairMarketValue null, estimatedValue 241,
    // meta.method "rare-card-anchor", no fmvRung key at all.
    //
    // MUTATION: narrow `persistedNumber` back to fairMarketValue only and
    // this pin goes red.
    const inv = read("backend/scripts/lib/pricing-invariants.cjs");
    expect(inv).toContain("persistedNumber");
    expect(inv).toMatch(/estimatedValue === "number" && holding\.estimatedValue > 0/);
  });
});

// ── H-9: the trail reap ────────────────────────────────────────────────────
describe("H-9 — a deleted holding keeps no price trail", () => {
  const store = read("backend/src/services/portfolioiq/portfolioStore.service.ts");
  const reviewQueue = read("backend/src/services/portfolioiq/ebayReviewQueue.service.ts");
  const script = read("backend/scripts/reap-orphan-price-trails.cjs");

  it("the reaper exists and removes exactly the one trail", () => {
    expect(store).toContain("export function reapPriceTrail");
    expect(store).toContain("delete doc.priceHistoryByHolding[holdingId]");
  });

  it("EVERY delete site reaps its trail", () => {
    // MUTATION: remove any single reapPriceTrail call above a
    // `delete doc.holdings[...]` and this pin goes red.
    //
    // Five sites: deleteHolding, sellHolding (sold out), the ERP sell
    // mirror, the trade lane's outgoing side, and the review-queue reject.
    // Count CODE, not prose: the helper's own doc comment quotes
    // `delete doc.holdings[id]` to say what it pairs with, and a comment is
    // not a call site.
    const code = store.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const storeDeletes = code.match(/delete doc\.holdings\[/g) ?? [];
    const storeReaps = code.match(/reapPriceTrail\(doc, /g) ?? [];
    expect(storeDeletes.length).toBe(4);
    expect(storeReaps.length).toBe(4);

    expect(reviewQueue).toContain("reapPriceTrail(doc, holdingId);");
    const rqDeletes = reviewQueue.match(/delete doc\.holdings\[/g) ?? [];
    expect(rqDeletes.length).toBe(1);
  });

  it("the repair script is report-first and writes nothing without the gate", () => {
    expect(script).toContain('BACKFILL_APPLY === "true"');
    expect(script).toContain("REPORT-ONLY");
    // The report path must return before any write.
    const reportIdx = script.indexOf("if (!APPLY) {");
    const writeIdx = script.indexOf(".replace(p.doc)");
    expect(reportIdx).toBeGreaterThan(-1);
    expect(reportIdx).toBeLessThan(writeIdx);
  });

  it("the apply path is reconciled: intended = written + skipped + failed", () => {
    // CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW. A sweep that dropped its writes
    // must be red, not green.
    expect(script).toContain("reportWrites({");
    expect(script).toContain("intended: intendedTrails");
    expect(script).toContain("written,");
    expect(script).toContain("skipped,");
    expect(script).toContain("failed,");
  });

  it("the apply path verifies by read before counting a write", () => {
    expect(script).toContain("container.item(p.doc.id, p.userId).read()");
    expect(script).toContain("remaining.length > 0");
    // A doc whose orphans survived the write is FAILED, never written.
    const verifyBlock = script.slice(script.indexOf("remaining.length > 0"));
    expect(verifyBlock.slice(0, 200)).toContain("failed +=");
  });

  it("the reap script is dispatchable through the existing runner lane", () => {
    const runner = read(".github/workflows/backfill-runner.yml");
    expect(runner).toContain("- reap-orphan-price-trails");
    // NO new workflow_dispatch input: GitHub caps at 25 and the runner
    // carries 24. The script's optional one-user scope rides REPRICE_USER_ID.
    const inputsBlock = runner.slice(runner.indexOf("    inputs:"), runner.indexOf("\njobs:"));
    const inputNames = (inputsBlock.match(/^      [a-z_]+:$/gm) ?? []).length;
    expect(inputNames).toBe(24);
  });
});
