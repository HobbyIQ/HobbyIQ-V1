// Is this catalog row the same PLAYER as this sale?
//
// One definition, shared, because two copies of this list drifted apart within
// an hour of each other and the second copy silently rejected 828 sales the
// first would have moved.
//
// WHY IT IS NOT JUST STRING EQUALITY. A playerName field carries designations
// that describe the CARD, not the person:
//
//   "Darryl Strawberry XRC"   extended rookie card
//   "Larry Bowa MGR"          manager card
//   "Todd Greene USA"         Team USA
//   "Pete Rose MGR"
//
// Raw comparison called those different people and rejected 12,870 of 20,678
// sales in one sweep.
//
// WHY IT IS NOT FUZZY EITHER. The guard has to keep catching real mismatches —
// it found a sale labelled Doug Jones pointing at 1989 Topps #6, which is Pedro
// Guerrero. Loosening to substring or edit-distance matching would wave that
// through, and the whole point of the check is that base sets and their Traded
// or Tiffany counterparts both number from 1, so the same number is routinely a
// different player.
//
// "jr" AND "sr" ARE DELIBERATELY ABSENT from the strip list. Ken Griffey and
// Ken Griffey Jr are two players. Collapsing them would file a father's cards
// into his son's pool, which is a worse error than leaving a few rows unmoved.
const DESIGNATION = new Set([
  // card-status
  "xrc", "rc", "rookie", "rookies", "prospect", "prospects", "draft", "pick", "picks",
  // honours / roles printed on the card
  "hof", "mgr", "mg", "manager", "coach", "usa", "team",
  // subset labels
  "tc", "cl", "checklist", "ldr", "ldrs", "leaders", "rb", "hl", "highlight",
  "highlights", "star", "allstar", "as", "fs", "future",
  // print variations
  "sp", "ssp", "err", "cor", "uer", "var", "variation",
]);

/** Normalised form for comparison: ASCII-folded, designations removed.
 *
 *  FOLDING HAS TO HAPPEN BEFORE THE SPLIT. Splitting on [^a-z] first tears an
 *  accented name in half instead of folding it — "Luis Peña" became
 *  luis + pe + a while the sale's "Luis Pena" stayed luispena, so the two never
 *  matched and 576 sapphire sales were refused as different people. Same
 *  mistake would silently under-move every Peña, Acuña, Suárez and Jiménez in
 *  the pool, and it did on the Tiffany and Topps Traded sweeps before this.
 *
 *  NFKD splits "ñ" into "n" + a combining tilde; stripping the combining marks
 *  leaves plain "n". Mirrors fold() in catalogSearch.service. */
function normPlayerName(s) {
  return String(s === null || s === undefined ? "" : s)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t && !DESIGNATION.has(t))
    .join("");
}

/** True only when both sides name the same person. Empty on either side is
 *  NOT a match — unverifiable must never read as verified. */
function samePlayer(a, b) {
  const x = normPlayerName(a);
  const y = normPlayerName(b);
  return Boolean(x) && Boolean(y) && x === y;
}

module.exports = { DESIGNATION, normPlayerName, samePlayer };
