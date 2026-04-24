import { readFileSync } from 'node:fs'
import path from 'node:path'

import type { DamageEvent, DamageType, Scenario, SimResult } from '../../src/sim/v3/types.ts'

export type CoverageArea = 'basic' | 'passive' | 'A01' | 'A02' | 'A03' | 'A04'

export interface NumericExpectation {
  expected: number
  tolerance?: number
}

export interface GroundTruthSource {
  kind: 'manual_capture' | 'combat_log' | 'user_report' | 'repo_note'
  capturedAt?: string
  notes?: string
}

export interface DamageEventMatch {
  label?: string
  labelMode?: 'exact' | 'startsWith' | 'includes'
  source?: DamageEvent['source']
  damageType?: DamageType
}

export interface DamageEventCountAssertion {
  match: DamageEventMatch
  expected: number
}

export interface DamageEventValueAssertion {
  match: DamageEventMatch
  occurrence?: number
  field: 'preMitigation' | 'postMitigation'
  expected: number
  tolerance?: number
}

export interface ScalarAssertion {
  field: 'comboExecutionTime' | 'totalCombatTime' | 'defenderDefeatedAt'
  expected: number
  tolerance?: number
}

export interface SnapshotAssertion {
  side: 'attacker' | 'defender'
  field: string
  expected: number | string | boolean
  tolerance?: number
}

export interface GroundTruthFixture {
  id: string
  description?: string
  source: GroundTruthSource
  scenario: Scenario
  coverage?: {
    godId?: string
    areas?: CoverageArea[]
    items?: string[]
  }
  totals?: Partial<Record<'physical' | 'magical' | 'true' | 'total', NumericExpectation>>
  scalarAssertions?: ScalarAssertion[]
  eventCountAssertions?: DamageEventCountAssertion[]
  eventValueAssertions?: DamageEventValueAssertion[]
  snapshotAssertions?: SnapshotAssertion[]
}

export interface GroundTruthFile {
  schemaVersion: 1
  fixtures: GroundTruthFixture[]
}

export const GROUND_TRUTH_FIXTURES_PATH = path.resolve('data/ground-truth-fixtures.json')

export function loadGroundTruthFixtures(): GroundTruthFile {
  return JSON.parse(readFileSync(GROUND_TRUTH_FIXTURES_PATH, 'utf8')) as GroundTruthFile
}

export function valueClose(actual: number, expected: number, tolerance = 0.01): boolean {
  return Math.abs(actual - expected) <= tolerance
}

export function matchDamageEvent(event: DamageEvent, match: DamageEventMatch): boolean {
  if (match.source && event.source !== match.source) return false
  if (match.damageType && event.damageType !== match.damageType) return false
  if (match.label) {
    const mode = match.labelMode ?? 'exact'
    if (mode === 'exact' && event.label !== match.label) return false
    if (mode === 'startsWith' && !event.label.startsWith(match.label)) return false
    if (mode === 'includes' && !event.label.includes(match.label)) return false
  }
  return true
}

export function getSnapshotValue(result: SimResult, side: 'attacker' | 'defender', field: string): unknown {
  const root = side === 'attacker' ? result.attackerSnapshot as Record<string, unknown> : result.defenderSnapshot as Record<string, unknown>
  return field.split('.').reduce<unknown>((value, segment) => {
    if (value && typeof value === 'object' && segment in (value as Record<string, unknown>)) {
      return (value as Record<string, unknown>)[segment]
    }
    return undefined
  }, root)
}
