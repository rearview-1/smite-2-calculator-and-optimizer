import type { Curve } from './curve.ts'

export type DamageType = 'physical' | 'magical' | 'true'

export type StatTag =
  | 'MaxHealth'
  | 'MaxMana'
  | 'HealthPerTime'
  | 'ManaPerTime'
  | 'PhysicalProtection'
  | 'MagicalProtection'
  | 'MovementSpeed'
  | 'BaseAttackSpeed'
  | 'AttackSpeedPercent'
  | 'InhandPower'
  | 'MagicalPower'
  | 'Strength'
  | 'Intelligence'
  | 'PhysicalPenetrationFlat'
  | 'PhysicalPenetrationPercent'
  | 'MagicalPenetrationFlat'
  | 'MagicalPenetrationPercent'
  | 'CritChance'
  | 'CooldownReductionPercent'
  | 'PhysicalInhandLifestealPercent'
  | 'PhysicalAbilityLifestealPercent'
  | 'MagicalInhandLifestealPercent'
  | 'MagicalAbilityLifestealPercent'

export type AbilitySlot = 'A1' | 'A2' | 'A3' | 'A4' | 'Passive'

export interface GodDef {
  id: string
  displayName: string
  primaryDamageType: DamageType
  statCurves: Partial<Record<StatTag, Curve>>
  abilities: Record<AbilitySlot, AbilityDef | null>
  basicChain: number[]
}

export interface AbilityDef {
  slot: AbilitySlot
  displayName: string
  rankValues: Record<string, Curve>
  tags: string[]
}

export interface ItemDef {
  id: string
  displayName: string
  tier: 'starter' | 't1' | 't2' | 't3' | 'evolved' | 'relic'
  flatStats: Partial<Record<StatTag, number>>
  adaptiveStrength?: number
  adaptiveIntelligence?: number
  effects: ItemEffectDef[]
}

export type ItemEffectDef =
  | {
      kind: 'onAbilityCast_nextBasic'
      bonusDamage: number
      damageType: DamageType
      id: string
      note?: string
    }
  | {
      kind: 'onBasicHit_trueDamage'
      perHit: number
      maxTriggers?: number
      id: string
      note?: string
    }
  | {
      kind: 'onAbilityHit_nextBasic'
      powerMultiplier: number
      damageType: DamageType
      id: string
      note?: string
    }
  | {
      kind: 'flatStackedPower'
      perStackStrength?: number
      perStackIntelligence?: number
      maxStacks: number
      id: string
      note?: string
    }
