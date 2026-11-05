# Выпуск новой версии: меняет номер версии в трёх файлах, делает коммит и метку
# и отправляет всё на GitHub. Дальше GitHub Actions соберёт и опубликует релиз сам.
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1 0.5.1
param([Parameter(Mandatory = $true)][string]$Version)

$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Версия должна быть вида 0.5.1, а не '$Version'" }
Set-Location (Join-Path $PSScriptRoot '..')

# Напоминание о новых версиях sing-box и GitHub Actions. Выпуск оно не останавливает.
try { & (Join-Path $PSScriptRoot 'check-updates.ps1') } catch { Write-Host "Не удалось проверить обновления: $_" }
Write-Host ""

function Set-Version([string]$Path, [string]$Pattern, [string]$Replacement) {
    $text = [System.IO.File]::ReadAllText((Resolve-Path $Path))
    $regex = [regex]$Pattern
    if (-not $regex.IsMatch($text)) { throw "Не нашёл версию в $Path" }
    $text = $regex.Replace($text, $Replacement, 1)
    [System.IO.File]::WriteAllText((Resolve-Path $Path), $text, (New-Object System.Text.UTF8Encoding $false))
}

Set-Version 'package.json' '"version":\s*"[^"]+"' "`"version`": `"$Version`""
Set-Version 'src-tauri/tauri.conf.json' '"version":\s*"[^"]+"' "`"version`": `"$Version`""
Set-Version 'src-tauri/Cargo.toml' '(?m)^version\s*=\s*"[^"]+"' "version = `"$Version`""

git add -A
git commit -m "ShredingerBox v$Version"
git tag "v$Version"
git push
git push origin "v$Version"

Write-Host ""
Write-Host "Готово. Сборка идёт тут: https://github.com/ThisIsSuigetsu/shredingerbox/actions"
Write-Host "Через 10-15 минут релиз появится, и клиенты предложат обновиться."
