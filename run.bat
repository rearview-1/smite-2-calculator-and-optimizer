@echo off
REM SMITE 2 Calculator - one-click launcher.
REM
REM Modes (all paths support live code reload where applicable):
REM   run.bat                 Local prod. Builds UI, serves dist on :4455, opens browser.
REM   run.bat dev             Local dev. Vite (HMR) on :5173 + API-watch on :4455.
REM                            Also rebuilds dist in watch mode so :4455 and :5173 stay in parity.
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
echo [run.bat] Starting app server on http://localhost:%APP_PORT%/
start "SMITE2 APP" cmd /k "set APP_PORT=%APP_PORT% && npm run app"
call :wait_for_http http://localhost:%APP_PORT%/api/gods 20 || (
  echo [run.bat] App server did not come up on :%APP_PORT%.
  pause & exit /b 1
)
start "" "http://localhost:%APP_PORT%/"
goto :eof


:dev
echo.
echo [run.bat] Local dev mode. Vite on :%VITE_PORT% (HMR), API-watch on :%APP_PORT%.
start "SMITE2 API"  cmd /k "set APP_PORT=%APP_PORT% && npm run app:watch"
call :wait_for_http http://localhost:%APP_PORT%/api/gods 20 || (
  echo [run.bat] API-watch server did not come up on :%APP_PORT%.
  pause & exit /b 1
)
start "SMITE2 DIST" cmd /k "npm run app:build:watch"
start "SMITE2 VITE" cmd /k "set VITE_PORT=%VITE_PORT% && npm run dev"
call :wait_for_http http://localhost:%VITE_PORT%/ 30 || (
  echo [run.bat] Vite dev server did not come up on :%VITE_PORT%.
  pause & exit /b 1
)
start "" "http://localhost:%VITE_PORT%/"
goto :eof


:tunnel_prod
call :need_cloudflared || ( pause & exit /b 1 )
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
call :need_cloudflared || ( pause & exit /b 1 )
echo.
echo [run.bat] Remote DEV via Cloudflare Tunnel.
echo    Vite (HMR) on :%VITE_PORT%, API-watch on :%APP_PORT%.
echo    Teammate's browser hot-reloads when you save files.
echo    dist/ is rebuilt in watch mode too, so the app host stays in sync.
start "SMITE2 API"  cmd /k "set APP_PORT=%APP_PORT% && npm run app:watch"
call :wait_for_http http://localhost:%APP_PORT%/api/gods 20 || (
  echo [run.bat] API-watch server did not come up on :%APP_PORT%.
  pause & exit /b 1
)
start "SMITE2 DIST" cmd /k "npm run app:build:watch"
start "SMITE2 VITE" cmd /k "set VITE_PORT=%VITE_PORT% && npm run dev"
call :wait_for_http http://localhost:%VITE_PORT%/ 30 || (
  echo [run.bat] Vite dev server did not come up on :%VITE_PORT%.
  pause & exit /b 1
)
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
call :wait_for_http http://localhost:%APP_PORT%/api/gods 20 || (
  echo [run.bat] API-watch server did not come up on :%APP_PORT%.
  pause & exit /b 1
)
start "SMITE2 DIST" cmd /k "npm run app:build:watch"
start "SMITE2 VITE" cmd /k "set VITE_PORT=%VITE_PORT% && npm run dev"
call :wait_for_http http://localhost:%VITE_PORT%/ 30 || (
  echo [run.bat] Vite dev server did not come up on :%VITE_PORT%.
  pause & exit /b 1
)
echo.
echo [run.bat] Remote DEV via localhost.run. Copy the https:// URL it prints.
ssh -R 80:localhost:%VITE_PORT% -o "StrictHostKeyChecking=accept-new" nokey@localhost.run
goto :eof


:wait_for_http
set "_WAIT_URL=%~1"
set "_WAIT_TRIES=%~2"
if "%_WAIT_TRIES%"=="" set "_WAIT_TRIES=20"
for /l %%I in (1,1,%_WAIT_TRIES%) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "try { $r = Invoke-WebRequest -UseBasicParsing '%_WAIT_URL%' -TimeoutSec 2; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
  if not errorlevel 1 exit /b 0
  timeout /t 1 /nobreak >nul
)
exit /b 1


:need_cloudflared
REM Accept either the short or the GitHub release filename, in the repo root
REM or on PATH. Plain if/goto structure - avoids cmd parser quirks some shells
REM hit with multi-condition for-loops.
set CLOUDFLARED=
if exist "%~dp0cloudflared.exe" (
  set "CLOUDFLARED=%~dp0cloudflared.exe"
  goto :have_cloudflared
)
if exist "%~dp0cloudflared-windows-amd64.exe" (
  set "CLOUDFLARED=%~dp0cloudflared-windows-amd64.exe"
  goto :have_cloudflared
)
where cloudflared.exe >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%P in ('where cloudflared.exe') do set "CLOUDFLARED=%%P"
  goto :have_cloudflared
)
where cloudflared-windows-amd64.exe >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%P in ('where cloudflared-windows-amd64.exe') do set "CLOUDFLARED=%%P"
  goto :have_cloudflared
)
echo.
echo [run.bat] cloudflared not found.
echo   Option A: place cloudflared.exe (or cloudflared-windows-amd64.exe) next to run.bat
echo   Option B: install from https://github.com/cloudflare/cloudflared/releases/latest
echo            (download "cloudflared-windows-amd64.exe" and drop it next to run.bat)
echo.
pause & exit /b 1

:have_cloudflared
echo [run.bat] Using cloudflared at: %CLOUDFLARED%
exit /b 0
