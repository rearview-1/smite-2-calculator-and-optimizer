# Collaboration Plan

Two separate problems need different tools:

## 1. Realtime "is my teammate here right now?"

Git does not solve this. Use one of these:

- VSCode Live Share for shared coding sessions and presence
- Discord plus screen share if you only need awareness
- Supabase Realtime or Liveblocks if the web app itself should show who is editing a shared build

If you want the product to display shared optimizer sessions later, add a dedicated presence provider. Do not try to infer live presence from Git polling.

## 2. Repo sync between two local machines

Use GitHub or another central remote, then:

```powershell
git remote add origin <repo-url>
git branch -M main
git push -u origin main
```

Daily safe flow:

```powershell
git fetch --all --prune
git status --short --branch
git pull --rebase origin main
```

Why this matters:

- `git fetch` is safe and non-destructive
- `git pull --rebase` keeps local history cleaner than repeated merge commits
- background auto-pull is risky because it can rewrite your working tree while you are editing

## Included helper

This repo includes `scripts/watch-remote.ps1`.

It does this:

- fetches the remote on an interval
- shows incoming commits from the tracked branch
- does not auto-merge or auto-pull

Run it with:

```powershell
npm.cmd run sync:watch
```

Or directly:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/watch-remote.ps1
```

## If you want app-level collaboration later

Recommended shape:

- Presence: Supabase Realtime or Liveblocks
- Shared documents: JSON build state keyed by session ID
- Conflict handling: last-write-wins for lightweight controls, CRDT/Yjs only if simultaneous structured edits become common

That keeps the product collaboration layer separate from source-control collaboration, which is the correct boundary.
