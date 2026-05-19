# CompIQ Azure Functions

Six signal collectors, one aggregator, and one HTTP serve endpoint that
together feed CompIQ's forward-looking pricing engine.

## Layout

```
compiq-functions/
  host.json
  requirements.txt
  local.settings.json.example
  shared/__init__.py            # blob helpers, tracked-player list
  fn-ebay-signals/              # timer, every 4hr
  fn-reddit-signals/            # timer, every 2hr
  fn-trends-signals/            # timer, every 6hr
  fn-odds-signals/              # timer, every 4hr
  fn-stats-signals/             # timer, every 2hr
  fn-news-signals/              # timer, every 3hr
  fn-signal-aggregator/         # timer, every 2hr (after collectors)
  fn-serve-signals/             # HTTP GET /api/signals?player=...
```

Each function folder has:
- `function.json` — Azure binding
- `function.py` — pure signal logic (matches the engineering spec exactly)
- `__init__.py` — Azure entry point, iterates `tracked_players()`

## Required App Settings

```
AZURE_BLOB_CONNECTION_STRING
EBAY_APP_ID
EBAY_CERT_ID
REDDIT_CLIENT_ID
REDDIT_CLIENT_SECRET
ODDS_API_KEY
NEWS_API_KEY
OPENAI_API_KEY
COMPIQ_TRACKED_PLAYERS    # optional, comma-separated; falls back to default 5
```

MLB Stats API and Google Trends require no credentials.

## Blob layout

`compiq-signals/<player-slug>/{ebay,reddit,trends,odds,stats,news,aggregated}.json`

The MCP pricing module reads only `aggregated.json` per player.

## Local development

```powershell
cd compiq-functions
copy local.settings.json.example local.settings.json
# fill in secrets in local.settings.json
func start
```

## Deploy

```powershell
cd compiq-functions
func azure functionapp publish <FUNCTION_APP_NAME> --python
```
