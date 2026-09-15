/**
 * CF-A-STAGING-SLOT-MUST-NOT-ACT-LIKE-PRODUCTION (Fable, 2026-09-15, R56).
 *
 * An App Service slot runs the SAME IMAGE WITH THE SAME SETTINGS as
 * production. So while a staging slot warms, it is a second complete
 * production backend — production Cosmos, production eBay credentials,
 * production APNs key — running every in-process scheduler a minute or two
 * before it takes over from the instance already running them.
 *
 * Twelve schedulers start at boot. The concrete hazards, each from a job that
 * exists today:
 *
 *   priceAlertEvaluator / advancedAlertsEvaluator  send PUSH NOTIFICATIONS
 *   portfolioReprice                               WRITES holding values
 *   ebayOrderPoll                                  ADVANCES A SHARED CURSOR
 *   stagingDrainer                                 promotes comps_staging rows
 *
 * Two pollers sharing one cursor is the worst of them: one advances past
 * orders the other has not processed, and those orders are never seen again.
 *
 * These pins hold the gate. The load-bearing one is the DEFAULT: an unset
 * variable must mean production, so merging this changes nothing about the app
 * as it runs today and no existing deployment has to be touched.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  slotRole,
  isStagingSlot,
  mayRunBackgroundJobs,
  allowBackgroundJob,
} from "../src/services/ops/slotRole.js";

const KEY = "HIQ_SLOT_ROLE";
let saved: string | undefined;

beforeEach(() => { saved = process.env[KEY]; delete process.env[KEY]; });
afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

describe("the default is production", () => {
  it("an UNSET variable means production", () => {
    // THE pin. If this ever flipped, a merge of this PR would silence every
    // job in production — the exact inverse of the bug it prevents.
    expect(slotRole()).toBe("production");
    expect(isStagingSlot()).toBe(false);
    expect(mayRunBackgroundJobs()).toBe(true);
  });

  it("an empty or whitespace value means production", () => {
    for (const v of ["", "   "]) {
      process.env[KEY] = v;
      expect(slotRole()).toBe("production");
    }
  });

  it("an UNRECOGNISED value means production, not staging", () => {
    // A typo must fail SAFE. "stage", "Staging-2", "true" are not the word,
    // and a process that cannot prove it is a slot must behave as production
    // — the alternative is a silent production outage from a misspelling.
    for (const v of ["stage", "staging-2", "true", "1", "prod", "STAGINGX"]) {
      process.env[KEY] = v;
      expect(slotRole()).toBe("production");
      expect(mayRunBackgroundJobs()).toBe(true);
    }
  });
});

describe("a staging slot runs no jobs", () => {
  it("recognises the role, case-insensitively and trimmed", () => {
    for (const v of ["staging", "STAGING", "  Staging  "]) {
      process.env[KEY] = v;
      expect(slotRole()).toBe("staging");
      expect(isStagingSlot()).toBe(true);
      expect(mayRunBackgroundJobs()).toBe(false);
    }
  });

  it("refuses every background job and says which", () => {
    process.env[KEY] = "staging";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(allowBackgroundJob("startEbayOrderPollJob")).toBe(false);

    // The skip is LOGGED, not silent: "why did nothing run?" is a question the
    // slot's own log stream should answer without a redeploy.
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/background_job_skipped_on_staging_slot/);
    expect(logged).toMatch(/startEbayOrderPollJob/);
    warn.mockRestore();
  });

  it("allows every background job in production", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const job of ["startDailyJobs", "startPortfolioRepriceJob", "startEbayOrderPollJob"]) {
      expect(allowBackgroundJob(job)).toBe(true);
    }
    // Nothing to report when nothing is skipped.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("is read at CALL time, not cached at module load", () => {
    expect(slotRole()).toBe("production");
    process.env[KEY] = "staging";
    // A cached value would make the gate depend on import order — which is the
    // kind of thing that works in a test and not in a container.
    expect(slotRole()).toBe("staging");
  });
});

describe("every scheduler in server.ts is behind the gate", () => {
  it("no start*Job call is left ungated", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    // Every scheduler invocation inside the listen callback must be guarded.
    // A new job added later without the guard is exactly the regression this
    // catches — and it would ship a double-runner the next time a slot warms.
    const invocations = src.match(/^\s*(?:if \(allowBackgroundJob\("[A-Za-z]+"\)\) )?start[A-Za-z]+\(\);/gm) ?? [];
    expect(invocations.length).toBeGreaterThanOrEqual(12);

    const ungated = invocations.filter((line) => !line.includes("allowBackgroundJob"));
    expect(ungated).toEqual([]);
  });

  it("the role is stated at startup", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    // "Which role did this process think it was?" is the first question of any
    // swap that goes wrong, and it must not require a redeploy to answer.
    expect(src).toMatch(/event: "server_role"/);
  });
});
