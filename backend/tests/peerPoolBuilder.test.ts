import { describe, it, expect } from "vitest";
import {
  buildPeerPool,
  resolvePeerTier,
  type PeerPoolComp,
} from "../src/services/compiq/peerPoolBuilder";
import {
  inMemoryTierLookup,
  inferRelatedSetsHeuristic,
  normalizeParallelKey,
} from "../src/services/compiq/parallelAttributesLookup";

// Issue #25 Phase 3 — peer pool builder tests.
// Uses inMemoryTierLookup to avoid Cosmos network I/O.

const SUBJECT_SET = "2024 Bowman Chrome Baseball";

// Skenes-curated tier map matches Stage 3 dev Cosmos state.
const SKENES_SET_MAP: Record<string, number> = {
  [normalizeParallelKey("Base", false)]: 1,
  [normalizeParallelKey("Refractor", false)]: 2,
  [normalizeParallelKey("Blue Refractor", false)]: 4,
  [normalizeParallelKey("Gold Refractor", false)]: 6,
  [normalizeParallelKey("Red Refractor", false)]: 7,
};

function lookup() {
  return inMemoryTierLookup({ [SUBJECT_SET]: SKENES_SET_MAP });
}

function comp(price: number, title: string, set: string | null = null): PeerPoolComp {
  return { price, title, set };
}

describe("normalizeParallelKey", () => {
  it("lowercases, trims, collapses whitespace", () => {
    expect(normalizeParallelKey("  Gold   Refractor ", false)).toBe("gold refractor");
  });
  it("appends |auto for autograph parallels", () => {
    expect(normalizeParallelKey("Refractor", true)).toBe("refractor|auto");
  });
});

describe("resolvePeerTier", () => {
  const setMap = new Map<string, number>(Object.entries(SKENES_SET_MAP));

  it("matches an exact curated parallel name", () => {
    expect(resolvePeerTier("Gold Refractor", false, setMap)).toBe(6);
  });

  it("matches a bare-color parser output via the ' Refractor' suffix variant", () => {
    // parseCardQuery returns "Blue" alone for a "2024 Bowman Chrome Blue Refractor" title
    expect(resolvePeerTier("Blue", false, setMap)).toBe(4);
  });

  it("matches Base for an empty/null parallel (base card)", () => {
    expect(resolvePeerTier(null, false, setMap)).toBe(1);
  });

  it("returns null when the parallel is not curated", () => {
    expect(resolvePeerTier("Purple Mojo Refractor", false, setMap)).toBeNull();
  });
});

describe("inferRelatedSetsHeuristic", () => {
  it("expands Bowman Chrome family for a given year", () => {
    const out = inferRelatedSetsHeuristic("2024 Bowman Chrome Prospects Autograph");
    expect(out).toContain("2024 Bowman Chrome Baseball");
    expect(out).toContain("2024 Bowman Chrome Prospects");
    // Subject must be excluded
    expect(out.some((s) => /Prospects Autograph/.test(s))).toBe(false);
  });

  it("returns [] when no year is detectable", () => {
    expect(inferRelatedSetsHeuristic("Bowman Chrome Baseball")).toEqual([]);
  });
});

describe("buildPeerPool — primary set (same player, same set, different parallel)", () => {
  it("builds a pool from Bowman Chrome comps with parser-inferred tiers", async () => {
    const comps: PeerPoolComp[] = [
      comp(300, "2024 Bowman Chrome Paul Skenes BCP-179"),                  // Base → tier 1
      comp(450, "2024 Bowman Chrome Paul Skenes Refractor BCP-179"),         // Refractor → tier 2
      comp(2800, "2024 Bowman Chrome Paul Skenes Gold Refractor /50 BCP-179"), // Gold → tier 6
    ];
    const r = await buildPeerPool({
      subjectPlayer: "Paul Skenes",
      subjectSet: SUBJECT_SET,
      subjectParallelName: "Blue Refractor",
      subjectIsAutograph: false,
      comps,
      lookup: lookup(),
    });
    expect(r.subjectTier).toBe(4);
    expect(r.peerPool.length).toBe(3);
    expect(r.peerPool.map((p) => p.tier).sort()).toEqual([1, 2, 6]);
    expect(r.diagnostics.nullReason).toBeNull();
    expect(r.diagnostics.primarySetCount).toBe(3);
    expect(r.diagnostics.fallbackPeerCount).toBe(0);
  });

  it("excludes comps that match the subject's own parallel name", async () => {
    const comps: PeerPoolComp[] = [
      comp(1200, "2024 Bowman Chrome Paul Skenes Blue Refractor /150"), // SAME as subject → drop
      comp(300, "2024 Bowman Chrome Paul Skenes BCP-179"),
      comp(450, "2024 Bowman Chrome Paul Skenes Refractor BCP-179"),
      comp(2800, "2024 Bowman Chrome Paul Skenes Gold Refractor /50"),
    ];
    const r = await buildPeerPool({
      subjectPlayer: "Paul Skenes",
      subjectSet: SUBJECT_SET,
      subjectParallelName: "Blue Refractor",
      subjectIsAutograph: false,
      comps,
      lookup: lookup(),
    });
    expect(r.peerPool.length).toBe(3);
    expect(r.diagnostics.dropCounts.same_parallel_as_subject).toBe(1);
  });

  it("drops comps whose parsed parallel isn't curated", async () => {
    // Use a narrowly-curated set map so the parser-extracted parallel
    // ("Gold" from "Gold Refractor") has no matching tier.
    const narrowLookup = inMemoryTierLookup({
      [SUBJECT_SET]: {
        [normalizeParallelKey("Base", false)]: 1,
        [normalizeParallelKey("Refractor", false)]: 2,
        [normalizeParallelKey("Blue Refractor", false)]: 4,
      },
    });
    const comps: PeerPoolComp[] = [
      comp(300, "2024 Bowman Chrome Paul Skenes BCP-179"),
      comp(450, "2024 Bowman Chrome Paul Skenes Refractor BCP-179"),
      comp(2800, "2024 Bowman Chrome Paul Skenes Gold Refractor /50"),    // uncurated in narrow map
    ];
    const r = await buildPeerPool({
      subjectPlayer: "Paul Skenes",
      subjectSet: SUBJECT_SET,
      subjectParallelName: "Blue Refractor",
      subjectIsAutograph: false,
      comps,
      lookup: narrowLookup,
    });
    expect(r.peerPool.length).toBe(2);
    expect(r.diagnostics.dropCounts.uncurated_peer_parallel).toBe(1);
    expect(r.diagnostics.nullReason).toBe("peer_pool_too_small");
  });

  it("returns peer_pool_too_small when fewer than 3 peers survive", async () => {
    const comps: PeerPoolComp[] = [
      comp(300, "2024 Bowman Chrome Paul Skenes BCP-179"),
      comp(450, "2024 Bowman Chrome Paul Skenes Refractor BCP-179"),
      // Subject's own parallel — excluded
      comp(1200, "2024 Bowman Chrome Paul Skenes Blue Refractor /150"),
    ];
    const r = await buildPeerPool({
      subjectPlayer: "Paul Skenes",
      subjectSet: SUBJECT_SET,
      subjectParallelName: "Blue Refractor",
      subjectIsAutograph: false,
      comps,
      lookup: lookup(),
    });
    expect(r.peerPool.length).toBe(2);
    expect(r.diagnostics.nullReason).toBe("peer_pool_too_small");
  });
});

describe("buildPeerPool — fallback to related sets", () => {
  it("augments with related-set comps when primary set has < 3", async () => {
    const relatedSet = "2024 Bowman Chrome Prospects";
    const subjectSet = "2024 Bowman Chrome Prospects Autograph";
    const lookupTwoSets = inMemoryTierLookup(
      {
        // Subject's own set has nothing curated (only Auto Refractor for the subject).
        [subjectSet]: {
          [normalizeParallelKey("Blue Refractor", true)]: 5,
        },
        // Related set is fully curated.
        [relatedSet]: SKENES_SET_MAP,
      },
      // Stub the related-set inference so we get a deterministic single fallback.
      () => [relatedSet],
    );

    const comps: PeerPoolComp[] = [
      // No same-set peers available.
      comp(80, "2024 Bowman Chrome Prospects Player BCP-2", relatedSet),
      comp(120, "2024 Bowman Chrome Prospects Player Refractor BCP-2", relatedSet),
      comp(600, "2024 Bowman Chrome Prospects Player Gold Refractor /50", relatedSet),
    ];
    const r = await buildPeerPool({
      subjectPlayer: "Same Player",
      subjectSet,
      subjectParallelName: "Blue Refractor",
      subjectIsAutograph: true,
      comps,
      lookup: lookupTwoSets,
    });
    expect(r.peerPool.length).toBe(3);
    expect(r.diagnostics.primarySetCount).toBe(0);
    expect(r.diagnostics.fallbackPeerCount).toBe(3);
    expect(r.diagnostics.fallbackSetsUsed).toEqual([relatedSet]);
    expect(r.subjectTier).toBe(5);
  });

  it("returns null when even combined pool is still < 3", async () => {
    const lookupNoRelated = inMemoryTierLookup(
      { [SUBJECT_SET]: SKENES_SET_MAP },
      () => ["2024 Bowman Chrome Prospects"], // related set exists but no comps from it
    );
    const comps: PeerPoolComp[] = [
      comp(300, "2024 Bowman Chrome Paul Skenes BCP-179"),
      comp(450, "2024 Bowman Chrome Paul Skenes Refractor"),
    ];
    const r = await buildPeerPool({
      subjectPlayer: "Paul Skenes",
      subjectSet: SUBJECT_SET,
      subjectParallelName: "Blue Refractor",
      subjectIsAutograph: false,
      comps,
      lookup: lookupNoRelated,
    });
    expect(r.peerPool.length).toBe(2);
    expect(r.diagnostics.nullReason).toBe("peer_pool_too_small");
  });
});

describe("buildPeerPool — edge cases", () => {
  it("returns subject_set_missing when subjectSet is empty/whitespace", async () => {
    const r = await buildPeerPool({
      subjectPlayer: "X",
      subjectSet: "  ",
      subjectParallelName: "Blue Refractor",
      subjectIsAutograph: false,
      comps: [],
      lookup: lookup(),
    });
    expect(r.diagnostics.nullReason).toBe("subject_set_missing");
    expect(r.peerPool).toEqual([]);
  });

  it("drops comps with zero / negative / non-finite prices", async () => {
    const comps: PeerPoolComp[] = [
      { price: 0, title: "2024 Bowman Chrome Paul Skenes" },
      { price: -5, title: "2024 Bowman Chrome Paul Skenes Refractor" },
      { price: Number.NaN, title: "2024 Bowman Chrome Paul Skenes Gold Refractor /50" },
      // Three valid peers so the pool still meets the gate
      comp(300, "2024 Bowman Chrome Paul Skenes BCP-179"),
      comp(450, "2024 Bowman Chrome Paul Skenes Refractor BCP-179"),
      comp(2800, "2024 Bowman Chrome Paul Skenes Gold Refractor /50"),
    ];
    const r = await buildPeerPool({
      subjectPlayer: "Paul Skenes",
      subjectSet: SUBJECT_SET,
      subjectParallelName: "Blue Refractor",
      subjectIsAutograph: false,
      comps,
      lookup: lookup(),
    });
    expect(r.peerPool.length).toBe(3);
    expect(r.diagnostics.dropCounts.invalid_price).toBeGreaterThanOrEqual(3);
  });
});
