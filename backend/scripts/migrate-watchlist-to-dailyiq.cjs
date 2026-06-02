/* eslint-disable */
// CF-WATCHLIST-UNIFY (2026-06-02): one-time migration from the basic
// `watchlist` container to the rich `dailyiq_watchlist` container.
//
// USAGE:
//   COSMOS_CONNECTION_STRING=... node scripts/migrate-watchlist-to-dailyiq.cjs --dry-run
//   COSMOS_CONNECTION_STRING=... node scripts/migrate-watchlist-to-dailyiq.cjs --apply
//
// Per the deploy-mode catalogue + memory: uses the @azure/cosmos client
// directly. Does NOT use the az CLI for data-plane reads (known gotcha:
// `az cosmosdb sql query` has bugs with cross-partition queries on this
// account).
//
// SAFE BY DEFAULT: --dry-run reports counts + resolution outcomes; writes
// nothing. --apply performs upserts to `dailyiq_watchlist`, logs each one,
// and does NOT delete source rows (one-way migration; source container is
// kept until verified in prod for ≥24h then dropped in a separate CF).
//
// Idempotency: deterministic `dailyiq_watchlist` doc id is
// `wl_${sha1(userId::playerId)}` — mirrors watchlistStore.docIdFor() so
// re-running --apply is safe. Existing rich entries WILL be merged with
// the basic row's metadata (sport/alertEnabled dropped — see below).
//
// FIELD MAPPING:
//   Source (`watchlist` doc):
//     { id (uuid), userId, playerId, playerName, sport, alertEnabled,
//       createdAt, docType: "watchlist" }
//   Target (`dailyiq_watchlist` doc):
//     { id (wl_<hash>), userId, playerId, playerName, teamName?,
//       teamAbbreviation?, league?, level?, position?, mlbPersonId?,
//       watchlistItemId (uuid), createdAt, docType: "dailyiq_watchlist" }
//
//   sport: DROPPED. Rich system uses league ("MLB" | "MiLB"). Default to
//          "MLB" when MLB resolution fails — these are baseball-app rows.
//   alertEnabled: DROPPED. Rich system has no per-player alertEnabled
//          field; alert preference is per-user via alertPreferences.
//   createdAt: PRESERVED.
//   watchlistItemId: NEW uuid generated per migrated row (rich system
//          requires it; basic system's `id` was uuid but stored as Cosmos
//          doc id, not a separate field).
//
// MLB resolution: best-effort. Tries searchMlbPerson via direct MLB Stats
// API call (no local backend dep — script is self-contained for ops use).
// On failure, falls back to freeform with league="MLB" + name-as-stored.
// Resolution result is reported per-row in --dry-run output.

const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");

const SOURCE_CONTAINER = "watchlist";
const TARGET_CONTAINER = "dailyiq_watchlist";
const SOURCE_DOC_TYPE = "watchlist";
const TARGET_DOC_TYPE = "dailyiq_watchlist";
const DB_NAME = process.env.COSMOS_DATABASE || "hobbyiq";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const APPLY = args.includes("--apply");
const VERBOSE = args.includes("--verbose") || args.includes("-v");

if (!DRY_RUN && !APPLY) {
  console.error(
    "Usage: node migrate-watchlist-to-dailyiq.cjs --dry-run | --apply [--verbose]",
  );
  console.error(
    "Refusing to run without an explicit mode flag (safety: no silent default).",
  );
  process.exit(2);
}
if (DRY_RUN && APPLY) {
  console.error("Cannot pass BOTH --dry-run AND --apply. Pick one.");
  process.exit(2);
}

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) {
  console.error("FATAL: COSMOS_CONNECTION_STRING is required.");
  process.exit(2);
}

function docIdFor(userId, playerId) {
  const hash = crypto
    .createHash("sha1")
    .update(`${userId}::${playerId}`)
    .digest("hex");
  return `wl_${hash}`;
}

// Approach A: two-call resolver. `/people/search` returns id + fullName
// but NOT currentTeam (confirmed via direct probe). Second call to
// `/people/{id}?hydrate=currentTeam` brings in the team metadata needed
// for league + level + team fields.
//
// Self-contained so the script can run from ops without pulling the
// backend module graph. Falls back to freeform ONLY when /people/search
// returns no person at all (e.g. minor-league prospects not yet in the
// MLB prominence index).
const MLB_BASE = "https://statsapi.mlb.com/api/v1";

async function searchMlbPerson(name) {
  const url = `${MLB_BASE}/people/search?names=${encodeURIComponent(name)}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json();
    const people = Array.isArray(j.people) ? j.people : [];
    return people[0] || null;
  } catch (err) {
    return null;
  }
}

// Second call — hydrate currentTeam onto the person record. Returns
// the hydrated person, or null on any failure (caller falls through to
// a basic-profile from the search response).
//
// Empirical schema (verified 2026-06-02):
//   MLB player: currentTeam = { id, name, link }                  (no parentOrgId)
//   MiLB player: currentTeam = { id, name, link, parentOrgId: N } (parentOrgId present)
//   Neither response carries currentTeam.sport — that requires a 3rd
//   call to /teams/{teamId}. See fetchTeamSport below.
async function hydratePersonTeam(personId) {
  const url = `${MLB_BASE}/people/${personId}?hydrate=currentTeam`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json();
    const people = Array.isArray(j.people) ? j.people : [];
    return people[0] || null;
  } catch (err) {
    return null;
  }
}

// Third call (MiLB rows only) — fetch the team's sport.id so we can map
// it to a level string. Skipped for MLB rows (level is always null when
// sportId === 1). Returns { sportId, league } or null on failure.
async function fetchTeamSport(teamId) {
  const url = `${MLB_BASE}/teams/${teamId}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json();
    const teams = Array.isArray(j.teams) ? j.teams : [];
    const sportId = teams[0] && teams[0].sport && teams[0].sport.id;
    return Number.isFinite(sportId) ? { sportId } : null;
  } catch (err) {
    return null;
  }
}

// Map MLB Stats sportId → human-readable level. Mirrors backend's
// mlbStats.service.ts levelFromSport. sportId 1 = MLB; the rest are
// affiliated minor-league tiers.
function levelFromSportId(sportId) {
  switch (sportId) {
    case 1: return null;        // MLB — no minor-league level
    case 11: return "Triple-A";
    case 12: return "Double-A";
    case 13: return "High-A";
    case 14: return "Single-A";
    case 16: return "Rookie";
    default: return null;
  }
}

// Profile from hydrated person + optional team-sport supplement.
// teamSport is the third-call result for MiLB rows; null for MLB rows
// (where level is always null anyway) and on hydrate failures.
function profileFromHydratedPerson(person, teamSport, fallbackName) {
  if (!person || typeof person !== "object") return null;
  const id = person.id;
  if (!Number.isFinite(id)) return null;
  const team = person.currentTeam || {};
  const positionCode = person.primaryPosition && person.primaryPosition.abbreviation;
  // MLB vs MiLB: parentOrgId presence on currentTeam is the empirical
  // discriminant. parentOrgId = the MLB org the affiliate rolls up to.
  // MLB teams ARE the parent org → no parentOrgId field.
  const isMlb = team.parentOrgId === undefined || team.parentOrgId === null;
  const league = isMlb ? "MLB" : "MiLB";
  const sportId = teamSport && Number.isFinite(teamSport.sportId)
    ? teamSport.sportId
    : (isMlb ? 1 : undefined);
  return {
    mlbPersonId: id,
    playerName: person.fullName || fallbackName,
    teamName: team.name || "",
    teamAbbreviation: team.abbreviation || "",
    league,
    level: levelFromSportId(sportId),
    position: positionCode || "",
  };
}

async function resolveAddablePlayer({ playerId, playerName }) {
  const searchTerm = (playerName || "").trim() ||
    (playerId || "").trim().replace(/-/g, " ");
  if (!searchTerm) {
    return { resolvedVia: "no-input", profile: null };
  }

  // Step 1: search.
  const searchHit = await searchMlbPerson(searchTerm);
  if (!searchHit || !Number.isFinite(searchHit.id)) {
    // Freeform fallback: search returned nothing. Keep the row, default
    // league=MLB, no rich metadata. Travis Sykora-class — prospects not
    // yet indexed by /people/search.
    return {
      resolvedVia: "freeform",
      profile: {
        playerName: searchTerm,
        league: "MLB",
      },
    };
  }

  // Step 2: hydrate currentTeam onto the person record.
  const hydrated = await hydratePersonTeam(searchHit.id);
  if (!hydrated) {
    // Hydrate failed (network / 404). Fall back to building from the
    // search hit alone with the safe MLB default. The id + fullName are
    // still authoritative; only team/level fields degrade.
    return {
      resolvedVia: "mlb-api+search-only",
      profile: {
        mlbPersonId: searchHit.id,
        playerName: searchHit.fullName || searchTerm,
        teamName: "",
        teamAbbreviation: "",
        league: "MLB",  // safe default; can be corrected on first live route hit
        level: null,
        position:
          searchHit.primaryPosition && searchHit.primaryPosition.abbreviation
            ? searchHit.primaryPosition.abbreviation
            : "",
      },
    };
  }

  // Step 3 (MiLB only): if currentTeam.parentOrgId is present, the
  // player is on an affiliate — fetch the team's sport.id so we can
  // map it to a level string ("Double-A", etc). Skipped for MLB rows
  // (level is always null when sportId === 1).
  const team = hydrated.currentTeam || {};
  const isMilb = team.parentOrgId !== undefined && team.parentOrgId !== null;
  let teamSport = null;
  if (isMilb && Number.isFinite(team.id)) {
    teamSport = await fetchTeamSport(team.id);
  }

  const profile = profileFromHydratedPerson(hydrated, teamSport, searchTerm);
  return {
    resolvedVia: "mlb-api+hydrate",
    profile,
  };
}

(async () => {
  const client = new CosmosClient(conn);
  const db = client.database(DB_NAME);
  const source = db.container(SOURCE_CONTAINER);
  const target = db.container(TARGET_CONTAINER);

  console.log("=".repeat(72));
  console.log(`CF-WATCHLIST-UNIFY migration  mode=${DRY_RUN ? "DRY-RUN" : "APPLY"}`);
  console.log(`  source: ${DB_NAME}/${SOURCE_CONTAINER}  (docType=${SOURCE_DOC_TYPE})`);
  console.log(`  target: ${DB_NAME}/${TARGET_CONTAINER}  (docType=${TARGET_DOC_TYPE})`);
  console.log("=".repeat(72));

  // Enumerate. Source is partition /userId; query without partitionKey
  // means cross-partition. Watchlist is single-user pre-launch so this
  // is a small enumeration.
  console.log("\nEnumerating source container...");
  const iter = source.items.query(
    {
      query: 'SELECT * FROM c WHERE c["docType"] = @t',
      parameters: [{ name: "@t", value: SOURCE_DOC_TYPE }],
    },
    { maxItemCount: 500 },
  );
  const sourceRows = [];
  while (iter.hasMoreResults()) {
    const { resources, requestCharge } = await iter.fetchNext();
    sourceRows.push(...resources);
    if (VERBOSE) {
      console.log(`  page: +${resources.length} (RU=${requestCharge?.toFixed(1)})`);
    }
  }
  console.log(`  found ${sourceRows.length} source row(s)`);

  if (sourceRows.length === 0) {
    console.log("\nNo source rows. Nothing to migrate.");
    process.exit(0);
  }

  // Resolve + map each row.
  const plan = [];
  let mlbHydrated = 0;     // Approach A success: search + hydrate (best)
  let mlbSearchOnly = 0;   // Search hit but hydrate failed (rare)
  let freeform = 0;        // Search returned no person (e.g. Sykora)
  let resolutionFailed = 0;
  let missingFields = 0;

  for (const row of sourceRows) {
    const userId = String(row.userId || "").trim();
    const playerId = String(row.playerId || "").trim();
    const playerName = String(row.playerName || "").trim();

    if (!userId || !playerId) {
      plan.push({
        sourceId: row.id,
        userId,
        playerId,
        playerName,
        action: "SKIP",
        reason: "missing userId or playerId",
      });
      missingFields++;
      continue;
    }

    const resolved = await resolveAddablePlayer({ playerId, playerName });
    if (!resolved.profile) {
      plan.push({
        sourceId: row.id,
        userId,
        playerId,
        playerName,
        action: "SKIP",
        reason: "resolution failed (no input)",
      });
      resolutionFailed++;
      continue;
    }

    if (resolved.resolvedVia === "mlb-api+hydrate") mlbHydrated++;
    else if (resolved.resolvedVia === "mlb-api+search-only") mlbSearchOnly++;
    else freeform++;

    const targetId = docIdFor(userId, playerId);
    const watchlistItemId = crypto.randomUUID();
    const targetDoc = {
      id: targetId,
      docType: TARGET_DOC_TYPE,
      userId,
      playerId,
      playerName: resolved.profile.playerName || playerName,
      teamName: resolved.profile.teamName || undefined,
      teamAbbreviation: resolved.profile.teamAbbreviation || undefined,
      league: resolved.profile.league || "MLB",
      level: resolved.profile.level ?? undefined,
      position: resolved.profile.position || undefined,
      mlbPersonId: resolved.profile.mlbPersonId || undefined,
      watchlistItemId,
      createdAt: row.createdAt || new Date().toISOString(),
    };

    // Strip undefined to keep Cosmos doc clean.
    for (const k of Object.keys(targetDoc)) {
      if (targetDoc[k] === undefined) delete targetDoc[k];
    }

    plan.push({
      sourceId: row.id,
      userId,
      playerId,
      playerName,
      action: "UPSERT",
      resolvedVia: resolved.resolvedVia,
      targetId,
      league: targetDoc.league,
      level: targetDoc.level || null,
      mlbPersonId: targetDoc.mlbPersonId || null,
      targetDoc,
    });
  }

  console.log("\nResolution summary:");
  console.log(`  resolved via mlb-api + hydrate (best):       ${mlbHydrated}`);
  console.log(`  resolved via mlb-api search only (degraded): ${mlbSearchOnly}`);
  console.log(`  resolved via freeform fallback:              ${freeform}`);
  console.log(`  resolution failed (skipped):                 ${resolutionFailed}`);
  console.log(`  missing userId/playerId (skipped):           ${missingFields}`);
  console.log(`  total upserts that would land:               ${plan.filter((p) => p.action === "UPSERT").length}`);

  console.log("\nPer-row plan:");
  for (const p of plan) {
    const tag = p.action === "UPSERT" ? `[UPSERT via ${p.resolvedVia}]` : `[SKIP: ${p.reason}]`;
    if (p.action === "UPSERT") {
      const d = p.targetDoc;
      console.log(
        `  ${tag} user=${p.userId} player=${p.playerId} name="${p.playerName}"\n` +
        `      league=${p.league} level=${p.level ?? "null"} ` +
        `team="${d.teamName ?? ""}" (${d.teamAbbreviation ?? ""}) ` +
        `position=${d.position ?? ""} mlbPersonId=${p.mlbPersonId} targetId=${p.targetId}`,
      );
    } else {
      console.log(`  ${tag} user=${p.userId} player=${p.playerId} name="${p.playerName}"`);
    }
  }

  if (DRY_RUN) {
    console.log("\nDRY-RUN: no writes performed. Re-run with --apply to migrate.");
    process.exit(0);
  }

  // --apply: perform upserts, log each, do NOT delete source rows.
  console.log("\nAPPLY: performing upserts to target container...");
  let upserts = 0;
  let upsertErrors = 0;
  for (const p of plan) {
    if (p.action !== "UPSERT") continue;
    try {
      await target.items.upsert(p.targetDoc);
      upserts++;
      console.log(`  ✓ upserted target=${p.targetId} user=${p.userId} player=${p.playerId}`);
    } catch (err) {
      upsertErrors++;
      console.error(`  ✗ FAILED target=${p.targetId} user=${p.userId} player=${p.playerId} err=${err.message}`);
    }
  }
  console.log(`\nAPPLY done: ${upserts} upserted, ${upsertErrors} failed.`);
  console.log("Source rows in `watchlist` container PRESERVED (not deleted).");
  console.log("Drop the source container in a separate CF after ≥24h prod verification.");
})().catch((err) => {
  console.error("FATAL:", err.message);
  console.error(err.stack);
  process.exit(1);
});
