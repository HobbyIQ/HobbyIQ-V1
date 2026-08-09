# Portfolio Import Stress Test — Setup + Runbook

**Owner:** Drew Vabulas
**Purpose:** Catch failures in the first-user critical path (loading their existing collection) BEFORE launch
**Prepared:** 2026-08-09

## Why this matters

Portfolio import is the #1 conversion moment for a new signup. If your 500-card CSV chokes the parser, times out on the async job, or dedups wrong, you lose the user in week 1. This has never been stress-tested at real-collection scale.

## Endpoints under test

```
POST /api/portfolioiq/import/preview
POST /api/portfolioiq/import/commit
GET  /api/portfolioiq/import/jobs/:jobId
```

Route file: `backend/src/routes/portfolioiq.routes.ts` (search for `router.post("/import/preview"` around line 1012).

## Test data

Load your own real portfolio. If you don't have a CSV export handy:

**Option A — from your existing HobbyIQ portfolio (if any):**
- Sign in to hobby-iq.com
- Portfolio → Export CSV
- Save as `~/hobbyiq-real-portfolio.csv`

**Option B — from another platform:**
- Card Ladder → Export CSV
- SportsCardCollector → Export CSV
- Beckett Online Price Guide → Export CSV
Save whichever format you already have.

**Option C — synthetic 500-row CSV:**
Generate one via this Node script (paste into a scratch file, run once):

```bash
node -e "
const players = ['Shohei Ohtani','Mike Trout','Justin Herbert','Luka Doncic','Michael Jordan','Ken Griffey Jr','Sandy Koufax','Josh Allen'];
const sets = ['Topps Chrome','Bowman Chrome Prospects','Panini Prizm','Topps Update','Fleer','Bowman Sterling'];
const years = [2018,2019,2020,2021,2022,2023,2024,2025];
const parallels = ['Base','Refractor','Gold Refractor','Blue Wave','Silver Prizm','Auto'];
const rows = ['Year,Set,Player,Card Number,Parallel,Grade,Grader,Cost'];
for (let i = 1; i <= 500; i++) {
  const y = years[i % 8];
  const s = sets[i % 6];
  const p = players[i % 8];
  const cn = 'BCP-' + (100 + i);
  const par = parallels[i % 6];
  const grade = i % 4 === 0 ? '10' : (i % 4 === 1 ? '9' : '');
  const grader = grade ? 'PSA' : '';
  const cost = (Math.floor(Math.random() * 500) + 10) + '.00';
  rows.push([y,s,p,cn,par,grade,grader,cost].join(','));
}
require('fs').writeFileSync('C:/Users/dvabu/hobbyiq-synthetic-500.csv', rows.join('\n'));
console.log('Wrote 501 rows to C:/Users/dvabu/hobbyiq-synthetic-500.csv');
"
```

## Test procedure

### Phase 1: Preview (safe, no writes)

Use your real login session (browser dev tools → copy the x-session-id cookie value).

**PowerShell:**
```powershell
$TOKEN = "<paste session id from browser>"
$CSV = "C:\Users\dvabu\hobbyiq-real-portfolio.csv"  # or synthetic
curl.exe -sL --max-time 120 -X POST "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/portfolioiq/import/preview" `
  -H "x-session-id: $TOKEN" `
  -F "file=@$CSV" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);console.log('rows parsed:', j.rows?.length);console.log('errors:', j.errors?.length);console.log('warnings:', j.warnings?.length);if(j.errors)j.errors.slice(0,5).forEach(e=>console.log(' ',e));}catch{console.log(s.slice(0,500));}});"
```

**Expected result:**
- HTTP 200
- `rows` parsed ~= your CSV row count
- `errors` should be 0 for well-formed CSVs (real ones can have 2-10% error rate for weird rows — that's fine)
- Response returns within 30s for 500 rows, 90s for 5000 rows

**Failure modes to watch for:**
- HTTP 500 → parser crashed on your specific CSV shape → screenshot + share the error
- Timeout → parser is O(n²) on something → back off with a smaller sample first, expand
- All rows return errors → column mapping is wrong, CSV format differs from what backend expects

### Phase 2: Commit (writes to your actual portfolio)

**⚠ This WRITES to your portfolio.** If you've been using HobbyIQ, back up your portfolio first (Export CSV) so you can restore. Or test with a NEW throwaway account.

If safe to proceed:

```powershell
curl.exe -sL --max-time 300 -X POST "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/portfolioiq/import/commit" `
  -H "x-session-id: $TOKEN" `
  -F "file=@$CSV" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);console.log('jobId:', j.jobId);console.log('status:', j.status);}catch{console.log(s.slice(0,500));}});"
```

**Expected result:**
- HTTP 202 (Accepted, async)
- Returns a `jobId` for polling
- Job kicks off in background

Then poll status:

```powershell
$JOB_ID = "<jobId from above>"
curl.exe -sL --max-time 30 "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/portfolioiq/import/jobs/$JOB_ID" `
  -H "x-session-id: $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);console.log(JSON.stringify(j,null,2).slice(0,600));}catch{console.log(s.slice(0,500));}});"
```

Poll every 5s until status = `completed` or `failed`.

**Expected result:**
- Completes in 2-10 min for 500 rows (depends on Cosmos RU + dedup queries per row)
- `completed` state with `stats.inserted`, `stats.duplicates`, `stats.errors`
- ZERO uncaught exceptions

**Failure modes:**
- Job times out (never completes after 15+ min) → async job hang → check App Insights for background exceptions
- `failed` status → error message will describe cause → screenshot + share
- `completed` but 0 rows inserted → dedup logic tagged everything as duplicate → likely a bug in the dedup key

### Phase 3: Verify the write landed

After commit completes:

```powershell
curl.exe -sL --max-time 30 "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/portfolioiq/holdings" `
  -H "x-session-id: $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);console.log('total holdings:', j.holdings?.length ?? '?');}catch{console.log(s.slice(0,300));}});"
```

Should return approximately (imported rows - duplicates) as your total holdings count.

Then open hobby-iq.com/app/portfolio in browser and verify visually:
- Holdings appear
- FMVs populate (may take 1-2 min for backend to resolve each)
- Card images load (may take a while — TCDB image cache warms on first hit)
- No error states

## Success criteria for launch

- ✅ 500-row CSV preview completes in <30s with <5% error rate
- ✅ 500-row CSV commit completes in <10min with 0 uncaught exceptions
- ✅ Holdings visible in web app after commit
- ✅ At least 80% of holdings have FMV populated within 5 min

If any of these fail, DO NOT LAUNCH. Portfolio import is the first-user critical path; broken here = launch failure regardless of everything else working.

## When to escalate

Post the exact error message + a sample CSV row that triggers it. Backend session can trace the failure to a specific parser/dedup/write path.

---

**End of runbook.** Estimated time to run all 3 phases end-to-end: 20-30 min per CSV size. Do this ONCE with your real portfolio + ONCE with a synthetic 500-row CSV before Sept 14.
