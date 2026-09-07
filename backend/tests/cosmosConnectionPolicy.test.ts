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
