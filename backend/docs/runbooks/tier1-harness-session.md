# Tier 1 Production Harness Activation

**Status:** Code fix shipped (PR #218). One-time GitHub Secret provisioning needed to turn the check green.

CF-TIER1-HARNESS-SESSION (2026-06-30). The `Tier 1 Production Harness` CI job has been chronically red since at least 2026-06-29 — every PR fails with `HTTP 401 Missing or invalid x-session-id header`. Per [[tier1-harness-chronic-failure]] memory, the real validity checks (`Backend Unit Tests` + `Pricing Regression Harness`) still cover correctness, so this red has been noise. This runbook turns the noise off.

## Root cause

The harness hits production `/api/compiq/*` routes (`/search`, `/price-by-id`, etc.). All of those are gated by `requireSession` middleware (CF-PAYMENTS-A) which demands an `x-session-id` header. The harness sends only `Content-Type: application/json` — no session.

## Fix (already in code)

The harness now reads `TIER1_HARNESS_SESSION_ID` from the environment and forwards it as `x-session-id`:

- `backend/harness/tier1/_helpers.ts:postJson` — reads env, attaches header when present
- `.github/workflows/regression.yml` — exposes the value from a GitHub Secret

If the secret is unset, the harness fails with a clear "secret missing" message instead of the opaque 401.

## Activation (one-time, Drew's offline action)

### Step 1 — Get a long-lived session-id

Easiest path: sign into your own production iOS app, capture the `x-session-id` from network requests, use that. Caveat: if/when that session expires (Apple sign-in renewal flow), the harness goes red until you re-set the secret.

**Cleaner path (recommended):** create a dedicated `harness@hobbyiq.local` user with a never-expiring or long-rotating session. This requires a small backend support — out of scope for this PR but worth doing if the harness is going to be load-bearing.

For today, the iOS-borrowed session is fine.

### Step 2 — Set the GitHub Secret

```bash
# Via gh CLI:
gh secret set TIER1_HARNESS_SESSION_ID --repo HobbyIQ/HobbyIQ-V1
# Then paste the session-id when prompted.

# Or via web UI:
# Settings → Secrets and variables → Actions → New repository secret
# Name: TIER1_HARNESS_SESSION_ID
# Value: <the session-id from Step 1>
```

### Step 3 — Verify

Push any small change (or re-run the last PR's checks) — the harness step now runs with the secret. If it passes:

- ✅ Tier 1 turns green on every subsequent PR
- ✅ The "chronic red" noise stops, so a real regression actually catches your eye

If it still fails with 401, the session-id rotated. Recapture from iOS, re-set the secret, done.

## Local dev usage

To run the harness from your laptop against prod:

```bash
cd backend
TIER1_HARNESS_SESSION_ID=<your-session-id> npm run test:harness:tier1
```

Without the env var, every case fails with the actionable "secret missing" error — no opaque 401s.

## Rotation / when to re-set the secret

- Session-id expires on the iOS user (Apple sign-in renewal)
- Backend session storage gets reset (rare, only on infra rebuild)
- You want to swap to a dedicated harness user (recommended)

In each case, repeat Step 2.

## Long-lived token bypass (CF-TIER1-HARNESS-TOKEN-BYPASS, PR #219)

Drew's actual setup: a fixed, non-rotating token rather than capturing a real session-id. Shipped in PR #219:

- **Backend middleware (`requireSession.ts`)** — short-circuits before session lookup when `x-session-id` matches `process.env.TIER1_HARNESS_TOKEN`. Authenticates as a synthetic harness user (`userId: "tier1-harness"`, `plan: "pro_seller"`, `email: "tier1-harness@hobbyiq.internal"`).
- **Fail-closed** — if `TIER1_HARNESS_TOKEN` is unset or empty in the backend env, the bypass is unreachable. No accidental enable in dev or other environments.
- **GitHub Secret `TIER1_HARNESS_SESSION_ID`** — the harness sends this value as `x-session-id`. Set to match the backend's `TIER1_HARNESS_TOKEN`.

**One-line activation (Drew's offline step, after PR #219 deploys):**

```bash
az webapp config appsettings set \
  --name HobbyIQ3 \
  --resource-group rg-hobbyiq-dev \
  --settings TIER1_HARNESS_TOKEN=<value-matching-the-github-secret>
```

App Service restarts on settings change → next Tier 1 run authenticates. Verify with the same `gh workflow run "CompIQ Pricing Regression Harness" --ref main` from Step 3 above.

**Rotation:** to rotate, change both the App Service env var AND the GitHub Secret to a new value. They must match.

**Telemetry filter:** any analytics that key off `userId` can exclude harness traffic with `where userId != "tier1-harness"`. The `.internal` TLD in the email also makes filtering trivial.

## Out of scope (follow-ups)

- **HMAC-signed token** — the current bypass is plain string compare. Fine for a CI shared secret; not fine if the token ever leaks beyond CI/App Service.
- **Auto-renewal of a real session-id** — the harness could call an auth-refresh endpoint on startup if/when the backend exposes one. Not relevant under the token-bypass model.

## Related

- [[tier1-harness-chronic-failure]] memory — pre-fix description of the noise.
- [Deploy pattern](deploy-pattern.md) — when this lands on main, no deploy needed (CI-only change).
