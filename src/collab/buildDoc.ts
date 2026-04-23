/**
 * Build document — the sync target. Wraps a Scenario with the metadata needed
 * for collaborative editing, persistence, and conflict resolution.
 *
 * A Build lives in three forms depending on context:
 *   1. BuildDoc  (plain JSON, for persistence + over-the-wire transfer)
 *   2. Y.Doc     (CRDT form, for live collaborative editing; see yjsBuildDoc.ts)
 *   3. Scenario  (sim input; converted via buildToScenario)
 *
 * The fields below are the source of truth for what a "shared build" contains.
 * When adding a field, update:
 *   - BuildDoc (this file)
 *   - buildToScenario() (conversion to sim input)
 *   - yjsBuildDoc.ts (Y.Map bindings)
 */

import type { BuildInput, EnemyInput, RotationAction, Scenario, ScenarioOptions } from '../sim/v3/types.ts'

/** A shared build document. Single source of truth synced across collaborators. */
export interface BuildDoc {
  /** Stable document ID (UUID). Used as the sync channel key. */
  id: string

  /** Human-readable title. */
  title: string

  /** User who originally created the document. */
  ownerId: string

  /** Additional user IDs granted edit access. Presence (live cursors) is
   *  separate — anyone watching the channel sees presence. */
  collaborators: string[]

  /** Monotonic version number — bumped on every persisted update. Used by
   *  last-writer-wins fallback when CRDT isn't in the loop (e.g. REST save). */
  version: number

  /** Epoch-ms creation time. */
  createdAt: number
  /** Epoch-ms of last persisted write. */
  updatedAt: number
  /** User ID of the last writer. */
  lastEditorId: string

  /** --- Scenario payload (flat because CRDT works best on flat Y.Map fields) --- */

  attacker: BuildInput
  defender: EnemyInput
  enemies?: EnemyInput[]
  rotation: RotationAction[]
  options?: ScenarioOptions

  teamAttackers?: Array<BuildInput & { rotation: RotationAction[]; title?: string }>

  /** Free-form notes panel for collaborators. */
  notes?: string
}

/** Unwrap a BuildDoc into the Scenario shape the sim expects. */
export function buildToScenario(doc: BuildDoc): Scenario {
  return {
    title: doc.title,
    attacker: doc.attacker,
    defender: doc.defender,
    enemies: doc.enemies,
    rotation: doc.rotation,
    options: doc.options,
    teamAttackers: doc.teamAttackers,
  }
}

/** Build a new empty document with sane defaults. */
export function createBuildDoc(params: {
  id: string
  ownerId: string
  title?: string
  godId?: string
  level?: number
}): BuildDoc {
  const now = Date.now()
  return {
    id: params.id,
    title: params.title ?? 'Untitled build',
    ownerId: params.ownerId,
    collaborators: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
    lastEditorId: params.ownerId,
    attacker: {
      godId: params.godId ?? 'Loki',
      level: params.level ?? 20,
      abilityRanks: { A01: 1, A02: 1, A03: 1, A04: 1 },
      items: [],
    },
    defender: {
      godId: 'Kukulkan',
      level: 20,
    },
    rotation: [],
  }
}

/** Pseudo-UUID good enough for client-side generation; not cryptographic. */
export function newBuildId(): string {
  const rand = () => Math.random().toString(16).slice(2, 10)
  return `build-${Date.now().toString(36)}-${rand()}-${rand()}`
}
