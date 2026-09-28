# One-shot applier: copy all exported commit files from ./patches into a target repo,
# in commit order, then delete files that were removed by the branch.
# NOTE: does NOT need git on the target machine -- it just copies files.
param(
    [string]$Target = 'D:\project\vscode',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$here = $PSScriptRoot
if (-not $here) { $here = $PWD.Path }
$patches = Join-Path $here 'patches'
if (-not (Test-Path $patches)) {
    Write-Error "Cannot find 'patches' next to this script. Keep apply_patches.ps1 together with the patches\ folder."
    exit 1
}
if (-not (Test-Path $Target)) {
    Write-Error "Target repo not found: $Target`nPass the correct path, e.g.  .\apply_patches.ps1 -Target 'D:\path\to\repo'"
    exit 1
}

$deletedList = Join-Path $patches '_DELETED.txt'
$deleted = if (Test-Path $deletedList) {
    [System.IO.File]::ReadAllLines($deletedList, [System.Text.UTF8Encoding]::new($false)) |
        Where-Object { $_.Trim().Length -gt 0 }
} else { @() }

# per-commit folders sorted by name (NNN-<short>) -> applies in chronological order
$folders = Get-ChildItem -Directory -Path $patches | Sort-Object Name
$copied = 0
$failed = [System.Collections.Generic.List[string]]::new()

foreach ($f in $folders) {
    $files = Get-ChildItem -File -Recurse -Path $f.FullName |
        Where-Object { $_.Name -ne '_COMMIT_INFO.txt' }
    foreach ($file in $files) {
        $rel = $file.FullName.Substring($f.FullName.Length + 1)
        $dest = Join-Path $Target $rel
        $destDir = Split-Path -Parent $dest
        if ($DryRun) {
            Write-Host ("[DRY] copy -> {0}" -f $rel)
            $copied++
            continue
        }
        try {
            if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
            [System.IO.File]::Copy($file.FullName, $dest, $true)
            $copied++
        } catch {
            $failed.Add($rel)
        }
    }
}

# apply deletions
$delDone = 0
foreach ($rel in $deleted) {
    $p = Join-Path $Target $rel
    if ($DryRun) {
        Write-Host ("[DRY] delete -> {0}" -f $rel)
        $delDone++
        continue
    }
    if (Test-Path $p) {
        try { Remove-Item $p -Force; $delDone++ }
        catch { $failed.Add("DELETE: $rel") }
    }
}

Write-Host ""
if ($DryRun) {
    Write-Host ("DRY RUN complete. Would copy {0} file(s) and delete {1} file(s)." -f $copied, $deleted.Count)
} else {
    Write-Host ("Applied: copied {0} file(s), deleted {1} file(s)." -f $copied, $delDone)
}
if ($failed.Count -gt 0) {
    Write-Host ("`n{0} operation(s) failed:" -f $failed.Count)
    $failed | ForEach-Object { Write-Host ("  - {0}" -f $_) }
    exit 2
}
