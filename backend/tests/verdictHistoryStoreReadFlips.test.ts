// CF-VERDICT-FLIP-ALERTS-WIRE (Drew, 2026-07-16, iOS-prep). Pins the
// read-side helpers (readRecentFlips, readRecentFlipsForPlayers) that
// the /players/:player/verdict-history + /portfolio/flips routes use.
//
// Store is Cosmos-backed with a partition on /player. Tests use the
// exported _setContainerForTests hook to inject a minimal fake that
// answers the two query shapes readVerdictHistory issues: the
// range-by-partition + the item queries.

import { describe, it, expect, beforeEach } from "vitest";
import {
  readRecentFlips,
  readRecentFlipsForPlayers,
  _setContainerForTests,
  type VerdictDoc,
} from "../src/services/compiq/verdictHistoryStore.service.js";

interface FakeItems {
  query(spec: { query: string; parameters: Array<{ name: string; value: string }> }, opts: { partitionKey: string }): { fetchAll(): Promise<{ resources: VerdictDoc[] }> };
  upsert(doc: unknown): Promise<void>;
}
interface FakeContainer { items: FakeItems }

function makeFakeContainer(byPlayer: Record<string, VerdictDoc[]>): FakeContainer {
  return {
    items: {
      query: (spec, opts) => ({
        fetchAll: async () => {
          const player = opts.partitionKey;
          const docs = byPlayer[player] ?? [];
          const cutoffParam = spec.parameters.find((p) => p.name === "@cutoff")?.value;
          const todayParam = spec.parameters.find((p) => p.name === "@today")?.value;
          if (todayParam) {
            // recordVerdictAndDetectFlip's prior-day lookup — unused by readRecentFlips
            const prior = docs
              .filter((d) => d.date < todayParam)
              .sort((a, b) => (a.date < b.date ? 1 : -1))
              .slice(0, 1);
            return { resources: prior };
          }
          if (cutoffParam) {
            return {
              resources: docs
                .filter((d) => d.date >= cutoffParam)
                .sort((a, b) => (a.date < b.date ? -1 : 1)),
            };
          }
          return { resources: docs };
        },
      }),
      upsert: async () => { /* no-op */ },
    },
  };
}

function mkDoc(player: string, date: string, verdict: VerdictDoc["verdict"]): VerdictDoc {
  return {
    id: `${player}::${date}`,
    player,
    date,
    verdict,
    salesDirection: null,
    listingsDirection: null,
    generatedAt: `${date}T00:00:00Z`,
    ttl: 180 * 24 * 3600,
  };
}

describe("readRecentFlips — per-player flip detection over persisted history", () => {
  beforeEach(() => { _setContainerForTests(null); });

  it("returns empty when the player has fewer than 2 days of data", async () => {
    _setContainerForTests(makeFakeContainer({
      "eric-hartman": [mkDoc("eric-hartman", "2026-07-10", "mixed")],
    }) as never);
    const flips = await readRecentFlips("Eric Hartman", 30);
    expect(flips).toEqual([]);
  });

  it("detects a single flip between two consecutive-day snapshots", async () => {
    _setContainerForTests(makeFakeContainer({
      "eric-hartman": [
        mkDoc("eric-hartman", "2026-07-14", "mixed"),
        mkDoc("eric-hartman", "2026-07-15", "bull"),
      ],
    }) as never);
    const flips = await readRecentFlips("Eric Hartman", 30);
    expect(flips.length).toBe(1);
    expect(flips[0].from).toBe("mixed");
    expect(flips[0].to).toBe("bull");
    expect(flips[0].player).toBe("eric-hartman");
    expect(flips[0].date).toBe("2026-07-15");
  });

  it("skips stable stretches — no flip when consecutive verdicts match", async () => {
    _setContainerForTests(makeFakeContainer({
      "trout": [
        mkDoc("trout", "2026-07-10", "bull"),
        mkDoc("trout", "2026-07-11", "bull"),
        mkDoc("trout", "2026-07-12", "bull"),
        mkDoc("trout", "2026-07-13", "mixed"),
        mkDoc("trout", "2026-07-14", "mixed"),
      ],
    }) as never);
    const flips = await readRecentFlips("Trout", 30);
    expect(flips.length).toBe(1);
    expect(flips[0].date).toBe("2026-07-13");
    expect(flips[0].from).toBe("bull");
    expect(flips[0].to).toBe("mixed");
  });

  it("orders flips oldest → newest (the caller may re-sort)", async () => {
    _setContainerForTests(makeFakeContainer({
      "hartman": [
        mkDoc("hartman", "2026-07-01", "bear"),
        mkDoc("hartman", "2026-07-02", "mixed"),
        mkDoc("hartman", "2026-07-05", "bull"),
        mkDoc("hartman", "2026-07-06", "strong_bull"),
      ],
    }) as never);
    const flips = await readRecentFlips("Hartman", 30);
    expect(flips.map((f) => f.date)).toEqual(["2026-07-02", "2026-07-05", "2026-07-06"]);
  });

  it("returns empty when the container is unavailable (no throw)", async () => {
    _setContainerForTests(null);
    const flips = await readRecentFlips("Nobody", 30);
    expect(flips).toEqual([]);
  });
});

describe("readRecentFlipsForPlayers — batch across a portfolio", () => {
  beforeEach(() => { _setContainerForTests(null); });

  it("aggregates flips across multiple players", async () => {
    _setContainerForTests(makeFakeContainer({
      "eric-hartman": [
        mkDoc("eric-hartman", "2026-07-14", "mixed"),
        mkDoc("eric-hartman", "2026-07-15", "bull"),
      ],
      "trout": [
        mkDoc("trout", "2026-07-15", "bull"),
        mkDoc("trout", "2026-07-16", "strong_bull"),
      ],
    }) as never);
    const flips = await readRecentFlipsForPlayers(["Eric Hartman", "Trout"], 30);
    expect(flips.length).toBe(2);
    // Sorted newest first
    expect(flips[0].date).toBe("2026-07-16");
    expect(flips[1].date).toBe("2026-07-15");
  });

  it("de-duplicates requested players by normalized name", async () => {
    _setContainerForTests(makeFakeContainer({
      "eric-hartman": [
        mkDoc("eric-hartman", "2026-07-14", "mixed"),
        mkDoc("eric-hartman", "2026-07-15", "bull"),
      ],
    }) as never);
    const flips = await readRecentFlipsForPlayers(["Eric Hartman", "eric hartman", "  Eric Hartman  "], 30);
    expect(flips.length).toBe(1);
  });

  it("empty players array returns empty flips (route enforces non-empty; store is tolerant)", async () => {
    const flips = await readRecentFlipsForPlayers([], 7);
    expect(flips).toEqual([]);
  });

  it("filters flips to the requested window (respects days parameter)", async () => {
    _setContainerForTests(makeFakeContainer({
      "old-player": [
        mkDoc("old-player", "2026-01-01", "bull"),
        mkDoc("old-player", "2026-01-02", "bear"),
      ],
    }) as never);
    // Force short window: cutoff = today - 7d. All history is > 6 months old → drops.
    const flips = await readRecentFlipsForPlayers(["Old Player"], 7);
    expect(flips).toEqual([]);
  });
});
