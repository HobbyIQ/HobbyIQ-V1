# Post-deploy verification: worker (#2226) and HobbyIQ3 (#2221)

Read-only prep. Three queries for the worker deploy, two for the slot swap, plus
what each one proves and what a bad answer looks like.

## 1. "Deploy Worker" — what it does

`.github/workflows/deploy-worker.yml`, single `deploy` job:

```text
0 checkout → 1 setup-node → 2 Install deps → 3 Build
4 Install root zip deps → 5 Create deploy.zip → 6 Login to Azure
7 Deploy to the worker   (azure/webapps-deploy@v3, app hobbyiq3-worker)
8 Update build metadata  (az webapp config appsettings set …)
9 Verify health + sha
```

**It already verifies the sha** — 20 attempts × 15 s, polling
`https://hobbyiq3-worker.azurewebsites.net/api/health` until `build.shaShort`
equals `${GITHUB_SHA:0:7}`, and `::error::` + exit 1 otherwise. So the
"deployed but never came back up" case is covered, and unlike the HobbyIQ3 slot
path before #2206 it does *not* accept a bare 200.

**There is no smoke.** Nothing exercises the drainer, the dedup path, or any
route after the deploy. The verification below is the substitute.

**Two things to know before dispatching:**

1. **Step 8 causes a second restart.** `az webapp config appsettings set` is a
   config write, so App Service recycles the worker again ~45–60 s after
   `webapps-deploy` already did — the exact pair `CF-DEPLOY-RESTARTS-ONCE`
   removed from the HobbyIQ3 deploy on 2026-09-07. It also writes `DEPLOYED_AT`,
   which is the stale-shadowing bug #2207 fixes on the read side. Harmless for
   this deploy; worth retiring on the same reasoning as the API's.
2. **Verify the drainer restarted, not just the process.** See §2c.

**Worker build sha is exposed at `/api/health`**, same shape as the API —
confirmed live:

```text
sha        897d66ad072e8722d5e5363ae1180542d39563fc
shaShort   897d66a
builtAt    2026-09-08T13:06:46Z      <- currently 8 days old
```

After the deploy this must read the new sha. **That is the first check**, and it
is the one the workflow already makes.

## 2. Worker queries — run ~30 min after the deploy

> Sampling is 10%: **always `sum(itemCount)`**, never `count()`.

### 2a. `sold_comps.dedup_timeout` by hour

```kusto
traces
| where timestamp > ago(2h)
| where message has "sold_comps.dedup_timeout"
| extend site = tostring(extract('"site":"([^"]+)"', 1, message))
| summarize timeouts = sum(itemCount) by bin(timestamp, 1h), site
| order by timestamp asc
```

**Expect:** a small non-zero number, concentrated in `cross-partition`. Zero is
*also* a good answer — it means no dedup query exceeded 12 s.

**Bad answer:** thousands per hour. That would mean 12 s is too tight for the
healthy case and rows are being written unverified at scale — back the timeout
out rather than leaving it.

### 2b. Breaker events

```kusto
traces
| where timestamp > ago(2h)
| where message has "staging_drainer.breaker_"
| extend ev = tostring(extract('"event":"([^"]+)"', 1, message))
| project timestamp, ev, message
| order by timestamp asc
```

**Expect:** nothing. The breaker is a safety net, not a routine path.

**If `breaker_open` appears:** the drainer paused — that is the design working,
and `comps_staging` still holds every unpromoted row. Check it is followed by a
`breaker_closed` within a couple of minutes. **`breaker_open` with no
`breaker_closed` after 10 minutes means the container is genuinely unavailable**
and wants a look at `card_catalog` RUs, not a code change.

### 2c. Did the drainer actually restart?

**Do not look for `staging_drainer_started`** — it is `console.log`, which the
prod WARN floor drops before export. Verified: over 7 days App Insights holds
**zero** of them, and only `staging_drainer_tick_error` (a `console.warn`,
5,520 in 7 d) arrives from that module.

Use the absence of *old* behaviour instead:

```kusto
dependencies
| where timestamp > ago(30m)
| where cloud_RoleName == "hobbyiq3-worker"
| where tostring(data) has "sold_comps" or tostring(data) has "card_catalog"
| summarize calls = sum(itemCount),
            slow60 = sumif(itemCount, duration >= 59000),
            p50 = percentile(duration, 50),
            p95 = percentile(duration, 95),
            maxMs = max(duration)
```

**On the new build `maxMs` must be < ~13,000** for dedup calls — the 12 s
`abortSignal` makes a 60 s dependency impossible from those three sites. **A 60 s
row after the deploy means the worker is still on the old build**, and is the
cheapest possible proof of that.

### 2d. The headline: 60 s failure rate, before vs after

```kusto
dependencies
| where cloud_RoleName == "hobbyiq3-worker"
| where tostring(data) has "card_catalog"
| where timestamp > ago(26h)
| extend phase = iff(timestamp < datetime(<DEPLOY_UTC>), "before", "after")
| summarize calls = sum(itemCount),
            slow60 = sumif(itemCount, duration >= 59000),
            p95 = percentile(duration, 95)
        by phase
| extend failPct = round(100.0 * slow60 / calls, 2)
```

Substitute the deploy instant for `<DEPLOY_UTC>`. Compare per-hour rates, not
totals — the windows will differ in length.

**Baseline to beat (7 d, un-sampled):** worker → `card_catalog` 60 s failures
**210,780**, i.e. ~1,250/hour. **Expect `slow60` in the "after" phase to fall to
near zero** for the three bounded sites; a residue is possible from the seven
other `soldCompsStore` queries this PR did not touch, which is itself a useful
number.

## 3. HobbyIQ3 queries — after the slot swap

### 3a. 60 s failures on the webhook, per hour

```kusto
dependencies
| where operation_Name == "POST /api/tca/webhook"
| where timestamp > ago(26h)
| summarize calls = sum(itemCount),
            slow60 = sumif(itemCount, duration >= 59000)
        by bin(timestamp, 1h)
| extend failPct = round(100.0 * slow60 / calls, 2)
| order by timestamp asc
```

**Baseline:** 1,411,860 failures in 7 d, 8.2% of 16,975,370 calls — but bursty,
so read the **per-hour** rate. The eight worst *requests* were ~10M of the
17M, with one issuing 3.8M calls over 370 minutes.

**Expect** the tail to disappear: with the 10-minute batch budget no single
request can still be issuing after 10 minutes, so an hour can no longer inherit
millions of calls from one runaway.

### 3b. Budget-exhausted events

```kusto
traces
| where timestamp > ago(26h)
| where message has "tca.webhook.budget_exhausted"
| extend unprocessed = toint(extract('"unprocessedCount":([0-9]+)', 1, message)),
         elapsed     = toint(extract('"elapsedMs":([0-9]+)', 1, message))
| project timestamp, elapsed, unprocessed, message
| order by timestamp asc
```

**Expect:** a handful at most, each with a small `unprocessedCount`.

**This is the number that matters most in the whole document.** A high
`unprocessedCount` means the budget is dropping real work — rows TCA has already
been acked for. The fix is then to raise the budget or make the batch faster,
**not** to accept the loss. The ids are in the event, so anything unprocessed is
recoverable rather than merely counted.

### 3c. Cross-check: the smoke

The deploy's own smoke covers the pricing routes. Per the merge analysis, the
combined tree changes **basis text and new response fields only** — no
`fairMarketValue`, `rungLabel` or `confidence` moves — so a verdict change in
any smoke case is unexpected and worth reading rather than re-running.

## Validated baselines (run 2026-09-16, pre-deploy)

Every query in this document was executed read-only before the deploy, both to
confirm it parses and to capture the number the "after" run is compared against.

| query | pre-deploy result |
|---|---|
| **2d** worker → card_catalog, 26 h | calls **1,479,440**, slow60 **31,400**, p95 **470 ms**, **2.12%** |
| **3a** webhook, 26 h | calls **3,955,810**, slow60 **101,820**, **2.57%** |
| 2a `sold_comps.dedup_timeout` | **0** (event does not exist yet — expected) |
| 2b `staging_drainer.breaker_*` | **0** (same) |
| 3b `tca.webhook.budget_exhausted` | **0** (same) |

Two notes on reading these:

- **p95 is 470 ms on the worker** while 2.12% of calls hit 60 s. The
  distribution is bimodal — nearly everything is fast and a small tail hangs
  to the ceiling. That is the shape a timeout fixes cleanly, and it is why the
  12 s bound should barely touch the healthy path.
- The three event counts being **0** is the point: they are new in #2221/#2226,
  so any non-zero reading afterwards is unambiguously from the new build. That
  makes them a better "did it deploy?" signal than a version string.

## Ordering

1. Worker deploy → workflow's own sha check must pass.
2. Wait ~30 min → **2c** first (proves the new build is live), then **2a**,
   **2b**, **2d**.
3. Slot swap → **3a**, **3b** after the next webhook deliveries land, which at
   ~5/hour may mean waiting rather than 30 minutes.
