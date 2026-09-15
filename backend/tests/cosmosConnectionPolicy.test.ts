// CF-COSMOS-PING-VOLUME (2026-09-07). Pins the fix that stops the 1 ms
// Cosmos gateway "GET /" dependency flood.
//
// The important test here is the LAST one: it drives a real CosmosClient
// against a stubbed transport (the SDK's own `plugins` hook, which
// short-circuits before the network) and counts root-path GETs. That is the
// test that would have caught #1982 shipping a filter which could not work —
// it measures the calls the SDK actually makes, rather than asserting that
// our own helper returns the flag we just typed into it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CosmosClient } from "@azure/cosmos";
import {
  endpointDiscoveryEnabled,
  hobbyIqConnectionPolicy,
  boundedRetriesEnabled,
  withConnectionPolicy,
  cosmosOptionsFromConnectionString,
} from "../src/services/ops/cosmosConnectionPolicy.js";

const ENV_KEY = "COSMOS_ENDPOINT_DISCOVERY";
let saved: string | undefined;
beforeEach(() => { saved = process.env[ENV_KEY]; delete process.env[ENV_KEY]; });
afterEach(() => { if (saved === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = saved; });

describe("endpointDiscoveryEnabled", () => {
  it("is OFF by default — the account is single-region", () => {
    expect(endpointDiscoveryEnabled()).toBe(false);
    expect(hobbyIqConnectionPolicy().enableEndpointDiscovery).toBe(false);
  });

  it("can be turned back on for a multi-region account", () => {
    process.env[ENV_KEY] = "true";
    expect(endpointDiscoveryEnabled()).toBe(true);
    expect(hobbyIqConnectionPolicy().enableEndpointDiscovery).toBe(true);
  });

  it("ignores case and surrounding whitespace", () => {
    process.env[ENV_KEY] = "  TRUE  ";
    expect(endpointDiscoveryEnabled()).toBe(true);
  });

  it("treats any non-true value as off", () => {
    for (const v of ["", "false", "1", "yes", "no"]) {
      process.env[ENV_KEY] = v;
      expect(endpointDiscoveryEnabled()).toBe(v === "true");
    }
  });
});

describe("option builders", () => {
  it("turns a connection string into object-form options carrying the policy", () => {
    const o = cosmosOptionsFromConnectionString("AccountEndpoint=https://x/;AccountKey=k;") as any;
    expect(o.connectionString).toBe("AccountEndpoint=https://x/;AccountKey=k;");
    expect(o.connectionPolicy.enableEndpointDiscovery).toBe(false);
  });

  it("never overrides a policy the caller set explicitly", () => {
    const o = withConnectionPolicy({
      endpoint: "https://x/",
      key: "k",
      connectionPolicy: { enableEndpointDiscovery: true, requestTimeout: 1234 },
    } as any) as any;
    expect(o.connectionPolicy.enableEndpointDiscovery).toBe(true);
    expect(o.connectionPolicy.requestTimeout).toBe(1234);
  });

  it("preserves the caller's other client options", () => {
    const o = withConnectionPolicy({ endpoint: "https://x/", key: "k", userAgentSuffix: "hiq" } as any) as any;
    expect(o.endpoint).toBe("https://x/");
    expect(o.userAgentSuffix).toBe("hiq");
  });
});

/**
 * Drives a real CosmosClient with the transport stubbed by the SDK's plugin
 * hook, and counts how many root-path ("GET /") calls it makes.
 *
 * `accountLocations: "empty"` reproduces the production pathology: the
 * database-account response never populates the location cache, so
 * GlobalEndpointManager.resolveServiceEndpoint re-issues the root GET on
 * EVERY operation.
 */
async function countRootGets(opts: {
  ops: number;
  discovery: boolean;
  accountLocations: "populated" | "empty";
}): Promise<number> {
  const paths: string[] = [];
  const locations =
    opts.accountLocations === "populated"
      ? [{ name: "Central US", databaseAccountEndpoint: "https://acct-centralus.documents.azure.com:443/" }]
      : [];
  const client = new CosmosClient({
    endpoint: "https://acct.documents.azure.com/",
    key: Buffer.from("not-a-real-key").toString("base64"),
    connectionPolicy: { enableEndpointDiscovery: opts.discovery },
    plugins: [
      {
        on: "request",
        plugin: async (ctx: any) => {
          const p = ctx.path || "/";
          paths.push(p);
          const isRoot = p === "/" || p === "";
          return {
            headers: {},
            code: 200,
            substatus: 0,
            result: isRoot
              ? { writableLocations: locations, readableLocations: locations, enableMultipleWritableLocations: false }
              : { Documents: [], _count: 0 },
          };
        },
      },
    ],
  } as any);
  const container = client.database("hobbyiq").container("sold_comps");
  for (let i = 0; i < opts.ops; i++) {
    try { await container.items.query("SELECT 1").fetchAll(); } catch { /* stubbed shape */ }
  }
  client.dispose();
  return paths.filter((p) => p === "/" || p === "").length;
}

describe("Cosmos root-path ping volume (real SDK, stubbed transport)", () => {
  it("with discovery ON and a cache that never populates, EVERY op re-pings the gateway", async () => {
    // This is the production failure: pings scale with operation count.
    const roots = await countRootGets({ ops: 10, discovery: true, accountLocations: "empty" });
    expect(roots).toBeGreaterThanOrEqual(10);
  }, 30_000);

  it("with discovery OFF, the gateway is never pinged — regardless of the cache", async () => {
    // The fix. Zero root GETs even in the pathological case above.
    expect(await countRootGets({ ops: 10, discovery: false, accountLocations: "empty" })).toBe(0);
    expect(await countRootGets({ ops: 10, discovery: false, accountLocations: "populated" })).toBe(0);
  }, 30_000);

  it("still issues the real data-plane calls with discovery OFF", async () => {
    // Suppressing pings must not suppress actual work.
    const paths: string[] = [];
    const client = new CosmosClient({
      endpoint: "https://acct.documents.azure.com/",
      key: Buffer.from("not-a-real-key").toString("base64"),
      connectionPolicy: { enableEndpointDiscovery: false },
      plugins: [{ on: "request", plugin: async (ctx: any) => {
        paths.push(`${ctx.method} ${ctx.path || "/"}`);
        return { headers: {}, code: 200, substatus: 0, result: { Documents: [], _count: 0, id: "x" } };
      }}],
    } as any);
    const container = client.database("hobbyiq").container("sold_comps");
    try { await container.items.query("SELECT 1").fetchAll(); } catch { /* stubbed */ }
    try { await container.items.create({ id: "probe" } as any); } catch { /* stubbed */ }
    client.dispose();
    expect(paths.some((p) => p.includes("/dbs/hobbyiq/colls/sold_comps"))).toBe(true);
    expect(paths.filter((p) => p.endsWith(" /")).length).toBe(0);
  }, 30_000);
});

/**
 * CF-A-REQUEST-NEEDS-A-CEILING (Fable, 2026-09-15). POST-FREEZE.
 *
 * The policy previously set `enableEndpointDiscovery` and nothing else, so a
 * request inherited every SDK default. Measured against the pinned 4.9.3:
 * `requestTimeout` 60,000 ms; the throttle policy bounded at 9 tries / 30 s;
 * and `EndpointDiscoveryRetryPolicy.maxTries = 120` at 1,000 ms apart — a
 * ~120 s ceiling PER OPERATION, on a static the connection policy cannot
 * configure. Two of those exceed Azure's 240 s front-end kill by themselves,
 * which is the shape of the /price hang (#2163).
 *
 * These pins hold the explicit ceilings, and that an override must be a
 * deliberate number rather than a typo that silently removes one.
 */
describe("the policy states its ceilings rather than inheriting them", () => {
  const CEILING_KEYS = [
    "COSMOS_REQUEST_TIMEOUT_MS",
    "COSMOS_MAX_RETRY_ATTEMPTS",
    "COSMOS_MAX_RETRY_WAIT_SECONDS",
    "COSMOS_BOUNDED_RETRIES",
    "WEBSITE_SITE_NAME",
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of CEILING_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    // The ceilings are OPT-IN and the opt-in is the web process, so the cases
    // below that assert a ceiling must first BE the web process. The gate
    // itself is pinned separately in the next describe block.
    process.env.WEBSITE_SITE_NAME = "HobbyIQ3";
  });
  afterEach(() => {
    for (const k of CEILING_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("bounds a single request well under the SDK's 60 s default", () => {
    const policy = hobbyIqConnectionPolicy();
    // MUTATION CHECK: pre-fix this field was absent entirely, and the SDK
    // filled in 60,000.
    expect(policy.requestTimeout).toBe(20_000);
  });

  it("states a retry ceiling instead of inheriting 9 tries / 30 s", () => {
    const policy = hobbyIqConnectionPolicy();
    expect(policy.retryOptions?.maxRetryAttemptCount).toBe(5);
    expect(policy.retryOptions?.maxWaitTimeInSeconds).toBe(20);
  });

  it("keeps the ceilings the request path was fixed against", () => {
    const policy = hobbyIqConnectionPolicy();
    const worstCaseMs =
      (policy.requestTimeout ?? 0) + (policy.retryOptions?.maxWaitTimeInSeconds ?? 0) * 1000;
    // A whole operation, ceiling to ceiling, must stay far inside the 240 s
    // front door — the bound that was actually being hit.
    expect(worstCaseMs).toBeLessThan(45_000);
  });

  it("carries the ceilings through both helper shapes", () => {
    for (const options of [withConnectionPolicy({} as any), cosmosOptionsFromConnectionString("AccountEndpoint=https://x/;AccountKey=aaaa;")]) {
      expect(options.connectionPolicy?.requestTimeout).toBe(20_000);
      expect(options.connectionPolicy?.retryOptions?.maxRetryAttemptCount).toBe(5);
    }
  });

  it("lets a lane raise a ceiling by env without a deploy", () => {
    process.env.COSMOS_REQUEST_TIMEOUT_MS = "90000";
    process.env.COSMOS_MAX_RETRY_ATTEMPTS = "9";
    const policy = hobbyIqConnectionPolicy();
    expect(policy.requestTimeout).toBe(90_000);
    expect(policy.retryOptions?.maxRetryAttemptCount).toBe(9);
  });

  it("ignores a malformed or zero override rather than removing the ceiling", () => {
    for (const bad of ["", "   ", "abc", "0", "-1"]) {
      process.env.COSMOS_REQUEST_TIMEOUT_MS = bad;
      // A typo must not be the thing that restores an unbounded request.
      expect(hobbyIqConnectionPolicy().requestTimeout).toBe(20_000);
    }
  });
});

/**
 * CF-A-CEILING-FOR-A-REQUEST-IS-NOT-A-CEILING-FOR-A-LANE (Fable, 2026-09-15).
 *
 * A ceiling that is right for a web request is wrong for a batch lane, and
 * both build their clients from this one file. A user request has a person and
 * Azure's 240 s front door behind it — giving up early and saying so beats
 * answering late. A backfill lane has neither: it is measured in hours, runs
 * against sold_comps at elevated RU, and any request it abandons at 20 s is
 * work it must redo. A 31-slot rematch wave builds from main, so tightening a
 * batch lane's retry budget mid-wave is not a thing to discover from a
 * throughput graph.
 *
 * So the ceilings are opt-in, and these pins hold the gate. The load-bearing
 * one is the LAST: outside the web process this function must return exactly
 * what it returned before the ceilings existed.
 */
describe("the ceilings apply in the web process and nowhere else", () => {
  const KEYS = ["COSMOS_BOUNDED_RETRIES", "WEBSITE_SITE_NAME", "COSMOS_REQUEST_TIMEOUT_MS"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("is ON inside App Service, which sets WEBSITE_SITE_NAME", () => {
    process.env.WEBSITE_SITE_NAME = "HobbyIQ3";
    expect(boundedRetriesEnabled()).toBe(true);
    expect(hobbyIqConnectionPolicy().requestTimeout).toBe(20_000);
  });

  it("is OFF on a GitHub Actions runner, where that marker is absent", () => {
    // This is the backfill / rematch / ingest case. No app setting has to be
    // created for the gate to work, and creating one would be a live prod
    // config change.
    expect(boundedRetriesEnabled()).toBe(false);
  });

  it("an explicit COSMOS_BOUNDED_RETRIES wins in BOTH directions", () => {
    process.env.COSMOS_BOUNDED_RETRIES = "1";
    expect(boundedRetriesEnabled()).toBe(true);            // on, off App Service

    process.env.WEBSITE_SITE_NAME = "HobbyIQ3";
    process.env.COSMOS_BOUNDED_RETRIES = "0";
    // The escape hatch: if the ceilings turn out to be wrong in prod they can
    // be switched off by app setting, without a deploy and without a revert.
    expect(boundedRetriesEnabled()).toBe(false);
    expect(hobbyIqConnectionPolicy().requestTimeout).toBeUndefined();
  });

  it("OUTSIDE the web process the policy is byte-for-byte what it always was", () => {
    // THE pin. Pre-change this function returned exactly one key. Every script,
    // cron and backfill lane must still get exactly that object — which is what
    // makes this PR's blast radius outside the web process nil by construction
    // rather than by review.
    expect(hobbyIqConnectionPolicy()).toEqual({ enableEndpointDiscovery: false });

    const fromConnString = cosmosOptionsFromConnectionString("AccountEndpoint=https://x/;AccountKey=aaaa;");
    expect(fromConnString.connectionPolicy).toEqual({ enableEndpointDiscovery: false });
    expect(fromConnString.connectionPolicy?.retryOptions).toBeUndefined();
  });
});
