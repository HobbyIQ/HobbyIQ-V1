// CF-A-ROW-IN-THE-WRONG-SPORT-IS-NOT-A-MISSING-CHECKLIST (2026-09-07) — the pins.
//
// The 2026-09-07 auto-seed census measured 32,044 card_catalog rows carrying a
// sport with ZERO checklist backing in their product-year — 1,145 of them
// claiming FOOTBALL on 1948–1955 Bowman, a baseball-only product. Every one is
// reachable by retire-self-derived-identities (`ingest-auto-seed` leads
// SD_SOURCES), and every one was misfiled by it: the lane compares twins within
// (sport, year, setKey), so a row whose SPORT is wrong finds no twin BY
// CONSTRUCTION and lands on the ACQUISITION QUEUE — generating requests for
// checklists that cannot exist.
//
// THREE BRANCHES, ONE PIN EACH, and the pins are written so that DELETING the
// detection turns them red (a pin that passes against a mutated rule is
// decoration — the lesson of splitIdentityCensus.test.ts's exemption mutation):
//
//   1. TWIN FOUND under the true sport  -> RETIRE, `sport-contaminated:twin-in-<sport>`
//   2. NO TWIN under the true sport     -> identityUnverified, `sport-contaminated:no-twin`,
//                                          AND NO ACQUISITION ENQUEUE
//   3. SEVERAL sports attest            -> identityUnverified, `sport-ambiguous`, no enqueue
//
// THE MUTATION IS THE ENQUEUE. Section 5 drops the detection — exactly as a
// regression would — and asserts that the wrong-sport cell reappears on the
// acquisition queue. That is the harm the change exists to prevent, so it is
// the thing the mutation must surface; a mutation that only flipped a counter
// would pin bookkeeping rather than the defect.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);
const ROOT = path.join(__dirname, "..", "..");
const BACKEND = path.join(ROOT, "backend");
const LANE = path.join(BACKEND, "scripts/retire-self-derived-identities.cjs");

const lib = require_(path.join(BACKEND, "scripts/lib/sport-contamination.cjs"));
const {
  classifySportContamination,
  contaminationReason,
  mayEnqueueAcquisition,
  MIN_CHECKLIST_ROWS,
} = lib;

/** The lane's own source, read rather than executed: it connects to Cosmos at
 *  main() and cannot be imported. The classification rule it runs lives in the
 *  lib above and IS exercised directly; what the source is read for is the
 *  wiring — that the lane calls the probe, and that its enqueue passes through
 *  the gate. */
const laneSrc = fs.readFileSync(LANE, "utf8").replace(/\r\n/g, "\n");

// ── THE FIXTURES ────────────────────────────────────────────────────────────
//
// 1952 Bowman is the real shape from the census: a baseball-only product
// (Bowman setKey taxonomy ruling) carrying auto-seed rows that claim football.
const BOWMAN_1952_CHECKLIST_SPORTS = { baseball: 412 };
// `score` is the census's own example of a genuinely cross-sport product —
// the class that must NOT be repaired, because guessing which of three sports
// a row belongs to is the guessed address #1929 removed from the ingest.
const SCORE_1991_CHECKLIST_SPORTS = { baseball: 893, football: 704, hockey: 441 };

describe("sport contamination — the cross-sport probe", () => {
  // ── 1. TWIN FOUND ─────────────────────────────────────────────────────────
  it("BRANCH 1 — a football row on a baseball-only product resolves to baseball, and a twin there RETIRES it", () => {
    const v = classifySportContamination({
      sport: "football",
      checklistSportCounts: BOWMAN_1952_CHECKLIST_SPORTS,
    });
    expect(v.contaminated).toBe(true);
    expect(v.verdict).toBe("contaminated");
    expect(v.trueSport).toBe("baseball");

    // The twin question is asked again against the checklists that actually
    // describe the product. When it answers yes, the checklist row IS the card.
    expect(contaminationReason(v.verdict, { trueSport: v.trueSport, twinFound: true }))
      .toBe("sport-contaminated:twin-in-baseball");
    // And a retired row never enqueues.
    expect(mayEnqueueAcquisition(v.verdict)).toBe(false);
  });

  // ── 2. NO TWIN ────────────────────────────────────────────────────────────
  it("BRANCH 2 — no twin under the true sport parks the row and enqueues NOTHING", () => {
    const v = classifySportContamination({
      sport: "football",
      checklistSportCounts: BOWMAN_1952_CHECKLIST_SPORTS,
    });
    expect(contaminationReason(v.verdict, { trueSport: v.trueSport, twinFound: false }))
      .toBe("sport-contaminated:no-twin");

    // THE POINT OF THE WHOLE CHANGE. Neither cell may be asked for:
    //   `football|1952|bowman` — no publisher serves it; the product is baseball.
    //   `baseball|1952|bowman` — by construction it HAS a checklist (that is the
    //     fact that identified the contamination), so there is nothing to buy.
    expect(mayEnqueueAcquisition(v.verdict)).toBe(false);
  });

  // ── 3. AMBIGUOUS ──────────────────────────────────────────────────────────
  it("BRANCH 3 — a genuinely cross-sport product is AMBIGUOUS, never repaired to a guess", () => {
    const v = classifySportContamination({
      sport: "soccer",
      checklistSportCounts: SCORE_1991_CHECKLIST_SPORTS,
    });
    expect(v.contaminated).toBe(true);
    expect(v.verdict).toBe("ambiguous");
    expect(v.trueSport).toBeNull();
    expect(v.candidates).toEqual(["baseball", "football", "hockey"]);
    expect(contaminationReason(v.verdict, v)).toBe("sport-ambiguous");
    expect(mayEnqueueAcquisition(v.verdict)).toBe(false);
  });

  // ── 4. THE TWO NON-FIRING CASES, which are what keep the queue working ────
  it("does NOT fire when the asking sport holds the checklist — the lane's own comparison is sound", () => {
    const v = classifySportContamination({
      sport: "baseball",
      checklistSportCounts: BOWMAN_1952_CHECKLIST_SPORTS,
    });
    expect(v.verdict).toBe("agree");
    expect(v.contaminated).toBe(false);
    expect(mayEnqueueAcquisition(v.verdict)).toBe(true);
  });

  it("does NOT fire on a product NO sport attests — absence of coverage is not absence of the product", () => {
    // setSportAuthority's founding lesson: its first version read "we have no
    // 2024 Donruss BASEBALL checklist" as "2024 Donruss is not a baseball
    // product" and moved 1.24M comps backwards. An unattested product-year is
    // the honest acquisition case, and it MUST still reach the queue.
    const v = classifySportContamination({ sport: "baseball", checklistSportCounts: {} });
    expect(v.verdict).toBe("no-attestation");
    expect(v.contaminated).toBe(false);
    expect(mayEnqueueAcquisition(v.verdict)).toBe(true);
  });

  it("one stray foreign checklist row is a misfiling, not an attestation", () => {
    // Absolute floor, never a ratio: dominance over a single-sport sample is
    // always 1.0 (setSportAuthority).
    const v = classifySportContamination({
      sport: "baseball",
      checklistSportCounts: { football: MIN_CHECKLIST_ROWS - 1 },
    });
    expect(v.verdict).toBe("no-attestation");
    expect(mayEnqueueAcquisition(v.verdict)).toBe(true);
  });

  it("a blank sport on either side is UNKNOWN, and unknown never matches (#1923)", () => {
    expect(classifySportContamination({ sport: "", checklistSportCounts: { baseball: 99 } }).contaminated).toBe(false);
    expect(classifySportContamination({ sport: "baseball", checklistSportCounts: { "": 99 } }).verdict).toBe("no-attestation");
  });

  // ── 5. THE MUTATION ───────────────────────────────────────────────────────
  it("MUTATION — drop the detection and the wrong-sport cell is back on the acquisition queue", () => {
    // The queue as the lane builds it: one entry per (year, setKey) that a
    // self-derived row could not be placed in. `sport` is the lane's SPORT.
    const buildQueue = (detect: boolean) => {
      const gaps = new Set<string>();
      const rows = [
        // The 1,145-row class: football rows on a baseball-only product.
        { sport: "football", year: 1952, setKey: "bowman", checklists: BOWMAN_1952_CHECKLIST_SPORTS },
        // A REAL gap on the same run, which must survive the fix untouched.
        { sport: "football", year: 1995, setKey: "collectors-edge", checklists: {} },
      ];
      for (const r of rows) {
        const v = detect
          ? classifySportContamination({ sport: r.sport, checklistSportCounts: r.checklists })
          // THE MUTATION: no probe. Every unplaceable row is read as a gap,
          // which is precisely what the lane did before this change.
          : { verdict: "no-attestation" as const };
        if (mayEnqueueAcquisition(v.verdict)) gaps.add(`${r.sport}|${r.year}|${r.setKey}`);
      }
      return gaps;
    };

    const withDetection = buildQueue(true);
    const withoutDetection = buildQueue(false);

    // WITH the detection: only the real gap is asked for.
    expect([...withDetection]).toEqual(["football|1995|collectors-edge"]);
    expect(withDetection.has("football|1952|bowman")).toBe(false);

    // WITHOUT it: the queue asks a publisher for a 1952 Bowman FOOTBALL
    // checklist. That product is baseball; no source can ever serve the cell.
    // THIS IS THE RED.
    expect(withoutDetection.has("football|1952|bowman")).toBe(true);
    expect(withoutDetection.size).toBeGreaterThan(withDetection.size);

    // And the real gap is unharmed either way — the fix narrows the queue, it
    // does not empty it.
    expect(withoutDetection.has("football|1995|collectors-edge")).toBe(true);
  });

  // ── 6. THE WIRING ─────────────────────────────────────────────────────────
  it("the lane calls the probe, and its enqueue passes through the gate", () => {
    expect(laneSrc).toContain('require(path.join(__dirname, "lib", "sport-contamination.cjs"))');
    expect(laneSrc).toContain("classifySportContamination({ sport: SPORT, checklistSportCounts: counts })");
    // The enqueue is gated. If this line goes, section 5's mutation is live in
    // production rather than in a test.
    expect(laneSrc).toContain("mayEnqueueAcquisition(contamination.verdict)");
    // The probe is asked BEFORE the twin comparison it corrects.
    const probeAt = laneSrc.indexOf("classifySportContamination({ sport: SPORT");
    const rowLoopAt = laneSrc.indexOf("for (const r of sd) {");
    expect(probeAt).toBeGreaterThan(-1);
    expect(probeAt).toBeLessThan(rowLoopAt);
  });

  it("a cross-sport retire is verified against the marker it actually wrote", () => {
    // The verify used to compare every retire against the plain RETIRED
    // marker. A `sport-contaminated:twin-in-baseball` row would have read as
    // MISSING THE MARKER and turned a healthy APPLY run red.
    expect(laneSrc).toContain("const want = e.expect || RETIRED;");
    expect(laneSrc).toContain("String(got1 || \"\") === want");
  });

  it("a contaminated product does not let the already-marked shortcut swallow its rows", () => {
    // Every one of the 32,044 rows was parked `identityUnverified` by a
    // PRE-PROBE run. If the shortcut still fired on them the fix would never
    // reach the population it exists for.
    expect(laneSrc).toContain("alreadyProbed");
    expect(laneSrc).toContain("const settled = contaminatedProduct");
  });
});
