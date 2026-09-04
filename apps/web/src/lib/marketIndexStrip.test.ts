// CF-MARKET-INDEXES (Drew, 2026-09-04). Pins for the strip's disappearing
// act. Every case here is one that actually happened or is one keystroke
// away from happening:
//
//   - pokemon was 180/180 levelless on 2026-09-04 and the strip silently
//     dropped it, so "we did not price this" looked like "this sport does
//     not exist".
//   - the old component returned null on ANY rejection, so a 401 or a 500
//     erased a working feature with no trace.
//   - a partial response must never blank the strip: three published
//     sports and two withheld ones is a five-tile strip.

import { describe, expect, it } from "vitest";
import type { SportIndexSeries } from "./api";
import {
  isWithheld,
  plottable,
  statusForError,
  stripIsHidden,
  visibleTiles,
  withheldCopy,
} from "./marketIndexStrip";

function sport(over: Partial<SportIndexSeries> & { sport: string }): SportIndexSeries {
  return {
    series: [],
    latestLevel: null,
    changePct: null,
    windowDays: 180,
    basketSize: null,
    asOf: null,
    freshMembers: null,
    usedWeight: null,
    stale: false,
    withheldReason: null,
    ...over,
  };
}

/** A normal, published sport with a drawable series. */
function published(name: string, level = 100): SportIndexSeries {
  return sport({
    sport: name,
    series: [
      { date: "2026-09-03", level: level - 1 },
      { date: "2026-09-04", level },
    ],
    latestLevel: level,
    changePct: 1,
    basketSize: 100,
    freshMembers: 94,
    asOf: "2026-09-04",
  });
}

/** A sport the backend deliberately did not price. */
function withheld(name: string, reason: string): SportIndexSeries {
  return sport({
    sport: name,
    series: [],
    stale: true,
    withheldReason: reason,
    basketSize: 100,
    freshMembers: 10,
    asOf: "2026-09-04",
  });
}

describe("plottable / isWithheld", () => {
  it("needs two points to draw a line", () => {
    expect(plottable(published("baseball"))).toBe(true);
    expect(plottable(sport({ sport: "x", series: [{ date: "d", level: 1 }] }))).toBe(false);
    expect(plottable(sport({ sport: "x" }))).toBe(false);
  });

  it("treats a withheld reason OR a carried level as withheld", () => {
    expect(isWithheld(withheld("pokemon", "series_start"))).toBe(true);
    expect(isWithheld(sport({ sport: "x", stale: true }))).toBe(true);
    expect(isWithheld(sport({ sport: "x", withheldReason: "no_basket" }))).toBe(true);
  });

  it("a never-computed sport is NOT withheld — nothing truthful to say", () => {
    expect(isWithheld(sport({ sport: "cricket" }))).toBe(false);
    expect(isWithheld(published("baseball"))).toBe(false);
  });
});

describe("withheld tile copy", () => {
  it("says there is no number when the basket could not be formed", () => {
    expect(withheldCopy(withheld("pokemon", "series_start"))).toBe("Not enough sales to price");
    expect(withheldCopy(withheld("hockey", "no_basket"))).toBe("Not enough sales to price");
  });

  it("says the level is carried when a prior level is being reused", () => {
    expect(withheldCopy(withheld("hockey", "used_weight_below_floor"))).toBe(
      "Carried · basket too thin",
    );
    expect(withheldCopy(sport({ sport: "hockey", stale: true }))).toBe("Carried · basket too thin");
  });
});

describe("PIN: the strip renders with 3 published + 2 withheld sports", () => {
  const indexes = [
    published("baseball", 115.1),
    published("basketball", 94),
    published("football", 98.3),
    withheld("hockey", "used_weight_below_floor"),
    withheld("pokemon", "series_start"),
  ];

  it("shows a tile for every one of the five — a withheld sport is not deleted", () => {
    const tiles = visibleTiles(indexes);
    expect(tiles.map((t) => t.sport)).toEqual([
      "baseball",
      "basketball",
      "football",
      "hockey",
      "pokemon",
    ]);
  });

  it("does not hide the strip because two sports are withheld", () => {
    expect(stripIsHidden({ status: "ok", indexes })).toBe(false);
  });

  it("still renders when only ONE sport is published and the rest are withheld", () => {
    const thin = [published("baseball"), withheld("pokemon", "no_basket")];
    expect(stripIsHidden({ status: "ok", indexes: thin })).toBe(false);
    expect(visibleTiles(thin)).toHaveLength(2);
  });

  it("renders a withheld-only response rather than vanishing", () => {
    const allWithheld = [withheld("pokemon", "series_start"), withheld("hockey", "no_basket")];
    expect(stripIsHidden({ status: "ok", indexes: allWithheld })).toBe(false);
    expect(visibleTiles(allWithheld)).toHaveLength(2);
  });
});

describe("PIN: the strip is absent ONLY on a missing capability", () => {
  it("hides on 404 and 501 — there is no such product on this deployment", () => {
    expect(statusForError({ status: 404 })).toBe("absent");
    expect(statusForError({ status: 501 })).toBe("absent");
    expect(stripIsHidden({ status: "absent", indexes: null })).toBe(true);
  });

  it("does NOT hide on 401, 402, 500, timeout or network failure", () => {
    for (const s of [401, 402, 403, 500, 502, 408, 0]) {
      expect(statusForError({ status: s })).toBe("error");
    }
    expect(statusForError(undefined)).toBe("error");
    expect(stripIsHidden({ status: "error", indexes: null })).toBe(false);
  });

  it("does not hide while loading — the skeleton holds the space", () => {
    expect(stripIsHidden({ status: "loading", indexes: null })).toBe(false);
  });

  it("hides only when the server answered fine and had nothing to say", () => {
    expect(stripIsHidden({ status: "ok", indexes: [] })).toBe(true);
    expect(stripIsHidden({ status: "ok", indexes: null })).toBe(true);
    // A sport that was never computed carries no reason and no series.
    expect(stripIsHidden({ status: "ok", indexes: [sport({ sport: "cricket" })] })).toBe(true);
  });
});

describe("PIN: prod shape on 2026-09-04", () => {
  // Exactly what Cosmos held: baseball/basketball/football/hockey
  // published, pokemon 180/180 levelless with reason `series_start`.
  const live = [
    published("baseball", 115.08),
    published("basketball", 93.96),
    published("football", 98.3),
    published("hockey", 135.68),
    withheld("pokemon", "series_start"),
  ];

  it("renders five tiles, not four", () => {
    expect(stripIsHidden({ status: "ok", indexes: live })).toBe(false);
    expect(visibleTiles(live)).toHaveLength(5);
  });

  it("pokemon says why it has no number instead of disappearing", () => {
    const pk = visibleTiles(live).find((t) => t.sport === "pokemon")!;
    expect(pk).toBeDefined();
    expect(plottable(pk)).toBe(false);
    expect(withheldCopy(pk)).toBe("Not enough sales to price");
  });
});
