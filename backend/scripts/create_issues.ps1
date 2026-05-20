$ErrorActionPreference = "Stop"
$gh = "C:\Program Files\GitHub CLI\gh.exe"
$repo = "HobbyIQ/HobbyIQ-V1"

$issue1 = & $gh issue create -R $repo `
  --title "compiq: vintage pricing produces fractional cents (/19 division artifact); FMV may be derived from incorrect computation" `
  --body-file "$env:TEMP\issue1_body.md" `
  --label "bug" --label "compiq" --label "needs-investigation"
Write-Host "ISSUE1: $issue1"

$issue2 = & $gh issue create -R $repo `
  --title "compiq: crossParallelAnchor momentum-lift over-discounts cards with low sale frequency by applying -35% clamp to stale-but-stable values" `
  --body-file "$env:TEMP\issue2_body.md" `
  --label "bug" --label "compiq" --label "design-question"
Write-Host "ISSUE2: $issue2"

$issue3 = & $gh issue create -R $repo `
  --title "compiq: neighborSynthesis under-prices autograph cards when no direct auto comps exist; base-to-auto multiplier produces unrealistically low values" `
  --body-file "$env:TEMP\issue3_body.md" `
  --label "bug" --label "compiq" --label "needs-investigation"
Write-Host "ISSUE3: $issue3"
