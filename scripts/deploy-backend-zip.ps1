param(
    [Parameter(Mandatory=$true)]
    [string]$ResourceGroup,
    [Parameter(Mandatory=$true)]
    [string]$AppName,
    [string]$BackendPath = "./backend",
    [string]$ZipPath = "./backend-deploy.zip"
)

Write-Host "[INFO] Building backend at $BackendPath..."
if (Test-Path "$BackendPath/package-lock.json") {
    npm install --prefix $BackendPath
} else {
    npm install --prefix $BackendPath --package-lock-only
}

if (Test-Path "$BackendPath/package.json") {
    $pkg = Get-Content "$BackendPath/package.json" | ConvertFrom-Json
    if ($pkg.scripts.build) {
        npm run build --prefix $BackendPath
    }
}

Write-Host "[INFO] Creating clean ZIP package at $ZipPath..."
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }

$exclude = @("node_modules", ".env", ".env.local", "backend-deploy.zip", "coverage", "test", "tests", "*.log", "*.tmp", "*.DS_Store")

Add-Type -AssemblyName System.IO.Compression.FileSystem
function Add-ToZip($zip, $src, $base) {
    $basePath = (Resolve-Path $src).Path
    Get-ChildItem -Path $src -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($basePath.Length).TrimStart('\','/')
        if ([string]::IsNullOrWhiteSpace($rel)) {
            $rel = $_.Name
        }
        $top = $rel.Split('/')[0]
        if ($top -eq $rel) { $top = $rel.Split('\\')[0] }
        if ($exclude -notcontains $top) {
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel)
        }
    }
}

[System.IO.Compression.ZipArchive]$zip = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
Add-ToZip $zip $BackendPath (Resolve-Path $BackendPath).Path.Length
$zip.Dispose()

Write-Host "[INFO] Deploying ZIP to Azure App Service..."
$deploy = az webapp deploy --resource-group $ResourceGroup --name $AppName --src-path $ZipPath --type zip --restart true --query "{status:status, active:activeDeploymentId}" --output json | ConvertFrom-Json

if ($deploy.status -eq "Success") {
    Write-Host "[PASS] ZIP deploy succeeded."
    Write-Host "[INFO] Smoke test:"
    Write-Host ".\\scripts\\smoke-test-azure.ps1 -BaseUrl \"https://$AppName.azurewebsites.net\""
} else {
    Write-Host "[FAIL] ZIP deploy failed."
    Write-Host $deploy
}
