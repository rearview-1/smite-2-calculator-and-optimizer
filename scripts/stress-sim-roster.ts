#!/usr/bin/env tsx

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { getAspect, inferGodDamageType, loadGods, getItem } from '../src/catalog/loadCatalogs.ts'
import { buildAbilityPlan, type AbilityPlan } from '../src/sim/v3/abilityResolver.ts'
import { inferPrimaryStat, runScenario } from '../src/sim/v3/engine.ts'
import type { AbilitySlot, RotationAction, Scenario, SimResult } from '../src/sim/v3/types.ts'

type RoleId = 'carry' | 'mid' | 'solo' | 'jungle' | 'support'
type BuildStyle = 'baseline' | 'ability' | 'proc' | 'aa' | 'bruiser' | 'aspect'

interface SweepCase {
  id: string
  role: RoleId
  buildStyle: BuildStyle
  items: string[]
  aspects?: string[]
  rotation: RotationAction[]
  options?: Scenario['options']
}

interface CaseReport {
  id: string
  role: RoleId
  buildStyle: BuildStyle
  items: string[]
  aspects: string[]
  rotation: string[]
  totalDamage?: number
  comboExecutionTime?: number
  warningCount?: number
  anomalyCount: number
  anomalies: string[]
  warnings: string[]
  topDamageLabels: Array<{ label: string; damage: number }>
  error?: string
}

interface GodReport {
  godId: string
  name: string
  damageType: 'physical' | 'magical' | 'true'
  primaryStat: 'STR' | 'INT' | 'hybrid'
  aspectSupported: boolean
  cases: CaseReport[]
  anomalyCount: number
  warningCount: number
  failedCases: number
}

const REPORT_PATH = resolve('data/sim-roster-stress-report.json')
const RANKS = { A01: 5, A02: 5, A03: 5, A04: 5 }

const PHYSICAL_ABILITY_ITEMS = [
  "Bumba's Hammer",
  "Jotunn's Revenge",
  "Hydra's Lament",
  'The Crusher',
  'Heartseeker',
  "Titan's Bane",
]

const PHYSICAL_PROC_ITEMS = [
  "Bumba's Hammer",
  "Hydra's Lament",
  'The Crusher',
  'Heartseeker',
  "Titan's Bane",
  'Bloodforge',
]

const PHYSICAL_AA_ITEMS = [
  'Sun Beam Bow',
  "Devourer's Gauntlet",
  'Demon Blade',
  'Deathbringer',
  "Qin's Blade",
  'Rage',
]

const PHYSICAL_BRUISER_ITEMS = [
  "Bumba's Hammer",
  "Hydra's Lament",
  "Gladiator's Shield",
  'Void Shield',
  "Shogun's Ofuda",
  'Mystical Mail',
]

const MAGICAL_ABILITY_ITEMS = [
  'Bluestone Brooch',
  'Book of Thoth',
  'Divine Ruin',
  'Obsidian Shard',
  'Rod of Tahuti',
  'Ancient Signet',
]

const MAGICAL_PROC_ITEMS = [
  'Bluestone Brooch',
  'Polynomicon',
  'Divine Ruin',
  'Obsidian Shard',
  'Rod of Tahuti',
  'Ancient Signet',
]

const MAGICAL_AA_ITEMS = [
  'Nimble Ring',
  'Polynomicon',
  'Obsidian Shard',
  'Rod of Tahuti',
  'Ancient Signet',
  'The Cosmic Horror',
]

const MAGICAL_BRUISER_ITEMS = [
  'Bluestone Brooch',
  'Divine Ruin',
  'Void Stone',
  "Shogun's Ofuda",
  'Ancient Signet',
  'Mystical Mail',
]

function rotationSummary(rotation: RotationAction[]): string[] {
  return rotation.map((action) => {
    if (action.kind === 'ability') return `${action.slot}${action.cancel ? ' cancel' : ''}`
    if (action.kind === 'wait') return `wait ${action.seconds}s`
    if (action.kind === 'activate') return `activate ${action.itemKey}`
    if (action.kind === 'relic') return `relic ${action.relicKey}`
    return action.kind
  })
}

function resolveItems(candidateNames: string[]): string[] {
  const out: string[] = []
  for (const name of candidateNames) {
    try {
      getItem(name)
      out.push(name)
    } catch {
      continue
    }
  }
  return out
}

function singleAbilityRotation(slot: AbilitySlot): RotationAction[] {
  return [{ kind: 'ability', slot }]
}

function abilityPlanDamageSummary(plan: AbilityPlan | null): {
  hasDamage: boolean
  expectedDamageEvents: number
} {
  if (!plan) return { hasDamage: false, expectedDamageEvents: 0 }
  let expectedDamageEvents = 0
  let hasDamage = false
  for (const component of plan.components) {
    if (component.kind === 'direct') {
      hasDamage = true
      expectedDamageEvents += Math.max(1, component.hits)
    } else if (component.kind === 'dot' || component.kind === 'bleed') {
      hasDamage = true
      expectedDamageEvents += Math.max(1, component.ticks ?? component.hits)
    }
  }
  return { hasDamage, expectedDamageEvents }
}

function hasAbilityThenBasic(rotation: RotationAction[]): boolean {
  let sawAbility = false
  for (const action of rotation) {
    if (action.kind === 'ability') sawAbility = true
    if (sawAbility && action.kind === 'basic') return true
  }
  return false
}

function countItemDamage(result: SimResult, labelPrefix: string): number {
  return result.damageEvents.filter((event) => event.label.startsWith(labelPrefix)).length
}

function analyzeCase(
  godId: string,
  buildCase: SweepCase,
  result: SimResult,
): { anomalies: string[]; warnings: string[] } {
  const anomalies: string[] = []
  const warnings = [...result.warnings]

  if (!Number.isFinite(result.totals.total)) anomalies.push('non-finite-total-damage')
  if (!Number.isFinite(result.comboExecutionTime)) anomalies.push('non-finite-combo-time')

  for (const event of result.damageEvents) {
    if (!Number.isFinite(event.preMitigation) || !Number.isFinite(event.postMitigation)) {
      anomalies.push(`non-finite-damage-event:${event.label}`)
    }
    if (event.preMitigation < 0 || event.postMitigation < 0) {
      anomalies.push(`negative-damage-event:${event.label}`)
    }
  }

  if (
    buildCase.rotation.length === 1
    && buildCase.rotation[0]?.kind === 'ability'
  ) {
    const slot = buildCase.rotation[0].slot
    const plan = buildAbilityPlan(
      loadGods()[godId]!,
      slot,
      RANKS[slot],
      { aspectActive: (buildCase.aspects?.length ?? 0) > 0 },
    )
    const summary = abilityPlanDamageSummary(plan)
    const normalizedAbilityName = (plan?.abilityName ?? slot).trim().toLowerCase()
    const actualAbilityDamageEvents = result.damageEvents.filter((event) => {
      const label = event.label.trim().toLowerCase()
      return label === slot.toLowerCase()
        || label.startsWith(`${slot.toLowerCase()} `)
        || label.startsWith(normalizedAbilityName)
    }).length
    if (summary.hasDamage && actualAbilityDamageEvents === 0) {
      anomalies.push(`missing-ability-damage:${slot}`)
    }
    if (!summary.hasDamage && actualAbilityDamageEvents > 0) {
      anomalies.push(`unexpected-ability-damage:${slot}`)
    }
    if (summary.expectedDamageEvents > 0 && actualAbilityDamageEvents < summary.expectedDamageEvents) {
      anomalies.push(`undercounted-ability-events:${slot}:${actualAbilityDamageEvents}/${summary.expectedDamageEvents}`)
    }
  }

  if (buildCase.items.includes('Bluestone Brooch')) {
    const abilityDamageEvents = result.damageEvents.filter((event) => event.source === 'ability').length
    if (abilityDamageEvents > 0 && countItemDamage(result, 'Bluestone Brooch') === 0) {
      anomalies.push('missing-item-proc:Bluestone Brooch')
    }
  }

  if (buildCase.items.includes('Divine Ruin')) {
    const nonDivineDamageEvents = result.damageEvents.filter((event) => event.label !== 'Divine Ruin').length
    if (nonDivineDamageEvents > 0 && countItemDamage(result, 'Divine Ruin') === 0) {
      anomalies.push('missing-item-proc:Divine Ruin')
    }
  }

  if (buildCase.items.includes('Polynomicon') && hasAbilityThenBasic(buildCase.rotation)) {
    if (countItemDamage(result, 'Polynomicon') === 0) {
      anomalies.push('missing-item-proc:Polynomicon')
    }
  }

  return { anomalies, warnings }
}

function buildCasesForGod(
  godId: string,
  damageType: 'physical' | 'magical' | 'true',
  aspectSupported: boolean,
): SweepCase[] {
  const isMagical = damageType === 'magical'
  const abilityItems = resolveItems(isMagical ? MAGICAL_ABILITY_ITEMS : PHYSICAL_ABILITY_ITEMS)
  const procItems = resolveItems(isMagical ? MAGICAL_PROC_ITEMS : PHYSICAL_PROC_ITEMS)
  const aaItems = resolveItems(isMagical ? MAGICAL_AA_ITEMS : PHYSICAL_AA_ITEMS)
  const bruiserItems = resolveItems(isMagical ? MAGICAL_BRUISER_ITEMS : PHYSICAL_BRUISER_ITEMS)
  const aspectKey = aspectSupported ? [`${godId}.aspect`] : []

  const cases: SweepCase[] = [
    {
      id: 'baseline-basic',
      role: 'carry',
      buildStyle: 'baseline',
      items: [],
      rotation: [{ kind: 'basic', label: 'AA1' }],
    },
    {
      id: 'baseline-a01',
      role: isMagical ? 'mid' : 'jungle',
      buildStyle: 'baseline',
      items: [],
      rotation: singleAbilityRotation('A01'),
    },
    {
      id: 'baseline-a02',
      role: isMagical ? 'support' : 'solo',
      buildStyle: 'baseline',
      items: [],
      rotation: singleAbilityRotation('A02'),
    },
    {
      id: 'baseline-a03',
      role: isMagical ? 'mid' : 'solo',
      buildStyle: 'baseline',
      items: [],
      rotation: singleAbilityRotation('A03'),
    },
    {
      id: 'baseline-a04',
      role: isMagical ? 'mid' : 'jungle',
      buildStyle: 'baseline',
      items: [],
      rotation: singleAbilityRotation('A04'),
    },
    {
      id: 'proc-aa-a01-aa',
      role: isMagical ? 'carry' : 'jungle',
      buildStyle: 'proc',
      items: procItems,
      rotation: [{ kind: 'basic' }, { kind: 'ability', slot: 'A01' }, { kind: 'basic' }],
    },
    {
      id: 'proc-aa-a02-aa',
      role: isMagical ? 'carry' : 'carry',
      buildStyle: 'proc',
      items: procItems,
      rotation: [{ kind: 'basic' }, { kind: 'ability', slot: 'A02' }, { kind: 'basic' }],
    },
    {
      id: 'bruiser-a01-a02-a03',
      role: isMagical ? 'support' : 'solo',
      buildStyle: 'bruiser',
      items: bruiserItems,
      rotation: [
        { kind: 'ability', slot: 'A01' },
        { kind: 'ability', slot: 'A02' },
        { kind: 'ability', slot: 'A03' },
      ],
    },
    {
      id: 'ability-full-kit-window',
      role: isMagical ? 'mid' : 'jungle',
      buildStyle: 'ability',
      items: abilityItems,
      rotation: [
        { kind: 'ability', slot: 'A01' },
        { kind: 'ability', slot: 'A02' },
        { kind: 'ability', slot: 'A03' },
        { kind: 'ability', slot: 'A04' },
      ],
      options: { combatWindow: 5, greedyBasics: true },
    },
    {
      id: aspectSupported ? 'aspect-window' : 'aa-window',
      role: isMagical ? 'carry' : 'carry',
      buildStyle: aspectSupported ? 'aspect' : 'aa',
      items: aspectSupported ? abilityItems : aaItems,
      aspects: aspectKey,
      rotation: aspectSupported
        ? [
            { kind: 'ability', slot: 'A01' },
            { kind: 'ability', slot: 'A02' },
            { kind: 'ability', slot: 'A03' },
            { kind: 'basic' },
          ]
        : [
            { kind: 'basic' },
            { kind: 'basic' },
            { kind: 'ability', slot: 'A01' },
            { kind: 'basic' },
            { kind: 'ability', slot: 'A02' },
            { kind: 'basic' },
          ],
      options: { combatWindow: 5, greedyBasics: true },
    },
  ]

  return cases
}

function buildScenario(godId: string, buildCase: SweepCase): Scenario {
  return {
    title: `${godId} ${buildCase.id}`,
    attacker: {
      godId,
      level: 20,
      abilityRanks: RANKS,
      items: buildCase.items,
      aspects: buildCase.aspects,
    },
    defender: {
      godId: 'Kukulkan',
      level: 20,
    },
    rotation: buildCase.rotation,
    options: buildCase.options,
  }
}

function topDamageLabels(result: SimResult): Array<{ label: string; damage: number }> {
  return Object.entries(result.byLabel)
    .map(([label, damage]) => ({ label, damage }))
    .sort((a, b) => b.damage - a.damage)
    .slice(0, 5)
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

  let totalCases = 0
  let failedCases = 0
  let anomalyCases = 0
  let warningCases = 0
  const anomalyKinds = new Map<string, number>()
  const warningKinds = new Map<string, number>()

  for (const [godId, god] of Object.entries(gods).sort((a, b) => a[1].god.localeCompare(b[1].god))) {
    const damageType = inferGodDamageType(god)
    const primaryStat = inferPrimaryStat(god)
    const aspectSupported = getAspect(godId) != null
    const cases = buildCasesForGod(godId, damageType, aspectSupported)
    const godReport: GodReport = {
      godId,
      name: god.god,
      damageType,
      primaryStat,
      aspectSupported,
      cases: [],
      anomalyCount: 0,
      warningCount: 0,
      failedCases: 0,
    }

    for (const buildCase of cases) {
      totalCases += 1
      try {
        const result = runScenario(buildScenario(godId, buildCase))
        const analysis = analyzeCase(godId, buildCase, result)
        const caseReport: CaseReport = {
          id: buildCase.id,
          role: buildCase.role,
          buildStyle: buildCase.buildStyle,
          items: buildCase.items,
          aspects: buildCase.aspects ?? [],
          rotation: rotationSummary(buildCase.rotation),
          totalDamage: Number(result.totals.total.toFixed(4)),
          comboExecutionTime: Number(result.comboExecutionTime.toFixed(4)),
          warningCount: result.warnings.length,
          anomalyCount: analysis.anomalies.length,
          anomalies: analysis.anomalies,
          warnings: analysis.warnings,
          topDamageLabels: topDamageLabels(result),
        }
        godReport.cases.push(caseReport)
        godReport.anomalyCount += analysis.anomalies.length
        godReport.warningCount += result.warnings.length
        if (analysis.anomalies.length > 0) anomalyCases += 1
        if (result.warnings.length > 0) warningCases += 1
        for (const anomaly of analysis.anomalies) anomalyKinds.set(anomaly, (anomalyKinds.get(anomaly) ?? 0) + 1)
        for (const warning of result.warnings) warningKinds.set(warning, (warningKinds.get(warning) ?? 0) + 1)
      } catch (error) {
        failedCases += 1
        godReport.failedCases += 1
        const message = error instanceof Error ? error.message : String(error)
        godReport.cases.push({
          id: buildCase.id,
          role: buildCase.role,
          buildStyle: buildCase.buildStyle,
          items: buildCase.items,
          aspects: buildCase.aspects ?? [],
          rotation: rotationSummary(buildCase.rotation),
          anomalyCount: 1,
          anomalies: ['scenario-threw'],
          warnings: [],
          topDamageLabels: [],
          error: message,
        })
        anomalyCases += 1
        anomalyKinds.set('scenario-threw', (anomalyKinds.get('scenario-threw') ?? 0) + 1)
      }
    }

    report.gods.push(godReport)
  }

  const godsWithAnomalies = report.gods.filter((god) => god.anomalyCount > 0 || god.failedCases > 0)
  const godsWithWarnings = report.gods.filter((god) => god.warningCount > 0)
  report.summary = {
    totalGods: report.gods.length,
    totalCases,
    failedCases,
    anomalyCases,
    warningCases,
    godsWithAnomalies: godsWithAnomalies.length,
    godsWithWarnings: godsWithWarnings.length,
    topAnomalies: [...anomalyKinds.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([kind, count]) => ({ kind, count })),
    topWarnings: [...warningKinds.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([kind, count]) => ({ kind, count })),
    topGodsByAnomalies: godsWithAnomalies
      .slice()
      .sort((a, b) => (b.anomalyCount + b.failedCases) - (a.anomalyCount + a.failedCases))
      .slice(0, 25)
      .map((god) => ({
        godId: god.godId,
        name: god.name,
        anomalyCount: god.anomalyCount,
        failedCases: god.failedCases,
        warningCount: god.warningCount,
      })),
  }

  mkdirSync(dirname(REPORT_PATH), { recursive: true })
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2))

  console.log(`[stress-sim-roster] wrote ${REPORT_PATH}`)
  console.log(`[stress-sim-roster] gods=${report.gods.length} cases=${totalCases} anomalyCases=${anomalyCases} failedCases=${failedCases} warningCases=${warningCases}`)
  for (const entry of (report.summary.topAnomalies as Array<{ kind: string; count: number }>).slice(0, 10)) {
    console.log(`  anomaly ${entry.kind}: ${entry.count}`)
  }
}

main()
