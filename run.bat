@echo off
REM SMITE 2 Calculator — one-click launcher.
REM
REM Modes (all paths support live code reload where applicable):
REM   run.bat                 Local prod. Builds UI, serves dist on :4455, opens browser.
REM   run.bat dev             Local dev. Vite (HMR) on :5173 + API-watch on :4455.
REM   run.bat nobuild         Serve existing dist/ without rebuilding.
REM   run.bat tunnel          Remote prod via Cloudflare Tunnel. Built UI, stable.
REM   run.bat tunnel:dev      Remote DEV via Cloudflare Tunnel. Vite HMR + API-watch.
REM                            Your teammate sees your edits live as you save files.
REM   run.bat tunnel:ssh      Remote prod via localhost.run (SSH, no install).
REM   run.bat tunnel:ssh:dev  Remote DEV via localhost.run.
REM
REM Env overrides:
REM   APP_PORT   API + prod-UI port (default 4455)
REM   VITE_PORT  Vite dev port (default 5173)

setlocal enabledelayedexpansion
cd /d "%~dp0"

if "%APP_PORT%"==""  set APP_PORT=4455
if "%VITE_PORT%"=="" set VITE_PORT=5173

set MODE=%~1
if "%MODE%"=="" set MODE=prod

if /i "%MODE%"=="dev"            goto :dev
if /i "%MODE%"=="nobuild"        goto :serve
if /i "%MODE%"=="tunnel"         goto :tunnel_prod
if /i "%MODE%"=="tunnel:dev"     goto :tunnel_dev
if /i "%MODE%"=="tunnel:ssh"     goto :tunnel_ssh_prod
if /i "%MODE%"=="tunnel:ssh:dev" goto :tunnel_ssh_dev

REM Default: prod local.
echo [run.bat] Building React UI...
call npm run app:build
if errorlevel 1 ( echo [run.bat] Build failed. & pause & exit /b 1 )

:serve
echo.
echo [run.bat] Serving on http://localhost:%APP_PORT%/
start "" "http://localhost:%APP_PORT%/"
call npm run app
goto :eof


:dev
echo.
echo [run.bat] Local dev mode. Vite on :%VITE_PORT% (HMR), API-watch on :%APP_PORT%.
start "SMITE2 API"  cmd /k "set APP_PORT=%APP_PORT% && npm run app:watch"
timeout /t 2 /nobreak >nul
start "" "http://localhost:%VITE_PORT%/"
call npm run dev
goto :eof


:tunnel_prod
call :need_cloudflared || pause & exit /b 1
if not exist "%~dp0dist\index.html" (
  echo [run.bat] No dist/ - building UI first...
  call npm run app:build || ( echo Build failed. & pause & exit /b 1 )
)
echo.
echo [run.bat] Remote PROD via Cloudflare Tunnel. Teammate opens the printed URL.
start "SMITE2 API"  cmd /k "set APP_PORT=%APP_PORT% && npm run app"
timeout /t 3 /nobreak >nul
echo.
"%CLOUDFLARED%" tunnel --url http://localhost:%APP_PORT%
goto :eof


:tunnel_dev
call :need_cloudflared || pause & exit /b 1
echo.
echo [run.bat] Remote DEV via Cloudflare Tunnel.
echo    Vite (HMR) on :%VITE_PORT%, API-watch on :%APP_PORT%.
echo    Teammate's browser hot-reloads when you save files.
start "SMITE2 API"  cmd /k "set APP_PORT=%APP_PORT% && npm run app:watch"
timeout /t 2 /nobreak >nul
start "SMITE2 VITE" cmd /k "npm run dev"
timeout /t 3 /nobreak >nul
echo.
"%CLOUDFLARED%" tunnel --url http://localhost:%VITE_PORT%
goto :eof


:tunnel_ssh_prod
if not exist "%~dp0dist\index.html" (
  echo [run.bat] No dist/ - building UI first...
  call npm run app:build || ( echo Build failed. & pause & exit /b 1 )
)
start "SMITE2 API"  cmd /k "set APP_PORT=%APP_PORT% && npm run app"
timeout /t 3 /nobreak >nul
echo.
echo [run.bat] Remote PROD via localhost.run. Copy the https:// URL it prints.
ssh -R 80:localhost:%APP_PORT% -o "StrictHostKeyChecking=accept-new" nokey@localhost.run
goto :eof


:tunnel_ssh_dev
start "SMITE2 API"  cmd /k "set APP_PORT=%APP_PORT% && npm run app:watch"
timeout /t 2 /nobreak >nul
start "SMITE2 VITE" cmd /k "npm run dev"
timeout /t 3 /nobreak >nul
echo.
echo [run.bat] Remote DEV via localhost.run. Copy the https:// URL it prints.
ssh -R 80:localhost:%VITE_PORT% -o "StrictHostKeyChecking=accept-new" nokey@localhost.run
goto :eof


:need_cloudflared
set CLOUDFLARED=
if exist "%~dp0cloudflared.exe" set CLOUDFLARED=%~dp0cloudflared.exe
if "%CLOUDFLARED%"=="" for %%P in (cloudflared.exe) do if not defined CLOUDFLARED if not "%%~$PATH:P"=="" set CLOUDFLARED=%%~$PATH:P
if "%CLOUDFLARED%"=="" (
  echo.
  echo [run.bat] cloudflared.exe not found.
  echo   Option A: place cloudflared.exe next to run.bat
  echo   Option B: install from https://github.com/cloudflare/cloudflared/releases/latest
  echo            (download the "windows-amd64.exe" release, drop next to run.bat)
  echo.
  pause & exit /b 1
)
exit /b 0
