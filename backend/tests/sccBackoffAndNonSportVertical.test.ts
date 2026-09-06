/**
 * TWO WAYS A LANE GOES QUIET WITHOUT BEING BROKEN.
 *
 * ── 1. A SOFT BLOCK IS NOT A DEAD ID (run 34044007926) ──────────────────────
 *
 * The basketball 1990-2009 walk, ALONE on the lane, took three consecutive
 *
 *   UNREACHABLE — sportscardchecklist did not serve the set page
 *   (a 200 carrying no checklist) — exit 9: no checklist on the page
 *
 * and aborted. Every one of those pages is alive: 2000-01 Topps Chrome
 * (set-151053), re-fetched by hand minutes later, served HTTP 200, 817,204
 * bytes and 200 <h5> headers. The lane had fetched thousands of pages today.
 *
 * A rate limit, read as three dead ids -- and `unreachable` is TERMINAL, so
 * each entry was closed against a page that was never broken. Measured
 * read-only in crawl_state: 24 entries carry the "a 200 carrying no checklist"
 * reason (18 basketball, 6 baseball; 12 recorded today), against 6 genuine
 * dead ids.
 *
 * THREE THINGS WERE MISSING, and all three are fixed here.
 *
 * (a) THE POLITENESS DELAY WAS NEVER SPENT. This file's header has promised
 *     ">=2s between requests" since the lane shipped, and DELAY_MS existed to
 *     honour it -- but it was read ONLY inside the 429/503 backoff. The fetcher
 *     is one page per process and the driver invokes it once per entry, so
 *     consecutive entries hit the host back to back with no delay at all. The
 *     delay is now spent before the request, jittered so a fleet cannot
 *     synchronise into the very burst it is avoiding.
 *
 * (b) THE RESPONSE WAS NEVER DESCRIBED. A human reading the run could not tell
 *     a challenge from a truncation from a dead id. Every zero-card outcome now
 *     logs the byte count and the <title>.
 *
 * (c) THE FIRST ANSWER WAS TREATED AS FINAL. An empty response is now retried
 *     at 60s and 180s before any verdict. A soft block lifts on that scale; a
 *     dead id never does, so a dead id costs two waits ONCE -- and a
 *     "Checklist Not Found" body, which is a definite answer, skips the retries
 *     entirely rather than spending four minutes relearning it.
 *
 * The verdict is `backoff`: explicitly NOT terminal, not a failure, and it
 * stops the run cleanly at the FIRST occurrence rather than after a streak of
 * three -- by then the fetcher has already waited four minutes and been
 * refused, so two more entries would only write two more false verdicts.
 *
 * A BARE CDN TEST WOULD BE WORSE THAN NONE. This host's ordinary healthy pages
 * carry Cloudflare markers -- 18 matches on the live, 200-header 2000-01 Topps
 * Chrome page -- so the block signal is the ABSENCE of a checklist COMBINED
 * with a positive block phrase, never a CDN name on its own. Pinned both ways.
 *
 * ── 2. NON-SPORT IS A VERTICAL THE REGEX NEVER ADMITTED ─────────────────────
 *
 * A walk for `sports=non-sport years=1948-1962` found 0 eligible entries. The
 * manifest was the reason: SET_URL_RE alternated four sports, so every
 * `-nonsport-trading-card-checklist` URL failed to parse, classify() returned
 * null, and 5,163 non-sport sets were never minted as entries at all. Not
 * dropped by a cell rule -- never seen.
 *
 * The source spells it `nonsport`, one word; the catalog spells it `non-sport`,
 * and slugGuard's CANONICAL_SPORTS already rules that with a `"nonsport":
 * "non-sport"` alias. So this admits a vertical the system ALREADY KNOWS and
 * invents no vocabulary.
 *
 * Measured against the full sitemap after the fix: 19 of the 21 non-sport sets
 * in 1948-1962 now classify, including every set named in the report -- 1952
 * Topps Wings, 1955 Rails and Sails, 1952 Look 'n See, 1956 Davy Crockett (both
 * backs), 1953-55 World on Wheels, 1956 Flags of the World, 1953 Fighting
 * Marines. The 2 that do not are issuers no brand rule names (Ed-U-Cards, Union
 * Oil); they stay unminted rather than being guessed at.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, "..", "scripts");
const FETCHER = path.join(SCRIPTS, "fetchSportsCardChecklist.cjs");
const DRIVER = path.join(SCRIPTS, "ingest-universe-driver.cjs");
const DISCOVER = path.join(SCRIPTS, "discoverSportsCardChecklistSets.cjs");
const BLOCK = path.join(SCRIPTS, "lib", "scc-block-detect.cjs");

const fetcher = require_(FETCHER);
const driver = require_(DRIVER);
const discover = require_(DISCOVER);
const { challengeSignal, describeResponse, titleOf, CHALLENGE_MARKERS } = require_(BLOCK);

const { zeroCardReason, buildRows, parseSetUrl } = fetcher;
const { TERMINAL_STATUSES, BACKOFF_STATUS, BACKOFF_RETRY_MINUTES } = driver;

/** A body with no card scaffolding, over the 40 KB floor, naming a set page. */
const padded = (inner: string) =>
  `<html><head><title>${inner}</title></head><body>${inner}` +
  "<!-- set-151053 trading-card-checklist -->".repeat(1200) +
  "</body></html>";

const reasonFor = (page: string) => {
  const { stats } = buildRows(page, { parallel: "", isAuto: false });
  return zeroCardReason(page, stats);
};

// ── 1a. the block is recognised, and a healthy page is not ───────────────────

describe("a challenge page is recognised without slandering healthy pages", () => {
  it("a rate-limit body is a challenge", () => {
    const page = padded("Attention Required! | Cloudflare");
    expect(reasonFor(page)).toContain("challenge/rate-limit page");
  });

  it("the reason carries the title, the bytes AND the marker", () => {
    // The run that lost three live entries could not answer "what did we get?"
    // from its own output. This is that answer.
    const r = reasonFor(padded("Just a moment..."));
    expect(r).toMatch(/\d{4,} bytes/);
    expect(r).toContain("title=");
    expect(r).toContain("marker=");
  });

  it.each([
    "cf-browser-verification", "cf_chl_opt", "Just a moment",
    "Attention Required", "Checking your browser before",
    "Too Many Requests", "rate limited", "Ray ID", "Error 1015",
    "You have been blocked", "DDoS protection by",
  ])("%s is a block marker", (marker) => {
    expect(challengeSignal(padded(marker), false)).toBeTruthy();
  });

  it("THE CASE THAT MATTERS: a page WITH cards is never a block", () => {
    // Measured on the live 2000-01 Topps Chrome page: 200 <h5> headers AND 18
    // Cloudflare matches. A CDN name is not evidence of a challenge, and a
    // detector that thought so would condemn every good page on this host.
    const healthy = "<html><body>cloudflare __cf_bm ray id" +
      "<h5 class=\"h4\"><a href=\"#\">x</a> #1 Ted Williams </h5>".repeat(200) +
      "</body></html>";
    expect(challengeSignal(healthy, true)).toBeNull();
  });

  it("a bare CDN name with no block phrase is NOT a challenge", () => {
    // The other half of the same discipline, on a body with no cards.
    expect(challengeSignal(padded("Served by cloudflare"), false)).toBeNull();
    expect(reasonFor(padded("Served by cloudflare"))).not.toContain("challenge/rate-limit");
  });

  it("the not-found page is still a dead id, not a block", () => {
    // #1875's verdict must survive: these are the 6 genuine dead ids among the
    // 30 unreachable verdicts, and they must NOT be re-opened as backoffs.
    const page = padded("Checklist Not Found");
    expect(reasonFor(page)).toContain("not carded at the source");
    expect(reasonFor(page)).not.toContain("challenge/rate-limit");
  });

  it("a truncated body still names itself, now with its title", () => {
    const r = reasonFor("<html><head><title>x</title></head><body>set-1 trading-card-checklist</body></html>");
    expect(r).toContain("did not serve a set page");
    expect(r).toContain("bytes=");
  });

  it("titleOf and describeResponse are honest about a missing title", () => {
    expect(titleOf("<html><body>x</body></html>")).toBe("");
    expect(describeResponse("<html><body>x</body></html>")).toContain("title=(none)");
  });

  it("the marker list stays small and phrase-shaped, never a bare CDN name", () => {
    expect(CHALLENGE_MARKERS.length).toBeLessThanOrEqual(20);
    for (const re of CHALLENGE_MARKERS) {
      expect(re.source.toLowerCase()).not.toBe("cloudflare");
    }
  });
});

// ── 1b. pacing and retry ─────────────────────────────────────────────────────

describe("the lane is paced, and retries before it judges", () => {
  const src = fs.readFileSync(FETCHER, "utf8");

  it("the politeness delay is SPENT before the request", () => {
    // The defect: DELAY_MS existed but was read only in the 429 backoff, so a
    // one-page-per-process fetcher never waited between entries at all.
    expect(src).toContain("const firstWait = jitteredPageDelay();");
    expect(src).toContain("if (firstWait) await sleep(firstWait);");
  });

  it("it is jittered, so a fleet cannot synchronise into a burst", () => {
    expect(src).toContain("PAGE_DELAY_MIN_MS + Math.floor(Math.random() * (PAGE_DELAY_JITTER_MS + 1))");
  });

  it("and configurable, with a polite default", () => {
    expect(src).toContain("SCC_PAGE_DELAY_MS || 2000");
    expect(src).toContain("SCC_PAGE_JITTER_MS || 2000");
  });

  it("an empty response is retried at 60s then 180s before any verdict", () => {
    expect(src).toContain('SCC_RETRY_WAITS_MS || "60000,180000"');
    expect(src).toContain("await sleep(RETRY_WAITS_MS[i]);");
  });

  it("a definite NOT-FOUND answer skips the retries", () => {
    // A dead id must not cost four minutes on every walk.
    expect(src).toContain("if (!looksEmpty || NOT_FOUND_RE.test(html)) break;");
  });

  it("each retry logs what arrived, so a block is visible in the run", () => {
    expect(src).toContain("no checklist on attempt ${i + 1}");
    expect(src).toContain("waiting ${Math.round(RETRY_WAITS_MS[i] / 1000)}s and retrying");
  });

  it("offline --html parsing takes no delay and no retry", () => {
    expect(src).toContain("if (htmlFile) {");
  });
});

// ── 1c. the backoff verdict ──────────────────────────────────────────────────

describe("a backoff stops the run without closing a single entry", () => {
  const src = fs.readFileSync(DRIVER, "utf8");

  it("`backoff` is NOT terminal -- the next pending-only walk takes it again", () => {
    // The whole point. `unreachable` closed 24 live entries; this must not.
    expect(BACKOFF_STATUS).toBe("backoff");
    expect(TERMINAL_STATUSES.has(BACKOFF_STATUS)).toBe(false);
  });

  it("the four statuses that WERE terminal still are", () => {
    for (const s of ["ingested", "unreachable", "empty", "partial"]) {
      expect(TERMINAL_STATUSES.has(s)).toBe(true);
    }
  });

  it("a challenge is classified as a lane backoff, never as a set verdict", () => {
    expect(src).toContain("if (/challenge\\/rate-limit page/.test(said))");
    expect(src).toContain("e.laneBackoff = true;");
  });

  it("laneBackoff outranks emptyAtSource and isGone", () => {
    // A challenge body that also "looks gone" must never become a verdict
    // about the set.
    expect(src).toContain("const status = e?.laneBackoff ? BACKOFF_STATUS");
    const line = src.slice(src.indexOf("const status = e?.laneBackoff"), src.indexOf("const status = e?.laneBackoff") + 220);
    expect(line.indexOf("laneBackoff")).toBeLessThan(line.indexOf("emptyAtSource"));
    expect(line.indexOf("emptyAtSource")).toBeLessThan(line.indexOf("isGone"));
  });

  it("it stops at the FIRST occurrence, not after a streak of three", () => {
    expect(src).toContain("if (verdict.status === BACKOFF_STATUS) {");
    const branch = src.slice(src.indexOf("if (verdict.status === BACKOFF_STATUS) {"), src.indexOf("consecutiveFailures = streakAfter"));
    expect(branch).toContain("break;");
  });

  it("the run says it is backing off, and names a retry time", () => {
    expect(src).toContain("BACKING OFF —");
    expect(src).toContain("retry after ${mins} minutes");
    expect(BACKOFF_RETRY_MINUTES).toBeGreaterThan(0);
  });

  it("it says out loud that nothing was marked unreachable", () => {
    expect(src).toContain("NOTHING was marked unreachable");
  });

  it("THE ABORT-ON-3 SURVIVES for real failures", () => {
    // The case the backoff must not swallow: a genuinely broken lane, or a run
    // of real dead ids, still trips the systemic tripwire.
    expect(src).toContain("if (consecutiveFailures >= SYSTEMIC_FAILURE_STREAK) {");
    expect(src).toContain("consecutive entries failed or were unreachable — the lane, not the entries");
    expect(driver.SYSTEMIC_FAILURE_STREAK).toBeGreaterThanOrEqual(2);
  });

  it("a dead id still reaches `unreachable`, which is still terminal", () => {
    expect(src).toContain("does not card this set id");
    expect(TERMINAL_STATUSES.has("unreachable")).toBe(true);
  });
});

// ── 2. the non-sport vertical ────────────────────────────────────────────────

describe("non-sport is admitted as a vertical the catalog already rules", () => {
  const NONSPORT = "https://www.sportscardchecklist.com/set-155078/1952-topps-wings-friend-or-foe-r707-4-nonsport-trading-card-checklist";

  it("a -nonsport- URL parses at all -- it did not before", () => {
    const p = parseSetUrl(NONSPORT);
    expect(p).toBeTruthy();
    expect(p.year).toBe(1952);
    expect(p.rest).toBe("topps-wings-friend-or-foe-r707-4");
  });

  it("and yields the CANONICAL vertical, not the source's spelling", () => {
    const p = parseSetUrl(NONSPORT);
    expect(p.sport).toBe("non-sport");
    expect(p.sportRaw).toBe("nonsport");
  });

  it("`non-sport` is a ruled vertical -- this invents no vocabulary", () => {
    const guard = fs.readFileSync(
      path.join(HERE, "..", "src", "services", "portfolioiq", "slugGuard.service.ts"), "utf8");
    expect(guard).toContain('"non-sport"');
    expect(guard).toContain('"nonsport": "non-sport"');
  });

  it("classify() mints an entry for it", () => {
    const c = discover.classify(NONSPORT);
    expect(c).toBeTruthy();
    expect(c.sport).toBe("non-sport");
    expect(c.cell.sport).toBe("non-sport");
  });

  it.each([
    ["1952 Topps Wings", "1952-topps-wings-friend-or-foe-r707-4"],
    ["1955 Rails and Sails", "1955-topps-rails-and-sails"],
    ["1952 Look 'n See", "1952-topps-look-and-see"],
    ["1956 Davy Crockett orange", "1956-topps-davy-crockett-orange-back"],
    ["1956 Davy Crockett green", "1956-topps-davy-crockett-green-back-r712-1a"],
    ["1953-55 World on Wheels", "1953-55-topps-world-on-wheels"],
    ["1956 Flags of the World", "1956-topps-flags-of-the-world"],
    ["1953 Fighting Marines", "1953-topps-fighting-marines-r709-1"],
  ])("%s is reachable", (_label, slug) => {
    const c = discover.classify(
      `https://www.sportscardchecklist.com/set-1/${slug}-nonsport-trading-card-checklist`);
    expect(c, `${slug} must classify`).toBeTruthy();
    expect(c.sport).toBe("non-sport");
  });

  it("the cells are the vintage window and the brands already ruled", () => {
    const cells = discover.CELLS.filter((c: any) => c.sport === "non-sport");
    expect(cells.length).toBeGreaterThan(0);
    expect(new Set(cells.map((c: any) => c.setKey))).toEqual(new Set(["topps", "bowman", "fleer"]));
    for (const c of cells) {
      expect(c.from).toBe(1948);
      expect(c.to).toBeLessThanOrEqual(1969);
      expect(discover.BRAND_RE[c.setKey], `${c.setKey} needs a brand pattern`).toBeTruthy();
    }
  });

  it("an issuer no brand rule names stays UNMINTED rather than guessed", () => {
    // Ed-U-Cards and Union Oil are real 1948-1962 non-sport sets on this
    // source. Minting them would mean inventing a product key, so they wait
    // for a ruling instead.
    for (const slug of ["1950-ed-u-cards-the-lone-ranger", "1961-union-oil-dodger-family-booklets"]) {
      expect(discover.classify(
        `https://www.sportscardchecklist.com/set-1/${slug}-nonsport-trading-card-checklist`)).toBeNull();
    }
  });

  it("the four original sports are untouched", () => {
    for (const [slug, sport] of [
      ["1957-topps-baseball", "baseball"],
      ["1972-topps-football", "football"],
      ["1957-topps-basketball", "basketball"],
      ["1979-80-o-pee-chee-hockey", "hockey"],
    ]) {
      const p = parseSetUrl(`https://www.sportscardchecklist.com/set-1/${slug}-trading-card-checklist`);
      expect(p, slug).toBeTruthy();
      expect(p.sport).toBe(sport);
      expect(p.sportRaw).toBe(sport);
    }
  });

  it("both scripts share one regex and one mapping -- they cannot drift", () => {
    const f = fs.readFileSync(FETCHER, "utf8");
    const d = fs.readFileSync(DISCOVER, "utf8");
    for (const src of [f, d]) {
      expect(src).toContain("(football|basketball|hockey|baseball|nonsport)");
      expect(src).toContain('const SPORT_FROM_SLUG = { nonsport: "non-sport" };');
    }
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

describe("the pins fail against the code that lost three live entries", () => {
  it("make `backoff` terminal -> a blocked entry is closed again", () => {
    withMutant(
      DRIVER,
      "SHORT_STATUS, REFUSED_STATUS]);",
      'SHORT_STATUS, REFUSED_STATUS, BACKOFF_STATUS]);',
      "terminalbackoff",
      (m) => {
        expect(m.TERMINAL_STATUSES.has("backoff")).toBe(true);
        expect(TERMINAL_STATUSES.has("backoff")).toBe(false);
      },
    );
  });

  it("drop the hasChecklist guard -> every healthy page becomes a challenge", () => {
    // The detector's whole discipline, as a mutation: this host's good pages
    // carry Cloudflare strings, so a signal that ignores the card scaffolding
    // condemns them.
    withMutant(
      BLOCK,
      "  if (hasChecklist) return null;",
      "  // guard removed",
      "haschecklist",
      (m) => {
        const healthy = "<html><body>cloudflare ray id" +
          "<h5 class=\"h4\"><a href=\"#\">x</a> #1 Ted Williams </h5>".repeat(200) + "</body></html>";
        expect(m.challengeSignal(healthy, true)).toBeTruthy();   // slandered
        expect(challengeSignal(healthy, true)).toBeNull();       // shipped: fine
      },
    );
  });

  it("drop the pre-request delay -> the lane is unpaced again", () => {
    // Asserted on the SOURCE rather than by loading the mutant: the delay is
    // spent inside main()'s fetch path, so proving it by execution would mean
    // really sleeping and really fetching. The line is the mechanism, and its
    // absence is the defect that let today's walk run unpaced.
    const original = fs.readFileSync(FETCHER, "utf8");
    const target = "    if (firstWait) await sleep(firstWait);";
    expect(original).toContain(target);
    const mutated = original.replace(target, "    // delay removed");
    expect(mutated).not.toContain(target);
    // ...and with it gone nothing else in the file waits before a request.
    const fetchPath = mutated.slice(mutated.indexOf("const fetchUrl ="), mutated.indexOf("html = await get(fetchUrl);"));
    expect(fetchPath).not.toContain("await sleep(");
  });

  it("drop `nonsport` from the regex -> all 5,163 non-sport sets vanish again", () => {
    withMutant(
      DISCOVER,
      "(football|basketball|hockey|baseball|nonsport)",
      "(football|basketball|hockey|baseball)",
      "nononsport",
      (m) => {
        const u = "https://www.sportscardchecklist.com/set-155078/1952-topps-wings-friend-or-foe-r707-4-nonsport-trading-card-checklist";
        expect(m.classify(u)).toBeNull();          // the original defect
        expect(discover.classify(u)).toBeTruthy(); // shipped: minted
      },
    );
  });

  it("drop the sport mapping -> the source's spelling escapes into the catalog", () => {
    withMutant(
      DISCOVER,
      'const SPORT_FROM_SLUG = { nonsport: "non-sport" };',
      "const SPORT_FROM_SLUG = {};",
      "nomap",
      (m) => {
        const u = "https://www.sportscardchecklist.com/set-155078/1952-topps-wings-friend-or-foe-r707-4-nonsport-trading-card-checklist";
        // Without the mapping the parsed sport is the SOURCE's `nonsport`,
        // which no cell claims (the cells name the ruled `non-sport`), so the
        // set is dropped exactly as it was before this fix. The mapping is
        // therefore load-bearing, not cosmetic.
        expect(m.classify(u)).toBeNull();
        expect(discover.classify(u).sport).toBe("non-sport");
      },
    );
  });
});
