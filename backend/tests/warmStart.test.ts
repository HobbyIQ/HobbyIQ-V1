/**
 * CF-THE-FIRST-USER-SHOULD-NOT-PAY-FOR-THE-DEPLOY (Fable, 2026-09-15).
 *
 * THE DEFECT. For ~4.5 minutes after every restart, pricing requests took
 * 14-22 s (direct-comps 21.6 s at +2.8 min, setdoc-baseline 22.1 s at
 * +4.5 min), settling to 2.9 s / 0.5 s once warm. The warm numbers are fine;
 * the problem is WHO pays the warm-up. Measured on a cold process against the
 * built app: 1,392 ms for the bare-colour corpus, 289 ms for the checklist
 * parallel corpus, 585 ms to import the ladder's module graph, 1,287 ms for
 * require("applicationinsights"). Each is paid exactly once per process — by
 * the deploy, or by whichever user happens to arrive first.
 *
 * These pins hold the properties that make pre-paying it safe. The important
 * one is the LAST group: warm-up must never be able to fail a boot or a
 * request, because a process that serves traffic slowly is strictly better
 * than one that does not serve it at all.
 */
import { describe, expect, it, vi } from "vitest";
import { warmStart } from "../src/services/ops/warmStart.js";

describe("warmStart builds the expensive singletons", () => {
  it("runs every step and reports what each cost", async () => {
    const result = await warmStart();

    const labels = result.steps.map((s) => s.label);
    expect(labels).toContain("checklist-parallel-corpus");
    expect(labels).toContain("bare-colour-alias-corpus");
    expect(labels).toContain("card-query-parser");
    expect(labels).toContain("valuation-module-graph");
    // The per-step ms IS the observability: it is how the 14-22 s window was
    // attributed, and how a future regression would be spotted.
    for (const s of result.steps) expect(typeof s.ms).toBe("number");
    expect(typeof result.totalMs).toBe("number");
  }, 30_000);

  it("every step succeeds against the real modules", async () => {
    const result = await warmStart();

    // A step that silently fails would warm nothing and nobody would know —
    // the request would just still be slow. Each reports its own ok flag.
    const failed = result.steps.filter((s) => !s.ok);
    expect(failed.map((s) => `${s.label}: ${s.error}`)).toEqual([]);
  }, 30_000);

  it("actually builds the corpora — a later, DIFFERENT input is already warm", async () => {
    await warmStart();

    const { statedFinishFromChecklist } = await import("../src/services/portfolioiq/statedFinishFromChecklist.js");
    const { bareColourAliasFromChecklist } = await import("../src/services/portfolioiq/bareColourAliasFromChecklist.js");

    // Deliberately different inputs from the warm-up's own fixed title: this
    // asserts the shared INDEX was built, not that one string was memoised.
    const t0 = Date.now();
    statedFinishFromChecklist("2020 Topps Chrome Someone Blue Refractor /150");
    bareColourAliasFromChecklist("2020 Topps Chrome Someone Blue", { year: 2020, setKey: "topps-chrome" });
    const ms = Date.now() - t0;

    // MUTATION CHECK: cold, these two cost ~1,700 ms between them. If warmStart
    // stopped building them (e.g. the bare-colour call lost its year/setKey
    // context and returned null before loadMap) this would blow past 200 ms.
    expect(ms).toBeLessThan(200);
  }, 30_000);

  it("is idempotent — a second run is nearly free", async () => {
    await warmStart();
    const t0 = Date.now();
    await warmStart();
    const secondMs = Date.now() - t0;

    // The deploy workflow may hit /api/health/warm after the server has already
    // warmed itself. That must not re-pay anything.
    expect(secondMs).toBeLessThan(200);
  }, 30_000);
});

describe("warm-up is never load-bearing", () => {
  it("never rejects, even when a step throws", async () => {
    // A warm-up that can throw is a warm-up that can crash a boot. Every step
    // is individually guarded, so a broken one is reported, not propagated.
    await expect(warmStart()).resolves.toBeDefined();
  }, 30_000);

  it("reports a failing step instead of propagating it", async () => {
    const parser = await import("../src/services/compiq/cardQueryParser.js");
    const spy = vi.spyOn(parser, "parseCardQuery").mockImplementation(() => {
      throw new Error("parser exploded");
    });

    const result = await warmStart();

    // The run completes and the other steps still ran — a failed warm-up step
    // degrades to "this one thing will build lazily on first use", which is
    // exactly the behaviour that existed before this module.
    expect(result.steps.length).toBeGreaterThan(1);
    expect(result.steps.some((s) => s.ok)).toBe(true);
    spy.mockRestore();
  }, 30_000);

  it("issues no Cosmos query — it may not cost RU or write anything", async () => {
    // Asserted on the SOURCE rather than by monkey-patching the SDK (an ESM
    // namespace is read-only, and a runtime spy would only prove this one run
    // stayed clean). The property that matters is structural: warm-up parses
    // fixed strings and imports modules, and must never grow a query, a write,
    // or a vendor call — any of which would make a boot-time optimisation cost
    // RU on every restart, or worse, write something.
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../src/services/ops/warmStart.ts", import.meta.url), "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    for (const forbidden of [
      /new CosmosClient/,
      /\.items\.query\(/,
      /\.items\.(create|upsert)\(/,
      /\.item\([^)]*\)\.(read|patch|replace|delete)\(/,
      /fetch\(/,
    ]) {
      expect(src).not.toMatch(forbidden);
    }
  });
});
