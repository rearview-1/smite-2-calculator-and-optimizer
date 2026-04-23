/**
 * BuildRepository — storage abstraction for BuildDocs.
 *
 * Two implementations ship:
 *   - FileBuildRepository  : data/builds/<id>.json  (single-user offline, test harness)
 *   - YjsBuildRepository   : Y.Doc backed by a y-websocket relay (multi-user live)
 *
 * The sim, the optimizer, and any UI hook against the interface, never the impl.
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BuildDoc } from './buildDoc.ts'

export type BuildChangeListener = (doc: BuildDoc) => void

export interface BuildRepository {
  /** Load a build by id, or null if missing. */
  get(id: string): Promise<BuildDoc | null>

  /** Persist a full build document. Bumps version + updatedAt. */
  save(doc: BuildDoc, editorId: string): Promise<BuildDoc>

  /** List all build IDs the current storage can see (for a "my builds" panel). */
  list(): Promise<Array<{ id: string; title: string; updatedAt: number }>>

  /** Delete a build. No-op if missing. */
  delete(id: string): Promise<void>

  /** Subscribe to external changes to this document. The listener fires on
   *  remote-initiated updates (e.g. another collaborator saved). The returned
   *  function unsubscribes. */
  subscribe(id: string, listener: BuildChangeListener): () => void

  /** Tear down any connections / watchers. */
  dispose(): Promise<void>
}

// ----------------------------------------------------------------------------

const DEFAULT_BUILDS_DIR = join(process.cwd(), 'data', 'builds')

/** Local file-backed repository. Good for offline work + deterministic tests.
 *  For live collab, use YjsBuildRepository instead. */
export class FileBuildRepository implements BuildRepository {
  private readonly dir: string
  private readonly listeners = new Map<string, Set<BuildChangeListener>>()

  constructor(dir: string = DEFAULT_BUILDS_DIR) {
    this.dir = dir
    mkdirSync(this.dir, { recursive: true })
  }

  private pathFor(id: string): string {
    // Basic safety: strip path separators from id
    const safe = id.replace(/[/\\]/g, '_')
    return join(this.dir, `${safe}.json`)
  }

  async get(id: string): Promise<BuildDoc | null> {
    const p = this.pathFor(id)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8')) as BuildDoc
  }

  async save(doc: BuildDoc, editorId: string): Promise<BuildDoc> {
    const next: BuildDoc = {
      ...doc,
      version: doc.version + 1,
      updatedAt: Date.now(),
      lastEditorId: editorId,
    }
    const p = this.pathFor(next.id)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(next, null, 2), 'utf-8')
    for (const l of this.listeners.get(next.id) ?? []) l(next)
    return next
  }

  async list(): Promise<Array<{ id: string; title: string; updatedAt: number }>> {
    if (!existsSync(this.dir)) return []
    const names = readdirSync(this.dir).filter((n) => n.endsWith('.json'))
    const out: Array<{ id: string; title: string; updatedAt: number }> = []
    for (const n of names) {
      try {
        const doc = JSON.parse(readFileSync(join(this.dir, n), 'utf-8')) as BuildDoc
        out.push({ id: doc.id, title: doc.title, updatedAt: doc.updatedAt })
      } catch {
        // Skip malformed files.
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async delete(id: string): Promise<void> {
    const p = this.pathFor(id)
    if (existsSync(p)) unlinkSync(p)
    this.listeners.delete(id)
  }

  subscribe(id: string, listener: BuildChangeListener): () => void {
    let set = this.listeners.get(id)
    if (!set) { set = new Set(); this.listeners.set(id, set) }
    set.add(listener)
    return () => {
      const s = this.listeners.get(id)
      s?.delete(listener)
      if (s && s.size === 0) this.listeners.delete(id)
    }
  }

  async dispose(): Promise<void> {
    this.listeners.clear()
  }
}
