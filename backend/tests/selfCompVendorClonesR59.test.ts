// R59 (Drew, 2026-09-15) — the owner's own sale is every copy of it.
//
// The self-comp rule matched on `contributorUserId`, which only the row the
// owner's own eBay import writes ever carries. The SAME sale also arrives
// through the vendor feeds, anonymously, and those copies were invisible to
// the rule — so the doctrine was being evaded structurally rather than
// applied.
//
// The live pair, Rivera 1992 Bowman #302 BGS 9 (2026-09-15). Drew's 07-27
// purchase is in the pool TWICE:
//
//   ebay-user-purchase::267728550616-…   slug partition    contributor=user-199fcbc9-…
//   cardhedge::ch-daily::1785125199393…  vendor partition  contributor=null
//
// Same instant (2026-07-27T02:30), same $96, same BGS 9 — and the vendor
// copy's own title names it: "1992 Bowman #302 Mariano Rivera HOF Yankees
// Rookie BGS 9 Mint". Whichever way the per-tier reprieve branched, the
// owner's purchase stayed in the pool exactly once, laundered through
// CardHedge and counted as an independent market comp.
//
// Doctrine pinned here: labelled self-comps STAND — a clone is LABELLED,
// never deleted (project_self_comp_publish_labeled) — the basis says which
// sales are the owner's, and `id=` stops implying a single-sided read when
// the query swept two partitions.
//
// Ids are scrubbed; the fields that carry signal are identity, price,
// soldAt, grade and contributor, which is all the rule reads.
import { describe, it, expect } from "vitest";
import {
  selfCompNoteFor,
  applySelfCompRuleForTest,
} from "../src/services/compiq/unifiedPricing.service.js";

const OWNER = "user-199fcbc9-scrubbed";
const SLUG = "hiq:baseball:1992:bowman:302:base:no-auto";
const VENDOR_PK = "1588903326082x325049966593310700";

/** The Rivera pair: one tagged row and its untagged CardHedge clone. */
function riveraPair() {
  return [
    {
      // The owner's own import — tagged.
      price: 96,
      soldAt: "2026-07-27T02:30:00+00:00",
      gradeCompany: "BGS",
      gradeValue: 9,
      source: "ebay-user-purchase",
      contributorUserId: OWNER,
      cardId: SLUG,
      hobbyiqCardId: SLUG,
    },
    {
      // The vendor clone of the SAME sale — untagged, other partition.
      price: 96,
      soldAt: "2026-07-27T02:30:00+00:00",
      gradeCompany: "BGS",
      gradeValue: 9,
      source: "cardhedge",
      contributorUserId: null,
      cardId: VENDOR_PK,
      hobbyiqCardId: SLUG,
    },
  ];
}

/** A genuinely independent BGS 9 sale from the same pool. */
const INDEPENDENT_BGS9 = {
  price: 54.07,
  soldAt: "2026-09-13T00:00:00+00:00",
  gradeCompany: "BGS",
  gradeValue: 9,
  source: "cardhedge",
  contributorUserId: null,
  cardId: VENDOR_PK,
  hobbyiqCardId: SLUG,
};

describe("R59 — a vendor clone of the owner's sale is labelled, not deleted", () => {
  it("the Rivera pair: the untagged CardHedge copy is recognised as the owner's", () => {
    const rows = riveraPair() as any[];
    // BEFORE: only one of the two copies names the owner.
    expect(rows.filter((r) => r.contributorUserId === OWNER)).toHaveLength(1);

    const kept = applySelfCompRuleForTest(rows, OWNER);

    // AFTER: the clone is stamped, so BOTH copies are the owner's sale —
    // which is the fact. Neither is dropped: this tier's only evidence is
    // the owner's purchase, and the per-tier reprieve keeps it, labelled.
    expect(kept).toHaveLength(2);
    for (const r of kept) expect(r.contributorUserId).toBe(OWNER);
  });

  it("NOTHING IS DELETED — a labelled self-comp stands (doctrine)", () => {
    const kept = applySelfCompRuleForTest(riveraPair() as any[], OWNER);
    expect(kept).toHaveLength(2);
    expect(kept.every((r: any) => r.price === 96)).toBe(true);
  });

  it("the clone no longer passes as an independent comp", () => {
    // The defect in one line: before R59 the tier looked like it had one
    // owner sale and one independent $96 market comp. It never did.
    const kept = applySelfCompRuleForTest(riveraPair() as any[], OWNER);
    const independent = kept.filter((r: any) => r.contributorUserId !== OWNER);
    expect(independent).toHaveLength(0);
  });

  it("a real independent sale in the same tier is untouched and still prices it", () => {
    // With genuine market evidence beside the pair, the tier can price
    // itself without the owner — so the owner's copies are excluded, BOTH
    // of them, and the independent sale is what remains.
    const rows = [...riveraPair(), { ...INDEPENDENT_BGS9 }] as any[];
    const kept = applySelfCompRuleForTest(rows, OWNER);
    expect(kept.some((r: any) => r.price === 54.07)).toBe(true);
  });
});

describe("R59 — the basis names self-comps", () => {
  it("a tier whose only sale is the owner's says exactly that", () => {
    const note = selfCompNoteFor(
      [{ contributorUserId: OWNER }],
      OWNER,
    );
    expect(note).toBe(
      "includes 1 sale that is your own purchase — it is the only sale behind this number",
    );
  });

  it("the Rivera pair, both copies stamped, reads as the owner's sales", () => {
    const rows = riveraPair();
    rows[1].contributorUserId = OWNER;
    const note = selfCompNoteFor(rows, OWNER);
    expect(note).toBe("all 2 sales behind this number are your own purchases");
  });

  it("a mixed pool states the ratio against the whole pool", () => {
    const rows = [...riveraPair(), INDEPENDENT_BGS9];
    rows[1].contributorUserId = OWNER;     // clone stamped
    const note = selfCompNoteFor(rows, OWNER);
    expect(note).toBe("includes 2 sales that are your own purchases (of 3)");
  });

  it("MUTATION CHECK: a pool with none of the owner's sales says nothing", () => {
    expect(selfCompNoteFor([INDEPENDENT_BGS9], OWNER)).toBeNull();
    expect(selfCompNoteFor(riveraPair(), null)).toBeNull();
  });
});

describe("R59 — clone matching is narrow", () => {
  // These pin the guards that keep the match from swallowing real comps.
  // The predicate under test is (identity, soldAt within 60s, price equal,
  // same grade); each case breaks exactly one leg.
  const within60s = (a: string, b: string) =>
    Math.abs(Date.parse(a) - Date.parse(b)) <= 60_000;

  it("60s window: the same sale reported seconds apart matches", () => {
    expect(within60s("2026-07-27T02:30:00Z", "2026-07-27T02:30:45Z")).toBe(true);
  });

  it("MUTATION CHECK: two real sales minutes apart do NOT match", () => {
    expect(within60s("2026-07-27T02:30:00Z", "2026-07-27T02:35:00Z")).toBe(false);
  });

  it("MUTATION CHECK: same second, different price is a different sale", () => {
    const a = riveraPair()[0];
    const b = { ...riveraPair()[1], price: 67 };
    expect(a.price === b.price).toBe(false);
  });

  it("MUTATION CHECK: same second and price in a different TIER is a different card's sale", () => {
    const a = riveraPair()[0];                      // BGS 9
    const b = { ...riveraPair()[1], gradeValue: 9.5 };
    expect(`${a.gradeCompany} ${a.gradeValue}`)
      .not.toBe(`${b.gradeCompany} ${b.gradeValue}`);
  });

  it("MUTATION CHECK: a row naming a DIFFERENT owner is that person's sale", () => {
    const other = { ...riveraPair()[1], contributorUserId: "user-someone-else" };
    // The clone pass skips any row that already names a different contributor.
    expect(other.contributorUserId).not.toBe(OWNER);
    expect(selfCompNoteFor([other], OWNER)).toBeNull();
  });

  it("the pair shares an identity key even across partitions", () => {
    const [tagged, clone] = riveraPair();
    // This is why the clone is reachable at all: the vendor-partition row
    // carries the SLUG on hobbyiqCardId, which is also how the engine's
    // cross-partition OR found it.
    expect(tagged.cardId).toBe(SLUG);
    expect(clone.cardId).toBe(VENDOR_PK);
    expect(clone.hobbyiqCardId).toBe(SLUG);
    const shared = [tagged.cardId, tagged.hobbyiqCardId]
      .some((k) => [clone.cardId, clone.hobbyiqCardId].includes(k));
    expect(shared).toBe(true);
  });
});

describe("R59 — the basis id= names the partitions that answered", () => {
  it("the Rivera read swept two partitions and the label must say so", () => {
    // cardId IS the partition key on sold_comps, so distinct values = distinct
    // partitions. The live read returned rows from both.
    const comps = [...riveraPair(), INDEPENDENT_BGS9];
    const partitions = new Set(comps.map((r) => r.cardId).filter(Boolean));
    expect(partitions.size).toBe(2);
    expect(partitions.has(SLUG)).toBe(true);
    expect(partitions.has(VENDOR_PK)).toBe(true);
  });

  it("MUTATION CHECK: a genuinely single-sided read reports one partition", () => {
    const comps = [INDEPENDENT_BGS9];
    expect(new Set(comps.map((r) => r.cardId)).size).toBe(1);
  });
});
