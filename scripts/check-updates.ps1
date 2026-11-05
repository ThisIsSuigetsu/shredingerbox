# Есть ли новые версии sing-box и GitHub Actions, закреплённых в сборке. Ничего не меняет -
# только сообщает. release.ps1 вызывает его перед выпуском.
#   powershell -ExecutionPolicy Bypass -File scripts\check-updates.ps1
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..'
$headers = @{ 'User-Agent' = 'ShredingerBox' }
if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }
$found = 0

function Days($date) { [int]((Get-Date) - [datetime]$date).TotalDays }

# sing-box
$pinned = (Get-Content (Join-Path $PSScriptRoot 'sing-box.pin') | Where-Object { $_ -match '^version=' }) -replace '^version=', ''
$rel = Invoke-RestMethod 'https://api.github.com/repos/SagerNet/sing-box/releases/latest' -Headers $headers
$latest = $rel.tag_name.TrimStart('v')
if ($latest -ne $pinned) {
    $found++
    Write-Host "sing-box: в сборке $pinned, вышла $latest ($(Days $rel.published_at) дн. назад) - $($rel.html_url)" -ForegroundColor Yellow
} else {
    Write-Host "sing-box: $pinned - последняя версия"
}

$workflow = Get-Content (Join-Path $root '.github\workflows\release.yml')

# Rust: «toolchain: "1.99.1"» в release.yml
$rust = ($workflow | Where-Object { $_ -match 'toolchain:\s*"?([\d.]+)"?' } | Select-Object -First 1) -replace '.*toolchain:\s*"?([\d.]+)"?.*', '$1'
$rr = Invoke-RestMethod 'https://api.github.com/repos/rust-lang/rust/releases/latest' -Headers $headers
if ($rr.tag_name -ne $rust) {
    $found++
    Write-Host "Rust: в сборке $rust, вышла $($rr.tag_name) ($(Days $rr.published_at) дн. назад)" -ForegroundColor Yellow
} else {
    Write-Host "Rust: $rust - последняя версия"
}

# GitHub Actions: строки вида «uses: owner/repo@<хеш> # v1.2.3»
foreach ($line in $workflow) {
    if ($line -notmatch 'uses:\s*([\w.-]+/[\w.-]+)@([0-9a-f]{40})\s*#\s*(\S+)') { continue }
    $repo, $sha, $tag = $Matches[1], $Matches[2], $Matches[3].TrimEnd(',')
    if ($tag -eq 'stable') {
        $head = Invoke-RestMethod "https://api.github.com/repos/$repo/commits/stable" -Headers $headers
        if ($head.sha -ne $sha) { $found++; Write-Host "${repo}: ветка stable ушла вперёд ($(Days $head.commit.committer.date) дн. назад)" -ForegroundColor Yellow }
        else { Write-Host "${repo}: без изменений" }
        continue
    }
    $r = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers $headers
    if ($r.tag_name -ne $tag) {
        $found++
        Write-Host "${repo}: в сборке $tag, вышла $($r.tag_name) ($(Days $r.published_at) дн. назад)" -ForegroundColor Yellow
    } else {
        Write-Host "${repo}: $tag - последняя версия"
    }
}

# Открытые pull request'ы от Dependabot - их нужно проверить и принять (или закрыть).
$prs = @(Invoke-RestMethod 'https://api.github.com/repos/ThisIsSuigetsu/shredingerbox/pulls?state=open' -Headers $headers |
    Where-Object { $_.user.login -like 'dependabot*' })
foreach ($pr in $prs) {
    $found++
    Write-Host "Dependabot ждёт проверки ($(Days $pr.created_at) дн.): $($pr.title) - $($pr.html_url)" -ForegroundColor Yellow
}
if (-not $prs.Count) { Write-Host "Dependabot: открытых pull request нет" }

if ($found) {
    Write-Host ""
    Write-Host "Есть обновления: $found. Перед обновлением проверь новости о взломах этих проектов," -ForegroundColor Yellow
    Write-Host "а sing-box обновляй через scripts\update-sing-box.ps1." -ForegroundColor Yellow
}
