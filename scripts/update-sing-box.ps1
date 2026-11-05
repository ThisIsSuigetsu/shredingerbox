# Перейти на другую версию sing-box: скачивает архивы Windows и macOS из релиза, сверяет их
# с SHA256, который GitHub сам посчитал при загрузке релиза, и записывает в sing-box.pin.
#   powershell -ExecutionPolicy Bypass -File scripts\update-sing-box.ps1 1.14.5
param([Parameter(Mandatory = $true)][string]$Version)

$ErrorActionPreference = 'Stop'
$Version = $Version.TrimStart('v')
$headers = @{ 'User-Agent' = 'ShredingerBox' }
$rel = Invoke-RestMethod "https://api.github.com/repos/SagerNet/sing-box/releases/tags/v$Version" -Headers $headers
if ($rel.prerelease) { throw "v$Version - предварительная версия, в сборку её не берём" }
Write-Host "sing-box v$Version: опубликован $($rel.published_at), автор релиза $($rel.author.login)"

$tmp = Join-Path $env:TEMP 'shredingerbox-sing-box-update'
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $tmp | Out-Null
$hashes = @{}
foreach ($suffix in 'windows-amd64.zip', 'darwin-arm64.tar.gz') {
    $name = "sing-box-$Version-$suffix"
    $asset = $rel.assets | Where-Object { $_.name -eq $name }
    if (-not $asset) { throw "В релизе нет $name" }
    $file = Join-Path $tmp $name
    Invoke-WebRequest $asset.browser_download_url -OutFile $file -UseBasicParsing
    $hash = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
    if ($asset.digest -and $asset.digest -ne "sha256:$hash") {
        throw "$name не совпадает с хешем от GitHub: $($asset.digest) и sha256:$hash"
    }
    Write-Host "  $name  $hash  (загрузил $($asset.uploader.login))"
    $hashes[$suffix.Split('.')[0]] = $hash
}

$pin = Join-Path $PSScriptRoot 'sing-box.pin'
$head = (Get-Content $pin | Where-Object { $_ -match '^#' }) -join "`n"
$text = "$head`nversion=$Version`nwindows-amd64=$($hashes['windows-amd64'])`ndarwin-arm64=$($hashes['darwin-arm64'])`n"
[System.IO.File]::WriteAllText((Resolve-Path $pin), $text, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Записано в sing-box.pin. Дальше: scripts\get-sing-box.ps1, проверка в start-dev.bat, выпуск."
