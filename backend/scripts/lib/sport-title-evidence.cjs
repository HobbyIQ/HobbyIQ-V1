"use strict";
/**
 * sport-title-evidence.cjs -- THE GAZETTEER, shipped. Pure: no I/O, no
 * Cosmos, no clock.
 *
 * R76 (Drew, 2026-09-19). On 2026-08-20 repair-set-sport.cjs flipped 183,248
 * sold_comps rows' sport by set-level checklist dominance
 * (setSportAuthority.cjs), vetoed only by FIVE literal substring words
 * (SPORT_WORDS = "baseball"/"football"/"basketball"/"hockey"/"soccer"). A
 * read-only census judged 69,598 of those flips WRONG: the title named a
 * different sport's TEAM or LEAGUE (not one of the five literal words), and
 * the substring veto never saw it -- "1988 Fleer Michael Jordan ... Chicago
 * Bulls" contains none of the five words, so nothing stopped the basketball
 * card from being flipped to baseball on the strength of Fleer's baseball
 * checklist dominance.
 *
 * THIS MODULE is that missing evidence, built once and shared by BOTH the
 * restore lane (revert-set-sport-repair.cjs, judging which of the 69,598 to
 * put back) and the repair's own veto (setSportAuthority.cjs's judgeComp),
 * so the two can never drift the way the substring/five-word veto already
 * did once. One rule, two call sites -- CF-ONE-DECLARATION-TWO-READERS.
 *
 * -- WORD-BOUNDARY MATCHING, NOT SUBSTRING ----------------------------------
 *
 * A naive `title.includes("reds")` reads "Redskins" as containing MLB's
 * "Reds" -- exactly the failure class SPORT_WORDS' successor must not repeat
 * one level down. Every gazetteer term is escaped and wrapped in explicit
 * non-word-char (or string-edge) boundaries; `\b` is not reliable around
 * apostrophes/periods in multi-word team names ("d.c. united", "st. louis
 * city"), so this uses an explicit negative lookaround instead.
 *
 * -- AMBIGUOUS NICKNAMES -----------------------------------------------------
 *
 * Some team words name a franchise in MORE THAN ONE league: "kings" is BOTH
 * the NBA Sacramento Kings and the NHL LA Kings (both already gazetteer
 * entries below, in their real per-sport lists -- NOT suppressed). A title
 * naming "kings" alone therefore evidences TWO sports at once, and the word
 * by itself decides nothing between them.
 *
 * This is exactly the census's own `gaz.size > 1` branch (classifyA.cjs):
 * when a title's evidence set names more than one sport, sportBefore and the
 * post-repair sport are compared against that SET, and the verdict follows
 * DIRECTIONALLY -- `sports.has(before) && !sports.has(current)` still means
 * "the title's evidence set backs the pre-repair sport and not the
 * post-repair one," which is exactly as strong a restore signal as a single
 * unambiguous word, because the title never claimed the CURRENT sport at
 * all. The 300-row validation sample's 10 "Kings" rows (Jordan/Ewing/
 * Robitaille/Richmond/Thomas/Olajuwon/Doughty) all resolved this way: every
 * one names hockey+basketball (never baseball or football, since neither
 * league fields a "Kings"), so a baseball-current/basketball-before flip
 * reads unambiguously restore regardless of which of the two the word
 * itself points at.
 *
 * AMBIGUOUS_NICKNAMES therefore is NOT an exclusion list -- every word on it
 * stays live in its real per-sport gazetteer entries below. It exists only
 * so `judgeRestoreVerdict` can name, in its `ambiguous-only` leave reason,
 * that a word which is inherently multi-league was the ONLY evidence in a
 * title where sportBefore and current happen to be the SAME two leagues the
 * word already spans and neither is named apart from it (a title that says
 * nothing else at all) -- see judgeRestoreVerdict for the exact branch.
 *
 * -- PHRASE EXCLUSIONS --------------------------------------------------------
 *
 * A full-population sweep (R76, 2026-09-19) found 7 rows where a PRODUCT
 * name -- not a city or team name -- collided with a gazetteer word:
 *
 *   "Wizards of the Coast" (the Pokemon TCG publisher's own historical name)
 *     is not the NBA Washington Wizards.
 *   "Phantasmal Flames" (a 2025 Pokemon TCG expansion) is not the NHL
 *     Calgary Flames.
 *   "Lightning Strike(s)" (an insert/subset name used across MULTIPLE
 *     products -- 2000 Upper Deck basketball, Topps/Panini soccer) is not
 *     the NHL Tampa Bay Lightning.
 *
 * When an exclusion phrase is present, its associated single-word gazetteer
 * term is suppressed for that title -- even though the phrase itself
 * contains the word as a substring, because a plain word-boundary match
 * cannot distinguish "Wizards of the Coast" from "Washington Wizards"; both
 * are legitimate multi-word phrases built on the same root word.
 *
 * Genuinely-basketball Kobe Bryant "Lightning Strikes" rows (13 in the
 * validated population) still resolve correctly after this suppression: the
 * player name (Kobe Bryant) and/or the product (Fleer, Upper Deck -- both
 * pre-dating any hockey Lightning Strike insert this pool carries) still
 * name basketball elsewhere in evidence gathering; suppressing the word
 * "lightning" costs nothing there because it was never the deciding
 * evidence for those rows to begin with.
 */

const NHL = [
  "bruins", "sabres", "red wings", "panthers", "canadiens", "senators", "lightning", "maple leafs",
  "hurricanes", "blue jackets", "devils", "islanders", "rangers", "flyers", "penguins", "capitals",
  "blackhawks", "avalanche", "stars", "wild", "predators", "blues", "jets", "utah hockey club",
  "ducks", "flames", "oilers", "kings", "sharks", "kraken", "canucks", "golden knights",
  "goalie", "goaltender", "netminder", "nhl", "stanley cup", "hat trick", "power play", "hockey",
];
const NBA = [
  "hawks", "celtics", "nets", "hornets", "bulls", "cavaliers", "cavs", "mavericks", "mavs", "nuggets",
  "pistons", "warriors", "rockets", "pacers", "clippers", "lakers", "grizzlies", "heat", "bucks",
  "timberwolves", "pelicans", "knicks", "thunder", "magic", "76ers", "sixers", "suns", "trail blazers",
  "blazers", "kings", "spurs", "raptors", "jazz", "wizards", "nba", "basketball", "point guard",
  "shooting guard", "power forward", "center", "small forward", "triple-double", "slam dunk",
];
const NFL = [
  "cardinals", "falcons", "ravens", "bills", "panthers", "bears", "bengals", "browns", "cowboys",
  "broncos", "lions", "packers", "texans", "colts", "jaguars", "chiefs", "raiders", "chargers",
  "rams", "dolphins", "vikings", "patriots", "saints", "giants", "jets", "eagles", "steelers",
  "49ers", "niners", "seahawks", "buccaneers", "bucs", "titans", "commanders", "redskins",
  "nfl", "football", "quarterback", "running back", "wide receiver", "tight end", "linebacker",
  "cornerback", "safety", "punter", "kicker", "touchdown", "interception", "super bowl", "pro bowl",
];
const MLB = [
  "diamondbacks", "d-backs", "braves", "orioles", "red sox", "cubs", "white sox", "reds",
  "guardians", "indians", "rockies", "tigers", "astros", "royals", "angels", "dodgers", "marlins",
  "brewers", "twins", "mets", "yankees", "athletics", "phillies", "pirates", "padres", "giants",
  "mariners", "cardinals", "rays", "rangers", "blue jays", "nationals", "expos",
  "mlb", "baseball", "pitcher", "outfielder", "shortstop", "first baseman", "second baseman",
  "third baseman", "catcher", "world series", "home run",
  // "rbi" and bare "era" dropped: both true acronyms/words but too weak a
  // signal alone (e.g. "New Era" cap brand, "steroid era") and rare enough
  // in this pool (12 hits total, 2 of them "New Era") not to be worth the
  // risk -- the same exclusion the original census gazetteer made.
];
const MLS_SOCCER = [
  "atlanta united", "austin fc", "charlotte fc", "chicago fire", "fc cincinnati", "colorado rapids",
  "columbus crew", "dc united", "d.c. united", "fc dallas", "houston dynamo", "sporting kc",
  "inter miami", "la galaxy", "lafc", "minnesota united", "nashville sc", "new england revolution",
  "nycfc", "new york red bulls", "orlando city", "philadelphia union", "portland timbers",
  "real salt lake", "san jose earthquakes", "seattle sounders", "st. louis city", "toronto fc",
  "vancouver whitecaps", "premier league", "la liga", "bundesliga", "serie a", "ligue 1",
  "champions league", "world cup", "fifa", "uefa", "mls", "striker", "midfielder", "fullback",
  "goalkeeper", "fc barcelona", "real madrid", "manchester united", "manchester city", "liverpool fc",
  "chelsea fc", "arsenal fc", "juventus", "bayern munich", "psg", "soccer", "football club",
];

const ALL = [
  ...NHL.map((w) => [w, "hockey"]),
  ...NBA.map((w) => [w, "basketball"]),
  ...NFL.map((w) => [w, "football"]),
  ...MLB.map((w) => [w, "baseball"]),
  ...MLS_SOCCER.map((w) => [w, "soccer"]),
];

// Longest-first so multi-word team names are matched before shorter overlaps
// contained within them (e.g. "kansas city chiefs" over a stray shorter word).
ALL.sort((a, b) => b[0].length - a[0].length);

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * WEAK WORDS (review HIGH 2, 2026-09-19): single common words -- usually a
 * position or a generic hobby term -- that name a sport ONLY in context, and
 * collide with ordinary English or other product names on their own:
 * "center" ("Center Stage" insert), "safety" ("Safety Set" of a grading
 * service), "kicker" (a bonus/incentive card, "kicker card"), the *-guard
 * position words (a plain "guard" occurs in non-sports contexts too, though
 * this gazetteer only ever compiles the qualified forms "point guard" /
 * "shooting guard" -- listed here for the same reason). A title whose ONLY
 * hits are weak words is treated as NO EVIDENCE, never as naming that sport
 * -- see `sportEvidence`'s `sports`, which excludes any sport backed
 * exclusively by weak hits. A weak word sitting ALONGSIDE a strong hit for
 * the SAME sport costs nothing (the strong hit already carries the sport);
 * it only changes the answer when it would otherwise be the sole evidence. */
const WEAK_WORDS = new Set([
  "center", "safety", "kicker", "punter",
  "point guard", "shooting guard",
]);

/**
 * AUTHORITATIVE WORDS (review HIGH 2, 2026-09-19): the sport's own name or
 * its league acronym. Unlike a team nickname -- which can belong to a
 * college, a high school, or an unrelated org the gazetteer has never heard
 * of ("Duke Blue Devils" is not the NHL New Jersey Devils, but a bare
 * "devils" hit cannot tell the two apart) -- a title that says "basketball"
 * or "NBA" outright is making a direct, on-purpose claim about the sport,
 * not a claim mediated through a team name that might belong to anyone.
 *
 * When a title carries an authoritative hit for ONE of {sportBefore,
 * currentSport} and no authoritative hit for the OTHER, a non-authoritative
 * (plain team-nickname) hit for that other sport is treated as the weaker
 * signal it is and does not block the authoritative word's verdict --
 * "college basketball Duke Blue Devils" evidences basketball authoritatively
 * and hockey only through the bare, unqualified nickname "devils"; the
 * authoritative hit wins. Two authoritative hits (or an authoritative hit on
 * one side against a MULTI-WORD, specific team name naming a real
 * professional franchise on the other -- not merely a bare shared nickname)
 * still produce `both-named`/`third-sport` exactly as before; this tier only
 * demotes an otherwise-decisive bare nickname collision, never a genuine
 * team identification. */
const AUTHORITATIVE_WORDS = new Set(["hockey", "nhl", "basketball", "nba", "football", "nfl", "baseball", "mlb", "soccer", "mls"]);

const COMPILED = ALL.map(([word, sport]) => ({
  sport,
  word: word.toLowerCase(),
  weak: WEAK_WORDS.has(word.toLowerCase()),
  authoritative: AUTHORITATIVE_WORDS.has(word.toLowerCase()),
  re: new RegExp(`(?<![a-z0-9])${escapeRe(word.toLowerCase())}(?![a-z0-9])`, "g"),
}));

/** Words present in TWO-PLUS of the per-sport lists above -- computed, not
 *  hand-maintained, so a future gazetteer edit can never silently drift from
 *  this list. See AMBIGUOUS NICKNAMES doc above: these stay LIVE in
 *  `COMPILED`/`sports`, this map only names which leagues a bare hit spans
 *  for `judgeRestoreVerdict`'s `ambiguous-only` reason text. */
const AMBIGUOUS_NICKNAMES = (() => {
  const bySport = new Map(); // word -> Set(sport)
  for (const [word, sport] of ALL) {
    const key = word.toLowerCase();
    if (!bySport.has(key)) bySport.set(key, new Set());
    bySport.get(key).add(sport);
  }
  const out = new Map();
  for (const [word, sports] of bySport) if (sports.size > 1) out.set(word, sports);
  return out;
})();

/**
 * EXCLUSION PHRASES (R76 fix, 2026-09-19). See module header. Each entry
 * names a phrase and the gazetteer word inside it that a word-boundary match
 * would otherwise wrongly credit.
 *
 * SUPPRESSION IS PER-OCCURRENCE (review HIGH 2, 2026-09-19), not word-wide.
 * The first version of this table suppressed the WORD for the whole title --
 * so "Washington Wizards ... Wizards of the Coast" (a title that names both
 * the real NBA team AND quotes the Pokemon publisher) would have lost its
 * genuine basketball evidence along with the false one. `sportEvidence` now
 * matches the exclusion phrase's OWN span in the title and only discards a
 * gazetteer hit whose match position falls INSIDE that span -- a "wizards"
 * hit at index 11 ("Washington Wizards") survives; one at index 40 ("Wizards
 * of the Coast") does not, in the same title.
 */
const EXCLUSIONS = [
  { phrase: "wizards of the coast", suppresses: ["wizards"] },
  { phrase: "lightning strike", suppresses: ["lightning"] },
  { phrase: "phantasmal flames", suppresses: ["flames"] },
];

/**
 * Every [start, end) span of `phrase` in `t`, so a suppression can be scoped
 * to just that occurrence rather than the whole title.
 */
function phraseSpans(t, phrase) {
  const spans = [];
  let from = 0;
  for (;;) {
    const at = t.indexOf(phrase, from);
    if (at < 0) break;
    spans.push([at, at + phrase.length]);
    from = at + 1;
  }
  return spans;
}

/**
 * sportEvidence(title) -> { sports: Set<string>, authoritativeSports: Set<string>,
 *                           hits: [{ word, sport, weak, authoritative }],
 *                           onlyAmbiguousWords: boolean }
 *
 * `sports` is every DISTINCT sport with at least one STRONG (non-weak) hit
 * in the title (word-boundary matched, phrase-exclusions applied per
 * occurrence) -- see WEAK_WORDS above: a sport backed ONLY by weak-word hits
 * never enters `sports` at all, so a title like "Center Stage" or "Safety
 * Set" registers no sport rather than a false basketball/football. It may
 * be empty, or contain more than one entry -- either because the title
 * genuinely names two sports, or because it hit an AMBIGUOUS_NICKNAMES word
 * that spans more than one league on its own ("kings" -> {hockey,
 * basketball}).
 *
 * `authoritativeSports` is the subset of `sports` backed by an
 * AUTHORITATIVE_WORDS hit (the sport's own name or league acronym) -- see
 * that doc above for why this is a stronger claim than a team nickname.
 * `judgeRestoreVerdict` uses it to demote a bare, unqualified nickname
 * collision against an authoritative hit for the other side; `sportEvidence`
 * itself makes no before/current comparison and does not otherwise treat
 * `sports` and `authoritativeSports` differently.
 *
 * FOOTBALL/SOCCER (review HIGH 2, 2026-09-19): the literal word "football"
 * is ambiguous between American football and the rest-of-world name for
 * soccer. The simplest rule that keeps the 300/300 census reproduction and
 * fixes the collision: when the ONLY evidence for "football" in a title is
 * the bare literal word itself (no NFL team/league/position hit) AND the
 * title ALSO carries genuine soccer evidence, the literal "football" hit is
 * read as the soccer sense and does not add "football" to `sports` --
 * soccer wins outright rather than producing a false "both-named". A title
 * naming BOTH the literal word "football" and an NFL-specific term (e.g.
 * "quarterback", "Cowboys") still gets football from the specific term
 * regardless of any soccer word elsewhere; this rule only fires when the
 * bare word is football's ONLY signal.
 *
 * `hits` is every individual surviving match, for callers that want to show
 * their work (each tagged `weak`/`authoritative`). `onlyAmbiguousWords` is
 * true iff every entry in `sports` is backed only by AMBIGUOUS_NICKNAMES
 * words -- i.e. `sports` is non-empty but nothing in the title
 * single-handedly names one league.
 */
function sportEvidence(title) {
  const t = String(title || "").toLowerCase();
  const hits = [];
  const suppressedSpans = [];
  for (const { phrase, suppresses } of EXCLUSIONS) {
    const spans = phraseSpans(t, phrase);
    if (spans.length) for (const w of suppresses) for (const span of spans) suppressedSpans.push({ word: w, span });
  }
  const isSuppressed = (word, index) =>
    suppressedSpans.some((s) => s.word === word && index >= s.span[0] && index < s.span[1]);

  // strongSports / anySports: which sports have at least one STRONG hit, and
  // which have ANY hit (strong or weak) -- a sport can appear in anySports
  // without ever entering strongSports (weak-only). authoritativeSports is a
  // further-refined subset of strongSports.
  const strongSports = new Set();
  const anySports = new Set();
  const authoritativeSports = new Set();

  for (const { sport, word, weak, authoritative, re } of COMPILED) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      if (isSuppressed(word, m.index)) continue;
      hits.push({ word, sport, weak, authoritative });
      anySports.add(sport);
      if (!weak) strongSports.add(sport);
      if (authoritative) authoritativeSports.add(sport);
      if (m[0].length === 0) re.lastIndex++; // defensive: never used (no empty-match terms), guards an infinite loop
    }
  }

  // ── FOOTBALL/SOCCER: see doc above. Only the bare literal word counts as
  // football's "only signal" -- any other NFL-gazetteer hit makes this a
  // no-op.
  const footballHits = hits.filter((h) => h.sport === "football");
  const footballOnlyBareWord = footballHits.length > 0 && footballHits.every((h) => h.word === "football");
  const hasSoccerEvidence = strongSports.has("soccer");
  if (footballOnlyBareWord && hasSoccerEvidence) {
    strongSports.delete("football");
    authoritativeSports.delete("football");
  }

  const onlyAmbiguousWords = strongSports.size === 0 && anySports.size > 0
    && [...anySports].every((s) => [...AMBIGUOUS_NICKNAMES.values()].some((leagues) => leagues.has(s)));

  return { sports: strongSports, authoritativeSports, hits, onlyAmbiguousWords };
}

/**
 * THE R76 VERDICT. Judges one sale's restore candidacy from title evidence
 * alone -- no I/O, no Cosmos, so both the restore lane and its own tests
 * call this and nothing else decides.
 *
 * @param {object} input
 * @param {string} input.title
 * @param {string} input.sportBefore    the PRE-repair sport (what the title
 *                                      is expected to back, if the flip was
 *                                      wrong)
 * @param {string} input.currentSport   the POST-repair sport (what the flip
 *                                      wrote)
 * @returns {{ verdict: "restore"|"keep"|"leave", reason: string }}
 *
 *   restore     the title's evidence SET backs sportBefore and not current --
 *               DIRECTIONAL, exactly the census's own `gaz.size > 1` branch:
 *               `sports.has(before) && !sports.has(current)`. This covers
 *               both an unambiguous single-sport hit ("Chicago Bulls" ->
 *               {basketball}) and a multi-league word whose SPAN still
 *               excludes current ("kings" -> {hockey, basketball}, when
 *               current is baseball or football -- neither league fields a
 *               Kings, so the word's ambiguity between hockey/basketball
 *               never touches the actual disagreement being judged).
 *   keep        the mirror image: sports backs current and not before --
 *               the flip was right; nothing to restore.
 *   leave       sports backs BOTH before and current ("both-named", the
 *               ambiguous word spans exactly the two sports in dispute and
 *               nothing else in the title breaks the tie), names a sport
 *               that is NEITHER before nor current ("third-sport"), or
 *               names nothing at all ("no-evidence"). A human, not this
 *               function, rules on these.
 *
 * AUTHORITATIVE-WORD DEMOTION (review HIGH 2, 2026-09-19): before comparing
 * `sports` against before/current, if EXACTLY ONE of {before, current} has
 * an authoritative hit (the sport's own name/acronym) and the OTHER's only
 * hit is a bare, non-authoritative team-nickname word (no authoritative hit
 * of its own), that other sport is dropped from the comparison set --
 * "college basketball Duke Blue Devils" carries authoritative basketball
 * evidence and only a bare, unqualified "devils" for hockey (a nickname
 * shared by pro AND non-pro teams the gazetteer cannot tell apart); the
 * authoritative hit decides. Two authoritative hits (both before and
 * current named outright) are NOT demoted -- that is a genuine
 * both-named/third-sport case, not a nickname collision.
 */
function judgeRestoreVerdict({ title, sportBefore, currentSport }) {
  const before = String(sportBefore || "").toLowerCase();
  const current = String(currentSport || "").toLowerCase();
  const { sports, authoritativeSports } = sportEvidence(title);
  const effective = new Set(sports);

  for (const [strongSide, weakSide] of [[before, current], [current, before]]) {
    if (authoritativeSports.has(strongSide) && effective.has(weakSide) && !authoritativeSports.has(weakSide)) {
      effective.delete(weakSide);
    }
  }

  const namesBefore = effective.has(before);
  const namesCurrent = effective.has(current);
  const thirdSports = [...effective].filter((s) => s !== before && s !== current);

  if (namesBefore && namesCurrent) {
    return { verdict: "leave", reason: "both-named", detail: `title evidence backs BOTH ${before} and ${current} -- cannot disambiguate` };
  }
  if (namesBefore && !namesCurrent) {
    return { verdict: "restore", reason: "title-backs-before", detail: `title evidence backs ${before} (sportBefore), not ${current} (current)` };
  }
  if (namesCurrent && !namesBefore) {
    return { verdict: "keep", reason: "title-backs-current", detail: `title evidence backs ${current} (current), not ${before} (sportBefore) -- the flip was right` };
  }
  if (thirdSports.length) {
    return { verdict: "leave", reason: "third-sport", detail: `title evidence backs ${thirdSports.join(", ")} -- neither ${before} nor ${current}` };
  }
  return { verdict: "leave", reason: "no-evidence", detail: "title names no sport the gazetteer recognises" };
}

module.exports = {
  sportEvidence, judgeRestoreVerdict,
  NHL, NBA, NFL, MLB, MLS_SOCCER, AMBIGUOUS_NICKNAMES, EXCLUSIONS,
  WEAK_WORDS, AUTHORITATIVE_WORDS,
};
