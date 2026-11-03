$ErrorActionPreference = 'Stop'
$headers = @{ 'User-Agent' = 'ShredingerBox' }
# В GitHub Actions есть токен - с ним не упираемся в лимит запросов к API
if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }
$rel = Invoke-RestMethod 'https://api.github.com/repos/SagerNet/sing-box/releases/latest' -Headers $headers
$asset = $rel.assets | Where-Object { $_.name -like '*-windows-amd64.zip' } | Select-Object -First 1
if (-not $asset) { throw 'В релизе не найден архив windows-amd64' }
$tmp = Join-Path $env:TEMP 'shredingerbox-sing-box'
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $tmp | Out-Null
$zip = Join-Path $tmp $asset.name
Write-Host "Скачиваю $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) МБ)..."
Invoke-WebRequest $asset.browser_download_url -OutFile $zip -UseBasicParsing
Expand-Archive $zip -DestinationPath $tmp
$exe = Get-ChildItem $tmp -Recurse -Filter 'sing-box.exe' | Select-Object -First 1
$dest = Join-Path $PSScriptRoot '..\src-tauri\binaries\sing-box-x86_64-pc-windows-msvc.exe'
Copy-Item $exe.FullName $dest -Force
Write-Host "Готово: sing-box $($rel.tag_name)"
