# Secret Rotations

Append-only log of secret rotations performed on CompIQ / HobbyIQ infrastructure.
Each entry: secret identifier, rotation timestamp, reason, scope of impact, verification evidence, residual risk.

---

## 2026-05-21 — Storage account keys for `stcompiqfnotgm` and `stcompiqfnotgm2`

**Secrets rotated**

| Resource | Key | Status |
| --- | --- | --- |
| `stcompiqfnotgm2` (rg-hobbyiq-dev, eastus, Standard_LRS) | key1 | renewed (was the leaked credential) |
| `stcompiqfnotgm2` (rg-hobbyiq-dev, eastus, Standard_LRS) | key2 | renewed (used as the swap target) |
| `stcompiqfnotgm` (rg-hobbyiq-dev, centralus, Standard_LRS) | key1 | renewed (precaution — same account family in leaked transcript region) |
| `stcompiqfnotgm` (rg-hobbyiq-dev, centralus, Standard_LRS) | key2 | renewed (precaution) |

**Rotation timestamp**

2026-05-21 (session timezone). All four `az storage account keys renew` calls returned exit 0; resulting key state visible via `az storage account keys list -g rg-hobbyiq-dev -n <account>`.

**Reason for rotation**

The `key1` value of `stcompiqfnotgm2` was rendered to terminal output during a `2026-05-21` Phase 0 audit session and persisted into the VS Code chat transcript file at:

```
c:\Users\dvabu\AppData\Roaming\Code\User\workspaceStorage\774e786536993a97f53ba3ee662ac224\GitHub.copilot-chat\transcripts\9c92d7bc-5292-4d3b-bd15-d5ae3ce25129.jsonl
```

approximately at line range L2491–L2503 of that transcript (a `az storage account show-connection-string` invocation for `stcompiqfnotgm2`). The transcript file is local to the user workstation and not published, but the credential is still considered exposed under standard practice and required immediate rotation. `stcompiqfnotgm` (centralus, currently empty / no containers) appeared in the same transcript region and was rotated on the same precaution principle even though no application references it.

**Scope of impact (settings updated)**

| App | Setting | Form | Updated |
| --- | --- | --- | --- |
| `fn-compiq` | `AzureWebJobsStorage` | standard 4-field | yes |
| `fn-compiq` | `WEBSITE_CONTENTAZUREFILECONNECTIONSTRING` | standard 4-field | yes |
| `fn-compiq` | `AZURE_BLOB_CONNECTION_STRING` | extended 8-field (preserves explicit `BlobEndpoint`/`FileEndpoint`/`QueueEndpoint`/`TableEndpoint`) | yes |
| `compiq-mcp` | `AZURE_BLOB_CONNECTION_STRING` | extended 8-field | yes |

`HobbyIQ3` was scanned and contains no references to either storage account. No other web apps or function apps in `rg-hobbyiq-dev` referenced `stcompiqfnotgm*` (`compiq-mcp` was the only non-fn-compiq consumer).

**Rotation order (zero-downtime hybrid pattern)**

1. Renew `stcompiqfnotgm2.key2` (currently unused → zero impact).
2. Build new connection strings using `key2`. For the extended `AZURE_BLOB_CONNECTION_STRING` form, only the `AccountKey=` segment was substituted — the explicit endpoint URLs were preserved verbatim.
3. Apply 3 settings to `fn-compiq` and 1 setting to `compiq-mcp` via batched `az functionapp config appsettings set` / `az webapp config appsettings set`.
4. Restart both apps; confirm `state == Running` and that all 14 `fn-compiq` functions remain discoverable (this implicitly confirms `WEBSITE_CONTENTAZUREFILECONNECTIONSTRING` authenticated successfully against the file share, since the function host cannot enumerate functions otherwise).
5. Renew `stcompiqfnotgm2.key1` (the leaked key) — instantly invalidates the exposed credential. Apps continue serving on `key2` with no interruption.
6. Renew `stcompiqfnotgm.key1` and `stcompiqfnotgm.key2` (no setting updates needed — account is unreferenced).

**Verification evidence**

- `az functionapp show -g rg-hobbyiq-dev -n fn-compiq --query state` → `Running`
- `az webapp show -g rg-hobbyiq-dev -n compiq-mcp --query state` → `Running`
- `az functionapp function list -g rg-hobbyiq-dev -n fn-compiq` → all 14 functions enumerated
  (fn-backtest-runner, fn-cardhedge-comps, fn-ebay-signals, fn-news-signals, fn-nightly-comp-prefetch, fn-odds-signals, fn-price-floor, fn-reddit-signals, fn-search-intent, fn-serve-signals, fn-signal-aggregator, fn-stats-signals, fn-trends-signals, fn-youtube-signals)
- App Insights query for `AuthenticationFailed` / `AuthorizationFailure` / `403 Forbidden` across `fn-compiq`, `hobbyiq-insights`, `appi-hobbyiq-prod`, `HobbyIQ3` over the 15-minute window post-restart → zero rows on all four components.
- Setting length sanity: standard form 190 chars (matches pre-rotation length); extended form 434 chars (matches pre-rotation length); `AccountName=stcompiqfnotgm2` field unchanged in all four settings.

**Residual risk and follow-ups**

- The leaked `key1` value remains in the local transcript file `9c92d7bc-5292-4d3b-bd15-d5ae3ce25129.jsonl` until the user purges that file. Since the key is now invalid, the residual risk is informational only.
- No SAS tokens were issued from `stcompiqfnotgm2` historically (verified by absence of any `sas` references in app settings); rotating account keys does not invalidate SAS tokens that pre-existed, but none are believed to exist.
- A future hardening item: switch `fn-compiq` and `compiq-mcp` from connection-string auth to a system-assigned managed identity with `Storage Blob Data Contributor` on `stcompiqfnotgm2`. Tracked separately — out of scope for this incident response.

**Operational lesson recorded for future sessions**

The precipitating event (rendering the connection string with full key value to the agent terminal during routine inventory) is the same operational anti-pattern that motivated the W2 META_FINDINGS write-up. Future inventory steps must mask credentials at capture (e.g. only render lengths or hashes, never the raw value) — the rotation procedure documented above already follows this rule.
