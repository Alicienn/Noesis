@echo off
title Noesis - laboratoire de recherche autonome
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ est requis : https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installation des dependances...
  call npm install --no-audit --no-fund || goto :error
)

if not exist dist\index.html (
  echo Construction de l'interface...
  call npm run build || goto :error
)

if "%NOESIS_PORT%"=="" set NOESIS_PORT=4317
start "" "http://localhost:%NOESIS_PORT%"
call npx tsx server/index.ts
goto :eof

:error
echo Echec. Voir les messages ci-dessus.
pause
exit /b 1
