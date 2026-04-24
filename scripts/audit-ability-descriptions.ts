#!/usr/bin/env tsx

import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { loadGods } from '../src/catalog/loadCatalogs.ts'
import { buildAbilityPlan } from '../src/sim/v3/abilityResolver.ts'
import { runScenario } from '../src/sim/v3/engine.ts'
import { getGodHandler } from '../src/sim/v3/godHandlers.ts'
import type { AbilitySlot, Scenario } from '../src/sim/v3/types.ts'
import { getAuthoredAbilityDescription } from './lib/authoredAbilityDescriptions.ts'

type IssueType =
  | 'explicit-hit-count-mismatch'
  | 'row-hit-count-mismatch'
  | 'damage-falloff-not-modeled'
  | 'damage-not-modeled'
  | 'delayed-damage-not-timed'
  | 'secondary-damage-not-modeled'
  | 'enemy-debuff-not-emitted'

type AbilityIssue = {
  godId: string
  slot: AbilitySlot
  abilityName: string | null
  issue: IssueType
  description: string
  rows: string[]
  handler: boolean
  authoredKeys?: string[]
  expected?: number
  actual?: number
  eventLabels: string[]
  preMitigationSeries: number[]
  delayedEventLabels: string[]
}

const OUT_PATH = path.resolve('data/ability-description-audit.json')
const slots: AbilitySlot[] = ['A01', 'A02', 'A03', 'A04']
const ranks = { A01: 5, A02: 5, A03: 5, A04: 5 }

function explicitHitCount(description: string): number | null {
  const flat = description.replace(/\s+/g, ' ').trim()
  const clauses = flat
    .split(/•|\u2022|\n|\.(?:\s|$)/)
    .map((part) => part.trim())
    .filter(Boolean)
  const patterns = [
    /^(?:ability|this ability|damage|damage over time|dot)\s+hits?\s+(\d+)\s+times\b/i,
    /^hits?\s+(\d+)\s+times\b/i,
    /\b(?:fire|fires|firing)\s+(\d+)\s+(?:projectiles?|acorns?|shots?)\b/i,
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

function rowHitCount(rankValues: Record<string, unknown> | null | undefined): number | null {
  if (!rankValues) return null
  const allowed = new Set(['hitcount', 'hits', 'numberofhits', 'attackcount'])
  for (const [rowName, value] of Object.entries(rankValues)) {
    const normalized = rowName.toLowerCase().replace(/[^a-z]/g, '')
    if (!allowed.has(normalized)) continue
    const curve = value as { keys?: Array<{ v?: number }> }
    const count = curve?.keys?.at(-1)?.v
    if (typeof count === 'number' && Number.isFinite(count) && count > 1) return count
  }
  return null
}

function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, ' ').trim()
}

function descriptionClauses(description: string): string[] {
  return description
    .split(/•|\u2022|\./)
    .map((part) => part.trim())
    .filter(Boolean)
}

function descriptionImpliesDamage(description: string): boolean {
  return descriptionClauses(description).some((clause) => {
    if (!/\bdeal(?:s|ing)?\b[\s\S]{0,32}\bdamage\b|\btake\b[\s\S]{0,32}\bdamage\b/i.test(clause)) return false
    if (/\bnext ability\b|\bnext basic\b|\byour attacks\b|\byour basic attacks\b|\bwhile your basic attacks\b|\byou also deal bonus damage to\b/i.test(clause)) return false
    if (/\bif\b|\bwhen\b|\bwhile\b|\bwithin a whirlwind\b|\bon statues\b|\bthistlethorn acorn\b/i.test(clause)) return false
    return true
  })
}

function isCastOnlyAttackModifier(description: string): boolean {
  return /\bnext\s+\d*\s*basic attack\b|\bnext basic attack\b|\bnext 3 basic attacks\b|\bempower(?:ing)? your attacks\b|\bempowering your attacks as\b|\bimbue your arrows\b|\byour attacks fire\b|\bwhile your basic attacks\b|\byour basic attacks deal\b|\bgain increased critical strike chance while this ability is active\b/i.test(description)
}

function hasExplicitDamageDelay(description: string): boolean {
  if (hasConditionalOnlySecondaryDamage(description)) return false
  if (/\bcan be refired\b|\breactivate this ability\b/i.test(description) && !/\bautomatically refires\b/i.test(description)) return false
  return /after\s+\d+(?:\.\d+)?\s*(?:s|seconds?)\b|after a short delay|after a delay|for\s+\d+(?:\.\d+)?\s*(?:s|seconds?)\b[\s\S]{0,48}\bbefore\b[\s\S]{0,24}\bexplode|at the end of the effect/i.test(description)
}

function hasConditionalOnlySecondaryDamage(description: string): boolean {
  return /\bthistlethorn acorn\b|\bon statues\b|\bif the projectile hits a clay soldier\b|\bif you have a shield from raven shout\b|\benemy gods and jungle bosses debuffed explode\b/i.test(description)
}

function requiresBaseSecondaryDamage(description: string): boolean {
  if (hasConditionalOnlySecondaryDamage(description)) return false
  const normalized = normalizeDescription(description)
  const explosionMatch = /\bexplod(?:e|es|ing)\b/.exec(normalized)
  const damageBeforeExplosion = explosionMatch
    ? /\bdeal(?:s|ing)?\b[\s\S]{0,32}\bdamage\b|\btake\b[\s\S]{0,32}\bdamage\b/i.test(normalized.slice(0, explosionMatch.index))
    : false
  return /\bbefore breaking into\b|\bthen explod(?:e|es|ing)\b|\bexplosion leaves\b|\bboth the explosion and the retraction deal\b|\bburst of damage at the end of the effect\b|\bdealing magical damage again\b|\bdealing physical damage again\b|\bcollapse(?:s|ing)? in on itself dealing\b/i.test(normalized)
    || (damageBeforeExplosion && /\bexplodes\b[\s\S]{0,24}\bdealing\b/i.test(normalized))
}

function buildScenario(godId: string, slot: AbilitySlot, label: string | null): Scenario {
  return {
    title: 'ability description audit',
    attacker: { godId, level: 20, abilityRanks: ranks, items: [] },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot, label: label ?? slot }],
  }
}

function issuePush(
  issues: AbilityIssue[],
  base: Omit<AbilityIssue, 'issue'>,
  issue: IssueType,
) {
  issues.push({ ...base, issue })
}

const issues: AbilityIssue[] = []
for (const [godId, god] of Object.entries(loadGods())) {
  for (const slot of slots) {
    const ability = god.abilities?.[slot]
    const authored = getAuthoredAbilityDescription(godId, slot)
    const description = normalizeDescription(authored.combined ?? ability?.description ?? '')
    if (!ability || !description) continue

    const handler = Boolean(getGodHandler(godId, slot))
    const result = runScenario(buildScenario(godId, slot, ability.name ?? slot))
    const plan = buildAbilityPlan(god, slot, 5)
    const damageEvents = result.damageEvents.filter((ev) => ev.source === 'ability' || ev.source === 'dot')
    const preMitigationSeries = damageEvents.map((ev) => Number(ev.preMitigation.toFixed(4)))
    const delayedEventLabels = damageEvents.filter((ev) => ev.t > 0.05).map((ev) => ev.label)
    const hasTimedDamage = delayedEventLabels.length > 0
    const hasSecondaryDamage = damageEvents.length >= 2 || (plan?.components ?? []).some((component) => component.kind === 'dot' || component.kind === 'bleed')
    const base = {
      godId,
      slot,
      abilityName: ability.name ?? null,
      description,
      rows: Object.keys(ability.rankValues ?? {}),
      handler,
      authoredKeys: authored.keys,
      eventLabels: damageEvents.map((ev) => ev.label),
      preMitigationSeries,
      delayedEventLabels,
    }

    const expectedFromDescription = explicitHitCount(description)
    if (expectedFromDescription && damageEvents.length !== expectedFromDescription) {
      issuePush(issues, { ...base, expected: expectedFromDescription, actual: damageEvents.length }, 'explicit-hit-count-mismatch')
    }

    const expectedFromRows = rowHitCount(ability.rankValues)
    if (expectedFromRows && damageEvents.length !== expectedFromRows) {
      issuePush(issues, { ...base, expected: expectedFromRows, actual: damageEvents.length }, 'row-hit-count-mismatch')
    }

    if (descriptionImpliesDamage(description) && damageEvents.length === 0 && !isCastOnlyAttackModifier(description)) {
      issuePush(issues, base, 'damage-not-modeled')
    }

    const hasDamageFalloffRow = Object.keys(ability.rankValues ?? {}).some((row) => /DamageRedMulti/i.test(row))
    const hasDescendingPreMit = preMitigationSeries.length > 1
      && preMitigationSeries.some((value, index) => index > 0 && value < preMitigationSeries[index - 1] - 0.001)
    if (hasDamageFalloffRow && !hasDescendingPreMit) {
      issuePush(issues, base, 'damage-falloff-not-modeled')
    }

    if (hasExplicitDamageDelay(description) && damageEvents.length > 0 && !hasTimedDamage) {
      issuePush(issues, base, 'delayed-damage-not-timed')
    }

    if (requiresBaseSecondaryDamage(description) && damageEvents.length > 0 && !hasSecondaryDamage) {
      issuePush(issues, base, 'secondary-damage-not-modeled')
    }

    const mentionsEnemyDebuff =
      /\breducing their\b|\btake more damage from you\b|\bdebuff(?:ing)? enemies\b/i.test(description)
    const emitsEnemyDebuff =
      result.events.some((event) => event.kind === 'buff-apply' && event.target === 'enemy')
      || (plan?.components ?? []).some((component) => component.kind === 'enemy-debuff')
    if (mentionsEnemyDebuff && !emitsEnemyDebuff) {
      issuePush(issues, base, 'enemy-debuff-not-emitted')
    }
  }
}

const byIssue: Record<IssueType, number> = {
  'explicit-hit-count-mismatch': 0,
  'row-hit-count-mismatch': 0,
  'damage-falloff-not-modeled': 0,
  'damage-not-modeled': 0,
  'delayed-damage-not-timed': 0,
  'secondary-damage-not-modeled': 0,
  'enemy-debuff-not-emitted': 0,
}
for (const issue of issues) byIssue[issue.issue] += 1

writeFileSync(OUT_PATH, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  issueCount: issues.length,
  byIssue,
  issues,
}, null, 2)}\n`, 'utf8')

console.log('=== Ability description audit ===')
console.log(`Open issues: ${issues.length}`)
for (const [issue, count] of Object.entries(byIssue)) {
  console.log(`  ${issue}: ${count}`)
}
console.log(`Report: ${OUT_PATH}`)
if (issues.length > 0) {
  console.log()
  for (const issue of issues.slice(0, 20)) {
    const expected = issue.expected != null ? ` expected=${issue.expected}` : ''
    const actual = issue.actual != null ? ` actual=${issue.actual}` : ''
    console.log(`  - ${issue.godId} ${issue.slot} ${issue.abilityName ?? '(unnamed)'} :: ${issue.issue}${expected}${actual}`)
  }
}
