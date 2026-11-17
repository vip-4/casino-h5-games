# Cloudflare Pages Direct Upload script (ASCII only for PowerShell 5.1 compatibility)
$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)

# Credentials are read from environment variables (never hard-coded).
$accountId = $env:CLOUDFLARE_ACCOUNT_ID
$apiToken  = $env:CLOUDFLARE_API_TOKEN
if (-not $apiToken -or -not $accountId) { throw "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN first." }
$project   = "casino-h5-games"
$branch    = "main"
$api       = "https://api.cloudflare.com/client/v4"
$dist      = Join-Path $PSScriptRoot "dist"

function Read-Json($path) { Get-Content $path -Raw | ConvertFrom-Json }
function Write-Json($path, $obj) { [System.IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 8 -Compress), $utf8) }

function Get-AssetHash([string]$path) {
  $ext = [System.IO.Path]::GetExtension($path).TrimStart(".").ToLowerInvariant()
  $content = [System.IO.File]::ReadAllBytes($path)
  $extBytes = [System.Text.Encoding]::UTF8.GetBytes($ext)
  $ms = New-Object System.IO.MemoryStream
  $ms.Write($extBytes, 0, $extBytes.Length)
  $ms.WriteByte(0)
  $ms.Write($content, 0, $content.Length)
  $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($ms.ToArray())
  return -join ($hash[0..15] | ForEach-Object { $_.ToString("x2") })
}

function Get-Mime([string]$ext) {
  $map = @{ html="text/html; charset=utf-8"; htm="text/html; charset=utf-8"; css="text/css; charset=utf-8";
    js="application/javascript; charset=utf-8"; json="application/json; charset=utf-8"; xml="application/xml; charset=utf-8";
    txt="text/plain; charset=utf-8"; svg="image/svg+xml"; md="text/markdown; charset=utf-8" }
  if ($map.ContainsKey($ext)) { return $map[$ext] }
  return "application/octet-stream"
}

Write-Host "[1/4] Fetch upload token..."
$tokenPath = Join-Path $env:TEMP "cf_jwt.json"
$code = curl.exe -s -o $tokenPath -w "%{http_code}" "$api/accounts/$accountId/pages/projects/$project/upload-token" -H "Authorization: Bearer $apiToken"
if ($code -ne 200) { throw "upload-token failed HTTP $code" }
$jwt = (Read-Json $tokenPath).result.jwt
if (-not $jwt) { throw "JWT empty" }

Write-Host "[2/4] Hashing files..."
$manifest = @{}
$assets = @{}
foreach ($f in (Get-ChildItem $dist -File)) {
  $h = Get-AssetHash $f.FullName
  $rel = "/" + $f.Name
  $manifest[$rel] = $h
  if (-not $assets.ContainsKey($h)) {
    $assets[$h] = @{ bytes = [System.IO.File]::ReadAllBytes($f.FullName); ext = $f.Extension.TrimStart(".").ToLowerInvariant() }
  }
}
Write-Host "      manifest: $($manifest.Count) files / $($assets.Count) unique assets"

$missingPath = Join-Path $env:TEMP "cf_missing.json"
$hashBody = @{ hashes = @($assets.Keys) }
$bodyPath = Join-Path $env:TEMP "cf_hashbody.json"
Write-Json $bodyPath $hashBody
$code = curl.exe -s -o $missingPath -w "%{http_code}" -X POST "$api/pages/assets/check-missing" -H "Authorization: Bearer $jwt" -H "Content-Type: application/json" --data-binary "@$bodyPath"
if ($code -ne 200) { throw "check-missing failed HTTP $code" }
$missing = (Read-Json $missingPath).result
if ($null -eq $missing) { $missing = @() }
Write-Host "      missing: $($missing.Count)"

if ($missing.Count -gt 0) {
  Write-Host "[3/4] Uploading assets..."
  $batch = @()
  foreach ($h in $missing) {
    if (-not $assets.ContainsKey($h)) { continue }
    $a = $assets[$h]
    $batch += @{ key = $h; value = [Convert]::ToBase64String($a.bytes); metadata = @{ contentType = (Get-Mime $a.ext) }; base64 = $true }
  }
  $uploadBody = Join-Path $env:TEMP "cf_uploadbody.json"
  Write-Json $uploadBody $batch
  $uploadOut = Join-Path $env:TEMP "cf_uploadresult.json"
  $code = curl.exe -s -o $uploadOut -w "%{http_code}" -X POST "$api/pages/assets/upload" -H "Authorization: Bearer $jwt" -H "Content-Type: application/json" --data-binary "@$uploadBody"
  if ($code -ne 200) { Write-Host (Get-Content $uploadOut -Raw); throw "assets/upload failed HTTP $code" }
  Write-Host "      uploaded"
} else {
  Write-Host "[3/4] All assets cached, skip upload"
}

Write-Host "[4/4] Creating deployment..."
$manifestPath = Join-Path $env:TEMP "cf_manifest_final.json"
Write-Json $manifestPath $manifest
$deployOut = Join-Path $env:TEMP "cf_deploy_final.json"
$headersField = Join-Path $dist "_headers"
$code = curl.exe -s -o $deployOut -w "%{http_code}" -X POST "$api/accounts/$accountId/pages/projects/$project/deployments" -H "Authorization: Bearer $apiToken" -F "manifest=<$manifestPath" -F "branch=$branch" -F "_headers=@$headersField" -F "commit_message=SEO+GEO optimized casino H5 games"
if ($code -ne 200) { Write-Host (Get-Content $deployOut -Raw); throw "deployment failed HTTP $code" }
$r = (Read-Json $deployOut).result
Write-Host "DONE deployment_id=$($r.id)"
Write-Host "URL=$($r.url)"
