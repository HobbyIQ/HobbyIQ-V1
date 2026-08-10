// CF-INVITE-PLAN-GRANT-BACKFILL (Drew, 2026-08-10). One-shot script:
//
//   1. Update an existing invite_codes row to set grantsPlan (future
//      claimers land on the granted plan automatically)
//   2. Walk claimedBy[] on that code, patching every user's
//      entitlementOverride to the granted plan
//
// Use for the "founding invite = pro seller" retroactive upgrade so
// people who already redeemed BYEBYE80PERCENTERS don't have to wait
// for a code change to get their promised tier.
//
// Usage:
//   COSMOS_CONNECTION_STRING="..." node backend/scripts/grantPlanToInviteClaimers.cjs \
//     --code=BYEBYE80PERCENTERS --plan=pro_seller [--dry-run]

const path = require("path");
const { CosmosClient } = require("@azure/cosmos");

function arg(name, dflt = null) {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : dflt;
}

const CODE = String(arg("code", "")).trim().toUpperCase();
const PLAN = String(arg("plan", "")).trim();
const DRY = process.argv.includes("--dry-run");
const VALID_PLANS = ["free", "collector", "investor", "pro_seller"];

if (!CODE) { console.error("--code required"); process.exit(1); }
if (!VALID_PLANS.includes(PLAN)) {
  console.error(`--plan must be one of: ${VALID_PLANS.join(", ")}`);
  process.exit(1);
}
if (!process.env.COSMOS_CONNECTION_STRING) {
  console.error("COSMOS_CONNECTION_STRING required");
  process.exit(1);
}

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const invites = db.container("invite_codes");
  const users = db.container(process.env.COSMOS_USERS_CONTAINER || "users");

  // Step 1: read the invite doc
  console.log(`[step 1] reading invite ${CODE}`);
  let inviteRow;
  try {
    const { resource } = await invites.item(CODE, CODE).read();
    inviteRow = resource;
  } catch (err) {
    if (err && err.code === 404) {
      console.error(`invite ${CODE} not found`);
      process.exit(1);
    }
    throw err;
  }
  console.log(`  code           : ${inviteRow.code}`);
  console.log(`  status         : ${inviteRow.status}`);
  console.log(`  usesRemaining  : ${inviteRow.usesRemaining} / ${inviteRow.maxUses}`);
  console.log(`  currently grants: ${inviteRow.grantsPlan ?? "(nothing)"}`);
  console.log(`  claimedBy count: ${(inviteRow.claimedBy || []).length}`);

  // Step 2: patch invite doc's grantsPlan (future claimers)
  if (inviteRow.grantsPlan !== PLAN) {
    console.log("");
    console.log(`[step 2] set invite.grantsPlan = ${PLAN}${DRY ? " [DRY-RUN]" : ""}`);
    if (!DRY) {
      inviteRow.grantsPlan = PLAN;
      await invites.item(CODE, CODE).replace(inviteRow);
    }
  } else {
    console.log("");
    console.log(`[step 2] invite already grants ${PLAN} — no change needed`);
  }

  // Step 3: iterate claimedBy, patch each user's entitlementOverride
  const claimers = inviteRow.claimedBy || [];
  console.log("");
  console.log(`[step 3] upgrading ${claimers.length} existing claimer(s)${DRY ? " [DRY-RUN]" : ""}`);
  let upgraded = 0, alreadySet = 0, notFound = 0, failed = 0;
  for (const c of claimers) {
    const userId = c.userId;
    if (!userId) continue;
    try {
      const { resource: user } = await users.item(userId, userId).read();
      if (!user) { notFound++; continue; }
      if (user.entitlementOverride === PLAN) {
        alreadySet++;
        continue;
      }
      if (DRY) {
        console.log(`  would set ${userId}.entitlementOverride = ${PLAN} (was: ${user.entitlementOverride ?? user.plan ?? "free"})`);
        upgraded++;
        continue;
      }
      user.entitlementOverride = PLAN;
      await users.item(userId, userId).replace(user);
      upgraded++;
      console.log(`  ✓ ${userId} → ${PLAN}`);
    } catch (err) {
      const code = err && err.code;
      if (code === 404) { notFound++; continue; }
      failed++;
      console.warn(`  fail ${userId}: ${(err && err.message) || err}`);
    }
  }

  console.log("");
  console.log("[done]");
  console.log(`  upgraded     : ${upgraded}`);
  console.log(`  already set  : ${alreadySet}`);
  console.log(`  user not found: ${notFound}`);
  console.log(`  failed       : ${failed}`);
  if (DRY) console.log(`  (dry-run — no writes issued)`);
}

main().catch((e) => {
  console.error("[FATAL]", (e && e.stack) || e);
  process.exit(1);
});
