/**
 * Mutable combat state that handlers read and write during a scenario run.
 *
 * Tracks the attacker's active self-buffs, pending riders on the next basic/ability,
 * cooldowns, the current time cursor, and per-target debuff state.
 */

import type { AbilitySlot, DamageType, TimelineEvent } from './types.ts'

export interface ActiveBuff {
  key: string                                // stable identifier for stacking/refresh
  label: string
  appliedAt: number
  expiresAt: number
  modifiers: Partial<Record<string, number>> // flat stat additions while active
  stacks: number
  stacksMax?: number
}

export interface ActiveDebuff {
  key: string
  label: string
  appliedAt: number
  expiresAt: number
  stacks: number
  modifiers: Partial<Record<string, number>> // flat modifiers applied PER STACK
  stacksMax?: number
}

export interface PendingBasicDamageRider {
  label: string
  damageType: DamageType
  baseDamage: number
  strScaling: number
  intScaling: number
  expiresAt: number
}

export interface ActiveBasicProjectileRider {
  key: string
  label: string
  damageType: DamageType
  baseDamage: number
  inhandScaling: number
  hits: number
  expiresAt: number
}

export interface RiderState {
  /** Multiplier on the next basic's pre-mitigation damage. Used by Hydra. */
  nextBasicMultiplier: number | null
  /** Bonus true damage appended to the next basic (Bumba post-ability). */
  nextBasicBonusTrue: number
  /** Ability-provided bonus damage attached to the next basic attack. */
  nextBasicBonusDamages: PendingBasicDamageRider[]
  /** Number of Kali rupture stacks on the current defender. */
  ruptureStacks: number
  /** Bumba per-basic charges used (caps at 3). */
  bumbaBasicsUsed: number
  /** Current index in the basic attack chain (for DAMAGE multipliers). Preserves
   *  across ability casts — Kali's post-ability AA in validated in-game tests
   *  uses chain-2 damage, so abilities don't reset this counter. */
  basicChainIndex: number
  /** Separate counter for swing-TIME chain position. Resets when an ability is
   *  cast (next AA uses Fire_01 authored swing time) per user-observed behavior. */
  basicSwingChainIndex: number
  /** Per-item counters for effects like "every fourth attack". */
  itemProcCounters: Record<string, number>
  /** Active item effects that add extra projectile damage to each basic. */
  activeBasicProjectiles: ActiveBasicProjectileRider[]
  /** Active/item rider: next non-ultimate ability used should not go on cooldown. */
  nextNonUltimateNoCooldown: boolean
}

export interface CooldownState {
  abilities: Record<AbilitySlot, number>    // timestamp at which ability is off-cooldown
  basic: number                             // next-basic timestamp (advances by 1 / AS)
  actives: Record<string, number>           // item active cooldowns by item key
}

export interface CombatState {
  t: number
  attackerBuffs: Map<string, ActiveBuff>
  enemyDebuffs: Map<string, ActiveDebuff>
  riders: RiderState
  cooldowns: CooldownState
  events: TimelineEvent[]
  /** Tracked per-target HP so multi-hit sequences respect overkill. */
  defenderCurrentHP: number
  /** Accumulated overkill (damage past 0 HP). */
  overkill: number
}

export function createCombatState(defenderMaxHP: number): CombatState {
  return {
    t: 0,
    attackerBuffs: new Map(),
    enemyDebuffs: new Map(),
    riders: {
      nextBasicMultiplier: null,
      nextBasicBonusTrue: 0,
      nextBasicBonusDamages: [],
      ruptureStacks: 0,
      bumbaBasicsUsed: 0,
      basicChainIndex: 0,
      basicSwingChainIndex: 0,
      itemProcCounters: {},
      activeBasicProjectiles: [],
      nextNonUltimateNoCooldown: false,
    },
    cooldowns: {
      abilities: { A01: 0, A02: 0, A03: 0, A04: 0 },
      basic: 0,
      actives: {},
    },
    events: [],
    defenderCurrentHP: defenderMaxHP,
    overkill: 0,
  }
}

/** Expire any buff/debuff whose expiresAt <= current time, emitting events. */
export function expireTimedEffects(state: CombatState) {
  for (const [key, buff] of Array.from(state.attackerBuffs.entries())) {
    if (buff.expiresAt <= state.t) {
      state.attackerBuffs.delete(key)
      state.events.push({ kind: 'buff-expire', t: state.t, label: buff.label, target: 'self' })
    }
  }
  for (const [key, debuff] of Array.from(state.enemyDebuffs.entries())) {
    if (debuff.expiresAt <= state.t) {
      state.enemyDebuffs.delete(key)
      state.events.push({ kind: 'buff-expire', t: state.t, label: debuff.label, target: 'enemy' })
    }
  }
}

/** Sum the flat stat contribution from all active buffs/debuffs for a stat key. */
export function buffStatDelta(state: CombatState, statKey: string): number {
  let delta = 0
  for (const buff of state.attackerBuffs.values()) {
    delta += (buff.modifiers[statKey] ?? 0) * buff.stacks
  }
  return delta
}

/** Return the per-stack-scaled debuff delta applied to a target stat (e.g. Oath-Sworn prot shred). */
export function enemyDebuffStatDelta(state: CombatState, statKey: string): number {
  let delta = 0
  for (const debuff of state.enemyDebuffs.values()) {
    const perStack = debuff.modifiers[statKey] ?? 0
    delta += perStack * debuff.stacks
  }
  return delta
}

export function applyOrRefreshBuff(
  state: CombatState,
  buff: Omit<ActiveBuff, 'appliedAt' | 'stacks'> & { addStacks?: number },
) {
  const existing = state.attackerBuffs.get(buff.key)
  if (existing) {
    existing.expiresAt = Math.max(existing.expiresAt, buff.expiresAt)
    existing.modifiers = buff.modifiers
    existing.stacksMax = buff.stacksMax ?? existing.stacksMax
    if (buff.addStacks) {
      existing.stacks = Math.min(existing.stacks + buff.addStacks, existing.stacksMax ?? Infinity)
    }
  } else {
    const { addStacks, ...storedBuff } = buff
    state.attackerBuffs.set(buff.key, {
      ...storedBuff,
      appliedAt: state.t,
      stacks: addStacks == null ? 1 : Math.max(0, addStacks),
    })
    state.events.push({
      kind: 'buff-apply',
      t: state.t,
      label: buff.label,
      target: 'self',
      durationSeconds: buff.expiresAt - state.t,
      expiresAt: buff.expiresAt,
    })
  }
}

export function applyOrRefreshDebuff(
  state: CombatState,
  debuff: Omit<ActiveDebuff, 'appliedAt' | 'stacks'> & { addStacks?: number },
) {
  const existing = state.enemyDebuffs.get(debuff.key)
  const addStacks = debuff.addStacks ?? 1
  if (existing) {
    existing.expiresAt = Math.max(existing.expiresAt, debuff.expiresAt)
    existing.stacks = Math.min(existing.stacks + addStacks, debuff.stacksMax ?? Infinity)
    existing.modifiers = debuff.modifiers
  } else {
    state.enemyDebuffs.set(debuff.key, {
      ...debuff,
      appliedAt: state.t,
      stacks: addStacks,
    })
    state.events.push({
      kind: 'buff-apply',
      t: state.t,
      label: debuff.label,
      target: 'enemy',
      durationSeconds: debuff.expiresAt - state.t,
      expiresAt: debuff.expiresAt,
    })
  }
}
