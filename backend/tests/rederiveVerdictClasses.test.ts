// CF-CLASSIFY-READS-THE-REPORT-NOT-THE-LINE-SHAPE (#1868) — the pins.
//
// THE RUN THAT WROTE THIS FILE. Run 34021743427 was the first end-to-end night
// of `acquire-for-withheld-holdings`, after #1867 unblocked the plan step. All
// ten cells went green. Cell `baseball|2025|bowman-draft` re-derived holding
// a2963cd5 onto a checklist-backed slug and repriced user-67878bb5. And all ten
// cells printed the identical line:
//
//   CLASSIFY agree=0 rederive=0 no-match-blank=0 no-match-fields=0
//            self-derived=0 collision=0 over-claim=0 human=0 low-conf=0
//            unverified-total=0
//
// ALL ZEROS — including the cell whose report carried `"verdict": "REDERIVE"`
// and whose Gate 3 proceeded ON that verdict and applied it. The night's only
// real re-point was invisible in the very line written to describe it.
//
// WHY. The classifier grepped the captured report with patterns anchored to the
// SCRIPT's stdout — `^[[:space:]]*REDERIVE `. The lane does print exactly that.
// But the file the workflow reads is not the script's stdout: `dispatch`
// captures the dispatched run with `gh run view --log`, which prefixes EVERY
// line with `<job> TAB <step> TAB <timestamp>`. So the anchor could not match
// and `grep -c` honestly returned 0.
//
// Gate 3 read the SAME file and survived, because its second alternative
// (`"REDERIVE":[[:space:]]*[1-9]`) is unanchored and matched the lane's
// machine-readable SUMMARY straight through the prefix. One consumer was
// portable across capture formats and the other was not, and nothing said so —
// which is precisely what a pin is for. Verified against the real captured log
// of run 34022954856: the anchored pattern finds 0, the report contains 1.
//
// These pins are mutation-sensitive by construction:
//   - parse the wrong stream (a cell job log)     -> `unread`, never zeros
//   - strip the de-prefixer                       -> the fixture stops parsing
//   - collapse the UNVERIFIED subclasses          -> the collision count moves
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);
const BACKEND = path.join(__dirname, "..");
const lib = require_(path.join(BACKEND, "scripts/lib/rederive-verdict-classes.cjs"));
const { classify, summaryLine, stripCapturePrefix, extractReport, unverifiedSubclass } = lib;

/** One `gh run view --log` line: job TAB step TAB timestamp + content. This is
 *  the shape that defeated the shipped classifier, so the fixture is built in
 *  it rather than in the raw shape the lane prints. */
const cap = (content: string) =>
  `run-backfill\tRun backfill (DRY-RUN)\t2026-09-06T08:51:11.3907930Z ${content}`;

/**
 * A report with ONE REDERIVE and ONE COLLISION, in the exact document shape
 * `recheck-holding-identity.ts` emits (pretty-printed, one line per key) and
 * wrapped in the exact capture prefix `dispatch` produces.
 *
 * The REDERIVE entry is the real one from run 34022954856; the UNVERIFIED entry
 * carries the real collision reason string the lane pushes — "the destination
 * does not corroborate it: holding player X vs catalog row Y" — NOT the console
 * wording ("player mismatch"), because reading the report means reading the
 * report's own field.
 */
const REPORT = {
  event: "holding_rederive_report",
  mode: "rederive",
  apply: false,
  verdicts: [
    {
      hid: "a2963cd5-5be6-4783-bd2c-44d19fc2fa91",
      userId: "user-67878bb5-496d-4bf5-87e4-e8869609d19f",
      docId: "user-67878bb5-496d-4bf5-87e4-e8869609d19f",
      from: "hiq:baseball:2025:bowman-draft:cpa-ce:chrome-refractor:auto",
      to: "hiq:baseball:2025:bowman-draft:cpa-ce:refractor:auto:num-499",
      backedBy: "checklistcenter-2026-08-29",
      verdict: "REDERIVE",
      reason: "checklist-backed by checklistcenter-2026-08-29",
      matchedBy: "exact",
      confidence: 0.98,
      userAuthored: false,
    },
    {
      hid: "bb11ccdd-0000-4444-8888-111122223333",
      userId: "user-67878bb5-496d-4bf5-87e4-e8869609d19f",
      docId: "user-67878bb5-496d-4bf5-87e4-e8869609d19f",
      from: "hiq:baseball:1997:topps-finest:120:refractor:no-auto",
      to: "hiq:baseball:1997:topps-finest:120:base:no-auto",
      backedBy: "beckett-1997",
      verdict: "UNVERIFIED",
      reason:
        "set name was recovered from listing text and the destination does not corroborate it:"
        + ' holding player "Diego Tornes" vs catalog row "Devin Taylor"',
      matchedBy: "fuzzy",
      confidence: 0.81,
      userAuthored: false,
    },
  ],
};

/** The fixture as the workflow really receives it: human lines, the SUMMARY,
 *  then the document — every line behind the gh capture prefix. */
function fixtureLog(): string {
  const lines: string[] = [
    cap("  === rederive-holding-identity  MODE: rederive  apply=false ==="),
    cap("  REDERIVE   Conor Essenburg        2025 #CPA-CE  "),
    cap("  UNVERIFIED Diego Tornes           1997 #120"),
    cap("             NOT WRITTEN: recovered setName, player mismatch"),
    cap(""),
    cap(`SUMMARY  ${JSON.stringify({ REDERIVE: 1, UNVERIFIED: 1 })}`),
  ];
  for (const l of JSON.stringify(REPORT, null, 1).split("\n")) lines.push(cap(l));
  lines.push(cap(""), cap("Report only — nothing written."));
  return lines.join("\n");
}

describe("the CLASSIFY counts come from the report, through the capture prefix", () => {
  it("counts one REDERIVE and one COLLISION — the shipped grep counted zero of each", () => {
    const r = classify(fixtureLog());
    expect(r.ok, r.why).toBe(true);
    expect(r.counts.rederive, "the re-point that run 34021743427 reported as 0").toBe(1);
    expect(r.counts.collision, "the UNVERIFIED player-mismatch subclass").toBe(1);
    expect(r.counts.unverifiedTotal).toBe(1);
    expect(r.total).toBe(2);
    // The other buckets stay empty — a classifier that counts everything twice
    // would satisfy the two assertions above.
    expect(r.counts.agree).toBe(0);
    expect(r.counts.selfDerived).toBe(0);
    expect(r.counts.overClaim).toBe(0);
    expect(r.counts.human).toBe(0);
    expect(r.counts.lowConf).toBe(0);
    expect(r.counts.noMatchBlank).toBe(0);
    expect(r.counts.noMatchFields).toBe(0);
  });

  it("renders the line the workflow publishes", () => {
    const r = classify(fixtureLog());
    expect(summaryLine(r.counts)).toBe(
      "agree=0 rederive=1 no-match-blank=0 no-match-fields=0 self-derived=0"
      + " collision=1 over-claim=0 human=0 low-conf=0 unverified-total=1",
    );
    // The exact string the broken run emitted, as a guard against regressing to
    // it while still "passing" some looser assertion.
    expect(summaryLine(r.counts)).not.toBe(
      "agree=0 rederive=0 no-match-blank=0 no-match-fields=0 self-derived=0"
      + " collision=0 over-claim=0 human=0 low-conf=0 unverified-total=0",
    );
  });

  it("reads a RAW capture too — the classifier does not depend on which shape it got", () => {
    // `| tee` and a local run produce unprefixed lines. Both must work, because
    // the whole defect was a parser that only worked on one of them.
    const raw = fixtureLog().split("\n").map(stripCapturePrefix).join("\n");
    const r = classify(raw);
    expect(r.ok).toBe(true);
    expect(r.counts.rederive).toBe(1);
    expect(r.counts.collision).toBe(1);
  });

  // MUTATION 1 — THE DEFECT ITSELF. Parse the wrong stream and the answer must
  // be `unread`, never a row of zeros: publishing zeros for an unparsed report
  // is exactly how the night's real re-point went unseen.
  it("MUTATION: the wrong stream yields UNREAD, not zeros", () => {
    const wrong = [
      cap("GATE 3 proceed=yes"),
      cap("watching run 34022954856 for rederive-holding-identity"),
      cap("Run backfill (DRY-RUN)"),
    ].join("\n");
    const r = classify(wrong);
    expect(r.ok, "a log with no report must not be reported as a successful count").toBe(false);
    expect(r.counts.rederive).toBe(0);
    expect(r.why).toMatch(/no holding_rederive_report/);
  });

  // MUTATION 2 — the anchored grep the workflow used to run. Proves the fixture
  // really does reproduce the run-34021743427 condition rather than merely
  // asserting against a shape that never failed.
  it("MUTATION: the old line-anchored pattern finds nothing in this very fixture", () => {
    const log = fixtureLog();
    const anchored = log.split("\n").filter((l) => /^\s*REDERIVE /.test(l));
    expect(
      anchored.length,
      "if the old anchor matched, this fixture would not reproduce the all-zeros run",
    ).toBe(0);
    // And the fix reads the same bytes correctly.
    expect(classify(log).counts.rederive).toBe(1);
  });

  // MUTATION 3 — drop the de-prefixer and the document stops being findable.
  it("MUTATION: without prefix stripping the report cannot be extracted", () => {
    const log = fixtureLog();
    expect(extractReport(log), "the real path must find it").not.toBeNull();
    // Simulate a classifier that forgot to strip: the JSON lines still carry
    // `job TAB step TAB timestamp`, so JSON.parse over them fails.
    const notStripped = log.split("\n").filter((l) => l.includes('"verdicts"'));
    expect(notStripped.length).toBeGreaterThan(0);
    expect(() => JSON.parse(notStripped.join("\n"))).toThrow();
  });

  // The SUMMARY fallback: a truncated capture keeps the two classes the gates
  // care about rather than degrading to zeros.
  it("a capture with only the SUMMARY still reports the rederive count", () => {
    const only = [cap("some earlier line"), cap(`SUMMARY  ${JSON.stringify({ REDERIVE: 2, AGREE: 3 })}`)].join("\n");
    const r = classify(only);
    expect(r.ok).toBe(true);
    expect(r.partial).toBe(true);
    expect(r.counts.rederive).toBe(2);
    expect(r.counts.agree).toBe(3);
  });
});

describe("the UNVERIFIED subclasses map to the reasons the lane really pushes", () => {
  // Each of these is a verbatim reason string from recheck-holding-identity.ts.
  // They route to different unblocking actions, so collapsing any two would
  // lose the meaning the table exists to convey.
  const cases: Array<[string, string]> = [
    ["no catalog row backs the derived slug — never mint", "selfDerived"],
    [
      'set name was recovered from listing text and the destination does not corroborate it:'
      + ' holding player "A" vs catalog row "B"',
      "collision",
    ],
    ["no ladder source — the holding claims printRun=499 and the destination does not carry it", "overClaim"],
    ["a human ruled this identity (ruling:Drew:2026-09-05) — report only; field recovery proposes X", "human"],
    ["confidence 0.71 below 0.8", "lowConf"],
  ];
  for (const [reason, expected] of cases) {
    it(`"${reason.slice(0, 44)}…" -> ${expected}`, () => {
      expect(unverifiedSubclass(reason)).toBe(expected);
    });
  }

  it("the corroborate and carry reasons do not collide — both contain 'destination does not'", () => {
    // The ordering hazard, pinned: a naive `destination does not` test would
    // bucket the player collision as an over-claim and the table would send the
    // operator to the wrong queue.
    expect(unverifiedSubclass('the destination does not corroborate it: holding player "A" vs catalog row "B"'))
      .toBe("collision");
    expect(unverifiedSubclass("no ladder source — ... and the destination does not carry it"))
      .toBe("overClaim");
  });
});
