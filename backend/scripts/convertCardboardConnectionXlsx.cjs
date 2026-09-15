#!/usr/bin/env node
// CF-CARDBOARD-CONNECTION-XLSX (2026-09-14).
//
// cardboardconnection.com publishes each release's checklist as an .xlsx on S3.
// Its sheet is COLUMN-oriented and is NOT the Beckett shape:
//
//   A=Set Name  B=Card  C=Description  D=Team City  E=Team Name
//   F=Rookie    G=Auto  H=Mem          I=Serial #'d J=Odds       K=Point
//
// convertBeckettChecklistXlsx.cjs walks INLINE section headers and therefore
// misreads this layout — pointed at a cconnect sheet it emits the set name as
// `cardNumber` and the card number as `player` for every row. This converter
// exists because that silent field shift produces a well-formed WRONG file,
// and a well-formed wrong value is invisible to every sweep.
//
// WHAT IS READ VS INFERRED
//   parallel  — the rung the section name ADDS to its anchor, per the repo's
//               one-format rule. "Base Set" / a bare insert name emit BLANK
//               (blank means unknown, never "Base"). "<Anchor> <Rung> Parallel"
//               emits "<Rung>". A "- Young Guns" suffix is a SUBSET of the
//               anchor, not a rung, and is carried into `category`.
//   isAuto    — the Auto column only. Never inferred from a section name; the
//               isAuto boundary is the source's own attestation.
//   printRun  — the "Serial #'d" column only, normalised to /N. Never
//               cross-joined from a range stated elsewhere on the page — that
//               is the unfixed baseballcardpedia defect this must not repeat.
//   player    — the Description column. A Rookie flag folds into the player
//               field as the repo's CSV convention does ("Name RC").
//
// Emits the repo's standard scraped-CSV shape so the existing ingest path
// consumes it unchanged:
//   category,cardNumber,parallel,isAuto,printRun,player
//
// Usage:
//   node scripts/convertCardboardConnectionXlsx.cjs \
//     --xlsx <file.xlsx> --year 2021 --set-key upper-deck-series-1 \
//     --set-name "2021-22 Upper Deck Series 1 Hockey" --sport hockey \
//     --out data/checklists/scraped/acq-2026-09-14-cardboardconnection/x.csv \
//     --source-url "https://cconnect.s3.amazonaws.com/..." \
//     --page-url "https://www.cardboardconnection.com/..."

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const XLSX = val("--xlsx", "");
const YEAR = Number(val("--year", "0"));
const SET_KEY = val("--set-key", "");
const SET_NAME = val("--set-name", "");
const SPORT = val("--sport", "");
const OUT = val("--out", "");
const SOURCE_URL = val("--source-url", "");
const PAGE_URL = val("--page-url", "");
const SOURCE_TAG = val("--source-tag", "cardboardconnection-2026-09-14");

if (require.main === module && (!XLSX || !YEAR || !SET_KEY || !OUT || !SPORT)) {
  console.error("need --xlsx --year --set-key --set-name --sport --out");
  process.exit(2);
}

const unesc = (s) => String(s)
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&amp;/g, "&");

/** Read an xlsx into an array of {A,B,...} cell maps. Uses `unzip`, no deps. */
function readSheet(xlsxPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbcxlsx-"));
  try {
    execFileSync("unzip", ["-o", "-q", xlsxPath, "-d", tmp]);
    const ssPath = path.join(tmp, "xl", "sharedStrings.xml");
    const strs = [];
    if (fs.existsSync(ssPath)) {
      const ss = fs.readFileSync(ssPath, "utf8");
      const re = /<si>([\s\S]*?)<\/si>/g;
      let m;
      while ((m = re.exec(ss))) {
        strs.push(unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("")));
      }
    }
    // Only sheet1 — cconnect publishes a single sheet per release.
    const sheet = fs.readFileSync(path.join(tmp, "xl", "worksheets", "sheet1.xml"), "utf8");
    const rows = [];
    const rre = /<row[^>]*>([\s\S]*?)<\/row>/g;
    let r;
    while ((r = rre.exec(sheet))) {
      const cells = {};
      const cre = /<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g;
      let c;
      while ((c = cre.exec(r[1]))) {
        const isS = /t="s"/.test(c[2]);
        const isInline = /t="(inlineStr|str)"/.test(c[2]);
        let v = (c[3].match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (v === undefined && isInline) v = (c[3].match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
        if (v === undefined) continue;
        cells[c[1]] = isS ? strs[Number(v)] : unesc(v);
      }
      if (Object.keys(cells).length) rows.push(cells);
    }
    return rows;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}


/**
 * CF-A-DOUBLED-NAME-IS-A-SOURCE-TYPO (2026-09-15). cconnect prints
 * "Jaret Patterson - Jaret Patterson" in ONE cell of 2021 Donruss FB. That
 * single malformed row made seven Optic Rated Rookie Preview colours look like
 * seven different card sets: the roster-agreement gate refuses on ONE
 * disagreement and 599 of 600 agreed. The cell states one player twice, so
 * collapsing it is reading the source, not correcting it.
 */
function cleanPlayerCell(v) {
  const s = String(v == null ? "" : v).trim();
  // Split on " - " and collapse ONLY when both halves are the same name. A
  // genuine two-player card ("Brian Urlacher - Khalil Mack") is left alone.
  const halves = s.split(/\s+-\s+/);
  if (halves.length === 2 && halves[0].trim() && halves[0].trim() === halves[1].trim()) {
    return halves[0].trim();
  }
  return s;
}

const slug = (s) => String(s).toLowerCase()
  .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Split a cconnect section name into {anchor, parallel, subset}.
 *
 * THE ANCHOR IS NOT GUESSABLE FROM THE STRING, and two earlier cuts of this
 * function proved it twice over:
 *
 *   1. A regex split of "<head> <tail> Parallel" produced anchor "Honor" +
 *      rung "Roll Rainbow" for "Honor Roll Rainbow Parallel" — well-formed,
 *      confident, wrong.
 *   2. Matching against the sheet's non-"Parallel" section names still failed
 *      the sections whose WHOLE name is a rung: "French Parallel" and
 *      "Clear Cut Parallel" have no anchor token at all, so they were read as
 *      their own card sets and 300 base cards per file collided on the product
 *      key, each address answering for two or three different sections.
 *
 * So the anchor is MEASURED, not parsed. `anchorOf` is supplied by the caller
 * from the sheet's own content: a section whose (cardNumber -> player) mapping
 * reproduces another section's IS a rung of that section, and a section with
 * its own players is its own card set. That is the same test #2112's guard
 * applies — same number, different player means a different card — run at
 * acquisition time instead of at ingest time.
 *
 * A "- <Subset>" tail is a subset of the anchor and never a rung.
 * When nothing measures as the anchor, the rung is left BLANK rather than
 * invented — blank means unknown, never "Base".
 */
function splitSection(name, anchorOf = new Map()) {
  let s = String(name).trim();
  let subset = "";
  const dash = s.match(/^(.*?)\s+-\s+(.*)$/);
  if (dash) { s = dash[1].trim(); subset = dash[2].trim(); }
  const measured = anchorOf.get(String(name).trim());
  if (measured) {
    // The rung is what this section's name ADDS to its measured anchor; when
    // the name shares no prefix with it (e.g. "French Parallel" under "Base
    // Set") the whole name, minus the "Parallel" noise word, is the rung.
    const anchorName = measured.anchorSection;
    let stem = s.replace(/\s+Parallel$/, "").trim();
    let anchorStem = String(anchorName).trim();
    const aDash = anchorStem.match(/^(.*?)\s+-\s+(.*)$/);
    if (aDash) anchorStem = aDash[1].trim();
    const rung = stem.startsWith(anchorStem + " ")
      ? stem.slice(anchorStem.length).trim()
      : stem;
    return { anchor: anchorStem, parallel: rung, subset };
  }
  return { anchor: s.replace(/\s+Parallel$/, "").trim(), parallel: "", subset };
}

/**
 * The player-name form two sections are compared on. Only COSMETIC card-role
 * suffixes are dropped: cconnect writes "Nathan MacKinnon/Leon Draisaitl CL"
 * in the base print and "Nathan MacKinnon/Leon Draisaitl" in its Clear Cut
 * rung — the same card, annotated once. Nothing that could name a different
 * player is touched, so this cannot fuse two genuinely different cards.
 */
function comparablePlayer(s) {
  return String(s)
    .replace(/\s+\((?:CL|RC|SP|IA|UER)\)$/i, "")
    .replace(/\s+(?:CL|IA|UER)$/i, "")
    .trim()
    .toLowerCase();
}

/**
 * Measure which sections are rungs of which, from the sheet's own rows.
 *
 * A section is a RUNG of another when every card number it lists maps to the
 * same player the other section puts at that number, and the other section is
 * at least as large. The largest such section wins (a rung of a rung still
 * resolves to the print it parallels). Everything else is its own card set.
 *
 * The comparison runs on `comparablePlayer`, so a cosmetic "CL" annotation on
 * one side does not read as a different card — measured on 2021-22 UD Series 2,
 * where exactly 2 of 200 Clear Cut rows differ from base by that suffix alone
 * and a strict-equality rule left 290 base cards colliding on the product key.
 *
 * Returns Map<sectionName, {anchorSection}> for rungs only.
 */
function measureAnchors(sectionRows) {
  const names = [...sectionRows.keys()];
  const anchorOf = new Map();
  for (const name of names) {
    const mine = sectionRows.get(name);
    if (!mine.size) continue;
    let best = null;
    for (const other of names) {
      if (other === name) continue;
      // CF-A-RUNG-NAME-EXTENDS-ITS-ROOT (2026-09-15). A rung is its root
      // PRINTED AGAIN with a finish added, so its title must extend the root's
      // title. Roster identity alone cannot tell two sets apart when a product
      // reuses one roster across several of them.
      //
      // Measured on 2019-20 Donruss BK: "Next Day Autographs" (42),
      // "Rookie Dominator Signatures" (40) and "Rookie Jersey Kings" (40) are
      // three DIFFERENT autograph/relic sets that all print the same rookie
      // class — #1 Zion Williamson, #2 Ja Morant, #3 RJ Barrett in every one.
      // Their rosters are identical, so the test below matched and the largest
      // won: both Rookie sets were filed as rungs of "Next Day Autographs", a
      // set whose name they do not share a single word with.
      //
      // Requiring the name relationship costs nothing real — every genuine rung
      // this module folds ("Base Set" -> "French Parallel" aside, which is
      // handled by the caller's anchor map) is spelled as its root plus a
      // finish — and it is what stops a shared roster fusing distinct sets.
      // THE ONE EXCEPTION is a title that is nothing BUT a finish — the Upper
      // Deck sheet prints "French Parallel" and "Clear Cut Parallel" as whole
      // section names, with no anchor token at all. Those are still rungs of
      // the print they reproduce, and refusing them put 300 base cards per file
      // back on one address. A title ending in the word "Parallel" is that
      // shape; anything else must extend its root's name.
      const isBareFinish = /\sParallel$/i.test(name);
      if (!isBareFinish && !name.startsWith(other + " ")) continue;
      const theirs = sectionRows.get(other);
      if (theirs.size < mine.size) continue;
      let allSame = true;
      for (const [num, player] of mine) {
        const t = theirs.get(num);
        if (t === undefined || comparablePlayer(t) !== comparablePlayer(player)) { allSame = false; break; }
      }
      if (!allSame) continue;
      // Prefer the largest candidate; ties break on the shorter name, which is
      // the print the others are named after.
      if (!best || theirs.size > sectionRows.get(best).size ||
        (theirs.size === sectionRows.get(best).size && other.length < best.length)) {
        best = other;
      }
    }
    if (best) anchorOf.set(name, { anchorSection: best });
  }
  // A section that is an anchor for someone must not itself be recorded as a
  // rung of one of its own rungs (mutual-identity ties); drop such cycles.
  for (const [name, { anchorSection }] of [...anchorOf]) {
    const back = anchorOf.get(anchorSection);
    if (back && back.anchorSection === name) anchorOf.delete(name);
  }
  return anchorOf;
}

/** "200" -> "/200"; "25 (Gold)" -> "/25"; blank -> "". Never invented. */
function normPrintRun(v) {
  if (v === undefined || v === null || v === "") return "";
  const m = String(v).match(/(\d[\d,]*)/);
  if (!m) return "";
  return "/" + m[1].replace(/,/g, "");
}

function convert(xlsxPath) {
  const rows = readSheet(xlsxPath);
  if (!rows.length) throw new Error("no rows in sheet");
  // Header row maps column letter -> header name.
  const hdr = rows[0];
  const colOf = {};
  for (const [k, v] of Object.entries(hdr)) colOf[String(v).trim().toLowerCase()] = k;
  // TWO LAYOUTS, BOTH FROM cardboardconnection.
  //
  //   UD-style      Set Name | Card | Description | Team City | Team Name |
  //                 Rookie | Auto | Mem | Serial #'d | Odds | Point
  //   Panini-style  Card Set | Number | Player | Team | Seq.
  //
  // The Panini sheet has NO Auto column and NO "Parallel" suffix on its
  // section names; its Seq. column IS a print run (verified: constant within
  // every one of the 179 sections that carry it, e.g. Black=/1, Gold=/10 —
  // a single sampled "1" looked like a row index until the distribution was
  // checked). isAuto is therefore read from the SECTION NAME on this layout
  // and nowhere else, which is the source's own attestation for a sheet that
  // states autographs as named sections ("Rookie Phenom Jersey Autographs").
  const C = {
    set: colOf["set name"] || colOf["card set"],
    card: colOf["card"] || colOf["number"],
    desc: colOf["description"] || colOf["player"],
    rookie: colOf["rookie"],
    auto: colOf["auto"],
    mem: colOf["mem"],
    serial: colOf["serial #'d"] || colOf["serial #d"] || colOf["serial #"] || colOf["seq."] || colOf["seq"],
  };
  const LAYOUT = colOf["card set"] ? "panini" : "ud";
  if (!C.set || !C.card || !C.desc) {
    throw new Error("unexpected header: " + JSON.stringify(hdr));
  }
  // Pass 1: each section's (cardNumber -> player) mapping, so rungs can be
  // MEASURED against the print they parallel rather than parsed out of a name.
  const sectionRows = new Map();
  for (const r of rows.slice(1)) {
    const s = String(r[C.set] || "").trim();
    const num = String(r[C.card] || "").trim();
    const player = cleanPlayerCell(r[C.desc]);
    if (!s || !num || !player) continue;
    if (!sectionRows.has(s)) sectionRows.set(s, new Map());
    sectionRows.get(s).set(num, player);
  }
  // CF-A-PLURAL-TWIN-IS-THE-SAME-SECTION (2026-09-15). cconnect prints both
  // "Jersey Kings" and "Jerseys Kings Prime" in 2020-21 Donruss BK. The plural
  // is a source typo, not a second card set: folding it onto the singular keeps
  // "Prime" a PARALLEL of the registered `panini-donruss-jersey-kings` insert
  // instead of minting `...-jerseys-kings-prime`, a key that would say a
  // parallel is a set. Applied ONLY where the singular form is itself a section
  // in this sheet, so nothing is invented.
  const pluralTwins = new Map();
  {
    const singularOf = (t) => t.replace(/(\w+?)s(\s)/g, "$1$2");
    for (const t of [...sectionRows.keys()]) {
      const sing = singularOf(t);
      if (sing === t || !sectionRows.has(sing)) continue;
      const src = sectionRows.get(t), dst = sectionRows.get(sing);
      for (const [n, pl] of src) if (!dst.has(n)) dst.set(n, pl);
      pluralTwins.set(t, sing);
    }
  }

  let anchors = measureAnchors(sectionRows);
  const blockedSections = [];
  if (LAYOUT === "panini") {
    // R37 (Drew, 2026-09-14): on a sheet with no Parallel marker, the parallel
    // is what the section title adds beyond the SHORTEST matching base anchor.
    // An anchor is a section title that is not itself an extension of another
    // title. A section that matches NO anchor is not guessed — it is BLOCKED
    // and listed by title in the manifest.
    const titles = [...sectionRows.keys()];
    let baseAnchors = titles.filter((t) => !titles.some((p) => p !== t && t.startsWith(p + " ")));

    // CF-A-SUBSET-IS-NOT-A-RUNG (R37 follow-up, 2026-09-15).
    //
    // The shortest-anchor rule alone EXPLODED the two Mosaic files: the ingest
    // refused them with 175 and 224 distinct parallels in one `base` category,
    // against a real Mosaic ladder of about 29 rungs.
    //
    // The cause: Panini prints its base SUBSETS as section titles that extend
    // the base title — "Base Hall of Fame Mosaic Black". The shortest anchor is
    // "Base", so everything after it became the parallel and the SUBSET rode
    // into the rung name. Six subsets x ~29 real rungs = ~175 phantom rungs,
    // each a cross-join of a section name with a colour.
    //
    // A SUBSET IS TOLD APART FROM A RUNG BY ITS CARD NUMBERS, not by its name.
    // A rung REPRINTS its anchor's numbers; a subset occupies its OWN range.
    // Measured on 2019-20 Mosaic: base 1-200, Rookies 201-250, USA 251-260,
    // NBA 261-280, Hall of Fame 281-295, MVPs 296-300 — disjoint, so these are
    // six sections of one 300-card base set, and the colour that follows is
    // the rung they share.
    //
    // So a title whose numbers are DISJOINT from its candidate anchor's is
    // promoted to an anchor in its own right. It then becomes the anchor its
    // own colour rungs measure against, and the ladder collapses back to the
    // real ~29.
    const numsOf = (t) => new Set(sectionRows.get(t).keys());
    const disjoint = (a, b) => { for (const n of a) if (b.has(n)) return false; return true; };
    for (let pass = 0; pass < 4; pass++) {
      let grew = false;
      for (const t of titles) {
        if (baseAnchors.includes(t)) continue;
        const cands = baseAnchors.filter((a) => t.startsWith(a + " "));
        if (!cands.length) continue;
        cands.sort((a, b) => a.length - b.length || a.localeCompare(b));
        const anchor = cands[cands.length - 1]; // the longest, i.e. nearest
        if (disjoint(numsOf(t), numsOf(anchor))) { baseAnchors.push(t); grew = true; }
      }
      if (!grew) break;
    }
    baseAnchors = [...new Set(baseAnchors)];

    anchors = new Map();
    // CF-A-COLOUR-SIBLING-SET-NAMES-ITSELF-BY-ITS-PREFIX (2026-09-15).
    //
    // A product can publish an insert with NO uncoloured tier: 2021 Donruss FB
    // prints "Optic Rated Rookie Preview Blue/Gold/Green/Holo/Pink/Purple/Red"
    // and no plain "Optic Rated Rookie Preview". Every colour then extends
    // nothing, so each became an anchor — and the CATEGORY is the setKey
    // segment, so `optic-rated-rookie-preview-gold` would MINT A PARALLEL AS A
    // CARD SET and give 100 rows a wrong identity.
    //
    // The siblings themselves name the set: they share a prefix, they REPRINT
    // ONE ROSTER (same number -> same player, which is what makes them one
    // checklist printed several ways), and what they differ by is the rung.
    // Reading that shared prefix is not inventing a name — refusing to read it
    // is what splits one card set seven ways. Same evidence the module's own
    // derived-root rule takes for Spectra's fourteen "Dual Patch Autographs
    // <colour>" files.
    //
    // A TIE IS NOT RESOLVED HERE. The prefix must be shared by >= 2 siblings
    // and their rosters must agree with ZERO disagreements; one disagreement
    // means these are different cards and each keeps its own key.
    {
      const bySharedPrefix = new Map();
      for (const t of baseAnchors) {
        const segs = t.split(" ");
        for (let n = 1; n < segs.length; n++) {
          const pre = segs.slice(0, n).join(" ");
          if (!bySharedPrefix.has(pre)) bySharedPrefix.set(pre, []);
          bySharedPrefix.get(pre).push(t);
        }
      }
      // Widest first: with seven colours, "Optic Rated Rookie Preview" is
      // shared by all seven while "Optic Rated Rookie" is shared by the same
      // seven — prefer the LONGEST among equally-wide, which is the full set
      // name rather than a fragment of it.
      const ranked = [...bySharedPrefix.keys()].sort((a, b) =>
        bySharedPrefix.get(b).length - bySharedPrefix.get(a).length || b.length - a.length);
      const claimed = new Set();
      for (const pre of ranked) {
        const sibs = bySharedPrefix.get(pre).filter((t) => !claimed.has(t));
        if (sibs.length < 2) continue;
        if (titles.includes(pre)) continue; // a real section already names it
        // One roster, printed several ways: zero disagreements required.
        const merged = new Map();
        let differ = 0, agreed = 0;
        for (const s of sibs) {
          for (const [num, player] of sectionRows.get(s)) {
            const held = merged.get(num);
            if (held === undefined) merged.set(num, player);
            else if (held === player) agreed++;
            else differ++;
          }
        }
        if (differ > 0 || agreed === 0) continue;
        // And the tails must differ, or there is no rung to move.
        const tails = new Set(sibs.map((s) => s.slice(pre.length + 1)));
        if (tails.size < 2) continue;
        // SCOPED TO THE SHAPE THIS RULE WAS VERIFIED ON, AND NO WIDER.
        //
        // Roster agreement alone is far too weak a licence to invent a root.
        // "Rookie Dominator Signatures" and "Rookie Jersey Kings" share their
        // first word and agree 40/40 — they are the same rookie class — yet
        // one is entirely signed and the other entirely not, so they are two
        // card sets whose names merely start alike. An earlier cut of this
        // rule folded them onto a `rookie` root the source never prints and
        // scattered their colour rungs onto an unrelated set. That is the same
        // failure CF-A-DERIVED-ROOT-IS-NEVER-A-SHARED-FIRST-WORD names.
        //
        // So the rule is held to the Optic Rated Rookie Preview shape it was
        // measured against, and the general case is left to a follow-up that
        // can trace the anchor map properly:
        //
        //   - the shared prefix is at least THREE words, so a single leading
        //     word like "Rookie" can never become a card set;
        //   - every tail is ONE word, so a tail that is itself a set name
        //     ("Dominator Signatures", "Jersey Kings") disqualifies the group;
        //   - every sibling shares the same signing status, because a rung
        //     reprints its root and autograph status is not a parallel.
        //
        // Absent beats wrong: a group that fails any of these keeps its
        // sections on their own full-name keys, which is what the source says.
        if (pre.trim().split(/\s+/).length < 3) continue;
        if ([...tails].some((t) => t.trim().split(/\s+/).length !== 1)) continue;
        const signing = new Set();
        for (const s of sibs) {
          for (const r2 of rows.slice(1)) {
            if (String(r2[C.set] || "").trim() !== s) continue;
            signing.add(Boolean(C.auto) && String(r2[C.auto] || "").trim() !== "");
          }
        }
        if (signing.size > 1) continue;
        sectionRows.set(pre, merged);
        for (const s of sibs) {
          anchors.set(s, { anchorSection: pre });
          claimed.add(s);
          baseAnchors = baseAnchors.filter((x) => x !== s);
        }
        baseAnchors.push(pre);
        claimed.add(pre);
      }
    }

    for (const t of titles) {
      if (baseAnchors.includes(t)) continue;
      // A colour sibling has already been resolved against the prefix its own
      // siblings name; the generic rule below must not re-root it on something
      // shorter.
      if (anchors.has(t)) continue;
      const cands = baseAnchors.filter((a) => t.startsWith(a + " "));
      if (!cands.length) { blockedSections.push(t); continue; }
      // SHORTEST matching anchor, per the ruling — but only among anchors whose
      // numbers this title actually REPRINTS. A rung reprints its anchor; an
      // anchor whose numbers are disjoint cannot explain this title's cards.
      const mine = numsOf(t);
      const sharing = cands.filter((a) => !disjoint(mine, numsOf(a)));
      const pick = (sharing.length ? sharing : cands).sort((a, b) => a.length - b.length || a.localeCompare(b));
      anchors.set(t, { anchorSection: pick[0] });
    }

    // A RUNG IS NEVER SOMEONE ELSE'S ROOT.
    //
    // 2021 Donruss FB prints seven "Optic Rated Rookie Preview <colour>"
    // sections and an eighth, "Optic Rated Rookie Preview Red and Green".
    // That eighth title genuinely extends the name of the "... Red" section
    // and reprints its roster exactly, so measureAnchors filed it as a rung of
    // Red — correctly, on the evidence it had, because at that point Red is
    // still a section in its own right.
    //
    // The colour-sibling rule then folds Red itself onto "Optic Rated Rookie
    // Preview". Red is now a rung, not a root, and the stale pointer minted
    // `optic-rated-rookie-preview-red` as a CARD SET carrying the nonsense
    // rung "and Green" — the very defect CF-A-COLOUR-SIBLING names, arriving
    // by a second route.
    //
    // Anchors are only final here, after every fold has been applied, so this
    // is where the chains get walked: follow each pointer up to the section
    // that is nobody's rung. That section is what the source prints as the set.
    for (const [name, rec] of [...anchors]) {
      const seen = new Set([name]);
      let root = rec.anchorSection;
      while (anchors.has(root) && !seen.has(root)) {
        seen.add(root);
        root = anchors.get(root).anchorSection;
      }
      if (root !== rec.anchorSection) anchors.set(name, { anchorSection: root });
    }
  }

  const out = [];
  const sections = new Map();
  let signed = 0;
  let printRuns = 0;
  for (const r of rows.slice(1)) {
    const setName = String(r[C.set] || "").trim();
    const num = String(r[C.card] || "").trim();
    const player = cleanPlayerCell(r[C.desc]);
    if (!setName || !num || !player) continue;
    if (blockedSections.includes(setName)) continue;
    const canonical = pluralTwins.get(setName) || setName;
    const { anchor, parallel, subset } = splitSection(canonical, anchors);
    const category = subset ? `${slug(anchor)}--${slug(subset)}` : slug(anchor);
    const isAuto = LAYOUT === "panini"
      ? /(?:^|[^a-z])(?:auto|autograph|autographs|signature|signatures|ink|scripts|penmanship)(?:[^a-z]|$)/i.test(setName)
      : (Boolean(C.auto) && String(r[C.auto] || "").trim() !== "");
    const printRun = C.serial ? normPrintRun(r[C.serial]) : "";
    const rookie = Boolean(C.rookie) && String(r[C.rookie] || "").trim() !== "";
    if (isAuto) signed++;
    if (printRun) printRuns++;
    if (!sections.has(setName)) {
      sections.set(setName, { section: setName, category, parallel, cards: 0, auto: 0, printRun: 0 });
    }
    const s = sections.get(setName);
    s.cards++;
    if (isAuto) s.auto++;
    if (printRun) s.printRun++;
    out.push({
      category,
      cardNumber: num,
      parallel,
      isAuto: isAuto ? "true" : "false",
      printRun,
      player: rookie && !/\bRC\b/.test(player) ? `${player} RC` : player,
    });
  }
  return { rows: out, sections: [...sections.values()], signed, printRuns, blockedSections, layout: LAYOUT };
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

if (require.main === module) {
  const { rows, sections, signed, printRuns, blockedSections, layout } = convert(XLSX);
  const header = "category,cardNumber,parallel,isAuto,printRun,player";
  const body = rows.map((r) =>
    [r.category, r.cardNumber, r.parallel, r.isAuto, r.printRun, r.player].map(csvCell).join(",")
  );
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, header + "\n" + body.join("\n") + "\n");

  const distinctParallels = new Set(rows.map((r) => r.parallel).filter(Boolean));
  const manifest = {
    source: SOURCE_TAG,
    sourceUrl: PAGE_URL || SOURCE_URL,
    xlsxUrl: SOURCE_URL,
    fetchedAt: "2026-09-14",
    sport: SPORT,
    year: YEAR,
    setName: SET_NAME,
    productKey: path.basename(OUT).replace(/\.csv$/, ""),
    setKey: SET_KEY,
    rowCount: rows.length,
    autoCount: signed,
    printRunCount: printRuns,
    distinctParallels: distinctParallels.size,
    parallelColumnAuthoritative: true,
    layout,
    rungRule: layout === "panini"
      ? "R37 (Drew 2026-09-14): parallel = what the section title adds beyond the SHORTEST matching base anchor; a section matching no anchor is BLOCKED, never guessed."
      : "measured: a section whose (cardNumber -> player) mapping reproduces another section's is a rung of it.",
    sectionsBlocked: blockedSections.length,
    blockedSectionTitles: blockedSections,
    parallelVocabulary: [...distinctParallels].sort(),
    sectionsReport: sections.map((s) => ({
      section: s.section,
      category: s.category,
      parallel: s.parallel,
      cards: s.cards,
      auto: s.auto,
      printRun: s.printRun,
    })),
  };
  fs.writeFileSync(OUT.replace(/\.csv$/, ".manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${OUT}`);
  console.log(`  rows=${rows.length}  signed=${signed}  printRuns=${printRuns}  sections=${sections.length}  parallels=${distinctParallels.size}  layout=${layout}  BLOCKED sections=${blockedSections.length}`);
  for (const b of blockedSections.slice(0, 10)) console.log(`     BLOCKED: ${b}`);
}

module.exports = { convert, splitSection, measureAnchors, comparablePlayer, normPrintRun };
