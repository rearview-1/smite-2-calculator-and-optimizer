/**
 * God-agnostic combat engine. Loads gods/items/effects from data/*.json catalogs
 * and simulates a scenario: attacker does a rotation against a defender.
 *
 * Architecture:
 *  - Input: Scenario (attacker + defender + rotation)
 *  - Snapshot: resolve effective stats at t=0 for attacker and defender
 *  - Walk: iterate rotation, emitting damage events per action
 *  - Passives: pluggable per-god handlers (Kali rupture, etc.)
 *  - Item procs: pluggable per-item handlers (Hydra ×1.3, Bumba true damage, etc.)
 *
 * Time is not yet fully modeled — rotations execute in order without cooldown/AS gating.
 * That's the next slice after this.
 */

import type { GodCatalogEntry, ItemCatalogEntry } from '../catalog/loadCatalogs.ts'
import {
  getGod,
  getItem,
  resolveItemStatsWithOverrides,
  statAt,
} from '../catalog/loadCatalogs.ts'

// ---- Scenario types ----

export type AbilitySlot = 'A01' | 'A02' | 'A03' | 'A04'

export type RotationAction =
  | { kind: 'ability'; slot: AbilitySlot; label?: string }
  | { kind: 'basic'; label?: string }
  | { kind: 'wait'; seconds: number; label?: string }

export interface BuildInput {
  godId: string
  level: number
  abilityRanks: Record<AbilitySlot, number>
  items: string[] // display names or internal keys
  // aspects: string[]  // planned for the aspect slice
  // activeBuffs: string[] // planned for the buff slice
}

export interface EnemyInput {
  godId: string
  level: number
  items?: string[]
  flatHealthBonus?: number
}

export interface Scenario {
  title: string
  attacker: BuildInput
  defender: EnemyInput
  rotation: RotationAction[]
  options?: {
    penPercentOverride?: number
  }
}

// ---- Snapshots ----

export interface AttackerSnapshot {
  god: GodCatalogEntry
  level: number
  abilityRanks: Record<AbilitySlot, number>
  items: ItemCatalogEntry[]
  // Resolved numerical stats
  maxHealth: number
  maxMana: number
  healthPerTime: number
  manaPerTime: number
  physicalProtection: number
  magicalProtection: number
  moveSpeed: number
  baseAttackSpeed: number
  attackSpeedPercent: number
  totalAttackSpeed: number
  inhandPower: number
  // Adaptive breakdowns — a god's primaryStat (STR/INT) determines which applies
  adaptiveStrength: number
  adaptiveIntelligence: number
  // Pen
  penFlat: number
  penPercent: number
  cdrPercent: number
}

export interface DefenderSnapshot {
  god: GodCatalogEntry
  level: number
  maxHealth: number
  currentHealth: number
  physicalProtection: number
  magicalProtection: number
}

// Universal +18% MS modifier (GE_IncreasedStartingMovementSpeed) — every god
const UNIVERSAL_MS_MULTIPLIER = 1.18

function sumItemStats(items: ItemCatalogEntry[]) {
  const flat: Record<string, number> = {}
  let str = 0
  let int = 0
  for (const item of items) {
    const r = resolveItemStatsWithOverrides(item)
    str += r.adaptiveStrength
    int += r.adaptiveIntelligence
    for (const [k, v] of Object.entries(r.stats)) {
      flat[k] = (flat[k] ?? 0) + v
    }
  }
  return { flat, str, int }
}

export function snapshotAttacker(build: BuildInput): AttackerSnapshot {
  const god = getGod(build.godId)
  const items = build.items.map(getItem)
  const { flat, str, int } = sumItemStats(items)

  // Catalog strips the 'Character.Stat.' prefix when extracting. Use bare names.
  const baseHealth = statAt(god, 'MaxHealth', build.level)
  const baseMana = statAt(god, 'MaxMana', build.level)
  const baseHPregen = statAt(god, 'HealthPerTime', build.level)
  const baseMPregen = statAt(god, 'ManaPerTime', build.level)
  const basePhysProt = statAt(god, 'PhysicalProtection', build.level)
  const baseMagProt = statAt(god, 'MagicalProtection', build.level)
  const baseMoveSpeed = statAt(god, 'MovementSpeed', build.level)
  const baseAttackSpeed = statAt(god, 'BaseAttackSpeed', build.level)
  const attackSpeedPct = statAt(god, 'AttackSpeedPercent', build.level)
  const baseInhandPower = statAt(god, 'InhandPower', build.level)

  const attackSpeedPercentTotal = attackSpeedPct + (flat.AttackSpeedPercent ?? 0)

  return {
    god,
    level: build.level,
    abilityRanks: build.abilityRanks,
    items,
    maxHealth: baseHealth + (flat.MaxHealth ?? 0),
    maxMana: baseMana + (flat.MaxMana ?? 0),
    healthPerTime: baseHPregen + (flat.HealthPerTime ?? 0),
    manaPerTime: baseMPregen + (flat.ManaPerTime ?? 0),
    physicalProtection: basePhysProt + (flat.PhysicalProtection ?? 0),
    magicalProtection: baseMagProt + (flat.MagicalProtection ?? 0),
    moveSpeed: (baseMoveSpeed + (flat.MovementSpeed ?? 0)) * UNIVERSAL_MS_MULTIPLIER,
    baseAttackSpeed,
    attackSpeedPercent: attackSpeedPercentTotal,
    totalAttackSpeed: baseAttackSpeed * (1 + attackSpeedPercentTotal / 100),
    inhandPower: baseInhandPower,
    adaptiveStrength: str,
    adaptiveIntelligence: int,
    penFlat: flat.PhysicalPenetrationFlat ?? 0,
    penPercent: flat.PhysicalPenetrationPercent ?? 0,
    cdrPercent: flat.CooldownReductionPercent ?? 0,
  }
}

export function snapshotDefender(enemy: EnemyInput): DefenderSnapshot {
  const god = getGod(enemy.godId)
  const items = enemy.items?.map(getItem) ?? []
  const { flat } = sumItemStats(items)
  const baseHealth = statAt(god, 'MaxHealth', enemy.level)
  const basePhysProt = statAt(god, 'PhysicalProtection', enemy.level)
  const baseMagProt = statAt(god, 'MagicalProtection', enemy.level)
  const maxHealth = baseHealth + (flat.MaxHealth ?? 0) + (enemy.flatHealthBonus ?? 0)
  return {
    god,
    level: enemy.level,
    maxHealth,
    currentHealth: maxHealth,
    physicalProtection: basePhysProt + (flat.PhysicalProtection ?? 0),
    magicalProtection: baseMagProt + (flat.MagicalProtection ?? 0),
  }
}
