# Portable-версия для Windows: zip с ShredingerBox.exe, ядром и portable.txt,
# по которому клиент хранит все данные в папке data рядом с собой.
# Запускается в GitHub Actions после сборки и загружает zip в релиз.
#   ./scripts/make-portable.ps1 v0.6.1
param([Parameter(Mandatory = $true)][string]$Tag)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$version = $Tag.TrimStart('v')
$out = Join-Path $env:RUNNER_TEMP 'ShredingerBox'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory $out | Out-Null

Copy-Item 'src-tauri/target/release/shredingerbox.exe' (Join-Path $out 'ShredingerBox.exe')
Copy-Item 'src-tauri/binaries/sing-box-x86_64-pc-windows-msvc.exe' (Join-Path $out 'sing-box.exe')
@"
ShredingerBox $version - portable-версия.

Пока этот файл лежит рядом с ShredingerBox.exe, все настройки, подписки и статистика
хранятся в папке data рядом с программой. Папку можно переносить целиком.

Обновление: скачай новый zip со страницы
https://github.com/ThisIsSuigetsu/shredingerbox/releases/latest
и распакуй поверх старой папки - папка data останется.
"@ | Set-Content (Join-Path $out 'portable.txt') -Encoding utf8

$zip = Join-Path $env:RUNNER_TEMP "ShredingerBox_${version}_x64-portable.zip"
Compress-Archive -Path $out -DestinationPath $zip -Force
gh release upload $Tag $zip --clobber
Write-Host "Загружено: $zip"
