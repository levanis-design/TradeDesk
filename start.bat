@echo off
rem TradeDesk launcher for Windows. Double-click to start the app.
rem First run: checks for Node.js 22 or newer and offers to install it, installs the app's packages, then starts TradeDesk.
rem Use "start.bat debug" to keep the window open and see messages.
setlocal EnableExtensions
cd /d "%~dp0"
title TradeDesk

call :findnode
if defined NODE_OK goto :havenode

echo.
echo TradeDesk needs Node.js 22 or newer, and it was not found on this computer.
where winget >nul 2>nul
if errorlevel 1 (
  echo Windows Package Manager is not available here, so opening the Node.js download page.
  echo Install the LTS version, then run start.bat again.
  start "" "https://nodejs.org/en/download"
  goto :fail
)
choice /c YN /m "Install Node.js LTS now with Windows Package Manager"
if errorlevel 2 goto :fail
winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
rem A fresh install is not on this window's PATH yet, so add its usual folder.
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
call :findnode
if not defined NODE_OK (
  echo.
  echo Node.js was installed but this window cannot see it yet. Close this window and run start.bat again.
  goto :fail
)

:havenode
echo Using Node.js %NODE_FULL%

if exist "node_modules\electron\path.txt" goto :run
echo.
echo First run: installing the app's packages. This downloads about 250 MB and takes a few minutes.
call npm install --no-audit --no-fund
if errorlevel 1 goto :fail
if not exist "node_modules\electron\path.txt" (
  echo.
  echo The packages installed but Electron did not finish downloading. Check your internet connection, then run start.bat again.
  goto :fail
)

:run
if /i "%~1"=="debug" (
  call npm start
  pause
  exit /b %errorlevel%
)
echo Starting TradeDesk...
start "" "node_modules\electron\dist\electron.exe" "."
exit /b 0

:findnode
set "NODE_OK="
set "NODE_FULL="
where node >nul 2>nul
if errorlevel 1 exit /b 0
for /f "delims=" %%v in ('node -p "process.versions.node"') do set "NODE_FULL=%%v"
for /f "delims=." %%m in ("%NODE_FULL%") do set "NODE_MAJOR=%%m"
if %NODE_MAJOR% GEQ 22 set "NODE_OK=1"
exit /b 0

:fail
echo.
echo TradeDesk could not start. Read the messages above. If it keeps failing, run "start.bat debug".
pause
exit /b 1
