@echo off
rem Builds the Windows installer. Electron is bundled inside it, so the people you share it with need nothing else first.
rem Run this on Windows with Node.js 22 or newer installed. Output: dist\TradeDesk-Setup-<version>.exe
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Run start.bat once, which offers to install it, then run this again.
  pause
  exit /b 1
)
call npm install || goto :fail
call npm test || goto :fail
call npm run dist || goto :fail
echo.
echo Done. The installer is in the dist folder.
pause
exit /b 0
:fail
echo.
echo Build failed. Read the messages above.
pause
exit /b 1
