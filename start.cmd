@echo off
setlocal
cd /d "%~dp0"
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install the Node.js LTS release from https://nodejs.org/
  exit /b 1
)
if not exist node_modules\express\package.json (
  call npm.cmd ci
  if errorlevel 1 exit /b 1
)
node server.js
