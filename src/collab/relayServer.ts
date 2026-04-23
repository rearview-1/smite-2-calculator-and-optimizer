/**
 * Minimal y-websocket-compatible relay. Run with:
 *     npm run collab:server
 *
 * Implements the y-protocols wire format (sync + awareness) over plain
 * WebSockets, without depending on y-websocket's bin/utils helper (dropped in
 * y-websocket v3). Each websocket room is one Y.Doc; connected peers share
 * updates + awareness state.
 *
 * Persists each doc to data/collab-rooms/<id>.ydoc on idle so restarts survive.
 *
 * No auth — local/LAN use. For public deployment, put a real backend here.
 */

import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { URL } from 'node:url'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

function envPort(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const PORT = envPort('COLLAB_PORT', 4455)
const PERSIST_DIR = process.env.COLLAB_PERSIST_DIR
  ? resolve(process.env.COLLAB_PERSIST_DIR)
  : join(process.cwd(), 'data', 'collab-rooms')
mkdirSync(PERSIST_DIR, { recursive: true })

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
const IDLE_PERSIST_MS = 1500

function persistPath(name: string): string {
  return join(PERSIST_DIR, `${name.replace(/[/\\]/g, '_')}.ydoc`)
}

function scheduleSave(room: Room): void {
  const prev = pendingSaves.get(room.name)
  if (prev) clearTimeout(prev)
  pendingSaves.set(room.name, setTimeout(() => {
    const encoded = Y.encodeStateAsUpdate(room.ydoc)
    writeFileSync(persistPath(room.name), Buffer.from(encoded))
    pendingSaves.delete(room.name)
  }, IDLE_PERSIST_MS))
}

function getOrCreateRoom(name: string): Room {
  const cached = rooms.get(name)
  if (cached) return cached

  const ydoc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(ydoc)
  awareness.setLocalState(null)  // server has no identity

  const p = persistPath(name)
  if (existsSync(p)) {
    try { Y.applyUpdate(ydoc, readFileSync(p)) }
    catch (err) { console.warn(`[relay] hydrate ${name}: ${(err as Error).message}`) }
  }

  const room: Room = { name, ydoc, awareness, conns: new Set(), awarenessConnIds: new Map() }

  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    // Broadcast to all peers except the originator.
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeUpdate(encoder, update)
    const msg = encoding.toUint8Array(encoder)
    for (const conn of room.conns) {
      if (conn === origin) continue
      send(conn, msg)
    }
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
    for (const conn of room.conns) {
      if (conn === origin) continue
      send(conn, msg)
    }
  })

  rooms.set(name, room)
  return room
}

function send(conn: WebSocket, data: Uint8Array): void {
  if (conn.readyState === 0 || conn.readyState === 1) {
    try { conn.send(data) } catch { conn.close() }
  }
}

function handleMessage(room: Room, conn: WebSocket, data: Uint8Array): void {
  const decoder = decoding.createDecoder(data)
  const messageType = decoding.readVarUint(decoder)
  const encoder = encoding.createEncoder()

  switch (messageType) {
    case MESSAGE_SYNC: {
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.readSyncMessage(decoder, encoder, room.ydoc, conn)
      if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder))
      break
    }
    case MESSAGE_AWARENESS: {
      awarenessProtocol.applyAwarenessUpdate(
        room.awareness, decoding.readVarUint8Array(decoder), conn,
      )
      break
    }
    default:
      console.warn(`[relay] unknown message type ${messageType}`)
  }
}

function handleConnection(conn: WebSocket, roomName: string): void {
  const room = getOrCreateRoom(roomName)
  room.conns.add(conn)

  // Send sync step 1 (our state vector) to the new peer.
  {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoder, room.ydoc)
    send(conn, encoding.toUint8Array(encoder))
  }
  // Send current awareness state so the newcomer sees who's already here.
  {
    const awarenessStates = room.awareness.getStates()
    if (awarenessStates.size > 0) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(encoder,
        awarenessProtocol.encodeAwarenessUpdate(
          room.awareness, Array.from(awarenessStates.keys()),
        ))
      send(conn, encoding.toUint8Array(encoder))
    }
  }

  conn.on('message', (data: Buffer) => {
    try { handleMessage(room, conn, new Uint8Array(data)) }
    catch (err) { console.warn(`[relay] message err: ${(err as Error).message}`) }
  })
  conn.on('close', () => {
    room.conns.delete(conn)
    const ids = room.awarenessConnIds.get(conn)
    room.awarenessConnIds.delete(conn)
    // Drop this peer's awareness entry.
    awarenessProtocol.removeAwarenessStates(
      room.awareness,
      ids ? Array.from(ids) : [],
      conn,
    )
    console.log(`[relay] disconnect room=${roomName}  peers=${room.conns.size}`)
  })
  conn.on('error', () => { conn.close() })

  console.log(`[relay] connect room=${roomName}  peers=${room.conns.size}`)
}

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      peers: Array.from(rooms.values()).reduce((n, r) => n + r.conns.size, 0),
      uptime: process.uptime(),
    }))
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ noServer: true })
wss.on('connection', (conn, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const docName = decodeURIComponent(
    url.pathname.startsWith('/collab/')
      ? url.pathname.replace(/^\/collab\//, '')
      : url.pathname.replace(/^\/+/, ''),
  ) || 'default'
  handleConnection(conn, docName)
})
httpServer.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

httpServer.listen(PORT, () => {
  console.log(`[relay] listening on ws://localhost:${PORT}`)
  console.log(`[relay] health: http://localhost:${PORT}/health`)
  console.log(`[relay] persist: ${PERSIST_DIR}`)
})

process.on('SIGINT', () => {
  console.log('\n[relay] SIGINT — flushing')
  for (const room of rooms.values()) {
    writeFileSync(persistPath(room.name), Buffer.from(Y.encodeStateAsUpdate(room.ydoc)))
  }
  process.exit(0)
})
