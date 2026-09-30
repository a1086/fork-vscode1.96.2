@echo off
setlocal EnableExtensions

set "TARGET=D:\project\vscode-100.0"
set "DRY="
set "FORCE="
set "TARGETSET="

:parse
if "%~1"=="" goto run
if /I "%~1"=="DRY" (
    set "DRY=-DryRun"
    shift
    goto parse
)
if /I "%~1"=="FORCE" (
    set "FORCE=-Force"
    shift
    goto parse
)
if not defined TARGETSET (
    set "TARGET=%~1"
    set "TARGETSET=1"
)
shift
goto parse

:run
echo Script folder: %~dp0
echo Target repo  : %TARGET%
echo.
rem Use -File (not -Command "... | Tee-Object"): Write-Host output never enters
rem the pipeline, so Tee-Object only captured one line into apply.log.
rem Redirect at the cmd level instead, then show the log when finished.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0apply_patches.ps1" -Target "%TARGET%" %DRY% %FORCE% > "%~dp0apply.log" 2>&1
type "%~dp0apply.log"
echo.
echo Done. Full output saved to apply.log in this folder.
pause
