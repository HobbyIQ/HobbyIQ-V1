/**
 * CF-CARDSIGHT-RETIRED-FROM-PRICING (2026-08-23).
 *
 * Drew, asked whether Cardsight should be writing prices at all: "NO IT SHOULD
 * NOT".
 *
 * Cardsight was retired from MATCHING on 2026-08-16 in code rather than by
 * pulling the env var, so CARDSIGHT_API_KEY stayed set in App Service and
 * isCardsightConfigured() kept returning true. It was never retired from
 * PRICING, and it kept quoting values a week later:
 *
 *   Max Williams "2025 Bowman Draft Gold #CPA-MWI" (aff3236a, $301.43 paid)
 *     fairMarketValue 14.29   sourceVendor "cardsight"
 *     valuationStatus "observed"   cardId absent
 *     lastUpdated 2026-08-23T18:59:08Z
 *
 * Three Cardsight paths can price — cardsightStructuredBridge,
 * cardsightFallback, cardsightPricingBackstop — and all three gate on this one
 * function, so the retirement lives here.
 *
 * THE DIRECTION OF THE DEFAULT IS THE POINT. Default-off with an opt-in
 * (CARDSIGHT_ENABLED=true) rather than default-on behind a kill switch: the
 * latter is exactly how the 08-16 retirement stayed half-done.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCardsightConfigured } from "../src/services/compiq/cardsightSlim.client.js";

const KEY = "CARDSIGHT_API_KEY";
const FLAG = "CARDSIGHT_ENABLED";

let savedKey: string | undefined;
let savedFlag: string | undefined;

beforeEach(() => {
  savedKey = process.env[KEY];
  savedFlag = process.env[FLAG];
});

afterEach(() => {
  if (savedKey === undefined) delete process.env[KEY]; else process.env[KEY] = savedKey;
  if (savedFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = savedFlag;
});

describe("Cardsight is retired from pricing", () => {
  it("is OFF with a key present and no flag — the exact prod shape that priced the Gold", () => {
    process.env[KEY] = "a-real-looking-key";
    delete process.env[FLAG];
    expect(isCardsightConfigured()).toBe(false);
  });

  it("stays OFF for values that are not exactly true", () => {
    process.env[KEY] = "a-real-looking-key";
    for (const v of ["", "false", "0", "no", "1", "yes", "TRUE-ish", "  "]) {
      process.env[FLAG] = v;
      expect(isCardsightConfigured(), `flag=${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("can be turned back on deliberately, without a deploy", () => {
    process.env[KEY] = "a-real-looking-key";
    process.env[FLAG] = "true";
    expect(isCardsightConfigured()).toBe(true);
  });

  it("accepts the flag case-insensitively and with surrounding whitespace", () => {
    process.env[KEY] = "a-real-looking-key";
    for (const v of ["true", "TRUE", " True ", "\tTRUE\n"]) {
      process.env[FLAG] = v;
      expect(isCardsightConfigured(), `flag=${JSON.stringify(v)}`).toBe(true);
    }
  });

  it("fails CLOSED when re-enabled with no API key", () => {
    // An accidental re-enable must not read as configured.
    process.env[FLAG] = "true";
    delete process.env[KEY];
    expect(isCardsightConfigured()).toBe(false);
  });

  it("fails closed on a blank or whitespace-only key", () => {
    process.env[FLAG] = "true";
    for (const k of ["", "   ", "\t"]) {
      process.env[KEY] = k;
      expect(isCardsightConfigured(), `key=${JSON.stringify(k)}`).toBe(false);
    }
  });
});
