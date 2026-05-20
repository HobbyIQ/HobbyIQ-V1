$ErrorActionPreference = "Stop"
$gh = "C:\Program Files\GitHub CLI\gh.exe"
$repo = "HobbyIQ/HobbyIQ-V1"

$c21 = & $gh issue comment 21 -R $repo --body-file "$env:TEMP\issue21_comment.md"
Write-Host "ISSUE21 COMMENT: $c21"

& $gh issue close 21 -R $repo --reason completed
Write-Host "ISSUE21 closed."

$c22 = & $gh issue comment 22 -R $repo --body-file "$env:TEMP\issue22_comment.md"
Write-Host "ISSUE22 COMMENT: $c22"
