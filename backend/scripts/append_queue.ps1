$path = "$env:TEMP\followup-queue-2026-05-15.md"
$block = @"

## Pricing accuracy followups (2026-05-15 evening)
- [#24](https://github.com/HobbyIQ/HobbyIQ-V1/issues/24) — vintage pricing /19 fractional-cent artifact (Mantle)
- [#25](https://github.com/HobbyIQ/HobbyIQ-V1/issues/25) — crossParallelAnchor momentum-lift -35% clamp over-discounts stale-but-scarce cards (De Vries)
- [#26](https://github.com/HobbyIQ/HobbyIQ-V1/issues/26) — neighborSynthesis base-to-auto multiplier under-prices autographs (Roman Anthony)
- [#21 closed](https://github.com/HobbyIQ/HobbyIQ-V1/issues/21#issuecomment-4464858299) — rolled forward into #25
- [#22 comment](https://github.com/HobbyIQ/HobbyIQ-V1/issues/22#issuecomment-4464858505) — three-path FMV-lag analysis (Trout / De Vries / Anthony)
"@
Add-Content -Path $path -Value $block -Encoding utf8
Write-Host ("appended to " + $path)
Write-Host "--- tail ---"
Get-Content $path | Select-Object -Last 10
