@echo off
setlocal EnableExtensions
set "D=%~dp0"

echo ===== 1. WHICH PS1 DOES BAT CALL? =====
findstr /C:"apply_patches.ps1" "%D%apply.bat"
findstr /C:"make_patches.ps1" "%D%apply.bat"
echo (must show apply_patches.ps1, NOT make_patches.ps1)
echo.

echo ===== 2. IS PS1 THE FULL-FILE VERSION? =====
findstr /C:"git merge-file" "%D%apply_patches.ps1"
echo (above line MUST appear; blank = wrong version)
findstr /C:"commits" "%D%apply_patches.ps1"
echo (above MUST be blank; any output = old diff version)
echo.

echo ===== 3. PATCHES NEXT TO SCRIPT? =====
if exist "%D%patches" (echo patches: FOUND) else (echo !!! patches: NOT FOUND)
if exist "%D%patches\_base" (echo _base: FOUND) else (echo !!! _base: MISSING)
for /f %%C in ('dir "%D%patches" /B /AD 2^>nul ^| findstr /R "^[0-9][0-9][0-9]-" ^| find /C /V ""') do echo commit folders: %%C
echo.

echo ===== 4. LOG KEY LINES =====
findstr /C:"Commit folders" /C:"Target repo" /C:"APPLY done" /C:"DRY RUN done" /C:"ERROR" /C:"Cancelled" "%D%apply.log"
echo.

echo ===== 5. TARGET EXISTS? =====
if exist "D:\project\vscode-100.0\src" (echo target src: OK) else (echo !!! target src: MISSING)
pause
