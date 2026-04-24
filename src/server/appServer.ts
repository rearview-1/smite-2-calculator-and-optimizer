/**
 * Unified local server for the SMITE 2 calculator.
 *
 * One process, one port (default 4455), four things:
 *   1. GET /api/gods           — god catalog (names + ids)
 *   2. GET /api/items          — item catalog (names + internal keys)
 *   3. POST /api/scenarios/run — accept a Scenario JSON, return SimResult
 *   4. WebSocket upgrade       — Yjs relay (same protocol as relayServer.ts)
 *   5. GET /*                  — serves the built React SPA from dist/
 *
 * Run via `npm run app`. run.bat wraps this with a browser open.
 *
 * In dev: run `npm run dev` alongside this server. Vite serves the UI on
 * VITE_PORT (default 5173) and proxies /api + /collab to APP_PORT (default 4455).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, extname, resolve, normalize, relative, isAbsolute } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { URL } from 'node:url'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

import { runScenario, snapshotAttacker, snapshotDefender, inferPrimaryStat } from '../sim/v3/engine.ts'
import { loadGods, loadItems, resolveItemStatsWithOverrides, getAspect, type GodCatalogEntry } from '../catalog/loadCatalogs.ts'
import { itemDisplayName, isDeprecatedItem, shouldPreferItemRecord } from '../catalog/itemEligibility.ts'
import { allGodLockedItems, acornAdaptiveStrength, godLockedItemStatTags } from '../catalog/godLockedItems.ts'
import type { Scenario, SimResult } from '../sim/v3/types.ts'
import type { OptimizeRequest } from '../optimizer/optimize.ts'
import { optimizeParallel } from '../optimizer/parallel.ts'

function envPort(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const PORT = envPort('APP_PORT', 4455)
const APP_PORT_WAS_EXPLICIT = Boolean(process.env.APP_PORT && process.env.APP_PORT.trim())
const VITE_PORT = envPort('VITE_PORT', 5173)
const DIST_DIR = resolve(process.cwd(), 'dist')
const PERSIST_DIR = process.env.COLLAB_PERSIST_DIR
  ? resolve(process.env.COLLAB_PERSIST_DIR)
  : resolve(process.cwd(), 'data', 'collab-rooms')
mkdirSync(PERSIST_DIR, { recursive: true })

function isInsideDir(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// ---------- REST API ----------

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const MAX_BODY_BYTES = 2 * 1024 * 1024  // 2 MB — optimize requests are small

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function logServerError(route: string, err: unknown) {
  const e = err as Error
  console.error(`[api] ${route}: ${e.message}\n${e.stack ?? ''}`)
}

function godSupportsAspect(godId: string, god: GodCatalogEntry): boolean {
  if (getAspect(godId)) return true
  const talentKeys = Object.keys(god.talents ?? {}).filter((key) => /^talent/i.test(key))
  const passiveVariants = Object.values(god.passive.talentVariants ?? {}).filter(Boolean)
  return talentKeys.length > 0 || passiveVariants.length > 0
}

function godAspectDescription(godId: string, god: GodCatalogEntry): string | null {
  const aspect = getAspect(godId)
  if (aspect?.aspect.description) return aspect.aspect.description
  const variants = Object.values(god.passive.talentVariants ?? {}).filter(Boolean)
  return variants[0] ?? null
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/api/')) return false
  // CORS for dev (Vite on VITE_PORT calling us on APP_PORT).
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'content-type')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true }

  try {
    if (url.pathname === '/api/gods' && req.method === 'GET') {
      const gods = loadGods()
      const out = Object.entries(gods).map(([id, g]) => {
        const aspectSupported = godSupportsAspect(id, g)
        return {
          id, name: g.god,
          primaryStat: inferPrimaryStat(g),
          aspectSupported,
          aspectKey: aspectSupported ? `${id}.aspect` : null,
          aspectLabel: aspectSupported ? 'Aspect' : null,
          aspectDescription: godAspectDescription(id, g),
        }
      })
      json(res, 200, out.sort((a, b) => a.name.localeCompare(b.name)))
      return true
    }

    if (url.pathname === '/api/items' && req.method === 'GET') {
      const items = loadItems()
      const bestByName = new Map<string, { key: string; item: typeof items[keyof typeof items] }>()
      for (const [key, item] of Object.entries(items)) {
        const name = itemDisplayName(item)
        if (!name) continue
        if (isDeprecatedItem(item)) continue  // never surface removed items
        const current = bestByName.get(name)
        if (shouldPreferItemRecord(item, current?.item)) bestByName.set(name, { key, item })
      }
      const out = [...bestByName.values()]
        .map(({ key, item }) => {
          const resolved = resolveItemStatsWithOverrides(item)
          return {
            key,
            internalKey: item.internalKey,
            name: itemDisplayName(item),
            tier: item.tier,
            categories: item.categories,
            statTags: item.statTags,
            storeFloats: item.storeFloats,
            totalCost: item.totalCost,
            passive: item.passive,
            aspectPassive: null as string | null,
            godLocked: null as string | null,
            // Precomputed stats so the picker UI can show "100HP · 40STR/70INT"
            // without duplicating the inferOrderedTags heuristic client-side.
            resolvedStats: {
              stats: resolved.stats,
              adaptiveStrength: resolved.adaptiveStrength,
              adaptiveIntelligence: resolved.adaptiveIntelligence,
              adaptiveChoice: resolved.adaptiveChoice ?? null,
            },
            aspectResolvedStats: null as null | {
              stats: Record<string, number>
              adaptiveStrength: number
              adaptiveIntelligence: number
              adaptiveChoice: null
            },
          }
        })
      // Append god-locked items (Ratatoskr's acorns). Values fully extracted
      // from game files; see godLockedItems.ts for provenance per entry.
      // Default to NON-ASPECT view in the picker — the aspect toggle (when
      // added) will swap to aspectStats/aspectPassive for the same acorn.
      for (const glItem of allGodLockedItems()) {
        const adaptiveSTR = acornAdaptiveStrength(glItem, /* aspectActive */ false)
        out.push({
          key: glItem.internalKey,
          internalKey: glItem.internalKey,
          name: glItem.displayName,
          tier: `T${glItem.tier}` as string,
          categories: ['Offensive', 'GodLocked'],
          statTags: godLockedItemStatTags(glItem),
          storeFloats: [],
          totalCost: null,
          passive: glItem.nonAspectPassive,
          aspectPassive: glItem.aspectPassive,
          godLocked: glItem.godId,
          resolvedStats: {
            stats: glItem.nonAspectStats,
            adaptiveStrength: adaptiveSTR,
            adaptiveIntelligence: 0,
            adaptiveChoice: null,
          },
          aspectResolvedStats: {
            stats: glItem.aspectStats,
            adaptiveStrength: acornAdaptiveStrength(glItem, /* aspectActive */ true),
            adaptiveIntelligence: 0,
            adaptiveChoice: null,
          },
        })
      }
      json(res, 200, out.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')))
      return true
    }

    if (/^\/api\/god\/[^/]+$/.test(url.pathname)) {
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method not allowed', path: url.pathname })
        return true
      }
      const id = url.pathname.replace('/api/god/', '')
      const gods = loadGods()
      const god = gods[id]
      if (!god) { json(res, 404, { error: 'god not found' }); return true }
      const aspect = getAspect(id)
      json(res, 200, {
        id, name: god.god,
        passive: god.passive,
        abilities: Object.fromEntries(
          (['A01', 'A02', 'A03', 'A04'] as const).map((slot) => {
            const ab = god.abilities[slot]
            return [slot, ab ? {
              name: ab.name,
              description: ab.description,
              damageType: ab.damageType,
              rows: Object.keys(ab.rankValues ?? {}),
            } : null]
          }),
        ),
        aspect: aspect ? aspect.aspect : null,
      })
      return true
    }

    if (url.pathname === '/api/scenarios/snapshot' && req.method === 'POST') {
      const body = await readBody(req)
      let scenario: Scenario
      try { scenario = JSON.parse(body) }
      catch { json(res, 400, { error: 'invalid JSON body' }); return true }
      try {
        json(res, 200, {
          attacker: snapshotAttacker(scenario),
          defender: snapshotDefender(scenario),
        })
      } catch (err) {
        logServerError('/api/scenarios/snapshot', err)
        json(res, 500, { error: (err as Error).message })
      }
      return true
    }

    if (url.pathname === '/api/optimize' && req.method === 'POST') {
      const body = await readBody(req)
      let request: OptimizeRequest
      try { request = JSON.parse(body) }
      catch { json(res, 400, { error: 'invalid JSON body' }); return true }
      try { json(res, 200, await optimizeParallel(request)) }
      catch (err) {
        logServerError('/api/optimize', err)
        json(res, 500, { error: (err as Error).message })
      }
      return true
    }

    if (url.pathname === '/api/scenarios/run' && req.method === 'POST') {
      const body = await readBody(req)
      let scenario: Scenario
      try { scenario = JSON.parse(body) }
      catch { json(res, 400, { error: 'invalid JSON body' }); return true }
      try {
        const result: SimResult = runScenario(scenario)
        json(res, 200, result)
      } catch (err) {
        logServerError('/api/scenarios/run', err)
        json(res, 500, { error: (err as Error).message })
      }
      return true
    }

    json(res, 404, { error: 'unknown api route', path: url.pathname })
    return true
  } catch (err) {
    logServerError(url.pathname, err)
    json(res, 500, { error: (err as Error).message })
    return true
  }
}

// ---------- Static SPA (dist/) ----------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

function handleStatic(_req: IncomingMessage, res: ServerResponse, url: URL): void {
  if (!existsSync(DIST_DIR)) {
    res.writeHead(503, { 'content-type': 'text/plain' })
    res.end([
      'No dist/ build found.',
      '',
      'For development, run Vite separately:   npm run dev',
      `  → it serves the UI on http://localhost:${VITE_PORT} and proxies /api to this server.`,
      '',
      'For production, build first:            npm run build',
      '  → writes dist/ that this server can serve.',
    ].join('\n'))
    return
  }

  // SPA resolution: request path → file in dist, or fall back to index.html.
  const requested = url.pathname === '/' ? '/index.html' : url.pathname
  const safe = normalize(requested).replace(/^([/\\])+/, '')
  const filePath = resolve(DIST_DIR, safe)
  // Prevent escape.
  if (!isInsideDir(DIST_DIR, filePath)) {
    res.writeHead(400); res.end('bad path'); return
  }
  const finalPath = existsSync(filePath) ? filePath : join(DIST_DIR, 'index.html')
  const ext = extname(finalPath).toLowerCase()
  try {
    const body = readFileSync(finalPath)
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=300',
    })
    res.end(body)
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(`static err: ${(err as Error).message}`)
  }
}

// ---------- Yjs relay (same protocol as relayServer.ts) ----------

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
interface Room {
  name: string
  ydoc: Y.Doc
  awareness: awarenessProtocol.Awareness
  conns: Set<WebSocket>
  awarenessConnIds: Map<WebSocket, Set<number>>
}
const rooms = new Map<string, Room>()
const pendingSaves = new Map<string, NodeJS.Timeout>()

function persistPath(name: string) { return join(PERSIST_DIR, `${name.replace(/[/\\]/g, '_')}.ydoc`) }

function scheduleSave(room: Room) {
  clearTimeout(pendingSaves.get(room.name))
  pendingSaves.set(room.name, setTimeout(() => {
    writeFileSync(persistPath(room.name), Buffer.from(Y.encodeStateAsUpdate(room.ydoc)))
    pendingSaves.delete(room.name)
  }, 1500))
}

function getRoom(name: string): Room {
  const cached = rooms.get(name)
  if (cached) return cached
  const ydoc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(ydoc)
  awareness.setLocalState(null)
  const p = persistPath(name)
  if (existsSync(p)) {
    try { Y.applyUpdate(ydoc, readFileSync(p)) }
    catch (err) { console.warn(`[relay] hydrate ${name}: ${(err as Error).message}`) }
  }
  const room: Room = { name, ydoc, awareness, conns: new Set(), awarenessConnIds: new Map() }
  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeUpdate(encoder, update)
    const msg = encoding.toUint8Array(encoder)
    for (const c of room.conns) if (c !== origin) send(c, msg)
    scheduleSave(room)
  })
  awareness.on('update', ({ added, updated, removed }: {
    added: number[]; updated: number[]; removed: number[]
  }, origin: unknown) => {
    if (origin && typeof origin === 'object' && 'readyState' in origin) {
      const conn = origin as WebSocket
      const ids = room.awarenessConnIds.get(conn) ?? new Set<number>()
      for (const id of added.concat(updated)) ids.add(id)
      for (const id of removed) ids.delete(id)
      if (ids.size > 0) room.awarenessConnIds.set(conn, ids)
      else room.awarenessConnIds.delete(conn)
    }
    const changed = added.concat(updated, removed)
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changed))
    const msg = encoding.toUint8Array(encoder)
    for (const c of room.conns) if (c !== origin) send(c, msg)
  })
  rooms.set(name, room)
  return room
}

function send(c: WebSocket, data: Uint8Array) {
  if (c.readyState === 0 || c.readyState === 1) { try { c.send(data) } catch { c.close() } }
}

function onMessage(room: Room, conn: WebSocket, data: Uint8Array) {
  const decoder = decoding.createDecoder(data)
  const messageType = decoding.readVarUint(decoder)
  if (messageType === MESSAGE_SYNC) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.readSyncMessage(decoder, encoder, room.ydoc, conn)
    if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder))
  } else if (messageType === MESSAGE_AWARENESS) {
    awarenessProtocol.applyAwarenessUpdate(
      room.awareness, decoding.readVarUint8Array(decoder), conn,
    )
  }
}

// ---------- wire it all up ----------

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  if (await handleApi(req, res, url)) return
  handleStatic(req, res, url)
})

const wss = new WebSocketServer({ noServer: true })
wss.on('connection', (conn, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  // Unified app mode uses /collab/<room>. Bare /<room> remains accepted so
  // older local demo URLs do not fail after the app-server merge.
  const roomName = decodeURIComponent(
    url.pathname.startsWith('/collab/')
      ? url.pathname.replace(/^\/collab\//, '')
      : url.pathname.replace(/^\/+/, ''),
  ) || 'default'
  const room = getRoom(roomName)
  room.conns.add(conn)

  // Seed sync + awareness state to the new peer.
  {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoder, room.ydoc)
    send(conn, encoding.toUint8Array(encoder))
  }
  {
    const states = room.awareness.getStates()
    if (states.size > 0) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(encoder,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(states.keys())))
      send(conn, encoding.toUint8Array(encoder))
    }
  }

  conn.on('message', (data: Buffer) => {
    try { onMessage(room, conn, new Uint8Array(data)) }
    catch (err) { console.warn(`[relay] msg err: ${(err as Error).message}`) }
  })
  conn.on('close', () => {
    room.conns.delete(conn)
    const ids = room.awarenessConnIds.get(conn)
    room.awarenessConnIds.delete(conn)
    awarenessProtocol.removeAwarenessStates(
      room.awareness,
      ids ? Array.from(ids) : [],
      conn,
    )
    console.log(`[ws] close room=${roomName} peers=${room.conns.size}`)
  })
  conn.on('error', () => conn.close())
  console.log(`[ws] open  room=${roomName} peers=${room.conns.size}`)
})

httpServer.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

function listenOn(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      httpServer.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      httpServer.off('error', onError)
      resolve(port)
    }
    httpServer.once('error', onError)
    httpServer.once('listening', onListening)
    httpServer.listen(port)
  })
}

async function startServer(): Promise<number> {
  if (APP_PORT_WAS_EXPLICIT) return listenOn(PORT)

  const maxAttempts = 10
  for (let offset = 0; offset < maxAttempts; offset++) {
    const candidate = PORT + offset
    try {
      return await listenOn(candidate)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'EADDRINUSE') throw e
    }
  }
  throw new Error(`No open app port found in range ${PORT}-${PORT + maxAttempts - 1}`)
}

startServer()
  .then((boundPort) => {
    const moved = boundPort !== PORT
    console.log(`\n  SMITE 2 Calculator — local app`)
    if (moved) console.log(`  note:     :${PORT} was busy, using :${boundPort} instead`)
    console.log(`  UI:       http://localhost:${boundPort}/`)
    console.log(`  API:      http://localhost:${boundPort}/api/gods`)
    console.log(`  collab:   ws://localhost:${boundPort}/collab/<build-id>`)
    console.log(`  dist:     ${existsSync(DIST_DIR) ? 'ok' : `missing — run \`npm run build\` or start Vite on ${VITE_PORT}`}\n`)
  })
  .catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[app] port ${PORT} is already in use.`)
      console.error(`[app] stop the existing server, or run with a different port:`)
      console.error(`[app]   set APP_PORT=${PORT + 1} && npm run app`)
      process.exit(1)
    }
    console.error(`[app] failed to start: ${(err as Error).message}`)
    process.exit(1)
  })

process.on('SIGINT', () => {
  console.log('\n[app] SIGINT — flushing')
  for (const room of rooms.values()) {
    writeFileSync(persistPath(room.name), Buffer.from(Y.encodeStateAsUpdate(room.ydoc)))
  }
  process.exit(0)
})
