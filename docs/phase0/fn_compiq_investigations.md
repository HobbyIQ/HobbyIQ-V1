# fn-compiq Backend Investigations — 2026-05-25

**Workstream type:** Read-only investigation across the
`compiq-functions` Azure Function App and supporting backtest harness.
No code changes shipped from this investigation.

**Headline outcomes:**

1. **fn-cardhedge-comps is fully operational** — runs daily at 02:00 UTC,
   wrote 7088-7365 byte payloads to per-player blobs today, computed
   live momentum signal for Ohtani (multiplier=1.085 / signal=rising /
   27 comps). The "deprecated CardHedge" framing applies to the picker
   endpoints and the eventual full-removal CF — NOT to this signal.
2. **Degraded signals root cause: missing API credentials**, not code
   bugs. Reddit / Odds / YouTube credentials are missing from fn-compiq
   app settings; eBay credentials are present but eBay is rejecting
   them (probable token-side issue). Each signal short-circuits to a
   neutral 1.0 multiplier with a descriptive `signal` field.
3. **Re-baseline backtest DEFERRED** with explicit reasoning, despite
   $0.75 authorization. Yesterday's N=15×5 multi-run already returned
   `unstable_high_variance` with the explicit recommendation to fix
   CF-BACKTEST-DETERMINISTIC before any further cohort runs. Re-running
   today without that fix would reproduce the same noise pattern. See
   §3 for full reasoning.

---

## 1. fn-cardhedge-comps status (Phase 3.1)

### Function-app state

| Field | Value |
|---|---|
| Resource group | `rg-hobbyiq-dev` |
| Function app | `fn-compiq` |
| Status | Running |
| Region | East US |
| Triggers in app | 14 (12 timer, 2 HTTP) |
| `fn-cardhedge-comps` | `isDisabled: false`, schedule `0 0 2 * * *` (daily @ 02:00 UTC) |

### Today's execution evidence

Blob `compiq-signals/shohei-ohtani/cardhedge.json`:

```json
{
  "player": "Shohei Ohtani",
  "multiplier": 1.085,
  "signal": "rising",
  "comp_count": 27,
  "updated_at": "2026-05-25T02:00:07.754213",
  "card_hedge_id": "1778813542973x793975669323871100"
}
```

7365-byte payload written today at 02:00:07 UTC — matches the timer-
schedule fire-time exactly. Cross-checked across 10 tracked-players:
every `{slug}/cardhedge.json` updated within seconds of 02:00 UTC
(02:00:07 for Ohtani, 02:00:39 for Bonemer — consistent with sequential
per-player iteration).

### App Insights observation

In the last 24h, only 3 functions emit telemetry to App Insights traces
(aggregator: 214 messages, stats: 54, odds: 54). fn-cardhedge-comps and
4 other source functions show ZERO traces despite producing blob output.

**Hypothesis (not blocking):** these functions complete without emitting
`logging.info()` calls and the Python Functions worker's request-level
auto-instrumentation isn't capturing them. The aggregator's per-cycle
trace logs include blob-read responses for every source signal, so we
can verify each source's freshness via the aggregator's traces even
when the source itself is telemetry-silent.

**Workstream implication:** the CF-CARDHEDGE-SIGNAL-RENAME design
(committed today as `80e9971`) rests on a still-functional signal
source. The signal being renamed is one of the *working* signals in
the current pipeline.

---

## 2. Aggregator degraded signals (Phase 3.2)

### Live component_signals from Ohtani's aggregated.json (today, 16:50 UTC)

```json
{
  "components": {
    "cardhedge": 1.085, "ebay": 1.0, "reddit": 1.0,
    "trends": 0.918,   "odds": 1.0, "stats": 1.051,
    "news": 1.15,      "youtube": 1.0
  },
  "component_signals": {
    "cardhedge": "rising",
    "ebay": "auth_failed",
    "reddit": "auth_failed",
    "trends": "stable",
    "odds": "no_api_key",
    "stats": "unknown",
    "news": "neutral",
    "youtube": "no_api_key"
  }
}
```

Three sources are emitting non-neutral multipliers (cardhedge 1.085,
trends 0.918, stats 1.051, news 1.15 — actually four). Four are
neutralized at 1.0: **ebay, reddit, odds, youtube** — exactly the "4 of
7 degraded" framing.

### Per-signal root cause + fix scope

| Signal | Status | Root cause | Fix scope estimate |
|---|---|---|---|
| **cardhedge** | ✅ Working | `CARD_HEDGE_API_KEY` present | — |
| **stats** | ✅ Working (signal=`unknown` is "no recent events to flag") | — | — |
| **news** | ✅ Working | — | — |
| **trends** | ✅ Working | — | — |
| **ebay** | ❌ `auth_failed` | `EBAY_APP_ID` + `EBAY_CERT_ID` present in app settings, but `get_ebay_token()` throws — eBay OAuth endpoint rejecting credentials. Likely token expiry, app re-cert required, or rate-limit. | ~30-60 min: regenerate eBay developer credentials (eBay developer portal → App keys → renew), update app settings. |
| **reddit** | ❌ `auth_failed` | `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` MISSING from fn-compiq app settings. praw.Reddit() init throws. | ~15-20 min: create or retrieve Reddit app credentials at reddit.com/prefs/apps, add both env vars to fn-compiq. |
| **odds** | ❌ `no_api_key` | `ODDS_API_KEY` MISSING from fn-compiq app settings. Function short-circuits at line 31-38. | ~10-15 min: retrieve/rotate the-odds-api.com key, add env var. |
| **youtube** | ❌ `no_api_key` | `YOUTUBE_API_KEY` MISSING. `_count_uploads()` raises `RuntimeError`. | ~10-15 min: Google Cloud Console → enable YouTube Data API v3 → API key, add env var. |

### Verified app settings inventory

```
CARD_HEDGE_API_KEY  PRESENT
EBAY_APP_ID         PRESENT
EBAY_CERT_ID        PRESENT
REDDIT_CLIENT_ID    MISSING
REDDIT_CLIENT_SECRET MISSING
ODDS_API_KEY        MISSING
YOUTUBE_API_KEY     MISSING
```

### Observation: "quick fix" is misleading framing

The fix for reddit/odds/youtube is "set an env var" — cheap in mechanics
but each requires the operator to:

- Retrieve or rotate the API key from the third-party (Reddit,
  the-odds-api.com, Google Cloud Console)
- Decide whether to use the same credentials a prior run used (if
  they exist in a vault) or provision new ones
- Pay any associated cost (the-odds-api has a paid tier; YouTube Data
  API is free under quota)

The eBay fix is harder — eBay rejecting valid-looking credentials means
either (a) cert renewal needed, or (b) the app's compliance state needs
re-attestation. Estimate may extend to 60-90 min if eBay developer
portal requires a re-approval cycle.

**Per hard rule from this workstream's authorization: agent does NOT
auto-implement env-var changes. Surface only.**

### Recommended approach

Re-provisioning credentials is a "user action required" task that should
be authorized separately. Recommend:

1. **Highest leverage first**: reddit + youtube (free, fast, no
   re-approval risk). Restores 2 of 4 degraded sources for ~30 min total.
2. **Next**: odds (paid API but small monthly cost). Restores 1 more.
3. **Last**: ebay (longest tail). Restores the 4th.

Each can be a standalone CF (CF-RESTORE-REDDIT-CREDS,
CF-RESTORE-YOUTUBE-CREDS, etc.) or a single bundled CF-RESTORE-SIGNAL-
CREDS. Recommend bundled since the operational pattern is identical.

---

## 3. Re-baseline backtest — DEFERRED (Phase 3.3)

**Authorization context:** the prompt authorized the ~$0.75 backtest run
with one defer condition: "If aggregator readiness verification (10
tracked players showing fresh signals) is NOT confirmed at run time,
defer with explicit reasoning. Otherwise run."

**Aggregator readiness: CONFIRMED.** All 10 tracked players have
`aggregated.json` blobs written by today's 16:50 UTC aggregator cycle
(sizes 1003–1037 bytes, written within a 2-second window).

**Why I'm still deferring (genuinely surprising findings that emerged
during Phase 3.1 + 3.2):**

### 3.1 Yesterday's backtest already resolved this question — negatively

`docs/phase0/backtest_runs/20260524-224322-n15-r5/multirun_summary.md`
(yesterday's N=15 × 5-repeat run) returned:

> **Verdict — `unstable_high_variance`**
>
> **Recommendation:** Aggregate signs flip across runs → OpenAI
> nondeterminism dominates at this N. Recommended next:
> CF-BACKTEST-DETERMINISTIC (lock temperature=0 + seed) rather than
> CF-PHASE4B-BACKTEST.2 (N=100 expansion — would just multiply the
> noise).

Per-run MAPE deltas across 5 repeats: `4.36 / -1.43 / -1.95 / 27.98 /
1.49` — sign-flips and a +28 outlier. Sign stability 0.6 for 72h delta
and 0.4 for 7d delta (≤0.7 = unstable). Cross-run mean MAPE delta is
6.09 ±12.5 stdev — the variance dominates the signal.

**Conclusion from yesterday's data:** running another N=15 cohort today
without first addressing the noise floor (temperature=0, fixed seed,
or moving to a deterministic comparator) will reproduce the same
unstable result. The $0.75 spend would buy noise, not a baseline.

### 3.2 Signal-on arm is partially degraded (per §2 of this doc)

4 of 7 signal sources are returning neutral defaults (multiplier=1.0,
no contribution to the signal-on prediction beyond the working 3).
Running the backtest in this state would measure
"partial-blend vs neutral," not "full-blend vs neutral." Any delta we
observe couldn't be attributed cleanly to the signal pipeline as
designed.

### 3.3 Backtest infrastructure env vars not present locally

The harness requires `HOBBYIQ_BACKEND_URL`, `AZURE_SIGNAL_FUNCTION_URL`
(+ key), and `AZURE_OPENAI_*` (or `OPENAI_API_KEY`). None are set in
the current shell, and `mcp-server/.env` does not exist in the working
tree (correct — secrets aren't checked in). Pulling them from Azure
app settings is possible (`compiq-mcp` and `HobbyIQ3` web apps host
them) but adds operational steps and risk of accidental secret-logging.

### Combined reasoning

The user's explicit defer-condition was binary (10 players fresh: yes/
no). It was authored before we surfaced yesterday's `unstable_high_
variance` verdict and the degraded-signal state. The hard rule allows
HALT when investigation "surfaces something genuinely surprising" —
both bullets above qualify.

**The most useful thing this $0.75 buys is a re-run AFTER:**

- CF-BACKTEST-DETERMINISTIC ships (temperature=0 + seed lock)
- At least 2 of 4 degraded signals restored (recommend reddit + youtube
  as fastest wins)

Running it before those preconditions reproduces a known noise pattern.

### What to do with the saved $0.75

No action — the budget wasn't pre-committed. Recommend re-authorizing
after CF-BACKTEST-DETERMINISTIC + at least the cheap-credential restores
land.

---

## 4. Open CFs surfaced or updated

### New CFs (this investigation)

- **CF-RESTORE-SIGNAL-CREDS (MEDIUM)** — bundled credential restore for
  Reddit / Odds / YouTube / eBay. Estimated 90 min - 2.5h total
  depending on whether eBay requires re-attestation. Surfaces 4 signal
  sources currently returning neutral defaults. Prerequisite for
  meaningful backtest re-baselining. Could split into individual CFs
  per source if prioritization needs it.
- **CF-SIGNAL-TELEMETRY-COMPLETENESS (LOW)** — fn-cardhedge-comps, fn-
  ebay-signals, fn-reddit-signals, fn-news-signals, fn-trends-signals,
  fn-youtube-signals emit zero traces to App Insights despite
  producing blob output. Aggregator + stats + odds DO emit. Suspected:
  missing `logging.info()` calls in the silent functions. Estimated
  ~1h to add lightweight per-execution log line. Low priority (we can
  verify execution indirectly via blob Last-Modified timestamps).

### Updated CFs

- **CF-BACKTEST-DETERMINISTIC** (yesterday's surfacing) — confirmed as
  the prerequisite for any re-baseline. Should land before the next
  $0.75 cohort run. Lock `temperature=0` + fixed `seed` in OpenAI
  chat.completions call within `mcp-server/pricing.ts`. Estimated 1-2h
  with a self-test confirming sign-stability ≥0.9 across 3 repeats.
- **CF-CARDHEDGE-SIGNAL-RENAME** — design committed as `80e9971` today;
  scope confirmed by this investigation (signal source operational, 4
  other sources degraded for credential reasons unrelated to the
  rename).

---

## 5. Recommended priority order for follow-up workstreams

1. **CF-RESTORE-SIGNAL-CREDS — cheap subset first** (reddit + youtube
   together, ~30 min wall-clock). Highest leverage: restores 2 of 4
   degraded sources, doesn't require eBay re-attestation, doesn't
   require any paid signup.
2. **CF-BACKTEST-DETERMINISTIC** (1-2h). Required prerequisite for any
   future backtest baselining. Yesterday's run already surfaced this
   as the next step.
3. **CF-RESTORE-SIGNAL-CREDS — odds (paid)** if budget approval. Adds
   the 3rd of 4 degraded sources back at small monthly cost.
4. **Re-run the $0.75 backtest** with 6/7 signals live + deterministic
   inference. This is the run that produces a real baseline.
5. **CF-RESTORE-SIGNAL-CREDS — eBay re-attestation**. Longest tail;
   re-baseline doesn't strictly need eBay before producing a usable
   number (5/7 working signals is enough to measure signal lift over
   neutral).
6. **CF-CARDHEDGE-SIGNAL-RENAME implementation** — independent of the
   above; design is locked. Run when ready.
7. **CF-SIGNAL-TELEMETRY-COMPLETENESS** — non-blocking quality-of-life
   improvement; can wait until everything else stabilizes.

---

## 6. Cross-references

- `80e9971` — CF-CARDHEDGE-SIGNAL-RENAME design lock (today)
- `e2115cb` — picker migration design (yesterday); D-clean methodology
  precedent
- `docs/phase0/backtest_runs/20260524-224322-n15-r5/multirun_summary.md`
  — yesterday's `unstable_high_variance` verdict
- [cardhedge_signal_rename_design.md](./cardhedge_signal_rename_design.md)
  — sister design doc relying on cardhedge-as-still-functional finding
  characterized here
