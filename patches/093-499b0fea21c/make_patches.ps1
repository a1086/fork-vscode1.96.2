# make_patches.ps1 -- export branch commits as FULL FILE snapshots into patches\
#
# Usage (run in the repo root, next to this file):
#   .\make_patches.ps1                    full rebuild (base..HEAD)
#   .\make_patches.ps1 -Full              same as above
#   .\make_patches.ps1 -Incremental       only export commits since last run
#   .\make_patches.ps1 -Base <hash>       override fork base commit
#
# Output layout:
#   patches\001-<short>\src\vs\...        full file content at that commit
#   patches\_base\001-<short>\src\vs\...  same file at the BASE version
#   patches\_DELETED.txt                  files removed by the branch
#   patches\_BASE.txt / _LAST.txt / INDEX.md

param(
    [string]$Base = '',
    [switch]$Full,
    [switch]$Incremental
)

$ErrorActionPreference = 'Stop'

$repo = $PWD.Path
$patches = Join-Path $repo 'patches'
$baseDir = Join-Path $patches '_base'
$baseFile = Join-Path $patches '_BASE.txt'
$lastFile = Join-Path $patches '_LAST.txt'

# ----- resolve base -----
$base = $Base
if (-not $base) {
    if (Test-Path $baseFile) { $base = (Get-Content $baseFile -Raw).Trim() }
    else { $base = 'fabdb6a30b4' }
}
if (-not $base) {
    Write-Host 'ERROR: no base commit. Use -Base <hash>'
    exit 1
}

# ----- decide mode -----
$mode = 'full'
$range = "$base..HEAD"
$startIdx = 1

if ($Incremental -and -not $Full -and (Test-Path $lastFile)) {
    $last = (Get-Content $lastFile -Raw).Trim()
    & git merge-base --is-ancestor $last HEAD 2>$null
    if ($LASTEXITCODE -eq 0) {
        $mode = 'incr'
        $range = "$last..HEAD"
        $existing = @(Get-ChildItem -Directory -Path $patches -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^\d{3}-' })
        $startIdx = $existing.Count + 1
        Write-Host "Incremental: exporting $range (start at #$startIdx)"
    } else {
        Write-Host 'WARN: last commit is not an ancestor of HEAD, falling back to full'
        $mode = 'full'
    }
}

# ----- safety gate before wiping patches -----
if ($mode -eq 'full' -and (Test-Path $patches)) {
    $n = @(Get-ChildItem -Directory -Path $patches -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -match '^\d{3}-' }).Count
    Write-Host ''
    Write-Host "WARNING: about to DELETE and rebuild patches\ (currently $n commit folders)"
    $ans = Read-Host 'Type YES (uppercase) to confirm'
    if ($ans -ne 'YES') {
        Write-Host 'Cancelled. patches\ untouched.'
        exit 0
    }
}

if ($mode -eq 'full') {
    if (Test-Path $patches) { Remove-Item $patches -Recurse -Force }
    New-Item -ItemType Directory -Path $patches -Force | Out-Null
}

Write-Host "Repo : $repo"
Write-Host "Base : $base"
Write-Host "Mode : $mode"
Write-Host "Range: $range"
Write-Host ""

# ----- export each commit -----
$commits = git rev-list --reverse $range
$idx = $startIdx - 1
$exported = 0

foreach ($c in $commits) {
    $idx++
    $short = (git rev-parse --short $c).Trim()
    $subject = (git log -1 --format=%s $c).Trim()
    $statusLines = git -c core.quotepath=false diff-tree --no-commit-id --name-status -r -M $c

    # correct 3-way merge base for THIS commit = its first parent
    # (the fork base only fits the very first exported commit)
    $parentLine = git rev-list --parents -n 1 $c
    $parentTokens = @($parentLine -split '\s+' | Where-Object { $_ })
    $mergeBase = if ($parentTokens.Count -ge 2) { $parentTokens[1] } else { $base }

    $dirName = ('{0:D3}-{1}' -f $idx, $short)
    $dir = Join-Path $patches $dirName
    New-Item -ItemType Directory -Path $dir -Force | Out-Null

    $copied = 0
    foreach ($line in $statusLines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $parts = $line -split "`t"
        $st = $parts[0]
        $path = $parts[-1]
        if ($st -eq 'D') { continue }

        # for renames/copies the pre-change path lives at the source path
        $baseSidePath = $path
        if ($st -like 'R*' -or $st -like 'C*') { $baseSidePath = $parts[1] }

        $dest = Join-Path $dir $path
        $destDir = Split-Path -Parent $dest
        if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }

        $tmp = [System.IO.Path]::GetTempFileName()
        & cmd /c "git -C `"$repo`" show $c`:`"$path`" > `"$tmp`" 2>nul"
        if ($LASTEXITCODE -eq 0) {
            [System.IO.File]::Copy($tmp, $dest, $true)
            $copied++
        } else {
            Write-Host "  SKIP (export failed): $path"
        }
        Remove-Item $tmp -Force

        $basePath = Join-Path $baseDir ($dirName + '\' + $path)
        $baseDirOf = Split-Path -Parent $basePath
        if (-not (Test-Path $baseDirOf)) { New-Item -ItemType Directory -Path $baseDirOf -Force | Out-Null }
        $tmpB = [System.IO.Path]::GetTempFileName()
        & cmd /c "git -C `"$repo`" show $mergeBase`:`"$baseSidePath`" > `"$tmpB`" 2>nul"
        if ($LASTEXITCODE -eq 0) {
            [System.IO.File]::Copy($tmpB, $basePath, $true)
        }
        Remove-Item $tmpB -Force
    }

    $meta = New-Object System.Collections.Generic.List[string]
    $meta.Add("Commit : $c")
    $meta.Add("Short  : $short")
    $meta.Add("Subject: $subject")
    $meta.Add("")
    $meta.Add("Files ($copied changed):")
    foreach ($l in $statusLines) { $meta.Add("  $l") }
    [System.IO.File]::WriteAllLines((Join-Path $dir '_COMMIT_INFO.txt'), $meta, [System.Text.UTF8Encoding]::new($false))

    $exported++
    Write-Host "[$idx] $short  $subject  -> $copied file(s)"
}

# ----- net deletions (vs base), include rename sources -----
$diffAll = git -c core.quotepath=false diff -M --name-status "$base" HEAD
$del = New-Object System.Collections.Generic.List[string]
foreach ($line in $diffAll) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = $line -split "`t"
    if ($parts[0] -eq 'D') { $del.Add($parts[1]) }
    elseif ($parts[0] -like 'R*') { $del.Add($parts[1]) }
}
$delUnique = @($del | Sort-Object -Unique)
[System.IO.File]::WriteAllLines((Join-Path $patches '_DELETED.txt'), [string[]]$delUnique, [System.Text.UTF8Encoding]::new($false))

# ----- INDEX -----
$fullCommits = git rev-list --reverse "$base..HEAD"
$index = New-Object System.Collections.Generic.List[string]
$index.Add('# Patch Index (full-file snapshot)')
$index.Add("Base: $base -> HEAD")
$index.Add("Total commits: $($fullCommits.Count)")
$index.Add("")
$i = 0
foreach ($c in $fullCommits) {
    $i++
    $s = (git log -1 --format=%s $c).Trim()
    $index.Add("## $i - $s")
}
[System.IO.File]::WriteAllLines((Join-Path $patches 'INDEX.md'), $index, [System.Text.UTF8Encoding]::new($false))

# ----- state -----
[System.IO.File]::WriteAllText($baseFile, $base, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($lastFile, (git rev-parse HEAD).Trim(), [System.Text.UTF8Encoding]::new($false))

Write-Host ""
Write-Host "DONE. Mode=$mode, exported $exported commit(s), deleted list $($delUnique.Count) file(s)."
Write-Host "Copy patches\ next to apply_patches.ps1, then run: apply.bat DRY"
