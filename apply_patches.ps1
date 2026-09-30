param(
    [string]$Target = 'D:\project\vscode-100.0',
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Test-EqualBytes {
    param([byte[]]$A, [byte[]]$B)
    if ($null -eq $A -or $null -eq $B) { return $false }
    if ($A.Length -ne $B.Length) { return $false }
    for ($i = 0; $i -lt $A.Length; $i++) {
        if ($A[$i] -ne $B[$i]) { return $false }
    }
    return $true
}

function Test-HasNul {
    param([byte[]]$B)
    if ($null -eq $B) { return $false }
    for ($i = 0; $i -lt $B.Length; $i++) {
        if ($B[$i] -eq 0) { return $true }
    }
    return $false
}

function Test-IsCrlf {
    param([byte[]]$B)
    for ($i = 1; $i -lt $B.Length; $i++) {
        if ($B[$i] -eq 10) { return ($B[$i-1] -eq 13) }
    }
    return $false
}

function Convert-ToCrlf {
    param([byte[]]$B)
    $out = New-Object System.IO.MemoryStream
    for ($i = 0; $i -lt $B.Length; $i++) {
        if ($B[$i] -eq 10 -and ($i -eq 0 -or $B[$i-1] -ne 13)) { $out.WriteByte(13) }
        $out.WriteByte($B[$i])
    }
    return $out.ToArray()
}

$here = $PSScriptRoot
if (-not $here) { $here = $PWD.Path }
$patches = Join-Path $here 'patches'

if (-not (Test-Path $patches)) {
    Write-Host 'ERROR: cannot find patches\ folder.'
    exit 1
}
if (-not (Test-Path $Target)) {
    Write-Host "ERROR: target not found: $Target"
    exit 1
}

$baseRoot = Join-Path $patches '_base'
$KeepOnConflict = -not $Force

if ($KeepOnConflict -and -not (Test-Path $baseRoot)) {
    Write-Host "ERROR: missing _base\ at $baseRoot"
    exit 3
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host 'ERROR: git not found on PATH'
    exit 4
}

$allDir = @(Get-ChildItem -Directory -Path $patches -ErrorAction SilentlyContinue)
$commitDirs = @($allDir | Where-Object { $_.Name -notmatch '^_' })

Write-Host '=================================='
Write-Host "Script folder : $here"
Write-Host "Target repo   : $Target"
Write-Host "Commit folders: $($commitDirs.Count)"
Write-Host "Mode          : $(if ($DryRun) { 'DRY RUN' } else { 'APPLY' })"
Write-Host '=================================='
Write-Host ''

if ($commitDirs.Count -eq 0) {
    Write-Host 'WARNING: no commit folders found, nothing to do.'
    exit 1
}

$deletedList = Join-Path $patches '_DELETED.txt'
$deleted = if (Test-Path $deletedList) {
    [System.IO.File]::ReadAllLines($deletedList) | Where-Object { $_.Trim().Length -gt 0 }
} else { @() }

$copied = 0
$skipped = 0
$conflicts = New-Object System.Collections.Generic.List[string]
$failed   = New-Object System.Collections.Generic.List[string]

foreach ($f in ($commitDirs | Sort-Object Name)) {
    $files = Get-ChildItem -File -Recurse -Path $f.FullName |
        Where-Object { $_.Name -ne '_COMMIT_INFO.txt' }

    foreach ($file in $files) {
        $rel = $file.FullName.Substring($f.FullName.Length + 1)
        $dest = Join-Path $Target $rel
        $destDir = Split-Path -Parent $dest

        try {
            if (-not (Test-Path $destDir)) {
                New-Item -ItemType Directory -Path $destDir -Force | Out-Null
            }

            if ($Force) {
                if ($DryRun) { Write-Host "[DRY] overwrite -> $rel"; $copied++; continue }
                [System.IO.File]::Copy($file.FullName, $dest, $true); $copied++; continue
            }

            $patchBytes = [System.IO.File]::ReadAllBytes($file.FullName)
            $basePath = Join-Path $baseRoot ($f.Name + '\' + $rel)
            $hasBase = Test-Path $basePath

            # GUARD: empty patch means failed export, applying it would wipe the target
            if ($patchBytes.Length -eq 0) {
                Write-Host "[GUARD] skip EMPTY patch -> $rel"
                $failed.Add("EMPTY-PATCH: $rel")
                continue
            }

            # new file
            if (-not (Test-Path $dest)) {
                if ($DryRun) { Write-Host "[DRY] new -> $rel"; $copied++; continue }
                [System.IO.File]::Copy($file.FullName, $dest, $true); $copied++; continue
            }

            $destBytes = [System.IO.File]::ReadAllBytes($dest)

            if (Test-EqualBytes $patchBytes $destBytes) { $skipped++; continue }

            $isBinary = $false
            if ($hasBase) {
                $baseBytes = [System.IO.File]::ReadAllBytes($basePath)
                if ((Test-HasNul $destBytes) -or (Test-HasNul $baseBytes) -or (Test-HasNul $patchBytes)) { $isBinary = $true }
            } else {
                if ((Test-HasNul $destBytes) -or (Test-HasNul $patchBytes)) { $isBinary = $true }
            }

            if ($isBinary -or -not $hasBase) {
                if ($hasBase -and (Test-EqualBytes $baseBytes $destBytes)) {
                    if ($DryRun) { Write-Host "[DRY] overwrite -> $rel"; $copied++; continue }
                    [System.IO.File]::Copy($file.FullName, $dest, $true); $copied++
                } else {
                    Write-Host "[CONFLICT] binary/no-base, target kept -> $rel"
                    $conflicts.Add($rel)
                }
                continue
            }

            # text: 3-way merge. git merge-file -p prints the merged result to stdout:
            #   exit 0      clean merge
            #   exit 1..127 number of conflict hunks (output has <<<<<<< ======= >>>>>>>)
            #   exit 255/-1 hard error (e.g. "Cannot merge binary files") - output EMPTY
            # Called via .NET Process (byte-safe): no cmd.exe quoting issues,
            # no PowerShell text-encoding mangling, real exit code, visible stderr.
            $destIsCrlf = Test-IsCrlf $destBytes
            $baseCopy  = $basePath
            $patchCopy = $file.FullName
            $tmpFiles  = New-Object System.Collections.Generic.List[string]
            try {
                # align line endings of base/patch with the target file,
                # otherwise a CRLF target vs LF snapshot drowns the merge in EOL-only conflicts
                if ($destIsCrlf) {
                    if (-not (Test-IsCrlf $baseBytes)) {
                        $baseCopy = [System.IO.Path]::GetTempFileName()
                        [System.IO.File]::WriteAllBytes($baseCopy, (Convert-ToCrlf $baseBytes))
                        $tmpFiles.Add($baseCopy)
                    }
                    if (-not (Test-IsCrlf $patchBytes)) {
                        $patchCopy = [System.IO.Path]::GetTempFileName()
                        [System.IO.File]::WriteAllBytes($patchCopy, (Convert-ToCrlf $patchBytes))
                        $tmpFiles.Add($patchCopy)
                    }
                }

                $psi = New-Object System.Diagnostics.ProcessStartInfo
                $psi.FileName = 'git'
                $psi.Arguments = "merge-file -p `"$dest`" `"$baseCopy`" `"$patchCopy`""
                $psi.UseShellExecute = $false
                $psi.RedirectStandardOutput = $true
                $psi.RedirectStandardError = $true
                $proc = [System.Diagnostics.Process]::Start($psi)
                $ms = New-Object System.IO.MemoryStream
                $proc.StandardOutput.BaseStream.CopyTo($ms)
                $mergeErr = $proc.StandardError.ReadToEnd()
                $proc.WaitForExit()
                $rc = $proc.ExitCode

                # hard error (255/-1) or anything outside the conflict-count range:
                # NEVER write anything over the target in this case
                if ($rc -ne 0 -and ($rc -gt 127 -or $rc -lt 0)) {
                    Write-Host "[FAILED] git merge-file exit $rc -> $rel"
                    if ($mergeErr) { Write-Host "         $($mergeErr.Trim())" }
                    $failed.Add($rel)
                    continue
                }

                # never write an empty merge result over an existing file
                if ($ms.Length -eq 0) {
                    Write-Host "[GUARD] empty merge output -> $rel"
                    if ($mergeErr) { Write-Host "         $($mergeErr.Trim())" }
                    $failed.Add("EMPTY-MERGE: $rel")
                    continue
                }

                if (-not $DryRun) {
                    [System.IO.File]::WriteAllBytes($dest, $ms.ToArray())
                }

                if ($rc -eq 0) {
                    if ($DryRun) { Write-Host "[DRY] merge -> $rel" }
                    $copied++
                } else {
                    $conflicts.Add($rel)
                    if ($DryRun) { Write-Host "[DRY] CONFLICT -> $rel" }
                    else { Write-Host "[CONFLICT] $rel" }
                }
            } finally {
                foreach ($t in $tmpFiles) { Remove-Item $t -Force -ErrorAction SilentlyContinue }
            }

        } catch {
            $failed.Add($rel)
        }
    }
}

$delDone = 0
foreach ($rel in $deleted) {
    $p = Join-Path $Target $rel
    if ($DryRun) { Write-Host "[DRY] delete -> $rel"; $delDone++; continue }
    if (Test-Path $p) {
        try { Remove-Item $p -Force; $delDone++ }
        catch { $failed.Add("DELETE: $rel") }
    }
}

Write-Host ''
Write-Host '=================================='
if ($DryRun) {
    Write-Host "DRY RUN done: merge/apply $copied, skip $skipped, conflict $($conflicts.Count), delete $($deleted.Count)"
} else {
    Write-Host "APPLY done: merged $copied, skipped $skipped, conflicts $($conflicts.Count), deleted $delDone"
}
Write-Host '=================================='

if ($conflicts.Count -gt 0) {
    Write-Host ''
    Write-Host "Conflicting files ($($conflicts.Count)) - markers written inside:"
    $conflicts | ForEach-Object { Write-Host "  - $_" }
    Write-Host ''
    Write-Host 'Search <<<<<<< in VS Code, fix each block, delete the marker lines.'
}

if ($failed.Count -gt 0) {
    Write-Host ''
    Write-Host "Failed $($failed.Count):"
    $failed | ForEach-Object { Write-Host "  - $_" }
    exit 2
}
