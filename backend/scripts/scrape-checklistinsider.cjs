#!/usr/bin/env node
/**
 * CF-CHECKLISTINSIDER (Drew, 2026-08-20: "lets get to work on the checklist").
 *
 * Harvests set checklists from checklistinsider.com into a staging file.
 * WRITES NOTHING TO COSMOS.
 *
 * TWO SOURCES PER PRODUCT, because neither is sufficient alone:
 *
 *   the .xlsx download   full card checklist - cardNumber, player, team, subset
 *   the HTML page        the PARALLEL LADDER, which carries the PRINT RUNS
 *
 * The workbook does not list parallels and the page does not list every card, so
 * both are fetched and staged together.
 *
 * WHY PRINT RUNS ARE THE POINT. They are the one field we cannot reconstruct
 * from anywhere else, and every attempt to read them out of seller titles bred a
 * new defect class - `2024` parsed as a print run 1,666 times, `PSA 9/10` read as
 * a serial, a $5,449 card landing in a /9 pool. A checklist states the ladder
 * outright, making those bugs structurally impossible rather than guarded.
 *
 * The alternatives were checked and rejected on 2026-08-20:
 *   cardboardconnection.com   DNS-dead (search engines still serve its cache)
 *   groupbreakchecklists.com  dead
 *   topps.com / Blowout PDFs  403 behind bot protection
 *   cardboardchecklist MCP    free and structured, but NO print runs at all
 *
 * THE WORKBOOK IS PARSED BY THE EXISTING CARDBOARD CONNECTION PARSER, not by
 * anything written here. Its documented layout - "a single-sheet stream with
 * section headers followed by card rows" - is exactly what checklistinsider
 * ships, and it returned 1,542 cards with ZERO diagnostics on the first product
 * tried. Writing a third checklist parser would repeat the
 * one-rule-two-implementations split that caused the setKey fragmentation we
 * spent this morning merging. It also revives a module that has had no live
 * source since Cardboard Connection went dark.
 *
 * THE LADDER IS FOUND BY DOCUMENT STRUCTURE, NOT BY LINE SHAPE. Matching lines
 * that merely look like "name /number" failed twice, because a checklist row
 * reads the same way:
 *
 *   "Base - 17 Trae Young /99"                  a CARD, not a parallel
 *   "Canvas Creations - Kurt Warner /25"        a CARD, no number to key on
 *   "SS-AM Auston Matthews - Toronto ... /25"   a CARD, number at the FRONT
 *
 * 2023-24 National Treasures produced 1,494 such false parallels against a real
 * ladder of about seven. The page instead marks the ladder explicitly, and only
 * that markup is trusted:
 *
 *   <p><strong>2023 Panini Spectra Football Base Parallel List</strong></p>
 *   <ul><li>Silver</li><li>Celestial - /99</li><li>Hyper - /75</li>...
 *
 * A product with no such heading has NO parallel ladder here, and reports zero.
 * That is the correct answer for Impeccable and Engrained, whose "parallels"
 * under the old line-shape parse were entirely checklist rows.
 *
 * QUALITY IS RECORDED, NOT ASSUMED. Parser diagnostics and a stub flag are
 * staged per product so a later gap report can distinguish "no checklist
 * published" from "we never looked" from "we looked and could not read it".
 *
 * STAGING ONLY. Output is JSONL for review before any ingest. Nothing here is
 * authoritative until a human has read a sample - a scraper that wrote straight
 * into the catalog would be another self-confirming source, which is the defect
 * this whole effort exists to remove.
 *
 * Usage:
 *   node backend/scripts/scrape-checklistinsider.cjs \
 *     [--sport=baseball] [--year=2026] [--limit=N] [--delayMs=1500]
 *     [--out=C:/tmp/ci-staging.jsonl]
 */

const fs = require("fs");
const path = require("path");
const backend = path.join(__dirname, "..");
const XLSX = require(path.join(backend, "node_modules/xlsx"));
const { parseCardboardConnectionChecklist } = require(path.join(backend, "dist/agents/cardboardConnection/cardboardConnectionParser.js"));

/**
 * TWO WORKBOOK LAYOUTS SHIP UNDER THE SAME "Download the Excel" LINK, and they
 * need different readers:
 *
 *   TABULAR (Panini)   a real header row, one card per row
 *       CARD SET | CARD # | ATHLETE | TEAM | SEQ
 *       Base Amethyst Spotlight | 1 | Kyler Murray | Arizona Cardinals | 25
 *
 *   STREAM (Topps)     section headings interleaved with card rows
 *       BASE
 *       1 | Aaron Judge | New York Yankees
 *
 * SEQ IS THE PRIZE. It is the print run, stated per card, and it is populated on
 * 92.8% of rows in the first Panini workbook measured - 3,856 (parallel, card,
 * printRun) tuples from ONE product. That is card-level precision the HTML
 * ladder cannot reach, since the ladder names a parallel but cannot say which
 * cards in it are serialised differently.
 *
 * Feeding a tabular sheet to the stream reader does not fail loudly - it
 * mis-assigns columns, which is worse. Zenith parsed as cardNumber="Z-Graphs",
 * player="2", team="Jamal Anderson" before this split existed. So the layout is
 * DETECTED from the header row rather than assumed, and an unrecognised sheet is
 * reported rather than guessed at.
 */
/**
 * THREE PUBLISHERS, THREE HEADER VOCABULARIES. All three are real and all three
 * were found by a workbook failing to parse, not by guessing:
 *
 *   Panini      CARD SET | CARD # | ATHLETE     | TEAM      | SEQ
 *   Upper Deck  Set Name | Card   | Description | Team City | ... | Serial #'d
 *   Topps       (no header row at all - the section-stream shape)
 *
 * Upper Deck calls the player "Description", so the detector rejected the whole
 * sheet and fell through to the stream reader, which returned nothing: 92 of 599
 * products, 79 of them hockey. It also ships explicit `Auto` and `Rookie`
 * columns, which are better than the flags we infer from card-number prefixes.
 */
const HEAD = {
  subset: /^(card\s*set|set\s*name|set|subset|insert)$/i,
  cardNumber: /^(card\s*#?|card\s*number|no\.?)$/i,
  player: /^(athlete|player(\s*name)?|name|subject|description)$/i,
  team: /^(team|team\s*name)$/i,
  teamCity: /^team\s*city$/i,
  printRun: /^(seq|sequence|print\s*run|numbered|serial(\s*#'?d)?|#'?d)$/i,
  isAuto: /^(auto|autograph)$/i,
  isRookie: /^(rookie|rc)$/i,
};

/**
 * A FOURTH SHAPE: tabular data with NO header row.
 *
 *   Base | 1 | Bobby Witt Jr.   | Kansas City Royals
 *   Base | 2 | Bryce Harper     | Philadelphia Phillies
 *
 * The Panini layout minus its header, so detectHeader finds nothing and the
 * sheet falls to the stream reader — which expects the card number in column A
 * and finds "Base" there, yielding zero cards. Four products, including
 * 2025 Topps Chrome Black.
 *
 * INFERRED FROM SHAPE ACROSS THE WHOLE SHEET, NOT FROM ONE ROW. A single-row
 * guess is how the Zenith column-shift happened. This requires a strong
 * majority of rows to agree on the same column roles before it will claim a
 * mapping, and returns null otherwise so the sheet is REPORTED as unreadable
 * rather than parsed wrongly. A wrong parse is worse than no parse: it produces
 * confident garbage that no gap report will ever flag.
 */
// Deliberately loose: real card numbers are "1", "BCP-109", "CBA-BW", "FP-1".
// Requiring a digit would drop initials-based insert numbers (CBA-BW = Chrome
// Black Autos, Bobby Witt) — 198 of Chrome Black's 468 rows. What excludes junk
// is not this pattern but the REQUIREMENT THAT A PERSON'S NAME SIT BESIDE IT:
// "BASE" would pass here, and is rejected because its player column is empty.
const CARD_NUM_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,11}$/;
const PERSON_RE = /^[A-Z][A-Za-z'.À-ſ-]+(?:\s+[A-Za-z'.À-ſ-]+){1,3}$/;

function detectHeaderless(rows) {
  const body = rows.filter((r) => Array.isArray(r) && r.filter((c) => c != null && String(c).trim()).length >= 3);
  if (body.length < 20) return null;
  const sample = body.slice(0, 400);

  // SCORE THE PAIR, NOT EACH COLUMN. Judging columns independently set the bar
  // in the wrong place: Topps Chrome Black scores 0.68 on its card-number column
  // (section rows and long insert numbers dilute it) and 0.92 on its player
  // column, so a per-column gate either rejects a correct mapping or has to be
  // loosened until it accepts wrong ones. Requiring the two to hold on the SAME
  // ROW is far stronger evidence — across 455 rows, half agreeing on a
  // (number, person) adjacency does not happen by chance.
  const joint = (numCol, playerCol) =>
    sample.filter((r) => CARD_NUM_RE.test(String(r[numCol] ?? "").trim())
                      && PERSON_RE.test(String(r[playerCol] ?? "").trim())).length / sample.length;

  // Candidate offsets: {subset, num, player, team} and {num, player, team}.
  const candidates = [[1, 2, 0, 3], [0, 1, null, 2]]
    .map((c) => ({ c, s: joint(c[0], c[1]) }))
    .sort((a, b) => b.s - a.s);
  const best = candidates[0];
  if (!best || best.s < 0.5) return null;

  const [numCol, playerCol, subsetCol, teamCol] = best.c;
  const map = { cardNumber: numCol, player: playerCol };
  if (subsetCol !== null) map.subset = subsetCol;
  if (teamCol !== null) map.team = teamCol;
  return { row: -1, map, inferred: true, confidence: best.s };
}

/** Find a header row in the first few rows and map column index -> field. */
function detectHeader(rows) {
  for (let i = 0; i < Math.min(6, rows.length); i++) {
    const cells = (rows[i] || []).map((c) => String(c ?? "").trim());
    const map = {};
    for (let c = 0; c < cells.length; c++) {
      for (const [field, re] of Object.entries(HEAD)) {
        if (!(field in map) && re.test(cells[c])) map[field] = c;
      }
    }
    // A header is only convincing with BOTH a card number and a player column;
    // "SET" alone appears in plenty of ordinary rows.
    if ("cardNumber" in map && "player" in map) return { row: i, map };

    // A CHECKLIST WITH NO CARD NUMBERS IS READABLE BUT UNUSABLE, and that is a
    // THIRD outcome, distinct from both "no checklist" and "we cannot read it".
    //
    // 2025 Topps T205 publishes "Player | Team" and lists its 300 subjects
    // alphabetically; the cards are numbered, the checklist just does not say
    // so. Our slug space is keyed on cardNumber, so parsing these would mint
    // rows nothing can match — and null-cardNumber catalog rows are already a
    // known defect we are cleaning up, not one to manufacture more of.
    //
    // So it is REPORTED, not forced. Flattering the parse rate by emitting
    // unusable rows is the kind of number that hides work rather than finding
    // it.
    if ("player" in map && "team" in map) return { row: i, map, noCardNumbers: true };
  }
  return null;
}

function parseWorkbook(buf) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const cards = [];
  const sections = new Set();
  const diagnostics = [];
  let layout = null;

  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: null });
    if (!rows.length) continue;
    // ORDER MATTERS, and getting it wrong costs real rows. "No card numbers" is
    // a LAST resort, not a first read: 2023 Topps Composite has a Player/Team
    // header AND card numbers in a column the header does not name. Accepting
    // the no-card-number signature before trying shape inference threw away
    // 1,078 correctly-parsed cards and reported the product as unusable.
    const strict = detectHeader(rows);
    const head = (strict && !strict.noCardNumbers) ? strict : (detectHeaderless(rows) || strict);
    if (!head) continue;
    if (head.noCardNumbers) {
      // Readable, but it lists no card numbers — see detectHeader. Recorded and
      // skipped rather than parsed into rows nothing can key on.
      layout = "no-card-numbers";
      diagnostics.push({ level: "warn", message: `sheet "${name}" lists players with no card-number column; ${rows.length} rows skipped` });
      continue;
    }
    layout = head.inferred ? "tabular-inferred" : "tabular";
    let map = head.map;
    for (let i = head.row + 1; i < rows.length; i++) {
      const r = rows[i] || [];

      // A WORKBOOK CAN BE SEVERAL TABLES STACKED, and the columns move between
      // them. Upper Deck Series 2 repeats "Rookie" 1,127 times and "Plate" 218
      // times in the middle of the sheet — each is a fresh header for the
      // section below it. Mapping columns once from the first header and
      // applying it to all 4,400 rows reads later sections at the wrong offset,
      // which does not fail loudly: it silently mints wrong print runs and
      // wrong player names. So a header row RE-MAPS rather than being skipped.
      // A RE-MAP MUST NOT LOSE A FIELD. 2023 Topps Composite opens with
      // ["BASE", null, "Name", "Team", "Rookie"] — header-shaped, but with no
      // card-number column. Accepting it replaced a correct inferred mapping
      // (confidence 0.98) with one lacking cardNumber, after which every row
      // failed the shape test and the product reported zero cards. Only a
      // header naming BOTH a number and a player may re-map; anything else is
      // skipped as a banner.
      const asHeader = detectHeader([r]);
      if (asHeader && !asHeader.noCardNumbers) { map = asHeader.map; continue; }
      if (asHeader) continue;

      const at = (f) => (f in map ? (r[map[f]] == null ? null : String(r[map[f]]).trim()) : null);
      const cardNumber = at("cardNumber");
      const player = at("player");
      if (!cardNumber && !player) continue;

      // AN INFERRED MAPPING ONLY ACCEPTS ROWS OF THE SHAPE IT WAS INFERRED FROM.
      // Without a header row there is nothing marking where the table starts, so
      // banner and section lines ("SUBJECT TO CHANGE*", "BASE CARDS") sit in the
      // same columns as data and sail through a mere is-it-non-empty check —
      // 2025 Topps Chrome Black emitted them as cards numbered "SUBJEC".
      // The shape IS the evidence for the mapping, so a row that does not fit it
      // is not a card. Header-derived mappings skip this: there the header has
      // already told us where the table is, and real checklists carry oddball
      // card numbers this test would reject.
      if (head.inferred && !(CARD_NUM_RE.test(cardNumber || "") && PERSON_RE.test(player || ""))) continue;
      const subset = at("subset");
      if (subset) sections.add(subset);
      let printRun = null;
      const rawRun = at("printRun");
      if (rawRun) {
        const n = Number(String(rawRun).replace(/[,\/]/g, "").trim());
        if (Number.isFinite(n) && n >= 1 && n <= 100000) printRun = n;
      }
      // Upper Deck states auto and rookie outright. A stated flag beats the
      // card-number-prefix inference we fall back to elsewhere, so keep it when
      // offered and leave it null rather than false when the column is absent —
      // "not stated" and "stated as no" are different facts.
      const flag = (f) => {
        if (!(f in map)) return null;
        const v = String(at(f) ?? "").trim().toLowerCase();
        if (!v) return null;
        return v === "y" || v === "yes" || v === "true" || v === "1" || v === "x";
      };
      // Team arrives split on Upper Deck sheets ("Anaheim" + "Ducks").
      const city = at("teamCity");
      const team = at("team");
      const fullTeam = city && team ? `${city} ${team}` : (team || city || null);
      cards.push({
        subset: subset || null, cardNumber, player, team: fullTeam, printRun,
        isAuto: flag("isAuto"), isRookie: flag("isRookie"),
      });
    }
  }

  // Any tabular variant returns here. Testing `layout === "tabular"` silently
  // discarded correctly-parsed "tabular-inferred" sheets and fell through to the
  // stream reader, which reported zero cards — a parse that succeeds and is then
  // thrown away looks exactly like a parse that failed.
  if (layout && layout.startsWith("tabular")) return { layout, cards, sections: [...sections], diagnostics };
  // A no-card-number sheet is a FINAL answer, not a reason to try the stream
  // reader — the stream reader would find no numbers either, and its empty
  // result would be logged as a parse failure rather than the truth.
  if (layout === "no-card-numbers") return { layout, cards: [], sections: [...sections], diagnostics };

  // No header row anywhere -> the Topps section-stream shape. Hand it to the
  // parser already written for exactly that layout rather than writing a third.
  const parsed = parseCardboardConnectionChecklist(buf, { sourceLabel: "checklistinsider" });
  return {
    layout: "stream",
    cards: (parsed.cards || []).map((c) => ({
      subset: c.section || null, cardNumber: c.cardNumber ?? null, player: c.player ?? null,
      team: c.team ?? null, printRun: c.inlinePrintRun ?? null,
    })),
    sections: (parsed.sections || []).map((s) => s.name).filter(Boolean),
    diagnostics: (parsed.diagnostics || []).slice(0, 20),
  };
}

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const SPORT = arg("sport", "");
const YEAR = arg("year", "");
const LIMIT = Number(arg("limit", "0")) || Infinity;
/** Deliberately unhurried. This is a small free site doing us a favour. */
const DELAY_MS = Number(arg("delayMs", "1500"));
const OUT = arg("out", "C:/tmp/ci-staging.jsonl");
/** Re-run a named subset (one slug per line). Used to retry the products a
 *  reader fix should now handle, without re-fetching all 599 pages. */
const SLUGS_FILE = arg("slugsFile", "");
const ONLY = SLUGS_FILE
  ? new Set(fs.readFileSync(SLUGS_FILE, "utf8").split("\n").map((x) => x.trim()).filter(Boolean))
  : null;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, asBuffer = false, attempt = 0) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60_000) });
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) {
      // A silent null here is exactly how a 403 reported itself as "0 set pages
      // in scope" -- an empty scrape indistinguishable from a successful one.
      console.log(`   HTTP ${res.status} ${String(url).slice(0, 90)}`);
      return null;
    }
    return asBuffer ? Buffer.from(await res.arrayBuffer()) : await res.text();
  } catch (e) {
    if (attempt < 3) { await sleep(3000 * (attempt + 1)); return get(url, asBuffer, attempt + 1); }
    console.log(`   fetch failed ${String(url).slice(0, 80)}: ${String(e.message).slice(0, 50)}`);
    return null;
  }
}

const detag = (s) => String(s).replace(/<[^>]+>/g, "")
  .replace(/&#8217;|&rsquo;|&#039;/g, "'").replace(/&amp;/g, "&")
  .replace(/&nbsp;|\u00a0/g, " ").replace(/&#8211;|&ndash;/g, "-").replace(/&quot;/g, '"')
  .replace(/\s+/g, " ").trim();

/**
 * The ladder lives in a <ul> whose preceding heading names it. Only headings
 * containing "parallel" qualify; "Box Break", "Downloads" and the site nav all
 * contain serial-looking text and must not be mistaken for a ladder.
 */
const PARALLEL_HEAD_RE = /parallels?\b/i;

/** "Celestial - /99", "Gold - /2,026", "Yellow Holo Foil - /399 (Retail)" */
const LADDER_ITEM_RE = /^(.{1,60}?)\s*[-–—]?\s*\/\s*([0-9][0-9,]{0,6})\b(.*)$/;

function extractLadders(html) {
  const out = [];
  const seen = new Set();
  const ulRe = /<ul[^>]*>([\s\S]*?)<\/ul>/gi;
  let m;
  while ((m = ulRe.exec(html))) {
    const before = html.slice(Math.max(0, m.index - 300), m.index);
    const heads = [...before.matchAll(/<(?:strong|b|h[1-6])[^>]*>([^<]{3,110})<\/(?:strong|b|h[1-6])>/gi)];
    if (!heads.length) continue;
    const heading = detag(heads[heads.length - 1][1]);
    if (!PARALLEL_HEAD_RE.test(heading)) continue;
    for (const im of m[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
      const text = detag(im[1]);
      if (!text || text.length > 110) continue;
      const lm = LADDER_ITEM_RE.exec(text);
      // An unnumbered entry is still a real parallel ("Silver"); it simply has
      // no print run. Recording it with printRun null keeps the ladder complete
      // and lets the reconcile step tell "unnumbered" from "unknown".
      const name = (lm ? lm[1] : text).trim().replace(/[-–—]\s*$/, "").trim();
      if (!name || !/[A-Za-z]{2}/.test(name)) continue;
      let printRun = null;
      if (lm) {
        const n = Number(String(lm[2]).replace(/,/g, ""));
        // Commas matter: "/2,026" is a run of 2026, and reading it as 2 would be
        // the same class of bug as `2024`-as-a-serial.
        if (Number.isFinite(n) && n >= 1 && n <= 100000) printRun = n;
      }
      const k = `${heading.toLowerCase()}|${name.toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ list: heading, parallel: name, printRun, note: lm ? (lm[3] || "").trim().slice(0, 60) || undefined : undefined });
    }
  }
  return out;
}

/** The workbook link, when the product publishes one. */
function extractXlsxUrl(html) {
  const m = /href="([^"]+\.xlsx)"/i.exec(html);
  return m ? m[1] : null;
}

/**
 * "https://.../2026-topps-series-1-baseball" -> { year, sport, slug }
 *
 * SEASON-SPANNING SLUGS are the norm for basketball and hockey:
 * "2023-24-panini-national-treasures-basketball". Matching only the leading year
 * leaves "24-panini-national-treasures" as the product name, which then fails
 * every setKey lookup.
 */
function parseUrl(u) {
  const slug = u.replace(/\/+$/, "").split("/").pop();
  const y = /^((?:19|20)\d{2})(?:-(\d{2}))?-/.exec(slug);
  const s = /-(baseball|football|basketball|hockey|soccer)$/.exec(slug);
  if (!y) return { slug, year: null, seasonEndYear: null, yearPrefix: null, sport: s ? s[1] : null };
  const year = Number(y[1]);
  // "2023-24" -> the season ends in 2024. Two-digit suffixes roll over centuries
  // ("1999-00"), so derive rather than concatenate.
  let seasonEndYear = null;
  if (y[2]) {
    const c = Math.floor(year / 100) * 100;
    seasonEndYear = c + Number(y[2]);
    if (seasonEndYear < year) seasonEndYear += 100;
  }
  return { slug, year, seasonEndYear, yearPrefix: y[0].replace(/-$/, ""), sport: s ? s[1] : null };
}

async function main() {
  console.log(`[checklistinsider] sport=${SPORT || "(all)"} year=${YEAR || "(all)"} delay=${DELAY_MS}ms`);
  console.log(`out: ${OUT}\n`);

  // Enumerate from the sitemap rather than guessing URL patterns.
  const idx = await get("https://www.checklistinsider.com/sitemap_index.xml");
  if (!idx) { console.error("FATAL: sitemap index unreachable"); process.exit(1); }
  const children = [...idx.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => /post-sitemap/.test(u));

  const urls = [];
  for (const c of children) {
    const xml = await get(c);
    await sleep(DELAY_MS);
    if (!xml) continue;
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.push(m[1]);
  }
  const sets = urls.map(parseUrl).filter((s) => s.sport && s.year)
    .filter((s) => (!SPORT || s.sport === SPORT) && (!YEAR || String(s.year) === YEAR))
    .filter((s) => !ONLY || ONLY.has(s.slug));
  console.log(`set pages in scope: ${sets.length.toLocaleString()} of ${urls.length.toLocaleString()} sitemap urls\n`);
  // Exiting 0 here let the end-to-end wrapper record "insider-acquired" and
  // walk on to an ingest with nothing staged. An empty scrape is a failure.
  if (!sets.length) {
    console.error("FATAL: 0 set pages in scope — the sitemap yielded no product pages.");
    console.error("       The index answers 200 from a residential IP, so suspect an IP block");
    console.error("       on the runner before suspecting the filter. Read the HTTP lines above.");
    process.exit(1);
  }

  const stream = fs.createWriteStream(OUT, { flags: "w" });
  let done = 0, withLadder = 0, withBook = 0, stubs = 0, ladderRows = 0, cardRows = 0, failed = 0, bookFailed = 0, diagged = 0, bookRuns = 0, noCardNumbers = 0;
  const layouts = {};
  for (const s of sets) {
    if (done >= LIMIT) break;
    const url = `https://www.checklistinsider.com/${s.slug}`;
    const html = await get(url);
    await sleep(DELAY_MS);
    done++;
    if (!html) { failed++; continue; }

    const parallels = extractLadders(html);
    const xlsxUrl = extractXlsxUrl(html);

    let cards = [], sections = [], diagnostics = [], layout = null, bookUnparsed = false;
    if (xlsxUrl) {
      const buf = await get(xlsxUrl, true);
      await sleep(DELAY_MS);
      if (!buf) { bookUnparsed = true; bookFailed++; diagnostics = [{ level: "error", message: "workbook fetch failed" }]; }
      else {
        try {
          const parsed = parseWorkbook(buf);
          cards = parsed.cards || [];
          sections = parsed.sections || [];
          diagnostics = parsed.diagnostics || [];
          layout = parsed.layout;
          if (layout === "no-card-numbers") {
            // Readable, and genuinely carries no card numbers. NOT a parse gap —
            // counting it as one would send someone to fix a reader that is
            // working correctly.
            noCardNumbers++;
          } else if (!cards.length) {
            // A workbook that yields nothing is a PARSE GAP, not an absent
            // checklist. Collapsing the two would hide a reader we need to fix
            // behind a number that looks like the site's fault.
            bookUnparsed = true; bookFailed++;
            diagnostics = diagnostics.concat([{ level: "error", message: `workbook parsed to 0 cards (layout=${layout})` }]);
          }
        } catch (e) {
          diagnostics = [{ level: "error", message: `parse threw: ${String(e.message).slice(0, 120)}` }];
          bookUnparsed = true; bookFailed++;
        }
      }
    }

    // A STUB is a page that published nothing: no ladder, no workbook at all.
    // A page WITH a workbook we failed to read is not a stub - see bookUnparsed.
    const isStub = !parallels.length && !xlsxUrl;
    if (isStub) stubs++;
    if (parallels.length) { withLadder++; ladderRows += parallels.length; }
    if (cards.length) { withBook++; cardRows += cards.length; }
    const runsFromBook = cards.filter((c) => c.printRun).length;
    bookRuns += runsFromBook;
    if (diagnostics.length) diagged++;
    if (layout) layouts[layout] = (layouts[layout] ?? 0) + 1;

    stream.write(JSON.stringify({
      source: "checklistinsider",
      scrapedAt: new Date().toISOString(),
      url, slug: s.slug, year: s.year, seasonEndYear: s.seasonEndYear,
      yearPrefix: s.yearPrefix, sport: s.sport,
      xlsxUrl, layout, isStub, bookUnparsed,
      parallels, sections, cards, diagnostics,
    }) + "\n");

    if (done % 10 === 0) {
      process.stderr.write(`\r  ${done}/${Math.min(sets.length, LIMIT)}  ladders=${withLadder} par=${ladderRows} books=${withBook} cards=${cardRows} stubs=${stubs}   `);
    }
  }
  stream.end();
  process.stderr.write("\n");

  console.log(`\npages fetched        : ${done.toLocaleString()}`);
  console.log(`  with a ladder      : ${withLadder.toLocaleString()}`);
  console.log(`  with a workbook    : ${withBook.toLocaleString()}`);
  console.log(`  STUBS (published nothing): ${stubs.toLocaleString()}`);
  console.log(`  page fetch failed  : ${failed.toLocaleString()}`);
  console.log(`  WORKBOOK UNPARSED  : ${bookFailed.toLocaleString()}   <- our reader, not their gap`);
  console.log(`  no card numbers    : ${noCardNumbers.toLocaleString()}   <- readable, but nothing to key on`);
  console.log(`  with diagnostics   : ${diagged.toLocaleString()}   <- read these before trusting the set`);
  console.log(`  layouts            : ${JSON.stringify(layouts)}`);
  console.log(`\nparallel rows        : ${ladderRows.toLocaleString()}   (print runs)`);
  console.log(`card rows            : ${cardRows.toLocaleString()}   (checklist)`);
  console.log(`  ...WITH a print run: ${bookRuns.toLocaleString()}   <- card-level print runs, the prize\n`);
  console.log("STAGING ONLY - nothing written to Cosmos. Read a sample before ingesting.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
