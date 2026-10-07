@echo off
setlocal
cd /d "%~dp0"
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm not found. Install Node.js LTS from https://nodejs.org/ and reopen the terminal.
  exit /b 1
)
if not exist .env copy .env.example .env >nul
call npm.cmd ci
if errorlevel 1 exit /b 1
call npm.cmd run doctor
