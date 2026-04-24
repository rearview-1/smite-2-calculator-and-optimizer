/**
 * Full god-agnostic combat engine.
 *
 *   runScenario(scenario) → SimResult
 *
 * Walks the rotation with real time tracking. Abilities gate on cooldown;
 * basics gate on 1 / effective-attack-speed. DoTs schedule tick events at
 * their real offsets. Self-buffs have duration windows; expire mid-combo
 * at the right moment. Item procs and target debuffs apply via hooks.
 */

import {
  getGod, getItem,
  getAbilityTiming,
  getBasicAttackMetadata,
  getBasicChain,
  inferGodDamageType,
  resolveItemStatsWithOverrides,
  statAt,
  abilityRowAt,
  type GodCatalogEntry,
  type ItemCatalogEntry,
} from '../../catalog/loadCatalogs.ts'
import { interp } from '../../catalog/curve.ts'
import { getAspectAbilityRows } from '../../catalog/aspectCurves.ts'
import { applyDefense } from '../formula.ts'
import { conditionalBonusFor } from '../../catalog/conditionalItems.ts'
import { findGodLockedItem, interpRank, type AcornAbilityMod } from '../../catalog/godLockedItems.ts'
import { hasMissingStatRows } from '../../catalog/itemEligibility.ts'
import {
  buildAbilityPlan,
  type AbilityPlan,
  type DamagePlan,
} from './abilityResolver.ts'
import type { HandlerContext } from './godHandlers.ts'
import {
  createCombatState,
  expireTimedEffects,
  buffStatDelta,
  enemyDebuffStatDelta,
  applyOrRefreshBuff,
  applyOrRefreshDebuff,
  type CombatState,
} from './combatState.ts'
import { getItemProcs } from './itemEffects.ts'
import type {
  AbilitySlot, DamageEvent, DamageType, RotationAction, Scenario, SimResult,
} from './types.ts'
import { DROP_BUFFS } from './buffs.ts'
import { getGodHandler } from './godHandlers.ts'

const UNIVERSAL_MS_MULT = 1.18  // GE_IncreasedStartingMovementSpeed
const BASIC_CHAIN_DEFAULTS: Record<string, number[]> = {
  Kali: [1.0, 0.5, 0.5],
  // Default for any unknown god — treat as single-hit basics with 1.0 scale
  __default: [1.0],
}
const MORRIGAN_DARK_OMEN_EXPIRES_KEY = 'TheMorrigan.A02.omen.expires'
const MORRIGAN_DARK_OMEN_BASE_KEY = 'TheMorrigan.A02.omen.base'
const MORRIGAN_DARK_OMEN_SCALE_KEY = 'TheMorrigan.A02.omen.intScale'
const NUT_CONVERGENCE_ACTIVE_KEY = 'Nut.A01.active'
const NUT_CONVERGENCE_SIDE_BASE_KEY = 'Nut.A01.sideBaseDamage'
const NUT_CONVERGENCE_SIDE_STR_KEY = 'Nut.A01.sideStrengthScaling'
const NUT_CONVERGENCE_SIDE_INT_KEY = 'Nut.A01.sideIntScaling'
const NUT_CONVERGENCE_SIDE_COUNT_KEY = 'Nut.A01.sideProjectileCount'
const NUT_CONVERGENCE_PROT_PCT_KEY = 'Nut.A01.protDebuffPct'
const NUT_CONVERGENCE_PROT_DEBUFF_KEY = 'Nut.A01.protDebuff'
const NUT_CONVERGENCE_PROT_DEBUFF_DURATION = 5

interface AttackerSnapshot {
  god: GodCatalogEntry
  level: number
  abilityRanks: Record<AbilitySlot, number>
  items: ItemCatalogEntry[]
  relics: ItemCatalogEntry[]
  aspects: string[]
  godState: Record<string, number | boolean | string>
  partialStacks: Record<string, number>
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
  adaptiveStrength: number
  adaptiveIntelligence: number
  penFlat: number
  penPercent: number
  magicalPenFlat: number
  magicalPenPercent: number
  cooldownStat: number
  cdrPercent: number
  critChance: number
  critDamageBonus: number
  lifestealGeneric: number
  lifestealMagical: number
  lifestealPhysicalInhand: number
  lifestealPhysicalAbility: number
  basicAttackDamageType: DamageType
  basicAttacksCanCrit: boolean
  primaryStat: 'STR' | 'INT' | 'hybrid'
}

interface DefenderSnapshot {
  god: GodCatalogEntry
  level: number
  baseHealth: number
  itemHealthBonus: number
  maxHealth: number
  physicalProtection: number
  magicalProtection: number
}

function chooseAdaptiveStat(
  choice: { strength: number; intelligence: number },
  itemStrength: number,
  itemIntelligence: number,
  primaryStat: 'STR' | 'INT' | 'hybrid',
) {
  if (itemStrength > itemIntelligence) return { strength: choice.strength, intelligence: 0 }
  if (itemIntelligence > itemStrength) return { strength: 0, intelligence: choice.intelligence }
  if (primaryStat === 'INT') return { strength: 0, intelligence: choice.intelligence }
  return { strength: choice.strength, intelligence: 0 }
}

function effectiveCdrPercent(cooldownStat: number): number {
  return cooldownStat <= 0 ? 0 : (cooldownStat / (cooldownStat + 100)) * 100
}

function stackCountFor(item: ItemCatalogEntry, partialStacks: Record<string, number>): number {
  return partialStacks[item.internalKey ?? '']
    ?? partialStacks[item.displayName ?? '']
    ?? 0
}

/** Best-effort: return an item's max stack count if its passive says so.
 *  Returns null for items that don't stack. Reads the same patterns as
 *  `addGenericStackStats` below so the two stay consistent. */
export function maxStackCountFor(item: ItemCatalogEntry): number | null {
  const internal = (item.internalKey ?? '').toLowerCase()
  // Hard-coded caps for items whose passive phrasing doesn't match the regex.
  if (internal.includes('transcend') || internal.includes('bookofthoth') || internal.includes('book_of_thoth')) return 50
  if (internal.includes('rage')) return 5
  const passive = normalizePassiveText(item.passive)
  const m = /max\s+(\d+)\s+Stacks/i.exec(passive)
    ?? /Stacks? up to\s+(\d+)\s+times/i.exec(passive)
    ?? /up to\s+(\d+)\s+Stacks/i.exec(passive)
  if (m) return Number(m[1])
  const evolve = /At\s+(\d+)\s+Stacks/i.exec(passive)
  if (evolve) return Number(evolve[1])
  return null
}

const AUTO_EVOLVE_STACK_ITEM_KEYS = new Set([
  'item.bookofthoth',
  'item.devourersgauntlet',
  'item.the nemes',
  'item.transcendance',
])

/** Auto-evolve is for durable farm/quest stacks that are normally complete in
 *  a late-game build. Combat-window, kill/assist-only, or temporary stacks must
 *  be supplied explicitly through partialStacks or scenario actions. */
export function shouldAutoEvolveStackingItem(item: ItemCatalogEntry): boolean {
  const key = (item.internalKey ?? '').toLowerCase()
  return AUTO_EVOLVE_STACK_ITEM_KEYS.has(key)
}

/** True if the item has any `On Use:` clause (pressable active). */
export function itemHasActive(item: ItemCatalogEntry): boolean {
  return /on use:/i.test(item.passive ?? '')
}

function itemStatAmplifierPct(item: ItemCatalogEntry): number {
  const passive = item.passive ?? ''
  const m = /\+(\d+(?:\.\d+)?)%\s+of all Stats from Items/i.exec(passive)
  return m ? Number(m[1]) : 0
}

function itemIntelligenceAmplifierPct(item: ItemCatalogEntry): number {
  const key = item.internalKey ?? ''
  if (key !== 'item.EldritchOrb') return 0
  for (const effect of item.geEffects ?? []) {
    const refs = new Set(effect.asciiRefs ?? [])
    if (!refs.has('IncreasedIntelligence') || !refs.has('MagicalPower')) continue
    const pct = effect.interestingFloats.find((f) => f.value > 0 && f.value <= 1)?.value
    if (pct != null) return pct * 100
  }
  return /Multiply current Intelligence/i.test(item.passive ?? '') ? 25 : 0
}

function itemCritDamageBonusPct(item: ItemCatalogEntry): number {
  const passive = item.passive ?? ''
  const match = /\+(\d+(?:\.\d+)?)%\s+Critical Strike Damage/i.exec(passive)
  return match ? Number(match[1]) : 0
}

function itemHasTyphonsFangLifestealConversion(item: ItemCatalogEntry): boolean {
  return item.internalKey === 'Item.TyphonsFang'
}

function itemHasCosmicHorrorIntelligenceMode(item: ItemCatalogEntry): boolean {
  return item.internalKey === 'item.Staff of Cosmic Horror'
}

function itemHasTritonsConchAura(item: ItemCatalogEntry): boolean {
  return item.internalKey === "item.Triton's Conch"
}

function itemHasShogunsOfudaAura(item: ItemCatalogEntry): boolean {
  return item.internalKey === "item.Shogun's Ofuda"
}

function itemProtectionAmplifierPct(item: ItemCatalogEntry): { physical: number; magical: number } {
  const passive = item.passive ?? ''
  const physical = /\+(\d+(?:\.\d+)?)%\s+bonus Physical Protections from items/i.exec(passive)
  const magical = /\+(\d+(?:\.\d+)?)%\s+bonus Magical Protections from items/i.exec(passive)
  return {
    physical: physical ? Number(physical[1]) : 0,
    magical: magical ? Number(magical[1]) : 0,
  }
}

function normalizePassiveText(passive: string | null | undefined): string {
  return (passive ?? '').replace(/[•·]/g, ' ').replace(/\s+/g, ' ').trim()
}

function addGenericStackStats(
  item: ItemCatalogEntry,
  stackCount: number,
  flat: Record<string, number>,
): { str: number; int: number } {
  if (stackCount <= 0 || !item.passive) return { str: 0, int: 0 }
  const passive = normalizePassiveText(item.passive)
  const maxMatch = /max\s+(\d+)\s+Stacks/i.exec(passive)
    ?? /Stacks? up to\s+(\d+)\s+times/i.exec(passive)
  const effectiveStacks = maxMatch ? Math.min(stackCount, Number(maxMatch[1])) : stackCount
  let str = 0
  let int = 0

  const perStackPatterns: Array<[RegExp, (value: number) => void]> = [
    [/Per Stack[^:]*:\s*\+?(\.?\d+(?:\.\d+)?)\s+Strength/i, (v) => { str += v * effectiveStacks }],
    [/Per Stack[^:]*:\s*\+?(\.?\d+(?:\.\d+)?)\s+Intelligence/i, (v) => { int += v * effectiveStacks }],
    [/Stacks? grants?\s+\+?(\.?\d+(?:\.\d+)?)\s+Max Health/i, (v) => { flat.MaxHealth = (flat.MaxHealth ?? 0) + v * effectiveStacks }],
    [/Each Stack grants:[^+]*\+?(\.?\d+(?:\.\d+)?)\s+Strength/i, (v) => { str += v * effectiveStacks }],
    [/Each Stack grants:[^+]*\+?(\.?\d+(?:\.\d+)?)%\s+Lifesteal/i, (v) => {
      flat.PhysicalInhandLifestealPercent = (flat.PhysicalInhandLifestealPercent ?? 0) + v * effectiveStacks
    }],
    [/Stack(?:s)?(?: of)?:\s*\+?(\.?\d+(?:\.\d+)?)\s+Intelligence/i, (v) => { int += v * effectiveStacks }],
    [/\+?(\.?\d+(?:\.\d+)?)\s+Attack Damage/i, (v) => { flat.InhandPower = (flat.InhandPower ?? 0) + v * effectiveStacks }],
    [/Momentum grants\s+\+?(\.?\d+(?:\.\d+)?)%\s+Pathfinding/i, (v) => {
      flat.Pathfinding = (flat.Pathfinding ?? 0) + v * effectiveStacks
    }],
  ]

  for (const [pattern, apply] of perStackPatterns) {
    const match = pattern.exec(passive)
    if (match) apply(Number(match[1]))
  }

  const rageCrit = /God Kill or Assist:\s*\+?(\.?\d+(?:\.\d+)?)%\s+Critical Strike Chance\s*\(Max\s+(\.?\d+(?:\.\d+)?)%\)/i.exec(passive)
  if (rageCrit) {
    flat.CritChance = (flat.CritChance ?? 0) + Math.min(Number(rageCrit[1]) * effectiveStacks, Number(rageCrit[2]))
  }
  const rageEvolve = /After\s+(\d+)\s+God Kills or Assists:\s*\+?(\.?\d+(?:\.\d+)?)%\s+additional Critical Strike Chance/i.exec(passive)
  if (rageEvolve && stackCount >= Number(rageEvolve[1])) {
    flat.CritChance = (flat.CritChance ?? 0) + Number(rageEvolve[2])
  }

  const evolvedAtMatch = /At\s+(\d+)\s+Stacks/i.exec(passive)
  if (evolvedAtMatch && stackCount >= Number(evolvedAtMatch[1])) {
    const extraStrength = /At\s+\d+\s+Stacks[\s\S]*?\+(\d+(?:\.\d+)?)\s+Strength/i.exec(passive)
    const extraInt = /At\s+\d+\s+Stacks[\s\S]*?\+(\d+(?:\.\d+)?)\s+Intelligence/i.exec(passive)
    const extraHealth = /At\s+\d+\s+Stacks[\s\S]*?\+(\d+(?:\.\d+)?)\s+Max Health/i.exec(passive)
    const extraLifesteal = /At\s+\d+\s+Stacks[\s\S]*?\+(\d+(?:\.\d+)?)%\s+Lifesteal/i.exec(passive)
    if (extraStrength) str += Number(extraStrength[1])
    if (extraInt) int += Number(extraInt[1])
    if (extraHealth) flat.MaxHealth = (flat.MaxHealth ?? 0) + Number(extraHealth[1])
    if (extraLifesteal) {
      flat.PhysicalInhandLifestealPercent = (flat.PhysicalInhandLifestealPercent ?? 0) + Number(extraLifesteal[1])
    }
  }

  return { str, int }
}

function addStatMap(
  flat: Record<string, number>,
  addStrength: (value: number) => void,
  addIntelligence: (value: number) => void,
  stats: Record<string, number> | undefined,
  multiplier = 1,
) {
  if (!stats) return
  for (const [k, rawValue] of Object.entries(stats)) {
    const value = rawValue * multiplier
    if (k === 'PhysicalPower') addStrength(value)
    else if (k === 'MagicalPower') addIntelligence(value)
    else flat[k] = (flat[k] ?? 0) + value
  }
}

function sumItemStats(
  items: ItemCatalogEntry[],
  partialStacks: Record<string, number> = {},
  primaryStat: 'STR' | 'INT' | 'hybrid' = 'STR',
  forceConditional = false,
  level = 20,
) {
  const flat: Record<string, number> = {}
  let str = 0
  let int = 0
  let statAmplifierPct = 0
  let intelligenceAmplifierPct = 0
  let typhonsFangEquipped = false
  let cosmicHorrorEquipped = false
  let tritonsConchEquipped = false
  let shogunsOfudaEquipped = false
  let physicalProtectionAmplifierPct = 0
  let magicalProtectionAmplifierPct = 0
  const adaptiveChoices: Array<{ strength: number; intelligence: number }> = []
  for (const item of items) {
    const r = resolveItemStatsWithOverrides(item)
    // Conditional passive bonuses (Spirit Robe's +40 prot under CC, etc.)
    // are OFF by default; only added when the user opts in via
    // `options.forceConditionalItemEffects`.
    if (forceConditional) {
      const bonus = conditionalBonusFor(item.internalKey)
      addStatMap(flat, (v) => { str += v }, (v) => { int += v }, bonus?.stats)
      addStatMap(flat, (v) => { str += v }, (v) => { int += v }, bonus?.statsPerLevel, level)
      if (bonus?.itemProtectionAmplifierPct) {
        physicalProtectionAmplifierPct += bonus.itemProtectionAmplifierPct.physical
        magicalProtectionAmplifierPct += bonus.itemProtectionAmplifierPct.magical
      }
    }
    statAmplifierPct += itemStatAmplifierPct(item)
    intelligenceAmplifierPct += itemIntelligenceAmplifierPct(item)
    typhonsFangEquipped ||= itemHasTyphonsFangLifestealConversion(item)
    cosmicHorrorEquipped ||= itemHasCosmicHorrorIntelligenceMode(item)
    tritonsConchEquipped ||= itemHasTritonsConchAura(item)
    shogunsOfudaEquipped ||= itemHasShogunsOfudaAura(item)
    const protectionAmplifier = itemProtectionAmplifierPct(item)
    physicalProtectionAmplifierPct += protectionAmplifier.physical
    magicalProtectionAmplifierPct += protectionAmplifier.magical
    str += r.adaptiveStrength
    int += r.adaptiveIntelligence
    if (r.adaptiveChoice) adaptiveChoices.push(r.adaptiveChoice)
    for (const [k, v] of Object.entries(r.stats)) {
      flat[k] = (flat[k] ?? 0) + v
    }
    // Mana additions for mana-stacking items. The +Strength / +Intelligence evolve
    // bonuses are handled generically by addGenericStackStats below; do not add
    // them here or they will be counted twice.
    const stackCount = stackCountFor(item, partialStacks)
    if (stackCount && item.internalKey?.toLowerCase().includes('transcend')) {
      flat.MaxMana = (flat.MaxMana ?? 0) + stackCount * 7
      if (stackCount >= 50) flat.MaxMana = (flat.MaxMana ?? 0) + 100
    }
    if (stackCount && item.internalKey?.toLowerCase().includes('bookofthoth')) {
      flat.MaxMana = (flat.MaxMana ?? 0) + stackCount * 10
      if (stackCount >= 50) flat.MaxMana = (flat.MaxMana ?? 0) + 100
    }
    const genericStackStats = addGenericStackStats(item, stackCount, flat)
    str += genericStackStats.str
    int += genericStackStats.int
  }
  const itemStrengthBeforeAdaptive = str
  const itemIntelligenceBeforeAdaptive = int
  for (const choice of adaptiveChoices) {
    const picked = chooseAdaptiveStat(choice, itemStrengthBeforeAdaptive, itemIntelligenceBeforeAdaptive, primaryStat)
    str += picked.strength
    int += picked.intelligence
  }
  if (physicalProtectionAmplifierPct > 0 && flat.PhysicalProtection) {
    flat.PhysicalProtection *= 1 + physicalProtectionAmplifierPct / 100
  }
  if (magicalProtectionAmplifierPct > 0 && flat.MagicalProtection) {
    flat.MagicalProtection *= 1 + magicalProtectionAmplifierPct / 100
  }
  if (statAmplifierPct > 0) {
    const multiplier = 1 + statAmplifierPct / 100
    str *= multiplier
    int *= multiplier
    for (const key of Object.keys(flat)) {
      flat[key] *= multiplier
    }
  }
  if (tritonsConchEquipped) {
    str += 5 + 0.5 * level
    int += 5 + level
  }
  if (shogunsOfudaEquipped) {
    flat.AttackSpeedPercent = (flat.AttackSpeedPercent ?? 0) + 20
  }
  if (cosmicHorrorEquipped) {
    const echo = flat.EchoItem ?? 0
    const cdr = flat.CooldownReductionPercent ?? 0
    if (echo <= cdr) int += 35
  }
  if (typhonsFangEquipped) {
    const lifesteal = Math.max(
      0,
      flat.LifeStealPercent ?? 0,
      flat.MagicalLifestealPercent ?? 0,
      flat.PhysicalInhandLifestealPercent ?? 0,
      flat.PhysicalAbilityLifestealPercent ?? 0,
    )
    int += lifesteal * 1.8
  }
  if (intelligenceAmplifierPct > 0) {
    int *= 1 + intelligenceAmplifierPct / 100
  }
  return { flat, str, int }
}

export function inferPrimaryStat(god: GodCatalogEntry): 'STR' | 'INT' | 'hybrid' {
  const abilities = Object.values(god.abilities).filter(Boolean)
  const scalingTags = new Set<string>()
  for (const a of abilities) {
    for (const t of a?.scalingTags ?? []) scalingTags.add(t)
  }
  const hasStr = scalingTags.has('Physical') || scalingTags.has('Strength')
  const hasInt = scalingTags.has('Magical') || scalingTags.has('Intelligence')
  if (hasStr && hasInt) return 'hybrid'
  if (hasInt) return 'INT'
  return 'STR'
}

export function snapshotAttacker(scenario: Scenario): AttackerSnapshot {
  const build = scenario.attacker
  const god = getGod(build.godId)
  const items = build.items.map((name) => getItem(name, { godId: build.godId, aspects: build.aspects }))
  const relics = (build.relics ?? []).map((name) => getItem(name, { godId: build.godId, aspects: build.aspects }))
  const primaryStat = inferPrimaryStat(god)
  const forceConditional = scenario.options?.forceConditionalItemEffects === true
  const { flat, str, int } = sumItemStats(items, build.partialStacks ?? {}, primaryStat, forceConditional, build.level)

  // Mana-conversion items use mana from items only, including their own stacks.
  let adaptiveStrengthFromMana = 0
  let adaptiveIntelligenceFromMana = 0
  for (const item of items) {
    if (item.internalKey?.toLowerCase().includes('transcend')) {
      adaptiveStrengthFromMana += 0.03 * (flat.MaxMana ?? 0)
    }
    if (item.internalKey?.toLowerCase().includes('bookofthoth')) {
      const stacks = stackCountFor(item, build.partialStacks ?? {})
      const conversion = stacks >= 50 ? 0.07 : 0.05
      adaptiveIntelligenceFromMana += conversion * (flat.MaxMana ?? 0)
    }
  }

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

  const totalItemIntelligence = int + adaptiveIntelligenceFromMana
  const nimbleRingBonus = items.some((item) => item.internalKey === 'item.NimbleRing')
    ? Math.floor(totalItemIntelligence / 10)
    : 0
  const asTotal = attackSpeedPct + (flat.AttackSpeedPercent ?? 0) + nimbleRingBonus
  const cooldownStat = flat.CooldownReductionPercent ?? 0
  const basicAttackMeta = getBasicAttackMetadata(build.godId)
  const basicAttackDamageType = basicAttackMeta?.damageType ?? inferGodDamageType(god)

  return {
    god,
    level: build.level,
    abilityRanks: build.abilityRanks,
    items,
    relics,
    aspects: build.aspects ?? [],
    godState: build.godState ?? {},
    partialStacks: build.partialStacks ?? {},
    maxHealth: baseHealth + (flat.MaxHealth ?? 0),
    maxMana: baseMana + (flat.MaxMana ?? 0),
    healthPerTime: baseHPregen + (flat.HealthPerTime ?? 0),
    manaPerTime: baseMPregen + (flat.ManaPerTime ?? 0),
    physicalProtection: basePhysProt + (flat.PhysicalProtection ?? 0),
    magicalProtection: baseMagProt + (flat.MagicalProtection ?? 0),
    moveSpeed: (baseMoveSpeed + (flat.MovementSpeed ?? 0)) * UNIVERSAL_MS_MULT,
    baseAttackSpeed,
    attackSpeedPercent: asTotal,
    totalAttackSpeed: baseAttackSpeed * (1 + asTotal / 100),
    inhandPower: baseInhandPower + (flat.InhandPower ?? 0) + nimbleRingBonus,
    adaptiveStrength: str + adaptiveStrengthFromMana,
    adaptiveIntelligence: totalItemIntelligence,
    penFlat: flat.PhysicalPenetrationFlat ?? 0,
    penPercent: flat.PhysicalPenetrationPercent ?? 0,
    magicalPenFlat: flat.MagicalPenetrationFlat ?? 0,
    magicalPenPercent: flat.MagicalPenetrationPercent ?? 0,
    cooldownStat,
    cdrPercent: effectiveCdrPercent(cooldownStat),
    critChance: flat.CritChance ?? 0,
    critDamageBonus: items.reduce((sum, item) => sum + itemCritDamageBonusPct(item), 0),
    lifestealGeneric: flat.LifeStealPercent ?? 0,
    lifestealMagical: flat.MagicalLifestealPercent ?? 0,
    lifestealPhysicalInhand: flat.PhysicalInhandLifestealPercent ?? 0,
    lifestealPhysicalAbility: flat.PhysicalAbilityLifestealPercent ?? 0,
    basicAttackDamageType,
    basicAttacksCanCrit: basicAttackMeta?.canCrit ?? true,
    primaryStat,
  }
}

export function snapshotDefender(scenario: Scenario): DefenderSnapshot {
  const enemy = scenario.defender
  const god = getGod(enemy.godId)
  const items = enemy.items?.map((name) => getItem(name, { godId: enemy.godId })) ?? []
  const { flat } = sumItemStats(items, {}, inferPrimaryStat(god), false, enemy.level)
  const baseHealth = statAt(god, 'MaxHealth', enemy.level)
  const basePhysProt = statAt(god, 'PhysicalProtection', enemy.level)
  const baseMagProt = statAt(god, 'MagicalProtection', enemy.level)
  const itemHealthBonus = flat.MaxHealth ?? 0
  return {
    god,
    level: enemy.level,
    baseHealth,
    itemHealthBonus,
    maxHealth: baseHealth + itemHealthBonus + (enemy.flatHealthBonus ?? 0),
    physicalProtection: basePhysProt + (flat.PhysicalProtection ?? 0),
    magicalProtection: baseMagProt + (flat.MagicalProtection ?? 0),
  }
}

// --- Damage application ---

interface DamageCtx {
  attacker: AttackerSnapshot
  defender: DefenderSnapshot
  state: CombatState
  options: NonNullable<Scenario['options']>
}

function queuePostAbilityItemRiders(ctx: DamageCtx) {
  for (const item of ctx.attacker.items) {
    for (const proc of getItemProcs(item)) {
      if (proc.kind === 'onAbilityCast_nextBasicBonus') {
        ctx.state.riders.nextBasicBonusTrue += proc.bonusTrue
      } else if (proc.kind === 'onAbilityHit_nextBasicMult') {
        const isMelee = ctx.attacker.baseAttackSpeed >= 0.96
        ctx.state.riders.nextBasicMultiplier = isMelee ? proc.meleeMultiplier : proc.rangedMultiplier
      } else if (proc.kind === 'onAbilityCast_nextBasicScalingDamage') {
        const cooldownKey = proc.id
        const readyAt = ctx.state.cooldowns.actives[cooldownKey] ?? 0
        if (readyAt > ctx.state.t) continue
        ctx.state.riders.nextBasicBonusDamages.push({
          label: item.displayName ?? proc.id,
          damageType: proc.damageType,
          baseDamage: proc.baseDamage,
          strScaling: proc.strScaling,
          intScaling: proc.intScaling,
          expiresAt: ctx.state.t + proc.durationSeconds,
          source: 'item',
        })
        ctx.state.cooldowns.actives[cooldownKey] = ctx.state.t + proc.cooldown
      } else if (proc.kind === 'onAbilityCast_selfBuff') {
        if (!consumeItemProcCooldown(ctx, proc.id, proc.cooldown)) continue
        applyOrRefreshBuff(ctx.state, {
          key: proc.id,
          label: itemLabel(item, proc.id),
          expiresAt: ctx.state.t + proc.durationSeconds,
          modifiers: proc.modifiers,
          stacksMax: proc.stacksMax,
          addStacks: proc.addStacks,
        })
      }
    }
  }
}

function currentProt(ctx: DamageCtx, damageType: DamageType): number {
  if (damageType === 'true') return 0
  const base = damageType === 'physical'
    ? ctx.defender.physicalProtection
    : ctx.defender.magicalProtection
  const shred = damageType === 'physical'
    ? enemyDebuffStatDelta(ctx.state, 'PhysicalProtection')
    : enemyDebuffStatDelta(ctx.state, 'MagicalProtection')
  return Math.max(0, base + shred)
}

function emitDamage(
  ctx: DamageCtx, damageType: DamageType, preMitigation: number, label: string,
  source: DamageEvent['source'], notes?: string[], suppressDamageEcho = false,
) {
  const adjustedPre = applyOutgoingDamageModifiers(ctx, source, preMitigation)
  const penFlat = currentPenFlat(ctx, damageType)
  const basePenPercent = damageType === 'physical'
    ? currentPenPercent(ctx, 'physical')
    : currentPenPercent(ctx, 'magical')
  const penPercent = ctx.options.penPercentOverride ?? basePenPercent
  const prot = currentProt(ctx, damageType)
  const post = applyDefense(adjustedPre, {
    targetProtection: prot,
    penFlat,
    penPercent,
  })
  const ev: DamageEvent = {
    kind: 'damage',
    t: ctx.state.t,
    label,
    source,
    damageType,
    preMitigation: adjustedPre,
    postMitigation: post,
    notes,
  }
  // Basic-attack crit is an inhand property, not a physical-only property.
  // The extracted inhand GameplayEffects expose CanCrit on magical and physical
  // gods alike, so only the source check matters here.
  const critChance = currentCritChance(ctx)
  if (source === 'basic' && ctx.attacker.basicAttacksCanCrit && critChance > 0) {
    const critMode = ctx.options.critMode ?? 'expected'
    const critBonus = 0.75 + currentCritDamageBonus(ctx) / 100
    if (critMode === 'alwaysCrit') {
      ev.postMitigation *= 1 + critBonus
      ev.crit = true
    } else if (critMode === 'expected') {
      ev.postMitigation *= 1 + (critChance / 100) * critBonus
    }
  }
  ctx.state.events.push(ev)
  if (ctx.state.defenderCurrentHP > 0) {
    ctx.state.defenderCurrentHP -= ev.postMitigation
    if (ctx.state.defenderCurrentHP < 0) {
      ctx.state.overkill += -ctx.state.defenderCurrentHP
      ctx.state.defenderCurrentHP = 0
    }
  } else {
    ctx.state.overkill += ev.postMitigation
  }
  if (!suppressDamageEcho) {
    emitDamageEcho(ctx, source, adjustedPre)
  }
  maybeTriggerTheMorriganDarkOmen(ctx, source, label, notes)
}

function maybeTriggerTheMorriganDarkOmen(
  ctx: DamageCtx,
  source: DamageEvent['source'],
  label: string,
  notes?: string[],
) {
  if (ctx.attacker.god.god !== 'The_Morrigan') return
  const expiresAt = ctx.state.cooldowns.actives[MORRIGAN_DARK_OMEN_EXPIRES_KEY] ?? 0
  if (expiresAt <= ctx.state.t) return
  if (label === 'Dark Omen (trigger)') return

  const noteText = (notes ?? []).join(' ').toLowerCase()
  const fromGodAbility =
    source === 'dot'
    || (source === 'ability' && noteText.length === 0)
  if (!fromGodAbility) return

  const base = ctx.state.cooldowns.actives[MORRIGAN_DARK_OMEN_BASE_KEY] ?? 0
  const intScale = ctx.state.cooldowns.actives[MORRIGAN_DARK_OMEN_SCALE_KEY] ?? 0
  delete ctx.state.cooldowns.actives[MORRIGAN_DARK_OMEN_EXPIRES_KEY]
  delete ctx.state.cooldowns.actives[MORRIGAN_DARK_OMEN_BASE_KEY]
  delete ctx.state.cooldowns.actives[MORRIGAN_DARK_OMEN_SCALE_KEY]

  const pre = base + currentAdaptiveIntelligence(ctx) * intScale
  if (pre <= 0) return
  emitDamage(ctx, 'magical', pre, 'Dark Omen (trigger)', 'ability', ['The Morrigan Dark Omen mark'])
}

function applyOutgoingDamageModifiers(
  ctx: DamageCtx,
  source: DamageEvent['source'],
  preMitigation: number,
): number {
  const pct =
    source === 'basic'
      ? buffStatDelta(ctx.state, 'AttackDamagePercent') + buffStatDelta(ctx.state, 'BasicAttackDamagePercent')
      : (source === 'ability' || source === 'dot')
        ? buffStatDelta(ctx.state, 'AbilityDamagePercent')
        : 0
  const sourceVulnerability = enemyDebuffStatDelta(ctx.state, 'DamageTakenFromSourcePercent')
  return preMitigation * (1 + (pct + sourceVulnerability) / 100)
}

function emitDamageEcho(
  ctx: DamageCtx,
  source: DamageEvent['source'],
  triggeringPreMitigation: number,
) {
  if (source !== 'basic' && source !== 'ability' && source !== 'dot') return
  const pct = enemyDebuffStatDelta(ctx.state, 'BonusPhysicalDamageFromAttacksAndAbilitiesPercent')
  if (pct <= 0) return
  emitDamage(
    ctx,
    'physical',
    triggeringPreMitigation * pct / 100,
    'Jagged Wounds',
    'item',
    [`${pct.toFixed(2)}% of triggering ${source} pre-mitigation damage`],
    true,
  )
}

function consumeItemProcCooldown(ctx: DamageCtx, procId: string, cooldown: number): boolean {
  const readyAt = ctx.state.cooldowns.actives[procId] ?? 0
  if (readyAt > ctx.state.t) return false
  if (cooldown > 0) ctx.state.cooldowns.actives[procId] = ctx.state.t + cooldown
  return true
}

function itemLabel(item: ItemCatalogEntry, fallback: string): string {
  return item.displayName ?? item.internalKey ?? fallback
}

function targetHealthDamagePre(
  ctx: DamageCtx,
  baseHealthPct: number,
  itemHealthPct: number,
  strengthAsTargetMaxPct = 0,
): number {
  const basePortion = ctx.defender.baseHealth * baseHealthPct
  const itemPortion = ctx.defender.itemHealthBonus * itemHealthPct
  const strengthPortion = ctx.defender.maxHealth * (currentAdaptiveStrength(ctx) * strengthAsTargetMaxPct / 100)
  return basePortion + itemPortion + strengthPortion
}

function defenderHpAtCurrentTime(ctx: DamageCtx): number {
  const damageDone = ctx.state.events
    .filter((ev): ev is DamageEvent => ev.kind === 'damage' && ev.t <= ctx.state.t)
    .reduce((sum, ev) => sum + ev.postMitigation, 0)
  return Math.max(0, ctx.defender.maxHealth - damageDone)
}

function normalizeEnemyDebuffModifiers(
  ctx: DamageCtx,
  modifiers: Partial<Record<string, number>>,
): Partial<Record<string, number>> {
  const out: Partial<Record<string, number>> = {}
  for (const [key, value] of Object.entries(modifiers)) {
    const numericValue = value ?? 0
    if (key === 'PhysicalProtectionPercent') {
      out.PhysicalProtection = (out.PhysicalProtection ?? 0) + ctx.defender.physicalProtection * numericValue / 100
    } else if (key === 'MagicalProtectionPercent') {
      out.MagicalProtection = (out.MagicalProtection ?? 0) + ctx.defender.magicalProtection * numericValue / 100
    } else {
      out[key] = (out[key] ?? 0) + numericValue
    }
  }
  return out
}

function scaledSelfBuffModifiers(
  ctx: DamageCtx,
  modifiers: Partial<Record<string, number>>,
  modifiersPerLevel: Partial<Record<string, number>> = {},
): Partial<Record<string, number>> {
  const out: Partial<Record<string, number>> = { ...modifiers }
  for (const [key, value] of Object.entries(modifiersPerLevel)) {
    out[key] = (out[key] ?? 0) + (value ?? 0) * ctx.attacker.level
  }
  return out
}

function procPre(
  ctx: DamageCtx,
  baseDamage: number,
  perLevelDamage: number,
  strScaling: number,
  intScaling: number,
): number {
  const strTotal = currentAdaptiveStrength(ctx)
  const intTotal = currentAdaptiveIntelligence(ctx)
  return baseDamage + perLevelDamage * ctx.attacker.level + strTotal * strScaling + intTotal * intScaling
}

function currentAdaptiveStrength(ctx: DamageCtx): number {
  const flat =
    ctx.attacker.adaptiveStrength
    + buffStatDelta(ctx.state, 'adaptiveStrength')
    + buffStatDelta(ctx.state, 'PhysicalPower')
  return flat * (1 + buffStatDelta(ctx.state, 'adaptiveStrengthPercent') / 100)
}

function currentAdaptiveIntelligence(ctx: DamageCtx): number {
  const flat =
    ctx.attacker.adaptiveIntelligence
    + buffStatDelta(ctx.state, 'adaptiveIntelligence')
    + buffStatDelta(ctx.state, 'MagicalPower')
  return flat * (1 + buffStatDelta(ctx.state, 'adaptiveIntelligencePercent') / 100)
}

function currentCdrPercent(ctx: DamageCtx): number {
  return effectiveCdrPercent(
    ctx.attacker.cooldownStat + buffStatDelta(ctx.state, 'CooldownReductionPercent'),
  )
}

function currentCritChance(ctx: DamageCtx): number {
  return Math.max(0, ctx.attacker.critChance + buffStatDelta(ctx.state, 'CritChance'))
}

function currentCritDamageBonus(ctx: DamageCtx): number {
  return Math.max(0, ctx.attacker.critDamageBonus + buffStatDelta(ctx.state, 'CritDamageBonus'))
}

function currentPenFlat(ctx: DamageCtx, damageType: DamageType): number {
  if (damageType === 'physical') {
    return ctx.attacker.penFlat + buffStatDelta(ctx.state, 'PhysicalPenetrationFlat')
  }
  if (damageType === 'magical') {
    return ctx.attacker.magicalPenFlat + buffStatDelta(ctx.state, 'MagicalPenetrationFlat')
  }
  return 0
}

function currentPenPercent(ctx: DamageCtx, damageType: DamageType): number {
  if (damageType === 'physical') {
    return ctx.attacker.penPercent + buffStatDelta(ctx.state, 'PhysicalPenetrationPercent')
  }
  if (damageType === 'magical') {
    return ctx.attacker.magicalPenPercent + buffStatDelta(ctx.state, 'MagicalPenetrationPercent')
  }
  return 0
}

function currentLifestealPercent(ctx: DamageCtx): number {
  return Math.max(
    0,
    ctx.attacker.lifestealGeneric + buffStatDelta(ctx.state, 'LifeStealPercent'),
    ctx.attacker.lifestealMagical + buffStatDelta(ctx.state, 'MagicalLifestealPercent'),
    ctx.attacker.lifestealPhysicalInhand + buffStatDelta(ctx.state, 'PhysicalInhandLifestealPercent'),
    ctx.attacker.lifestealPhysicalAbility + buffStatDelta(ctx.state, 'PhysicalAbilityLifestealPercent'),
  )
}

function currentInhandAttackDamage(ctx: DamageCtx): number {
  return (
    ctx.attacker.inhandPower
    + buffStatDelta(ctx.state, 'InhandPower')
    + currentAdaptiveStrength(ctx)
    + currentAdaptiveIntelligence(ctx) * 0.2
  )
}

function currentAttackerProtectionTotal(ctx: DamageCtx): number {
  const physical = ctx.attacker.physicalProtection + buffStatDelta(ctx.state, 'PhysicalProtection')
  const magical = ctx.attacker.magicalProtection + buffStatDelta(ctx.state, 'MagicalProtection')
  return Math.max(0, physical) + Math.max(0, magical)
}

function currentAttackerItemProtectionTotal(ctx: DamageCtx): number {
  const basePhysical = statAt(ctx.attacker.god, 'PhysicalProtection', ctx.attacker.level)
  const baseMagical = statAt(ctx.attacker.god, 'MagicalProtection', ctx.attacker.level)
  const physical = ctx.attacker.physicalProtection - basePhysical
  const magical = ctx.attacker.magicalProtection - baseMagical
  return Math.max(0, physical) + Math.max(0, magical)
}

function equippedItemPartialStacks(ctx: DamageCtx, item: ItemCatalogEntry): number {
  return Math.max(0,
    ctx.attacker.partialStacks[item.internalKey ?? '']
    ?? ctx.attacker.partialStacks[item.displayName ?? '']
    ?? 0)
}

function consumeNextNonUltimateNoCooldown(ctx: DamageCtx, slot: AbilitySlot) {
  if (!ctx.state.riders.nextNonUltimateNoCooldown || slot === 'A04') return
  ctx.state.cooldowns.abilities[slot] = ctx.state.t
  ctx.state.riders.nextNonUltimateNoCooldown = false
  ctx.state.events.push({
    kind: 'buff-expire',
    t: ctx.state.t,
    label: 'Next non-ultimate no cooldown consumed',
    target: 'self',
  })
}

function periodicItemCooldownKey(procId: string): string {
  return `periodic:${procId}`
}

function nextPeriodicItemTickTime(ctx: DamageCtx): number | null {
  let next: number | null = null
  for (const item of ctx.attacker.items) {
    for (const proc of getItemProcs(item)) {
      if (proc.kind !== 'periodic_cdr') continue
      const key = periodicItemCooldownKey(proc.id)
      const scheduled = ctx.state.cooldowns.actives[key] ?? proc.intervalSeconds
      next = next == null ? scheduled : Math.min(next, scheduled)
    }
  }
  return next
}

function applyDuePeriodicItemTicks(ctx: DamageCtx) {
  for (const item of ctx.attacker.items) {
    for (const proc of getItemProcs(item)) {
      if (proc.kind !== 'periodic_cdr') continue
      const key = periodicItemCooldownKey(proc.id)
      let scheduled = ctx.state.cooldowns.actives[key] ?? proc.intervalSeconds
      while (scheduled <= ctx.state.t + 1e-9) {
        for (const slot of ['A01', 'A02', 'A03', 'A04'] as AbilitySlot[]) {
          const cd = ctx.state.cooldowns.abilities[slot]
          if (cd > ctx.state.t) {
            ctx.state.cooldowns.abilities[slot] = Math.max(ctx.state.t, cd - proc.secondsReduced)
          }
        }
        ctx.state.events.push({
          kind: 'active-use',
          t: ctx.state.t,
          itemKey: item.internalKey ?? proc.id,
          label: `${itemLabel(item, proc.id)} (-${proc.secondsReduced}s cooldowns)`,
        })
        scheduled += proc.intervalSeconds
      }
      ctx.state.cooldowns.actives[key] = scheduled
    }
  }
}

function advanceTime(ctx: DamageCtx, targetT: number) {
  if (targetT < ctx.state.t) {
    ctx.state.t = targetT
    expireTimedEffects(ctx.state)
    return
  }
  while (true) {
    const nextTick = nextPeriodicItemTickTime(ctx)
    if (nextTick == null || nextTick > targetT) break
    ctx.state.t = nextTick
    expireTimedEffects(ctx.state)
    applyDuePeriodicItemTicks(ctx)
  }
  ctx.state.t = targetT
  expireTimedEffects(ctx.state)
}

function advanceUntilAbilityReady(ctx: DamageCtx, slot: AbilitySlot) {
  while (ctx.state.cooldowns.abilities[slot] > ctx.state.t) {
    const readyAt = ctx.state.cooldowns.abilities[slot]
    const nextTick = nextPeriodicItemTickTime(ctx)
    if (nextTick != null && nextTick < readyAt) {
      advanceTime(ctx, nextTick)
    } else {
      advanceTime(ctx, readyAt)
    }
  }
}

function cancelCastDurationOverride(ctx: DamageCtx, slot: AbilitySlot): number | null {
  if (ctx.attacker.god.god === 'Susano' && slot === 'A01') return 0.15
  return null
}

// --- Ability execution ---

function executeAbility(ctx: DamageCtx, slot: AbilitySlot, label: string, opts?: { cancel?: boolean }) {
  const rank = ctx.attacker.abilityRanks[slot] ?? 1

  // Per-god custom handler takes precedence when registered (Loki A01, etc.)
  const godHandler = getGodHandler(ctx.attacker.god.god, slot)
  if (godHandler) {
    const handled = godHandler(
      {
        ...ctx,
        options: ctx.options,
        emitDamage,
        directPre,
        schedDot,
        applyAbilityHitItemProcs,
        applyRepeatableAbilityHitItemProcs,
        applyOnBasicHitSplashProcs,
        attacker: { ...ctx.attacker, aspects: ctx.attacker.aspects },
        currentAdaptiveStrength: () => currentAdaptiveStrength(ctx),
        currentAdaptiveIntelligence: () => currentAdaptiveIntelligence(ctx),
        currentCdrPercent: () => currentCdrPercent(ctx),
        cancel: opts?.cancel,
      } as unknown as HandlerContext,
      rank,
    )
    if (handled) {
      applyAspectAbilityMods(ctx, slot, rank)
      applyAcornAbilityMods(ctx, slot, rank)
      // Still queue next-basic riders (Bumba post-ability, Hydra multiplier)
      queuePostAbilityItemRiders(ctx)
      consumeNextNonUltimateNoCooldown(ctx, slot)
      return
    }
  }

  // Auto-attack cancel path: fire cooldown, emit the cast event, apply
  // on-ability-cast item riders (Hydra / Poly / Bumba next-basic bonuses),
  // but skip the ability's own damage components. Models a player cancelling
  // an ability windup purely to trigger item procs.
  if (opts?.cancel) {
    const plan = buildAbilityPlan(ctx.attacker.god, slot, rank, { aspectActive: ctx.attacker.aspects.length > 0 })
    const cdSec = plan?.cooldownSeconds ?? 0
    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot, label: `${label} (cancel)` })
    const cdr = currentCdrPercent(ctx) / 100
    ctx.state.cooldowns.abilities[slot] = ctx.state.t + cdSec * (1 - cdr)
    queuePostAbilityItemRiders(ctx)
    consumeNextNonUltimateNoCooldown(ctx, slot)
    return
  }

  const plan: AbilityPlan | null = buildAbilityPlan(
    ctx.attacker.god, slot, rank, { aspectActive: ctx.attacker.aspects.length > 0 },
  )
  if (!plan) return

  ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot, label })

  // Cooldown with CDR
  const cdr = currentCdrPercent(ctx) / 100
  ctx.state.cooldowns.abilities[slot] = ctx.state.t + plan.cooldownSeconds * (1 - cdr)

  // "Ability Hit" item procs apply AFTER the first contact, not before.
  // So the first hit of any damaging component uses the pre-proc prot, and
  // subsequent hits benefit from the debuff. We track whether we've applied
  // the procs yet in this ability instance.
  let abilityProcsApplied = false
  const applyProcsOnceOnHit = () => {
    if (abilityProcsApplied) return
    applyAbilityHitItemProcs(ctx)
    abilityProcsApplied = true
  }
  const applyAllAbilityHitProcs = () => {
    applyProcsOnceOnHit()
    applyRepeatableAbilityHitItemProcs(ctx)
  }
  const preDamageSelfBuffs = plan.components
    .filter((component): component is Extract<typeof component, { kind: 'self-buff' }> =>
      component.kind === 'self-buff' && component.applyBeforeDamage === true)
  for (const component of preDamageSelfBuffs) {
    applyOrRefreshBuff(ctx.state, {
      key: component.key,
      label: component.label,
      expiresAt: ctx.state.t + component.durationSeconds,
      modifiers: component.modifiers,
    })
  }
  const onHitEnemyDebuffs = plan.components
    .filter((component): component is Extract<typeof component, { kind: 'enemy-debuff' }> =>
      component.kind === 'enemy-debuff' && component.applyOnEachDamageHit === true)
  const applyOnHitEnemyDebuffs = () => {
    for (const component of onHitEnemyDebuffs) {
      applyOrRefreshDebuff(ctx.state, {
        key: component.key,
        label: component.label,
        expiresAt: ctx.state.t + component.durationSeconds,
        modifiers: normalizeEnemyDebuffModifiers(ctx, component.modifiers),
        stacksMax: component.stacksMax,
        addStacks: component.addStacks ?? 1,
      })
    }
  }

  for (const component of plan.components) {
    if (component.kind === 'direct') {
      const savedT = ctx.state.t
      const timing = getAbilityTiming(ctx.attacker.god.god, slot)
      const baseDelay = component.delaySeconds ?? timing.damageApplyOffset ?? 0
      const multiHitInterval =
        component.hits > 1 && timing.shape === 'channel'
          ? Math.max(0.05, timing.hitInterval)
          : 0
      if (baseDelay > 0) {
        ctx.state.t = savedT + baseDelay
        expireTimedEffects(ctx.state)
      }
      const pre = directPre(ctx, component)
      // Multi-hit direct abilities (Da Ji A02 3-hit combo, Ratatoskr A02 dash)
      // can be truncated via `options.tickOverrides` so the user can model
      // "only 2 of 3 hits connected" etc.
      const override = ctx.options.tickOverrides?.[`${ctx.attacker.god.god}.${label}`]
      const actualHits = override != null
        ? Math.max(0, Math.min(component.hits, Math.floor(override)))
        : component.hits
      for (let h = 0; h < actualHits; h++) {
        if (h > 0 && multiHitInterval > 0) {
          ctx.state.t = savedT + baseDelay + h * multiHitInterval
          expireTimedEffects(ctx.state)
        }
        const hitLabel = component.hits > 1 ? `${component.label} (hit ${h + 1}/${actualHits})` : component.label
        emitDamage(ctx, component.damageType, pre, hitLabel, 'ability')
        applyOnHitEnemyDebuffs()
        // Once-per-ability procs apply after first contact; repeatable
        // ability-hit items (Bluestone) apply on every actual hit.
        applyAllAbilityHitProcs()
      }
      ctx.state.t = savedT
    } else if (component.kind === 'dot') {
      schedDot(ctx, component, label, applyAllAbilityHitProcs)
    } else if (component.kind === 'bleed') {
      schedDot(ctx, component, label, applyAllAbilityHitProcs)
    } else if (component.kind === 'self-buff') {
      if (component.applyBeforeDamage) continue
      applyOrRefreshBuff(ctx.state, {
        key: component.key,
        label: component.label,
        expiresAt: ctx.state.t + component.durationSeconds,
        modifiers: component.modifiers,
      })
    } else if (component.kind === 'enemy-debuff') {
      if (component.applyOnEachDamageHit) continue
      applyOrRefreshDebuff(ctx.state, {
        key: component.key,
        label: component.label,
        expiresAt: ctx.state.t + component.durationSeconds,
        modifiers: normalizeEnemyDebuffModifiers(ctx, component.modifiers),
        stacksMax: component.stacksMax,
        addStacks: component.addStacks ?? 1,
      })
    } else if (component.kind === 'next-basic-bonus') {
      ctx.state.riders.nextBasicBonusDamages.push({
        label: component.label,
        damageType: component.damageType,
        baseDamage: component.baseDamage,
        strScaling: component.strScaling,
        intScaling: component.intScaling,
        expiresAt: ctx.state.t + component.durationSeconds,
        source: 'ability',
      })
      ctx.state.events.push({
        kind: 'buff-apply',
        t: ctx.state.t,
        label: component.label,
        target: 'self',
        durationSeconds: component.durationSeconds,
        expiresAt: ctx.state.t + component.durationSeconds,
      })
    } else if (component.kind === 'cc') {
      // logged as a buff-apply on enemy for visibility
      ctx.state.events.push({
        kind: 'buff-apply', t: ctx.state.t, label: component.label,
        target: 'enemy', durationSeconds: component.durationSeconds,
        expiresAt: ctx.state.t + component.durationSeconds,
      })
      applyHardCcItemProcs(ctx)
    } else if (component.kind === 'heal') {
      // heals aren't damage; skip for now (logged in damage series as 0 would be misleading).
    }
  }

  applyAspectAbilityMods(ctx, slot, rank)
  applyAcornAbilityMods(ctx, slot, rank)

  // Ability-use item riders queued on next basic.
  queuePostAbilityItemRiders(ctx)

  if (ctx.attacker.god.god === 'Kali' && slot === 'A03' && ctx.state.riders.ruptureStacks > 0) {
    const consumed = ctx.state.riders.ruptureStacks
    const pre = kaliRupturePre(ctx, slot, rank, consumed)
    if (pre > 0) {
      emitDamage(ctx, 'physical', pre, `Rupture (${consumed} stacks)`, 'passive',
        ['local rank rows: Passive Bonus Damage Base/Str/Int'])
      ctx.state.riders.ruptureStacks = 0
    }
  }

  // Kali rupture: each ability cast consumes all stacks for bonus damage
  if (ctx.attacker.god.god === 'Kali' && slot !== 'A03' && ctx.state.riders.ruptureStacks > 0) {
    const consumed = ctx.state.riders.ruptureStacks
    const perStack = 10 + 2 * ctx.attacker.level    // approximation; passive curve is tag-bound, not row-bound
    const pre = perStack * consumed
    emitDamage(ctx, 'physical', pre, `Rupture (${consumed} stacks)`, 'passive',
      [`${perStack}/stack × ${consumed} stacks — passive curve approximated`])
    ctx.state.riders.ruptureStacks = 0
  }

  consumeNextNonUltimateNoCooldown(ctx, slot)
}

function directPre(ctx: DamageCtx, plan: Pick<DamagePlan, 'baseDamage' | 'strScaling' | 'intScaling'>): number {
  const strTotal = currentAdaptiveStrength(ctx)
  const intTotal = currentAdaptiveIntelligence(ctx)
  return plan.baseDamage + strTotal * plan.strScaling + intTotal * plan.intScaling
}

function aspectRowValue(ctx: DamageCtx, slot: AbilitySlot, rowName: string, rank: number): number {
  const rows = getAspectAbilityRows(ctx.attacker.god.god, slot)
  const curve = rows[rowName]
  return curve ? interp(curve, rank) : 0
}

function acornModifierMapAt(
  modifiers: Record<string, number>,
  modifiersR1: Record<string, number> | undefined,
  rank: number,
): Record<string, number> {
  if (!modifiersR1) return modifiers
  const out: Record<string, number> = {}
  const keys = new Set([...Object.keys(modifiers), ...Object.keys(modifiersR1)])
  for (const key of keys) {
    out[key] = interpRank(modifiersR1[key] ?? modifiers[key] ?? 0, modifiers[key] ?? modifiersR1[key] ?? 0, rank)
  }
  return out
}

function equippedAcornMods(ctx: DamageCtx, slot: AbilitySlot): AcornAbilityMod[] {
  const mods: AcornAbilityMod[] = []
  const aspectActive = ctx.attacker.aspects.length > 0
  for (const item of ctx.attacker.items) {
    const acorn = findGodLockedItem(item.internalKey ?? item.displayName ?? '')
    if (!acorn || acorn.abilitySlot !== slot) continue
    mods.push(...(aspectActive ? acorn.aspectAbilityMods : acorn.abilityMods))
  }
  return mods
}

function applyAcornAbilityMods(ctx: DamageCtx, slot: AbilitySlot, rank: number) {
  const mods = equippedAcornMods(ctx, slot)
  if (mods.length === 0) return
  for (const mod of mods) {
    if (mod.kind === 'addDamage' || mod.kind === 'addAreaDamage') {
      const savedT = ctx.state.t
      if (mod.delaySeconds) ctx.state.t = savedT + mod.delaySeconds
      const pre =
        interpRank(mod.baseDamageR1, mod.baseDamageR5, rank)
        + currentAdaptiveStrength(ctx) * mod.strScaling
        + currentAdaptiveIntelligence(ctx) * mod.intScaling
        + ctx.defender.maxHealth * ('targetMaxHpScaling' in mod ? (mod.targetMaxHpScaling ?? 0) : 0)
      emitDamage(ctx, mod.damageType, pre, mod.label, 'ability', ['god-locked aspect modifier'])
      ctx.state.t = savedT
    } else if (mod.kind === 'addSelfBuff') {
      applyOrRefreshBuff(ctx.state, {
        key: `acorn:${slot}:${mod.label}`,
        label: mod.label,
        expiresAt: ctx.state.t + mod.durationSeconds,
        modifiers: acornModifierMapAt(mod.modifiers, mod.modifiersR1, rank),
        stacksMax: mod.maxStacks,
        addStacks: 1,
      })
    } else if (mod.kind === 'addDebuff') {
      applyOrRefreshDebuff(ctx.state, {
        key: `acorn:${slot}:${mod.label}`,
        label: mod.label,
        expiresAt: ctx.state.t + mod.durationSeconds,
        modifiers: acornModifierMapAt(mod.modifiers, mod.modifiersR1, rank),
        stacksMax: mod.maxStacks,
        addStacks: 1,
      })
    } else if (mod.kind === 'cdrOnHit') {
      const reducedBy = mod.secondsReduced * (mod.maxResetsPerCast ?? 1)
      ctx.state.cooldowns.abilities[slot] = Math.max(ctx.state.t, ctx.state.cooldowns.abilities[slot] - reducedBy)
    }
  }
}

function applyAspectAbilityMods(ctx: DamageCtx, slot: AbilitySlot, rank: number) {
  if (ctx.attacker.aspects.length === 0) return
  const godId = ctx.attacker.god.god

  if (godId === 'Poseidon' && slot === 'A02') {
    const baseDamage = aspectRowValue(ctx, slot, 'Aspect Projectile Base Damage', rank)
    const duration = aspectRowValue(ctx, slot, 'Aspect Projectile Duration', rank)
      || (abilityRowAt(ctx.attacker.god, slot, 'Buff Duration', rank) ?? 0)
    const inhandScaling = aspectRowValue(ctx, slot, 'Aspect Projectile Inhand Scaling', rank)
    if (baseDamage > 0 && duration > 0) {
      ctx.state.riders.activeBasicProjectiles.push({
        key: 'Poseidon.aspect.A02',
        label: 'Trident aspect side shot',
        damageType: 'magical',
        baseDamage,
        inhandScaling,
        hits: 2,
        expiresAt: ctx.state.t + duration,
        source: 'ability',
      })
    }
  }

  if (godId === 'Ra' && slot === 'A02') {
    const baseDamage = aspectRowValue(ctx, slot, 'Aspect Projectile Base Damage', rank)
    const intScaling = aspectRowValue(ctx, slot, 'Aspect Projectile Int Scaling', rank)
    const duration = abilityRowAt(ctx.attacker.god, slot, 'Enhanced Attack Duration', rank) ?? 0
    if (baseDamage > 0 && duration > 0) {
      ctx.state.riders.activeBasicProjectiles.push({
        key: 'Ra.aspect.A02',
        label: 'Divine Light aspect ray',
        damageType: 'magical',
        baseDamage,
        inhandScaling: 0,
        intScaling,
        hits: 1,
        expiresAt: ctx.state.t + duration,
        source: 'ability',
      })
    }
  }

  if (godId === 'Thanatos' && slot === 'A03') {
    const maxHpScaling = aspectRowValue(ctx, slot, 'Aspect Target Max HP Scaling', rank)
    if (maxHpScaling > 0) {
      emitDamage(
        ctx,
        'physical',
        ctx.defender.maxHealth * maxHpScaling,
        'Soul Reap (aspect max HP)',
        'ability',
        [`${(maxHpScaling * 100).toFixed(1)}% target max HP`],
      )
    }
  }
}

function kaliRupturePre(ctx: DamageCtx, slot: AbilitySlot, rank: number, stacks: number): number {
  const base = abilityRowAt(ctx.attacker.god, slot, 'Passive Bonus Damage Base Damage', rank)
  if (base == null) return 0
  const strScaling = abilityRowAt(ctx.attacker.god, slot, 'Passive Bonus Damage Str Scaling', rank) ?? 0
  const intScaling = abilityRowAt(ctx.attacker.god, slot, 'Passive Bonus Damage Int Scaling', rank) ?? 0
  return (base + currentAdaptiveStrength(ctx) * strScaling + currentAdaptiveIntelligence(ctx) * intScaling) * stacks
}

function currentTotalAttackSpeed(ctx: DamageCtx): number {
  const attackSpeedPercent = ctx.attacker.attackSpeedPercent + buffStatDelta(ctx.state, 'AttackSpeedPercent')
  return ctx.attacker.baseAttackSpeed * (1 + attackSpeedPercent / 100)
}

function schedDot(
  ctx: DamageCtx,
  plan: DamagePlan,
  label: string,
  onFirstHit?: () => void,
  source: DamageEvent['source'] = 'dot',
) {
  if (plan.ticks == null || plan.tickRate == null) return
  const tickOverride = ctx.options.tickOverrides?.[`${ctx.attacker.god.god}.${label}`]
  const actualTicks = tickOverride ?? plan.ticks
  const savedT = ctx.state.t
  const firstTickDelay = plan.delaySeconds ?? plan.tickRate
  for (let i = 1; i <= actualTicks; i++) {
    ctx.state.t = savedT + firstTickDelay + (i - 1) * plan.tickRate
    expireTimedEffects(ctx.state)
    // Recompute pre each tick in case buffs/debuffs mid-DoT changed the values
    const pre = directPre(ctx, plan)
    emitDamage(ctx, plan.damageType, pre, `${plan.label} (tick ${i}/${actualTicks})`, source,
      i === 1 ? [`${actualTicks} ticks × ${plan.tickRate}s interval`] : undefined)
    // Apply ability-hit procs after the first tick lands (so tick 1 uses pre-proc prot)
    if (i === 1 && onFirstHit) onFirstHit()
  }
  ctx.state.t = savedT  // return to cast-time clock; the caller advances time explicitly
}

// --- Basic attack ---

/** "On Attack Hit: X% bonus <Type> Damage to Enemies within Ym" splash
 *  (Bumba's Spear 25%, Bumba's Golden Dagger 10%, etc.). Called from both
 *  `executeBasic` and from god-handler basics (Loki's Vanish triggering
 *  basic) so the splash fires on every basic in the sim, not just the
 *  default-executed ones. Single-target sim: applies to the primary target. */
function applyOnBasicHitSplashProcs(ctx: DamageCtx, basicPre: number): void {
  for (const item of ctx.attacker.items) {
    for (const proc of getItemProcs(item)) {
      if (proc.kind === 'onBasicHit_bonusPctOfBasicDamage') {
        const bonusPre = basicPre * (proc.percent / 100)
        emitDamage(ctx, proc.damageType, bonusPre, itemLabel(item, proc.id), 'item',
          [`${proc.percent}% of basic pre-mit damage`])
      }
    }
  }
}

function executeBasic(ctx: DamageCtx, label: string) {
  const chain = BASIC_CHAIN_DEFAULTS[ctx.attacker.god.god] ?? BASIC_CHAIN_DEFAULTS.__default
  const step = ctx.state.riders.basicChainIndex % chain.length
  const multiplier = chain[step]
  ctx.state.riders.basicChainIndex += 1

  const effectivePower = currentInhandAttackDamage(ctx)
  let pre = effectivePower * multiplier
  const hydraMult = ctx.state.riders.nextBasicMultiplier
  if (hydraMult) {
    pre *= hydraMult
    ctx.state.riders.nextBasicMultiplier = null
  }

  emitDamage(ctx, ctx.attacker.basicAttackDamageType, pre, label, 'basic',
    hydraMult ? [`×${hydraMult} next-basic multiplier`] : undefined)
  applyOnBasicHitSplashProcs(ctx, pre)

  const nutConvergence = ctx.attacker.god.god === 'Nut'
    ? ctx.state.attackerBuffs.get(NUT_CONVERGENCE_ACTIVE_KEY)
    : undefined
  if (nutConvergence && nutConvergence.expiresAt > ctx.state.t && nutConvergence.stacks > 0) {
    const projectileCount = Math.max(0, Math.floor(ctx.state.cooldowns.actives[NUT_CONVERGENCE_SIDE_COUNT_KEY] ?? 2))
    const sideBase = ctx.state.cooldowns.actives[NUT_CONVERGENCE_SIDE_BASE_KEY] ?? 0
    const sideStrScaling = ctx.state.cooldowns.actives[NUT_CONVERGENCE_SIDE_STR_KEY] ?? 0
    const sideIntScaling = ctx.state.cooldowns.actives[NUT_CONVERGENCE_SIDE_INT_KEY] ?? 0
    let abilityHitProcsApplied = false
    for (let i = 1; i <= projectileCount; i++) {
      const sidePre =
        sideBase
        + currentAdaptiveStrength(ctx) * sideStrScaling
        + currentAdaptiveIntelligence(ctx) * sideIntScaling
      emitDamage(
        ctx,
        'magical',
        sidePre,
        `Convergence side shot (${i}/${projectileCount})`,
        'ability',
        ['asset-backed Nut A01 side projectile'],
      )
      if (!abilityHitProcsApplied) {
        applyAbilityHitItemProcs(ctx)
        abilityHitProcsApplied = true
      }
      applyRepeatableAbilityHitItemProcs(ctx)
    }

    const protDebuffPct = ctx.state.cooldowns.actives[NUT_CONVERGENCE_PROT_PCT_KEY] ?? 0
    if (protDebuffPct > 0) {
      applyOrRefreshDebuff(ctx.state, {
        key: NUT_CONVERGENCE_PROT_DEBUFF_KEY,
        label: 'Convergence protection shred',
        expiresAt: ctx.state.t + NUT_CONVERGENCE_PROT_DEBUFF_DURATION,
        modifiers: {
          PhysicalProtection: -ctx.defender.physicalProtection * protDebuffPct,
          MagicalProtection: -ctx.defender.magicalProtection * protDebuffPct,
        },
      })
    }

    nutConvergence.stacks -= 1
    if (nutConvergence.stacks <= 0) {
      ctx.state.attackerBuffs.delete(NUT_CONVERGENCE_ACTIVE_KEY)
      delete ctx.state.cooldowns.actives[NUT_CONVERGENCE_SIDE_BASE_KEY]
      delete ctx.state.cooldowns.actives[NUT_CONVERGENCE_SIDE_STR_KEY]
      delete ctx.state.cooldowns.actives[NUT_CONVERGENCE_SIDE_INT_KEY]
      delete ctx.state.cooldowns.actives[NUT_CONVERGENCE_SIDE_COUNT_KEY]
      delete ctx.state.cooldowns.actives[NUT_CONVERGENCE_PROT_PCT_KEY]
      ctx.state.events.push({ kind: 'buff-expire', t: ctx.state.t, label: nutConvergence.label, target: 'self' })
    }
  }

  ctx.state.riders.activeBasicProjectiles = ctx.state.riders.activeBasicProjectiles
    .filter((rider) => rider.expiresAt > ctx.state.t && (rider.remainingBasics == null || rider.remainingBasics > 0))
  for (const rider of ctx.state.riders.activeBasicProjectiles) {
    const projectilePre =
      rider.baseDamage
      + currentInhandAttackDamage(ctx) * rider.inhandScaling
      + currentAdaptiveStrength(ctx) * (rider.strScaling ?? 0)
      + currentAdaptiveIntelligence(ctx) * (rider.intScaling ?? 0)
    for (let i = 1; i <= rider.hits; i++) {
      emitDamage(ctx, rider.damageType, projectilePre, `${rider.label} (projectile ${i}/${rider.hits})`, rider.source ?? 'item',
        rider.notes ?? [(rider.source ?? 'item') === 'ability' ? 'ability-follow-up basic projectile' : 'active item extra basic projectile'])
    }
    if (rider.remainingBasics != null) rider.remainingBasics -= 1
  }
  ctx.state.riders.activeBasicProjectiles = ctx.state.riders.activeBasicProjectiles
    .filter((rider) => rider.expiresAt > ctx.state.t && (rider.remainingBasics == null || rider.remainingBasics > 0))

  const pendingBonusDamages = ctx.state.riders.nextBasicBonusDamages
    .filter((rider) => rider.expiresAt >= ctx.state.t)
  for (const rider of pendingBonusDamages) {
    const savedT = ctx.state.t
    if (rider.delaySeconds) ctx.state.t = savedT + rider.delaySeconds
    emitDamage(ctx, rider.damageType, directPre(ctx, rider), rider.label, rider.source ?? 'item',
      rider.notes ?? [(rider.source ?? 'item') === 'ability' ? 'next-basic ability bonus damage' : 'next-basic item bonus damage'])
    ctx.state.t = savedT
  }
  ctx.state.riders.nextBasicBonusDamages = []

  // Kali rupture: basics apply stacks (cap 3)
  if (ctx.attacker.god.god === 'Kali') {
    ctx.state.riders.ruptureStacks = Math.min(3, ctx.state.riders.ruptureStacks + 1)
  }

  // Bumba per-basic true damage
  for (const item of ctx.attacker.items) {
    for (const proc of getItemProcs(item)) {
      if (proc.kind === 'onBasicHit_trueDamage') {
        if (ctx.state.riders.bumbaBasicsUsed < proc.maxTriggers) {
          emitDamage(ctx, 'true', proc.perHit, 'Bumba true (per-basic)', 'item')
          ctx.state.riders.bumbaBasicsUsed += 1
        }
      } else if (proc.kind === 'onBasicHit_bonusDamage') {
        if (!consumeItemProcCooldown(ctx, proc.id, proc.cooldown)) continue
        emitDamage(
          ctx,
          proc.damageType,
          procPre(ctx, proc.baseDamage, proc.perLevelDamage, proc.strScaling, proc.intScaling),
          itemLabel(item, proc.id),
          'item',
          ['basic-hit item proc'],
        )
      } else if (proc.kind === 'onHit_bonusDamage' && proc.trigger !== 'ability') {
        if (!consumeItemProcCooldown(ctx, proc.id, proc.cooldown)) continue
        emitDamage(
          ctx,
          proc.damageType,
          procPre(ctx, proc.baseDamage, proc.perLevelDamage, proc.strScaling, proc.intScaling),
          itemLabel(item, proc.id),
          'item',
          ['on-hit item proc'],
        )
      } else if (proc.kind === 'onBasicHit_protectionScalingDamage') {
        if (!consumeItemProcCooldown(ctx, proc.id, proc.cooldown)) continue
        emitDamage(
          ctx,
          proc.damageType,
          proc.baseDamage + currentAttackerItemProtectionTotal(ctx) * proc.itemProtectionScaling,
          itemLabel(item, proc.id),
          'item',
          ['basic-hit item-protection scaling proc'],
        )
      } else if (proc.kind === 'onBasicHit_targetHealthDamage') {
        if (!consumeItemProcCooldown(ctx, proc.id, proc.cooldown)) continue
        emitDamage(
          ctx,
          proc.damageType,
          targetHealthDamagePre(ctx, proc.baseHealthPct, proc.itemHealthPct),
          itemLabel(item, proc.id),
          'item',
          ['basic-hit target-health item proc'],
        )
      } else if (proc.kind === 'onBasicHit_prechargedHealthScalingDamage') {
        const availableCharges = Math.floor(equippedItemPartialStacks(ctx, item))
        const usedCharges = ctx.state.riders.itemProcCounters[proc.id] ?? 0
        if (usedCharges >= availableCharges) continue
        ctx.state.riders.itemProcCounters[proc.id] = usedCharges + 1
        emitDamage(
          ctx,
          proc.damageType,
          proc.baseDamage + ctx.attacker.maxHealth * proc.maxHealthPct,
          itemLabel(item, proc.id),
          'item',
          ['precharged item stack consumed from partialStacks'],
        )
      } else if (proc.kind === 'onBasicOrHardCc_prechargedTargetHealthDamage') {
        const stacks = Math.floor(equippedItemPartialStacks(ctx, item))
        const used = ctx.state.riders.itemProcCounters[proc.id] ?? 0
        if (stacks <= 0 || used > 0) continue
        ctx.state.riders.itemProcCounters[proc.id] = stacks
        emitDamage(
          ctx,
          proc.damageType,
          ctx.defender.maxHealth * proc.targetMaxHealthPctPerStack * stacks,
          itemLabel(item, proc.id),
          'item',
          [`${stacks} precharged stack(s) consumed from partialStacks`],
        )
      } else if (proc.kind === 'onEveryNthBasic_inhandScalingDamage') {
        const count = (ctx.state.riders.itemProcCounters[proc.id] ?? 0) + 1
        ctx.state.riders.itemProcCounters[proc.id] = count
        if (count % proc.every !== 0) continue
        emitDamage(
          ctx,
          proc.damageType,
          proc.baseDamage + currentInhandAttackDamage(ctx) * proc.inhandScaling,
          itemLabel(item, proc.id),
          'item',
          [`every ${proc.every} basic-hit item proc`],
        )
      } else if (proc.kind === 'targetProtShredPct' && proc.trigger !== 'ability') {
        applyOrRefreshDebuff(ctx.state, {
          key: proc.id,
          label: `${itemLabel(item, proc.id)} (-${Math.round(proc.protPct * 100)}% prot)`,
          expiresAt: ctx.state.t + proc.durationSeconds,
          modifiers: {
            PhysicalProtection: -ctx.defender.physicalProtection * proc.protPct,
            MagicalProtection: -ctx.defender.magicalProtection * proc.protPct,
          },
          stacksMax: proc.maxStacks,
          addStacks: 1,
        })
      } else if (proc.kind === 'onDamage_selfBuff' && proc.trigger !== 'ability') {
        if (!consumeItemProcCooldown(ctx, proc.id, proc.cooldown)) continue
        applyOrRefreshBuff(ctx.state, {
          key: proc.id,
          label: itemLabel(item, proc.id),
          expiresAt: ctx.state.t + proc.durationSeconds,
          modifiers: scaledSelfBuffModifiers(ctx, proc.modifiers, proc.modifiersPerLevel),
          stacksMax: proc.stacksMax,
          addStacks: 1,
        })
      } else if (proc.kind === 'onCrit_selfBuff') {
        const critChance = currentCritChance(ctx)
        const critMode = ctx.options.critMode ?? 'expected'
        const addStacks =
          critMode === 'alwaysCrit' ? 1
          : critMode === 'neverCrit' ? 0
          : critChance / 100
        if (addStacks <= 0) continue
        applyOrRefreshBuff(ctx.state, {
          key: proc.id,
          label: itemLabel(item, proc.id),
          expiresAt: ctx.state.t + proc.durationSeconds,
          modifiers: proc.modifiers,
          stacksMax: proc.stacksMax,
          addStacks,
        })
      } else if (proc.kind === 'onHit_enemyDebuff' && proc.trigger !== 'ability') {
        if (!consumeItemProcCooldown(ctx, proc.id, proc.cooldown)) continue
        applyOrRefreshDebuff(ctx.state, {
          key: proc.id,
          label: itemLabel(item, proc.id),
          expiresAt: ctx.state.t + proc.durationSeconds,
          modifiers: normalizeEnemyDebuffModifiers(ctx, proc.modifiers),
          stacksMax: proc.stacksMax,
          addStacks: 1,
        })
      }
    }
  }
  if (ctx.attacker.god.god === 'Anhur' && ctx.attacker.aspects.length > 0) {
    const attackSpeedPerStack = aspectRowValue(ctx, 'A02', 'Attack Speed Buff', 1)
    const duration = aspectRowValue(ctx, 'A02', 'Buff Duration', 1)
    if (attackSpeedPerStack > 0 && duration > 0) {
      applyOrRefreshBuff(ctx.state, {
        key: 'Anhur.aspect.attack_speed',
        label: 'Aspect of Pride',
        expiresAt: ctx.state.t + duration,
        modifiers: { AttackSpeedPercent: attackSpeedPerStack },
        stacksMax: Math.max(1, Math.round(100 / attackSpeedPerStack)),
        addStacks: 1,
      })
    }
  }
  // Queued Bumba post-ability bonus
  if (ctx.state.riders.nextBasicBonusTrue > 0) {
    const v = ctx.state.riders.nextBasicBonusTrue
    emitDamage(ctx, 'true', v, 'Bumba post-ability', 'item')
    ctx.state.riders.nextBasicBonusTrue = 0
  }
}

function applyRepeatableAbilityHitItemProcs(ctx: DamageCtx) {
  for (const item of ctx.attacker.items) {
    for (const proc of getItemProcs(item)) {
      if (proc.kind !== 'onAbilityHit_currentHealthDot') continue
      const repeatKey = `${proc.id}:repeat-window`
      const isRepeatHit = (ctx.state.cooldowns.actives[repeatKey] ?? 0) > ctx.state.t
      const totalPre = (proc.flatDamage + defenderHpAtCurrentTime(ctx) * proc.currentHealthPct)
        * (isRepeatHit ? proc.repeatMultiplier : 1)
      const perTick = totalPre / proc.ticks
      schedDot(ctx, {
        kind: 'dot',
        baseDamage: perTick,
        strScaling: 0,
        intScaling: 0,
        hits: 1,
        ticks: proc.ticks,
        tickRate: proc.tickRate,
        duration: proc.tickRate * proc.ticks,
        damageType: proc.damageType,
        label: itemLabel(item, proc.id),
      }, itemLabel(item, proc.id), undefined, 'item')
      ctx.state.cooldowns.actives[repeatKey] = ctx.state.t + proc.repeatWindowSeconds
    }
  }
}

// --- Ability-hit item procs (target-side debuffs like Oath-Sworn shred) ---

function applyAbilityHitItemProcs(ctx: DamageCtx) {
  for (const item of ctx.attacker.items) {
    for (const proc of getItemProcs(item)) {
      if (proc.kind === 'targetProtShred_perLevel') {
        // Target gets -1 PhysProt per attacker level for durationSeconds.
        applyOrRefreshDebuff(ctx.state, {
          key: proc.id,
          label: `${item.displayName ?? proc.id} (−${ctx.attacker.level} prot)`,
          expiresAt: ctx.state.t + proc.durationSeconds,
          modifiers: { PhysicalProtection: -ctx.attacker.level },
          stacksMax: proc.maxStacks,
          addStacks: 1,
        })
      } else if (proc.kind === 'targetProtShredPct' && proc.trigger !== 'basic') {
        applyOrRefreshDebuff(ctx.state, {
          key: proc.id,
          label: `${itemLabel(item, proc.id)} (-${Math.round(proc.protPct * 100)}% prot)`,
          expiresAt: ctx.state.t + proc.durationSeconds,
          modifiers: {
            PhysicalProtection: -ctx.defender.physicalProtection * proc.protPct,
            MagicalProtection: -ctx.defender.magicalProtection * proc.protPct,
          },
          stacksMax: proc.maxStacks,
          addStacks: 1,
        })
      } else if (proc.kind === 'onAbilityHit_bonusDamage') {
        if (!consumeItemProcCooldown(ctx, proc.id, proc.cooldown)) continue
        emitDamage(
          ctx,
          proc.damageType,
          procPre(ctx, proc.baseDamage, proc.perLevelDamage, proc.strScaling, proc.intScaling),
          itemLabel(item, proc.id),
          'item',
          ['ability-hit item proc'],
        )
      } else if (proc.kind === 'onHit_bonusDamage' && proc.trigger !== 'basic') {
        if (!consumeItemProcCooldown(ctx, proc.id, proc.cooldown)) continue
        emitDamage(
          ctx,
          proc.damageType,
          procPre(ctx, proc.baseDamage, proc.perLevelDamage, proc.strScaling, proc.intScaling),
          itemLabel(item, proc.id),
          'item',
          ['on-hit item proc'],
        )
      } else if (proc.kind === 'onAbilityHit_protectionScalingDamage') {
        if (!consumeItemProcCooldown(ctx, proc.id, proc.cooldown)) continue
        emitDamage(
          ctx,
          proc.damageType,
          proc.baseDamage + currentAttackerItemProtectionTotal(ctx) * proc.itemProtectionScaling,
          itemLabel(item, proc.id),
          'item',
          ['ability-hit item-protection scaling proc'],
        )
      } else if (proc.kind === 'onAbilityHit_bleed') {
        if (!consumeItemProcCooldown(ctx, proc.id, proc.cooldown)) continue
        schedDot(ctx, {
          kind: 'dot',
          baseDamage: proc.damagePerTick,
          strScaling: proc.strScaling,
          intScaling: proc.intScaling,
          hits: 1,
          ticks: proc.ticks,
          tickRate: proc.tickRate,
          duration: proc.tickRate * proc.ticks,
          damageType: proc.damageType,
          label: itemLabel(item, proc.id),
        }, itemLabel(item, proc.id), undefined, 'item')
      } else if (proc.kind === 'onAbilityHit_targetHealthDamage') {
        if (!consumeItemProcCooldown(ctx, proc.id, proc.cooldown)) continue
        const pre = targetHealthDamagePre(
          ctx,
          proc.baseHealthPct,
          proc.itemHealthPct,
          proc.strengthAsTargetMaxPct,
        )
        if (proc.ticks > 1) {
          schedDot(ctx, {
            kind: 'dot',
            baseDamage: pre,
            strScaling: 0,
            intScaling: 0,
            hits: 1,
            ticks: proc.ticks,
            tickRate: proc.tickRate,
            duration: proc.tickRate * proc.ticks,
            damageType: proc.damageType,
            label: itemLabel(item, proc.id),
          }, itemLabel(item, proc.id), undefined, 'item')
        } else {
          emitDamage(ctx, proc.damageType, pre, itemLabel(item, proc.id), 'item',
            ['ability-hit target-health item proc'])
        }
      } else if (proc.kind === 'onAbilityHit_damageEchoDebuff') {
        const lifestealPct = currentLifestealPercent(ctx)
        const echoPct = proc.basePercent + (lifestealPct / 10) * proc.lifestealBonusPercentPer10
        applyOrRefreshDebuff(ctx.state, {
          key: proc.id,
          label: `${itemLabel(item, proc.id)} (+${echoPct.toFixed(2)}% damage echo)`,
          expiresAt: ctx.state.t + proc.durationSeconds,
          modifiers: { BonusPhysicalDamageFromAttacksAndAbilitiesPercent: echoPct },
          stacksMax: proc.maxStacks,
          addStacks: 1,
        })
      } else if (proc.kind === 'onAbilityHit_stackingBonusDamage') {
        const currentStacks = ctx.state.riders.itemProcCounters[proc.id] ?? 0
        if (currentStacks >= proc.stacksRequired) {
          emitDamage(
            ctx,
            proc.damageType,
            procPre(ctx, proc.baseDamage, proc.perLevelDamage, proc.strScaling, proc.intScaling),
            itemLabel(item, proc.id),
            'item',
            [`consumed ${proc.stacksRequired} ability-hit stack(s)`],
          )
          ctx.state.riders.itemProcCounters[proc.id] = 0
        } else {
          ctx.state.riders.itemProcCounters[proc.id] = currentStacks + 1
        }
      } else if (proc.kind === 'onDamage_selfBuff' && proc.trigger !== 'basic') {
        if (!consumeItemProcCooldown(ctx, proc.id, proc.cooldown)) continue
        applyOrRefreshBuff(ctx.state, {
          key: proc.id,
          label: itemLabel(item, proc.id),
          expiresAt: ctx.state.t + proc.durationSeconds,
          modifiers: scaledSelfBuffModifiers(ctx, proc.modifiers, proc.modifiersPerLevel),
          stacksMax: proc.stacksMax,
          addStacks: 1,
        })
      } else if (proc.kind === 'onHit_enemyDebuff' && proc.trigger !== 'basic') {
        if (!consumeItemProcCooldown(ctx, proc.id, proc.cooldown)) continue
        applyOrRefreshDebuff(ctx.state, {
          key: proc.id,
          label: itemLabel(item, proc.id),
          expiresAt: ctx.state.t + proc.durationSeconds,
          modifiers: normalizeEnemyDebuffModifiers(ctx, proc.modifiers),
          stacksMax: proc.stacksMax,
          addStacks: 1,
        })
      }
    }
  }
}

function applyHardCcItemProcs(ctx: DamageCtx) {
  for (const item of ctx.attacker.items) {
    for (const proc of getItemProcs(item)) {
      if (proc.kind === 'onHardCc_enemyDebuff') {
        applyOrRefreshDebuff(ctx.state, {
          key: proc.id,
          label: itemLabel(item, proc.id),
          expiresAt: ctx.state.t + proc.durationSeconds,
          modifiers: normalizeEnemyDebuffModifiers(ctx, proc.modifiers),
          stacksMax: proc.stacksMax,
          addStacks: 1,
        })
      } else if (proc.kind === 'onBasicOrHardCc_prechargedTargetHealthDamage') {
        const stacks = Math.floor(equippedItemPartialStacks(ctx, item))
        const used = ctx.state.riders.itemProcCounters[proc.id] ?? 0
        if (stacks <= 0 || used > 0) continue
        ctx.state.riders.itemProcCounters[proc.id] = stacks
        emitDamage(
          ctx,
          proc.damageType,
          ctx.defender.maxHealth * proc.targetMaxHealthPctPerStack * stacks,
          itemLabel(item, proc.id),
          'item',
          [`${stacks} precharged stack(s) consumed from partialStacks by hard CC`],
        )
      }
    }
  }
}

// --- Active item use ---

function activateItem(
  ctx: DamageCtx,
  itemKey: string,
  label: string,
  equipment: ItemCatalogEntry[] = ctx.attacker.items,
) {
  const item = equipment.find((i) =>
    i.internalKey === itemKey || i.displayName === itemKey,
  )
  if (!item) return
  for (const proc of getItemProcs(item)) {
    if (proc.kind === 'activeUse_shield') {
      const shieldAmount =
        proc.flatShield
        + proc.shieldPerLevel * ctx.attacker.level
        + ctx.attacker.maxHealth * proc.maxHealthPct
        + ctx.attacker.adaptiveStrength * proc.strengthFromItemsPct
        + ctx.attacker.adaptiveIntelligence * proc.intelligenceFromItemsPct
      const shieldLabel = shieldAmount > 0
        ? `${label} (${Math.round(shieldAmount)} shield)`
        : label
      // Shield doesn't directly deal damage; log as active-use with metadata.
      ctx.state.events.push({
        kind: 'active-use', t: ctx.state.t, itemKey, label: shieldLabel,
      })
      // The +10% lifesteal while shielded is applied as a self-buff for durationSeconds.
      if (proc.lifestealBonusPct > 0) {
        applyOrRefreshBuff(ctx.state, {
          key: `${proc.id}-lifesteal`,
          label: `${label} lifesteal`,
          expiresAt: ctx.state.t + proc.durationSeconds,
          modifiers: { PhysicalInhandLifestealPercent: proc.lifestealBonusPct },
        })
      }
      ctx.state.cooldowns.actives[itemKey] = ctx.state.t + proc.cooldown
    } else if (proc.kind === 'activeUse_cdr') {
      // Reduce each ability's remaining cooldown by secondsReduced
      for (const slot of ['A01', 'A02', 'A03', 'A04'] as AbilitySlot[]) {
        const cd = ctx.state.cooldowns.abilities[slot]
        if (cd > ctx.state.t) {
          ctx.state.cooldowns.abilities[slot] = Math.max(ctx.state.t, cd - proc.secondsReduced)
        }
      }
      ctx.state.events.push({ kind: 'active-use', t: ctx.state.t, itemKey, label })
      ctx.state.cooldowns.actives[itemKey] = ctx.state.t + proc.cooldown
    } else if (proc.kind === 'activeUse_damage') {
      // Bleed-style active: ticks over a short window.
      const perTick = proc.baseDamage + proc.perLevelDamage * ctx.attacker.level
      const dotPlan: DamagePlan = {
        kind: 'dot',
        baseDamage: perTick,
        strScaling: 0,
        intScaling: 0,
        hits: 1,
        ticks: proc.ticks,
        tickRate: 2 / Math.max(1, proc.ticks),  // estimate 2s bleed → 3 ticks means 0.67s/tick
        duration: 2,
        damageType: proc.damageType,
        label,
      }
      schedDot(ctx, dotPlan, label, undefined, 'active')
      ctx.state.events.push({ kind: 'active-use', t: ctx.state.t, itemKey, label })
      ctx.state.cooldowns.actives[itemKey] = ctx.state.t + proc.cooldown
    } else if (proc.kind === 'activeUse_instantDamage') {
      const pre = procPre(ctx, proc.baseDamage, proc.perLevelDamage, proc.strScaling, proc.intScaling)
        + ctx.state.defenderCurrentHP * proc.targetCurrentHealthPct
      emitDamage(ctx, proc.damageType, pre, label, 'active', ['active item damage'])
      ctx.state.events.push({ kind: 'active-use', t: ctx.state.t, itemKey, label })
      ctx.state.cooldowns.actives[itemKey] = ctx.state.t + proc.cooldown
    } else if (proc.kind === 'activeUse_inhandScalingDamage') {
      const pre = proc.baseDamage + currentInhandAttackDamage(ctx) * proc.inhandScaling
      for (let i = 1; i <= proc.hits; i++) {
        emitDamage(ctx, proc.damageType, pre, `${label} (hit ${i}/${proc.hits})`, 'active',
          ['active item attack-damage scaling'])
      }
      ctx.state.events.push({ kind: 'active-use', t: ctx.state.t, itemKey, label })
      ctx.state.cooldowns.actives[itemKey] = ctx.state.t + proc.cooldown
    } else if (proc.kind === 'activeUse_extraBasicProjectiles') {
      const rider = {
        key: proc.id,
        label,
        damageType: proc.damageType,
        baseDamage: proc.baseDamage,
        inhandScaling: proc.inhandScaling,
        hits: proc.hits,
        expiresAt: ctx.state.t + proc.durationSeconds,
        source: 'item' as const,
      }
      ctx.state.riders.activeBasicProjectiles = ctx.state.riders.activeBasicProjectiles
        .filter((existing) => existing.key !== rider.key)
      ctx.state.riders.activeBasicProjectiles.push(rider)
      ctx.state.events.push({ kind: 'active-use', t: ctx.state.t, itemKey,
        label: `${label} (${proc.hits} extra projectile${proc.hits === 1 ? '' : 's'} per basic)` })
      ctx.state.cooldowns.actives[itemKey] = ctx.state.t + proc.cooldown
    } else if (proc.kind === 'activeUse_targetHealthDamage') {
      const pre = targetHealthDamagePre(ctx, proc.baseHealthPct, proc.itemHealthPct)
      if (proc.ticks > 1) {
        schedDot(ctx, {
          kind: 'dot',
          baseDamage: pre,
          strScaling: 0,
          intScaling: 0,
          hits: 1,
          ticks: proc.ticks,
          tickRate: proc.tickRate,
          duration: proc.tickRate * proc.ticks,
          damageType: proc.damageType,
          label,
        }, label, undefined, 'active')
      } else {
        emitDamage(ctx, proc.damageType, pre, label, 'active', ['active target-health item damage'])
      }
      ctx.state.events.push({ kind: 'active-use', t: ctx.state.t, itemKey, label })
      ctx.state.cooldowns.actives[itemKey] = ctx.state.t + proc.cooldown
    } else if (proc.kind === 'activeUse_targetMaxHealthDamage') {
      const healthPct = proc.targetMaxHealthPct
        + (currentLifestealPercent(ctx) / 10) * proc.lifestealBonusPctPer10
      const perTick = Math.min(ctx.defender.maxHealth * healthPct, proc.damageCap)
      if (proc.ticks > 1) {
        schedDot(ctx, {
          kind: 'dot',
          baseDamage: perTick,
          strScaling: 0,
          intScaling: 0,
          hits: 1,
          ticks: proc.ticks,
          tickRate: proc.tickRate,
          duration: proc.tickRate * proc.ticks,
          damageType: proc.damageType,
          label,
        }, label, undefined, 'active')
      } else {
        emitDamage(ctx, proc.damageType, perTick, label, 'active', ['active target-max-health item damage'])
      }
      ctx.state.events.push({ kind: 'active-use', t: ctx.state.t, itemKey, label })
      ctx.state.cooldowns.actives[itemKey] = ctx.state.t + proc.cooldown
    } else if (proc.kind === 'activeUse_protectionScalingDamage') {
      const savedT = ctx.state.t
      ctx.state.t = savedT + proc.delaySeconds
      emitDamage(ctx, proc.damageType, currentAttackerProtectionTotal(ctx) * proc.protectionScaling, label, 'active',
        [`${Math.round(proc.protectionScaling * 100)}% of total protections`])
      ctx.state.t = savedT
      ctx.state.events.push({ kind: 'active-use', t: ctx.state.t, itemKey, label })
      ctx.state.cooldowns.actives[itemKey] = ctx.state.t + proc.cooldown
    } else if (proc.kind === 'activeUse_nextNonUltimateNoCooldown') {
      ctx.state.riders.nextNonUltimateNoCooldown = true
      ctx.state.events.push({ kind: 'active-use', t: ctx.state.t, itemKey,
        label: `${label} (next non-ultimate no cooldown)` })
      ctx.state.cooldowns.actives[itemKey] = ctx.state.t + proc.cooldown
    } else if (proc.kind === 'activeUse_selfBuff') {
      applyOrRefreshBuff(ctx.state, {
        key: proc.id,
        label,
        expiresAt: ctx.state.t + proc.durationSeconds,
        modifiers: proc.modifiers,
      })
      ctx.state.events.push({ kind: 'active-use', t: ctx.state.t, itemKey, label })
      ctx.state.cooldowns.actives[itemKey] = ctx.state.t + proc.cooldown
    } else if (proc.kind === 'activeUse_convertIntToStrength') {
      applyOrRefreshBuff(ctx.state, {
        key: proc.id,
        label,
        expiresAt: ctx.state.t + proc.durationSeconds,
        modifiers: {
          adaptiveStrength: currentAdaptiveIntelligence(ctx) * proc.strengthFromCurrentIntPct,
          adaptiveIntelligencePercent: proc.intelligencePercent,
          CritChance: proc.critChance,
        },
      })
      ctx.state.events.push({ kind: 'active-use', t: ctx.state.t, itemKey, label })
      ctx.state.cooldowns.actives[itemKey] = ctx.state.t + proc.cooldown
    } else if (proc.kind === 'activeUse_enemyDebuff') {
      applyOrRefreshDebuff(ctx.state, {
        key: proc.id,
        label,
        expiresAt: ctx.state.t + proc.durationSeconds,
        modifiers: normalizeEnemyDebuffModifiers(ctx, proc.modifiers),
        stacksMax: 1,
        addStacks: 1,
      })
      ctx.state.events.push({ kind: 'active-use', t: ctx.state.t, itemKey, label })
      ctx.state.cooldowns.actives[itemKey] = ctx.state.t + proc.cooldown
    } else if (proc.kind === 'activeUse_cc') {
      // Informational — logged as an event, no damage computed here.
      ctx.state.events.push({ kind: 'active-use', t: ctx.state.t, itemKey,
        label: `${label} (${proc.flavor} ${proc.durationSeconds}s)` })
      ctx.state.cooldowns.actives[itemKey] = ctx.state.t + proc.cooldown
    } else if (proc.kind === 'activeUse_teleport') {
      ctx.state.events.push({ kind: 'active-use', t: ctx.state.t, itemKey,
        label: `${label} (teleport ${proc.rangeMeters}m)` })
      ctx.state.cooldowns.actives[itemKey] = ctx.state.t + proc.cooldown
    } else if (proc.kind === 'activeUse_utility') {
      ctx.state.events.push({ kind: 'active-use', t: ctx.state.t, itemKey,
        label: `${label} (${proc.description})` })
      ctx.state.cooldowns.actives[itemKey] = ctx.state.t + proc.cooldown
    }
  }
}

// --- Scenario runner ---

export function runScenario(scenario: Scenario): SimResult {
  // Team-comp entry point: if `teamAttackers` is set, run each attacker as an
  // independent scenario against the shared defender, then stitch the results.
  // Each attacker sees the defender in its natural state (no crosstalk on
  // shields/shreds between attackers — a simplification that keeps the shared
  // sim tractable). Use `perAttackerTotals` to read per-attacker damage.
  if (scenario.teamAttackers && scenario.teamAttackers.length > 0) {
    return runTeamScenario(scenario)
  }
  return runSingleScenario(scenario)
}

function runTeamScenario(scenario: Scenario): SimResult {
  const primary = runSingleScenario({ ...scenario, teamAttackers: undefined })
  const sharedDefender = primary.defenderSnapshot as DefenderSnapshot
  const perAttackerTotals: Record<string, number> = {
    [scenario.attacker.godId]: primary.totals.total,
  }
  const allEvents = [...primary.events]
  const allDamageEvents = [...primary.damageEvents]
  let comboT = primary.comboExecutionTime
  let combatT = primary.totalCombatTime
  const byLabel: Record<string, number> = { ...primary.byLabel }
  const bySource: Record<string, number> = { ...primary.bySource }
  const totals = { ...primary.totals }

  for (const ally of scenario.teamAttackers!) {
    const allyScenario: Scenario = {
      title: ally.title ?? `team: ${ally.godId}`,
      attacker: ally,
      defender: scenario.defender,
      enemies: scenario.enemies,
      rotation: ally.rotation,
      options: scenario.options,
    }
    const allyRes = runSingleScenario(allyScenario)
    const key = ally.title ?? ally.godId
    perAttackerTotals[key] = allyRes.totals.total
    allEvents.push(...allyRes.events)
    allDamageEvents.push(...allyRes.damageEvents)
    comboT = Math.max(comboT, allyRes.comboExecutionTime)
    combatT = Math.max(combatT, allyRes.totalCombatTime)
    for (const [k, v] of Object.entries(allyRes.byLabel)) byLabel[k] = (byLabel[k] ?? 0) + v
    for (const [k, v] of Object.entries(allyRes.bySource)) bySource[k] = (bySource[k] ?? 0) + v
    totals.physical += allyRes.totals.physical
    totals.magical += allyRes.totals.magical
    totals.true += allyRes.totals.true
    totals.total += allyRes.totals.total
  }

  const events = allEvents.sort((a, b) => a.t - b.t)
  const damageEvents = allDamageEvents.sort((a, b) => a.t - b.t)
  const sharedOverkill = computeSharedOverkill(damageEvents, sharedDefender.maxHealth)
  const defenderDefeatedAt = computeDefenderDefeatedAt(damageEvents, sharedDefender.maxHealth)

  return {
    ...primary,
    totalCombatTime: combatT,
    comboExecutionTime: comboT,
    events,
    damageEvents,
    totals,
    byLabel,
    bySource,
    dpsSeries: buildDpsSeries(damageEvents, combatT),
    defenderDefeatedAt,
    overkill: sharedOverkill,
    perAttackerTotals,
    warnings: [
      ...primary.warnings,
      'Team mode shares defender HP for kill timing and overkill, but cross-attacker debuffs/shields are not yet applied during mitigation.',
    ],
  }
}

/** Produce a per-build report of stacking/ramp items so UIs can show "this item
 *  reaches peak effect at Ts". Rough estimates — actual ramp rate depends on
 *  gameplay pattern (basics landed, minions killed). */
function buildTimeAwareItemReport(attacker: AttackerSnapshot): Array<{
  itemName: string
  ramp: 'stacks' | 'uptime' | 'unknown'
  secondsToFull: number
  effectAtFull: string
}> {
  const report: Array<{ itemName: string; ramp: 'stacks' | 'uptime' | 'unknown';
    secondsToFull: number; effectAtFull: string }> = []
  for (const item of attacker.items) {
    const key = (item.internalKey ?? '').toLowerCase()
    const name = item.displayName ?? item.internalKey ?? '?'
    if (key.includes('transcend')) {
      report.push({ itemName: name, ramp: 'stacks', secondsToFull: 180,
        effectAtFull: '+50 stacks × 7 mana + evolution bonus (+15 STR, +100 mana)' })
    } else if (key.includes('bookofthoth') || key.includes('book_of_thoth')) {
      report.push({ itemName: name, ramp: 'stacks', secondsToFull: 240,
        effectAtFull: '+50 stacks × 10 mana + evolution (mana → 7% INT)' })
    } else if (key.includes('brawler')) {
      report.push({ itemName: name, ramp: 'uptime', secondsToFull: 6,
        effectAtFull: 'Brawler\'s bleed stacks 5× for DoT ramp' })
    } else if (key.includes('bloodforge') || key.includes('blood-forged')) {
      report.push({ itemName: name, ramp: 'stacks', secondsToFull: 10,
        effectAtFull: '+10 stacks × ~3 Strength each (minion kills)' })
    } else if (key.includes('soulreaver') || key.includes('soul-reaver')) {
      report.push({ itemName: name, ramp: 'stacks', secondsToFull: 20,
        effectAtFull: 'souls gained from basic hits → peak INT' })
    }
  }
  return report
}

function buildDpsSeries(
  damageEvents: DamageEvent[],
  endT: number,
): Array<{ t: number; instantDps: number; cumulativeDamage: number }> {
  const dpsSeries: Array<{ t: number; instantDps: number; cumulativeDamage: number }> = []
  const sampleWindow = 1.0
  let cumulative = 0
  let idx = 0
  const sorted = damageEvents.slice().sort((a, b) => a.t - b.t)
  for (let t = 0; t <= endT + 0.01; t += 0.1) {
    while (idx < sorted.length && sorted[idx].t <= t) {
      cumulative += sorted[idx].postMitigation
      idx += 1
    }
    // Instant DPS over the last sampleWindow seconds.
    const lo = t - sampleWindow
    const windowDamage = sorted
      .filter((e) => e.t > lo && e.t <= t)
      .reduce((sum, e) => sum + e.postMitigation, 0)
    dpsSeries.push({ t: Number(t.toFixed(2)), instantDps: windowDamage / sampleWindow, cumulativeDamage: cumulative })
  }
  return dpsSeries
}

function computeDefenderDefeatedAt(
  damageEvents: DamageEvent[],
  defenderMaxHealth: number,
): number | undefined {
  let cumulative = 0
  for (const ev of damageEvents.slice().sort((a, b) => a.t - b.t)) {
    cumulative += ev.postMitigation
    if (cumulative >= defenderMaxHealth) return ev.t
  }
  return undefined
}

function computeSharedOverkill(
  damageEvents: DamageEvent[],
  defenderMaxHealth: number,
): number {
  const totalDamage = damageEvents.reduce((sum, ev) => sum + ev.postMitigation, 0)
  return Math.max(0, totalDamage - defenderMaxHealth)
}

function runSingleScenario(scenario: Scenario): SimResult {
  const attacker = snapshotAttacker(scenario)
  const defender = snapshotDefender(scenario)
  const state = createCombatState(defender.maxHealth)
  const options = scenario.options ?? {}
  const ctx: DamageCtx = { attacker, defender, state, options }

  const assumptions: string[] = []
  const warnings: string[] = []

  // Apply pre-combat drop buffs declared on the scenario (Red, FG, EFG, elixirs, etc.)
  const disabledBuffs = new Set(options.disableBuffs ?? [])
  for (const buffKey of scenario.attacker.activeBuffs ?? []) {
    if (disabledBuffs.has(buffKey)) continue
    const def = DROP_BUFFS[buffKey]
    if (!def) { warnings.push(`Unknown drop buff: ${buffKey}`); continue }
    state.attackerBuffs.set(def.key, {
      key: def.key,
      label: def.label,
      appliedAt: 0,
      expiresAt: def.defaultDurationSeconds,
      modifiers: def.modifiers,
      stacks: 1,
    })
    if (def.note) assumptions.push(`${def.label}: ${def.note}`)
  }
  // Multi-enemy warning if present but unsupported
  if (scenario.enemies && scenario.enemies.length > 0) {
    warnings.push('Multi-enemy mode declared but sim currently resolves against primary defender only. Secondary enemies are ignored.')
  }
  // Stat bounds declaration (for a future optimizer that sweeps scenarios)
  if (scenario.attacker.statBounds) {
    assumptions.push('Stat bounds declared but not yet swept — sim uses point-estimate values.')
  }

  if (attacker.god.god === 'Kali') {
    assumptions.push('Kali A03 rupture bonus uses local Passive Bonus Damage rank rows; non-A03 rupture fallback remains approximate.')
  }
  if (options.penPercentOverride !== undefined) {
    assumptions.push(`penPercentOverride = ${options.penPercentOverride}%`)
  }
  if (scenario.attacker.aspects && scenario.attacker.aspects.length > 0) {
    const aspectNames = scenario.attacker.aspects.join(', ')
    assumptions.push(`Aspect(s) equipped (${aspectNames}) — aspect rank rows and wired god-locked modifiers are applied where extracted formulas exist.`)
  }

  for (const item of attacker.items) {
    if (hasMissingStatRows(item)) {
      warnings.push(`${itemLabel(item, item.internalKey ?? 'item')} has stat tags but no numeric stat rows in the extracted catalog; its flat stats are omitted until the item data is repaired.`)
    }
    const conditional = conditionalBonusFor(item.internalKey)
    if (conditional) {
      if (options.forceConditionalItemEffects === true) {
        assumptions.push(`${itemLabel(item, item.internalKey ?? 'item')} conditional passive forced active: ${conditional.trigger}.`)
      } else {
        assumptions.push(`${itemLabel(item, item.internalKey ?? 'item')} conditional passive not active by default: ${conditional.trigger}.`)
      }
    }
    for (const proc of getItemProcs(item)) {
      if (proc.kind === 'passive_selfBuff') {
        applyOrRefreshBuff(state, {
          key: proc.id,
          label: itemLabel(item, proc.id),
          expiresAt: Number.POSITIVE_INFINITY,
          modifiers: proc.modifiers,
        })
        assumptions.push(`${itemLabel(item, proc.id)} passive self-buff is applied at combat start.`)
      }
      if (proc.kind === 'passive_enemyDebuff') {
        applyOrRefreshDebuff(state, {
          key: proc.id,
          label: itemLabel(item, proc.id),
          expiresAt: Number.POSITIVE_INFINITY,
          modifiers: normalizeEnemyDebuffModifiers(ctx, proc.modifiers),
        })
        assumptions.push(`${itemLabel(item, proc.id)} passive enemy debuff is applied at combat start.`)
      }
      if (proc.kind === 'passive_utility') {
        assumptions.push(`${itemLabel(item, proc.id)}: ${proc.description}`)
      }
      if (
        (proc.kind === 'onBasicHit_prechargedHealthScalingDamage'
          || proc.kind === 'onBasicOrHardCc_prechargedTargetHealthDamage')
        && equippedItemPartialStacks(ctx, item) <= 0
      ) {
        assumptions.push(`${itemLabel(item, proc.id)} precharged passive requires partialStacks['${item.internalKey ?? item.displayName ?? proc.id}'].`)
      }
    }
  }

  for (const action of scenario.rotation) {
    walkAction(ctx, action)
  }
  // Capture the time when the player finished pressing buttons — this is
  // `how long did executing the combo take`. Different from totalCombatTime,
  // which includes post-combo DoT ticks and deployables still firing.
  const comboExecutionTime = state.t

  // If a combatWindow is set and greedyBasics is on, fill remaining time with basics
  if (options.combatWindow && options.greedyBasics) {
    while (state.t < options.combatWindow) {
      const nextBasic = Math.max(state.t, state.cooldowns.basic)
      if (nextBasic >= options.combatWindow) break
      advanceTime(ctx, nextBasic)
      executeBasic(ctx, `AA (filler t=${state.t.toFixed(2)}s)`)
      state.cooldowns.basic = state.t + 1 / Math.max(0.01, currentTotalAttackSpeed(ctx))
    }
  }

  const damageEvents = state.events.filter((e): e is DamageEvent => e.kind === 'damage')

  const totals = { physical: 0, magical: 0, true: 0, total: 0 }
  const byLabel: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  for (const ev of damageEvents) {
    totals[ev.damageType] += ev.postMitigation
    totals.total += ev.postMitigation
    byLabel[ev.label] = (byLabel[ev.label] ?? 0) + ev.postMitigation
    bySource[ev.source] = (bySource[ev.source] ?? 0) + ev.postMitigation
  }

  const endT = Math.max(state.t, ...damageEvents.map((e) => e.t))
  const dpsSeries = buildDpsSeries(damageEvents, endT)
  const defenderDefeatedAt = computeDefenderDefeatedAt(damageEvents, defender.maxHealth)

  return {
    scenarioTitle: scenario.title,
    totalCombatTime: endT,
    comboExecutionTime,
    events: state.events,
    damageEvents,
    totals,
    byLabel,
    bySource,
    dpsSeries,
    defenderDefeatedAt,
    timeAwareItems: buildTimeAwareItemReport(attacker),
    overkill: state.overkill,
    attackerSnapshot: attacker,
    defenderSnapshot: defender,
    assumptions,
    warnings,
  }
}

function walkAction(ctx: DamageCtx, action: RotationAction) {
  const { state } = ctx
  expireTimedEffects(state)
  if (action.kind === 'wait') {
    advanceTime(ctx, state.t + action.seconds)
    return
  }
  if (action.kind === 'ability') {
    // Advance clock to when the ability is off-cooldown (simulates waiting)
    advanceUntilAbilityReady(ctx, action.slot)
    const startT = state.t
    executeAbility(ctx, action.slot, action.label ?? `${action.slot}`, { cancel: action.cancel })
    // Advance past the cast lockout — how long the attacker is locked in the
    // animation before another action is possible. Uses the ability-timings
    // catalog; per-action `castDuration` override takes precedence (used for
    // cancelled channels).
    const timing = getAbilityTiming(ctx.attacker.god.god, action.slot)
    const castDur = action.castDuration
      ?? (action.cancel ? cancelCastDurationOverride(ctx, action.slot) : null)
      ?? timing.castDuration
    if (castDur > 0) {
      const endT = startT + castDur
      if (state.t < endT) advanceTime(ctx, endT)
    }
    // Ability use resets the SWING-time chain to step 1 — next AA uses Fire_01
    // authored swing time per user-observed behavior. The DAMAGE chain index
    // preserves across abilities (Kali's post-ability AA damage test validates
    // that the damage chain is NOT reset).
    state.riders.basicSwingChainIndex = 0
    return
  }
  if (action.kind === 'basic') {
    const bc = state.cooldowns.basic
    if (bc > state.t) advanceTime(ctx, bc)
    // Chain-position-aware swing time. Fire_01..Fire_N authored durations are
    // scaled by 1/AS (animations play at "1.0 AS"-equivalent, so attack speed
    // divides the swing time).
    const godId = ctx.attacker.god.god
    const chain = getBasicChain(godId) ?? [1.0]
    const swingChainIdx = state.riders.basicSwingChainIndex % chain.length
    const chainMult = chain[swingChainIdx]
    const currentAS = currentTotalAttackSpeed(ctx)
    const swingTime = chainMult / Math.max(0.01, currentAS)
    executeBasic(ctx, action.label ?? `AA${state.riders.basicChainIndex + 1}`)
    state.riders.basicSwingChainIndex += 1
    // Basic-to-basic: full chain-position swing time.
    // Basic-to-ability: cancel commit (~0.15s) before the next input can queue.
    const BASIC_COMMIT_TIME = 0.15
    state.cooldowns.basic = state.t + swingTime
    advanceTime(ctx, state.t + Math.min(BASIC_COMMIT_TIME, swingTime))
    return
  }
  if (action.kind === 'activate') {
    const cd = state.cooldowns.actives[action.itemKey] ?? 0
    if (cd > state.t) advanceTime(ctx, cd)
    activateItem(ctx, action.itemKey, action.label ?? action.itemKey)
    return
  }
  if (action.kind === 'relic') {
    // Relics are items equipped via scenario.attacker.relics. We resolve the
    // same ItemProc list from the item catalog and run through the same
    // activeUse proc paths as items.
    const relicItem = ctx.attacker.relics.find((i) =>
      i.internalKey === action.relicKey || i.displayName === action.relicKey)
    if (relicItem) {
      const resolvedKey = relicItem.internalKey ?? relicItem.displayName ?? action.relicKey
      const cd = state.cooldowns.actives[resolvedKey] ?? state.cooldowns.actives[action.relicKey] ?? 0
      if (cd > state.t) advanceTime(ctx, cd)
      activateItem(ctx, resolvedKey, action.label ?? action.relicKey, ctx.attacker.relics)
    } else {
      state.events.push({ kind: 'active-use', t: state.t, itemKey: action.relicKey,
        label: (action.label ?? action.relicKey) + ' (not found in scenario relics)' })
    }
    return
  }
}

// Re-export types for consumers
export type { Scenario, SimResult } from './types.ts'
