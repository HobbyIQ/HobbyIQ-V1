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
 *   - Read-only. It parses fixed strings, touches in-process caches, and makes
 *     exactly TWO Cosmos POINT READS — never a query, never a write, so it
 *     cannot mutate anything and its RU cost is ~2 RU per boot. See
 *     CF-A-WARM-PROCESS-HAS-AN-OPEN-CONNECTION below for why those two reads
 *     had to be added.
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

/**
 * CF-A-WARM-PROCESS-HAS-AN-OPEN-CONNECTION (Fable, 2026-09-16).
 *
 * THE GAP THIS CLOSES, and it was mine. The original warm-up deliberately
 * issued no Cosmos call at all — a guarantee of zero RU and zero write risk.
 * That guarantee is exactly what left the expensive half cold.
 *
 * Slot-smoke run 35037265421 (sha 09d9a765) is the evidence. The sha-match poll
 * worked (4 polls, so it really was the new process), `/api/health/warm`
 * reported `totalMs: 13`, and then smoke cases 5 and 7 came back
 * `catalog-lookup-timeout` after 3,161 ms and 3,057 ms — the per-query catalog
 * ceiling (`PRICE_LOOKUP_PER_QUERY_MS` = `DEFAULT_LADDER_BUDGET.perRungMs` =
 * 3,000 ms) plus overhead.
 *
 * `totalMs: 13` was TRUTHFUL ABOUT WHAT IT MEASURED AND SILENT ABOUT WHAT IT
 * DID NOT. It said the in-process singletons were built. It never claimed the
 * Cosmos client was constructed, the account endpoint resolved, or a
 * container's partition-key map fetched — and on a fresh process every one of
 * those is cold, paid by whichever request arrives first. That request was a
 * smoke case, and it aborted at the deadline.
 *
 * So the warm-up now opens the connection it was avoiding: ONE POINT READ per
 * hot container. A point read, not a query — it is the cheapest call that
 * forces the whole cold path (client construction, endpoint resolution,
 * partition-key ranges, TLS handshake, auth token) and it costs ~1 RU whether
 * the document exists or not. A 404 is a perfectly good warm: the round trip
 * is the point, not the row.
 *
 * The deadline is deliberately NOT raised to accommodate a cold process. 3 s is
 * correct for a warm one, and re-baselining it to cold would mask this defect
 * and slow every genuine refusal. Warm the path instead.
 */
type WarmStep = { label: string; ms: number; ok: boolean; error?: string };

/** Fixed, representative inputs. Never a real user's query. */
const WARM_TITLE = "2024 Bowman Chrome Shohei Ohtani Gold Refractor Auto /50";

/**
 * A real, stable `hiq:` slug used only as a point-read address.
 *
 * It does not need to EXIST. `container.item(id, pk).read()` performs the full
 * cold-path work either way, and a 404 is caught below and still recorded as a
 * successful warm — because what is being warmed is the connection, not a
 * cache of this row.
 */
const WARM_CATALOG_ID = "hiq:baseball:2024:bowman-chrome:85:base:no-auto";

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
/**
 * CF-A-WARM-THAT-TIMED-OUT-IS-NOT-A-WARM (Fable, 2026-09-18).
 *
 * A Cosmos warm step that takes this long did not warm anything — it hit
 * `COSMOS_REQUEST_TIMEOUT_MS` (20,000 ms, from the connection policy, which
 * applies on App Service because WEBSITE_SITE_NAME is set). 15 s is
 * comfortably above every healthy reading measured (prod: 20 consecutive
 * samples, max 4 ms; a healthy slot instance: 3-22 ms) and comfortably below
 * the 20 s ceiling, so it cannot fire on a slow-but-working call.
 */
const WARM_COSMOS_SLOW_MS = 15_000;

/**
 * A short, stable identifier for the App Service worker serving this process.
 *
 * WHY THIS EXISTS. Four of five slot deploys refused the swap because the smoke
 * timed out, while `/api/health/warm` reported `"ok":true`. It was reporting
 * `ok` on a warm whose two Cosmos steps had taken 20,003 ms and 20,005 ms —
 * i.e. had TIMED OUT — because each step is individually guarded and a failed
 * step is recorded rather than fatal.
 *
 * Underneath that was a second fact no endpoint could show: the plan runs TWO
 * instances, there is no ARR affinity, so the warm call and the smoke call
 * round-robin independently. Warming one instance proves nothing about the one
 * the smoke lands on. Measured on prod's own telemetry, last 3 h:
 *
 *   instance a549df3a…   calls 15,080   >=20s 280   p99 20,000 ms
 *   instance 6fd4f9ab…   calls 21,850   >=20s   0   p99    121 ms
 *
 * Without an instance id in the response there is no way to prove a warm
 * covered both workers. `WEBSITE_INSTANCE_ID` is a 64-char platform value;
 * only a short hash is exposed — enough to DISTINGUISH instances and to match
 * against `cloud_RoleInstance` in App Insights, without publishing the raw id.
 */
/** Exported so `/api/health` reports the SAME tag this warm does. Two
 *  definitions of "which instance answered" would be two answers, and the
 *  deploy gate compares them across endpoints. */
export function instanceTag(): string | null {
  const raw = String(process.env.WEBSITE_INSTANCE_ID ?? "").trim();
  return raw ? raw.slice(0, 8) : null;
}

export async function warmStart(): Promise<{
  ok: boolean;
  totalMs: number;
  instance: string | null;
  failedSteps: string[];
  steps: WarmStep[];
}> {
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

  // The two Cosmos containers the price path actually touches, each as its OWN
  // step so its ms is separately visible. That separation is the point: a
  // single aggregate `totalMs: 13` is what let a cold catalog path look warm,
  // and a reader can now see at a glance whether the expensive half ran.
  //
  // A failed read still counts as a warm attempt — the connection work happens
  // before the 404 — so these are guarded and their error is recorded rather
  // than swallowed.
  steps.push(await step("cosmos-card-catalog", async () => {
    const { getCardCatalogContainer } = await import("../portfolioiq/cardCatalog.service.js");
    const container = await getCardCatalogContainer();
    if (!container) return;                       // no connection string: nothing to warm
    // Point read, never a query: ~1 RU, and it forces client construction,
    // endpoint resolution, the partition-key map, TLS and auth all at once.
    // card_catalog partitions on /cardId, and a checklist-minted row has
    // cardId === id, so this is the row's own address.
    await container.item(WARM_CATALOG_ID, WARM_CATALOG_ID).read().catch(() => undefined);
  }));

  steps.push(await step("cosmos-sold-comps", async () => {
    const { CosmosClient } = await import("@azure/cosmos");
    const { cosmosOptionsFromConnectionString } = await import("./cosmosConnectionPolicy.js");
    const conn = process.env.COSMOS_CONNECTION_STRING;
    if (!conn) return;
    const container = new CosmosClient(cosmosOptionsFromConnectionString(conn))
      .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
      .container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
    // sold_comps partitions on /cardId. The id need not exist — see above.
    await container.item(WARM_CATALOG_ID, WARM_CATALOG_ID).read().catch(() => undefined);
  }));

  const totalMs = Date.now() - startedAt;

  // CF-A-WARM-THAT-TIMED-OUT-IS-NOT-A-WARM. A Cosmos step counts as FAILED
  // when it threw OR when it took >= WARM_COSMOS_SLOW_MS, because a step that
  // sat on the 20 s request ceiling did not open the connection it was there to
  // open. Reporting `ok:true` for that is what let four slot deploys smoke a
  // process whose Cosmos path was stone cold.
  //
  // Only the `cosmos-` steps get the duration rule: the in-process ones are
  // pure CPU and a slow one is still a completed one.
  const failedSteps = steps
    .filter((s) => !s.ok || (s.label.startsWith("cosmos-") && s.ms >= WARM_COSMOS_SLOW_MS))
    .map((s) => `${s.label}=${s.ms}ms${s.ok ? " (timed out)" : ` (${s.error ?? "error"})`}`);
  const ok = failedSteps.length === 0;
  const instance = instanceTag();

  console.warn(JSON.stringify({
    event: "warm_start_complete",
    source: "warmStart",
    ok,
    instance,
    totalMs,
    failedSteps,
    steps: steps.map((s) => ({ label: s.label, ms: s.ms, ok: s.ok, ...(s.error ? { error: s.error } : {}) })),
  }));
  return { ok, totalMs, instance, failedSteps, steps };
}
