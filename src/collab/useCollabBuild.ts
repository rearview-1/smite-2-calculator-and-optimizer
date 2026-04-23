/**
 * React hook that binds a BuildDoc to live collab via YjsBuildRepository.
 *
 * Modes:
 *   - When `buildId` is null: hook is inactive, returns null doc + empty peers.
 *     The app uses local React state only (single-user mode).
 *   - When `buildId` is set: hook connects to the relay, loads the shared doc,
 *     subscribes to remote changes, and exposes `applyPatch(updater)` + peers.
 *
 * WebSocket URL auto-derives from `window.location`:
 *   https://x.trycloudflare.com/         → wss://x.trycloudflare.com/collab/<id>
 *   http://localhost:4455/               → ws://localhost:4455/collab/<id>
 *   http://localhost:5173/ (Vite dev)    → ws://localhost:5173/collab/<id>   (proxied to 4455)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BuildDoc } from './buildDoc.ts'
import type { BuildPatchAPI } from './yjsBuildDoc.ts'
import { YjsBuildRepository, type PresenceInfo } from './yjsBuildRepository.ts'

function computeWsBase(): string {
  const loc = window.location
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${loc.host}/collab`
}

/** Random short id for an anonymous local session. */
function sessionUserId(): { id: string; name: string } {
  const stored = sessionStorage.getItem('collab.user')
  if (stored) {
    try { return JSON.parse(stored) as { id: string; name: string } }
    catch { /* fallthrough */ }
  }
  const id = `guest-${Math.random().toString(36).slice(2, 8)}`
  const name = `Guest ${id.slice(-4)}`
  const u = { id, name }
  sessionStorage.setItem('collab.user', JSON.stringify(u))
  return u
}

export interface CollabStatus {
  connected: boolean
  peers: PresenceInfo[]
  buildId: string | null
  doc: BuildDoc | null
}

export interface CollabHandle extends CollabStatus {
  applyPatch: (updater: (p: BuildPatchAPI) => void) => void
  /** Create a fresh build on the relay, returns its id. */
  createShared: (initial: Omit<BuildDoc, 'id' | 'ownerId' | 'version' | 'createdAt' | 'updatedAt' | 'lastEditorId' | 'collaborators'>) => Promise<string>
}

export function useCollabBuild(buildId: string | null): CollabHandle {
  const user = useMemo(() => sessionUserId(), [])
  const repoRef = useRef<YjsBuildRepository | null>(null)
  const [docState, setDocState] = useState<{ buildId: string | null; doc: BuildDoc | null }>({ buildId: null, doc: null })
  const [peerState, setPeerState] = useState<{ buildId: string | null; peers: PresenceInfo[] }>({ buildId: null, peers: [] })

  // Lazily create the repository once — reused across build ids.
  const ensureRepo = useCallback((): YjsBuildRepository => {
    if (!repoRef.current) {
      repoRef.current = new YjsBuildRepository({
        wsUrl: computeWsBase(),
        userId: user.id,
        userName: user.name,
        userColor: '#e3a34b',
      })
    }
    return repoRef.current
  }, [user.id, user.name])

  useEffect(() => {
    if (!buildId) return
    const repo = ensureRepo()
    let cancelled = false

    repo.get(buildId).then((d) => {
      if (!cancelled) setDocState({ buildId, doc: d })
    }).catch((err) => {
      if (!cancelled) console.warn(`[collab] failed to load build ${buildId}:`, err)
    })

    const unsubDoc = repo.subscribe(buildId, (d) => {
      if (!cancelled) setDocState({ buildId, doc: d })
    })
    const unsubPresence = repo.subscribePresence(buildId, (p) => {
      if (!cancelled) setPeerState({ buildId, peers: p })
    })

    return () => {
      cancelled = true
      unsubDoc()
      unsubPresence()
    }
  }, [buildId, ensureRepo])

  // Clean up the repo when the component unmounts.
  useEffect(() => () => {
    if (repoRef.current) {
      repoRef.current.dispose().catch((err) => console.warn('[collab] dispose:', err))
      repoRef.current = null
    }
  }, [])

  function applyPatch(updater: (p: BuildPatchAPI) => void) {
    if (!buildId) return
    ensureRepo().applyPatch(buildId, updater)
  }

  async function createShared(initial: Omit<BuildDoc, 'id' | 'ownerId' | 'version' | 'createdAt' | 'updatedAt' | 'lastEditorId' | 'collaborators'>): Promise<string> {
    const repo = ensureRepo()
    const created = await repo.createNew({
      title: initial.title,
      godId: initial.attacker.godId,
      level: initial.attacker.level,
    })
    // Seed the remainder of the document from the local scenario.
    repo.applyPatch(created.id, (p) => {
      p.setTitle(initial.title)
      p.setAttacker(initial.attacker)
      p.setDefender(initial.defender)
      p.setOptions(initial.options)
      p.setTeamAttackers(initial.teamAttackers)
      p.setRotation(initial.rotation)
      if (initial.notes !== undefined) p.setNotes(initial.notes)
    })
    return created.id
  }

  const doc = docState.buildId === buildId ? docState.doc : null
  const peers = peerState.buildId === buildId ? peerState.peers : []

  return {
    connected: !!buildId && !!doc,
    peers,
    buildId,
    doc,
    applyPatch,
    createShared,
  }
}
