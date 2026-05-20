$base = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/compiq/search"
$cards = @(
  @{ name = "skenes";  q = "2024 Topps Chrome Paul Skenes" },
  @{ name = "trout";   q = "2011 Topps Mike Trout" },
  @{ name = "judge";   q = "2017 Bowman Aaron Judge" },
  @{ name = "mantle";  q = "1956 Topps Mickey Mantle PSA 7" },
  @{ name = "anthony"; q = "2024 Bowman Chrome Roman Anthony Auto Refractor" },
  @{ name = "devries"; q = "2024 Bowman Chrome Blue Auto Leo De Vries" }
)
foreach ($c in $cards) {
  $out = "$env:TEMP\momentum-investigation-$($c.name).json"
  try {
    $body = @{ query = $c.q } | ConvertTo-Json
    $resp = Invoke-RestMethod -Method POST -Uri $base -ContentType "application/json" -Body $body -TimeoutSec 180
    $resp | ConvertTo-Json -Depth 40 | Out-File -Encoding utf8 $out
    Write-Host ("OK  " + $c.name + " -> " + $out + " (" + (Get-Item $out).Length + " bytes)")
  } catch {
    Write-Host ("ERR " + $c.name + " : " + $_.Exception.Message)
  }
}
