@echo off
REM SMITE 2 Calculator — first-time setup.
REM Run this once after cloning. It:
REM   1. Checks that Node, .NET, (optional) Python are installed
REM   2. Installs npm dependencies
REM   3. Clones the CUE4Parse library (used by SmiteAssetProbe)
REM   4. Builds the SmiteAssetProbe binary (needs .NET 8 SDK)
REM   5. Optionally downloads cloudflared.exe for the remote-sync tunnel
REM
REM After this succeeds, use run.bat to launch.

setlocal
cd /d "%~dp0"

echo.
echo =====================================================================
echo  SMITE 2 Calculator - first-time setup
echo =====================================================================
echo.

REM -------- 1. Prereq checks --------

where node >nul 2>&1
if errorlevel 1 (
  echo [setup] ERROR: Node.js not found.
  echo        Install LTS from https://nodejs.org/  (v20 or newer)
  pause & exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo [setup] node  %%v

where npm >nul 2>&1
if errorlevel 1 ( echo [setup] ERROR: npm not found. & pause & exit /b 1 )

where dotnet >nul 2>&1
if errorlevel 1 (
  echo [setup] WARNING: .NET SDK not found. SmiteAssetProbe can't be built.
  echo         Install .NET 8 SDK from https://dotnet.microsoft.com/download
  echo         Continuing anyway; the UI + sim work without the probe.
  set NO_DOTNET=1
) else (
  for /f "tokens=*" %%v in ('dotnet --version') do echo [setup] dotnet %%v
)

where python >nul 2>&1
if errorlevel 1 (
  echo [setup] NOTE: Python not found. Data-mining scripts need Python 3.10+.
  echo         Install from https://python.org/  (optional — the shipped catalogs work without it)
) else (
  for /f "tokens=*" %%v in ('python --version') do echo [setup] %%v
)

echo.

REM -------- 2. npm install --------

echo [setup] Installing Node dependencies (npm ci / npm install)...
if exist package-lock.json (
  call npm ci
) else (
  call npm install
)
if errorlevel 1 ( echo [setup] ERROR: npm install failed. & pause & exit /b 1 )

echo.

REM -------- 3. Clone CUE4Parse (needed by SmiteAssetProbe) --------

if defined NO_DOTNET goto :skip_probe

if not exist "tools\CUE4Parse-src" (
  echo [setup] Cloning CUE4Parse library into tools\CUE4Parse-src ...
  pushd tools
  git clone --depth 1 --recurse-submodules https://github.com/FabianFG/CUE4Parse.git CUE4Parse-src
  popd
  if errorlevel 1 (
    echo [setup] WARNING: CUE4Parse clone failed. SmiteAssetProbe build will fail.
    echo         Verify git is installed and your network lets you reach github.com.
    goto :skip_probe
  )
) else (
  echo [setup] CUE4Parse-src already present — skipping clone.
)

REM -------- 4. Build SmiteAssetProbe --------

echo.
echo [setup] Building SmiteAssetProbe (dotnet build)...
dotnet build tools\SmiteAssetProbe\SmiteAssetProbe.csproj -c Release
if errorlevel 1 (
  echo [setup] WARNING: SmiteAssetProbe build failed. Try running
  echo         `dotnet build tools\SmiteAssetProbe\SmiteAssetProbe.csproj -c Release`
  echo         manually to see the full error.
)

:skip_probe

echo.

REM -------- 5. Optional cloudflared download --------

set /p DOWNLOAD_CF="[setup] Download cloudflared.exe for remote-sync tunnels? [y/N] "
if /i not "%DOWNLOAD_CF%"=="y" goto :done

if exist cloudflared.exe (
  echo [setup] cloudflared.exe already present.
  goto :done
)

echo [setup] Downloading cloudflared.exe from GitHub releases...
powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'cloudflared.exe'"
if errorlevel 1 (
  echo [setup] WARNING: cloudflared download failed. You can grab it manually from:
  echo         https://github.com/cloudflare/cloudflared/releases/latest
) else (
  echo [setup] cloudflared.exe ready.
)

:done

echo.
echo =====================================================================
echo  Setup complete. Next steps:
echo.
echo    run.bat              - local prod, opens browser
echo    run.bat dev          - local dev with hot reload
echo    run.bat tunnel:dev   - live-shared remote dev via Cloudflare Tunnel
echo    run.bat tunnel:ssh   - same, via localhost.run (no install needed)
echo.
echo  See README.md for the full remote-collab guide.
echo =====================================================================
echo.
pause
