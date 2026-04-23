/**
 * Yjs-backed BuildRepository with live sync across sessions.
 *
 * Each BuildDoc is a Y.Doc connected to a y-websocket relay. Local edits
 * (via applyPatch) propagate to all peers; remote edits fire the subscribe
 * listener. Awareness (presence) is tracked on the same Y.Doc via
 * `ydoc.awareness` — we expose getPresence/setPresence for "who else is here"
 * indicators.
 *
 * The WebSocket URL (`wsUrl`) points at the relay server in
 * `src/collab/relayServer.ts`. Run it with `npm run collab:server`.
 */

import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import type { BuildDoc } from './buildDoc.ts'
import type {
  BuildChangeListener, BuildRepository,
} from './buildRepository.ts'
import {
  hydrateYDocFromBuild, readBuildFromYDoc, updateBuildInYDoc,
  type BuildPatchAPI,
} from './yjsBuildDoc.ts'
import { createBuildDoc, newBuildId } from './buildDoc.ts'

export interface PresenceInfo {
  userId: string
  userName: string
  color?: string
  /** Last selection the user made in the UI (opaque). */
  cursor?: unknown
  /** True if this is the local session. */
  isMe?: boolean
}

export type PresenceListener = (peers: PresenceInfo[]) => void

interface BuildChannel {
  ydoc: Y.Doc
  provider: WebsocketProvider
  listeners: Set<BuildChangeListener>
  presenceListeners: Set<PresenceListener>
  observeHandler: () => void
  awarenessHandler: () => void
}

export interface YjsBuildRepositoryOptions {
  wsUrl: string           // e.g. 'ws://localhost:4455'
  userId: string
  userName: string
  userColor?: string
}

export class YjsBuildRepository implements BuildRepository {
  private readonly channels = new Map<string, BuildChannel>()
  private readonly opts: YjsBuildRepositoryOptions

  constructor(opts: YjsBuildRepositoryOptions) {
    this.opts = opts
  }

  private channel(id: string): BuildChannel {
    const existing = this.channels.get(id)
    if (existing) return existing

    const ydoc = new Y.Doc()
    const provider = new WebsocketProvider(this.opts.wsUrl, `build-${id}`, ydoc, {
      connect: true,
    })

    // Publish local identity into awareness immediately.
    provider.awareness.setLocalStateField('user', {
      userId: this.opts.userId,
      userName: this.opts.userName,
      color: this.opts.userColor ?? '#6b8afd',
    })

    const listeners = new Set<BuildChangeListener>()
    const presenceListeners = new Set<PresenceListener>()
    let lastDocSignature = ''

    const observeHandler = () => {
      const doc = readBuildFromYDoc(ydoc)
      if (!doc) return
      const signature = JSON.stringify(doc)
      if (signature === lastDocSignature) return
      lastDocSignature = signature
      for (const l of listeners) l(doc)
    }
    ydoc.on('afterTransaction', observeHandler)

    const awarenessHandler = () => {
      const peers: PresenceInfo[] = []
      for (const [clientID, state] of provider.awareness.getStates()) {
        const u = (state as { user?: PresenceInfo }).user
        if (!u) continue
        peers.push({ ...u, isMe: clientID === provider.awareness.clientID })
      }
      for (const l of presenceListeners) l(peers)
    }
    provider.awareness.on('update', awarenessHandler)

    const channel: BuildChannel = {
      ydoc, provider, listeners, presenceListeners,
      observeHandler, awarenessHandler,
    }
    this.channels.set(id, channel)
    return channel
  }

  /** Get a build from the sync layer. If no channel exists yet, connects and
   *  waits briefly for initial sync from the server (up to 500ms). */
  async get(id: string): Promise<BuildDoc | null> {
    const ch = this.channel(id)
    // Give the server a moment to dump state into the new Y.Doc.
    if (!ch.provider.synced) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 500)
        ch.provider.once('sync', () => { clearTimeout(t); resolve() })
      })
    }
    return readBuildFromYDoc(ch.ydoc)
  }

  /** Persist a BuildDoc into the Y.Doc. Acts as "create or overwrite from
   *  JSON" — useful for the first publish from a file-backed flow. For
   *  incremental edits, prefer applyPatch. */
  async save(doc: BuildDoc, editorId: string): Promise<BuildDoc> {
    const ch = this.channel(doc.id)
    const existing = readBuildFromYDoc(ch.ydoc)
    if (!existing) {
      hydrateYDocFromBuild(ch.ydoc, doc)
    } else {
      // Y.Map overwrite via the patch API so transactionality + version bump
      // is consistent with other edits.
      updateBuildInYDoc(ch.ydoc, editorId, (p: BuildPatchAPI) => {
        p.setTitle(doc.title)
        p.setAttacker(doc.attacker)
        p.setDefender(doc.defender)
        p.setOptions(doc.options)
        p.setTeamAttackers(doc.teamAttackers)
        p.setRotation(doc.rotation)
        if (doc.notes !== undefined) p.setNotes(doc.notes)
      })
    }
    return readBuildFromYDoc(ch.ydoc) ?? doc
  }

  /** Apply a structured patch — the ergonomic way to do edits. */
  applyPatch(id: string, updater: (p: BuildPatchAPI) => void): void {
    const ch = this.channel(id)
    updateBuildInYDoc(ch.ydoc, this.opts.userId, updater)
  }

  /** Create a new build and push its initial state to the relay. */
  async createNew(params: { title?: string; godId?: string; level?: number }): Promise<BuildDoc> {
    const id = newBuildId()
    const doc = createBuildDoc({ id, ownerId: this.opts.userId, ...params })
    return this.save(doc, this.opts.userId)
  }

  async list(): Promise<Array<{ id: string; title: string; updatedAt: number }>> {
    // Yjs doesn't give us a cross-doc index. A real server would expose this via
    // a REST endpoint; for now, only documents already opened in this session
    // are listable. Production deployments should mirror builds into Postgres
    // and query there.
    const out: Array<{ id: string; title: string; updatedAt: number }> = []
    for (const [id, ch] of this.channels) {
      const doc = readBuildFromYDoc(ch.ydoc)
      if (doc) out.push({ id, title: doc.title, updatedAt: doc.updatedAt })
    }
    return out
  }

  async delete(id: string): Promise<void> {
    const ch = this.channels.get(id)
    if (!ch) return
    ch.ydoc.off('afterTransaction', ch.observeHandler)
    ch.provider.awareness.off('update', ch.awarenessHandler)
    ch.provider.destroy()
    ch.ydoc.destroy()
    this.channels.delete(id)
  }

  subscribe(id: string, listener: BuildChangeListener): () => void {
    const ch = this.channel(id)
    ch.listeners.add(listener)
    return () => ch.listeners.delete(listener)
  }

  /** Subscribe to presence changes for a build. Fires with the current set of
   *  peers on every update (join, leave, cursor move). */
  subscribePresence(id: string, listener: PresenceListener): () => void {
    const ch = this.channel(id)
    ch.presenceListeners.add(listener)
    // Fire once immediately with current state.
    listener(this.getPresence(id))
    return () => ch.presenceListeners.delete(listener)
  }

  /** Current snapshot of who's editing this build. */
  getPresence(id: string): PresenceInfo[] {
    const ch = this.channels.get(id)
    if (!ch) return []
    const peers: PresenceInfo[] = []
    for (const [clientID, state] of ch.provider.awareness.getStates()) {
      const u = (state as { user?: PresenceInfo }).user
      if (!u) continue
      peers.push({ ...u, isMe: clientID === ch.provider.awareness.clientID })
    }
    return peers
  }

  /** Publish this user's cursor/selection to other peers. */
  setCursor(id: string, cursor: unknown): void {
    const ch = this.channel(id)
    const prev = ch.provider.awareness.getLocalState() as { user: PresenceInfo } | null
    if (!prev) return
    ch.provider.awareness.setLocalStateField('user', { ...prev.user, cursor })
  }

  async dispose(): Promise<void> {
    for (const id of Array.from(this.channels.keys())) {
      await this.delete(id)
    }
  }
}
