$ErrorActionPreference = "Continue"
$gh = "C:\Program Files\GitHub CLI\gh.exe"
$repo = "HobbyIQ/HobbyIQ-V1"

Write-Host "=== existing labels (filtered) ==="
& $gh label list -R $repo --limit 200 | Select-String -Pattern "bug|compiq|needs-investigation|design-question"

Write-Host ""
Write-Host "=== ensure labels ==="
$labels = @(
  @{name="compiq"; color="0E8A16"; desc="CompIQ pricing engine"},
  @{name="needs-investigation"; color="FBCA04"; desc="Needs further investigation"},
  @{name="design-question"; color="D4C5F9"; desc="Open design question"}
)
foreach ($l in $labels) {
  & $gh label create $l.name -R $repo --color $l.color --description $l.desc 2>&1 | Out-Null
}
Write-Host "label ensure done."
