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
    // reprice-user-holdings prefers REPRICE_USER_ID over MODE, so a stray
    // user id here would turn the corpus sweep into a single-user run that
    // still reported success. MUTATION: set REPRICE_USER_ID in this job.
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
    // valueSource was absent on all 118 live holdings: the engine computes
    // it and every holding writer dropped it.
    expect(valuation).toMatch(/fmvRung: v\.rungLabel,\s*(\/\/[^\n]*\n\s*)*valueSource: "observed"/);
    expect(valuation).toMatch(/fmvRung: "grade-curve-estimate",\s*(\/\/[^\n]*\n\s*)*valueSource: "estimated"/);
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
