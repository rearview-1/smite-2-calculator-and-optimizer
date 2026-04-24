#!/usr/bin/env tsx

import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { abilityRowAt, getAbilityTiming, loadGods } from '../src/catalog/loadCatalogs.ts'
import { HIT_COUNT_OVERRIDES } from '../src/sim/v3/abilityResolver.ts'
import { runScenario, snapshotAttacker } from '../src/sim/v3/engine.ts'
import type { AbilitySlot, Scenario, SimResult } from '../src/sim/v3/types.ts'
import { getAuthoredAbilityDescription } from './lib/authoredAbilityDescriptions.ts'

type Snapshot = ReturnType<typeof snapshotAttacker>

type IssueKind =
  | 'damage-not-modeled'
  | 'explicit-hit-count-mismatch'
  | 'row-tick-count-mismatch'
  | 'single-hit-mismatch'
  | 'initial-plus-ticks-mismatch'
  | 'uniform-pre-mismatch'
  | 'timing-mismatch'

type ExpectedModel = {
  kind: 'single' | 'uniformTicks' | 'initialPlusTicks'
  expectedHits: number
  expectedPreSeries: number[]
  expectedTimes: number[]
  notes: string[]
  strictness: 'exact' | 'assumed'
}

type AbilityAudit = {
  godId: string
  god: string
  slot: AbilitySlot
  abilityName: string | null
  description: string | null
  damageType: string | null
  rows: Record<string, number>
  actual: {
    hitCount: number
    preSeries: number[]
    timeSeries: number[]
    labels: string[]
    totalPre: number
  }
  expected: ExpectedModel | null
  issues: Array<{ kind: IssueKind; detail: string }>
}

const OUT_PATH = path.resolve('data/ability-numeric-audit.json')
const RANK = 5
const RANKS = { A01: 5, A02: 5, A03: 5, A04: 5 }
const SLOTS: AbilitySlot[] = ['A01', 'A02', 'A03', 'A04']

function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, ' ').trim()
}

function explicitHitCount(description: string): number | null {
  const flat = normalizeDescription(description)
  const clauses = flat
    .split(/•|\u2022|\n|\.(?:\s|$)/)
    .map((part) => part.trim())
    .filter(Boolean)
  const patterns = [
    /^(?:ability|this ability|damage|damage over time|dot)\s+hits?\s+(\d+)\s+times\b/i,
    /^hits?\s+(\d+)\s+times\b/i,
    /\b(?:fire|fires|firing)\s+(\d+)\s+(?:projectiles?|acorns?|shots?|shards?)\b/i,
  ]
  for (const clause of clauses) {
    for (const pattern of patterns) {
      const match = pattern.exec(clause)
      if (!match) continue
      const count = Number(match[1])
      if (Number.isFinite(count) && count > 1) return count
    }
    if (/\b(?:strike|strikes)\s+twice\b/i.test(clause)) return 2
  }
  return null
}

function explicitRowHitCount(godId: string, slot: AbilitySlot): number | null {
  const rowNames = ['Hit Count', 'Hits', 'Number of Hits', 'Attack Count']
  for (const rowName of rowNames) {
    const value = row(godId, slot, [rowName])
    if (value != null && value > 1) return Math.round(value)
  }
  const override = HIT_COUNT_OVERRIDES[`${godId}.${slot}`]
  return override && override > 1 ? override : null
}

function descriptionImpliesDamage(description: string): boolean {
  const clean = normalizeDescription(description)
  if (!clean) return false
  return clean
    .split(/â€¢|\u2022|\./)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some((clause) => {
      if (!/\bdeal(?:s|ing)?\b[\s\S]{0,32}\bdamage\b|\btake\b[\s\S]{0,32}\bdamage\b/i.test(clause)) return false
      if (/\bnext basic\b|\bnext attack\b|\bnext ability\b|\byour attacks\b|\byour basic attacks\b|\bwhile your basic attacks\b|\byou also deal bonus damage to\b/i.test(clause)) return false
      if (/\bif\b|\bwhen\b|\bwhile\b|\bwithin a whirlwind\b|\bwithin the field\b|\bon statues\b|\bthistlethorn acorn\b/i.test(clause)) return false
      return true
    })
}

function descriptionHasDirectCastDamage(description: string): boolean {
  const clean = normalizeDescription(description)
  if (!clean) return false
  if (!/\bdeal(?:s|ing)?\b[\s\S]{0,32}\bdamage\b|\btake\b[\s\S]{0,32}\bdamage\b/i.test(clean)) return false
  if (/\bnext\s+\d*\s*basic attack\b|\bnext basic attack\b|\bnext successful attack\b|\bbasic attacks?\b|\byour attacks\b|\byour basic attacks\b|\bwhile your basic attacks\b/i.test(clean)) return false
  return true
}

function isCastOnlyAttackModifier(description: string): boolean {
  return /\bnext\s+\d*\s*basic attack\b|\bnext basic attack\b|\bnext successful attack\b|\byour attacks fire\b|\byour basic attacks\b|\bwhile your basic attacks\b|\byour basic attacks deal\b|\bwhile active, your next\b|\bempower(?:ing)? your attacks\b|\bimbue your arrows\b/i.test(description)
}

function descriptionImpliesMultiPhaseDamage(description: string): boolean {
  const clean = normalizeDescription(description)
  return /\breduced damage\b|\boverlap\b|\bsmall bubbles?\b|\bbonus\b|\bfinal hit\b|\bpillar\b|\bburst\b|\bricochet\b|\bbounce(?:s|d)?\b|\breturn(?:s|ing)?\b|\bprojectiles?\b|\btrail\b|\bsolar rays\b|\bradiates further\b|\bvortex(?:es|ed|ing)?\b|\bslam\b|\bdragon\b|\bbeams?\b|\bdash\b|\bcollaps(?:e|es|ed|ing)\b|\bcontinually\b|\bbleed\b|\bpuls(?:e|es|ing)\b/i.test(clean)
}

function descriptionHasConditionalSecondaryDamage(description: string): boolean {
  const clean = normalizeDescription(description)
  return /\bas they move\b|\bif the same enemy is hit twice\b|\bwhile buffed\b|\bafter firing\b|\bon cancel(?:ing)?\b|\bif a chained enemy reaches\b|\bnear the paolao\b|\bleaves a bramble area\b|\bif the projectile hits a clay soldier\b|\bif you have a shield from raven shout\b|\benemy gods and jungle bosses debuffed explode\b|\bthistlethorn acorn\b/i.test(clean)
}

function descriptionImpliesRepeatedDamage(description: string): boolean {
  const clean = normalizeDescription(description)
  return /\brepeated(?:ly)?\b|\bover time\b|\bevery\s+\d+(?:\.\d+)?\s*(?:s|seconds?)\b|\bchannel(?:ed|ing)?\b/i.test(clean)
}

function requiresBaseSecondaryDamage(description: string): boolean {
  const clean = normalizeDescription(description)
  if (descriptionHasConditionalSecondaryDamage(clean)) return false
  const explosionMatch = /\bexplod(?:e|es|ing)\b/.exec(clean)
  const damageBeforeExplosion = explosionMatch
    ? /\bdeal(?:s|ing)?\b[\s\S]{0,32}\bdamage\b|\btake\b[\s\S]{0,32}\bdamage\b/i.test(clean.slice(0, explosionMatch.index))
    : false
  return /\bbefore breaking into\b|\bthen explod(?:e|es|ing)\b|\bexplosion leaves\b|\bboth the explosion and the retraction deal\b|\bburst of damage at the end of the effect\b|\bdealing magical damage again\b|\bdealing physical damage again\b|\bcollapse(?:s|ing)? in on itself dealing\b/i.test(clean)
    || (damageBeforeExplosion && /\bexplodes\b[\s\S]{0,24}\bdealing\b/i.test(clean))
}

function descriptionHasReducedSubsequentHits(description: string): boolean {
  return /\bsubsequent hits deal reduced damage\b|\breduced damage by\b/i.test(normalizeDescription(description))
}

function isPlaceholderDamageRow(base: number, strScaling: number | null, intScaling: number | null): boolean {
  return base > 0 && base <= 5 && (strScaling ?? 0) === 0 && (intScaling ?? 0) === 0
}

function parseDescriptionEverySeconds(description: string): number | null {
  const match = /\bevery\s+(\d+(?:\.\d+)?)\s*(?:s|seconds?)\b/i.exec(normalizeDescription(description))
  return match ? Number(match[1]) : null
}

function parseDescriptionDurationSeconds(description: string): number | null {
  const match = /\bover\s+(\d+(?:\.\d+)?)\s*(?:s|seconds?)\b|\bfor\s+(\d+(?:\.\d+)?)\s*(?:s|seconds?)\b/i.exec(normalizeDescription(description))
  if (!match) return null
  return Number(match[1] ?? match[2])
}

function parseDescriptionDelaySeconds(description: string): number | null {
  const clean = normalizeDescription(description)
  const exact =
    /after\s+(\d+(?:\.\d+)?)\s*(?:s|seconds?)\b/i.exec(clean)
    ?? /for\s+(\d+(?:\.\d+)?)\s*(?:s|seconds?)\b[\s\S]{0,48}\bbefore\b[\s\S]{0,24}\bexplode/i.exec(clean)
  if (exact) return Number(exact[1])
  if (/after a short delay|after a delay/i.test(clean)) return 0.75
  if (/at the end of the effect/i.test(clean)) return 0
  return null
}

function buildScenario(godId: string, slot: AbilitySlot): Scenario {
  return {
    title: `${godId} ${slot} numeric audit`,
    attacker: { godId, level: 20, abilityRanks: RANKS, items: [] },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot, label: slot }],
  }
}

function damageEventsForAbility(result: SimResult, slot: AbilitySlot, abilityName: string | null): SimResult['damageEvents'] {
  const normalizedAbilityName = (abilityName ?? slot).trim().toLowerCase()
  const labelPriority = (label: string): number => {
    const lower = label.toLowerCase()
    if (/\((final|small|bramble|vortex|slam|burst|collapse|dragon|bonus|area|explode|explosion|pillar)\b/.test(lower)) return 2
    if (/\((projectile|hit\b|beam\b|dash\b|pulse\b|tick\b)/.test(lower)) return 1
    return 0
  }
  return result.damageEvents.filter((event) => {
    if (event.source !== 'ability' && event.source !== 'dot') return false
    const label = event.label.trim().toLowerCase()
    return label === slot.toLowerCase()
      || label.startsWith(`${slot.toLowerCase()} `)
      || label.startsWith(normalizedAbilityName)
  }).sort((a, b) => {
    if (a.t !== b.t) return a.t - b.t
    const priorityDelta = labelPriority(a.label) - labelPriority(b.label)
    if (priorityDelta !== 0) return priorityDelta
    return b.preMitigation - a.preMitigation
  })
}

function row(
  godId: string,
  slot: AbilitySlot,
  names: string[],
): number | null {
  const god = loadGods()[godId]!
  for (const name of names) {
    const value = abilityRowAt(god, slot, name, RANK)
    if (value != null) return value
  }
  return null
}

function allRelevantRows(godId: string, slot: AbilitySlot): Record<string, number> {
  const god = loadGods()[godId]!
  const rows = god.abilities[slot]?.rankValues
  const out: Record<string, number> = {}
  if (!rows) return out
  for (const key of Object.keys(rows)) {
    if (!/damage|scaling|duration|tick|count|projectile|rings|hits|spins/i.test(key)) continue
    const value = abilityRowAt(god, slot, key, RANK)
    if (value != null) out[key] = value
  }
  return out
}

function computePre(
  godId: string,
  slot: AbilitySlot,
  damageType: 'physical' | 'magical' | 'true' | null,
  snapshot: Snapshot,
  mode: 'main' | 'initial',
): number | null {
  const baseNames = mode === 'initial'
    ? ['Base Damage Initial', 'Initial Damage']
    : ['Projectile Damage', 'Base Damage', 'Damage', 'Dash Damage', 'Damage Per Tick']
  const base = row(godId, slot, baseNames)
  if (base == null) return null

  const strength = snapshot?.adaptiveStrength ?? 0
  const intelligence = snapshot?.adaptiveIntelligence ?? 0
  let total = base

  const strSpecific = mode === 'initial'
    ? row(godId, slot, ['Physical Power Scaling Initial', 'Strength Scaling Initial', 'STR Scaling Initial'])
    : row(godId, slot, ['Physical Power Scaling', 'Strength Scaling', 'STR Scaling', 'STRScaling', 'Dash Scaling', 'STR Scaling Damage'])
  const intSpecific = mode === 'initial'
    ? row(godId, slot, ['Magical Power Scaling Initial', 'Int Scaling Initial', 'INT Scaling Initial', 'Initial Scaling'])
    : row(godId, slot, ['Magical Power Scaling', 'Int Scaling', 'INT Scaling', 'Int Scaling Per Tick', 'INT Scaling Damage'])

  if (isPlaceholderDamageRow(base, strSpecific, intSpecific)) return null

  if (strSpecific != null) total += strength * strSpecific
  if (intSpecific != null) total += intelligence * intSpecific

  const genericScaling = mode === 'initial'
    ? row(godId, slot, ['Scaling Initial'])
    : row(godId, slot, ['Scaling'])
  if (genericScaling != null) {
    if (damageType === 'physical') total += strength * genericScaling
    else if (damageType === 'magical') total += intelligence * genericScaling
  }

  return total
}

function deriveExpectedModel(
  godId: string,
  slot: AbilitySlot,
  damageType: 'physical' | 'magical' | 'true' | null,
  description: string,
  snapshot: Snapshot,
): ExpectedModel | null {
  if (godId === 'Discordia' && slot === 'A01') {
    const projectilePre = computePre(godId, slot, damageType, snapshot, 'main')
    const areaBase = row(godId, slot, ['AreaDamage'])
    const areaScaling = row(godId, slot, ['AreaINTScaling']) ?? 0
    if (projectilePre != null && areaBase != null) {
      return {
        kind: 'uniformTicks',
        expectedHits: 2,
        expectedPreSeries: [
          projectilePre,
          areaBase + (snapshot?.adaptiveIntelligence ?? 0) * areaScaling,
        ],
        expectedTimes: [0, 0],
        notes: ['direct projectile plus local AreaDamage row', 'authored long tooltip excludes minor projectile damage on area-hit targets'],
        strictness: 'exact',
      }
    }
  }

  if (godId === 'Discordia' && slot === 'A04') {
    const initialBase = row(godId, slot, ['Damage'])
    const initialScaling = row(godId, slot, ['INTScaling']) ?? 0
    const burstBase = row(godId, slot, ['BurstDamage'])
    const burstScaling = row(godId, slot, ['BurstINTScaling']) ?? 0
    const duration = row(godId, slot, ['DebuffDuration']) ?? 0
    if (initialBase != null && burstBase != null) {
      return {
        kind: 'uniformTicks',
        expectedHits: 2,
        expectedPreSeries: [
          initialBase + (snapshot?.adaptiveIntelligence ?? 0) * initialScaling,
          burstBase + (snapshot?.adaptiveIntelligence ?? 0) * burstScaling,
        ],
        expectedTimes: [0, Number(duration.toFixed(4))],
        notes: ['projectile damage plus delayed BurstDamage row from local DebuffDuration'],
        strictness: 'exact',
      }
    }
  }

  if (godId === 'Merlin' && slot === 'A04') {
    const mainPre = computePre(godId, slot, damageType, snapshot, 'main')
    if (mainPre != null) {
      return {
        kind: 'uniformTicks',
        expectedHits: 2,
        expectedPreSeries: [mainPre, mainPre],
        expectedTimes: [0, 0.35],
        notes: ['separate local retraction damage asset present; collapse delay remains hand-authored'],
        strictness: 'assumed',
      }
    }
  }

  const castOnlyAttackModifier =
    isCastOnlyAttackModifier(description) && !descriptionHasDirectCastDamage(description)
  if (castOnlyAttackModifier) return null
  const conditionalSecondaryDamage = descriptionHasConditionalSecondaryDamage(description)

  const tickRate = row(godId, slot, ['Tick Rate'])
    ?? row(godId, slot, ['Tick Duration'])
    ?? row(godId, slot, ['Dot Tick Rate'])
  const descriptionTickRate = parseDescriptionEverySeconds(description)
  const descriptionDuration = parseDescriptionDurationSeconds(description)
  const explicitHits = explicitHitCount(description)
  const mainPre = computePre(godId, slot, damageType, snapshot, 'main')
  const initialPre = computePre(godId, slot, damageType, snapshot, 'initial')
  const timing = getAbilityTiming(godId, slot)
  const tickDuration =
    row(godId, slot, ['Damage Over Time Duration', 'DoT Duration', 'Dot Duration', 'Total Duration', 'Rain Duration'])
    ?? ((row(godId, slot, ['TickDamage']) != null) ? row(godId, slot, ['Slow Duration', 'SlowDuration']) : null)
    ?? ((tickRate != null || (initialPre != null && mainPre != null && timing.shape === 'channel') || descriptionImpliesRepeatedDamage(description))
      ? row(godId, slot, ['Duration', 'Debuff Duration'])
      : null)
  const repeatedTickHits =
    explicitHits
    ?? ((tickDuration != null && tickRate == null) ? explicitRowHitCount(godId, slot) : null)
  const rowHitCount =
    tickDuration != null
      ? null
      : explicitRowHitCount(godId, slot)

  const tickBase = row(godId, slot, ['TickDamage', 'Damage Per Tick'])
  const tickPre = tickBase != null
    ? (() => {
        const strength = snapshot?.adaptiveStrength ?? 0
        const intelligence = snapshot?.adaptiveIntelligence ?? 0
        const tickStrScaling = row(godId, slot, ['Tick Strength Scaling', 'Str Scaling Per Tick', 'Bleed Str Scaling'])
        const tickIntScaling = row(godId, slot, ['Tick INT Scaling', 'Int Scaling Per Tick', 'Damage Per Tick Int Scaling', 'Bleed Int Scaling'])
        return tickBase + strength * (tickStrScaling ?? 0) + intelligence * (tickIntScaling ?? 0)
      })()
    : null

  const hasDirectBaseRow = row(godId, slot, ['Projectile Damage', 'Base Damage', 'Damage', 'Dash Damage']) != null
  if (!conditionalSecondaryDamage && hasDirectBaseRow && mainPre != null && tickPre != null && tickDuration != null) {
    const interval =
      tickRate
      ?? descriptionTickRate
      ?? (row(godId, slot, ['TickDamage']) != null && row(godId, slot, ['Slow Duration', 'SlowDuration']) != null ? 1 : timing.hitInterval)
    const hits = Math.max(1, Math.round(tickDuration / interval))
    return {
      kind: 'initialPlusTicks',
      expectedHits: 1 + hits,
      expectedPreSeries: [mainPre, ...Array.from({ length: hits }, () => tickPre)],
      expectedTimes: [0, ...Array.from({ length: hits }, (_, i) => Number(((i + 1) * interval).toFixed(4)))],
      notes: ['initial hit plus local TickDamage rows'],
      strictness: 'assumed',
    }
  }

  if (!conditionalSecondaryDamage && initialPre != null && mainPre != null && tickDuration != null) {
    const interval = tickRate ?? descriptionTickRate ?? timing.hitInterval
    const hits = Math.max(1, Math.round(tickDuration / interval))
    return {
      kind: 'initialPlusTicks',
      expectedHits: 1 + hits,
      expectedPreSeries: [initialPre, ...Array.from({ length: hits }, () => mainPre)],
      expectedTimes: [0, ...Array.from({ length: hits }, (_, i) => Number(((i + 1) * interval).toFixed(4)))],
      notes: [
        tickRate != null ? 'tick cadence from local Tick Rate row' : 'tick cadence from local timing fallback',
      ],
      strictness: tickRate != null ? 'exact' : 'assumed',
    }
  }

  if (!conditionalSecondaryDamage && mainPre != null && tickDuration != null) {
    let interval =
      tickRate
      ?? descriptionTickRate
      ?? (row(godId, slot, ['Damage Per Tick', 'TickDamage']) != null && row(godId, slot, ['Debuff Duration', 'Slow Duration', 'SlowDuration']) != null ? 1 : timing.hitInterval)
    let hits = Math.max(1, Math.round(tickDuration / interval))
    let firstTickTime = interval
    if (repeatedTickHits != null) {
      if (tickRate != null && Math.abs(tickDuration / tickRate - (repeatedTickHits - 1)) <= 0.05) {
        interval = tickRate
        hits = repeatedTickHits
        firstTickTime = 0
      } else {
        interval = tickRate ?? (tickDuration / repeatedTickHits)
        hits = repeatedTickHits
        firstTickTime = interval
      }
    }
    return {
      kind: 'uniformTicks',
      expectedHits: hits,
      expectedPreSeries: Array.from({ length: hits }, () => mainPre),
      expectedTimes: Array.from({ length: hits }, (_, i) => Number((firstTickTime + i * interval).toFixed(4))),
      notes: [
        repeatedTickHits != null
          ? 'tick cadence from local rows / overrides'
          : tickRate != null ? 'tick cadence from local Tick Rate row' : 'tick cadence from local timing fallback',
      ],
      strictness: repeatedTickHits != null || tickRate != null ? 'exact' : 'assumed',
    }
  }

  const repeatedHits = rowHitCount ?? explicitHits
  const finalBase = row(godId, slot, ['Base Damage Final', 'Final Base Damage'])
  const finalPre = finalBase != null
    ? (() => {
        const strength = snapshot?.adaptiveStrength ?? 0
        const intelligence = snapshot?.adaptiveIntelligence ?? 0
        const finalStr = row(godId, slot, ['Physical Power Scaling Final', 'Strength Scaling Final', 'STR Scaling Final']) ?? 0
        const finalInt = row(godId, slot, ['Magical Power Scaling Final', 'Int Scaling Final', 'INT Scaling Final']) ?? 0
        return finalBase + strength * finalStr + intelligence * finalInt
      })()
    : null
  if (!conditionalSecondaryDamage && mainPre != null && finalPre != null && repeatedHits != null && repeatedHits > 1) {
    const interval =
      descriptionTickRate
      ?? (timing.shape === 'channel' ? timing.hitInterval : 0)
    return {
      kind: 'uniformTicks',
      expectedHits: repeatedHits,
      expectedPreSeries: [...Array.from({ length: repeatedHits - 1 }, () => mainPre), finalPre],
      expectedTimes: interval > 0
        ? Array.from({ length: repeatedHits }, (_, i) => Number((((timing.shape === 'channel' ? i + 1 : i) * interval)).toFixed(4)))
        : Array.from({ length: repeatedHits }, () => 0),
      notes: ['final-hit rows from local data'],
      strictness: 'assumed',
    }
  }
  if (!conditionalSecondaryDamage && mainPre != null && repeatedHits != null && repeatedHits > 1) {
    const interval =
      descriptionTickRate
      ?? (timing.shape === 'channel' ? timing.hitInterval : 0)
    const reductionPerExtraHit = row(godId, slot, ['DamageRedMulti'])
    const expectedPreSeries = reductionPerExtraHit != null
      ? Array.from({ length: repeatedHits }, (_, i) => Number((mainPre * Math.max(0.2, 1 - reductionPerExtraHit * i)).toFixed(4)))
      : Array.from({ length: repeatedHits }, () => mainPre)
    return {
      kind: 'uniformTicks',
      expectedHits: repeatedHits,
      expectedPreSeries,
      expectedTimes: interval > 0
        ? Array.from({ length: repeatedHits }, (_, i) => Number((((timing.shape === 'channel' ? i + 1 : i) * interval)).toFixed(4)))
        : Array.from({ length: repeatedHits }, () => 0),
      notes: rowHitCount != null
        ? ['hit count from local rows / overrides']
        : ['hit count from local description wording'],
      strictness: rowHitCount != null && (descriptionTickRate != null || interval === 0) ? 'exact' : 'assumed',
    }
  }

  if (!conditionalSecondaryDamage && mainPre != null && requiresBaseSecondaryDamage(description)) {
    const secondaryDelay = parseDescriptionDelaySeconds(description) ?? 0
    return {
      kind: 'uniformTicks',
      expectedHits: 2,
      expectedPreSeries: [mainPre, mainPre],
      expectedTimes: [0, Number(secondaryDelay.toFixed(4))],
      notes: ['primary hit plus same-formula secondary damage from authored description'],
      strictness: 'exact',
    }
  }

  if (mainPre != null && descriptionHasDirectCastDamage(description)) {
    return {
      kind: 'single',
      expectedHits: 1,
      expectedPreSeries: [mainPre],
      expectedTimes: [0],
      notes: ['single-hit formula from local rows'],
      strictness: 'exact',
    }
  }

  if (mainPre != null && descriptionDuration == null && descriptionTickRate == null && rowHitCount == null && explicitHits == null) {
    return {
      kind: 'single',
      expectedHits: 1,
      expectedPreSeries: [mainPre],
      expectedTimes: [0],
      notes: ['single-hit fallback from local rows'],
      strictness: 'assumed',
    }
  }

  return null
}

function close(actual: number, expected: number, tolerance = 0.05): boolean {
  return Math.abs(actual - expected) <= tolerance
}

function auditAbility(godId: string, slot: AbilitySlot): AbilityAudit {
  const gods = loadGods()
  const god = gods[godId]!
  const ability = god.abilities[slot]
  const scenario = buildScenario(godId, slot)
  const result = runScenario(scenario)
  const snapshot = snapshotAttacker(scenario)
  const authored = getAuthoredAbilityDescription(godId, slot)
  const description = authored.combined ?? ability?.description ?? ''
  const actualEvents = damageEventsForAbility(result, slot, ability?.name ?? slot)
  const actualMultiPhase = actualEvents.some((ev) => /\((tick|final|small|bramble|vortex|slam|burst|collapse|dragon|bonus|area|explode|explosion|pillar)\b/i.test(ev.label))
  const actualPreSeries = actualEvents.map((ev) => Number(ev.preMitigation.toFixed(4)))
  const actualTimeSeries = actualEvents.map((ev) => Number(ev.t.toFixed(4)))
  const expected = deriveExpectedModel(godId, slot, ability?.damageType ?? null, description, snapshot)
  const issues: AbilityAudit['issues'] = []
  const multiPhaseDescription = descriptionImpliesMultiPhaseDamage(description) || descriptionHasConditionalSecondaryDamage(description) || actualMultiPhase
  const reducedSubsequentHits = descriptionHasReducedSubsequentHits(description)

  if (descriptionImpliesDamage(description) && actualEvents.length === 0 && !isCastOnlyAttackModifier(description)) {
    issues.push({ kind: 'damage-not-modeled', detail: 'description implies direct damage but no ability/dot events were emitted' })
  }

  const explicitHits = explicitHitCount(description)
  if (explicitHits != null && actualEvents.length !== explicitHits && expected?.kind !== 'initialPlusTicks') {
    issues.push({ kind: 'explicit-hit-count-mismatch', detail: `description suggests ${explicitHits} hits, got ${actualEvents.length}` })
  }

  if (expected) {
    if (expected.kind === 'single' && actualEvents.length !== 1 && !multiPhaseDescription) {
      issues.push({ kind: 'single-hit-mismatch', detail: `expected 1 event from local rows, got ${actualEvents.length}` })
    }
    if (expected.kind === 'uniformTicks' && actualEvents.length !== expected.expectedHits) {
      issues.push({ kind: 'row-tick-count-mismatch', detail: `expected ${expected.expectedHits} hits from local rows, got ${actualEvents.length}` })
    }
    if (expected.kind === 'initialPlusTicks' && actualEvents.length !== expected.expectedHits) {
      issues.push({ kind: 'initial-plus-ticks-mismatch', detail: `expected ${expected.expectedHits} total events from local rows, got ${actualEvents.length}` })
    }

    const comparableCount = Math.min(actualPreSeries.length, expected.expectedPreSeries.length)
    for (let i = 0; i < comparableCount; i += 1) {
      if (expected.kind === 'single' && multiPhaseDescription) break
      if (reducedSubsequentHits && i > 0) break
      if (!close(actualPreSeries[i]!, expected.expectedPreSeries[i]!)) {
        issues.push({
          kind: 'uniform-pre-mismatch',
          detail: `hit ${i + 1}: expected pre ${expected.expectedPreSeries[i]}, got ${actualPreSeries[i]}`,
        })
        break
      }
    }

    const shouldCheckTiming =
      expected.expectedTimes.length > 1
      && actualTimeSeries.length >= expected.expectedTimes.length
      && (expected.strictness === 'exact' || expected.notes.some((note) => /Tick Rate|description/i.test(note)))
      && !reducedSubsequentHits
    if (shouldCheckTiming) {
      for (let i = 0; i < expected.expectedTimes.length; i += 1) {
        if (!close(actualTimeSeries[i]!, expected.expectedTimes[i]!, 0.051)) {
          issues.push({
            kind: 'timing-mismatch',
            detail: `event ${i + 1}: expected t=${expected.expectedTimes[i]}, got ${actualTimeSeries[i]}`,
          })
          break
        }
      }
    }
  }

  return {
    godId,
    god: god.god,
    slot,
    abilityName: ability?.name ?? null,
    description: ability?.description ?? null,
    damageType: ability?.damageType ?? null,
    rows: allRelevantRows(godId, slot),
    actual: {
      hitCount: actualEvents.length,
      preSeries: actualPreSeries,
      timeSeries: actualTimeSeries,
      labels: actualEvents.map((ev) => ev.label),
      totalPre: Number(actualPreSeries.reduce((sum, value) => sum + value, 0).toFixed(4)),
    },
    expected,
    issues,
  }
}

function main() {
  const gods = loadGods()
  const audits: AbilityAudit[] = []
  const issueCounts = new Map<IssueKind, number>()
  let exactCoverage = 0
  let assumedCoverage = 0
  let uncovered = 0

  for (const [godId] of Object.entries(gods).sort((a, b) => a[1].god.localeCompare(b[1].god))) {
    for (const slot of SLOTS) {
      const audit = auditAbility(godId, slot)
      audits.push(audit)
      if (audit.expected?.strictness === 'exact') exactCoverage += 1
      else if (audit.expected?.strictness === 'assumed') assumedCoverage += 1
      else uncovered += 1
      for (const issue of audit.issues) {
        issueCounts.set(issue.kind, (issueCounts.get(issue.kind) ?? 0) + 1)
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalGods: Object.keys(gods).length,
      totalAbilities: audits.length,
      exactCoverage,
      assumedCoverage,
      uncovered,
      totalIssues: audits.reduce((sum, audit) => sum + audit.issues.length, 0),
      topIssues: [...issueCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([kind, count]) => ({ kind, count })),
      topAbilitiesByIssues: audits
        .filter((audit) => audit.issues.length > 0)
        .sort((a, b) => b.issues.length - a.issues.length)
        .slice(0, 50)
        .map((audit) => ({
          godId: audit.godId,
          god: audit.god,
          slot: audit.slot,
          abilityName: audit.abilityName,
          issueCount: audit.issues.length,
        })),
    },
    audits,
  }

  writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`[audit-ability-numerics] wrote ${OUT_PATH}`)
  console.log(`[audit-ability-numerics] abilities=${audits.length} exact=${exactCoverage} assumed=${assumedCoverage} uncovered=${uncovered} issues=${report.summary.totalIssues}`)
  for (const issue of [...issueCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  issue ${issue[0]}: ${issue[1]}`)
  }
}

main()
