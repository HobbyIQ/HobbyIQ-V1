// CF-EBAY-RECONNECT-SURFACE (found by #1721).
//
// What went wrong: the backend has returned `status: "reconnect-required"`
// with a reason and a timestamp since D26, and NO client read it. Both the
// web page and the iOS view branched on `connected` alone — which stays TRUE
// for a dead connection, because a token record still exists. Two real users
// sat in reconnect-required from 2026-08-31, purchases not syncing, behind a
// green "Connected" dot and a generic Reconnect button that explained
// nothing.
//
// What is pinned here: (1) the three states are actually three — a dead
// connection is NOT "connected", which is the whole bug; (2) the dead state
// says what happened, what it costs, and what to do, in plain words with the
// date; (3) the healthy and never-connected states stay quiet, so the prompt
// means something when it appears; (4) the wiring — the page and the banner
// read the helper rather than re-deriving `connected` on their own.
//
// MUTATION RED: delete the `status === "reconnect-required"` branch in
// describeEbayConnection and the first two blocks below go red — a dead
// connection falls through to "connected", exactly the shipped bug.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  describeEbayConnection,
  reconnectDate,
  type EbayConnectionWire,
} from "./ebayConnection";

/** The prod shape of the two users who sat broken since 2026-08-31. */
const BROKEN: EbayConnectionWire = {
  connected: true,
  status: "reconnect-required",
  reconnectReason: "invalid_grant",
  reconnectRequiredAt: "2026-08-31T04:12:09.000Z",
};

const HEALTHY: EbayConnectionWire = {
  connected: true,
  status: "ok",
  reconnectReason: null,
  reconnectRequiredAt: null,
};

const ABSENT: EbayConnectionWire = { connected: false };

describe("PIN: connected=true is not the same as working", () => {
  it("a reconnect-required record is NOT the connected state", () => {
    const v = describeEbayConnection(BROKEN);
    // The shipped bug in one assertion: this used to render as "connected".
    expect(v.state).toBe("reconnect-required");
    expect(v.state).not.toBe("connected");
    expect(v.needsReconnect).toBe(true);
  });

  it("a healthy record is the connected state and asks for nothing", () => {
    const v = describeEbayConnection(HEALTHY);
    expect(v.state).toBe("connected");
    expect(v.needsReconnect).toBe(false);
    expect(v.action).toBeNull();
  });

  it("no record at all is the not-connected state", () => {
    const v = describeEbayConnection(ABSENT);
    expect(v.state).toBe("not-connected");
    expect(v.needsReconnect).toBe(false);
    expect(v.action).toEqual({ label: "Connect eBay", kind: "connect" });
  });

  it("the three states are distinct — never two names for one outcome", () => {
    const states = [BROKEN, HEALTHY, ABSENT].map((w) => describeEbayConnection(w).state);
    expect(new Set(states).size).toBe(3);
  });

  it("only the broken state asks the user to act right now", () => {
    expect([HEALTHY, ABSENT].map((w) => describeEbayConnection(w).needsReconnect)).toEqual([
      false,
      false,
    ]);
    expect(describeEbayConnection(BROKEN).needsReconnect).toBe(true);
  });
});

describe("PIN: the broken state says what happened, in plain words", () => {
  it("names the date, the consequence, and the fix", () => {
    const v = describeEbayConnection(BROKEN);
    expect(v.detail).toMatch(/stopped working on 2026-08-31/);
    expect(v.detail).toMatch(/not syncing/i);
    expect(v.detail).toMatch(/Reconnect to resume/i);
    expect(v.label).toBe("Reconnect required");
  });

  it("offers exactly one action, and it is the reconnect flow", () => {
    expect(describeEbayConnection(BROKEN).action).toEqual({
      label: "Reconnect eBay",
      kind: "reconnect",
    });
  });

  it("surfaces the eBay-supplied reason as secondary text when there is one", () => {
    expect(describeEbayConnection(BROKEN).reason).toBe("invalid_grant");
  });

  it("a missing or blank reason is null, never an empty line", () => {
    for (const reason of [null, undefined, "", "   "]) {
      const v = describeEbayConnection({ ...BROKEN, reconnectReason: reason });
      expect(v.reason, JSON.stringify(reason)).toBeNull();
      // The prompt still stands without it — the reason is decoration.
      expect(v.needsReconnect).toBe(true);
      expect(v.detail).toMatch(/Reconnect to resume/);
    }
  });

  it("an undatable break drops the date rather than printing garbage", () => {
    for (const at of [null, undefined, "", "not-a-date"]) {
      const v = describeEbayConnection({ ...BROKEN, reconnectRequiredAt: at });
      expect(v.brokeOn, JSON.stringify(at)).toBeNull();
      expect(v.detail).not.toMatch(/Invalid Date|NaN|undefined|null/);
      // Still a prompt: we know it is broken even when we cannot date it.
      expect(v.detail).toMatch(/stopped working\. Purchases are not syncing/);
    }
  });

  it("the healthy and absent states never carry a break date or reason", () => {
    for (const w of [HEALTHY, ABSENT]) {
      const v = describeEbayConnection(w);
      expect(v.brokeOn).toBeNull();
      expect(v.reason).toBeNull();
    }
  });
});

describe("PIN: unknown / missing inputs never fake a healthy connection", () => {
  it("null and undefined read as not-connected, not as connected", () => {
    for (const w of [null, undefined]) {
      expect(describeEbayConnection(w).state).toBe("not-connected");
    }
  });

  it("a connected record with no status field is treated as working", () => {
    // Additive contract: an older backend that omits `status` must not
    // start nagging every healthy user to reconnect.
    const v = describeEbayConnection({ connected: true });
    expect(v.state).toBe("connected");
    expect(v.needsReconnect).toBe(false);
  });

  it("an unrecognised status string is not mistaken for reconnect-required", () => {
    expect(describeEbayConnection({ connected: true, status: "weird" }).state).toBe("connected");
  });

  it("connected must be exactly true — a truthy-ish value is not a connection", () => {
    for (const c of [undefined, false, null as unknown as boolean]) {
      expect(describeEbayConnection({ connected: c, status: "reconnect-required" }).state).toBe(
        "not-connected",
      );
    }
  });
});

describe("reconnectDate", () => {
  it("reduces an ISO timestamp to a plain YYYY-MM-DD", () => {
    expect(reconnectDate("2026-08-31T04:12:09.000Z")).toBe("2026-08-31");
  });

  it("returns null for anything it cannot date", () => {
    for (const v of [null, undefined, "", "  ", "nonsense"]) {
      expect(reconnectDate(v), JSON.stringify(v)).toBeNull();
    }
  });
});

// ─── Wiring ────────────────────────────────────────────────────────
// There is no DOM in this lane (vitest.config.mts is `environment: "node"`),
// so these read the sources — which is what the bug actually was: the field
// existed on the wire and no file mentioned it. A render test would not have
// caught that either, since the old page rendered fine; it rendered the
// wrong thing.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

/** Strips comments so a mention in prose does not count as a read. */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const API = "lib/api.ts";
const PAGE = "app/app/ebay/page.tsx";
const HOME = "app/app/page.tsx";
const BANNER = "components/EbayReconnectBanner.tsx";

describe("PIN: the client type carries the fields the backend returns", () => {
  it("EbayStatus declares status, reconnectReason and reconnectRequiredAt", () => {
    const s = code(src(API));
    const block = s.slice(s.indexOf("export interface EbayStatus"));
    const body = block.slice(0, block.indexOf("}") + 1);
    expect(body).toMatch(/status\?:\s*"ok"\s*\|\s*"reconnect-required"/);
    expect(body).toMatch(/reconnectReason\?:/);
    expect(body).toMatch(/reconnectRequiredAt\?:/);
  });
});

describe("PIN: the surfaces read the helper, not `connected` alone", () => {
  it("the eBay page derives its state from describeEbayConnection", () => {
    const s = code(src(PAGE));
    expect(s).toContain('from "@/lib/ebayConnection"');
    expect(s).toMatch(/describeEbayConnection\(status\)/);
  });

  it("the eBay page no longer hard-codes one status label for both states", () => {
    const s = code(src(PAGE));
    // The label must come from the helper, so that a dead connection cannot
    // be painted "Connected" again.
    expect(s).toMatch(/\{conn\.label\}/);
  });

  it("DailyIQ — the page behind the nav item — mounts the banner", () => {
    const s = code(src(HOME));
    expect(s).toContain('from "@/components/EbayReconnectBanner"');
    expect(s).toMatch(/<EbayReconnectBanner\b/);
  });

  it("the banner mount is not nested behind a gate or an entitlement", () => {
    const s = code(src(HOME));
    const line = s.split("\n").find((l) => l.includes("<EbayReconnectBanner"))!;
    expect(line).not.toMatch(/phase|locked|entitle|gate|granted|\?/i);
  });

  it("the banner renders only in the broken state, and starts the OAuth flow", () => {
    const s = code(src(BANNER));
    // It self-hides on both healthy states rather than nagging.
    expect(s).toMatch(/needsReconnect/);
    expect(s).toMatch(/return null/);
    // And its single action is the existing reconnect flow.
    expect(s).toContain("reconnectEbay");
  });
});
