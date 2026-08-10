// CF-INVITE-ONLY-SIGNUP (Drew, 2026-08-10). CLI to mint invite codes.
//
// Usage:
//   COSMOS_CONNECTION_STRING="..." node backend/scripts/mintInviteCode.cjs \
//     [--code=CUSTOM-CODE]        (optional; auto-generated if omitted)
//     [--uses=N]                  (default 1)
//     [--expires=YYYY-MM-DD]      (optional; ISO date, expires 23:59 UTC)
//     [--notes="who is this for"] (optional; free-text)
//     [--count=N]                 (mint N codes at once)
//
// Prints one code per line to stdout so it can be piped to a file or
// mail-merge. Also writes {code, url} lines when --url-base is set,
// e.g. --url-base=https://hobby-iq.com/login?signup=true so you can
// hand out a full click-to-signup link.
//
// Runs against prod Cosmos — mint sparingly. Every mint is a real row
// in the invite_codes container.

const path = require("path");

function arg(name, dflt = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  return dflt;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("COSMOS_CONNECTION_STRING required");
    process.exit(1);
  }
  const distRoot = path.resolve(__dirname, "..", "dist");
  const service = path.join(distRoot, "services", "auth", "inviteCodes.service.js");
  const fs = require("fs");
  if (!fs.existsSync(service)) {
    console.error("dist missing — run `npm run build` in backend first.");
    process.exit(1);
  }
  const { mintInviteCode } = require(service);

  const codeOverride = arg("code");
  const uses = Number(arg("uses", "1"));
  const expiresDay = arg("expires");
  const notes = arg("notes");
  const count = Math.max(1, Math.min(500, Number(arg("count", "1"))));
  const urlBase = arg("url-base");
  // CF-INVITE-PLAN-GRANT (Drew, 2026-08-10). --grants-plan=pro_seller
  // makes every redeemer of this code auto-land on Pro Seller via
  // entitlementOverride. Valid: free | collector | investor | pro_seller.
  const grantsPlan = arg("grants-plan");
  if (grantsPlan && !["free", "collector", "investor", "pro_seller"].includes(grantsPlan)) {
    console.error(`--grants-plan must be one of: free, collector, investor, pro_seller (got: ${grantsPlan})`);
    process.exit(1);
  }

  const expiresAt = expiresDay
    ? new Date(`${expiresDay}T23:59:59Z`).toISOString()
    : null;

  const results = [];
  for (let i = 0; i < count; i++) {
    // If --code was provided, only mint one — custom codes can't be
    // reused across mints.
    if (codeOverride && i > 0) break;
    const doc = await mintInviteCode({
      code: codeOverride ?? undefined,
      maxUses: uses,
      expiresAt,
      notes,
      createdBy: "admin-cli",
      grantsPlan: grantsPlan || null,
    });
    if (!doc) {
      console.error("mint returned null — check container permissions.");
      process.exit(1);
    }
    results.push(doc);
  }

  console.log("");
  console.log(`Minted ${results.length} invite code${results.length === 1 ? "" : "s"}:`);
  console.log("");
  for (const doc of results) {
    if (urlBase) {
      const sep = urlBase.includes("?") ? "&" : "?";
      console.log(`  ${doc.code}   ${urlBase}${sep}invite=${encodeURIComponent(doc.code)}`);
    } else {
      console.log(`  ${doc.code}   uses=${doc.maxUses}  expires=${doc.expiresAt ?? "never"}${doc.notes ? `  notes="${doc.notes}"` : ""}`);
    }
  }
  console.log("");
}

main().catch((e) => {
  console.error("[FATAL]", (e && e.stack) || e);
  process.exit(1);
});
