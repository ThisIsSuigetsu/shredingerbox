# Скачивает ядро sing-box для Windows той версии, что записана в sing-box.pin, и сверяет SHA256.
# Если архив не совпадает хоть на байт - останавливается с ошибкой, ядро не подменяется.
$ErrorActionPreference = 'Stop'
$pin = @{}
Get-Content (Join-Path $PSScriptRoot 'sing-box.pin') | Where-Object { $_ -match '^\s*([\w-]+)=(\S+)' } | ForEach-Object { $pin[$Matches[1]] = $Matches[2] }
$version = $pin['version']
$name = "sing-box-$version-windows-amd64.zip"
$url = "https://github.com/SagerNet/sing-box/releases/download/v$version/$name"

$tmp = Join-Path $env:TEMP 'shredingerbox-sing-box'
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $tmp | Out-Null
$zip = Join-Path $tmp $name
Write-Host "Скачиваю $name..."
Invoke-WebRequest $url -OutFile $zip -UseBasicParsing
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($hash -ne $pin['windows-amd64']) {
    throw "SHA256 архива sing-box не совпадает с sing-box.pin: ждали $($pin['windows-amd64']), получили $hash"
}
Expand-Archive $zip -DestinationPath $tmp
$exe = Get-ChildItem $tmp -Recurse -Filter 'sing-box.exe' | Select-Object -First 1
$dest = Join-Path $PSScriptRoot '..\src-tauri\binaries\sing-box-x86_64-pc-windows-msvc.exe'
Copy-Item $exe.FullName $dest -Force
Write-Host "Готово: sing-box $version, SHA256 совпал"
