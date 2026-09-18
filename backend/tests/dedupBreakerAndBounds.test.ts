/**
 * CF-A-DEDUP-TIMEOUT-IS-NOT-A-MISS /
 * CF-A-PAUSED-DRAINER-IS-RECOVERABLE-A-DUPLICATE-FLOOD-IS-NOT
 * (Fable, 2026-09-16).
 *
 * THE MEASUREMENT. Of the ~289,365 Cosmos calls per 7 days that fail at the
 * SDK's 60 s default with NO request context, 73% are `hobbyiq3-worker`
 * querying `card_catalog`. An empty operation_Name means no HTTP request was in
 * scope — the signature of an in-process scheduler — and the issuer is the
 * staging drainer (`STAGING_DRAINER_ENABLED=true`, `STAGING_DRAINER_WORKERS=16`,
 * the only always-on loop, matching a failure floor present in all 24 UTC
 * hours).
 *
 * It reaches Cosmos via `soldCompsStore.recordSoldComp`, whose ten
 * `items.query` sites carried ZERO `abortSignal` between them — each riding the
 * 60 s default plus the SDK's internal retries, sixteen loops at a time, into a
 * container they were themselves saturating.
 *
 * THE DESIGN QUESTION these pins encode: what does a dedup TIMEOUT mean? It is
 * not a "no" — it is "I do not know". Treating it as a miss and writing the row
 * as new is right ONCE (indistinguishable from the genuine miss that already
 * happens thousands of times a day) and catastrophic at scale, because under a
 * sustained outage it writes a duplicate for every row across sixteen loops,
 * and a split pool is a wrong FMV.
 *
 * So: one timeout proceeds; N consecutive timeouts PAUSE the drainer. A paused
 * drainer is recoverable — comps_staging still holds every unpromoted row. A
 * duplicate flood is not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dedupBreakerAdmits,
  dedupBreakerIsOpen,
  recordDedupSuccess,
  recordDedupTimeout,
  _dedupBreakerStateForTest,
  _resetDedupBreakerForTest,
  DEDUP_BREAKER_THRESHOLD,
  DEDUP_BREAKER_HOLD_MS,
} from "../src/services/portfolioiq/dedupBreaker.js";

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  _resetDedupBreakerForTest();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); _resetDedupBreakerForTest(); });

const logged = () => warn.mock.calls.map((c) => String(c[0])).join("\n");

describe("one timeout proceeds; a run of them pauses the drainer", () => {
  it("stays CLOSED below the threshold — one unknown is tolerable", () => {
    for (let i = 0; i < DEDUP_BREAKER_THRESHOLD - 1; i++) recordDedupTimeout();

    // MUTATION CHECK: a breaker that opened on the first timeout would pause
    // the drainer on ordinary noise, and the drainer is the thing that moves
    // comps_staging forward.
    expect(dedupBreakerIsOpen()).toBe(false);
    expect(dedupBreakerAdmits()).toBe(true);
  });

  it("opens on the Nth CONSECUTIVE timeout and pauses", () => {
    for (let i = 0; i < DEDUP_BREAKER_THRESHOLD; i++) recordDedupTimeout();

    expect(dedupBreakerIsOpen()).toBe(true);
    expect(dedupBreakerAdmits()).toBe(false);
    expect(logged()).toMatch(/staging_drainer\.breaker_open/);
  });

  it("a SUCCESS resets the run — intermittent timeouts never trip it", () => {
    for (let i = 0; i < DEDUP_BREAKER_THRESHOLD - 1; i++) recordDedupTimeout();
    recordDedupSuccess();
    for (let i = 0; i < DEDUP_BREAKER_THRESHOLD - 1; i++) recordDedupTimeout();

    // Consecutive is the signal. A container that answers sometimes is slow;
    // one that never answers is down, and only the second should pause a job.
    expect(dedupBreakerIsOpen()).toBe(false);
  });
});

describe("half-open admits exactly one probe", () => {
  it("holds for the full window, then admits ONE caller", () => {
    const t0 = Date.now();
    for (let i = 0; i < DEDUP_BREAKER_THRESHOLD; i++) recordDedupTimeout(t0);

    // Still holding.
    expect(dedupBreakerAdmits(t0 + DEDUP_BREAKER_HOLD_MS - 1)).toBe(false);

    const after = t0 + DEDUP_BREAKER_HOLD_MS + 1;
    // THE pin: sixteen loops reach the half-open window together. Exactly one
    // is admitted — otherwise a half-open breaker becomes sixteen simultaneous
    // retries into a container that may still be down, which is the amplifier
    // this whole change exists to remove.
    const admitted = [0, 1, 2, 3, 4, 5].map(() => dedupBreakerAdmits(after));
    expect(admitted.filter(Boolean).length).toBe(1);
  });

  it("a successful probe CLOSES the breaker for everyone", () => {
    const t0 = Date.now();
    for (let i = 0; i < DEDUP_BREAKER_THRESHOLD; i++) recordDedupTimeout(t0);
    const after = t0 + DEDUP_BREAKER_HOLD_MS + 1;
    expect(dedupBreakerAdmits(after)).toBe(true);   // the probe

    recordDedupSuccess();

    expect(dedupBreakerIsOpen(after)).toBe(false);
    expect(dedupBreakerAdmits(after)).toBe(true);
    expect(logged()).toMatch(/staging_drainer\.breaker_closed/);
  });

  it("a FAILED probe re-opens the window rather than leaving it half-open", () => {
    const t0 = Date.now();
    for (let i = 0; i < DEDUP_BREAKER_THRESHOLD; i++) recordDedupTimeout(t0);
    const after = t0 + DEDUP_BREAKER_HOLD_MS + 1;
    expect(dedupBreakerAdmits(after)).toBe(true);

    recordDedupTimeout(after);

    // Without this the breaker would admit a probe on EVERY call once the first
    // hold expired — a half-open breaker that never closes and never holds.
    expect(dedupBreakerIsOpen(after + 1)).toBe(true);
    expect(dedupBreakerAdmits(after + 1)).toBe(false);
  });

  it("the breaker is shared, not per-loop", async () => {
    // Module-level state: the first loop to discover the outage stops the other
    // fifteen, instead of each rediscovering it independently.
    const mod = await import("../src/services/portfolioiq/dedupBreaker.js");
    for (let i = 0; i < DEDUP_BREAKER_THRESHOLD; i++) mod.recordDedupTimeout();
    expect(mod.dedupBreakerIsOpen()).toBe(true);
    expect(dedupBreakerIsOpen()).toBe(true);        // same state, other handle
  });
});

describe("the bounds are present at every site", () => {
  const read = async (p: string) => {
    const fs = await import("node:fs");
    return fs.readFileSync(new URL(p, import.meta.url), "utf8");
  };

  it("all three sold_comps dedup queries are bounded and breaker-fed", async () => {
    const src = await read("../src/services/portfolioiq/soldCompsStore.service.ts");

    // MUTATION CHECK: these three carried NO FeedOptions at all — that is the
    // whole 73%.
    const bounded = src.match(/dedupQuery\("/g) ?? [];
    expect(bounded.length).toBe(3);
    expect(src).toMatch(/DEDUP_QUERY_TIMEOUT_MS = 12_000/);
    expect(src).toMatch(/event: "sold_comps\.dedup_timeout"/);
  });

  it("the cross-partition dedup no longer SELECTs *", async () => {
    const src = await read("../src/services/portfolioiq/soldCompsStore.service.ts");
    const xp = src.slice(src.indexOf('dedupQuery("cross-partition"'));

    // It was `SELECT *` with no TOP — the most expensive of the three. The
    // projection is narrowed to the seven fields the result actually uses, and
    // every one of scoreForCanonical's inputs must survive: a projection that
    // dropped a scored field would silently change which row wins canonical.
    expect(xp.slice(0, 500)).not.toMatch(/SELECT \*/);
    for (const f of ["c.id", "c.cardId", "c.verifiedByUser", "c.sourceExternalId",
                     "c.parallel", "c.observedAt", "c.flaggedWrong"]) {
      expect(xp.slice(0, 500)).toContain(f);
    }
  });

  it("the two remaining background writers are bounded", async () => {
    const dps = await read("../src/services/portfolioiq/persistDailyPriceSeries.service.ts");
    const mi = await read("../src/services/insights/marketIndex.service.ts");
    expect(dps).toMatch(/abortSignal: AbortSignal\.timeout\(15_000\)/);
    expect(mi).toMatch(/abortSignal: AbortSignal\.timeout\(15_000\)/);
  });

  it("a healthy dedup is byte-identical — SELECT * survives where scoring needs it", async () => {
    const src = await read("../src/services/portfolioiq/soldCompsStore.service.ts");
    const ch = src.slice(src.indexOf('dedupQuery("contentHash"'));

    // MUTATION CHECK, and the one most worth having: the contentHash dedup
    // scores rows with scoreForCanonical, which reads the WHOLE document.
    // Narrowing this projection to "tidy up" would break canonical selection
    // while compiling and passing every other test.
    expect(ch.slice(0, 600)).toMatch(/SELECT \* FROM c WHERE ARRAY_CONTAINS/);
  });
});
