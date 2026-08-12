// CF-BATCH-BBM (Drew, 2026-08-11). Bulk-download every available BBM
// 1st/2nd Version checklist PDF from sportsclick.jp, extract via
// pdftotext, parse via parseBbmChecklistPdf.cjs helper, and emit
// hand-fetched manifests. Ingest picks them up on next run.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SCRATCH = "C:/Users/dvabu/AppData/Local/Temp/claude/c--Users-dvabu-OneDrive---Just-the-Boys-and-Cards-LLC-Desktop-HobbyIQ-V1/44ed1a3b-f8bb-43c5-948b-2d23cfb9d8f7/scratchpad";
const HAND_DIR = path.resolve(__dirname, "..", "data", "checklists", "hand-fetched");
const PARSER = path.resolve(__dirname, "parseBbmChecklistPdf.cjs");

// Known-available combos (probed 2026-08-11). URL patterns differ
// per product: `{year}bbm1st_list.pdf` for flagship 1st/2nd,
// `{year}fusion_list.pdf`, `{year}rookie[-edition]_list.pdf`, etc.
// urlSlug controls the URL filename; version + slugSuffix control the
// output manifest naming.
const AVAILABLE = [
  // Flagship 1st Version (2016-2025)
  { year: 2025, version: "1st Version", urlSlug: "bbm1st", productSuffix: "1st-version" },
  { year: 2025, version: "2nd Version", urlSlug: "bbm2nd", productSuffix: "2nd-version" },
  { year: 2024, version: "1st Version", urlSlug: "bbm1st", productSuffix: "1st-version" },
  { year: 2024, version: "2nd Version", urlSlug: "bbm2nd", productSuffix: "2nd-version" },
  { year: 2023, version: "1st Version", urlSlug: "bbm1st", productSuffix: "1st-version" },
  { year: 2023, version: "2nd Version", urlSlug: "bbm2nd", productSuffix: "2nd-version" },
  { year: 2022, version: "1st Version", urlSlug: "bbm1st", productSuffix: "1st-version" },
  { year: 2022, version: "2nd Version", urlSlug: "bbm2nd", productSuffix: "2nd-version" },
  { year: 2021, version: "1st Version", urlSlug: "bbm1st", productSuffix: "1st-version" },
  { year: 2021, version: "2nd Version", urlSlug: "bbm2nd", productSuffix: "2nd-version" },
  { year: 2020, version: "1st Version", urlSlug: "bbm1st", productSuffix: "1st-version" },
  { year: 2020, version: "2nd Version", urlSlug: "bbm2nd", productSuffix: "2nd-version" },
  { year: 2019, version: "1st Version", urlSlug: "bbm1st", productSuffix: "1st-version" },
  { year: 2019, version: "2nd Version", urlSlug: "bbm2nd", productSuffix: "2nd-version" },
  { year: 2018, version: "1st Version", urlSlug: "bbm1st", productSuffix: "1st-version" },
  { year: 2018, version: "2nd Version", urlSlug: "bbm2nd", productSuffix: "2nd-version" },
  { year: 2017, version: "1st Version", urlSlug: "bbm1st", productSuffix: "1st-version" },
  { year: 2016, version: "2nd Version", urlSlug: "bbm2nd", productSuffix: "2nd-version" },
  // Fusion (2017-2025)
  { year: 2025, version: "Fusion", urlSlug: "fusion", productSuffix: "fusion" },
  { year: 2024, version: "Fusion", urlSlug: "fusion", productSuffix: "fusion" },
  { year: 2023, version: "Fusion", urlSlug: "fusion", productSuffix: "fusion" },
  { year: 2022, version: "Fusion", urlSlug: "fusion", productSuffix: "fusion" },
  { year: 2021, version: "Fusion", urlSlug: "fusion", productSuffix: "fusion" },
  { year: 2020, version: "Fusion", urlSlug: "fusion", productSuffix: "fusion" },
  { year: 2019, version: "Fusion", urlSlug: "fusion", productSuffix: "fusion" },
  { year: 2018, version: "Fusion", urlSlug: "fusion", productSuffix: "fusion" },
  { year: 2017, version: "Fusion", urlSlug: "fusion", productSuffix: "fusion" },
  // Rookie / Rookie Edition
  { year: 2025, version: "Rookie Edition", urlSlug: "rookie-edition", productSuffix: "rookie-edition" },
  { year: 2024, version: "Rookie Edition", urlSlug: "rookie-edition", productSuffix: "rookie-edition" },
  { year: 2023, version: "Rookie", urlSlug: "rookie", productSuffix: "rookie" },
  { year: 2022, version: "Rookie", urlSlug: "rookie", productSuffix: "rookie" },
  { year: 2021, version: "Rookie", urlSlug: "rookie", productSuffix: "rookie" },
  { year: 2020, version: "Rookie", urlSlug: "rookie", productSuffix: "rookie" },
  { year: 2019, version: "Rookie", urlSlug: "rookie", productSuffix: "rookie" },
  { year: 2018, version: "Rookie", urlSlug: "rookie", productSuffix: "rookie" },
  { year: 2017, version: "Rookie", urlSlug: "rookie", productSuffix: "rookie" },
  // Genesis (premium)
  { year: 2025, version: "Genesis", urlSlug: "genesis", productSuffix: "genesis" },
  { year: 2024, version: "Genesis", urlSlug: "genesis", productSuffix: "genesis" },
  { year: 2023, version: "Genesis", urlSlug: "genesis", productSuffix: "genesis" },
  { year: 2022, version: "Genesis", urlSlug: "genesis", productSuffix: "genesis" },
  { year: 2021, version: "Genesis", urlSlug: "genesis", productSuffix: "genesis" },
  { year: 2020, version: "Genesis", urlSlug: "genesis", productSuffix: "genesis" },
  { year: 2019, version: "Genesis", urlSlug: "genesis", productSuffix: "genesis" },
  { year: 2018, version: "Genesis", urlSlug: "genesis", productSuffix: "genesis" },
  { year: 2017, version: "Genesis", urlSlug: "genesis", productSuffix: "genesis" },
  // Icons
  { year: 2025, version: "Icons", urlSlug: "icons", productSuffix: "icons" },
  { year: 2024, version: "Icons", urlSlug: "icons", productSuffix: "icons" },
  { year: 2023, version: "Icons", urlSlug: "icons", productSuffix: "icons" },
  { year: 2022, version: "Icons", urlSlug: "icons", productSuffix: "icons" },
  { year: 2021, version: "Icons", urlSlug: "icons", productSuffix: "icons" },
  { year: 2020, version: "Icons", urlSlug: "icons", productSuffix: "icons" },
  { year: 2019, version: "Icons", urlSlug: "icons", productSuffix: "icons" },
  { year: 2018, version: "Icons", urlSlug: "icons", productSuffix: "icons" },
  // TrueHeart (only 2017-2020)
  { year: 2020, version: "True Heart", urlSlug: "trueheart", productSuffix: "true-heart" },
  { year: 2019, version: "True Heart", urlSlug: "trueheart", productSuffix: "true-heart" },
  { year: 2018, version: "True Heart", urlSlug: "trueheart", productSuffix: "true-heart" },
  { year: 2017, version: "True Heart", urlSlug: "trueheart", productSuffix: "true-heart" },
];

function main() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  let ok = 0, fail = 0;
  const summary = [];
  for (const { year, version, urlSlug, productSuffix } of AVAILABLE) {
    const pdfPath = `${SCRATCH}/${year}-${urlSlug}.pdf`;
    const txtPath = `${SCRATCH}/${year}-${urlSlug}.txt`;
    const outPath = `${HAND_DIR}/${year}-bbm-${productSuffix}.json`;
    const url = `https://www.sportsclick.jp/user_data/signlist/${year}${urlSlug}_list.pdf`;
    try {
      execSync(`curl -sf -o "${pdfPath}" "${url}"`, { stdio: "pipe" });
      execSync(`pdftotext -enc UTF-8 -layout "${pdfPath}" "${txtPath}"`, { stdio: "pipe" });
      execSync(`node "${PARSER}" "${txtPath}" ${year} "${version}" > "${outPath}"`, { stdio: "pipe" });
      const doc = JSON.parse(fs.readFileSync(outPath, "utf8"));
      const base = doc.baseSet?.length || 0;
      const ins = (doc.inserts || []).reduce((s, x) => s + (x.cards?.length || 0), 0);
      console.log(`  ✓ ${year} ${version}  base=${base}  inserts=${ins}`);
      summary.push({ year, version, base, inserts: ins });
      ok++;
    } catch (e) {
      console.log(`  ✗ ${year} ${version}  ${e.message.slice(0, 100)}`);
      fail++;
    }
  }
  console.log(`\n[done] ok=${ok}  fail=${fail}`);
  console.log(`base total: ${summary.reduce((s, x) => s + x.base, 0)}`);
  console.log(`insert total: ${summary.reduce((s, x) => s + x.inserts, 0)}`);
}
main();
