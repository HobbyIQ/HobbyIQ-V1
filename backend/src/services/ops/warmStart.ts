/**
 * CF-THE-FIRST-USER-SHOULD-NOT-PAY-FOR-THE-DEPLOY (Fable, 2026-09-15).
 *
 * THE DEFECT. For roughly the first 4.5 minutes after every restart, pricing
 * requests took 14-22 s (direct-comps 21.6 s at +2.8 min, setdoc-baseline
 * 22.1 s at +4.5 min) and then settled to 2.9 s / 0.5 s once warm. Nothing is
 * wrong with the warm numbers; the problem is that a real user hitting the app
 * during a deploy pays the entire warm-up, one lazy singleton at a time,
 * inside their own request.
 *
 * MEASURED on a cold process, driving the built app through one valuation
 * (each phase timed separately, warm disk, so these are floors not ceilings):
 *
 *   require("applicationinsights")              1,287 ms
 *   first bareColourAliasFromChecklist call     1,392 ms
 *   import the ladder module graph                585 ms
 *   import @azure/cosmos                          396 ms
 *   first statedFinishFromChecklist call          289 ms   (37,849 names)
 *   first valueIdentity, cold caches            1,118 ms
 *   the same call once warm                       730 ms
 *
 * Every one of those is paid EXACTLY ONCE per process and then never again —
 * which is what makes them warm-up rather than a performance bug, and also
 * what makes them trivially pre-payable. The only question is who pays: the
 * deploy, or whichever user happens to arrive first.
 *
 * WHAT THIS DOES. Runs the same work at boot, off the request path, so the
 * singletons are already built when the first request arrives. Deliberately:
 *
 *   - AFTER `app.listen`, not before. Blocking readiness would trade a slow
 *     first request for a late-arriving container, and App Service's health
 *     probe would be the thing waiting instead of a user. Warm-up is a
 *     best-effort optimisation and must never delay or fail the boot.
 *   - Read-only. It parses fixed strings and touches in-process caches. It
 *     issues NO Cosmos query and NO vendor call, so it cannot write, cannot
 *     cost RU, and cannot behave differently against prod than against a
 *     local box.
 *   - Fully guarded. Every step is individually try/caught: a warm-up that
 *     throws must never take down a process that would otherwise serve
 *     traffic. A failed step logs and the next one still runs.
 *   - Idempotent and cheap to re-run, so the deploy workflow's existing
 *     "Warm DailyIQ cache" step can also hit `/api/health/warm` without
 *     doubling any cost.
 *
 * WHAT IT DOES NOT FIX. The process still restarts, and requests that arrive
 * in the window between the restart and this finishing will still be slow. A
 * true zero-cold-start deploy needs a deployment-slot swap (App Service warms
 * the staging slot, then swaps it into production), and `az webapp deployment
 * slot list` reports NO slots configured on HobbyIQ3 today. Creating one is a
 * live production config change, so it is Drew's call, not this PR's.
 */

type WarmStep = { label: string; ms: number; ok: boolean; error?: string };

/** Fixed, representative inputs. Never a real user's query. */
const WARM_TITLE = "2024 Bowman Chrome Shohei Ohtani Gold Refractor Auto /50";

async function step(label: string, fn: () => unknown | Promise<unknown>): Promise<WarmStep> {
  const startedAt = Date.now();
  try {
    await fn();
    return { label, ms: Date.now() - startedAt, ok: true };
  } catch (err) {
    return { label, ms: Date.now() - startedAt, ok: false, error: (err as Error)?.message ?? String(err) };
  }
}

/**
 * Build the expensive process-wide singletons. Resolves when done; never
 * rejects. Safe to call more than once — each underlying build memoises, so a
 * second call is a no-op that costs a few milliseconds.
 */
export async function warmStart(): Promise<{ totalMs: number; steps: WarmStep[] }> {
  const startedAt = Date.now();
  const steps: WarmStep[] = [];

  // The two checklist corpora. Both build a token index on FIRST call and are
  // memoised after — 1,392 ms and 289 ms measured cold. Driven through their
  // public entry points, because that is what a request does; calling the
  // private builders would warm something subtly different.
  steps.push(await step("checklist-parallel-corpus", async () => {
    const m = await import("../portfolioiq/statedFinishFromChecklist.js");
    m.statedFinishFromChecklist?.(WARM_TITLE);
  }));
  steps.push(await step("bare-colour-alias-corpus", async () => {
    const { bareColourAliasFromChecklist } = await import("../portfolioiq/bareColourAliasFromChecklist.js");
    // The context is NOT decorative. This function returns null before it ever
    // calls loadMap() when `year` or `setKey` is missing, so a bare
    // `fn(title)` would warm nothing at all and the 1,392 ms would still be
    // waiting for the first real request. A representative (year, setKey) is
    // what actually forces the map to build.
    bareColourAliasFromChecklist(WARM_TITLE, { year: 2024, setKey: "bowman-chrome" });
  }));

  // The free-text parser's own memo and regex tables.
  steps.push(await step("card-query-parser", async () => {
    const m = await import("../compiq/cardQueryParser.js");
    m.parseCardQuery?.("2024 Bowman Chrome Ohtani Base");
  }));

  // The ladder's module graph — 585 ms of import cost that a first valuation
  // would otherwise pay inline. Importing is the whole point; nothing is
  // called, so no query is issued.
  steps.push(await step("valuation-module-graph", async () => {
    await import("../compiq/oneValuationPath.service.js");
    await import("../portfolioiq/hobbyIqFmv.service.js");
  }));

  const totalMs = Date.now() - startedAt;
  console.warn(JSON.stringify({
    event: "warm_start_complete",
    source: "warmStart",
    totalMs,
    steps: steps.map((s) => ({ label: s.label, ms: s.ms, ok: s.ok, ...(s.error ? { error: s.error } : {}) })),
  }));
  return { totalMs, steps };
}
