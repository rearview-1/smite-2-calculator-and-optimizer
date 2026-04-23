import type { AbilitySlot, DamageType, GodDef, ItemDef } from '../catalog/types.ts'

export interface BuildInput {
  god: GodDef
  godLevel: number
  abilityRanks: Record<AbilitySlot, number>
  items: ItemDef[]
}

export interface EnemyInput {
  god: GodDef
  godLevel: number
  items: ItemDef[]
  flatHealthBonus?: number
}

export type RotationAction =
  | { kind: 'ability'; slot: AbilitySlot; label?: string }
  | { kind: 'basic'; label?: string }
  | { kind: 'wait'; seconds: number }

export interface Scenario {
  title: string
  attacker: BuildInput
  defender: EnemyInput
  rotation: RotationAction[]
}

export interface DamageInstance {
  label: string
  source: 'ability' | 'basic' | 'item-onhit' | 'item-postability' | 'item-perbasic' | 'item-postability-power'
  damageType: DamageType
  preMitigation: number
  postMitigation: number
  notes?: string[]
}

export interface SimResult {
  scenarioTitle: string
  attackerSnapshot: Record<string, number>
  defenderSnapshot: { physicalProtection: number; magicalProtection: number; maxHealth: number }
  events: DamageInstance[]
  totals: {
    physical: number
    magical: number
    true: number
    total: number
  }
  byLabel: Array<{ label: string; total: number }>
  assumptions: string[]
}
