# make_patches.ps1  --  (re)generate patches/ from the fork base to HEAD.
#
# Usage (run from the repo root, i.e. next to this file):
#   .\make_patches.ps1                 full rebuild of patches/ (base..HEAD)
#   .\make_patches.ps1 -Full           same as above (explicit)
#   .\make_patches.ps1 -Incremental    only export commits added since last run
#   .\make_patches.ps1 -Base <hash>    override the fork base commit
#
# Output:  patches/<NNN>-<short>/<original path>  (one folder per commit)
#          patches/_COMMIT_INFO.txt  (per-commit meta)
#          patches/_DELETED.txt      (files removed by the branch)
#          patches/_LAST.txt         (HEAD hash of last export, for incremental)
#          patches/_BASE.txt         (fork base, remembered)
#          patches/INDEX.md          (summary of all commits)
#
# After generating, copy the folder (with apply.bat + apply_patches.ps1) to the
# target machine and run apply.bat there.

param(
    [string]$Base = '',
    [switch]$Full,
    [switch]$Incremental
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$env:LC_ALL = 'C.UTF-8'

$repo = $PWD.Path
$patches = Join-Path $repo 'patches'
$baseFile = Join-Path $patches '_BASE.txt'
$lastFile = Join-Path $patches '_LAST.txt'

# ----- resolve base -----
# base priority: -Base arg  >  patches/_BASE.txt  >  hard-coded default (fabdb6a30b4)
# after upgrading vscode, write the new upstream tag's commit into patches/_BASE.txt
# (or pass -Base <new commit> each time). See PATCH_WORKFLOW.md section "Version upgrade maintenance".
$base = $Base
if (-not $base) {
    if (Test-Path $baseFile) { $base = (Get-Content $baseFile -Encoding UTF8).Trim() }
    else { $base = 'fabdb6a30b4' }   # default fork base (vscode 1.96.2)
}
if (-not $base) { Write-Error 'No base commit. Pass -Base <hash>.'; exit 1 }

# ----- decide mode -----
$mode = 'full'
$range = "$base..HEAD"
$startIdx = 1

if ($Incremental -and -not $Full -and (Test-Path $lastFile)) {
    $last = (Get-Content $lastFile -Encoding UTF8).Trim()
    $isAnc = git merge-base --is-ancestor $last HEAD 2>$null
    if ($LASTEXITCODE -eq 0) {
        $mode = 'incr'
        $range = "$last..HEAD"
        $existing = @(Get-ChildItem -Directory -Path $patches -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^\d{3}-' })
        $startIdx = $existing.Count + 1
        Write-Host "Incremental: exporting $range (starting at #$startIdx)"
    } else {
        Write-Warning "Last exported commit ($last) is no longer an ancestor of HEAD (history rewritten?). Falling back to full rebuild."
        $mode = 'full'
    }
}

if ($mode -eq 'full') {
    if (Test-Path $patches) {
        $ok = $false
        for ($i = 0; $i -lt 5; $i++) {
            try { Remove-Item $patches -Recurse -Force -ErrorAction Stop; $ok = $true; break }
            catch { Start-Sleep -Milliseconds 400 }
        }
        if (-not $ok) {
            # fallback: empty contents item by item
            Get-ChildItem $patches -Force | ForEach-Object { Remove-Item $_.FullName -Recurse -Force }
            if (Test-Path $patches) { cmd /c "rmdir /s /q `"$patches`"" }
        }
    }
    New-Item -ItemType Directory -Path $patches -Force | Out-Null
    Write-Host "Full rebuild: exporting $range"
}

# ----- export commits in the range -----
$commits = git rev-list --reverse $range
$idx = $startIdx - 1
$summary = [System.Collections.Generic.List[string]]::new()
$summary.Add('# Commit Export Index')
$summary.Add("")
$summary.Add("Base: $base  ->  HEAD")
$summary.Add("Total commits in range: $($commits.Count)")
$summary.Add("")

foreach ($c in $commits) {
    $idx++
    $short = (git rev-parse --short $c).Trim()
    $subject = (git log -1 --format=%s $c).Trim()
    $author = (git log -1 --format=%an $c).Trim()
    $date = (git log -1 --format=%ad --date=short $c).Trim()
    $statusLines = git -c core.quotepath=false diff-tree --no-commit-id --name-status -r -M $c

    $dirName = ('{0:D3}-{1}' -f $idx, $short)
    $dir = Join-Path $patches $dirName
    New-Item -ItemType Directory -Path $dir -Force | Out-Null

    $copied = 0
    foreach ($line in $statusLines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $parts = $line -split "`t"
        $st = $parts[0]
        $path = $parts[-1]
        if ($st -eq 'D') { continue }   # deletions handled globally via _DELETED.txt

        $dest = Join-Path $dir $path
        $destDir = Split-Path -Parent $dest
        if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }

        $tmp = [System.IO.Path]::GetTempFileName()
        & cmd /c "git -C `"$repo`" show $c`:`"$path`" > `"$tmp`" 2>nul"
        [System.IO.File]::Copy($tmp, $dest, $true)
        Remove-Item $tmp -Force
        $copied++
    }

    $meta = [System.Collections.Generic.List[string]]::new()
    $meta.Add("Commit : $c")
    $meta.Add("Short  : $short")
    $meta.Add("Subject: $subject")
    $meta.Add("Author : $author")
    $meta.Add("Date   : $date")
    $meta.Add("")
    $meta.Add("Files ($copied changed):")
    foreach ($l in $statusLines) { $meta.Add("  $l") }
    [System.IO.File]::WriteAllLines((Join-Path $dir '_COMMIT_INFO.txt'), $meta, [System.Text.UTF8Encoding]::new($false))

    $summary.Add("## $dirName  ($short)")
    $summary.Add("")
    $summary.Add("- Subject: $subject")
    $summary.Add("- Author : $author   Date: $date")
    $summary.Add("- Files  : $copied changed")
    $summary.Add("")

    Write-Host "[$idx] $short  $subject  -> $copied file(s)"
}

# ----- regeneration that always covers the FULL branch (base..HEAD) -----
$fullCommits = git rev-list --reverse "$base..HEAD"
$delLines = [System.Collections.Generic.List[string]]::new()
foreach ($c in $fullCommits) {
    $raw = git -c core.quotepath=false diff-tree --no-commit-id --name-status -r -M $c
    foreach ($line in $raw) {
        if ($line -match '^D\t(.+)$') { $delLines.Add($Matches[1]) }
    }
}
$delUnique = @($delLines | Sort-Object -Unique)
[System.IO.File]::WriteAllLines((Join-Path $patches '_DELETED.txt'), [string[]]$delUnique, [System.Text.UTF8Encoding]::new($false))

# full INDEX over base..HEAD
$fullSummary = [System.Collections.Generic.List[string]]::new()
$fullSummary.Add('# Commit Export Index')
$fullSummary.Add("")
$fullSummary.Add("Base: $base  ->  HEAD")
$fullSummary.Add("Total commits: $($fullCommits.Count)")
$fullSummary.Add("")
$i = 0
foreach ($c in $fullCommits) {
    $i++
    $short = (git rev-parse --short $c).Trim()
    $subject = (git log -1 --format=%s $c).Trim()
    $fullSummary.Add("## " + $i.ToString('D3') + '-' + $short)
    $fullSummary.Add("- Subject: $subject")
    $fullSummary.Add("")
}
[System.IO.File]::WriteAllLines((Join-Path $patches 'INDEX.md'), $fullSummary, [System.Text.UTF8Encoding]::new($false))

# state files
[System.IO.File]::WriteAllText($baseFile, $base, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($lastFile, (git rev-parse HEAD).Trim(), [System.Text.UTF8Encoding]::new($false))

Write-Host ""
Write-Host "Done. Mode=$mode, exported $($commits.Count) commit(s) this run."
Write-Host "patches/ is ready. Copy it (with apply.bat + apply_patches.ps1) to the target and run apply.bat."
