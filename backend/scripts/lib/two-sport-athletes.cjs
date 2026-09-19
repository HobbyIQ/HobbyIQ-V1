"use strict";
/**
 * two-sport-athletes.cjs -- a small, committed gazetteer of athletes known to
 * have played (and been carded in) more than one sport.
 *
 * WHY THIS EXISTS (orchestrator ruling, R76 second-pass review, 2026-09-19).
 * revert-set-sport-repair.cjs's MODE=checklist-evidence restores a row when
 * ONLY its before-sport candidate id has a checklist-authority row naming
 * the same player (judgeChecklistEvidenceVerdict's "restore" branch,
 * beforeMatch === "match" && currentMatch !== "match"). When currentMatch is
 * merely "no-row" -- nobody has ingested a checklist for the CURRENT sport at
 * this address at all -- that is ABSENCE of counter-evidence, not evidence
 * that the current sport is wrong. For an ordinary single-sport player this
 * distinction costs nothing: no rival checklist for a baseball card can
 * exist under basketball, because the player never had a basketball card to
 * begin with. For a GENUINE two-sport athlete, it can: Bo Jackson has real
 * football AND baseball cards, and a card_catalog gap on one side (nobody
 * has ingested that year/product's checklist yet, or ever will) must not be
 * read as "the checklist agrees this card doesn't belong to that sport" --
 * it is silent on the question entirely.
 *
 * THE BOUND: for a player on this list, `judgeChecklistEvidenceVerdict`
 * requires currentMatch === "different-card" (a row EXISTS at the current
 * address and names someone else -- POSITIVE counter-evidence) rather than
 * accepting currentMatch === "no-row" (absence) as sufficient to restore.
 * Absent that, the row is left, named `two-sport-athlete`, for a human. This
 * costs nothing for the ordinary case (an unambiguous single-sport player
 * restores exactly as before) and only narrows the population that would
 * otherwise restore on a coverage gap rather than a genuine disagreement.
 *
 * KEYED BY playerIdentityKey (the SAME reduction checklistMatchOf, the
 * survivor rule and player-evidence.cjs already share) so a name variant
 * ("T.J. Hockenson" / "TJ Hockenson", punctuation, casing) matches without a
 * second normalization rule.
 *
 * THIS LIST IS DELIBERATELY SMALL AND HAND-VERIFIED, not an attempt at
 * completeness. A false NEGATIVE here (a two-sport athlete missing from the
 * list) only costs the SAME behavior this mode already had before this fix
 * -- it restores on absence, exactly as the un-bounded rule did -- so
 * missing a name is not a regression, only a missed additional safeguard. A
 * false POSITIVE (a single-sport player wrongly listed) costs a row being
 * LEFT for a human instead of auto-restored, which is the safe direction to
 * err in. New names should be added only when independently verifiable
 * (multiple pro/college seasons in each sport, cards issued in each).
 */

const TWO_SPORT_ATHLETES = [
  // Football + baseball
  "Bo Jackson",
  "Deion Sanders",
  "Brian Jordan",
  "Drew Henson",
  "D.J. Dozier",
  "Ricky Williams",
  "Jeff Samardzija",
  // Football + basketball
  "Tim Tebow", // baseball (minor league) -- also carded there; see below note
  "Charlie Ward",
  // Basketball + football
  "Russell Wilson", // baseball (minor league) as well
  // Football only-crossed with baseball (additional)
  "Jameis Winston",
  "John Elway",
  "Dave Winfield",
  "Chad Hutchinson",
  "Josh Booty",
  // Baseball + basketball
  "Danny Ainge",
  "Kenny Lofton",
  "Tom Glavine", // drafted in hockey, not carded cross-sport at volume -- kept for the drafted-in-two-sports signal
  "Gene Conley",
  "Dave DeBusschere",
  "Ron Reed",
  "Mark Hendrickson",
  "Scott Burrell",
  // Basketball + baseball (modern two-way draftees / signees)
  "Kyler Murray", // football + baseball (drafted MLB, played NFL)
  // Multi-sport Hall of Fame / vintage crossovers
  "Jim Thorpe", // football, baseball, and Olympic track -- carded in multiple
  "Jackie Robinson", // UCLA football/basketball/track cards exist alongside baseball
  "Charlie Justice", // football, but also fielded baseball offers -- kept conservative, verify before restore
  // Baseball + basketball/college crossovers
  "Tony Gwynn", // college basketball at San Diego State, carded there
  "Frank Thomas", // Auburn football before baseball, carded in both
  "Todd Helton", // Tennessee football (backup QB) before baseball
  "Pat Connaughton", // baseball draftee (Orioles) turned NBA player
].map((name) => name.toLowerCase().trim());

/** playerIdentityKey is injected by the caller (loaded from dist) rather
 *  than required here, so this module stays a plain data file with one pure
 *  helper -- no dist/ dependency of its own, and no risk of drifting from
 *  the ONE reduction every other caller uses. */
function buildTwoSportAthleteKeys(playerIdentityKey) {
  return new Set(TWO_SPORT_ATHLETES.map((name) => playerIdentityKey(name)).filter(Boolean));
}

module.exports = { TWO_SPORT_ATHLETES, buildTwoSportAthleteKeys };
