/**
 * Rotation walker built on the god-agnostic engine. Emits damage events for
 * each rotation action against the defender snapshot.
 *
 * Mechanics implemented:
 *   - Ability damage formula: basePlusScalings × defenseMultiplier × (1 − mitigation%)
 *   - Per-god active mid-combo buffs: A3-style +STR/+INT during a window
 *   - Kali rupture passive: basics apply stacks, abilities consume for bonus damage
 *   - Hydra's Lament: next-basic damage multiplier (×1.3 melee, ×1.2 ranged)
 *   - Bumba's Cudgel: +50 true damage per basic (max 3) + +10 true damage post-ability
 *   - A2 Lash bleed: 5 ticks
 *
 * Not yet implemented:
 *   - Cooldowns, attack-speed timing
 *   - DoT ticks spread over time (bleed is lumped)
 *   - Active items (Bloodforge shield)
 *   - Aspects
 *   - Time-window buffs / short-window buffs
 */

import {
  snapshotAttacker,
  snapshotDefender,
  type AttackerSnapshot,
  type DefenderSnapshot,
  type Scenario,
  type AbilitySlot,
} from './engine.ts'
import { abilityRowAt } from '../catalog/loadCatalogs.ts'
import { applyDefense } from './formula.ts'

export interface DamageEvent {
  t: number // seconds (placeholder, zero until timing is added)
  label: string
  source: 'ability' | 'basic' | 'item' | 'passive' | 'dot'
  damageType: 'physical' | 'magical' | 'true'
  preMitigation: number
  postMitigation: number
  notes?: string[]
}

export interface SimResult {
  scenario: { title: string; attacker: AttackerSnapshot; defender: DefenderSnapshot }
  events: DamageEvent[]
  totals: { physical: number; magical: number; true: number; total: number }
  byLabel: Record<string, number>
  overkill: number
  assumptions: string[]
}

// Per-god ability handler interface — each god can override how specific abilities
// resolve (damage formula, applied buffs, consumed stacks). Fall back to a generic
// "base + scaling" resolver if no handler is registered.
interface AbilityContext {
  attacker: AttackerSnapshot
  defender: DefenderSnapshot
  slot: AbilitySlot
  emit: (ev: DamageEvent) => void
  // Mutable combat state the handlers read/write
  state: CombatState
}

interface CombatState {
  // Active buffs on the attacker (e.g. Kali A3 Strength Buff)
  strengthBuff: number
  intelligenceBuff: number
  // Riders pending on the next basic
  pendingHydraMultiplier: number | null // e.g. 1.3 or 1.2
  pendingBumbaPostAbilityTrue: number // total true damage to apply on next basic
  // Rupture stacks on the defender (Kali)
  ruptureStacks: number
  // Bumba per-basic counter (+50 true damage × first 3 basics)
  bumbaBasicsUsed: number
  // Basic chain index (0 → first, 1 → second, wraps)
  basicChainIndex: number
}

function initialCombatState(): CombatState {
  return {
    strengthBuff: 0,
    intelligenceBuff: 0,
    pendingHydraMultiplier: null,
    pendingBumbaPostAbilityTrue: 0,
    ruptureStacks: 0,
    bumbaBasicsUsed: 0,
    basicChainIndex: 0,
  }
}

function defenseFor(attacker: AttackerSnapshot, defender: DefenderSnapshot, damageType: 'physical' | 'magical' | 'true', penPercentOverride?: number) {
  if (damageType === 'true') {
    return { targetProtection: 0, penFlat: 0, penPercent: 0 }
  }
  const prot = damageType === 'physical' ? defender.physicalProtection : defender.magicalProtection
  const penFlat = damageType === 'physical' ? attacker.penFlat : 0
  const penPercentFromItems = damageType === 'physical' ? attacker.penPercent : 0
  const penPercent = penPercentOverride ?? penPercentFromItems
  return { targetProtection: prot, penFlat, penPercent }
}

// --- Per-god ability handlers ---

// Resolves an ability damage instance using common Base Damage + STR/INT scaling rows.
// Returns null if the ability has no numerical rank values (pure utility).
function resolveGenericAbilityDamage(ctx: AbilityContext, rank: number, opts: { baseRow?: string; strScaleRow?: string; intScaleRow?: string; damageType?: 'physical' | 'magical' | 'true' }): { pre: number; damageType: 'physical' | 'magical' | 'true' } | null {
  const ability = ctx.attacker.god.abilities[ctx.slot]
  if (!ability) return null
  const baseRow = opts.baseRow ?? 'Base Damage'
  const base = abilityRowAt(ctx.attacker.god, ctx.slot, baseRow, rank)
  if (base == null) return null
  const strScale = opts.strScaleRow ? abilityRowAt(ctx.attacker.god, ctx.slot, opts.strScaleRow, rank) ?? 0 : 0
  const intScale = opts.intScaleRow ? abilityRowAt(ctx.attacker.god, ctx.slot, opts.intScaleRow, rank) ?? 0 : 0
  const totalStr = ctx.attacker.adaptiveStrength + ctx.state.strengthBuff
  const totalInt = ctx.attacker.adaptiveIntelligence + ctx.state.intelligenceBuff
  const pre = base + totalStr * strScale + totalInt * intScale
  const damageType = opts.damageType ?? ability.damageType ?? 'physical'
  return { pre, damageType }
}

// Kali-specific ability handler registry
const KaliHandlers: Partial<Record<AbilitySlot, (ctx: AbilityContext, rank: number) => void>> = {
  A01: (ctx, rank) => {
    // Nimble Strike: Base Damage + Strength Scaling
    const dmg = resolveGenericAbilityDamage(ctx, rank, {
      baseRow: 'Base Damage',
      strScaleRow: 'Strength Scaling',
      damageType: 'physical',
    })
    if (!dmg) return
    const def = defenseFor(ctx.attacker, ctx.defender, dmg.damageType)
    const post = applyDefense(dmg.pre, def)
    // Rupture proc: each consumed stack adds passive RuptureProcDamage
    const consumed = ctx.state.ruptureStacks
    if (consumed > 0) {
      const base = abilityRowAt(ctx.attacker.god, 'A01' as AbilitySlot, 'RuptureProcDamageBase', ctx.attacker.level)
      void base // rupture row lives on the passive, not A01 EffectValues — handled via applyRuptureConsumption instead
    }
    ctx.emit({ t: 0, label: 'A1 Nimble Strike', source: 'ability', damageType: dmg.damageType, preMitigation: dmg.pre, postMitigation: post })
    applyRuptureConsumption(ctx)
    scheduleItemRiders(ctx, 'ability')
  },
  A02: (ctx, rank) => {
    // Lash: impact + 5-tick bleed
    const impact = resolveGenericAbilityDamage(ctx, rank, {
      baseRow: 'Base Damage',
      strScaleRow: 'Scaling',
      intScaleRow: 'Int Scaling',
      damageType: 'physical',
    })
    if (impact) {
      const def = defenseFor(ctx.attacker, ctx.defender, impact.damageType)
      const post = applyDefense(impact.pre, def)
      ctx.emit({ t: 0, label: 'A2 Lash (impact)', source: 'ability', damageType: impact.damageType, preMitigation: impact.pre, postMitigation: post })
    }
    // Bleed: 5 ticks at rank's Bleed Damage + Bleed Str Scaling + Bleed Int Scaling
    const bleedBase = abilityRowAt(ctx.attacker.god, 'A02' as AbilitySlot, 'Bleed Damage', rank) ?? 0
    const bleedStr = abilityRowAt(ctx.attacker.god, 'A02' as AbilitySlot, 'Bleed Str Scaling', rank) ?? 0
    const bleedInt = abilityRowAt(ctx.attacker.god, 'A02' as AbilitySlot, 'Bleed Int Scaling', rank) ?? 0
    const totalStr = ctx.attacker.adaptiveStrength + ctx.state.strengthBuff
    const totalInt = ctx.attacker.adaptiveIntelligence + ctx.state.intelligenceBuff
    const perTick = bleedBase + totalStr * bleedStr + totalInt * bleedInt
    if (perTick > 0) {
      const def = defenseFor(ctx.attacker, ctx.defender, 'physical')
      for (let i = 1; i <= 5; i++) {
        const post = applyDefense(perTick, def)
        ctx.emit({ t: 0, label: `A2 Lash (bleed ${i}/5)`, source: 'dot', damageType: 'physical', preMitigation: perTick, postMitigation: post })
      }
    }
    applyRuptureConsumption(ctx)
    scheduleItemRiders(ctx, 'ability')
  },
  A03: (ctx, rank) => {
    // Incense: direct damage has no scaling (game-file confirmed) + grants STR/INT buff
    const base = abilityRowAt(ctx.attacker.god, 'A03' as AbilitySlot, 'Base Damage', rank)
    if (base != null && base > 0) {
      const def = defenseFor(ctx.attacker, ctx.defender, 'physical')
      const post = applyDefense(base, def)
      ctx.emit({ t: 0, label: 'A3 Incense (cast)', source: 'ability', damageType: 'physical', preMitigation: base, postMitigation: post, notes: ['flat damage — no STR/INT scaling on direct cast'] })
    }
    const strBuff = abilityRowAt(ctx.attacker.god, 'A03' as AbilitySlot, 'Strength Buff', rank) ?? 0
    const intBuff = abilityRowAt(ctx.attacker.god, 'A03' as AbilitySlot, 'Intelligence Buff', rank) ?? 0
    ctx.state.strengthBuff += strBuff
    ctx.state.intelligenceBuff += intBuff
    applyRuptureConsumption(ctx)
    scheduleItemRiders(ctx, 'ability')
  },
}

// --- Rupture mechanic (Kali passive) ---

function ruptureStackCap(): number { return 3 }

function applyRuptureOnBasicHit(ctx: AbilityContext) {
  if (ctx.attacker.god.god !== 'Kali') return
  if (ctx.state.ruptureStacks < ruptureStackCap()) {
    ctx.state.ruptureStacks += 1
  }
}

function applyRuptureConsumption(ctx: AbilityContext) {
  if (ctx.attacker.god.god !== 'Kali') return
  const consumed = ctx.state.ruptureStacks
  if (consumed <= 0) return
  const passiveStructureFloats = ctx.attacker.god.abilityEffects?.Passive ?? []
  // The passive GE tags indicate per-level scaling. Without a clean curve read,
  // approximate: RuptureProcDamage = 10 + 2 × level per stack. These values are
  // reasonable SMITE 2 defaults; refine when the passive EffectValues become probed.
  const perStack = 10 + 2 * ctx.attacker.level
  const pre = perStack * consumed
  const def = defenseFor(ctx.attacker, ctx.defender, 'physical')
  const post = applyDefense(pre, def)
  ctx.emit({
    t: 0,
    label: `Rupture proc (${consumed} stacks)`,
    source: 'passive',
    damageType: 'physical',
    preMitigation: pre,
    postMitigation: post,
    notes: [`${perStack}/stack × ${consumed} stacks`, 'approximate — passive curve not yet ingested'],
  })
  ctx.state.ruptureStacks = 0
  void passiveStructureFloats
}

// --- Item riders ---

function scheduleItemRiders(ctx: AbilityContext, trigger: 'ability' | 'basic') {
  if (trigger !== 'ability') return
  const hasHydra = ctx.attacker.items.some((i) => /Hydra/i.test(i.displayName ?? ''))
  const hasBumba = ctx.attacker.items.some((i) => /Bumba/i.test(i.displayName ?? ''))
  if (hasHydra) {
    // Melee god = ×1.3; ranged = ×1.2. Kali is melee.
    ctx.state.pendingHydraMultiplier = isMelee(ctx.attacker) ? 1.3 : 1.2
  }
  if (hasBumba) {
    ctx.state.pendingBumbaPostAbilityTrue = 10
  }
}

function isMelee(attacker: AttackerSnapshot): boolean {
  // Heuristic: melee gods have BaseAttackSpeed around 1.0-1.1; ranged around 0.85-0.95
  return attacker.baseAttackSpeed >= 0.96
}

// --- Basic attack resolver ---

function performBasic(ctx: AbilityContext, label: string) {
  const chainMultipliers = [1.0, 0.5, 0.5] // Kali's basic chain — needs generalization per god
  const mult = chainMultipliers[ctx.state.basicChainIndex % chainMultipliers.length]
  ctx.state.basicChainIndex += 1

  const effectivePower = ctx.attacker.inhandPower + ctx.attacker.adaptiveStrength + ctx.state.strengthBuff
  let pre = effectivePower * mult

  // Apply Hydra multiplier if pending
  const hydraMultiplier = ctx.state.pendingHydraMultiplier
  if (hydraMultiplier) {
    pre *= hydraMultiplier
    ctx.state.pendingHydraMultiplier = null
  }

  const def = defenseFor(ctx.attacker, ctx.defender, 'physical')
  const post = applyDefense(pre, def)
  ctx.emit({
    t: 0,
    label,
    source: 'basic',
    damageType: 'physical',
    preMitigation: pre,
    postMitigation: post,
    notes: hydraMultiplier ? [`×${hydraMultiplier} Hydra multiplier`] : undefined,
  })

  // Kali rupture: basics apply a stack
  applyRuptureOnBasicHit(ctx)

  // Bumba per-basic true damage (first 3 basics)
  if (ctx.attacker.items.some((i) => /Bumba/i.test(i.displayName ?? '')) && ctx.state.bumbaBasicsUsed < 3) {
    ctx.emit({ t: 0, label: 'Bumba true (per-basic)', source: 'item', damageType: 'true', preMitigation: 50, postMitigation: 50 })
    ctx.state.bumbaBasicsUsed += 1
  }

  // Bumba post-ability rider
  if (ctx.state.pendingBumbaPostAbilityTrue > 0) {
    const v = ctx.state.pendingBumbaPostAbilityTrue
    ctx.emit({ t: 0, label: 'Bumba post-ability true', source: 'item', damageType: 'true', preMitigation: v, postMitigation: v })
    ctx.state.pendingBumbaPostAbilityTrue = 0
  }
}

// --- Main entry point ---

export function runScenario(scenario: Scenario): SimResult {
  const attacker = snapshotAttacker(scenario.attacker)
  const defender = snapshotDefender(scenario.defender)
  const state = initialCombatState()
  const events: DamageEvent[] = []
  const emit = (ev: DamageEvent) => events.push(ev)

  const baseCtx: Omit<AbilityContext, 'slot'> = { attacker, defender, emit, state }
  const god = attacker.god

  for (const action of scenario.rotation) {
    if (action.kind === 'wait') continue
    if (action.kind === 'basic') {
      const label = action.label ?? `AA${state.basicChainIndex + 1}`
      const ctx: AbilityContext = { ...baseCtx, slot: 'A01' } // slot irrelevant for basic
      performBasic(ctx, label)
      continue
    }
    // Ability
    const rank = scenario.attacker.abilityRanks[action.slot] ?? 1
    const ctx: AbilityContext = { ...baseCtx, slot: action.slot }
    const handler = god.god === 'Kali' ? KaliHandlers[action.slot] : undefined
    if (handler) {
      handler(ctx, rank)
    } else {
      // Generic fallback: Base Damage + Strength/Int scaling if present
      const dmg = resolveGenericAbilityDamage(ctx, rank, {
        baseRow: 'Base Damage',
        strScaleRow: 'Strength Scaling',
        intScaleRow: 'Int Scaling',
      })
      if (dmg) {
        const def = defenseFor(ctx.attacker, ctx.defender, dmg.damageType, scenario.options?.penPercentOverride)
        const post = applyDefense(dmg.pre, def)
        ctx.emit({ t: 0, label: action.label ?? `${action.slot}`, source: 'ability', damageType: dmg.damageType, preMitigation: dmg.pre, postMitigation: post })
      }
      applyRuptureConsumption(ctx)
      scheduleItemRiders(ctx, 'ability')
    }
  }

  // Totals + damage-source breakdown
  const totals = { physical: 0, magical: 0, true: 0, total: 0 }
  const byLabel: Record<string, number> = {}
  let overkill = 0
  let remainingHP = defender.currentHealth
  for (const ev of events) {
    totals[ev.damageType] += ev.postMitigation
    totals.total += ev.postMitigation
    byLabel[ev.label] = (byLabel[ev.label] ?? 0) + ev.postMitigation
    if (remainingHP > 0) {
      const applied = Math.min(remainingHP, ev.postMitigation)
      remainingHP -= ev.postMitigation
      if (remainingHP < 0) overkill += -remainingHP
      void applied
    } else {
      overkill += ev.postMitigation
    }
  }

  return {
    scenario: { title: scenario.title, attacker, defender },
    events,
    totals,
    byLabel,
    overkill,
    assumptions: [
      `Kali rupture proc damage approximated as 10 + 2 × level per stack (passive curve not yet ingested)`,
      `Hydra multiplier: ${isMelee(attacker) ? '×1.3 (melee)' : '×1.2 (ranged)'}`,
    ],
  }
}

export type { Scenario, AttackerSnapshot, DefenderSnapshot }
