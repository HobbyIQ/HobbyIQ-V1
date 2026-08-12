// CF-PARSE-BBM-PDF (Drew, 2026-08-11). BBM (Baseball Magazine)
// publishes free PDF checklists on sportsclick.jp for each of their
// annual sets. This script parses the extracted text (via pdftotext
// -enc UTF-8 -layout) into our hand-fetched manifest format.
//
// PDF row shape:  □XXX 選手名   （T）
//   XXX = 3-digit card number (or CE01, F46, etc. subset marker)
//   選手名 = player name (kanji)
//   T = single-letter team code
//
// Usage:
//   pdftotext -enc UTF-8 -layout 2024bbm1st.pdf 2024bbm1st.txt
//   node parseBbmChecklistPdf.cjs 2024bbm1st.txt 2024 "1st Version" > manifest.json

const fs = require("fs");

function main() {
  const [txtPath, yearStr, versionLabel] = process.argv.slice(2);
  if (!txtPath || !yearStr) {
    console.error("usage: node parseBbmChecklistPdf.cjs <txt> <year> <versionLabel>");
    process.exit(1);
  }
  const year = Number(yearStr);
  const raw = fs.readFileSync(txtPath, "utf8");

  const baseSet = [];
  const inserts = new Map(); // subsetLabel → cards[]
  let currentSection = "base";

  const lines = raw.split(/\r?\n/);
  const cardRe = /^\s*[□■]\s*([A-Z]{0,4}\d+[A-Z]?)\s+(\S.*?)\s*[（(]([A-Za-zＴＣＳＤＭＹＢＬＥＫＦＨＷ])[）)]/;

  for (const line of lines) {
    const m = cardRe.exec(line);
    if (m) {
      const raw = m[1].trim();
      // Strip leading zeros for pure-numeric card numbers (matches how
      // our slug generator normalizes cardNumber).
      const n = /^\d+$/.test(raw) ? String(Number(raw)) : raw;
      // Player name is kanji + potential ＊/○/◎/●/Ｒ marker suffix
      // (rookie/subset markers). Strip trailing markers for cleanliness.
      const nameRaw = m[2].trim().replace(/[＊○◎●Ｒ]+$/, "").trim();
      const row = { n, p: nameRaw };
      if (currentSection === "base") baseSet.push(row);
      else {
        if (!inserts.has(currentSection)) inserts.set(currentSection, []);
        inserts.get(currentSection).push(row);
      }
    }
    // Section-change heuristic: detect ［section name］ headers.
    const sec = /^\s*［(.+)］/.exec(line);
    if (sec) {
      const label = sec[1];
      if (/レギュラー/.test(label)) currentSection = "base";
      else currentSection = label;
    }
  }

  const setNamePart = versionLabel ? ` ${versionLabel}` : "";
  const setKey = versionLabel
    ? `bbm-${versionLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
    : "bbm";

  const manifest = {
    sport: "baseball",
    year,
    setKey,
    setName: `${year} BBM${setNamePart}`,
    source: "bbm-japan-official-pdf",
    sourceUrl: `https://www.sportsclick.jp/user_data/signlist/${year}bbm1st_list.pdf`,
    fetchedAt: new Date().toISOString().slice(0, 10),
    note: "Parsed from BBM's official checklist PDF. Player names in kanji as printed.",
    baseSet,
  };
  if (inserts.size > 0) {
    manifest.inserts = [...inserts.entries()].map(([label, cards]) => ({ setName: label, cards }));
  }

  console.log(JSON.stringify(manifest, null, 2));
  console.error(`baseSet=${baseSet.length}  inserts=${inserts.size}  totalCards=${baseSet.length + [...inserts.values()].reduce((s, x) => s + x.length, 0)}`);
}
main();
