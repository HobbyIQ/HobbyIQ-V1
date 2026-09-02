// CF-PLAYER-TREND-SPECULATION (Drew, 2026-09-02). The two halves of the
// ruling must agree about what "cold" means.
//
// #1646 drew the 45d line in apps/web/src/lib/rung.ts for the CHIP ("last
// sale N weeks ago — priced to today's market"). That copy is a promise
// about the NUMBER, and the player-trend rung is what keeps it. If the two
// constants drift the product contradicts itself: a card at 50 days would
// wear the chip while the number behind it was still the old comp, or the
// number would move on a card the UI called fresh.
//
// So the backend owns the value and the web's copy is pinned equal to it,
// read from source the way rung.test.ts reads the rung vocabulary.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STALE_COMP_DAYS } from "../src/services/compiq/staleComp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_RUNG = path.resolve(here, "../../apps/web/src/lib/rung.ts");

describe("the stale-comp threshold is one number", () => {
  it("the web's STALE_COMP_DAYS equals the backend's", () => {
    const src = readFileSync(WEB_RUNG, "utf8");
    const m = src.match(/export const STALE_COMP_DAYS\s*=\s*(\d+)/);
    expect(m, "apps/web/src/lib/rung.ts must export STALE_COMP_DAYS").toBeTruthy();
    expect(Number(m![1])).toBe(STALE_COMP_DAYS);
  });

  it("is 45 — inside Drew's 30-60d band", () => {
    expect(STALE_COMP_DAYS).toBe(45);
    expect(STALE_COMP_DAYS).toBeGreaterThanOrEqual(30);
    expect(STALE_COMP_DAYS).toBeLessThanOrEqual(60);
  });
});
