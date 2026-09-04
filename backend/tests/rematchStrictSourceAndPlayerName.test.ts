/**
 * TWO GAPS IN THE BASE-EVICTION LANE, FOUND IN THE SAME SURVIVOR CENSUS.
 *
 * The base-eviction apply ran on all 32 shards, moved 4,283 of the 9,265
 * base-in-refractor rows and left 4,982. #1750 read the survivors and found
 * the team-name occurrence bug. Reading the same population again for the
 * refusals that are NOT collector judgements turns up two more, and neither is
 * a judgement about which card a sale is -- both are the code failing to read
 * evidence it already holds.
 *
 * ── GAP 1. A CURATED CHECKLIST SOURCE IS CHECKLIST-BACKED ──────────────────
 *
 * `rematch-sold-comps.cjs` carried its own regex for "is this catalog row
 * checklist-backed":
 *
 *   /checklist|beckett|tcdb|insider|bcp|baseballcardpedia|tcgdex/i
 *
 * #1725 later gave the tree ONE named definition -- `STRICT_CHECKLIST_SOURCES`
 * and the exported `isStrictChecklistSource`. Nine of its twenty-one sources
 * do not match the regex:
 *
 *   bccp  cardboardconnection  cardboard-connection  baseball-almanac
 *   hobbymonitor  bbm-japan-official-pdf  pokemon-tcg-data
 *   drew-google-sheet  cardpedia-drew-ruling
 *
 * The near miss is the nastiest kind: `bcp` IS in the pattern, and `bcp` is
 * NOT a substring of `bccp`, so the source that looks covered is the one that
 * is not. These are real scrapes -- bccp alone holds 19,620 catalog rows in
 * 2025 bowman, hobbymonitor 59,982 in 2025 topps-chrome -- and the visible cost
 * is base-eviction's destination gate reporting
 * `no-checklist-backed-base-destination` for base slugs whose checklist we
 * hold. The sale stays in the refractor pool: one card, two pools.
 *
 * THE FIX IS A UNION, AND THE DIRECTION IS THE RULING. The allowlist is now
 * consulted by the driver's `checklistBacked`, ADDED to the regex rather than
 * substituted for it, because the two disagree BOTH ways and only one of those
 * disagreements is this PR's ruling: the regex also accepts
 * `derived-from-base-checklist-*` and `auto-seed-*`, and dropping those would
 * TIGHTEN the ordinary IMPROVE gate across the whole 16.3M-row pool -- a
 * different ruling, on a different population, that nobody has made.
 *
 * ── GAP 2. A PLAYER'S NAME IS NOT A FINISH ────────────────────────────────
 *
 * CF-A-TEAM-NAME-IS-NOT-A-FINISH, read on the other noun in the title. The
 * finish vocabulary is harvested from the checklist corpus, and real parallels
 * really are called Max, King, Royal, Rose, Ruby and Jade. So are people:
 *
 *   "2025 Topps Chrome Max Fried #142 Atlanta Braves"   -> names a finish
 *   "1986 Topps Pete Rose #1 Cincinnati Reds"           -> names a finish
 *
 * The seller named no parallel at all. Guard 3 refuses, and the base sale stays
 * in the refractor pool.
 *
 * SUPPRESSION IS DRIVEN BY THIS ROW'S OWN IDENTITY, because players cannot be
 * enumerated the way `TEAM_NAME_PHRASES` enumerates teams. Only the words of
 * the name attached to THIS card are removed, and only from THIS row's witness
 * -- so "Max Fried ... Gold" still names Gold. That is the entire safety
 * argument and it is pinned in both directions below.
 *
 * AND THE NAME HAS TO BE A PERSON. The CHECKLIST's playerName wins; the row's
 * own stored field is a CHECKED fallback, because 25.7% of the pool's player
 * fields are corrupted (#1734). Measured on this very population the corruption
 * is the dangerous kind -- `playerName: "Pandora Alanna Smith Lynx"`, where
 * Pandora IS the parallel. Suppressing from that field would evict a genuine
 * Prizm Pandora sale onto the base pool: the defect the lane exists to end,
 * arriving through its own repair.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs")) as any;
const VOCAB = require_(path.join(backend, "scripts", "lib", "rematch-finish-vocab.cjs")) as any;

/** The regex the driver used to be alone in trusting. Quoted here so the
 *  disagreement between the two definitions is asserted, not assumed. */
const OLD_DRIVER_RE = /checklist|beckett|tcdb|insider|bcp|baseballcardpedia|tcgdex/i;

// ───────────────────────────────────────────────────────────────────────────
// GAP 1
// ───────────────────────────────────────────────────────────────────────────

describe("the strict allowlist is the ONE definition of a checklist source", () => {
  /** THE FINDING, AS A LIST. Each of these is a curated scraped checklist the
   *  allowlist names and the old regex could not see. If a future edit adds a
   *  source to the allowlist that the regex happens to match, this list simply
   *  gets shorter -- it never needs updating to stay true. */
  const MISSED_BY_THE_REGEX = [
    "bccp", "cardboardconnection", "cardboard-connection", "baseball-almanac",
    "hobbymonitor", "bbm-japan-official-pdf", "pokemon-tcg-data",
    "drew-google-sheet", "cardpedia-drew-ruling",
  ];

  it.each(MISSED_BY_THE_REGEX)("%s is a strict checklist source the old regex missed", (src) => {
    expect(K.isStrictChecklistSource(src)).toBe(true);
    expect(OLD_DRIVER_RE.test(src)).toBe(false);
  });

  it("bcp is in the pattern and is NOT a substring of bccp -- the near miss, named", () => {
    // The single line this whole gap turns on. `bcp` looks like coverage.
    expect(OLD_DRIVER_RE.test("bcp")).toBe(true);
    expect("bccp".includes("bcp")).toBe(false);
    expect(OLD_DRIVER_RE.test("bccp")).toBe(false);
    expect(K.isStrictChecklistSource("bccp")).toBe(true);
  });

  it("EVERY source the allowlist names passes its own predicate", () => {
    // A stem that stops passing is a stem someone edited out of the allowlist
    // without measuring the rows behind it.
    for (const src of K.STRICT_CHECKLIST_SOURCES) {
      expect(K.isStrictChecklistSource(src)).toBe(true);
    }
    expect(K.STRICT_CHECKLIST_SOURCES.length).toBeGreaterThanOrEqual(21);
  });

  it("the per-ingest suffixes and date stamps do not break a stem", () => {
    // The catalog spells the same publisher a dozen ways. Each must normalize
    // back onto the stem, or the fix covers only the tidy spellings.
    expect(K.isStrictChecklistSource("hobbymonitor-2026-08-27")).toBe(true);
    expect(K.isStrictChecklistSource("bccp-scraped")).toBe(true);
    expect(K.isStrictChecklistSource("cardboardconnection-scraped-2026-08-16")).toBe(true);
    expect(K.isStrictChecklistSource("drew-google-sheet-graded")).toBe(true);
    expect(K.normalizeCatalogSource("BCCP-Scraped-2026-08-27")).toBe("bccp");
  });

  it("MUTATION: the union only ever WIDENS -- the self-confirming sources still pass", () => {
    // The direction this PR deliberately did NOT rule on. `checklistBacked` is
    // the ordinary IMPROVE gate over 16.3M rows; substituting the allowlist for
    // the regex would have tightened it silently. These two must keep matching
    // the regex, so the driver's union keeps accepting them.
    expect(OLD_DRIVER_RE.test("derived-from-base-checklist-2026-08")).toBe(true);
    expect(K.isStrictChecklistSource("derived-from-base-checklist-2026-08")).toBe(false);
    expect(OLD_DRIVER_RE.test("auto-seed-tcdb")).toBe(true);
    expect(K.isStrictChecklistSource("auto-seed-tcdb")).toBe(false);
  });

  it("a vendor source is still not a checklist, under EITHER definition", () => {
    // The gate has to keep refusing the thing it was built to refuse.
    for (const src of ["cardhedge", "ebay", "vendor-ebay", "cardsight", "ch-product", "sales-attested"]) {
      expect(K.isStrictChecklistSource(src)).toBe(false);
      expect(OLD_DRIVER_RE.test(src)).toBe(false);
    }
  });

  it("MUTATION: a stem dropped from the allowlist goes red HERE, not in prod", () => {
    // The pin that makes the allowlist the ONE definition rather than a list
    // someone can quietly shorten. Every stem this PR added to the driver's
    // reach is asserted by name; removing one from STRICT_CHECKLIST_SOURCES
    // fails this test instead of silently re-stranding its rows.
    for (const stem of MISSED_BY_THE_REGEX) {
      expect(K.STRICT_CHECKLIST_SOURCES, `${stem} was dropped from the allowlist`)
        .toContain(stem);
    }
  });

  it("a base destination backed ONLY by bccp now supplies somewhere to evict TO", () => {
    // The end-to-end shape of gap 1: with the destination backed, the same row
    // that reported `no-checklist-backed-base-destination` qualifies.
    const slug = "hiq:baseball:2025:bowman:BCP-100:orange:no-auto";
    const stored = {
      sport: "baseball", cardYear: 2025, setKey: "bowman", cardNumber: "BCP-100",
      parallel: "Base", isAuto: false, printRun: null,
    };
    const evict = (backed: boolean) => K.baseEvictionEvidence({
      // A title that names NO finish at all, so the destination gate is the
      // only thing left standing between this sale and its base pool.
      row: { id: "sc-1", cardId: slug, source: "cardhedge", title: "2025 Bowman Chase Burns #BCP-100 Cincinnati" },
      stored, derived: { ...stored }, storedSlug: slug,
      baseDestSlug: "hiq:baseball:2025:bowman:BCP-100:base:no-auto",
      baseDestBacked: backed,
    });
    expect(evict(false).failed).toContain("no-checklist-backed-base-destination");
    expect(evict(false).qualifies).toBe(false);
    expect(evict(true).qualifies).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// GAP 2
// ───────────────────────────────────────────────────────────────────────────

describe("a player's name is not the seller naming a finish", () => {
  /** THE FIXTURE IS THE FINDING -- names that ARE finish words in the corpus. */
  const NAME_WORD_IS_A_FINISH = ["max", "king", "royal", "rose", "ruby", "jade"];

  it.each(NAME_WORD_IS_A_FINISH)("%s is a real finish token -- the word is not the bug", (w) => {
    // The corpus is RIGHT about these words. Bowman and Topps really do print
    // them. What is wrong is the OCCURRENCE, exactly as with the team names.
    expect(VOCAB.titleNamesFinish(w, {})).toBe(true);
  });

  const evict = (title: string, opts: Record<string, unknown> = {}) => {
    const slug = "hiq:baseball:2025:topps-chrome:142:gold:no-auto";
    const stored = {
      sport: "baseball", cardYear: 2025, setKey: "topps-chrome", cardNumber: "142",
      parallel: "Base", isAuto: false, printRun: null,
      ...(opts.stored as Record<string, unknown> ?? {}),
    };
    return K.baseEvictionEvidence({
      row: { id: "sc-x", cardId: slug, source: "cardhedge", title, ...(opts.row as Record<string, unknown> ?? {}) },
      stored, derived: { ...stored, parallel: null }, storedSlug: slug,
      baseDestSlug: "hiq:baseball:2025:topps-chrome:142:base:no-auto",
      baseDestBacked: true,
      checklistPlayerName: opts.checklistPlayerName ?? null,
    });
  };

  it("Max Fried reaches his base pool -- the only 'max' was the man", () => {
    const before = evict("2025 Topps Chrome Max Fried #142 Atlanta Braves");
    expect(before.failed).toContain("title-names-a-finish");
    expect(before.qualifies).toBe(false);

    const after = evict("2025 Topps Chrome Max Fried #142 Atlanta Braves", { checklistPlayerName: "Max Fried" });
    expect(after.qualifies).toBe(true);
    expect(after.failed).not.toContain("title-names-a-finish");
    // The evidence travels with the row: what was suppressed is quoted.
    expect(after.evidence.playerNameSuppressed).toBe("Max Fried");
  });

  it("Pete Rose reaches his base pool", () => {
    const r = K.baseEvictionEvidence({
      row: { id: "sc-rose", cardId: "hiq:baseball:1986:topps:1:rose:no-auto", source: "cardhedge",
             title: "1986 Topps Pete Rose #1 Cincinnati Reds" },
      stored: { sport: "baseball", cardYear: 1986, setKey: "topps", cardNumber: "1", parallel: "Base", isAuto: false, printRun: null },
      derived: { sport: "baseball", cardYear: 1986, setKey: "topps", cardNumber: "1", parallel: null, isAuto: false, printRun: null },
      storedSlug: "hiq:baseball:1986:topps:1:rose:no-auto",
      baseDestSlug: "hiq:baseball:1986:topps:1:base:no-auto", baseDestBacked: true,
      checklistPlayerName: "Pete Rose",
    });
    expect(r.qualifies).toBe(true);
  });

  it("ONLY the words of that name -- 'Max Fried ... Gold' still names Gold", () => {
    // THE safety property. One word added and the row must flip straight back
    // to refused, or the suppression is a colour blocklist wearing a disguise.
    const r = evict("2025 Topps Chrome Max Fried #142 Gold Refractor /50", { checklistPlayerName: "Max Fried" });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("title-names-a-finish");
  });

  it("a finish word that is ANOTHER player's name is untouched", () => {
    // "Ruby" is suppressed because it is this card's player. "Jade" is not a
    // word of that name, so the parallel the seller named still defends the row.
    const r = evict("2025 Topps Chrome Ruby Ruiz #142 Jade Refractor", { checklistPlayerName: "Ruby Ruiz" });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("title-names-a-finish");
  });

  it("no readable name means no suppression -- today's answer, unchanged", () => {
    // Absent beats wrong. A caller that cannot supply the checklist name and a
    // row with no stored name gets exactly the behaviour it gets today.
    expect(evict("2025 Topps Chrome Max Fried #142 Atlanta Braves").qualifies).toBe(false);
  });

  it("a CORRUPTED stored name is refused as a source -- Pandora IS the parallel", () => {
    // The measured failure mode, pinned. If the trust gate is removed, this row
    // evicts a genuine Prizm Pandora sale onto the base pool.
    const title = "Panini 2025 Prizm Pandora Alanna Smith #101 Minnesota Lynx";
    const r = K.baseEvictionEvidence({
      row: { id: "sc-p", cardId: "hiq:basketball:2025:panini-prizm:101:pandora:no-auto",
             source: "cardhedge", title, playerName: "Pandora Alanna Smith Lynx" },
      stored: { sport: "basketball", cardYear: 2025, setKey: "panini-prizm", cardNumber: "101",
                parallel: "Base", isAuto: false, printRun: null, playerName: "Pandora Alanna Smith Lynx" },
      derived: { sport: "basketball", cardYear: 2025, setKey: "panini-prizm", cardNumber: "101",
                 parallel: null, isAuto: false, printRun: null },
      storedSlug: "hiq:basketball:2025:panini-prizm:101:pandora:no-auto",
      baseDestSlug: "hiq:basketball:2025:panini-prizm:101:base:no-auto", baseDestBacked: true,
    });
    // The checklist name is absent and the stored one carries a parallel, so
    // nothing is suppressed and the row is NOT evicted. Asserted on
    // `qualifies` rather than on ONE reason string, because the row collects
    // two independent refusals -- the vocabulary's and G6's -- and pinning the
    // guard that happens to be listed first would pass while the other silently
    // became the only thing holding the row.
    expect(r.qualifies).toBe(false);
    // and the corrupted field was refused BY NAME as a source of suppression
    expect(r.evidence.playerNameSuppressed).toBeNull();
    expect(K.trustedPlayerName({ checklistPlayerName: null, storedPlayerName: "Pandora Alanna Smith Lynx" }))
      .toBeNull();
  });

  it("the CHECKLIST name outranks the row's own field", () => {
    // Same corrupted stored field, but the checklist can answer. Only the real
    // person's words are suppressed, so "Pandora" survives and the row stays.
    expect(K.trustedPlayerName({ checklistPlayerName: "Alanna Smith", storedPlayerName: "Pandora Alanna Smith Lynx" }))
      .toBe("Alanna Smith");
    expect(K.titleWithoutPlayerName("prizm pandora alanna smith", "Alanna Smith").trim())
      .toBe("prizm pandora");
  });

  it("the strip removes the PHRASE, not the words -- 'Pete Rose ... Rose Gold' keeps its Rose", () => {
    // THE over-broad direction, pinned. Word-wise suppression deletes both
    // roses and evicts a genuine Rose Gold sale onto the base pool. The
    // contiguous run is what makes this evidence and not a blocklist.
    expect(K.titleWithoutPlayerName("1986 topps pete rose #1 rose gold parallel", "Pete Rose"))
      .toMatch(/rose gold/);
    expect(K.titleWithoutPlayerName("1986 topps pete rose #1 rose gold parallel", "Pete Rose"))
      .not.toMatch(/pete/);
  });

  it("a multi-word name that never appears as a run is not suppressed at all", () => {
    // Scattered single words are not evidence that this title names this
    // person, so nothing is struck and the row keeps today's verdict.
    const t = "2025 topps chrome max #142 something fried";
    expect(K.titleWithoutPlayerName(t, "Max Fried")).toBe(t);
  });

  it("a one-word name is still removed -- there is no run to anchor against", () => {
    expect(K.titleWithoutPlayerName("2001 topps ichiro #726 mariners", "Ichiro"))
      .not.toMatch(/ichiro/);
  });

  it("a particle inside the name does not break the run", () => {
    // `playerNameWords` drops "de"/"la"/"jr" -- they are not distinguishing
    // words -- but they sit BETWEEN the words that are. Without admitting them
    // back as separators, every player with a particle in their name is
    // silently never suppressed: fail-safe, but a large and specific
    // population quietly getting nothing.
    expect(K.titleWithoutPlayerName("2024 topps chrome elly de la cruz #100 reds", "Elly De La Cruz"))
      .not.toMatch(/elly|cruz/);
    expect(K.titleWithoutPlayerName("2024 topps ronald acuna jr #1 braves", "Ronald Acuna Jr"))
      .not.toMatch(/ronald|acuna/);
  });

  it("particles and initials are never suppressed", () => {
    // "de", "jr" and two-letter tokens are not distinguishing words, and a
    // two-letter suppression would silently delete half the vocabulary.
    expect([...K.playerNameWords("Elly De La Cruz Jr")]).toEqual(["elly", "cruz"]);
    expect(K.playerNameWords("A J Brown").has("a")).toBe(false);
  });

  it("the shared vocabulary predicate itself is UNCHANGED -- IMPROVE is not touched", () => {
    // The same boundary #1750 pinned. The strip lives at the base-eviction call
    // site; if this flips, `titleNamesFinish` was edited and the IMPROVE guards
    // moved with it.
    expect(VOCAB.titleNamesFinish("2025 Topps Chrome Max Fried #142 Atlanta Braves",
      { year: 2025, setKey: "topps-chrome" })).toBe(true);
  });

  it("composes with the team strip -- a title can carry both", () => {
    // Pete Rose on the Reds: the player is a finish word AND the team is one.
    // Either guard alone leaves the row refused.
    const witness = K.titleWithoutPlayerName(
      K.titleWithoutTeamNames("1986 Topps Pete Rose #1 The Reds"), "Pete Rose");
    expect(VOCAB.titleNamesFinish(witness, { year: 1986, setKey: "topps" })).toBe(false);
  });
});

/**
 * TWO GUARDS, ONE BUG -- THE SAME SHAPE #1750 MEASURED, ON THE PLAYER.
 *
 * Found by this PR's own pins: with the vocabulary fixed, "Pete Rose" was
 * STILL refused, by G6 rather than by guard 3. G6 reads the title as a bag of
 * words, so a one-word slug parallel matches the player exactly as it matched
 * the team. Fixing guard 3 alone would have released nothing on these rows,
 * which is the mirror image of what #1750 found (there, guard 3 was the binding
 * one and fixing G6 alone would have released nothing).
 */
describe("G6 -- a player's name does not echo a one-word parallel slug", () => {
  const g6 = (title: string, seg: string, playerName: string | null) =>
    K.storedParallelStatedInTitle({
      title, storedSlug: `hiq:baseball:1986:topps:1:${seg}:no-auto`,
      stored: { parallel: "Base" }, setKey: "topps", playerName,
    });

  it("Pete Rose no longer echoes the 'rose' slug", () => {
    expect(g6("1986 Topps Pete Rose #1 Cincinnati Reds", "rose", null)?.phrase).toBe("rose");
    expect(g6("1986 Topps Pete Rose #1 Cincinnati Reds", "rose", "Pete Rose")).toBeNull();
  });

  it("a parallel named OUTSIDE the player's name still echoes", () => {
    // The safety direction. "Rose Refractor" is the seller naming a parallel;
    // suppressing the man's name leaves the word "refractor" and the phrase
    // no longer matches, but the bare-colour slug the seller DID name still does.
    expect(g6("1986 Topps Pete Rose #1 Rose Gold Parallel", "rose-gold", "Pete Rose")?.phrase)
      .toBe("rose-gold");
  });

  it("a multi-word parallel is unaffected -- it could never collide with a name", () => {
    expect(g6("2025 Topps Chrome Max Fried Pink Refractor #142", "pink-refractor", "Max Fried")?.phrase)
      .toBe("pink-refractor");
  });

  it("the 12 DAMAGED rows G6 was built for are untouched", () => {
    // G6's whole reason for existing: a parallel the corpus never heard of,
    // defending its own row. None of these words is a player's name here.
    expect(g6("2025 Topps Cosmic Chrome Joe Burrow Planetary Pursuit Mercury #PPM-JB", "mercury", "Joe Burrow")?.phrase)
      .toBe("mercury");
    expect(g6("Topps 2025 Cosmic Chrome Justin Jefferson Vikings Venus Insert #PPV-JJ", "venus", "Justin Jefferson")?.phrase)
      .toBe("venus");
  });
});

describe("MUTATION PIN -- the released row is a BASE-EVICTION, the honest one is not", () => {
  const input = (title: string, checklistPlayerName: string | null) => {
    const slug = "hiq:baseball:2025:topps-chrome:142:max:no-auto";
    const stored = {
      sport: "baseball", cardYear: 2025, setKey: "topps-chrome", cardNumber: "142",
      parallel: "Base", isAuto: false, printRun: null,
    };
    return {
      row: { id: "sc-fried", cardId: slug, source: "cardhedge", title },
      stored, derived: { ...stored, parallel: null }, checklistBacked: true,
      storedSlug: slug, baseDestSlug: "hiq:baseball:2025:topps-chrome:142:base:no-auto",
      baseDestBacked: true, checklistPlayerName,
    };
  };

  it("the Fried row is a BASE-EVICTION again, and writable", () => {
    const r = K.classifyRow(input("2025 Topps Chrome Max Fried #142 Atlanta Braves", "Max Fried"));
    expect(r.subclass).toBe(K.BASE_EVICTION);
    expect(r.writable).toBe(true);
  });

  it("the same row with a real parallel in the title stays refused and unwritable", () => {
    const r = K.classifyRow(input("2025 Topps Chrome Max Fried #142 Gold Refractor /50", "Max Fried"));
    expect(r.subclass).not.toBe(K.BASE_EVICTION);
    expect(r.writable).toBe(false);
  });

  it("REVERTING the suppression puts the Fried row back in the refractor pool", () => {
    // Drop the name and the row must return to exactly its pre-fix verdict.
    // A pin that passes with the fix reverted is a pin that proves nothing.
    const r = K.classifyRow(input("2025 Topps Chrome Max Fried #142 Atlanta Braves", null));
    expect(r.subclass).not.toBe(K.BASE_EVICTION);
    expect(r.writable).toBe(false);
  });
});

/**
 * A PUBLISHER'S LANE IS STILL THAT PUBLISHER (Drew's ruling, 2026-09-04).
 *
 * `tcgdex-ja-2026-09-04` is the SAME publisher as `tcgdex` -- scrape-tcgdex-ja.cjs
 * reads the identical free JSON API (MIT, the permitted one), and `-ja` names
 * WHICH CORPUS of that API was walked, not a different source of evidence. It
 * normalised to `tcgdex-ja`, which the allowlist did not carry, so 12,851 rows
 * scored STRICT 0 while the LOOSE `catalogAuthorityOf` called every one of them
 * `checklist` -- the two predicates disagreeing about the same rows, which is
 * exactly the split the allowlist exists to prevent.
 *
 * Measured read-only over all 172 distinct card_catalog sources (2026-09-04),
 * exactly FIVE normalized keys are a suffix of a strict publisher, and they are
 * NOT the same case. The two lanes are admitted BY NAME; the three refusals are
 * pinned just as hard, because a generic "strip the last segment" rule would
 * promote a VENDOR product classification into the gate whose false yes moves a
 * sale onto a card that may never have been printed.
 */
describe("a lane suffix never flips a known publisher's strictness", () => {
  it("tcgdex-ja is tcgdex — the ruling", () => {
    expect(K.isStrictChecklistSource("tcgdex-ja-2026-09-04")).toBe(true);
    expect(K.isStrictChecklistSource("tcgdex-ja-2026-09-02")).toBe(true);
    expect(K.isStrictChecklistSource("tcgdex-ja-2026-08-28")).toBe(true);
    expect(K.isStrictChecklistSource("tcgdex-ja")).toBe(true);
    // the un-laned publisher is unchanged, in both its spellings
    expect(K.isStrictChecklistSource("tcgdex-scraped-2026-08-16")).toBe(true);
    expect(K.isStrictChecklistSource("tcgdex")).toBe(true);
  });

  it("tcdb-scrape is tcdb — the same self-disagreement, one letter apart", () => {
    // `tcdb-scraped-*` already normalises to `tcdb` (the `-scraped` suffix is
    // stripped as an ingest verb) and was strict; `tcdb-scrape` was not. Same
    // publisher, same lane, two verdicts.
    expect(K.isStrictChecklistSource("tcdb-scrape")).toBe(true);
    expect(K.isStrictChecklistSource("tcdb-scrape-graded")).toBe(true);
    expect(K.isStrictChecklistSource("tcdb-scraped-2026-08-17")).toBe(true);
    expect(K.isStrictChecklistSource("tcdb-2026-08-12")).toBe(true);
  });

  it("the lane list is EXPLICIT — a vendor lane is refused however it is spelled", () => {
    // catalogAuthority.service.ts sends every `-product-structure` to VENDOR by
    // name, and the doctrine is consume SALES not PRODUCT fields. A generic
    // suffix rule would have made `bccp-product-structure` strict off `bccp`.
    expect(K.isStrictChecklistSource("bccp-product-structure")).toBe(false);
    expect(K.isStrictChecklistSource("clc-product-structure")).toBe(false);
    // a legacy FILL lane, ranked BELOW cardsight by nukeCatalogFragmentation
    expect(K.isStrictChecklistSource("checklist-batch-fill")).toBe(false);
    expect(K.isStrictChecklistSource("checklist-batch-fill-graded")).toBe(false);
    // a hand-edit lane of unproven provenance: 3 rows, never audited
    expect(K.isStrictChecklistSource("baseballcardpedia-manual-2026-08-10")).toBe(false);
  });

  it("an UNKNOWN publisher stays non-strict however it is laned", () => {
    // The lane must resolve to a publisher the list ALREADY trusts, so this can
    // never admit a new source -- only a corpus of an existing one.
    expect(K.isStrictChecklistSource("nonesuch-ja")).toBe(false);
    expect(K.isStrictChecklistSource("nonesuch-ja-2026-09-04")).toBe(false);
    expect(K.isStrictChecklistSource("ebay-ja")).toBe(false);
    expect(K.isStrictChecklistSource("cardhedge-ja-2026-09-04")).toBe(false);
    expect(K.isStrictChecklistSource("pool-scrape")).toBe(false);
    expect(K.isStrictChecklistSource("sold-comps-stub-scrape")).toBe(false);
  });

  it("MUTATION PIN: every named lane resolves to an ALREADY-strict publisher", () => {
    // The guard that makes the rule safe. If a lane were ever added whose
    // publisher is not itself strict, this widens the gate silently.
    for (const lane of K.STRICT_PUBLISHER_LANES) {
      const publisher = lane.slice(0, lane.lastIndexOf("-"));
      expect(K.STRICT_CHECKLIST_SOURCES, `${lane} -> ${publisher}`).toContain(publisher);
      expect(K.isStrictChecklistSource(lane)).toBe(true);
    }
  });

  it("MUTATION PIN: emptying the lane list restores the defect", () => {
    // A pin that passes with the fix reverted proves nothing. Rebuild the
    // predicate with no lanes and the tcgdex-ja rows go dark again.
    const withoutLanes = (raw: string) => {
      const s = K.normalizeCatalogSource(raw);
      return s !== "" && K.STRICT_CHECKLIST_SOURCES.includes(s);
    };
    expect(withoutLanes("tcgdex-ja-2026-09-04"), "the defect").toBe(false);
    expect(K.isStrictChecklistSource("tcgdex-ja-2026-09-04"), "the fix").toBe(true);
    // and the refusals are refusals under BOTH, so the fix widened nothing else
    for (const s of ["bccp-product-structure", "checklist-batch-fill", "nonesuch-ja"]) {
      expect(withoutLanes(s)).toBe(false);
      expect(K.isStrictChecklistSource(s)).toBe(false);
    }
  });
});
