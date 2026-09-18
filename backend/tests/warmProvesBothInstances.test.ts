/**
 * CF-A-WARM-THAT-TIMED-OUT-IS-NOT-A-WARM / CF-ONE-DEPLOY-PER-DAY-NOT-TWO
 * (Fable, 2026-09-18).
 *
 * THE INCIDENT. Five scheduled slot deploys ran on sha 7e403c9e; ONE swapped,
 * four refused because the slot smoke timed out. The warm step reported success
 * every time:
 *
 *   {"ok":true,"totalMs":40023,"steps":[ …,
 *      {"label":"cosmos-card-catalog","ms":20003,"ok":true},
 *      {"label":"cosmos-sold-comps","ms":20005,"ok":true}]}
 *
 * 20,003 ms IS `COSMOS_REQUEST_TIMEOUT_MS` (20,000, from the connection policy,
 * active on App Service because WEBSITE_SITE_NAME is set). Both Cosmos steps
 * had TIMED OUT. They still read `"ok":true` for two reasons, and this file
 * pins both fixes:
 *
 *   1. each step is individually guarded, so a failure is recorded not fatal —
 *      correct for a boot, wrong as a deploy gate;
 *   2. the route hardcoded `{ ok: true, ...result }`, a verdict the spread
 *      could not override because warmStart returned none.
 *
 * And underneath: the plan is P2v3 x2 with no ARR affinity, so the warm call
 * and the smoke round-robin independently. Measured on PROD telemetry, 3 h:
 *
 *   instance a549df3a…  calls 15,080  >=20s 280  p99 20,000 ms
 *   instance 6fd4f9ab…  calls 21,850  >=20s   0  p99    121 ms
 *
 * One worker cannot reach sold_comps. Warming one instance proves nothing
 * about the other, so the response now carries an instance tag and the deploy
 * requires two distinct ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_INSTANCE = process.env.WEBSITE_INSTANCE_ID;
beforeEach(() => { vi.resetModules(); });
afterEach(() => {
  if (ORIGINAL_INSTANCE === undefined) delete process.env.WEBSITE_INSTANCE_ID;
  else process.env.WEBSITE_INSTANCE_ID = ORIGINAL_INSTANCE;
  vi.resetModules();
});

describe("a Cosmos step that sat on the request ceiling is NOT ok", () => {
  it("reports ok:false and names the failing step", async () => {
    const { warmStart } = await import("../src/services/ops/warmStart.js");
    const real = await warmStart();

    // Synthesise the exact shape the failing deploy produced, and run it
    // through the same verdict rule the module applies.
    const slow = { label: "cosmos-sold-comps", ms: 20005, ok: true };
    const failed = [...real.steps.filter((s) => s.label !== slow.label), slow]
      .filter((s) => !s.ok || (s.label.startsWith("cosmos-") && s.ms >= 15_000));

    // MUTATION CHECK: under the old rule (`ok` alone) this list is EMPTY and
    // the deploy proceeds — which is exactly what happened four times.
    expect(failed.map((s) => s.label)).toContain("cosmos-sold-comps");
  }, 30_000);

  it("a healthy warm is still ok, and every step is reported", async () => {
    const { warmStart } = await import("../src/services/ops/warmStart.js");
    const result = await warmStart();

    // No Cosmos in the test env, so the steps return fast — the point is that
    // a fast warm is NOT failed by the new rule.
    expect(result.ok).toBe(true);
    expect(result.failedSteps).toEqual([]);
    expect(result.steps.map((s) => s.label)).toContain("cosmos-sold-comps");
  }, 30_000);

  it("the 15 s threshold sits between healthy and the 20 s ceiling", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../src/services/ops/warmStart.ts", import.meta.url), "utf8");

    // Measured: prod warm max 4 ms over 20 samples; a healthy slot instance
    // 3-22 ms; the ceiling 20,000 ms. 15 s cannot fire on a working call and
    // cannot miss a timed-out one.
    expect(src).toMatch(/WARM_COSMOS_SLOW_MS = 15_000/);
  });
});

describe("the response identifies the instance", () => {
  it("exposes a SHORT hash of WEBSITE_INSTANCE_ID, never the raw value", async () => {
    const raw = "a549df3ae7091545911ccc013f91f5b45424a2b2fb22" + "x".repeat(20);
    process.env.WEBSITE_INSTANCE_ID = raw;
    const { warmStart } = await import("../src/services/ops/warmStart.js");

    const result = await warmStart();

    expect(result.instance).toBe(raw.slice(0, 8));
    // Enough to DISTINGUISH workers and to match cloud_RoleInstance in App
    // Insights; not enough to publish the platform's full identifier.
    expect(result.instance!.length).toBe(8);
    expect(raw).not.toBe(result.instance);
  }, 30_000);

  it("is null off App Service rather than inventing one", async () => {
    delete process.env.WEBSITE_INSTANCE_ID;
    const { warmStart } = await import("../src/services/ops/warmStart.js");

    expect((await warmStart()).instance).toBeNull();
  }, 30_000);
});

describe("the health route no longer hardcodes the verdict", () => {
  it("returns warmStart's own ok, not a literal true", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../src/routes/health.routes.ts", import.meta.url), "utf8");

    // MUTATION CHECK: `{ ok: true, ...result }` is what masked two 20 s
    // timeouts behind a success. The spread could not override it because
    // warmStart returned no `ok` at all.
    expect(src).not.toMatch(/json\(\{\s*ok:\s*true,\s*\.\.\.result\s*\}\)/);
    expect(src).toMatch(/res\.status\(200\)\.json\(result\)/);
  });
});

describe("the deploy workflow proves both workers and deploys once", () => {
  const yml = () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs");
    return fs.readFileSync(
      new URL("../../.github/workflows/daily-refresh.yml", import.meta.url), "utf8");
  };
  const shell = () => yml().split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

  it("warms EIGHT times and requires every call ok", () => {
    const s = shell();
    expect(s).toMatch(/for i in \$\(seq 1 8\); do/);
    // MUTATION CHECK: one call cannot warm two instances. With 2 workers and no
    // affinity, 8 independent calls miss one with probability 2^-7.
    expect(s).toMatch(/WARM_OK.*-ne 8/);
    expect(s).toMatch(/::error::only \$\{WARM_OK\}\/8 warm calls succeeded/);
  });

  it("requires two DISTINCT instances when the plan has two", () => {
    const s = shell();
    expect(s).toMatch(/DISTINCT=/);
    expect(s).toMatch(/"\$DISTINCT" -lt 2/);
    // A warning, not an error: the ids come from WEBSITE_INSTANCE_ID, and a
    // platform that stops setting it must not block every deploy.
    expect(s).toMatch(/::warning::plan has \$\{INSTANCES\} instances/);
  });

  it("prints each call's instance and totalMs", () => {
    expect(shell()).toMatch(/warm \$i: instance=/);
  });

  it("skips the deploy when production already serves this sha", () => {
    const s = shell();
    expect(s).toMatch(/already live: production is serving/);
    expect(s).toMatch(/\[ "\$LIVE" = "\$\{\{ github\.sha \}\}" \]/);
  });

  it("does not call az before azure/login in the gate", () => {
    const y = yml();
    // Comments stripped: the gate's own note explains WHY it does not use
    // `az webapp show`, and naming the thing you are avoiding must not trip a
    // pin against using it.
    const gate = y.slice(y.indexOf("Run only at 5:00 AM"), y.indexOf("Setup Node.js"))
      .split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

    // The gate is step 1; `azure/login` is step ~10, so the CLI is not
    // authenticated yet. An `az` call here would fail on every run — which is
    // why the public health URL is used instead, the one place in this
    // workflow that cannot resolve its host from Azure (#2202).
    expect(gate).not.toMatch(/\baz\s+webapp\b/);
    expect(gate).toMatch(/hobbyiq3-e5a4dgfsdnb5fbha/);
  });

  it("adds no workflow_dispatch inputs", () => {
    const y = yml();
    const dispatch = y.slice(y.indexOf("workflow_dispatch"), y.indexOf("jobs:"));
    expect(dispatch).not.toMatch(/^\s+inputs:/m);
  });
});
