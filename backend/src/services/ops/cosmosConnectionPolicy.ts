// CF-COSMOS-PING-VOLUME (2026-09-07). The connection policy that stops the
// 1 ms Cosmos gateway "GET /" dependency flood at its SOURCE.
//
// WHY THE SPAN FILTER DID NOT WORK. #1982 added a SpanProcessor
// (services/ops/cosmosPingSpanFilter) to clear the SAMPLED flag on these
// spans. The processor is correct and its tests pass — but it never sees
// these rows. Measured after that deploy:
//
//   dependencies | summarize by sdkVersion
//     ali_node:2.9.6                 195,600   <- these are the pings
//     alm_node22:otel2.1.0:dst1.16.0     117   <- the in-process SDK
//
// `ali_node:2.9.6` is the App Service **agent extension**
// (ApplicationInsightsAgent_EXTENSION_VERSION=~3, set on BOTH HobbyIQ3 and
// hobbyiq3-worker), a separate collector that attaches outside the process
// and exports on its own pipeline. A span processor registered inside
// `useAzureMonitor()` governs the in-process OTel provider only, so it
// cannot suppress a row the agent minted. No amount of fixing the filter
// reaches them. The only durable fix is to stop MAKING the calls.
//
// WHAT ACTUALLY EMITS THEM. `GlobalEndpointManager.resolveServiceEndpoint`
// (@azure/cosmos 4.9.3, globalEndpointManager.js) opens with:
//
//     if (this.readableLocations.length === 0 || this.writeableLocations.length === 0) {
//       ... readDatabaseAccount({ urlConnection: this.defaultEndpoint })   // GET /
//     }
//
// That cache is per-CosmosClient. When it populates, the cost is ~2 root GETs
// for the life of the client. When it does NOT populate, EVERY operation
// re-issues the root GET. Reproduced locally against a stubbed transport
// (no network), 20 operations on one client:
//
//     locations cached      ->   2 root GETs
//     locations not cached  ->  80 root GETs   (4 per operation)
//     enableEndpointDiscovery:false -> 0 root GETs, in BOTH cases
//
// Production matched the pathological case exactly, and only on the worker:
//
//   role              real Cosmos ops   "GET /" pings
//   HobbyIQ3                   24,084             257    (healthy, 1:94)
//   hobbyiq3-worker             6,828          78,609    (inverted, 11.5:1)
//
// and by target — the worker talks to the GLOBAL endpoint, the API to the
// regional one, which is the same fact seen from the other side:
//
//   hobbyiq3-worker  hobbyiq-comps.documents.azure.com          304,900
//   HobbyIQ3         hobbyiq-comps-centralus.documents.azure.com 56,428
//
// hobbyiq3-worker is where STAGING_DRAINER_ENABLED=true and
// STAGING_DRAINER_WORKERS=16, so sixteen batch loops re-resolve the endpoint
// on essentially every operation: a flat ~16,000 pings/minute that does not
// track request traffic.
//
// WHY TURNING DISCOVERY OFF IS SAFE HERE — and it is a real question, since
// discovery is what gives a client regional failover. `hobbyiq-comps` is a
// SINGLE-REGION account:
//
//     az cosmosdb show --name hobbyiq-comps -g rg-hobbyiq-dev
//       locations: [Central US]   writeLocations: [Central US]
//       enableMultipleWriteLocations: false
//
// There is no second region to discover, prefer, or fail over to. Discovery
// spends a root GET to learn the one endpoint DNS already resolves to. With
// it off, reads, writes and queries all still route correctly to the account
// endpoint (verified against the stubbed transport). If the account ever
// becomes multi-region, flip COSMOS_ENDPOINT_DISCOVERY=true and the clients
// resume discovery with no code change.
//
// The retry options are unchanged from SDK defaults; throttle handling and
// per-request retries are untouched by this.

import type { CosmosClientOptions } from "@azure/cosmos";

/**
 * Endpoint discovery is OFF by default because the account is single-region.
 * Set COSMOS_ENDPOINT_DISCOVERY=true to restore the SDK default — do that if
 * `hobbyiq-comps` ever gains a second region.
 */
export function endpointDiscoveryEnabled(): boolean {
  return String(process.env.COSMOS_ENDPOINT_DISCOVERY ?? "").trim().toLowerCase() === "true";
}

/**
 * CF-A-REQUEST-NEEDS-A-CEILING (Fable, 2026-09-15). POST-FREEZE.
 *
 * WHAT THIS ADDS, and why the old comment below it was too modest. The policy
 * set `enableEndpointDiscovery` and nothing else, on the stated grounds that
 * leaving the rest at SDK defaults "cannot silently change retry, throttle or
 * timeout behaviour". True — but the SDK defaults are not all bounded the way
 * a request path needs, and `/api/compiq/price` rode one of them to Azure's
 * 240 s front-end kill (HTTP 499). See #2163 for the incident; that PR fixed
 * the request path alone because this file is shared by every lane.
 *
 * MEASURED, against the pinned @azure/cosmos 4.9.3 in this repo:
 *
 *   ConnectionPolicy.js:27         requestTimeout            60,000 ms
 *   constants.js:198-200           ThrottledRequestMaxRetryAttemptCount   9
 *                                  ThrottledRequestMaxWaitTimeInSeconds  30
 *   endpointDiscoveryRetryPolicy.js:49-51
 *                                  maxTries   120,  retryAfterInMs  1,000
 *
 * The throttle policy is already bounded and is NOT the problem. The endpoint
 * discovery policy is the one that hurts: 120 tries one second apart is a
 * ~120,000 ms ceiling PER OPERATION, and `maxTries` there is a hardcoded
 * static the connection policy cannot configure at all. Two such operations in
 * one request exceed the 240 s front door on their own, which is exactly the
 * shape of the /price hang — a client with an empty location cache, discovery
 * left on, re-resolving the endpoint on every operation.
 *
 * Endpoint discovery is already OFF by default here (single-region account),
 * so that ceiling is not normally reachable. The values below are the belt to
 * that braces: an explicit per-request ceiling, and a throttle ceiling stated
 * rather than inherited, so a future change to `COSMOS_ENDPOINT_DISCOVERY` or
 * to an SDK default cannot quietly restore a 2-minute operation.
 *
 * WHY THESE NUMBERS.
 *
 *   requestTimeout 20,000 ms (SDK default 60,000). One HTTP round trip to
 *     Cosmos, retries excluded — this bounds a single call, not a query's
 *     whole paging walk. The slowest read this repo measures is the ladder's
 *     per-rung ceiling of 3,000 ms (ladderBudget.service.ts), and the batch
 *     lanes are wide rather than slow per call, so 20 s is nearly 7x the
 *     slowest legitimate call and still a third of the default. A lane that
 *     genuinely needs longer should raise it here with the measurement, not
 *     silently inherit a minute.
 *
 *   maxRetryAttemptCount 5 (SDK default 9) and maxWaitTimeInSeconds 20
 *     (default 30). The wait cap is the binding one — it already stops a
 *     throttled request at 30 s — so this is a modest tightening, chosen so
 *     that requestTimeout + the throttle wait stays under a 45 s budget and
 *     well inside the ladder's 8 s walk for the request path. Nine retries
 *     against a partition that is hot is nine requests of added load on the
 *     thing that is already struggling; five is enough to ride out a
 *     momentary spike without deepening one.
 *
 * WHO SHARES THIS FILE. Everything: 140 files under `backend/src` build their
 * clients through `cosmosOptionsFromConnectionString` / `hobbyIqConnectionPolicy`
 * / `withConnectionPolicy` (111 services, 15 routes, 13 repositories, 1 job),
 * and the 41 scripts under `backend/scripts` that import those services inherit
 * it transitively — the rematch, backfill, ingest and reprice lanes among them.
 *
 * WHICH IS WHY THE CEILINGS ARE GATED TO THE WEB PROCESS. A ceiling that is
 * right for a user request is wrong for a batch lane: the request has a person
 * and a 240 s front door behind it, the lane has neither and must redo any work
 * it abandons. `boundedRetriesEnabled()` below holds that line — outside App
 * Service this function returns the same single-key object it returned before
 * this change, so every script, cron and backfill lane keeps today's SDK
 * defaults byte for byte. The values are additionally env-overridable, so even
 * inside the web process a budget can be restored without a deploy.
 *
 * The connection policy every HobbyIQ CosmosClient should be built with.
 */
export function hobbyIqConnectionPolicy(): NonNullable<CosmosClientOptions["connectionPolicy"]> {
  const policy: NonNullable<CosmosClientOptions["connectionPolicy"]> = {
    enableEndpointDiscovery: endpointDiscoveryEnabled(),
  };
  if (!boundedRetriesEnabled()) return policy;
  return {
    ...policy,
    requestTimeout: numFromEnv("COSMOS_REQUEST_TIMEOUT_MS", 20_000),
    retryOptions: {
      maxRetryAttemptCount: numFromEnv("COSMOS_MAX_RETRY_ATTEMPTS", 5),
      maxWaitTimeInSeconds: numFromEnv("COSMOS_MAX_RETRY_WAIT_SECONDS", 20),
      fixedRetryIntervalInMilliseconds: 0,
    },
  };
}

/**
 * Do the ceilings apply in THIS process?
 *
 * WHY THIS GATE EXISTS. A ceiling that is right for a web request is wrong for
 * a batch lane, and the two share this file. A user request has a person and a
 * 240 s front door on the other end of it: giving up early and saying so beats
 * answering late. A backfill lane has neither — it is measured in hours, it
 * runs against `sold_comps` at elevated RU, and a request it abandons at 20 s
 * is work it must redo. Tightening a batch lane's retry budget mid-wave is not
 * a thing to discover from a throughput graph, and a 31-slot rematch wave
 * builds from main.
 *
 * So the ceilings are OPT-IN and the opt-in is the web process:
 *
 *   COSMOS_BOUNDED_RETRIES=1   explicit, wins over everything, either way
 *                              ("0"/"false" force the SDK defaults back even
 *                              inside App Service — the escape hatch if the
 *                              ceilings ever turn out to be wrong in prod)
 *   WEBSITE_SITE_NAME present  the App Service marker. Set by the platform on
 *                              HobbyIQ3 and hobbyiq3-worker, and absent on a
 *                              GitHub Actions runner, on the backfill lanes and
 *                              on every local shell — so the gate needs NO app
 *                              setting to be created, and creating one would be
 *                              a live prod config change.
 *
 * Default OFF everywhere else, which means every script, cron, backfill,
 * ingest and rematch lane keeps the SDK defaults it has today, byte for byte:
 * `hobbyIqConnectionPolicy()` returns the same single-key object it returned
 * before this change. The blast radius of this PR outside the web process is
 * therefore nil by construction, not by review.
 *
 * NOTE this does gate the worker (hobbyiq3-worker) in as well as the API, since
 * both carry WEBSITE_SITE_NAME. That is deliberate: the worker is the role the
 * root-GET flood was measured on (see the note at the top of this file), so it
 * is the last process that should be running with an unbounded discovery
 * retry. It is not a batch runner; the backfill lanes run on Actions.
 */
export function boundedRetriesEnabled(): boolean {
  const explicit = String(process.env.COSMOS_BOUNDED_RETRIES ?? "").trim().toLowerCase();
  if (explicit === "1" || explicit === "true") return true;
  if (explicit === "0" || explicit === "false") return false;
  return String(process.env.WEBSITE_SITE_NAME ?? "").trim() !== "";
}

/** A positive finite number from the environment, or the stated default.
 *  A malformed or zero value takes the default rather than disabling the
 *  ceiling — an override must be a deliberate number, never a typo. */
function numFromEnv(name: string, fallback: number): number {
  const raw = Number(String(process.env[name] ?? "").trim());
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Wraps CosmosClient options (object form) with the shared connection policy,
 * preserving any policy fields the caller set explicitly.
 */
export function withConnectionPolicy<T extends CosmosClientOptions>(options: T): T {
  return {
    ...options,
    connectionPolicy: { ...hobbyIqConnectionPolicy(), ...(options.connectionPolicy ?? {}) },
  };
}

/**
 * Builds CosmosClient options from a connection string plus the shared policy.
 *
 * `new CosmosClient(cosmosOptionsFromConnectionString(connString))` is the single most common call shape in this
 * repo and it takes a STRING, which leaves no room for a connection policy —
 * that is exactly how every client ended up on the discovery default. This
 * returns the object form instead, so the policy applies.
 */
export function cosmosOptionsFromConnectionString(connectionString: string): CosmosClientOptions {
  return withConnectionPolicy({ connectionString } as CosmosClientOptions);
}
