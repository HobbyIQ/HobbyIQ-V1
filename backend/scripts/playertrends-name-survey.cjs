// player_trends name-shape survey.
//
// Originally built for CF-PLAYERNAME-CANONICALIZATION Phase 1c
// (2026-05-28). Retained as a reusable diagnostic for detecting
// name-format mismatches across stored player records:
//   - punctuation patterns (periods, apostrophes, hyphens)
//   - non-ASCII characters (accents)
//   - suffix presence (jr/sr/iii)
//   - whitespace anomalies
//   - case anomalies
//
// Re-run periodically to catch new mismatch classes as the cohort
// grows (especially when iOS supplies new player names with shapes
// not covered by canonicalizePlayerName).
//
// Read-only — pulls stored records via SELECT.
//
// Required env: COSMOS_CONNECTION_STRING

const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(2); }

  const client = new CosmosClient(conn);
  const c = client.database("hobbyiq").container("player_trends");

  console.log("=== TOTAL STORED ===");
  const { resources: countRows } = await c.items.query("SELECT VALUE COUNT(1) FROM c").fetchAll();
  console.log("count:", countRows[0]);

  console.log("");
  console.log("=== ALL STORED playerName VALUES ===");
  const { resources: rows } = await c.items.query("SELECT c.id, c.playerName, c.updatedAt FROM c ORDER BY c.playerName ASC").fetchAll();
  for (const r of rows) {
    console.log("  '" + r.playerName + "'  (id=" + r.id + ")");
  }

  console.log("");
  console.log("=== CLASSIFICATION ===");
  const features = {
    hasPeriod: [],
    hasApostrophe: [],
    hasHyphen: [],
    hasNonAscii: [],
    hasJrSrIii: [],
    hasMidInitial: [],
    hasMultipleSpaces: [],
    hasLeadingTrailingSpace: [],
    upperCase: [],
  };
  for (const r of rows) {
    const n = r.playerName || "";
    if (/\./.test(n)) features.hasPeriod.push(n);
    if (/['’`]/.test(n)) features.hasApostrophe.push(n);
    if (/-/.test(n)) features.hasHyphen.push(n);
    // Non-ASCII covers accented chars (acute, tilde, umlaut, etc.)
    let hasNonAscii = false;
    for (let i = 0; i < n.length; i++) {
      if (n.charCodeAt(i) > 127) { hasNonAscii = true; break; }
    }
    if (hasNonAscii) features.hasNonAscii.push(n);
    if (/\b(Jr|Sr|II|III|IV)\b/i.test(n)) features.hasJrSrIii.push(n);
    if (/\b[A-Z]\.\s/.test(n)) features.hasMidInitial.push(n);
    if (/\s{2,}/.test(n)) features.hasMultipleSpaces.push(n);
    if (n !== n.trim()) features.hasLeadingTrailingSpace.push(n);
    if (n === n.toUpperCase() && /[A-Z]/.test(n)) features.upperCase.push(n);
  }
  for (const [key, names] of Object.entries(features)) {
    if (names.length === 0) continue;
    console.log("  " + key + " (" + names.length + "):");
    for (const n of names.slice(0, 15)) console.log("    " + n);
  }
}

main().catch((e) => { console.error("FATAL:", e && e.message || e); process.exit(1); });
