@echo off
rem Double-click to open Paste. The daemon keeps running after this window closes.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Paste requires Node.js 20 or newer: https://nodejs.org
  pause
  exit /b 1
)

node bin\launch.js
if errorlevel 1 pause
endlocal
