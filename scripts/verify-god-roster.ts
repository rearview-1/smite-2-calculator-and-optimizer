#!/usr/bin/env tsx

import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { getAspect, loadGods } from '../src/catalog/loadCatalogs.ts'
import { buildAbilityPlan } from '../src/sim/v3/abilityResolver.ts'
import { runScenario } from '../src/sim/v3/engine.ts'
import type { AbilitySlot, RotationAction, Scenario, SimResult } from '../src/sim/v3/types.ts'
import { getAuthoredAbilityDescription } from './lib/authoredAbilityDescriptions.ts'

type IssueKind =
  | 'damage-not-modeled'
  | 'explicit-hit-count-mismatch'
  | 'damage-falloff-not-modeled'
  | 'delayed-damage-not-timed'
  | 'secondary-damage-not-modeled'
  | 'combo-missing-ability-damage'
  | 'scenario-warning'

type CaseReport = {
  id: string
  type: 'ability' | 'combo'
  slot?: AbilitySlot
  abilityName?: string | null
  aspects: string[]
  rotation: string[]
  totalDamage: number
  comboExecutionTime: number
  issues: Array<{ kind: IssueKind; detail: string }>
  eventLabels: string[]
  preMitigationSeries: number[]
  delayedEventLabels: string[]
  warnings: string[]
}

type GodReport = {
  godId: string
  name: string
  aspectSupported: boolean
  caseCount: number
  issueCount: number
  cases: CaseReport[]
}

const OUT_PATH = path.resolve('data/god-roster-verification.json')
const RANKS = { A01: 5, A02: 5, A03: 5, A04: 5 }
const SLOTS: AbilitySlot[] = ['A01', 'A02', 'A03', 'A04']

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
    if (/\bnext ability\b|\bnext basic\b|\bbasic attacks?\b|\byour attacks\b|\byour basic attacks\b|\bwhile your basic attacks\b|\byou also deal bonus damage to\b/i.test(clause)) return false
    if (/\bif\b|\bwhen\b|\bwhile\b|\bwithin a whirlwind\b|\bon statues\b|\bthistlethorn acorn\b/i.test(clause)) return false
    return true
  })
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

function isCastOnlyAttackModifier(description: string): boolean {
  return /\bnext\s+\d*\s*basic attack\b|\bnext basic attack\b|\bnext 3 basic attacks\b|\bempower(?:ing)? your attacks\b|\bempowering your attacks as\b|\bimbue your arrows\b|\byour attacks fire\b|\bbasic attacks?\b|\bwhile your basic attacks\b|\byour basic attacks deal\b|\bgain increased critical strike chance while this ability is active\b/i.test(description)
}

function hasConditionalOnlySecondaryDamage(description: string): boolean {
  return /\bthistlethorn acorn\b|\bon statues\b|\bif the projectile hits a clay soldier\b|\bif you have a shield from raven shout\b|\benemy gods and jungle bosses debuffed explode\b/i.test(description)
}

function hasExplicitDamageDelay(description: string): boolean {
  if (hasConditionalOnlySecondaryDamage(description)) return false
  if (/\bcan be refired\b|\breactivate this ability\b/i.test(description) && !/\bautomatically refires\b/i.test(description)) return false
  return /after\s+\d+(?:\.\d+)?\s*(?:s|seconds?)\b|after a short delay|after a delay|for\s+\d+(?:\.\d+)?\s*(?:s|seconds?)\b[\s\S]{0,48}\bbefore\b[\s\S]{0,24}\bexplode|at the end of the effect/i.test(description)
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

function rotationSummary(rotation: RotationAction[]): string[] {
  return rotation.map((action) => {
    if (action.kind === 'ability') return action.slot
    if (action.kind === 'basic') return action.label ?? 'AA'
    if (action.kind === 'wait') return `wait ${action.seconds}s`
    if (action.kind === 'activate') return `activate ${action.itemKey}`
    if (action.kind === 'relic') return `relic ${action.relicKey}`
    return action.kind
  })
}

function buildScenario(godId: string, rotation: RotationAction[], aspects: string[] = []): Scenario {
  return {
    title: `${godId} verifier`,
    attacker: {
      godId,
      level: 20,
      abilityRanks: RANKS,
      items: [],
      aspects,
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation,
  }
}

function damageEventsForAbility(result: SimResult, slot: AbilitySlot, abilityName: string | null): SimResult['damageEvents'] {
  const normalizedAbilityName = (abilityName ?? slot).trim().toLowerCase()
  return result.damageEvents.filter((event) => {
    if (event.source !== 'ability' && event.source !== 'dot') return false
    const label = event.label.trim().toLowerCase()
    return label === slot.toLowerCase()
      || label.startsWith(`${slot.toLowerCase()} `)
      || label.startsWith(normalizedAbilityName)
  })
}

function issue(kind: IssueKind, detail: string): { kind: IssueKind; detail: string } {
  return { kind, detail }
}

function verifyAbilityCase(godId: string, slot: AbilitySlot, aspects: string[]): CaseReport {
  const god = loadGods()[godId]!
  const ability = god.abilities[slot]
  const authored = getAuthoredAbilityDescription(godId, slot)
  const description = normalizeDescription(authored.combined ?? ability?.description ?? '')
  const rotation: RotationAction[] = [{ kind: 'ability', slot, label: ability?.name ?? slot }]
  const result = runScenario(buildScenario(godId, rotation, aspects))
  const plan = buildAbilityPlan(god, slot, 5, { aspectActive: aspects.length > 0 })
  const abilityEvents = damageEventsForAbility(result, slot, ability?.name ?? slot)
  const preMitigationSeries = abilityEvents.map((ev) => Number(ev.preMitigation.toFixed(4)))
  const delayedEventLabels = abilityEvents.filter((ev) => ev.t > 0.05).map((ev) => ev.label)
  const issues: CaseReport['issues'] = []
  const castOnlyAttackModifier = isCastOnlyAttackModifier(description)

  if (descriptionImpliesDamage(description) && abilityEvents.length === 0 && !castOnlyAttackModifier) {
    issues.push(issue('damage-not-modeled', 'description implies direct damage but no ability/dot events were emitted'))
  }

  const explicitHits = explicitHitCount(description)
  if (explicitHits && (
    (aspects.length === 0 && abilityEvents.length !== explicitHits)
    || (aspects.length > 0 && abilityEvents.length < explicitHits)
  )) {
    issues.push(issue('explicit-hit-count-mismatch', `expected ${explicitHits} damage events, got ${abilityEvents.length}`))
  }

  const hasDamageFalloffRow = Object.keys(ability?.rankValues ?? {}).some((row) => /DamageRedMulti/i.test(row))
  const hasDescendingPreMit = preMitigationSeries.length > 1
    && preMitigationSeries.some((value, index) => index > 0 && value < preMitigationSeries[index - 1] - 0.001)
  if (hasDamageFalloffRow && !hasDescendingPreMit) {
    issues.push(issue('damage-falloff-not-modeled', 'local falloff row exists but emitted damage does not descend'))
  }

  if (hasExplicitDamageDelay(description) && abilityEvents.length > 0 && delayedEventLabels.length === 0) {
    issues.push(issue('delayed-damage-not-timed', 'description specifies delayed damage but no delayed events were emitted'))
  }

  const hasSecondaryDamage = abilityEvents.length >= 2 || (plan?.components ?? []).some((component) => component.kind === 'dot' || component.kind === 'bleed')
  if (requiresBaseSecondaryDamage(description) && abilityEvents.length > 0 && !hasSecondaryDamage) {
    issues.push(issue('secondary-damage-not-modeled', 'description requires base secondary damage but emitted only one damage phase'))
  }

  for (const warning of result.warnings) issues.push(issue('scenario-warning', warning))

  return {
    id: aspects.length > 0 ? `${slot.toLowerCase()}-aspect` : slot.toLowerCase(),
    type: 'ability',
    slot,
    abilityName: ability?.name ?? null,
    aspects,
    rotation: rotationSummary(rotation),
    totalDamage: Number(result.totals.total.toFixed(4)),
    comboExecutionTime: Number(result.comboExecutionTime.toFixed(4)),
    issues,
    eventLabels: abilityEvents.map((ev) => ev.label),
    preMitigationSeries,
    delayedEventLabels,
    warnings: result.warnings,
  }
}

function comboCasesForGod(godId: string, aspectSupported: boolean): Array<{ id: string; rotation: RotationAction[]; aspects: string[] }> {
  const aspectKey = aspectSupported ? [`${godId}.aspect`] : []
  return [
    { id: 'aa-a01-aa', rotation: [{ kind: 'basic', label: 'AA1' }, { kind: 'ability', slot: 'A01' }, { kind: 'basic', label: 'AA2' }], aspects: [] },
    { id: 'aa-a02-aa', rotation: [{ kind: 'basic', label: 'AA1' }, { kind: 'ability', slot: 'A02' }, { kind: 'basic', label: 'AA2' }], aspects: [] },
    { id: 'a01-a02', rotation: [{ kind: 'ability', slot: 'A01' }, { kind: 'ability', slot: 'A02' }], aspects: [] },
    { id: 'a02-a03', rotation: [{ kind: 'ability', slot: 'A02' }, { kind: 'ability', slot: 'A03' }], aspects: [] },
    { id: 'full-kit', rotation: [{ kind: 'ability', slot: 'A01' }, { kind: 'ability', slot: 'A02' }, { kind: 'ability', slot: 'A03' }, { kind: 'ability', slot: 'A04' }], aspects: [] },
    ...(aspectSupported ? [{ id: 'aspect-full-kit', rotation: [{ kind: 'ability', slot: 'A01' }, { kind: 'ability', slot: 'A02' }, { kind: 'ability', slot: 'A03' }, { kind: 'ability', slot: 'A04' }], aspects: aspectKey }] : []),
  ]
}

function abilityCaseId(slot: AbilitySlot, aspects: string[]): string {
  return aspects.length > 0 ? `${slot.toLowerCase()}-aspect` : slot.toLowerCase()
}

function verifyComboCase(
  godId: string,
  id: string,
  rotation: RotationAction[],
  aspects: string[],
  abilityCasesById: Map<string, CaseReport>,
): CaseReport {
  const god = loadGods()[godId]!
  const result = runScenario(buildScenario(godId, rotation, aspects))
  const issues: CaseReport['issues'] = []

  for (let index = 0; index < rotation.length; index += 1) {
    const action = rotation[index]!
    if (action.kind !== 'ability') continue
    const ability = god.abilities[action.slot]
    const authored = getAuthoredAbilityDescription(godId, action.slot)
    const description = normalizeDescription(authored.combined ?? ability?.description ?? '')
    const castOnlyAttackModifier = isCastOnlyAttackModifier(description)
    const standaloneCase = abilityCasesById.get(abilityCaseId(action.slot, aspects))
    const standaloneHadDamage = (standaloneCase?.eventLabels.length ?? 0) > 0
    const standaloneMissingDamage = standaloneCase?.issues.some((entry) => entry.kind === 'damage-not-modeled') ?? false
    if (castOnlyAttackModifier) continue
    const shouldExpectDamage = standaloneHadDamage || standaloneMissingDamage
    if (!shouldExpectDamage) continue
    const abilityEvents = damageEventsForAbility(result, action.slot, ability?.name ?? action.slot)
    if (abilityEvents.length === 0) {
      issues.push(issue('combo-missing-ability-damage', `${action.slot} produced no damage events inside combo ${id}`))
    }
  }

  for (const warning of result.warnings) issues.push(issue('scenario-warning', warning))

  return {
    id,
    type: 'combo',
    aspects,
    rotation: rotationSummary(rotation),
    totalDamage: Number(result.totals.total.toFixed(4)),
    comboExecutionTime: Number(result.comboExecutionTime.toFixed(4)),
    issues,
    eventLabels: result.damageEvents.map((ev) => ev.label),
    preMitigationSeries: result.damageEvents.map((ev) => Number(ev.preMitigation.toFixed(4))),
    delayedEventLabels: result.damageEvents.filter((ev) => ev.t > 0.05).map((ev) => ev.label),
    warnings: result.warnings,
  }
}

function main() {
  const gods = loadGods()
  const report: {
    generatedAt: string
    summary: Record<string, unknown>
    gods: GodReport[]
  } = {
    generatedAt: new Date().toISOString(),
    summary: {},
    gods: [],
  }

  const issueCounts = new Map<IssueKind, number>()
  let totalCases = 0
  let totalIssues = 0

  for (const [godId, god] of Object.entries(gods).sort((a, b) => a[1].god.localeCompare(b[1].god))) {
    const aspectSupported = getAspect(godId) != null
    const cases: CaseReport[] = []
    const abilityCasesById = new Map<string, CaseReport>()

    for (const slot of SLOTS) {
      const baseCase = verifyAbilityCase(godId, slot, [])
      cases.push(baseCase)
      abilityCasesById.set(abilityCaseId(slot, []), baseCase)
      totalCases += 1
      if (aspectSupported) {
        const aspectCase = verifyAbilityCase(godId, slot, [`${godId}.aspect`])
        cases.push(aspectCase)
        abilityCasesById.set(abilityCaseId(slot, [`${godId}.aspect`]), aspectCase)
        totalCases += 1
      }
    }

    for (const comboCase of comboCasesForGod(godId, aspectSupported)) {
      cases.push(verifyComboCase(godId, comboCase.id, comboCase.rotation, comboCase.aspects, abilityCasesById))
      totalCases += 1
    }

    let godIssues = 0
    for (const testCase of cases) {
      godIssues += testCase.issues.length
      totalIssues += testCase.issues.length
      for (const item of testCase.issues) {
        issueCounts.set(item.kind, (issueCounts.get(item.kind) ?? 0) + 1)
      }
    }

    report.gods.push({
      godId,
      name: god.god,
      aspectSupported,
      caseCount: cases.length,
      issueCount: godIssues,
      cases,
    })
  }

  report.summary = {
    totalGods: report.gods.length,
    totalCases,
    totalIssues,
    topIssues: [...issueCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, count]) => ({ kind, count })),
    topGodsByIssues: report.gods
      .filter((god) => god.issueCount > 0)
      .sort((a, b) => b.issueCount - a.issueCount)
      .slice(0, 25)
      .map((god) => ({ godId: god.godId, name: god.name, issueCount: god.issueCount })),
  }

  writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`[verify-god-roster] wrote ${OUT_PATH}`)
  console.log(`[verify-god-roster] gods=${report.gods.length} cases=${totalCases} issues=${totalIssues}`)
  for (const issue of [...issueCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  issue ${issue[0]}: ${issue[1]}`)
  }
}

main()
