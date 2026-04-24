/**
 * Generic ability resolver. Given a god's AbilityCatalogEntry + rank, returns
 * a structured AbilityPlan the engine uses to emit damage/buff events.
 *
 * This is the engine's attempt to handle 77 gods' abilities without writing
 * 300+ hand-coded handlers. It inspects the curve-table row names on the
 * ability and recognizes common patterns:
 *
 *  - Direct damage:   "Base Damage" + ("Strength Scaling" | "Int Scaling" | "Scaling")
 *  - Multi-hit:       "Base Damage" paired with "Hit Count" or explicitly tagged
 *  - DoT damage:      "Damage Per Tick" + "Tick Rate" + "Damage Over Time Duration"
 *  - Bleed ancillary: "Bleed Damage" + "Bleed Str Scaling" + "Bleed Int Scaling"
 *                     (implicitly 5 ticks over a duration — SMITE 2 convention for bleeds)
 *  - Self-buff:       "Strength Buff", "Intelligence Buff", "Buff Duration"
 *  - Stun ancillary:  "Stun Duration" → just logged, no damage
 *  - Heal ancillary:  "Base Heal" / "Heal Base" — logged but not damage
 *
 * A god-specific handler (see godHandlers.ts) can replace the generic plan
 * when an ability doesn't fit (e.g. stance-based, resource-consuming).
 */

import { abilityRankValues, abilityRowAt, type GodCatalogEntry } from '../../catalog/loadCatalogs.ts'
import { interp, type Curve } from '../../catalog/curve.ts'
import { getAspectAbilityRows } from '../../catalog/aspectCurves.ts'
import type { AbilitySlot, DamageType } from './types.ts'

export interface DamagePlan {
  kind: 'direct' | 'dot' | 'bleed'
  baseDamage: number
  strScaling: number
  intScaling: number
  /** For multi-hit abilities: number of independent damage applications. */
  hits: number
  /** For DoT: total ticks over duration. */
  ticks?: number
  /** For DoT: seconds between ticks. */
  tickRate?: number
  /** For DoT: total duration in seconds. */
  duration?: number
  /** Optional cast-relative delay before this damage component lands. */
  delaySeconds?: number
  damageType: DamageType
  label: string
}

export interface BuffPlan {
  kind: 'self-buff'
  label: string
  key: string
  durationSeconds: number
  modifiers: Partial<Record<string, number>>
  applyBeforeDamage?: boolean
}

export interface CCPlan {
  kind: 'cc'
  label: string
  durationSeconds: number
  flavor: 'stun' | 'root' | 'slow' | 'silence' | 'knockback'
}

export interface HealPlan {
  kind: 'heal'
  label: string
  baseHeal: number
  strScaling: number
  intScaling: number
  missingHealthHealPercent: number
}

export interface EnemyDebuffPlan {
  kind: 'enemy-debuff'
  label: string
  key: string
  durationSeconds: number
  modifiers: Partial<Record<string, number>>
  addStacks?: number
  stacksMax?: number
  applyOnEachDamageHit?: boolean
}

export interface NextBasicBonusPlan {
  kind: 'next-basic-bonus'
  label: string
  baseDamage: number
  strScaling: number
  intScaling: number
  damageType: DamageType
  durationSeconds: number
}

export type AbilityComponent = DamagePlan | BuffPlan | CCPlan | HealPlan | NextBasicBonusPlan | EnemyDebuffPlan

export interface AbilityPlan {
  slot: AbilitySlot
  abilityName: string
  rank: number
  components: AbilityComponent[]
  /** Cost / cooldown from rank values if present. */
  manaCost: number
  cooldownSeconds: number
  /** Tags declared on the ability's main Damage GE (e.g. Effect.Property.CanEcho). */
  tags: string[]
}

interface BuildAbilityPlanOptions {
  aspectActive?: boolean
}

const ROW_ALIASES = {
  baseDamage: ['Base Damage', 'Damage', 'BaseDamage', 'DamageBase', 'Damage Base'],
  strScaling: [
    'Strength Scaling', 'Base Str Scaling', 'Scaling', 'Physical Power Scaling',
    'Physical Scaling', 'StrScaling', 'Bleed Str Scaling', 'STR Scaling',
    'Str Scaling', 'StrengthScaling', 'STRScaling', 'Damage Scaling',
    'DamageScaling', 'Standard Scaling', 'Projectile Physical Scaling',
    'STR Scaling',
  ],
  intScaling: [
    'Intelligence Scaling', 'Int Scaling', 'Base Int Scaling', 'Magical Power Scaling',
    'INTScaling', 'SmallINTScaling', 'Magical Scaling', 'Bleed Int Scaling',
    'INT Scaling', 'IntScaling', 'Base INT Scaling', 'Damage Int Scaling',
    'INT Damage Scaling', 'Base Scaling', 'Projectile Scaling',
    'INT Scaling',
  ],
  tickDamage: ['Damage Per Tick', 'Base Damage Per Tick', 'Tick Damage', 'TickDamage', 'Dot Damage', 'DoT Damage', 'TrailDamagePerTick'],
  tickRate: ['Tick Rate', 'Dot Tick Rate', 'TickTime', 'Tick Timing'],
  dotDuration: ['Damage Over Time Duration', 'DoT Duration', 'Dot Duration', 'Total Duration', 'Rain Duration', 'Tick Duration', 'Channel Duration', 'TrailDuration'],
  bleedDamage: ['Bleed Damage'],
  bleedStrScaling: ['Bleed Str Scaling'],
  bleedIntScaling: ['Bleed Int Scaling'],
  stunDuration: ['Stun Duration', 'StunDuration'],
  strengthBuff: ['Strength Buff'],
  intelligenceBuff: ['Intelligence Buff', 'Int Buff'],
  buffDuration: ['Buff Duration', 'BuffDuration', 'BaseDuration', 'Attack Speed Buff Duration', 'Attack Speed Duration', 'ShieldDuration'],
  manaCost: ['Mana Cost', 'Cost'],
  cooldown: ['Cooldown', 'Base Cooldown'],
  healBase: ['Heal Base', 'Base Heal', 'Base Healing', 'Healing Base', 'Heal Amount'],
  healMissingHealth: ['% Missing Health Heal', 'Missing Health Heal Percent', 'MissingHealthHeal'],
  hitCount: ['Hit Count', 'Hits', 'Number of Hits', 'Attack Count', 'AttackCount'],
  movementSpeedBuff: ['Movement Speed', 'Movement Speed Buff', 'Passive Movement Speed Buff', 'Speed Strength', 'Speed Buff', 'MS Buff', 'MSBuff', 'Movespeed'],
  attackSpeedBuff: ['Attack Speed', 'Attack Speed Buff', 'Attack Speed Bonus', 'AS Buff', 'Attack Speed Weak'],
  protectionBuff: ['Protection', 'Protections', 'Bonus Protections', 'Protections Buff', 'SelfProtBuff', 'AllyProtBuff', 'AladdinProtections'],
  shieldBuff: ['Shield Value', 'Shield Health', 'ShieldBuff'],
  damageBuff: ['Damage Buff', 'Damage Increased Buff'],
  penetrationBuff: ['Penetration', 'Physical Penetration', 'Physical Pen', 'Magical Penetration', 'Magical Pen'],
  basicAttackDamageBuff: ['BasicAttackDmg', 'Basic Attack Damage', 'InhandPowerBuff'],
  nextBasicBuffDamage: ['BuffDamage'],
  nextBasicBuffScaling: ['BuffScaling', 'Buff STR Scaling', 'Buff Int Scaling'],
} as const

/** Legacy prefix fallback retained for names the generic row matcher does not catch yet. */
const PHASE_PREFIXES = [
  'Initial', 'Secondary', 'Primary',
  'Cripple', 'Heavy',
  'Flurry', 'Final',
  'Charge', 'Burst',
  'Early', 'Late',
  'Strong', 'Weak',
  'Empowered', 'Normal', 'Unempowered',
  'Quick', 'Explosion',
  'First', 'Second', 'Third',
  'Stun', 'Root', 'Impact',
] as const

/** Per-ability hit-count overrides for channeled abilities whose tooltip uses
 * {AttackCount} or otherwise doesn't expose the count in a rankValues row. */
export const HIT_COUNT_OVERRIDES: Record<string, number> = {
  'Loki.A02': 8,           // Agonizing Visions: 8 hits (in-game combat log)
  'Anubis.A01': 8,         // Plague of Locusts: channeled repeating
  'Anubis.A03': 5,         // Grasping Hands
  'Anubis.A04': 8,         // Death Gaze: channel
  'Anhur.A04': 7,          // Desert Fury channel
  'Ares.A03': 6,           // Searing Flesh channel
  'Bacchus.A03': 6,        // Belch of the Gods channel
  'Cabrakan.A03': 5,       // Tremors channel
  'Cernunnos.A02': 4,      // Bramble Blast
  'Ganesha.A02': 5,        // Ohm channel
  'Hecate.A04': 3,         // Open the Gates (tooltip confirms 3)
  'Fenrir.A03': 4,         // Brutalize (tooltip confirms 4)
  'Hades.A04': 8,          // Pillar Of Agony (tooltip confirms 8)
  'Khepri.A02': 11,        // Rising Dawn (tooltip confirms 11)
  'Kukulkan.A03': 6,       // Whirlwind (tooltip confirms 6)
  'Neith.A04': 6,          // World Weaver channel
  'Poseidon.A03': 6,       // Whirlpool (tooltip confirms 6)
  'Sol.A01': 6,            // Radiance (repeating)
  'Ymir.A04': 8,           // Shards of Ice channel
  'Zeus.A04': 10,          // Lightning Storm channel
  'Artio.A03': 5,          // Life Tap channel
  'Athena.A04': 4,         // Defender of Olympus channel
  'Chiron.A02': 5,         // Masterful Shot flurry (tooltip "hit 5")
  'DaJi.A02': 4,           // One Thousand Cuts strikes 4 times
  'Eset.A01': 4,           // Wing Gust fires 4 projectiles
  'Thor.A03': 6,           // Berserker Barrage hits
  'Loki.A03': 6,           // Flurry Strike (tooltip)
  'Ratatoskr.A02': 4,      // Flurry spins 4 times
}

/** Local-GE-derived buff durations that are not exposed as rank rows. */
const BUFF_DURATION_OVERRIDES: Record<string, number> = {
  'Rama.A02': 6,           // GE_Rama_A02_AttackSpeed lifetime
}

const DEBUFF_DURATION_OVERRIDES: Record<string, number> = {
  'Scylla.A02': 5,         // Crush field persists for 5s; max-rank prot shred lives on the field
}

function firstRow(rankValues: Record<string, unknown> | null, names: readonly string[]): string | null {
  if (!rankValues) return null
  for (const n of names) {
    if (n in rankValues) return n
  }
  return null
}

let ACTIVE_ROW_SOURCE: Record<string, unknown> | null = null

function valueAt(god: GodCatalogEntry, slot: AbilitySlot, rowName: string | null, rank: number): number {
  if (!rowName) return 0
  const curve = ACTIVE_ROW_SOURCE?.[rowName] as Curve | undefined
  if (curve && typeof curve === 'object' && Array.isArray(curve.keys)) return interp(curve, rank)
  return abilityRowAt(god, slot, rowName, rank) ?? 0
}

function words(row: string): string[] {
  return row
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/%/g, ' percent ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function compact(row: string): string {
  return words(row).join('')
}

const MATCH_STOP_WORDS = new Set([
  'base', 'damage', 'scaling', 'scale', 'str', 'strength', 'physical', 'power',
  'int', 'intelligence', 'magical', 'per', 'tick', 'ticks', 'hit', 'hits',
  'attack', 'attacks',
])

function matchTokens(row: string): string[] {
  return words(row).filter((w) => !MATCH_STOP_WORDS.has(w))
}

function isScalingRow(row: string): boolean {
  const c = compact(row)
  return c.includes('scaling') || c.endsWith('scale') || c.includes('powercontribution')
}

function scalingBucket(row: string, damageType: DamageType): 'str' | 'int' {
  const ws = words(row)
  if (ws.includes('int') || ws.includes('intelligence') || ws.includes('magical')) return 'int'
  if (ws.includes('str') || ws.includes('strength') || ws.includes('physical')) return 'str'
  // Generic "Scaling" rows are usually tied to the ability damage type.
  return damageType === 'magical' ? 'int' : 'str'
}

function isNonDamageMetric(row: string): boolean {
  const c = compact(row)
  const ws = words(row)
  if (isScalingRow(row)) return true
  if (c.includes('tooltip')) return true
  if (c.includes('passive')) return true
  if (c.includes('enhanced')) return true
  if (c.includes('talent') || c.includes('aspect')) return true
  // God-locked / conditional / non-god rows should not be emitted as the base
  // god-vs-god cast damage unless a dedicated handler wires them.
  if (c.includes('acorn')) return true
  if (c.includes('minion') || c.includes('monster') || c.includes('jungle')) return true
  if (c.includes('trigger') || c.includes('proc')) return true
  if (c.includes('redmulti')) return true
  if (c.includes('duration') || c.includes('cooldown') || c === 'cost' || c === 'manacost') return true
  if (c.includes('reduction') || c.includes('reduced') || c.includes('mitigation')) return true
  if (c.includes('amp') || c.includes('escalation') || c.includes('lifetime')) return true
  if (c.includes('contribution') || c.includes('talen') || c.endsWith('rate') || c.endsWith('mod')) return true
  if (c.includes('scalar') || c.includes('multiplier')) return true
  if (c.includes('buff') || c.includes('debuff') || c.includes('threshold')) return true
  if (c.includes('health') || c.includes('heal') || c.includes('shield') || c.includes('lifesteal')) return true
  if (c.includes('slow') || c.includes('stun') || c.includes('root') || c.includes('silence')) return true
  if (c.includes('movement') || c.includes('movespeed') || c.includes('speed') || c.includes('range')) return true
  if (c.includes('protection') || c.includes('protections') || c.includes('protshred')) return true
  if (c.includes('count') || c.includes('stack') || c.includes('radius') || c.includes('level')) return true
  if (c.includes('maxstored')) return true
  if (ws.includes('percent') || row.includes('%')) return true
  return false
}

function descriptionClauses(description: string): string[] {
  return description
    .replace(/\s+/g, ' ')
    .split(/â€¢|\u2022|\./)
    .map((part) => part.trim())
    .filter(Boolean)
}

function isCastOnlyAttackModifierDescription(description: string): boolean {
  return /\bnext\s+\d*\s*basic attack\b|\bnext basic attack\b|\bnext successful attack\b|\byour attacks fire\b|\byour basic attacks\b|\bwhile active, your next\b|\bwhile this ability is active, gain a charge each time you hit an enemy god with a basic attack\b|\bempower(?:ing)? your attacks\b|\bimbue your arrows\b/i.test(description)
}

function descriptionHasDirectCastDamage(description: string): boolean {
  return descriptionClauses(description).some((clause) => {
    if (!/\bdeal(?:s|ing)?\b[\s\S]{0,32}\bdamage\b|\btake\b[\s\S]{0,32}\bdamage\b/i.test(clause)) return false
    if (/\bnext\s+\d*\s*basic attack\b|\bnext basic attack\b|\bnext successful attack\b|\bbasic attacks?\b|\byour attacks\b|\byour basic attacks\b/i.test(clause)) return false
    return true
  })
}

function descriptionImpliesRepeatedDamage(description: string): boolean {
  return descriptionClauses(description).some((clause) => {
    if (!/\bdeal(?:s|ing)?\b[\s\S]{0,32}\bdamage\b|\btake\b[\s\S]{0,32}\bdamage\b/i.test(clause)) return false
    if (/\bnext\s+\d*\s*basic attack\b|\bnext basic attack\b|\bnext successful attack\b|\byour attacks\b|\byour basic attacks\b/i.test(clause)) return false
    return /\bover\s+\d+(?:\.\d+)?\s*(?:s|seconds?)\b|\bevery\s+\d+(?:\.\d+)?\s*(?:s|seconds?)\b|\brepeated(?:ly)?\b|\bcontinually\b|\bcontinues to\b|\bchannel(?:ed|ing)?\b/i.test(clause)
  })
}

function parseDescriptionDelaySeconds(description: string): number | null {
  const flat = description.replace(/\s+/g, ' ').trim()
  const exact =
    /after\s+(\d+(?:\.\d+)?)\s*(?:s|seconds?)\b/i.exec(flat)
    ?? /for\s+(\d+(?:\.\d+)?)\s*(?:s|seconds?)\b[\s\S]{0,48}\bbefore\b[\s\S]{0,24}\bexplode/i.exec(flat)
  if (exact) return Number(exact[1])
  if (/after a short delay|after a delay|after delay/i.test(flat)) return 0.75
  if (/at the end of the effect/i.test(flat)) return 0
  return null
}

function inferInitialDamageDelaySeconds(
  god: GodCatalogEntry,
  slot: AbilitySlot,
  rank: number,
  rv: Record<string, unknown>,
  description: string,
): number {
  const projectileDelay = valueAt(god, slot, firstMatchingRow(rv, ['ProjectileDelay']), rank)
  if (projectileDelay > 0) return projectileDelay
  const parsed = parseDescriptionDelaySeconds(description)
  if (parsed != null) return parsed
  return 0
}

function inferComponentDelaySeconds(
  row: string,
  description: string,
  baseDelaySeconds: number,
  debuffDuration: number,
  hasMultipleDamageRows: boolean,
): number {
  const c = compact(row)
  if (baseDelaySeconds > 0) {
    if (!hasMultipleDamageRows) return baseDelaySeconds
    if (/initial|projectile|hitdamage/i.test(c)) return 0
    if (/explode|explosion|burst|area|small|trail|return|bonus|bramble|final/i.test(c)) return baseDelaySeconds
    return 0
  }
  if (/at the end of the effect/i.test(description) && /burst/i.test(c)) {
    return debuffDuration > 0 ? debuffDuration : 0.75
  }
  return 0
}

function shouldSkipConditionalDamageRow(
  row: string,
  description: string,
  allDamageRows: string[],
): boolean {
  const c = compact(row)
  const flat = description.replace(/\s+/g, ' ').toLowerCase()
  if (c.includes('jealousy') || c.includes('madness') || c.includes('bonusbounce')) return true
  if (c.includes('perbounce')) return true
  if ((c.includes('soulmate') || c.includes('bonusarea')) && flat.includes('soul mate')) return true
  if (c.includes('travel') && flat.includes('if the axe is deployed')) return true
  if (c.includes('punch') && flat.includes("use a charge of genie's strength")) return true
  if (c.includes('rolling') && flat.includes('push the bell')) return true
  if (c.includes('outer') && flat.includes('further away')) return true
  if (c.includes('damagepertick') && flat.includes('if they stay within the outer range')) return true
  if ((c.includes('bonusdamage') || c.includes('bonusbasedamage')) && flat.includes('affected by sickle strike')) return true
  if ((c.includes('bonusdamage') || c.includes('bonusbasedamage')) && /buffdurationpercloud|cloud/i.test(Object.keys(ACTIVE_ROW_SOURCE ?? {}).join(' '))) return true
  if ((c.includes('boarbasic') || c.includes('basicattackdamage')) && flat.includes('continues to charge other gods for its lifetime')) return true
  if (
    c === 'basedamage'
    && allDamageRows.some((candidate) => compact(candidate).includes('projectiledamage'))
    && flat.includes('throw the lamp forward')
    && !/again|another|explod|burst|both/i.test(flat)
  ) {
    return true
  }
  return false
}

function isTickDamageRow(row: string): boolean {
  const c = compact(row)
  return !isScalingRow(row) && (
    c.includes('damagepertick')
    || c.includes('basedamagepertick')
    || c.includes('tickdamage')
    || c.includes('damageperhit')
  )
}

function isDamageBaseRow(row: string): boolean {
  const c = compact(row)
  const ws = words(row)
  if (isNonDamageMetric(row)) return false
  if (c === 'damage' || c === 'basedamage' || c === 'damagebase') return true
  if (c.includes('basedamage') || c.includes('damagebase')) return true
  if (ws.includes('damage')) return true
  // Some multi-strike rows omit the word "damage" but still encode a hit base.
  if (ws.includes('base') && ws.includes('attack')) return true
  return false
}

function bestScalingRow(
  baseRow: string,
  scalingRows: Array<{ row: string; bucket: 'str' | 'int'; tokens: string[] }>,
  bucket: 'str' | 'int',
): string | null {
  const candidates = scalingRows.filter((r) => r.bucket === bucket)
  if (candidates.length === 0) return null

  const baseTokens = matchTokens(baseRow)
  let best: { row: string; score: number; specificity: number } | null = null
  for (const candidate of candidates) {
    let score = 0
    for (const token of baseTokens) {
      if (candidate.tokens.includes(token)) score += 10
    }
    const baseCompact = compact(baseRow)
    const scaleCompact = compact(candidate.row)
    for (const token of baseTokens) {
      if (token.length > 2 && scaleCompact.includes(token) && baseCompact.includes(token)) score += 2
    }
    const specificity = candidate.tokens.length
    if (!best || score > best.score || (score === best.score && specificity > best.specificity)) {
      best = { row: candidate.row, score, specificity }
    }
  }

  if (best && best.score > 0) return best.row

  // Fallback to a global scaling row only when it has no phase tokens.
  const global = candidates.find((r) => r.tokens.length === 0)
  return global?.row ?? null
}

function phaseLabel(row: string): string {
  const tokens = matchTokens(row)
  if (tokens.length === 0) return ''
  return tokens.join(' ')
}

function bestPhaseDurationRow(rows: string[], tickRow: string): string | null {
  const durationRows = rows.filter((row) => /duration/i.test(row))
  if (durationRows.length === 0) return null
  const tickTokens = matchTokens(tickRow)
  if (tickTokens.length === 0) return durationRows[0] ?? null
  let best: { row: string; score: number } | null = null
  for (const row of durationRows) {
    const rowTokens = matchTokens(row)
    let score = 0
    for (const token of tickTokens) {
      if (rowTokens.includes(token)) score += 10
    }
    if (!best || score > best.score) best = { row, score }
  }
  return best?.score ? best.row : null
}

function detectGenericDamageComponents(
  god: GodCatalogEntry,
  slot: AbilitySlot,
  rank: number,
  rv: Record<string, unknown>,
  damageType: DamageType,
  abilityName: string,
  abilityDescription: string,
  ignoredRows: Set<string>,
  overrideHitCount: number | undefined,
): DamagePlan[] {
  const rows = Object.keys(rv)
  const damageRows = rows
    .filter((row) => !ignoredRows.has(row))
    .filter((row) => !row.toLowerCase().includes('bleed'))
    .filter(isDamageBaseRow)

  if (damageRows.length === 0) return []

  const scalingRows = rows
    .filter(isScalingRow)
    .map((row) => ({ row, bucket: scalingBucket(row, damageType), tokens: matchTokens(row) }))

  const hitCountRow = firstRow(rv, ROW_ALIASES.hitCount)
  const hitsFromRow = hitCountRow ? Math.max(1, valueAt(god, slot, hitCountRow, rank)) : 1
  const hasFinalLikeRow = damageRows.some((r) => /\bfinal\b/i.test(r))
  const hasMultipleDamageRows = damageRows.length > 1
  const baseDelaySeconds = inferInitialDamageDelaySeconds(god, slot, rank, rv, abilityDescription)
  const debuffDuration = valueAt(god, slot,
    firstMatchingRow(rv, ['Debuff Duration', 'DebuffDuration', 'Duration']) ?? null, rank)
  const components: DamagePlan[] = []

  for (const row of damageRows) {
    if (shouldSkipConditionalDamageRow(row, abilityDescription, damageRows)) continue
    const base = valueAt(god, slot, row, rank)
    const strScale = valueAt(god, slot, bestScalingRow(row, scalingRows, 'str'), rank)
    const intScale = valueAt(god, slot, bestScalingRow(row, scalingRows, 'int'), rank)
    const isTinyScalarOnlyDamage =
      base > 0 && base <= 1
      && strScale === 0 && intScale === 0
    const isPlaceholder =
      compact(row) === 'damage'
      && base > 0 && base <= 5
      && strScale === 0 && intScale === 0
    const isBuffOnlyBonusDamage =
      compact(row) === 'bonusdamage'
      && strScale === 0
      && intScale === 0
    if (base <= 0 || isTinyScalarOnlyDamage || isPlaceholder || isBuffOnlyBonusDamage) continue

    let hits = hitsFromRow
    if (overrideHitCount) {
      if (damageRows.length === 1) {
        hits = overrideHitCount
      } else if (hasFinalLikeRow) {
        hits = /\bfinal\b/i.test(row) ? 1 : Math.max(1, overrideHitCount - 1)
      } else {
        hits = 1
      }
    }

    const phase = phaseLabel(row)
    components.push({
      kind: 'direct',
      baseDamage: base,
      strScaling: strScale,
      intScaling: intScale,
      hits,
      delaySeconds: inferComponentDelaySeconds(row, abilityDescription, baseDelaySeconds, debuffDuration, hasMultipleDamageRows),
      damageType,
      label: phase ? `${abilityName} (${phase})` : abilityName,
    })
  }

  return components
}

function firstMatchingRow(rankValues: Record<string, unknown>, aliases: readonly string[]): string | null {
  const exact = firstRow(rankValues, aliases)
  if (exact) return exact
  const aliasCompacts = aliases.map(compact)
  return Object.keys(rankValues).find((row) => aliasCompacts.includes(compact(row))) ?? null
}

function addTimedSelfBuffComponents(
  components: AbilityComponent[],
  god: GodCatalogEntry,
  slot: AbilitySlot,
  rank: number,
  rv: Record<string, unknown>,
  abilityName: string,
  damageType: DamageType,
) {
  const genericDurationRow =
    firstRow(rv, ROW_ALIASES.buffDuration)
    ?? firstRow(rv, ['Duration'])
  const durationOverride = BUFF_DURATION_OVERRIDES[`${god.god}.${slot}`]

  const addBuff = (
    row: string | null,
    statKey: string,
    labelSuffix: string,
    durationRow?: string | null,
    transform: (v: number) => number = (v) => v,
  ) => {
    if (!row) return
    const value = transform(valueAt(god, slot, row, rank))
    if (!Number.isFinite(value) || value === 0) return
    const duration = valueAt(god, slot, durationRow ?? genericDurationRow, rank) || durationOverride || 0
    if (duration <= 0) return
    components.push({
      kind: 'self-buff',
      label: `${abilityName} ${labelSuffix}`,
      key: `${slot}_${statKey}_${compact(row)}`,
      durationSeconds: duration,
      modifiers: { [statKey]: value },
    })
  }

  const addDualProtectionBuff = (row: string | null, durationRow?: string | null) => {
    if (!row) return
    const value = valueAt(god, slot, row, rank)
    if (!Number.isFinite(value) || value === 0) return
    const duration = valueAt(god, slot, durationRow ?? genericDurationRow, rank) || durationOverride || 0
    if (duration <= 0) return
    components.push({
      kind: 'self-buff',
      label: `${abilityName} protection buff`,
      key: `${slot}_protections_${compact(row)}`,
      durationSeconds: duration,
      modifiers: { PhysicalProtection: value, MagicalProtection: value },
    })
  }

  addBuff(
    firstMatchingRow(rv, ROW_ALIASES.attackSpeedBuff),
    'AttackSpeedPercent',
    'attack speed buff',
    firstRow(rv, ['Attack Speed Duration', 'Attack Speed Buff Duration']) ?? genericDurationRow,
  )
  addBuff(
    firstMatchingRow(rv, ROW_ALIASES.movementSpeedBuff),
    'MovementSpeed',
    'movement speed buff',
    firstRow(rv, ['Speed Buff Duration', 'MS Buff Duration']) ?? genericDurationRow,
  )
  addDualProtectionBuff(
    firstMatchingRow(rv, ROW_ALIASES.protectionBuff),
    firstRow(rv, ['Protections Duration', 'ProtDuration']) ?? genericDurationRow,
  )
  addBuff(
    firstMatchingRow(rv, ROW_ALIASES.shieldBuff),
    'ShieldHealth',
    'shield',
    firstRow(rv, ['Shield Duration']) ?? genericDurationRow,
  )
  addBuff(
    firstMatchingRow(rv, ROW_ALIASES.basicAttackDamageBuff),
    'InhandPower',
    'basic attack damage buff',
    firstRow(rv, ['Basic Attack Damage Duration', 'Inhand Power Duration']) ?? genericDurationRow,
  )
  addBuff(
    firstMatchingRow(rv, ROW_ALIASES.damageBuff),
    'AbilityDamagePercent',
    'damage buff',
    genericDurationRow,
  )
  const penetrationRow = firstMatchingRow(rv, ROW_ALIASES.penetrationBuff)
  if (penetrationRow) {
    const value = valueAt(god, slot, penetrationRow, rank)
    const duration = valueAt(god, slot, firstRow(rv, ['Duration']) ?? genericDurationRow, rank) || durationOverride || 0
    if (value > 0 && duration > 0) {
      const modifiers: Partial<Record<string, number>> = {}
      const rowWords = words(penetrationRow)
      const physicalOnly = rowWords.includes('physical')
      const magicalOnly = rowWords.includes('magical')
      if (!magicalOnly && (physicalOnly || damageType !== 'magical')) modifiers.PhysicalPenetrationFlat = value
      if (!physicalOnly && (magicalOnly || damageType === 'magical')) modifiers.MagicalPenetrationFlat = value
      if (Object.keys(modifiers).length > 0) {
        components.push({
          kind: 'self-buff',
          label: `${abilityName} penetration buff`,
          key: `${slot}_penetration_${compact(penetrationRow)}`,
          durationSeconds: duration,
          modifiers,
        })
      }
    }
  }

  const pureBonusDamageRow = firstMatchingRow(rv, ['Bonus Damage'])
  const hasBaseDamageRow = Object.keys(rv).some((row) => {
    const c = compact(row)
    return c === 'damage' || c === 'basedamage' || c === 'damagebase' || c.includes('basedamage')
  })
  if (pureBonusDamageRow && !hasBaseDamageRow) {
    const value = valueAt(god, slot, pureBonusDamageRow, rank)
    const duration = valueAt(god, slot, firstRow(rv, ['Duration']) ?? genericDurationRow, rank) || durationOverride || 0
    if (value > 0 && duration > 0) {
      components.push({
        kind: 'self-buff',
        label: `${abilityName} damage buff`,
        key: `${slot}_bonus_damage_${compact(pureBonusDamageRow)}`,
        durationSeconds: duration,
        modifiers: { AbilityDamagePercent: value },
      })
    }
  }

  const castPenBuffDuration = 0
  const magicalPenBonusRow = firstMatchingRow(rv, ['% Magical Penetration Bonus'])
  if (magicalPenBonusRow) {
    const value = valueAt(god, slot, magicalPenBonusRow, rank)
    if (value > 0) {
      components.push({
        kind: 'self-buff',
        label: `${abilityName} magical penetration`,
        key: `${slot}_cast_magical_pen_${compact(magicalPenBonusRow)}`,
        durationSeconds: castPenBuffDuration,
        modifiers: { MagicalPenetrationPercent: value },
        applyBeforeDamage: true,
      })
    }
  }

  const physicalPenBonusRow = firstMatchingRow(rv, ['% Physical Penetration Bonus'])
  if (physicalPenBonusRow) {
    const value = valueAt(god, slot, physicalPenBonusRow, rank)
    if (value > 0) {
      components.push({
        kind: 'self-buff',
        label: `${abilityName} physical penetration`,
        key: `${slot}_cast_physical_pen_${compact(physicalPenBonusRow)}`,
        durationSeconds: castPenBuffDuration,
        modifiers: { PhysicalPenetrationPercent: value },
        applyBeforeDamage: true,
      })
    }
  }
}

function addNextBasicBonusComponents(
  components: AbilityComponent[],
  god: GodCatalogEntry,
  slot: AbilitySlot,
  rank: number,
  rv: Record<string, unknown>,
  damageType: DamageType,
  abilityName: string,
) {
  const damageRow = firstMatchingRow(rv, ROW_ALIASES.nextBasicBuffDamage)
  if (!damageRow) return
  const baseDamage = valueAt(god, slot, damageRow, rank)
  if (baseDamage <= 0) return
  const durationRow = firstRow(rv, ROW_ALIASES.buffDuration) ?? firstRow(rv, ['Duration'])
  const duration = durationRow ? valueAt(god, slot, durationRow, rank) : 0
  const scalingRow = firstMatchingRow(rv, ROW_ALIASES.nextBasicBuffScaling)
  const bucket = scalingRow ? scalingBucket(scalingRow, damageType) : damageType === 'magical' ? 'int' : 'str'
  components.push({
    kind: 'next-basic-bonus',
    label: `${abilityName} next basic bonus`,
    baseDamage,
    strScaling: bucket === 'str' ? valueAt(god, slot, scalingRow, rank) : 0,
    intScaling: bucket === 'int' ? valueAt(god, slot, scalingRow, rank) : 0,
    damageType,
    durationSeconds: duration > 0 ? duration : 5,
  })
}

function extractAspectRankValues(
  rv: Record<string, unknown>,
  damageType: DamageType,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const scaleLabel = damageType === 'magical' ? 'Int Scaling' : 'Strength Scaling'
  const mappings: Array<[RegExp, string]> = [
    [/^TalentCD$/i, 'Cooldown'],
    [/^TalentCooldown$/i, 'Cooldown'],
    [/^TalentDamage$/i, 'Base Damage'],
    [/^Talent Damage$/i, 'Base Damage'],
    [/^Talent Base Damage$/i, 'Base Damage'],
    [/^TalentINTScaling$/i, 'Int Scaling'],
    [/^Talent Int Scaling$/i, 'Int Scaling'],
    [/^TalentIntScaling$/i, 'Int Scaling'],
    [/^TalentSTRBuff$/i, 'Strength Buff'],
    [/^TalentINTBuff$/i, 'Int Buff'],
    [/^TalentSTR$/i, 'Strength Buff'],
    [/^TalentINT$/i, 'Int Buff'],
    [/^TalentScaling$/i, scaleLabel],
    [/^TalentTickDamage$/i, 'Damage Per Tick'],
    [/^TalentTickScaling$/i, scaleLabel],
    [/^Base Damage Talent 1$/i, 'Base Damage'],
    [/^Int Scaling Talent 1$/i, 'Int Scaling'],
    [/^Talent 1 Base Damage$/i, 'Base Damage'],
    [/^Talent 1 Int Scaling$/i, 'Int Scaling'],
    [/^TalentASBuff$/i, 'Attack Speed Buff'],
    [/^TalentAttackSpeed$/i, 'Attack Speed Buff'],
    [/^TalentBuffDuration$/i, 'Buff Duration'],
    [/^TalentInhandPowerBuff$/i, 'InhandPowerBuff'],
    [/^TalentMSBuff$/i, 'MS Buff'],
    [/^TalentMovespeed$/i, 'Movement Speed'],
    [/^Talent Movement Speed$/i, 'Movement Speed'],
    [/^TalentAttackSpeedPerStack$/i, 'Attack Speed Buff'],
    [/^TalentAttackSpeedDuration$/i, 'Attack Speed Duration'],
    [/^Shield Health Talent$/i, 'Shield Health'],
    [/^Shield health Per Level Talent$/i, 'Shield Health Per Level'],
    [/^TalentProjDamage$/i, 'Projectile Damage'],
    [/^TalentProjINTScaling$/i, 'Projectile Int Scaling'],
    [/^TalentProjDamageReturn$/i, 'Return Damage'],
    [/^TalentReturnINTScaling$/i, 'Return Int Scaling'],
    [/^TalentBonus Damage$/i, 'Bonus Damage'],
    [/^TalentBonus Scaling$/i, damageType === 'magical' ? 'Bonus Int Scaling' : 'Bonus Strength Scaling'],
    [/^TalentExplode Damage$/i, 'Explosion Damage'],
    [/^TalentExplode Scaling$/i, damageType === 'magical' ? 'Explosion Int Scaling' : 'Explosion Strength Scaling'],
    [/^TalentExplodeIntScaling$/i, 'Explosion Int Scaling'],
    [/^TalentAbilityMulti$/i, 'Damage Buff'],
    [/^TalentHeal$/i, 'Base Heal'],
    [/^TalentHealingAmount$/i, 'Base Heal'],
    [/^Talent_TargetBaseDamage$/i, 'Base Damage'],
    [/^Talent_TargetStrengthScaling$/i, 'Strength Scaling'],
    [/^Talent_TargetIntelligenceScaling$/i, 'Int Scaling'],
    [/^Talent_AoEBaseDamage$/i, 'Secondary Damage'],
    [/^Talent_AoEStrengthScaling$/i, 'Secondary Strength Scaling'],
    [/^Talent_AoEIntelligenceScaling$/i, 'Secondary Int Scaling'],
    [/^TalentDamage2$/i, 'Secondary Damage'],
    [/^TalentINTScaling2$/i, 'Secondary Int Scaling'],
    [/^TalentIntScaling2$/i, 'Secondary Int Scaling'],
    [/^TalentAttackPowerScaling$/i, 'Secondary Strength Scaling'],
    // Suffix form (e.g. "Damage Talent", "Str Scaling Talent", "Int Scaling Talent")
    // — observed on Artemis, Artio, Cernunnos, Chiron, Nut, Osiris, Pele, Thor
    [/^Damage Talent$/i, 'Base Damage'],
    [/^Base Damage Talent$/i, 'Base Damage'],
    [/^Str Scaling Talent$/i, 'Strength Scaling'],
    [/^Strength Scaling Talent$/i, 'Strength Scaling'],
    [/^Int Scaling Talent$/i, 'Int Scaling'],
    [/^Int Talent Scaling$/i, 'Int Scaling'],
    [/^Intelligence Scaling Talent$/i, 'Int Scaling'],
    [/^Scaling Talent$/i, scaleLabel],
    [/^Slow Talent$/i, 'Slow'],
    [/^Slow Duration Talent$/i, 'Slow Duration'],
    [/^Fuel Talent$/i, 'Fuel'],
    // "Talent Explosion Damage" / "Talent Explosion Int Scaling" (Sol)
    [/^Talent Explosion Damage$/i, 'Explosion Damage'],
    [/^Talent Explosion Int Scaling$/i, 'Explosion Int Scaling'],
    // "TalentDuration" used by The_Morrigan A03 for aspect buff
    [/^TalentDuration$/i, 'Buff Duration'],
    [/^TalentMS$/i, 'Movement Speed'],
    // Generic Talent* prefix fallbacks for any row that matches a canonical pattern
    [/^Talent_?Heal_?Base$/i, 'Base Heal'],
    [/^TalentSlow$/i, 'Slow'],
    [/^TalentSlowDuration$/i, 'Slow Duration'],
    [/^TalentMovementSpeed/i, 'Movement Speed'],
  ]

  for (const [row, curve] of Object.entries(rv)) {
    if (!/talent|aspect/i.test(row)) continue
    const mapped = mappings.find(([pattern]) => pattern.test(row))
    if (!mapped) continue
    out[mapped[1]] = curve
  }
  return out
}

function buildAbilityPlanFromRows(
  god: GodCatalogEntry,
  slot: AbilitySlot,
  rank: number,
  rv: Record<string, unknown>,
  tags: string[],
  abilityName: string,
  abilityDescription: string,
  damageTypeDetected: DamageType,
): AbilityPlan {
  const prevRowSource = ACTIVE_ROW_SOURCE
  ACTIVE_ROW_SOURCE = rv
  const components: AbilityComponent[] = []
  const castOnlyAttackModifier =
    isCastOnlyAttackModifierDescription(abilityDescription) && !descriptionHasDirectCastDamage(abilityDescription)

  const overrideKey = `${god.god}.${slot}`
  const overrideHitCount = HIT_COUNT_OVERRIDES[overrideKey]
  // --- DoT detection ---
  const tickRow = firstRow(rv, ROW_ALIASES.tickDamage)
    ?? (descriptionImpliesRepeatedDamage(abilityDescription) ? firstRow(rv, ROW_ALIASES.baseDamage) : null)
    ?? Object.keys(rv).find((row) => isTickDamageRow(row))
  const tickRateRow = firstRow(rv, ROW_ALIASES.tickRate)
  const dotDurationRow = firstRow(rv, ROW_ALIASES.dotDuration)
    ?? (tickRow ? bestPhaseDurationRow(Object.keys(rv), tickRow) : null)
    ?? Object.keys(rv).find((row) => /duration/i.test(row) && /(dot|over time|total|overall)/i.test(row))
  if (!castOnlyAttackModifier && tickRow && dotDurationRow) {
    const tickDamage = valueAt(god, slot, tickRow, rank)
    const tickRateFromRow = valueAt(god, slot, tickRateRow, rank)
    const duration = valueAt(god, slot, dotDurationRow, rank) || 2
    let tickRate = tickRateFromRow || 1
    let ticks = overrideHitCount ?? Math.max(1, Math.round(duration / tickRate))
    let dotDelaySeconds: number | undefined
    if (overrideHitCount != null) {
      if (tickRateFromRow > 0) {
        const intervals = duration / tickRateFromRow
        if (Math.abs(intervals - (overrideHitCount - 1)) <= 0.05) {
          ticks = overrideHitCount
          tickRate = tickRateFromRow
          dotDelaySeconds = 0
        } else if (Math.abs(intervals - overrideHitCount) <= 0.05) {
          ticks = overrideHitCount
          tickRate = tickRateFromRow
        }
      } else if (duration > 0) {
        ticks = overrideHitCount
        tickRate = duration / overrideHitCount
      }
    }
    const scalingRows = Object.keys(rv)
      .filter(isScalingRow)
      .map((row) => ({ row, bucket: scalingBucket(row, damageTypeDetected), tokens: matchTokens(row) }))
    const strScale = valueAt(god, slot, bestScalingRow(tickRow, scalingRows, 'str'), rank)
    const intScale = valueAt(god, slot, bestScalingRow(tickRow, scalingRows, 'int'), rank)
    components.push({
      kind: 'dot',
      baseDamage: tickDamage,
      strScaling: strScale,
      intScaling: intScale,
      hits: 1,
      ticks,
      tickRate,
      duration,
      delaySeconds: dotDelaySeconds,
      damageType: damageTypeDetected,
      label: `${abilityName} (DoT)`,
    })
  } else {
    // --- Multi-phase detection: collect phase components by prefix ---
      const phaseComponents = detectGenericDamageComponents(
        god,
        slot,
        rank,
        rv,
        damageTypeDetected,
        abilityName,
        abilityDescription,
        new Set(),
        overrideHitCount,
      )
      const fallbackPhaseComponents = phaseComponents.length > 0
        ? phaseComponents
        : detectPhaseComponents(god, slot, rank, rv, damageTypeDetected, abilityName)
      if (!castOnlyAttackModifier && fallbackPhaseComponents.length > 0) {
        components.push(...fallbackPhaseComponents)
      } else if (!castOnlyAttackModifier) {
      // --- Direct damage (single or multi-hit via override/row) ---
      const baseRow = firstRow(rv, ROW_ALIASES.baseDamage)
      if (baseRow) {
        const base = valueAt(god, slot, baseRow, rank)
        const strScale = valueAt(god, slot, firstRow(rv, ROW_ALIASES.strScaling), rank)
        const intScale = valueAt(god, slot, firstRow(rv, ROW_ALIASES.intScaling), rank)
        // Placeholder detection: many utility/buff abilities have a bare "Damage"
        // row set to a small constant (e.g. 5) with no scaling row. That's not
        // real damage — skip it.
        const isPlaceholder =
          baseRow === 'Damage' &&
          base > 0 && base <= 5 &&
          strScale === 0 && intScale === 0
        const isBuffOnlyBonusDamage =
          compact(baseRow) === 'bonusdamage'
          && strScale === 0
          && intScale === 0
        if (base > 0 && !isPlaceholder && !isBuffOnlyBonusDamage) {
          const hitCountRow = firstRow(rv, ROW_ALIASES.hitCount)
          const hitsFromRow = hitCountRow ? Math.max(1, valueAt(god, slot, hitCountRow, rank)) : 1
          const hits = overrideHitCount ?? hitsFromRow
            components.push({
              kind: 'direct',
              baseDamage: base,
              strScaling: strScale,
              intScaling: intScale,
              hits,
              damageType: damageTypeDetected,
              label: abilityName,
            })
          }
        }
    }
  }

  // DoT abilities can also have an initial impact or detonation row. The older
  // resolver skipped those because DoT detection was exclusive.
  if (tickRow && dotDurationRow) {
      const impactComponents = detectGenericDamageComponents(
        god,
        slot,
        rank,
        rv,
        damageTypeDetected,
        abilityName,
        abilityDescription,
        new Set([tickRow]),
        overrideHitCount,
      )
    if (!castOnlyAttackModifier && impactComponents.length > 0) {
      components.push(...impactComponents)
    }
  }

  // --- Bleed detection (exists in parallel with direct/DoT on some abilities) ---
  const bleedRow = firstRow(rv, ROW_ALIASES.bleedDamage)
  if (!castOnlyAttackModifier && bleedRow) {
    const bleedBase = valueAt(god, slot, bleedRow, rank)
    if (bleedBase > 0) {
      const bleedStr = valueAt(god, slot, firstRow(rv, ROW_ALIASES.bleedStrScaling), rank)
      const bleedInt = valueAt(god, slot, firstRow(rv, ROW_ALIASES.bleedIntScaling), rank)
      // SMITE 2 convention: bleeds tick 5 times over ~5 seconds
      components.push({
        kind: 'bleed',
        baseDamage: bleedBase,
        strScaling: bleedStr,
        intScaling: bleedInt,
        hits: 1,
        ticks: 5,
        tickRate: 1,
        duration: 5,
        damageType: 'physical',
        label: `${abilityName} (bleed)`,
      })
    }
  }

  // --- Self-buff detection (Strength/Int Buff) ---
  const strBuffRow = firstRow(rv, ROW_ALIASES.strengthBuff)
  const intBuffRow = firstRow(rv, ROW_ALIASES.intelligenceBuff)
  const buffDurRow = firstRow(rv, ROW_ALIASES.buffDuration)
  if ((strBuffRow || intBuffRow) && buffDurRow) {
    const strBuff = valueAt(god, slot, strBuffRow, rank)
    const intBuff = valueAt(god, slot, intBuffRow, rank)
    const duration = valueAt(god, slot, buffDurRow, rank) || 4
    if (strBuff > 0 || intBuff > 0) {
      const modifiers: Partial<Record<string, number>> = {}
      if (strBuff) modifiers.adaptiveStrength = strBuff
      if (intBuff) modifiers.adaptiveIntelligence = intBuff
      components.push({
        kind: 'self-buff',
        label: `${abilityName} buff`,
        key: `${slot}_selfBuff`,
        durationSeconds: duration,
        modifiers,
      })
    }
  }

  addTimedSelfBuffComponents(components, god, slot, rank, rv, abilityName, damageTypeDetected)
  addNextBasicBonusComponents(components, god, slot, rank, rv, damageTypeDetected, abilityName)

  // --- Stun (informational only, no damage) ---
  const stunRow = firstRow(rv, ROW_ALIASES.stunDuration)
  if (stunRow) {
    const stun = valueAt(god, slot, stunRow, rank)
    if (stun > 0) {
      components.push({
        kind: 'cc',
        label: `${abilityName} stun`,
        durationSeconds: stun,
        flavor: 'stun',
      })
    }
  }

  // --- Heal (tracked for completeness) ---
  const healBaseRow = firstRow(rv, ROW_ALIASES.healBase)
  if (healBaseRow) {
    const heal = valueAt(god, slot, healBaseRow, rank)
    if (heal > 0) {
      components.push({
        kind: 'heal',
        label: `${abilityName} heal`,
        baseHeal: heal,
        strScaling: 0,
        intScaling: 0,
        missingHealthHealPercent: valueAt(god, slot, firstRow(rv, ROW_ALIASES.healMissingHealth), rank),
      })
    }
  }

  const damageAmpRow = firstMatchingRow(rv, ['Damage Amp', 'DamageAmp', 'Jealousy Damage Amp'])
  if (damageAmpRow) {
    const damageAmp = valueAt(god, slot, damageAmpRow, rank)
    const duration = valueAt(god, slot, firstMatchingRow(rv, ['Debuff Duration', 'Jealousy Duration']) ?? buffDurRow, rank) || 4
    if (damageAmp > 0 && duration > 0) {
      components.push({
        kind: 'enemy-debuff',
        label: `${abilityName} damage amp`,
        key: `${slot}_damage_amp`,
        durationSeconds: duration,
        modifiers: { DamageTakenFromSourcePercent: damageAmp },
      })
    }
  }

  const debuffDuration =
    valueAt(
      god,
      slot,
      firstMatchingRow(rv, [
        'Debuff Duration',
        'DebuffDuration',
        'Protections Debuff Duration',
        'ProtDuration',
        'Duration',
      ]),
      rank,
    ) || DEBUFF_DURATION_OVERRIDES[`${god.god}.${slot}`] || 0

  const pushEnemyDebuff = (
    label: string,
    key: string,
    modifiers: Partial<Record<string, number>>,
    extras?: Pick<EnemyDebuffPlan, 'addStacks' | 'stacksMax' | 'applyOnEachDamageHit'>,
  ) => {
    if (debuffDuration <= 0 || Object.keys(modifiers).length === 0) return
    components.push({
      kind: 'enemy-debuff',
      label,
      key,
      durationSeconds: debuffDuration,
      modifiers,
      addStacks: extras?.addStacks,
      stacksMax: extras?.stacksMax,
      applyOnEachDamageHit: extras?.applyOnEachDamageHit,
    })
  }

  const physProtDebuffRow = firstMatchingRow(rv, [
    'PhysProtDebuff',
    'Physical Protection Debuff',
    'Physical Protection Reduction',
    'Protection Reduction',
    'Prot Reduction',
    'ProtDebuffPerStack',
  ])
  if (physProtDebuffRow) {
    const rawValue = valueAt(god, slot, physProtDebuffRow, rank)
    const value = Math.abs(rawValue)
    if (value > 0) {
      const perStack = /per\s*stack/i.test(physProtDebuffRow) || compact(physProtDebuffRow).includes('perstack')
      const normalizedRow = compact(physProtDebuffRow)
      const affectsBothProtections = normalizedRow === 'protectionreduction' || normalizedRow === 'protreduction'
      pushEnemyDebuff(
        affectsBothProtections ? `${abilityName} protections debuff` : `${abilityName} physical protection debuff`,
        `${slot}_physical_protection_debuff_${compact(physProtDebuffRow)}`,
        affectsBothProtections
          ? { PhysicalProtection: -value, MagicalProtection: -value }
          : { PhysicalProtection: -value },
        perStack ? {
          addStacks: 1,
          stacksMax: overrideHitCount ?? Math.max(1, valueAt(god, slot, firstMatchingRow(rv, ROW_ALIASES.hitCount), rank) || 1),
          applyOnEachDamageHit: true,
        } : undefined,
      )
    }
  }

  const magicalProtDebuffRow = firstMatchingRow(rv, ['MagicalProtDebuff', 'MagProtDebuff', 'Magic Protections Debuff', 'Magical Protection Debuff'])
  if (magicalProtDebuffRow) {
    const value = Math.abs(valueAt(god, slot, magicalProtDebuffRow, rank))
    if (value > 0) {
      pushEnemyDebuff(
        `${abilityName} magical protection debuff`,
        `${slot}_magical_protection_debuff_${compact(magicalProtDebuffRow)}`,
        { MagicalProtection: -value },
      )
    }
  }

  const allProtDebuffRow = firstMatchingRow(rv, ['ProtectionDebuff', 'ProtectionsDebuff'])
  if (allProtDebuffRow) {
    const value = Math.abs(valueAt(god, slot, allProtDebuffRow, rank))
    if (value > 0) {
      pushEnemyDebuff(
        `${abilityName} protections debuff`,
        `${slot}_protections_debuff_${compact(allProtDebuffRow)}`,
        { PhysicalProtection: -value, MagicalProtection: -value },
      )
    }
  }

  const allProtDebuffPctRow = firstMatchingRow(rv, ['Protection Debuff Percent'])
  if (allProtDebuffPctRow) {
    const value = valueAt(god, slot, allProtDebuffPctRow, rank)
    if (value > 0) {
      pushEnemyDebuff(
        `${abilityName} protections percent debuff`,
        `${slot}_protections_percent_debuff_${compact(allProtDebuffPctRow)}`,
        { PhysicalProtectionPercent: -value, MagicalProtectionPercent: -value },
      )
    }
  }

  const manaCost = valueAt(god, slot, firstRow(rv, ROW_ALIASES.manaCost), rank)
  const cooldownSeconds = valueAt(god, slot, firstRow(rv, ROW_ALIASES.cooldown), rank) || defaultCooldown(slot)

  const plan = {
    slot,
    abilityName,
    rank,
    components,
    manaCost,
    cooldownSeconds,
    tags,
  }
  ACTIVE_ROW_SOURCE = prevRowSource
  return plan
}

export function buildAbilityPlan(
  god: GodCatalogEntry,
  slot: AbilitySlot,
  rank: number,
  options?: BuildAbilityPlanOptions,
): AbilityPlan | null {
  const ability = god.abilities[slot]
  if (!ability) return null
  const rv = abilityRankValues(god, slot) ?? {}
  const tags = ability.scalingTags ?? []
  const damageTypeDetected: DamageType =
    ability.damageType ?? (tags.includes('Physical') ? 'physical' : tags.includes('Magical') ? 'magical' : 'physical')
  const abilityName = ability.name ?? `${slot}`

  const basePlan = buildAbilityPlanFromRows(
    god,
    slot,
    rank,
    rv,
    tags,
    abilityName,
    ability.description ?? '',
    damageTypeDetected,
  )
  if (!options?.aspectActive) return basePlan

  const aspectRv = {
    ...extractAspectRankValues(rv, damageTypeDetected),
    ...getAspectAbilityRows(god.god, slot),
  }
  if (Object.keys(aspectRv).length === 0) return basePlan
  for (const rowName of [
    ...ROW_ALIASES.tickRate,
    ...ROW_ALIASES.dotDuration,
    ...ROW_ALIASES.buffDuration,
    ...ROW_ALIASES.hitCount,
    ...ROW_ALIASES.manaCost,
  ]) {
    if (!(rowName in aspectRv) && rowName in rv) aspectRv[rowName] = rv[rowName]
  }

  const aspectPlan = buildAbilityPlanFromRows(
    god,
    slot,
    rank,
    aspectRv,
    tags,
    `${abilityName} (aspect)`,
    ability.description ?? '',
    damageTypeDetected,
  )
  return {
    ...basePlan,
    components: [...basePlan.components, ...aspectPlan.components],
    cooldownSeconds: aspectPlan.cooldownSeconds || basePlan.cooldownSeconds,
  }
}

/** Default cooldown when the ability has no Cooldown row (rare). */
function defaultCooldown(slot: AbilitySlot): number {
  return slot === 'A04' ? 90 : 12
}

/**
 * Detect multi-phase abilities (Initial+Final, Cripple+Heavy, Flurry+Final, etc.)
 * and emit one DamagePlan component per phase. Ignores "Passive" prefixes since
 * those are god-passive helper rows, not the ability's direct damage.
 */
function detectPhaseComponents(
  god: GodCatalogEntry,
  slot: AbilitySlot,
  rank: number,
  rv: Record<string, unknown>,
  damageType: DamageType,
  abilityName: string,
): DamagePlan[] {
  const rows = Object.keys(rv)

  // Skip passive-prefix rows (they're passive-proc helpers)
  const isPassiveRow = (r: string) => r.startsWith('Passive ') || r === 'Passive'

  // Find phases: match both "<Prefix> Base Damage"/"<Prefix> Damage" (spaced)
  // and "<Prefix>Damage" (mashed — Ares pattern: "InitialDamage", "StunDamage").
  const phaseData: Array<{ prefix: string; base: number; strScale: number; intScale: number }> = []
  for (const prefix of PHASE_PREFIXES) {
    // Collect rows belonging to this phase: either prefixed with "<Prefix> " or "<Prefix>" (no-space)
    const prefixRows = rows.filter(
      (r) => (r.startsWith(prefix + ' ') || r.startsWith(prefix) && !/^Passive/.test(r))
        && !isPassiveRow(r)
        && r !== prefix,
    )
    if (prefixRows.length === 0) continue
    const baseRow =
      prefixRows.find((r) =>
        r === `${prefix} Base Damage` || r === `${prefix} Damage` || r === `${prefix}Damage`)
      ?? prefixRows.find((r) => /(^|\s)Damage$|Base Damage$/.test(r))
    if (!baseRow) continue
    const base = valueAt(god, slot, baseRow, rank)
    if (base <= 0) continue
    // Scaling rows: match BOTH spaced and mashed variants.
    // We deliberately avoid generic `/Scaling$/` because that would catch the
    // Int-scaling row as the Str-scaling row.
    const strScale = valueAt(god, slot,
      prefixRows.find((r) =>
        /Str Scaling$|STR Scaling$|Strength Scaling$|Physical Power Scaling$|Physical Scaling$|StrScaling$|STRScaling$|DamageScaling$/i.test(r)
        && !/Int/i.test(r),
      ) ?? null,
      rank)
    const intScale = valueAt(god, slot,
      prefixRows.find((r) =>
        /Int Scaling$|INT Scaling$|Magical Power Scaling$|Magical Scaling$|IntScaling$|INTScaling$|DamageIntScaling$/i.test(r),
      ) ?? null,
      rank)
    phaseData.push({ prefix, base, strScale, intScale })
  }

  if (phaseData.length === 0) return []

  // Build DamagePlan per phase
  return phaseData.map((phase) => ({
    kind: 'direct' as const,
    baseDamage: phase.base,
    strScaling: phase.strScale,
    intScaling: phase.intScale,
    hits: 1,
    damageType,
    label: `${abilityName} (${phase.prefix.toLowerCase()})`,
  }))
}
