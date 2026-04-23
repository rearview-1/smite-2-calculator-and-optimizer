# SMITE 2 Calculator &amp; Optimizer

A simulation-driven build calculator for SMITE 2. Runs an actual combat sim against any god, items, rotation, and enemy; reports damage totals, combo timing, DPS curves, time-aware item ramps, and per-source breakdowns. Built for theorycrafters who want ground-truth numbers, not stat-weight heuristics.

Ships with a local web UI, a REST API over the sim engine, and a real-time collaboration layer (Yjs CRDT) so you and a teammate can edit the same build live — locally, on your LAN, or over the internet through a free Cloudflare Tunnel.

## What's built

- **Sim engine** (`src/sim/v3/`). Data-driven resolver for 77 gods × 4 abilities, mined cast-lockout + basic-attack-chain timings, per-god custom handlers for kits like Loki's Flurry channel and Kali's rupture passive, multi-hit DoT/bleed scheduling, chain-aware basic-attack timing, team-comp multi-attacker mode.
- **Data catalogs** (`data/`). Gods (77), items (259), effect tooltips (116), ability timings mined from AnimMontage binaries, ability-audit flags.
- **Data mining pipeline** (`tools/SmiteAssetProbe/` + `scripts/*.py`). C# + CUE4Parse probe that reads SMITE 2's IoStore packs; Python scripts that turn raw exports into the JSON catalogs.
- **Web UI** (`src/App.tsx` + `src/server/appServer.ts`). React + Vite SPA with build config, rotation builder, results panel, damage timeline, DPS sparkline.
- **Collab layer** (`src/collab/`). Yjs CRDT docs over a minimal y-protocols relay. Share a build via URL hash, concurrent edits converge, presence tracking.

Validated totals: Loki full combo 1→3→2→4 returns 1352.92 damage (in-game 1348), Loki `1→AA→2→AA→4→AA→3(cancel)→AA` finishes in 2.91s (user-measured 2.83s).

## Tech stack

| Layer | Tools |
|---|---|
| UI | [React 19](https://react.dev/), [Vite 8](https://vite.dev/), [TypeScript 6](https://www.typescriptlang.org/) |
| Sim | TypeScript, run via [tsx](https://github.com/privatenumber/tsx) (Node ≥ 20) |
| Collab | [Yjs](https://github.com/yjs/yjs), [y-protocols](https://github.com/yjs/y-protocols), [ws](https://github.com/websockets/ws) |
| Data mining | [CUE4Parse](https://github.com/FabianFG/CUE4Parse) (UE asset parsing, .NET 8), Python 3.10+ (stdlib only) |
| Remote sync | [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) (free, preferred) or [localhost.run](https://localhost.run/) (free, SSH-based) |

## First-time setup

Prereqs (install once):

- **Node.js 20 LTS or newer** — https://nodejs.org/
- **Git** — https://git-scm.com/downloads
- **.NET 8 SDK** (only to rebuild data catalogs from game files) — https://dotnet.microsoft.com/download
- **Python 3.10+** (only for data-rebuild scripts) — https://python.org/

Then clone and bootstrap:

```bat
git clone https://github.com/<you>/smite-2-calculator.git
cd smite-2-calculator
setup.bat
```

`setup.bat` will:

1. Verify your prereqs
2. `npm install` Node deps (React, Vite, Yjs, ws, tsx)
3. `git clone` [CUE4Parse](https://github.com/FabianFG/CUE4Parse) into `tools/CUE4Parse-src/` (needed only for the asset probe)
4. `dotnet build` the `SmiteAssetProbe` if .NET is installed
5. Optionally download `cloudflared.exe` for remote-sync tunnels

## Running the app

Everything is driven by `run.bat`:

| Command | What it does |
|---|---|
| `run.bat` | Build UI, serve on `http://localhost:4455/`, open browser. Single-user. |
| `run.bat dev` | Vite dev server (hot module replacement) on `:5173`, API on `:4455`. Single-user. |
| `run.bat nobuild` | Serve existing `dist/` without rebuilding. |
| `run.bat tunnel` | **Remote prod** via Cloudflare Tunnel. Built UI, stable. |
| `run.bat tunnel:dev` | **Remote dev** via Cloudflare Tunnel. Vite HMR + API-watch. Your teammate sees live reloads as you save. |
| `run.bat tunnel:ssh` | Remote prod via localhost.run (no install, uses built-in OpenSSH). |
| `run.bat tunnel:ssh:dev` | Remote dev via localhost.run. |

### Command-line sim (no UI)

```bat
npm run sim
```

Runs the scenarios defined in `src/sim/v3/cli.ts` and prints damage events + totals. Useful for CI / regression testing.

## Syncing with a teammate over the internet

The collab layer uses Yjs — every edit is a CRDT operation that merges cleanly with concurrent edits. Presence is tracked so you see your teammate's "live" indicator in the UI.

### Option A — Cloudflare Tunnel (recommended, free forever)

1. One of you runs:

   ```bat
   run.bat tunnel:dev
   ```

   Cloudflare will print a URL like `https://abc-xyz.trycloudflare.com`.

2. Click **Share build ↗** in the top bar. The app creates a shared build, puts its id in the URL hash (`#build=build-xyz…`), and copies the full link to your clipboard.

3. Send that link to your teammate. They open it in their browser.

4. Both of you now edit the same build. Changes propagate in under 100ms. The **Live** indicator in the top bar shows both usernames.

5. When either of you saves a code file, Vite's HMR pushes the change down the tunnel; both browsers hot-reload while keeping their Yjs session (build state persists on the server).

### Option B — localhost.run (no install)

Same flow, but run `run.bat tunnel:ssh:dev` instead. Uses Windows' built-in OpenSSH client. The URL is printed after the SSH handshake.

### Option C — LAN only (no tunnel)

Run `run.bat dev` on your machine, find your LAN IP (`ipconfig`), and share `http://<your-ip>:5173/#build=<id>` with your teammate. Windows Firewall will usually prompt once to allow it. Requires both machines on the same network.

### Troubleshooting

- **Teammate's browser shows "Blocked request. This host is not allowed."** — Vite's `allowedHosts` needs updating. Add the tunnel hostname to `vite.config.ts`, or use `run.bat tunnel` (built mode) which doesn't require the allowlist.
- **Presence shows only me** — check the top bar: is it green with **Live** and a build id? If not, hit **Share build ↗** to create one. Plain local use doesn't sync.
- **Teammate can't connect after I save a file** — Vite HMR may have disconnected their browser. Ask them to refresh; their Yjs session rejoins the same room automatically.

## Project layout

```
smite-2-calculator/
├── run.bat                     Launcher — all run modes
├── setup.bat                   First-time bootstrap
├── package.json                Node deps + scripts
├── vite.config.ts              Dev-server proxy to app server, tunnel allowedHosts
├── src/
│   ├── App.tsx                 Main 3-column React app
│   ├── index.css               Dark editorial theme (Cormorant + JetBrains Mono)
│   ├── catalog/                Catalog loaders + curves
│   ├── sim/v3/                 Sim engine (runScenario, per-god handlers, item procs)
│   ├── collab/                 Real-time collab (Yjs + y-protocols relay)
│   └── server/appServer.ts     HTTP API + static SPA + WS relay (one port)
├── data/                       Mined JSON catalogs (gods/items/effects/timings)
├── scripts/                    Python data-pipeline scripts
└── tools/SmiteAssetProbe/      C# asset probe (uses CUE4Parse)
```

## Rebuilding data from game files (optional)

If you want to re-mine catalogs from a newer SMITE 2 patch:

1. Install .NET 8 SDK + Python 3.10+.
2. `setup.bat` clones CUE4Parse and builds the probe.
3. Point `SmiteAssetProbe` at your SMITE 2 `Paks` directory (default: `C:\Program Files (x86)\Steam\steamapps\common\SMITE 2\Windows\Hemingway\Content\Paks`).
4. Run:

   ```bat
   npm run probe:smite-files -- --asset-registry
   npm run probe:smite-files -- --anim-timings
   npm run probe:smite-files -- --raw-dump --query=Mon_Offhand
   python scripts/build-gods-catalog.py
   python scripts/build-items-catalog.py
   python scripts/mine-montage-durations.py
   python scripts/build-ability-timings.py
   ```

Note: game assets (`.uasset`, `.pak`, etc.) are Hi-Rez's IP and are `.gitignore`d. You bring your own from your SMITE 2 install.

## Dev notes

- Type-check everything: `npx tsc --noEmit -p tsconfig.app.json`
- Sim regression: `npm run sim` should print 6 validated scenarios including Loki combo (1352.92) and team-comp.
- Collab demo (two CLI "users" on same machine): `npm run collab:server` then `npm run collab:demo`.

## License

MIT. SMITE 2 is a trademark of Hi-Rez Studios; this project is an unofficial theorycrafting tool and is not affiliated with or endorsed by Hi-Rez.
