@echo off
setlocal EnableExtensions
set "TARGET=D:\project\vscode"
set "DRY="
set "ARG1=%~1"
if /I "%ARG1%"=="DRY" (
    set "DRY=-DryRun"
    if not "%~2"=="" ( set "TARGET=%~2" )
) else (
    if not "%ARG1%"=="" ( set "TARGET=%ARG1%" )
)
echo Target repo: %TARGET%
if defined DRY echo [DRY RUN - no changes will be made]
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0apply_patches.ps1" -Target "%TARGET%" %DRY%
pause
