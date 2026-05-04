/**
 * Pattern shorthand regression checker.
 *
 * Calls the live CompIQ API with shorthand-heavy baseball titles and prints
 * detected lanes via gradeTierUsed and resolvedCardName.
 *
 * Usage:
 *   node scripts/pattern-shorthand-check.js
 *
 * Optional env:
 *   API_BASE=https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net
 */

const API_BASE =
  process.env.API_BASE ||
  "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net";

const QUERIES = [
  "2024 Bowman Chrome Red Geo /5 Eli Willits",
  "2024 Bowman Chrome Blue Raywave Auto /150 Caleb Bonemer",
  "2023 Bowman Chrome Green Grass Auto Roman Anthony",
  "2024 Bowman Chrome Gold XFR Auto /50",
  "2024 Bowman Chrome Purple Lava Auto /250",
  "2024 Bowman Chrome Ref #499 Auto",
  "2024 Bowman Chrome Snake Skin Auto /99",
  "2024 Bowman Chrome Tiedye Auto /25",
  "2024 Bowman Chrome Crack Ice Auto /50",
  "2024 Bowman Chrome Sparkle Refractor Auto",
];

async function searchCard(query) {
  const res = await fetch(`${API_BASE}/api/compiq/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${query}`);
  }

  return res.json();
}

(async () => {
  console.log("Pattern shorthand regression run");
  console.log("=".repeat(88));

  for (const query of QUERIES) {
    try {
      const data = await searchCard(query);
      const sample = data?.recentComps?.[0]?.parallel || "n/a";
      const line = [
        `Q: ${query}`,
        `resolvedCardName: ${data?.resolvedCardName || ""}`,
        `gradeTierUsed: ${data?.gradeTierUsed || ""}`,
        `sampleCompParallel: ${sample}`,
      ].join(" | ");
      console.log(line);
    } catch (err) {
      console.log(`Q: ${query} | ERROR: ${err.message}`);
    }
  }

  console.log("=".repeat(88));
})();
