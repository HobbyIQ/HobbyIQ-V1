# APNs Provisioning — HALT for Drew

**Status:** Not provisioned. Push fan-out worker is fully wired end-to-end EXCEPT the APNs send call, which stays stubbed until the three items below land.
**Ownership:** Drew, because two of the three require an Apple Developer account and one requires an App Service settings mutation (which is a HALT-for-confirm surface per the memory rule).

## Why this can't be Claude-driven

- Apple Developer account access requires Drew's personal Apple ID and 2FA.
- The `.p8` auth key download is a one-time event; if leaked or re-issued, existing tokens become invalid across all users.
- Writing the key to App Service settings is a live prod config mutation — per `feedback_live_config_changes_halt_for_confirm.md`, that always needs explicit Drew go.

## What needs to happen

### 1. Create the APNs Auth Key (Apple Developer Console)

1. `developer.apple.com` → Certificates, Identifiers & Profiles → Keys.
2. New Key. Name it something like `HobbyIQ APNs Prod`.
3. Enable **Apple Push Notifications service (APNs)**.
4. Download the `.p8` file. Note the **Key ID** (10 chars) and the **Team ID** (10 chars, top-right of the developer console).
5. Store the `.p8` somewhere safe — Apple only lets you download it once.

### 2. Set the four required App Service settings

Run locally (Drew, from the machine that can auth to Azure):

```powershell
# Read the .p8 into a variable WITHOUT echoing.
$key = Get-Content -Raw path\to\AuthKey_XXXXXX.p8

az webapp config appsettings set `
  --name HobbyIQ3 --resource-group rg-hobbyiq-dev `
  --settings `
    APNS_AUTH_KEY_P8=$key `
    APNS_KEY_ID="<10-char Key ID>" `
    APNS_TEAM_ID="<10-char Team ID>" `
    APNS_BUNDLE_ID="com.hobbyiq.HobbyIQ"
```

- Use `APNS_BUNDLE_ID` = whatever iOS ships with. Confirm before setting.
- `APNS_AUTH_KEY_P8` value is the raw PEM (`-----BEGIN PRIVATE KEY-----` through `-----END PRIVATE KEY-----`). Do NOT base64-encode.
- Do NOT paste the key value into chat, git, or any file. The `$key` variable stays local.

### 3. iOS registers the device token at app launch

Once APNs is provisioned, iOS opens the standard `UIApplication.shared.registerForRemoteNotifications()` flow and posts the resulting device token to a new backend route (yet to be written):

```
POST /api/portfolio/preferences/push-token
Body: { apnsDeviceToken: "<hex string>" }
```

The route calls `setUserPushPreferenceForTests`-style writes on the user doc (a proper route will replace the test helper). iOS should also send `pushOnMajorFlip: true` when the user opts in from the Settings toggle.

## After all three items land

Un-stub the APNs send call in `backend/scripts/verdict-flip-push-fanout.cjs`:

```javascript
// Currently:
console.log(JSON.stringify({
  event: "flip_push_stubbed",
  reason: "APNs SDK not yet configured — see APNS_* env vars in runbook",
}));

// Replace with:
await sendApnsMajorFlip(user.apnsDeviceToken, flip);
```

The `sendApnsMajorFlip` helper lives (future) at `backend/src/services/push/apnsSender.ts`. Signs a JWT with the .p8 key + Key ID + Team ID (ES256), POSTs to `api.push.apple.com/3/device/<token>` with the flip payload as the notification body. Copy: `"Trout '11 Update flipped from BUY to SELL. Tap to review."` Deep-link opens the holding detail sheet.

## Test that it works

After un-stubbing, seed a fake flip on Drew's own player:

1. Cosmos Data Explorer → `verdict_history` container.
2. Insert two docs for the same player one day apart with different verdicts crossing the bull/bear boundary (e.g. `bear` yesterday, `bull` today).
3. Manually invoke the fan-out workflow: `gh workflow run "Verdict Flip Push Fan-out" --ref main`.
4. Verify: Drew's iPhone gets the push within ~30 seconds.

## What NOT to do

- Do NOT check the `.p8` file into git under any name.
- Do NOT hardcode `APNS_KEY_ID` / `APNS_TEAM_ID` in code — always read from env.
- Do NOT run the fan-out worker with `--no-dry-run` before APNs is provisioned. The stub will log the un-stub error, but the intent counts start looking like real sends in the KQL and confuse the observability.
