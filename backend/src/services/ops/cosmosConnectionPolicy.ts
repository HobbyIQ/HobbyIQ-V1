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
 * The connection policy every HobbyIQ CosmosClient should be built with.
 *
 * Only `enableEndpointDiscovery` is set. Everything else stays on the SDK
 * default so this cannot silently change retry, throttle or timeout behaviour.
 */
export function hobbyIqConnectionPolicy(): NonNullable<CosmosClientOptions["connectionPolicy"]> {
  return { enableEndpointDiscovery: endpointDiscoveryEnabled() };
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
