// Attach baseTemplate + autoTemplate keys to existing hand-fetched manifests
const fs = require("fs");
const path = require("path");
const DIR = path.resolve(__dirname, "..", "data", "checklists", "hand-fetched");

const MAP = {
  "2026-bowman-chrome.json":            { baseTemplate: "bowman-chrome-base", autoTemplate: "bowman-chrome-prospects-auto" },
  "2026-bowman-chrome-mega-box.json":   { baseTemplate: "bowman-chrome-base", autoTemplate: "bowman-chrome-prospects-auto" },
  "2025-panini-prizm-baseball.json":    { baseTemplate: "panini-prizm-baseball" },
  "2025-panini-prizm-football.json":    { baseTemplate: "panini-prizm-football" },
  "2024-25-panini-prizm-basketball.json": { baseTemplate: "panini-prizm-basketball" },
  "2024-panini-donruss-football.json":  { baseTemplate: "panini-donruss-football" },
};

for (const [file, patch] of Object.entries(MAP)) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) { console.warn(`skip: ${file} not found`); continue; }
  const manifest = JSON.parse(fs.readFileSync(p, "utf8"));
  Object.assign(manifest, patch);
  // For Bowman Chrome: promote chromeProspects to autoSeries so the auto template fires
  if (patch.autoTemplate && manifest.chromeProspects && !manifest.autoSeries) {
    manifest.autoSeries = manifest.chromeProspects;
    delete manifest.chromeProspects;
  }
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2));
  console.log(`✓ ${file}: ${JSON.stringify(patch)}`);
}
