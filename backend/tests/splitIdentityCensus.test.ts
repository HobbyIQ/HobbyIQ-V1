/**
 * SPLIT-IDENTITY -- the predicate the corpus census, the rematch classifier and
 * the pricing invariant auditor all decide with.
 *
 * CF-A-SPLIT-ROW-POLLUTES-TWO-POOLS (Drew, 2026-09-02: "we need to go back and
 * check ALL this way"). A sold_comps row carries two identity fields and
 * exactPoolReader.ts matches on EITHER, so a row whose `cardId` and
 * `hobbyiqCardId` name different cards is read into BOTH pools and prices two
 * cards off one sale.
 *
 * The whole safety of a corpus sweep rests on ONE distinction, so it is what
 * this file pins:
 *
 *   VENDOR-DESIGN  cardId is a vendor product id, hobbyiqCardId is our slug.
 *                  The designed ingest partition -- 13.5M CardHedge rows are
 *                  shaped exactly this way and a control read proved 1242 of
 *                  1242 rows on two untouched cards match it (#1650). NEVER
 *                  flagged; relocating these would mis-repair the whole pool.
 *   HIQ-SPLIT      both sides are hiq: slugs naming different cards. No ingest
 *                  designed this. THE damage class.
 *
 * The MUTATION CHECK at the bottom is the load-bearing test: drop the vendor
 * exemption from the real source and the control shape must turn the census
 * red. If that test ever passes with the mutation IN PLACE, the exemption has
 * stopped working and a sweep would drown in millions of false positives.
 *
 * Every shape here is a real one, measured against the live pool 2026-09-02.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

type Classification = {
  klass: string; split: boolean; vendorShape: string | null;
  segments: string[]; reason: string; cardId: string; hobbyiqCardId: string;
};
type SplitLib = {
  COHERENT: string; VENDOR_DESIGN: string; UNKNOWN_VENDOR: string;
  HIQ_SPLIT: string; MALFORMED: string;
  VENDOR_SHAPES: Array<{ name: string; example: string; re: RegExp }>;
  vendorShapeOf: (id: unknown) => string | null;
  differingSegments: (a: string, b: string) => string[];
  classifyIdentity: (row: Record<string, unknown>) => Classification;
  renderSplit: (c: Classification) => string;
};
const LIB = path.join(backend, "scripts", "lib", "split-identity.cjs");
const S = require_(LIB) as SplitLib;

/** The CardHedge control shape (#1650): a Bubble product id beside our slug. */
const CONTROL_VENDOR_ROW = {
  id: "v1",
  source: "cardhedge",
  cardId: "1778542173652x303328120692600800",
  hobbyiqCardId: "hiq:baseball:2026:bowman-chrome:cpa-eha:base:auto",
};

/** A real hiq-vs-hiq split from the pool: two products, one sale. */
const CONTROL_SPLIT_ROW = {
  id: "s1",
  source: "cardhedge",
  cardId: "hiq:baseball:2026:topps-finest:196:base:no-auto",
  hobbyiqCardId: "hiq:baseball:2026:topps-series-1:196:base:no-auto",
};

describe("VENDOR-DESIGN — the designed partition is never damage", () => {
  it("a CardHedge bubble id beside our slug is exempt and not flagged", () => {
    const c = S.classifyIdentity(CONTROL_VENDOR_ROW);
    expect(c.klass).toBe(S.VENDOR_DESIGN);
    expect(c.split).toBe(false);
    expect(c.vendorShape).toBe("bubble-id");
  });

  it("every enumerated vendor shape's own example classifies VENDOR-DESIGN", () => {
    // The examples in the lib are what a future reader re-measures against. If
    // one stops matching its own regex the documentation has drifted from the
    // code, and the census would start reporting that ingest as damage.
    for (const shape of S.VENDOR_SHAPES) {
      // The uuid examples in the header are elided with an ellipsis for width;
      // reconstruct full-length ones for the two that need it.
      const example = shape.example.includes("…")
        ? shape.example
          .replace("befe9bcc-…", "befe9bcc-e7e8-458c-9cd8-ce831848b9a1")
          .replace("334908f4-…", "334908f4-bf5f-4ed5-98c7-75113561ab55")
          .replace("f11498f6-…", "f11498f6-2cf9-4453-8bef-000000000000")
        : shape.example;
      const c = S.classifyIdentity({ cardId: example, hobbyiqCardId: "hiq:baseball:2026:bowman:1:base:no-auto" });
      expect(c.klass, `${shape.name} example "${example}" should be VENDOR-DESIGN`).toBe(S.VENDOR_DESIGN);
      expect(c.split).toBe(false);
    }
  });

  it("the bubble-id shape is anchored — junk WRAPPING a bubble id is not exempt", () => {
    // An unanchored test would read this as a clean vendor key and exempt a row
    // nobody can explain.
    const c = S.classifyIdentity({
      cardId: "garbage-1778542173652x303328120692600800-garbage",
      hobbyiqCardId: "hiq:baseball:2026:bowman:1:base:no-auto",
    });
    expect(c.klass).toBe(S.UNKNOWN_VENDOR);
    expect(c.split).toBe(true);
  });

  it("a foreign cardId of an UNMEASURED shape is reported, never silently exempted", () => {
    // A new ingest's key shape is something Drew should be told about. The
    // exemption is a closed list, not "anything that is not a slug".
    const c = S.classifyIdentity({ cardId: "someNewVendor/abc123", hobbyiqCardId: "hiq:baseball:2026:bowman:1:base:no-auto" });
    expect(c.klass).toBe(S.UNKNOWN_VENDOR);
    expect(c.split).toBe(true);
  });

  it("a vendor id in the hobbyiqCardId field is MALFORMED, not a partition", () => {
    // The partition reading requires OUR slug on the hobbyiqCardId side. A
    // vendor id there is a row whose canonical slug was never derived.
    const c = S.classifyIdentity({
      cardId: "hiq:baseball:2026:bowman:1:base:no-auto",
      hobbyiqCardId: "1778542173652x303328120692600800",
    });
    expect(c.klass).toBe(S.MALFORMED);
    expect(c.split).toBe(true);
  });
});

describe("HIQ-SPLIT — both sides hiq:, different cards", () => {
  it("two different slugs on one row is the damage class", () => {
    const c = S.classifyIdentity(CONTROL_SPLIT_ROW);
    expect(c.klass).toBe(S.HIQ_SPLIT);
    expect(c.split).toBe(true);
    expect(c.segments).toEqual(["setKey"]);
  });

  it("identical fields are COHERENT, and so is a row carrying only one", () => {
    const same = "hiq:baseball:2026:bowman:1:base:no-auto";
    expect(S.classifyIdentity({ cardId: same, hobbyiqCardId: same }).klass).toBe(S.COHERENT);
    // An absent hobbyiqCardId is a COVERAGE question, not a coherence one --
    // conflating them would let a backfill gap read as pool damage.
    expect(S.classifyIdentity({ cardId: same, hobbyiqCardId: null }).klass).toBe(S.COHERENT);
    expect(S.classifyIdentity({ cardId: same }).split).toBe(false);
  });

  it("sub-buckets name the segment that disagrees — the kind of damage", () => {
    // Each of these is a real shape sampled from the pool 2026-09-02.
    const cases: Array<[string, string, string[]]> = [
      // sport: baseball vs wrestling for one Topps Chrome sale
      ["hiq:baseball:2025:topps-chrome:26:red-refractor:auto:num-5",
        "hiq:wrestling:2025:topps-chrome:26:red-refractor:auto", ["sport", "printRun"]],
      // parallel: blue-sapphire vs blue-sapphire-refractor
      ["hiq:baseball:2026:bowman-chrome-sapphire:bspa-oc:blue-sapphire:auto:num-199",
        "hiq:baseball:2026:bowman-chrome-sapphire:bspa-oc:blue-sapphire-refractor:auto:num-199", ["parallel"]],
      // cardNumber: bdc95 vs bdc-95
      ["hiq:baseball:2024:bowman-chrome:bdc95:refractor:no-auto",
        "hiq:baseball:2024:bowman-chrome:bdc-95:refractor:no-auto", ["cardNumber"]],
    ];
    for (const [a, b, expected] of cases) {
      expect(S.differingSegments(a, b), `${a} vs ${b}`).toEqual(expected);
    }
  });

  it("an ABSENT print run counts as a disagreement, not as a wildcard", () => {
    // The commonest split shape: the same card with and without :num-N. If
    // absence matched anything, the form that empties a pool would be hidden.
    const c = S.classifyIdentity({
      cardId: "hiq:baseball:2025:bowman-draft:cpa-jha:base:auto",
      hobbyiqCardId: "hiq:baseball:2025:bowman-draft:cpa-jha:base:auto:num-150",
    });
    expect(c.klass).toBe(S.HIQ_SPLIT);
    expect(c.segments).toEqual(["printRun"]);
  });
});

describe("MUTATION CHECK: the vendor exemption is load-bearing", () => {
  // A guard nothing tests is a guard that gets deleted. Drop the exemption from
  // the real source and re-evaluate: the CardHedge control shape -- 13.5M rows
  // of designed partition -- must turn the census RED. That is precisely the
  // false-positive flood the exemption prevents, and the reason #1650 exists.
  it("removing the exemption makes the designed CardHedge shape read as damage", () => {
    const src = fs.readFileSync(LIB, "utf8");
    // The exemption is the branch that returns VENDOR_DESIGN for a recognised
    // foreign cardId. Neutralise the recogniser: no shape ever matches.
    const guard = "for (const shape of VENDOR_SHAPES) if (shape.re.test(s)) return shape.name;";
    expect(src).toContain(guard);
    const mutated = src.replace(guard, "// exemption removed by the mutation check");
    expect(mutated).not.toBe(src);

    const tmp = path.join(backend, "scripts", "lib", `.split-identity.mutant-${process.pid}.cjs`);
    try {
      fs.writeFileSync(tmp, mutated);
      const mutant = require_(tmp) as SplitLib;

      const real = S.classifyIdentity(CONTROL_VENDOR_ROW);
      const broken = mutant.classifyIdentity(CONTROL_VENDOR_ROW);

      // The exemption is the ONLY thing standing between these two answers.
      expect(real.klass).toBe(S.VENDOR_DESIGN);
      expect(real.split).toBe(false);
      expect(broken.klass).toBe(S.UNKNOWN_VENDOR);
      expect(broken.split).toBe(true);

      // And the real damage class is UNAFFECTED by the mutation -- proof the
      // exemption narrows false positives without hiding true ones.
      expect(mutant.classifyIdentity(CONTROL_SPLIT_ROW).klass).toBe(S.HIQ_SPLIT);
      expect(S.classifyIdentity(CONTROL_SPLIT_ROW).klass).toBe(S.HIQ_SPLIT);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });
});

describe("the census script is read-only and dispatchable", () => {
  const script = path.join(backend, "scripts", "census-split-identity.cjs");

  it("exists and contains no write call", () => {
    expect(fs.existsSync(script)).toBe(true);
    const src = fs.readFileSync(script, "utf8");
    // The census must never mutate the pool. Every Cosmos write goes through
    // one of these, so their absence from the source is the read-only proof.
    for (const call of ["items.create", "items.upsert", "items.bulk", ".patch(", ".delete("]) {
      expect(src.includes(call), `census must not call ${call}`).toBe(false);
    }
  });

  it("never uses the field-to-field predicate that is not index-served", () => {
    const src = fs.readFileSync(script, "utf8");
    // `c.cardId != c.hobbyiqCardId` cannot be served by an index; measured
    // 2026-09-02 it returned nothing at all rather than returning slowly. The
    // walk MUST stay an indexed range plus a client-side compare.
    //
    // Comment lines are stripped before the test: the header DOCUMENTS the
    // forbidden query (that is why the walk is shaped the way it is), and a
    // test that cannot tell prose from code would force the explanation out
    // of the file to stay green.
    const code = src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    expect(/c\.cardId\s*[!=]=\s*c\.hobbyiqCardId/.test(code)).toBe(false);
    expect(src).toContain("c._ts >= @lo AND c._ts < @hi");
  });

  it("prints the budget marker the runner greps for a relaunch", () => {
    const src = fs.readFileSync(script, "utf8");
    // The runner's regex is "stopped at the .*budget" (#1361). A marker in
    // different words is a census that can never continue past one budget.
    expect(src).toMatch(/stopped at the \$\{RUN_MINUTES\}-minute budget/);
  });
});
