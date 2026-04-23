/**
 * Yjs binding for a BuildDoc.
 *
 * Each build is stored as a Y.Doc with a single top-level Y.Map called
 * "build" that holds all BuildDoc fields. Nested arrays (rotation,
 * teamAttackers) are Y.Arrays so concurrent rotation edits merge correctly;
 * deeply nested objects (attacker, defender) are plain JSON values stored in
 * Y.Map entries and replaced wholesale on edit (last-writer-wins per field).
 *
 * This is a deliberate simplification. The trade-off: if two users edit
 * `attacker.items` at the same instant, the later write wins the whole array.
 * Rotation steps, by contrast, merge cleanly because they're in a Y.Array.
 * For a damage calculator where both users usually agree on the build and
 * disagree about the rotation, this matches usage.
 */

import * as Y from 'yjs'
import type { BuildDoc } from './buildDoc.ts'
import type { RotationAction, BuildInput } from '../sim/v3/types.ts'

const BUILD_MAP_KEY = 'build'
const ROTATION_ARRAY_KEY = 'rotation'

/** Hydrate a Y.Doc from a BuildDoc. Idempotent: if the Y.Doc already has
 *  data, we do nothing (remote state wins). */
export function hydrateYDocFromBuild(ydoc: Y.Doc, doc: BuildDoc): void {
  const map = ydoc.getMap<unknown>(BUILD_MAP_KEY)
  const rotation = ydoc.getArray<RotationAction>(ROTATION_ARRAY_KEY)

  // Only hydrate if the doc is empty. If remote has state, we adopt it.
  if (map.size > 0 || rotation.length > 0) return

  ydoc.transact(() => {
    map.set('id', doc.id)
    map.set('title', doc.title)
    map.set('ownerId', doc.ownerId)
    map.set('collaborators', doc.collaborators)
    map.set('version', doc.version)
    map.set('createdAt', doc.createdAt)
    map.set('updatedAt', doc.updatedAt)
    map.set('lastEditorId', doc.lastEditorId)
    map.set('attacker', doc.attacker)
    map.set('defender', doc.defender)
    map.set('enemies', doc.enemies ?? null)
    map.set('options', doc.options ?? null)
    map.set('teamAttackers', doc.teamAttackers ?? null)
    map.set('notes', doc.notes ?? '')
    rotation.delete(0, rotation.length)
    rotation.insert(0, doc.rotation)
  })
}

/** Project a Y.Doc back into a plain BuildDoc (for sim input, REST save). */
export function readBuildFromYDoc(ydoc: Y.Doc): BuildDoc | null {
  const map = ydoc.getMap<unknown>(BUILD_MAP_KEY)
  const rotationArr = ydoc.getArray<RotationAction>(ROTATION_ARRAY_KEY)
  if (map.size === 0) return null
  return {
    id: String(map.get('id') ?? ''),
    title: String(map.get('title') ?? 'Untitled'),
    ownerId: String(map.get('ownerId') ?? ''),
    collaborators: (map.get('collaborators') as string[] | undefined) ?? [],
    version: Number(map.get('version') ?? 1),
    createdAt: Number(map.get('createdAt') ?? Date.now()),
    updatedAt: Number(map.get('updatedAt') ?? Date.now()),
    lastEditorId: String(map.get('lastEditorId') ?? ''),
    attacker: (map.get('attacker') as BuildInput),
    defender: map.get('defender') as BuildDoc['defender'],
    enemies: (map.get('enemies') as BuildDoc['enemies']) ?? undefined,
    options: (map.get('options') as BuildDoc['options']) ?? undefined,
    teamAttackers: (map.get('teamAttackers') as BuildDoc['teamAttackers']) ?? undefined,
    notes: (map.get('notes') as string | undefined) ?? '',
    rotation: rotationArr.toArray(),
  }
}

/** Apply a partial update to the Y.Doc. All writes happen inside a single
 *  transaction so collaborators see one atomic change. */
export function updateBuildInYDoc(
  ydoc: Y.Doc,
  editorId: string,
  updater: (patch: BuildPatchAPI) => void,
): void {
  ydoc.transact(() => {
    const map = ydoc.getMap<unknown>(BUILD_MAP_KEY)
    const rotation = ydoc.getArray<RotationAction>(ROTATION_ARRAY_KEY)
    const api: BuildPatchAPI = {
      setTitle: (t) => map.set('title', t),
      setNotes: (n) => map.set('notes', n),
      setAttacker: (a) => map.set('attacker', a),
      setDefender: (d) => map.set('defender', d),
      setOptions: (o) => map.set('options', o ?? null),
      setTeamAttackers: (t) => map.set('teamAttackers', t ?? null),
      setRotation: (r) => {
        rotation.delete(0, rotation.length)
        rotation.insert(0, r)
      },
      appendRotationStep: (step) => rotation.push([step]),
      removeRotationStep: (i) => {
        if (i < 0 || i >= rotation.length) return
        rotation.delete(i, 1)
      },
      moveRotationStep: (from, to) => {
        if (from === to || from < 0 || from >= rotation.length) return
        const [item] = rotation.toArray().slice(from, from + 1)
        rotation.delete(from, 1)
        rotation.insert(Math.max(0, Math.min(rotation.length, to)), [item])
      },
      addCollaborator: (userId) => {
        const cur = (map.get('collaborators') as string[]) ?? []
        if (!cur.includes(userId)) map.set('collaborators', [...cur, userId])
      },
      removeCollaborator: (userId) => {
        const cur = (map.get('collaborators') as string[]) ?? []
        map.set('collaborators', cur.filter((c) => c !== userId))
      },
    }
    updater(api)
    const version = Number(map.get('version') ?? 1)
    map.set('version', version + 1)
    map.set('updatedAt', Date.now())
    map.set('lastEditorId', editorId)
  })
}

export interface BuildPatchAPI {
  setTitle: (title: string) => void
  setNotes: (notes: string) => void
  setAttacker: (a: BuildInput) => void
  setDefender: (d: BuildDoc['defender']) => void
  setOptions: (o: BuildDoc['options']) => void
  setTeamAttackers: (t: BuildDoc['teamAttackers']) => void
  setRotation: (r: RotationAction[]) => void
  appendRotationStep: (step: RotationAction) => void
  removeRotationStep: (index: number) => void
  moveRotationStep: (from: number, to: number) => void
  addCollaborator: (userId: string) => void
  removeCollaborator: (userId: string) => void
}
