# HobbyIQ Azure Deployment Guide

## Inspect deployment ZIP

To build and inspect the deployment ZIP without deploying:

```powershell
./scripts/deploy-backend-zip.ps1 `
  -ResourceGroup "rg-hobbyiq-dev" `
  -AppName "HobbyIQ" `
  -InspectOnly
```

Then manually inspect the ZIP contents:

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::OpenRead((Resolve-Path ".\backend-deploy.zip")).Entries |
  Select-Object FullName, Length |
  Sort-Object FullName |
  Format-Table -Auto
```

Check for dist/src/server.js directly:

```powershell
[System.IO.Compression.ZipFile]::OpenRead((Resolve-Path ".\backend-deploy.zip")).Entries |
  Where-Object { $_.FullName -eq "dist/src/server.js" } |
  Select-Object FullName, Length
```

If dist/src/server.js is missing, the script will print a FAIL message and not deploy.
