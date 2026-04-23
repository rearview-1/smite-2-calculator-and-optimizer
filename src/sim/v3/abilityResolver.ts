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

import { abilityRowAt, type GodCatalogEntry } from '../../catalog/loadCatalogs.ts'
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
  damageType: DamageType
  label: string
}

export interface BuffPlan {
  kind: 'self-buff'
  label: string
  key: string
  durationSeconds: number
  modifiers: Partial<Record<string, number>>
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

export interface NextBasicBonusPlan {
  kind: 'next-basic-bonus'
  label: string
  baseDamage: number
  strScaling: number
  intScaling: number
  damageType: DamageType
  durationSeconds: number
}

export type AbilityComponent = DamagePlan | BuffPlan | CCPlan | HealPlan | NextBasicBonusPlan

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
  tickDamage: ['Damage Per Tick', 'Base Damage Per Tick', 'Tick Damage', 'TickDamage'],
  tickRate: ['Tick Rate', 'Dot Tick Rate', 'TickTime', 'Tick Timing'],
  dotDuration: ['Damage Over Time Duration', 'DoT Duration', 'Total Duration'],
  bleedDamage: ['Bleed Damage'],
  bleedStrScaling: ['Bleed Str Scaling'],
  bleedIntScaling: ['Bleed Int Scaling'],
  stunDuration: ['Stun Duration', 'StunDuration'],
  strengthBuff: ['Strength Buff'],
  intelligenceBuff: ['Intelligence Buff', 'Int Buff'],
  buffDuration: ['Buff Duration', 'BuffDuration', 'BaseDuration', 'Attack Speed Buff Duration', 'Attack Speed Duration', 'ShieldDuration'],
  manaCost: ['Mana Cost', 'Cost'],
  cooldown: ['Cooldown', 'Base Cooldown', 'TalentCooldown', 'TalentCD'],
  healBase: ['Heal Base', 'Base Heal', 'Base Healing', 'Healing Base', 'Heal Amount'],
  healMissingHealth: ['% Missing Health Heal', 'Missing Health Heal Percent', 'MissingHealthHeal'],
  hitCount: ['Hit Count', 'Hits', 'Number of Hits', 'Attack Count', 'AttackCount'],
  movementSpeedBuff: ['Movement Speed', 'Movement Speed Buff', 'Passive Movement Speed Buff', 'Speed Strength', 'Speed Buff', 'MS Buff', 'MSBuff', 'Movespeed'],
  attackSpeedBuff: ['Attack Speed', 'Attack Speed Buff', 'Attack Speed Bonus', 'AS Buff', 'Attack Speed Weak'],
  protectionBuff: ['Protection', 'Protections', 'Bonus Protections', 'Protections Buff', 'SelfProtBuff', 'AllyProtBuff', 'AladdinProtections'],
  shieldBuff: ['Shield Value', 'Shield Health', 'ShieldBuff'],
  damageBuff: ['Damage Buff', 'Damage Increased Buff'],
  basicAttackDamageBuff: ['BasicAttackDmg', 'Basic Attack Damage', 'InhandPowerBuff'],
  nextBasicBuffDamage: ['BuffDamage'],
  nextBasicBuffScaling: ['BuffScaling'],
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
  'Hades.A04': 8,          // Pillar of Agony (tooltip confirms 8)
  'Hecate.A04': 3,         // Open the Gates (tooltip confirms 3)
  'Fenrir.A03': 4,         // Brutalize (tooltip confirms 4)
  'Khepri.A02': 11,        // Rising Dawn (tooltip confirms 11)
  'Kukulkan.A03': 6,       // Whirlwind (tooltip confirms 6)
  'Mordred.A04': 10,       // Heart Slash channel
  'Neith.A04': 6,          // World Weaver channel
  'Poseidon.A03': 6,       // Whirlpool (tooltip confirms 6)
  'Sol.A01': 6,            // Radiance (repeating)
  'Ymir.A04': 8,           // Shards of Ice channel
  'Zeus.A04': 10,          // Lightning Storm channel
  'Artio.A03': 5,          // Life Tap channel
  'Artemis.A01': 6,        // Transgressor's Fate — hits 6 (cripple+5)
  'Athena.A04': 4,         // Defender of Olympus channel
  'Chiron.A02': 5,         // Masterful Shot flurry (tooltip "hit 5")
  'Danzaburou.A04': 5,     // Uproarious Rocket channel
  'Thor.A03': 6,           // Berserker Barrage hits
  'Loki.A03': 6,           // Flurry Strike (tooltip)
}

/** Local-GE-derived buff durations that are not exposed as rank rows. */
const BUFF_DURATION_OVERRIDES: Record<string, number> = {
  'Rama.A02': 6,           // GE_Rama_A02_AttackSpeed lifetime
}

function firstRow(rankValues: Record<string, unknown> | null, names: readonly string[]): string | null {
  if (!rankValues) return null
  for (const n of names) {
    if (n in rankValues) return n
  }
  return null
}

function valueAt(god: GodCatalogEntry, slot: AbilitySlot, rowName: string | null, rank: number): number {
  if (!rowName) return 0
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
  if (c.includes('passive')) return true
  if (c.includes('enhanced')) return true
  if (c.includes('talent') || c.includes('aspect')) return true
  if (c.includes('duration') || c.includes('cooldown') || c === 'cost' || c === 'manacost') return true
  if (c.includes('reduction') || c.includes('reduced') || c.includes('mitigation')) return true
  if (c.includes('buff') || c.includes('debuff') || c.includes('threshold')) return true
  if (c.includes('health') || c.includes('heal') || c.includes('shield') || c.includes('lifesteal')) return true
  if (c.includes('slow') || c.includes('stun') || c.includes('root') || c.includes('silence')) return true
  if (c.includes('movement') || c.includes('movespeed') || c.includes('speed') || c.includes('range')) return true
  if (c.includes('protection') || c.includes('protections') || c.includes('protshred')) return true
  if (c.includes('count') || c.includes('stack') || c.includes('radius') || c.includes('level')) return true
  if (ws.includes('percent') || row.includes('%')) return true
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

function detectGenericDamageComponents(
  god: GodCatalogEntry,
  slot: AbilitySlot,
  rank: number,
  rv: Record<string, unknown>,
  damageType: DamageType,
  abilityName: string,
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
  const components: DamagePlan[] = []

  for (const row of damageRows) {
    const base = valueAt(god, slot, row, rank)
    const strScale = valueAt(god, slot, bestScalingRow(row, scalingRows, 'str'), rank)
    const intScale = valueAt(god, slot, bestScalingRow(row, scalingRows, 'int'), rank)
    const isPlaceholder =
      compact(row) === 'damage'
      && base > 0 && base <= 5
      && strScale === 0 && intScale === 0
    if (base <= 0 || isPlaceholder) continue

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
    'DamageMultiplier',
    'damage buff',
    genericDurationRow,
  )
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

export function buildAbilityPlan(god: GodCatalogEntry, slot: AbilitySlot, rank: number): AbilityPlan | null {
  const ability = god.abilities[slot]
  if (!ability) return null
  const rv = ability.rankValues ?? {}
  const tags = ability.scalingTags ?? []

  const damageTypeDetected: DamageType =
    ability.damageType ?? (tags.includes('Physical') ? 'physical' : tags.includes('Magical') ? 'magical' : 'physical')

  const components: AbilityComponent[] = []

  const overrideKey = `${god.god}.${slot}`
  const overrideHitCount = HIT_COUNT_OVERRIDES[overrideKey]
  // --- DoT detection ---
  const tickRow = firstRow(rv, ROW_ALIASES.tickDamage)
    ?? Object.keys(rv).find((row) => isTickDamageRow(row))
  const tickRateRow = firstRow(rv, ROW_ALIASES.tickRate)
  const dotDurationRow = firstRow(rv, ROW_ALIASES.dotDuration)
    ?? Object.keys(rv).find((row) => /duration/i.test(row) && /(dot|over time|total|overall)/i.test(row))
  if (tickRow && tickRateRow && dotDurationRow) {
    const tickDamage = valueAt(god, slot, tickRow, rank)
    const tickRate = valueAt(god, slot, tickRateRow, rank) || 0.5
    const duration = valueAt(god, slot, dotDurationRow, rank) || 2
    const ticks = Math.max(1, Math.round(duration / tickRate))
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
      damageType: damageTypeDetected,
      label: `${ability.name} (DoT)`,
    })
  } else {
    // --- Multi-phase detection: collect phase components by prefix ---
    const phaseComponents = detectGenericDamageComponents(
      god,
      slot,
      rank,
      rv,
      damageTypeDetected,
      ability.name ?? slot,
      new Set(),
      overrideHitCount,
    )
    const fallbackPhaseComponents = phaseComponents.length > 0
      ? phaseComponents
      : detectPhaseComponents(god, slot, rank, rv, damageTypeDetected, ability.name ?? slot)
    if (fallbackPhaseComponents.length > 0) {
      components.push(...fallbackPhaseComponents)
    } else {
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
        if (base > 0 && !isPlaceholder) {
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
            label: ability.name ?? `${slot}`,
          })
        }
      }
    }
  }

  // DoT abilities can also have an initial impact or detonation row. The older
  // resolver skipped those because DoT detection was exclusive.
  if (tickRow && tickRateRow && dotDurationRow) {
    const impactComponents = detectGenericDamageComponents(
      god,
      slot,
      rank,
      rv,
      damageTypeDetected,
      ability.name ?? slot,
      new Set([tickRow]),
      overrideHitCount,
    )
    if (impactComponents.length > 0) {
      components.push(...impactComponents)
    }
  }

  // --- Bleed detection (exists in parallel with direct/DoT on some abilities) ---
  const bleedRow = firstRow(rv, ROW_ALIASES.bleedDamage)
  if (bleedRow) {
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
        label: `${ability.name} (bleed)`,
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
        label: `${ability.name} buff`,
        key: `${slot}_selfBuff`,
        durationSeconds: duration,
        modifiers,
      })
    }
  }

  addTimedSelfBuffComponents(components, god, slot, rank, rv, ability.name ?? `${slot}`)
  addNextBasicBonusComponents(components, god, slot, rank, rv, damageTypeDetected, ability.name ?? `${slot}`)

  // --- Stun (informational only, no damage) ---
  const stunRow = firstRow(rv, ROW_ALIASES.stunDuration)
  if (stunRow) {
    const stun = valueAt(god, slot, stunRow, rank)
    if (stun > 0) {
      components.push({
        kind: 'cc',
        label: `${ability.name} stun`,
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
        label: `${ability.name} heal`,
        baseHeal: heal,
        strScaling: 0,
        intScaling: 0,
        missingHealthHealPercent: valueAt(god, slot, firstRow(rv, ROW_ALIASES.healMissingHealth), rank),
      })
    }
  }

  const manaCost = valueAt(god, slot, firstRow(rv, ROW_ALIASES.manaCost), rank)
  const cooldownSeconds = valueAt(god, slot, firstRow(rv, ROW_ALIASES.cooldown), rank) || defaultCooldown(slot)

  return {
    slot,
    abilityName: ability.name ?? `${slot}`,
    rank,
    components,
    manaCost,
    cooldownSeconds,
    tags,
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
        /Str Scaling$|Strength Scaling$|Physical Power Scaling$|Physical Scaling$|StrScaling$|DamageScaling$/.test(r)
        && !/Int/i.test(r),
      ) ?? null,
      rank)
    const intScale = valueAt(god, slot,
      prefixRows.find((r) =>
        /Int Scaling$|Magical Power Scaling$|Magical Scaling$|IntScaling$|DamageIntScaling$/.test(r),
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
