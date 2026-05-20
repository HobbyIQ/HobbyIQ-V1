$ErrorActionPreference = "SilentlyContinue"
$reportPath = "C:\Users\dvabu\OneDrive - Just the Boys and Cards LLC\Desktop\HobbyIQ-V1\root-worktree-inventory-2026-05-17.md"
$isoBranches = @('pr/phase3-engine','pr/sourcecitation-schema','pr/phase-3-contract-cleanup','pr/mechanism-1-normalization-fix')
$branches = git for-each-ref --format='%(refname:short)' refs/heads
$statusLines = git status --porcelain
$tracked = @(); $untracked = @()
foreach($line in $statusLines){
  if($line -match '^\?\? '){ $untracked += $line.Substring(3); continue }
  if($line -match '^( M|M |MM| D|D ) '){
    $code = $line.Substring(0,2).Trim()
    $path = $line.Substring(3)
    $tracked += [pscustomobject]@{ Code=$code; Path=$path }
  }
}
$modCount = ($tracked | Where-Object { $_.Code -eq 'M' }).Count
$delCount = ($tracked | Where-Object { $_.Code -eq 'D' }).Count
$untCount = $untracked.Count
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
$stashes = git stash list

$trackedRows = @()
foreach($t in $tracked){
  $path = $t.Path; $code = $t.Code
  $short = (git diff --shortstat origin/main -- "$path").Trim()
  if([string]::IsNullOrWhiteSpace($short)){ $short = if($code -eq 'D'){ 'deleted locally' } else { 'no diff vs main' } }

  if($code -eq 'D'){
    git cat-file -e "origin/main:$path" 2>$null; $existsMain = ($LASTEXITCODE -eq 0)
    if(-not $existsMain){
      $class = 'MATCH_MAIN'
      $reason = 'File absent on origin/main; local deletion aligns with main state.'
    } else {
      $class = 'DELETED'
      $reason = 'Tracked file deleted locally but still exists on origin/main.'
    }
    $trackedRows += [pscustomobject]@{Path=$path;Class=$class;Reason=$reason;Summary=$short}
    continue
  }

  $mainHash = (git rev-parse "origin/main:$path" 2>$null).Trim()
  $workHash = (git hash-object -- "$path").Trim()
  $isMain = (-not [string]::IsNullOrWhiteSpace($mainHash) -and $workHash -eq $mainHash)
  if($isMain){
    $trackedRows += [pscustomobject]@{Path=$path;Class='MATCH_MAIN';Reason='Working file content exactly matches origin/main.';Summary=$short}
    continue
  }

  $matchBranches = @()
  foreach($b in $branches){
    $bh = (git rev-parse "${b}:$path" 2>$null).Trim()
    if(-not [string]::IsNullOrWhiteSpace($bh) -and $bh -eq $workHash){ $matchBranches += $b }
  }

  $dupIso = $matchBranches | Where-Object { $isoBranches -contains $_ }
  if($dupIso.Count -gt 0){
    $trackedRows += [pscustomobject]@{Path=$path;Class='DUPLICATE_OF_ISOLATED_PR';Reason=("Matches committed content in isolated branch(es): " + ($dupIso -join ', '));Summary=$short}
    continue
  }
  if($matchBranches.Count -gt 0){
    $trackedRows += [pscustomobject]@{Path=$path;Class='MATCH_OTHER_BRANCH';Reason=("Matches local branch content: " + ($matchBranches -join ', '));Summary=$short}
    continue
  }

  $ownerLike = ($path -like 'backend/docs/*' -or $path -like 'backend/src/*' -or $path -like '*.swift' -or $path -like 'backend/tests/*')
  $staleLike = ($path -like 'backend/.data/*' -or $path -like 'backend/package-lock.json' -or $path -like 'backend/package.json' -or $path -like 'backend/harness/*')
  if($ownerLike -and -not $staleLike){
    $class='DIVERGENT_OWNER_WORK'
    $reason='Diverges from main/branches and appears to be substantive source or docs work.'
  } elseif($staleLike){
    $class='DIVERGENT_STALE'
    $reason='Diverges from main/branches in local state/data/dependency artifacts likely from iterative runs.'
  } else {
    $class='NEEDS_OWNER_REVIEW'
    $reason='Divergent and ambiguous intent.'
  }
  $trackedRows += [pscustomobject]@{Path=$path;Class=$class;Reason=$reason;Summary=$short}
}

$uBuild=@(); $uScratch=@(); $uOwner=@(); $uOrphan=@(); $uDupIso=@()
foreach($p in $untracked){
  if($p -like 'worktrees/*'){ $uOrphan += $p; continue }
  $isBuild = ($p -like '.data/*' -or $p -like 'backend/.data/*' -or $p -like 'tmp/*' -or $p -like 'backend/tmp/*' -or $p -like 'tmp_extract/*' -or $p -like 'logdownload_*/*' -or $p -like 'webapp-logs/*' -or $p -like '*.log' -or $p -like 'harness-output*.txt' -or $p -like 'unit-suite-output*.txt' -or $p -like '.blobconn.txt')
  $isOwner = ($p -like 'docs/*' -or $p -like 'backend/docs/*' -or $p -like '*.md' -or $p -like 'backend/src/*' -or $p -like 'backend/tests/*' -or $p -like '*.swift' -or $p -like 'frontend/src/*' -or $p -like 'backend/scripts/*' -or $p -like 'backend/data/*' -or $p -like 'mcp-server/*' -or $p -like 'compiq-functions/*')
  if($isBuild){ $uBuild += $p }
  elseif($isOwner){ $uOwner += $p }
  else { $uScratch += $p }

  if(Test-Path $p){
    $wh = (git hash-object -- "$p" 2>$null).Trim()
    if(-not [string]::IsNullOrWhiteSpace($wh)){
      $matches = @()
      foreach($ib in $isoBranches){
        $bh = (git rev-parse "${ib}:$p" 2>$null).Trim()
        if(-not [string]::IsNullOrWhiteSpace($bh) -and $bh -eq $wh){ $matches += $ib }
      }
      if($matches.Count -gt 0){ $uDupIso += ("$p => " + ($matches -join ', ')) }
    }
  }
}

$safe = $trackedRows | Where-Object { $_.Class -in @('MATCH_MAIN','DUPLICATE_OF_ISOLATED_PR') }
$ownerPreserve = $trackedRows | Where-Object { $_.Class -eq 'DIVERGENT_OWNER_WORK' }
$stale = $trackedRows | Where-Object { $_.Class -eq 'DIVERGENT_STALE' }
$needs = $trackedRows | Where-Object { $_.Class -in @('MATCH_OTHER_BRANCH','DELETED','NEEDS_OWNER_REVIEW') }
$countsByClass = $trackedRows | Group-Object Class | Sort-Object Name

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('## Root Worktree Inventory (2026-05-17)')
$lines.Add('')
$lines.Add('### Summary')
$lines.Add("- Modified tracked: $modCount files")
$lines.Add("- Deleted tracked: $delCount files")
$lines.Add("- Untracked: $untCount files")
$lines.Add("- Stashes: $($stashes.Count)")
$lines.Add("- Current branch: $branch")
$lines.Add('')
$lines.Add('### Class Totals')
foreach($g in $countsByClass){ $lines.Add("- $($g.Name): $($g.Count)") }
$lines.Add('')
$lines.Add('### Categorized by recommendation')
$lines.Add('')
$lines.Add('#### Safe to discard (MATCH_MAIN or DUPLICATE_OF_ISOLATED_PR)')
if($safe.Count -eq 0){ $lines.Add('- (none)') } else { foreach($r in $safe){ $lines.Add("- $($r.Path) — $($r.Reason) [$($r.Summary)]") } }
$lines.Add('')
$lines.Add('#### Owner work to preserve (DIVERGENT_OWNER_WORK)')
if($ownerPreserve.Count -eq 0){ $lines.Add('- (none)') } else { foreach($r in $ownerPreserve){ $lines.Add("- $($r.Path) — $($r.Summary). Recommended preservation path: isolate into dedicated PR/worktree.") } }
$lines.Add('')
$lines.Add('#### Stale / probably discardable (DIVERGENT_STALE)')
if($stale.Count -eq 0){ $lines.Add('- (none)') } else { foreach($r in $stale){ $lines.Add("- $($r.Path) — $($r.Summary).") } }
$lines.Add('')
$lines.Add('#### Needs owner review (uncertain)')
if($needs.Count -eq 0){ $lines.Add('- (none)') } else { foreach($r in $needs){ $lines.Add("- $($r.Path) — $($r.Reason) [$($r.Summary)]") } }
$lines.Add('')
$lines.Add('#### Untracked files')
$lines.Add('- Build artifacts to ignore: ' + ($(if($uBuild.Count){$uBuild -join '; '} else {'(none)'})))
$lines.Add('- Possible scratch / discardable: ' + ($(if($uScratch.Count){$uScratch -join '; '} else {'(none)'})))
$lines.Add('- Possible owner work to preserve: ' + ($(if($uOwner.Count){$uOwner -join '; '} else {'(none)'})))
$lines.Add('- Orphaned worktree state: ' + ($(if($uOrphan.Count){$uOrphan -join '; '} else {'(none)'})))
$lines.Add('')
$lines.Add('### Spot-check: duplicates of isolated PR branches')
if($uDupIso.Count -eq 0){ $lines.Add('- No untracked file content matched the four isolated PR branch versions by exact hash.') } else { foreach($d in $uDupIso){ $lines.Add("- $d") } }
$lines.Add('')
$lines.Add('### Stashes')
if($stashes.Count -eq 0){ $lines.Add('- (none)') } else { foreach($s in $stashes){ $lines.Add("- $s — recommendation: inspect before any root cleanup action.") } }
$lines.Add('')
$lines.Add('### Recommended next actions')
$lines.Add("- Files to discard (count): $($safe.Count + $stale.Count)")
$lines.Add("- Files needing preservation as new PRs (count): $($ownerPreserve.Count)")
$lines.Add("- Files needing owner judgment (count): $($needs.Count + $uOwner.Count)")
$lines.Add('- Estimated cleanup time after owner reviews: 60-120 minutes (batch-by-batch in isolated worktrees).')
$lines.Add('')
$lines.Add('### Tracked file detail (full triage)')
foreach($r in $trackedRows){ $lines.Add("- [$($r.Class)] $($r.Path) — $($r.Reason) [$($r.Summary)]") }

Set-Content -Path $reportPath -Value $lines -Encoding UTF8
Write-Output "REPORT_PATH=$reportPath"
Write-Output "TRACKED_TOTAL=$($trackedRows.Count) MOD=$modCount DEL=$delCount UNTRACKED=$untCount"
Write-Output "SAFE=$($safe.Count) OWNER=$($ownerPreserve.Count) STALE=$($stale.Count) NEEDS=$($needs.Count)"
