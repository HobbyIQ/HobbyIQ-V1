/**
 * CF-SET-SPORT-AUTHORITY (Drew, 2026-08-20) — ONE declaration of "what sport is
 * this set, and may it overrule a comp's slug?", shared by the audit that
 * measures the repair and the script that applies it.
 *
 * They MUST NOT each carry their own copy. That exact split — one rule, two
 * implementations, differences nobody chose — is what produced the setKey
 * fragmentation we spent 2026-08-20 merging, and what let five copies of
 * "is this a checklist source" drift far enough to flip 51 card-number prefixes
 * between "repair" and "blocked". An audit that measures with different gates
 * than the repair applies is not an audit of that repair.
 *
 * ── WHY THE GATES ARE SHAPED THIS WAY ───────────────────────────────────────
 *
 * The first version of this logic reported 8.69% contamination (1,243,562
 * comps) and its two largest moves were BACKWARDS. It ranked only
 * checklist-backed rows and required 0.95 dominance — but dominance over a
 * single-sport sample is always 1.0:
 *
 *   2024 panini-donruss
 *     ALL rows       baseball 5,503   football 19,130   basketball 4,031
 *     CHECKLIST rows football 3,993   ONLY
 *     -> dominance 1.0000, authority "football", gate PASSES
 *
 * We simply have no checklist for Donruss BASEBALL 2024; the product plainly
 * exists. Absence of checklist COVERAGE was read as absence of the PRODUCT.
 *
 * So the two questions are separated, because they need different evidence:
 *
 *   IS THIS SET MULTI-SPORT?  asked of ALL catalog rows. A vendor row is weak
 *     evidence of what a card IS, but perfectly good evidence that the product
 *     EXISTS in that sport.
 *
 *   IF SINGLE-SPORT, WHICH?   asked of checklist rows only.
 *
 * MIN_OTHER is ABSOLUTE, not a ratio: 4% of a large set is thousands of real
 * cards, and a ratio gate lets them through.
 *
 * ── R76 (Drew, 2026-09-19): THE VETO WAS FIVE SUBSTRING WORDS ───────────────
 *
 * From 2026-08-20 to 2026-09-19 the title veto below tested only whether the
 * title contained the LITERAL STRING "baseball" / "football" / "basketball" /
 * "hockey" / "soccer" (SPORT_WORDS, kept below for the record and for any
 * caller still reading it directly). A title almost never spells its own
 * sport that way -- it names a TEAM ("Chicago Bulls"), a LEAGUE ("NBA"), or a
 * position ("point guard") -- so this veto fired on roughly 11% of titles and
 * NEVER on the other 89%, including every one of the 183,248 comps this
 * repair moved. A read-only census then judged 69,598 of those moves WRONG:
 * the title named the pre-repair sport's team/league and the veto never saw
 * it, because none of those titles contain the word "basketball" itself.
 *
 * The veto now asks `sportEvidence` (sport-title-evidence.cjs) the SAME
 * question with a real gazetteer -- word-boundary matched team/league/
 * position evidence, not five substring nouns -- and is the SAME module the
 * restore lane (revert-set-sport-repair.cjs) uses to judge which of the
 * 69,598 wrongly-flipped comps to put back. One rule, two call sites, so this
 * file's veto and the restore lane's verdict can never drift the way the
 * five-word list and the census's own gazetteer already drifted once.
 */

/** Absolute count of catalog rows in OTHER sports that makes a setKey a
 *  cross-sport franchise and therefore unable to adjudicate. */
const MIN_OTHER = 200;
const MIN_CHECKLIST = 20;
const DOMINANCE = 0.95;

/** Retained for any caller that still reads it directly (e.g. a report that
 *  quotes "the veto used to test these five words"). `judgeComp` itself no
 *  longer reads this -- see the R76 note above. */
const SPORT_WORDS = ["baseball", "football", "basketball", "hockey", "soccer"];

const { sportEvidence } = require("./sport-title-evidence.cjs");

/**
 * Build the (year, setKey) -> sport authority map.
 *
 * @param {Map<string, Map<string, number>>} checklistCounts  key -> sport -> n, CHECKLIST rows only
 * @param {Map<string, Map<string, number>>} allCounts        key -> sport -> n, ALL rows
 */
function buildAuthority(checklistCounts, allCounts, opts = {}) {
  const minOther = opts.minOther ?? MIN_OTHER;
  const minChecklist = opts.minChecklist ?? MIN_CHECKLIST;
  const dominance = opts.dominance ?? DOMINANCE;

  const authority = new Map();
  const skipped = { mixed: 0, crossSport: 0, thin: 0 };
  const examples = [];

  for (const [k, m] of checklistCounts) {
    const total = [...m.values()].reduce((s, n) => s + n, 0);
    if (total < minChecklist) { skipped.thin++; continue; }
    const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked[0][1] / total < dominance) {
      skipped.mixed++;
      if (examples.length < 12) examples.push(`${k}  MIXED  ${ranked.slice(0, 3).map(([s, n]) => `${s}:${n}`).join(" ")}`);
      continue;
    }
    const all = allCounts.get(k);
    const other = all
      ? [...all.entries()].filter(([s]) => s !== ranked[0][0]).reduce((n, [, c]) => n + c, 0)
      : 0;
    if (other >= minOther) {
      skipped.crossSport++;
      if (examples.length < 12) {
        const top = [...all.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, n]) => `${s}:${n}`).join(" ");
        examples.push(`${k}  CROSS-SPORT  checklist=${ranked[0][0]}:${ranked[0][1]}  allRows= ${top}`);
      }
      continue;
    }
    authority.set(k, ranked[0][0]);
  }
  return { authority, skipped, examples };
}

/**
 * Decide one comp. Returns a verdict rather than a boolean so both callers
 * report the same categories.
 *
 * THE TITLE VETO is the reason this returns "vetoed" instead of just false. A
 * title that NAMES a sport is direct evidence about THIS card; the set-level
 * verdict is only a prior about its neighbours. When they disagree the card
 * wins — that is the pair the first version measured wrong: 4,000 comps slugged
 * hiq:baseball:2024:panini-donruss carried baseball 424, soccer 32, football 0
 * while the set-level rule wanted every one moved to football.
 *
 * R76: the veto now reads `sportEvidence(title).sports` -- a gazetteer of
 * teams, leagues and positions, word-boundary matched -- in place of the
 * five literal SPORT_WORDS substrings. It is still high-precision and
 * low-recall by construction (most titles name no team or league at all),
 * so it can STOP a repair but must never drive one. That asymmetry is
 * unchanged; only what counts as "the title names a sport" has grown a real
 * vocabulary. `sports.size > 1` (an ambiguous multi-league word, or a title
 * that genuinely names two sports) is treated the same as "no single verdict
 * to veto with" -- the repair proceeds on the set-level authority, exactly
 * as it did when SPORT_WORDS found zero or two-plus hits.
 */
function judgeComp({ slugSport, year, setKey, title }, authority) {
  const truth = authority.get(`${year}|${setKey}`);
  if (!truth) return { verdict: "no-authority" };
  if (truth === slugSport) return { verdict: "agree" };

  const { sports } = sportEvidence(title);
  if (sports.size === 1) {
    const named = [...sports][0];
    if (named === slugSport) return { verdict: "vetoed-title-backs-slug" };
    if (named !== truth) return { verdict: "vetoed-title-backs-neither", named };
  }
  return { verdict: "contradict", from: slugSport, to: truth };
}

module.exports = { buildAuthority, judgeComp, SPORT_WORDS, MIN_OTHER, MIN_CHECKLIST, DOMINANCE };
