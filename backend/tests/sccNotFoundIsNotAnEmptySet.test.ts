/**
 * A 404 SERVED WITH HTTP 200 IS NOT AN EMPTY SET.
 *
 * The recheck of 1956 Topps baseball (set-11611, runs 34025742030 report /
 * 34025851336 apply) ended
 *
 *   "empty at source 1 (the source served no cards; a verdict, not a lane fault)"
 *   rows created 0
 *
 * The hypotheses on the table were (a) a stale staged CSV from the hollow
 * SCC-VINTAGE walk, or (b) a vintage page shape the converter cannot read.
 *
 * IT WAS NEITHER. Fetched 2026-09-06, set-11611 returns HTTP 200 with 56,371
 * bytes whose <title> is "Checklist Not Found" and whose body echoes
 *
 *   NOT FOUND - https://www.sportscardchecklist.com/set-11611/1956-topps-...
 *
 * The site does not card that set id at all. And the server IGNORES THE SLUG,
 * keying only on `set-<id>` -- probed the same day, set-11608 serves 1955 Topps
 * and set-11614 serves 1957 Topps, with set-11611 between them serving the
 * not-found page. The sitemap advertised an id the site itself does not have.
 *
 * THE VINTAGE SHAPE IS FINE, which disposes of (b) with a measurement rather
 * than an argument. 1952, 1953, 1954 and 1957 Topps baseball all serve the SAME
 * H5-header + hidden-input layout the 1990s pages use:
 *
 *   set-11578  1952 Topps   489 headers
 *   set-11598  1953 Topps   274 headers
 *   set-11601  1954 Topps   250 headers
 *   set-11614  1957 Topps   417 headers, 417 hidden rows, 417 rows parsed,
 *                           Ted Williams at #1, 21 Double Print subsets, 0 skipped
 *
 * There is no second layout to teach the converter, and no gray-back/white-back
 * variation axis on these pages to mint rows from -- inventing one would be a
 * synthetic parallel, which this lane never does.
 *
 * WHY THE GUARD MISSED IT. `zeroCardReason` had two escape hatches before its
 * "nothing new to add" branch, and the not-found page defeats both: 56,371 bytes
 * clears the 40,000-byte floor, and the ECHOED URL makes the
 * `/set-\d+|trading-card-checklist/` test match. So a page saying "this set does
 * not exist" was reported as "the source lists this set and carries no cards for
 * it" -- which the driver reads as `emptyAtSource`, and `empty` is TERMINAL. The
 * entry was closed against a claim the source never made.
 *
 * MEASURED, crawl_state, lane sportscardchecklist, 2026-09-06:
 *
 *   empty       16      <- ALL 16 carry a 56-62 KB body in their reason string.
 *   partial  7,134
 *   failed     587
 *
 * Not one of the 16 is a real empty set; every one is this page. They span
 * basketball 1990s (6), baseball 1990s (6), baseball 1970s (2), 1980s (1) and
 * 1950s (1).
 *
 * The verdict is now `unreachable` -- terminal, so the walker stops re-fetching
 * a dead id, and recheckable, so a source that later cards the set is picked up.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FETCHER = path.join(HERE, "..", "scripts", "fetchSportsCardChecklist.cjs");
const DRIVER = path.join(HERE, "..", "scripts", "ingest-universe-driver.cjs");
const FIX = path.join(HERE, "fixtures", "sportscardchecklist");

const {
  zeroCardReason,
  buildRows,
  extractCardHeaders,
  countHiddenRows,
  NOT_FOUND_RE,
  CONVERTER_VERSION,
} = require_(FETCHER);

const {
  LANE_CONVERTER_VERSION,
  stagedIsCurrent,
  stagedConverterVersion,
  acquireFromStaging,
} = require_(DRIVER);

const html = (n: string) => fs.readFileSync(path.join(FIX, `${n}.trimmed.html`), "utf8");
const NOT_FOUND = "1956-topps-baseball-not-found";
const VINTAGE = "1957-topps-baseball";

/** What the fetcher would say about a page that parsed to zero cards. */
const reasonFor = (name: string) => {
  const page = html(name);
  const { stats } = buildRows(page, { parallel: "", isAuto: false });
  return zeroCardReason(page, stats);
};

// ── the not-found page is named for what it is ───────────────────────────────

describe("the host's Checklist Not Found page is not an empty set", () => {
  it("the fixture really does defeat BOTH existing escape hatches", () => {
    // If either of these stopped being true the fixture would pass the guard
    // for the wrong reason and the pin would be testing nothing.
    const page = html(NOT_FOUND);
    expect(page.length).toBeGreaterThanOrEqual(40000);
    expect(/set-\d+|trading-card-checklist/i.test(page)).toBe(true);
    // ...and it carries no card scaffolding at all.
    expect(extractCardHeaders(page)).toHaveLength(0);
    expect(countHiddenRows(page)).toBe(0);
  });

  it("it is NOT reported as a set that carries no cards", () => {
    // The exact sentence that made the driver record `empty`.
    expect(reasonFor(NOT_FOUND)).not.toContain("nothing new to add");
  });

  it("it is reported as an id the source does not card", () => {
    const r = reasonFor(NOT_FOUND);
    expect(r).toContain("Checklist Not Found");
    expect(r).toContain("not carded at the source");
  });

  it("the marker matches the phrase, in the title or the body echo", () => {
    expect(NOT_FOUND_RE.test("<title>...: Checklist Not Found</title>")).toBe(true);
    expect(NOT_FOUND_RE.test("NOT FOUND - https://www.sportscardchecklist.com/set-11611/x")).toBe(true);
    // A real checklist page must not trip it.
    expect(NOT_FOUND_RE.test(html(VINTAGE))).toBe(false);
  });

  it("a genuinely empty set page still says `nothing new to add`", () => {
    // THE CASE THE RULE MUST KEEP CATCHING. Scaffolding-free, over the floor,
    // names a set page, and does NOT carry the not-found marker: that is a real
    // "the source lists this set and cards none of it", and it must survive.
    const page = `<html><body><h1>1962 Topps Baseball</h1>${
      "<!-- a set page that lists no cards; trading-card-checklist set-99999 -->".repeat(900)
    }</body></html>`;
    expect(page.length).toBeGreaterThan(40000);
    const { stats } = buildRows(page, { parallel: "", isAuto: false });
    expect(zeroCardReason(page, stats)).toContain("nothing new to add");
  });

  it("a truncated body is still a host fault, not an empty set", () => {
    const short = "<html><body>set-11611 trading-card-checklist</body></html>";
    const { stats } = buildRows(short, { parallel: "", isAuto: false });
    expect(zeroCardReason(short, stats)).toContain("did not serve a set page");
  });

  it("a challenge page is still a challenge page", () => {
    const page = `<html><body>Just a moment...${"x".repeat(50000)}</body></html>`;
    const { stats } = buildRows(page, { parallel: "", isAuto: false });
    // Renamed in 2026-09-06's soft-block work: the sentence now says
    // "challenge/rate-limit page" and carries the marker that matched.
    expect(zeroCardReason(page, stats)).toContain("challenge/rate-limit page");
  });
});

// ── the driver routes it to `unreachable`, not `empty` ───────────────────────

describe("the driver records an un-carded id as unreachable", () => {
  const src = fs.readFileSync(DRIVER, "utf8");

  it("the not-found branch exists and is tested BEFORE `nothing new to add`", () => {
    // Anchored INSIDE the sportscardchecklist catch block: `nothing new to add`
    // appears in several lanes' handlers, so a bare indexOf finds another lane's
    // and compares two unrelated positions.
    const notFound = src.indexOf("if (/Checklist Not Found|not carded at the source/.test(said))");
    expect(notFound).toBeGreaterThan(-1);
    const empty = src.indexOf("if (/nothing new to add/.test(said))", notFound);
    expect(empty).toBeGreaterThan(-1);
    expect(notFound).toBeLessThan(empty);
    // ...and they are the SAME catch block: no other lane handler between them.
    expect(src.slice(notFound, empty)).not.toContain("run(\"");
  });

  it("its message is shaped for the shared isGone test", () => {
    // `unreachable` is reached by the isGone alternation, which matches
    // "HTTP 40[34]". The thrown sentence must carry that shape or the entry
    // lands in `failed` and reads as OUR pipe breaking.
    const line = src.slice(src.indexOf("does not card this set id"), src.indexOf("does not card this set id") + 200);
    expect(line).toContain("HTTP 404-equivalent");
    expect(/HTTP 40[34]|ENOTFOUND|exit(ed)?\s+(?:with\s+)?(?:code\s+)?9|workbook empty or unreachable/i
      .test('sportscardchecklist does not card this set id (HTTP 404-equivalent: its "Checklist Not Found" page served with 200)')).toBe(true);
  });

  it("it never sets emptyAtSource -- that is the flag that made it terminal-empty", () => {
    const branch = src.slice(
      src.indexOf("if (/Checklist Not Found|not carded at the source/.test(said))"),
      src.indexOf("if (/nothing new to add/.test(said))", src.indexOf("fetchSportsCardChecklist.cjs")),
    );
    expect(branch).not.toContain("emptyAtSource");
  });
});

// ── the vintage page shape needs no new reader ───────────────────────────────

describe("the 1950s page shape is the shape the converter already reads", () => {
  const page = html(VINTAGE);
  const { rows, stats } = buildRows(page, { parallel: "", isAuto: false });

  it("H5 headers and hidden inputs agree, exactly as on a 1997 page", () => {
    expect(stats.headers).toBe(30);
    expect(stats.hiddenRows).toBe(30);
    expect(stats.anchorMismatch).toBe(false);
    expect(stats.skipped).toBe(0);
  });

  it("card 1 is Ted Williams", () => {
    expect(rows[0].cardNumber).toBe("1");
    expect(rows[0].player).toBe("Ted Williams");
  });

  it("numbering is plain integers -- no vintage-specific card number form", () => {
    expect(rows.every((r: any) => /^\d+$/.test(r.cardNumber))).toBe(true);
  });

  it("UER is stripped from the player name and filed nowhere", () => {
    // "6 Hector Lopez UER" -- an uncorrected error is the same card, so folding
    // it into a subset would split the base pool.
    const six = rows.find((r: any) => r.cardNumber === "6");
    expect(six.player).toBe("Hector Lopez");
    expect(six.subset).toBe("");
    expect(six.category).toBe("base");
  });

  it("no parallel is invented -- a 1950s base set has no ladder", () => {
    // The era rule already exempts pre-1990 from the ladder expectation; what
    // matters here is that the converter mints NO synthetic rung to satisfy it.
    expect(rows.every((r: any) => r.parallel === "")).toBe(true);
    expect(rows.every((r: any) => r.printRun === "")).toBe(true);
    expect(rows.every((r: any) => r.isAuto === "false")).toBe(true);
  });

  it("every row is a real card from the page -- no synthetic rows", () => {
    expect(rows).toHaveLength(30);
    expect(new Set(rows.map((r: any) => r.cardNumber)).size).toBe(30);
    expect(rows.every((r: any) => r.player.length > 0)).toBe(true);
  });
});

// ── a stale staged file must not outlive its converter ───────────────────────

describe("a staged CSV stops winning once its converter is superseded", () => {
  it("the lane declares a converter version, and the fetcher stamps it", () => {
    expect(LANE_CONVERTER_VERSION.sportscardchecklist).toBe(CONVERTER_VERSION);
    expect(CONVERTER_VERSION).toBeGreaterThan(1);
  });

  it("a staged file at the current version still wins", () => {
    const dir = fs.mkdtempSync(path.join(HERE, ".staged-cur-"));
    try {
      const manifest = path.join(dir, "x.manifest.json");
      fs.writeFileSync(manifest, JSON.stringify({ converterVersion: CONVERTER_VERSION }));
      const r = stagedIsCurrent("sportscardchecklist", [{ csv: path.join(dir, "x.csv"), manifest }]);
      expect(r.ok).toBe(true);
      expect(r.stale).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("a staged file from an OLDER converter does not win", () => {
    const dir = fs.mkdtempSync(path.join(HERE, ".staged-old-"));
    try {
      const manifest = path.join(dir, "x.manifest.json");
      fs.writeFileSync(manifest, JSON.stringify({ converterVersion: 1 }));
      const r = stagedIsCurrent("sportscardchecklist", [{ csv: path.join(dir, "x.csv"), manifest }]);
      expect(r.ok).toBe(false);
      expect(r.stale[0].version).toBe(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("an UNSTAMPED staged file counts as older than any current version", () => {
    // Every file the hollow SCC-VINTAGE walk left behind is unstamped, which is
    // the population this rule has to re-open.
    const dir = fs.mkdtempSync(path.join(HERE, ".staged-uns-"));
    try {
      const manifest = path.join(dir, "x.manifest.json");
      fs.writeFileSync(manifest, JSON.stringify({ source: "sportscardchecklist" }));
      expect(stagedConverterVersion(manifest)).toBe(0);
      expect(stagedIsCurrent("sportscardchecklist", [{ csv: path.join(dir, "x.csv"), manifest }]).ok)
        .toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("an unreadable manifest is treated as unstamped, never as current", () => {
    expect(stagedConverterVersion(path.join(HERE, "no-such-manifest.json"))).toBe(0);
  });

  it("a lane that declares NO version keeps the plain staged-wins rule", () => {
    // Right guard, right scope: this must not change bcp, beckett, clc, tcgdexja.
    for (const lane of ["bcp", "beckett", "clc", "tcgdexja", "hobbymonitor", "checklistinsider"]) {
      expect(LANE_CONVERTER_VERSION[lane]).toBeUndefined();
      expect(stagedIsCurrent(lane, [{ csv: "a.csv", manifest: "nope.json" }]).ok).toBe(true);
    }
  });

  it("acquireFromStaging returns null for a stale file, so the fetch happens", () => {
    // Returning null is exactly what "no staged file" does, so the caller falls
    // through to the live fetch with no other behaviour change.
    const src = fs.readFileSync(DRIVER, "utf8");
    expect(typeof acquireFromStaging).toBe("function");
    expect(src).toContain("const fresh = stagedIsCurrent(String(entry?.lane || entry?.source || \"\"), staged);");
    expect(src).toContain("if (!fresh.ok) {");
    expect(src).toContain("STAGED IGNORED");
  });
});

// ── mutation reds ────────────────────────────────────────────────────────────

function withMutant(file: string, from: string, to: string, tag: string, fn: (m: any) => void) {
  const original = fs.readFileSync(file, "utf8");
  expect(original, `the mutation target must exist verbatim: ${from}`).toContain(from);
  const mutated = original.replace(from, to);
  expect(mutated).not.toBe(original);
  const tmp = path.join(path.dirname(file), `.mutated-${tag}-${process.pid}.cjs`);
  try {
    fs.writeFileSync(tmp, mutated);
    fn(require_(tmp));
  } finally { fs.rmSync(tmp, { force: true }); }
}

describe("the pins fail against the code that shipped the wrong verdict", () => {
  it("drop the not-found test -> the 1956 page is an `empty set` again", () => {
    withMutant(
      FETCHER,
      "    if (NOT_FOUND_RE.test(h)) {",
      "    if (false) {",
      "notfound",
      (m) => {
        const page = html(NOT_FOUND);
        const { stats } = m.buildRows(page, { parallel: "", isAuto: false });
        // The original defect, reproduced verbatim.
        expect(m.zeroCardReason(page, stats)).toContain("nothing new to add");
        // ...and the shipped fetcher disagrees on exactly this.
        expect(reasonFor(NOT_FOUND)).not.toContain("nothing new to add");
      },
    );
  });

  it("empty LANE_CONVERTER_VERSION -> a hollow staged file wins forever", () => {
    withMutant(
      DRIVER,
      `const LANE_CONVERTER_VERSION = { sportscardchecklist: ${LANE_CONVERTER_VERSION.sportscardchecklist} };`,
      "const LANE_CONVERTER_VERSION = {};",
      "converterver",
      (m) => {
        const dir = fs.mkdtempSync(path.join(HERE, ".staged-mut-"));
        try {
          const manifest = path.join(dir, "x.manifest.json");
          fs.writeFileSync(manifest, JSON.stringify({ converterVersion: 1 }));
          const staged = [{ csv: path.join(dir, "x.csv"), manifest }];
          expect(m.stagedIsCurrent("sportscardchecklist", staged).ok).toBe(true);   // stale wins
          expect(stagedIsCurrent("sportscardchecklist", staged).ok).toBe(false);    // shipped refuses
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      },
    );
  });

  it("treat an unstamped manifest as current -> the hollow walk's files win", () => {
    withMutant(
      DRIVER,
      "    return Number.isFinite(v) && v > 0 ? v : 0;",
      "    return Number.isFinite(v) && v > 0 ? v : Infinity;",
      "unstamped",
      (m) => {
        const dir = fs.mkdtempSync(path.join(HERE, ".staged-inf-"));
        try {
          const manifest = path.join(dir, "x.manifest.json");
          fs.writeFileSync(manifest, JSON.stringify({ source: "sportscardchecklist" }));
          const staged = [{ csv: path.join(dir, "x.csv"), manifest }];
          expect(m.stagedIsCurrent("sportscardchecklist", staged).ok).toBe(true);
          expect(stagedIsCurrent("sportscardchecklist", staged).ok).toBe(false);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      },
    );
  });
});
