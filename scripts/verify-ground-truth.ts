#!/usr/bin/env tsx

import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { runScenario } from '../src/sim/v3/engine.ts'
import type { DamageEvent, SimResult } from '../src/sim/v3/types.ts'
import {
  getSnapshotValue,
  loadGroundTruthFixtures,
  matchDamageEvent,
  valueClose,
  type GroundTruthFixture,
} from './lib/groundTruth.ts'

type CheckResult = {
  label: string
  pass: boolean
  actual?: number | string | boolean | null
  expected?: number | string | boolean
  tolerance?: number
  details?: string
}

type FixtureReport = {
  id: string
  pass: boolean
  checks: CheckResult[]
}

const OUT_PATH = path.resolve('data/ground-truth-report.json')

function pushNumericCheck(
  checks: CheckResult[],
  label: string,
  actual: number | undefined,
  expected: number,
  tolerance = 0.01,
): void {
  checks.push({
    label,
    pass: actual !== undefined && valueClose(actual, expected, tolerance),
    actual: actual ?? null,
    expected,
    tolerance,
  })
}

function filterDamageEvents(result: SimResult, fixture: GroundTruthFixture, match: GroundTruthFixture['eventCountAssertions'][number]['match']): DamageEvent[] {
  return result.damageEvents.filter((event) => matchDamageEvent(event, match))
}

const file = loadGroundTruthFixtures()
const reports: FixtureReport[] = []

for (const fixture of file.fixtures) {
  const result = runScenario(fixture.scenario)
  const checks: CheckResult[] = []

  for (const [field, expectation] of Object.entries(fixture.totals ?? {})) {
    if (!expectation) continue
    pushNumericCheck(
      checks,
      `totals.${field}`,
      result.totals[field as keyof SimResult['totals']],
      expectation.expected,
      expectation.tolerance ?? 0.01,
    )
  }

  for (const assertion of fixture.scalarAssertions ?? []) {
    pushNumericCheck(
      checks,
      assertion.field,
      result[assertion.field],
      assertion.expected,
      assertion.tolerance ?? 0.01,
    )
  }

  for (const assertion of fixture.eventCountAssertions ?? []) {
    const matches = filterDamageEvents(result, fixture, assertion.match)
    checks.push({
      label: `eventCount ${JSON.stringify(assertion.match)}`,
      pass: matches.length === assertion.expected,
      actual: matches.length,
      expected: assertion.expected,
    })
  }

  for (const assertion of fixture.eventValueAssertions ?? []) {
    const matches = filterDamageEvents(result, fixture, assertion.match)
    const occurrence = Math.max(1, assertion.occurrence ?? 1)
    const event = matches[occurrence - 1]
    const actual = event?.[assertion.field]
    pushNumericCheck(
      checks,
      `eventValue ${JSON.stringify(assertion.match)} #${occurrence} ${assertion.field}`,
      actual,
      assertion.expected,
      assertion.tolerance ?? 0.01,
    )
  }

  for (const assertion of fixture.snapshotAssertions ?? []) {
    const actual = getSnapshotValue(result, assertion.side, assertion.field)
    if (typeof assertion.expected === 'number') {
      pushNumericCheck(
        checks,
        `snapshot.${assertion.side}.${assertion.field}`,
        typeof actual === 'number' ? actual : undefined,
        assertion.expected,
        assertion.tolerance ?? 0.01,
      )
    } else {
      checks.push({
        label: `snapshot.${assertion.side}.${assertion.field}`,
        pass: actual === assertion.expected,
        actual: actual as string | boolean | null ?? null,
        expected: assertion.expected,
      })
    }
  }

  reports.push({
    id: fixture.id,
    pass: checks.every((check) => check.pass),
    checks,
  })
}

writeFileSync(OUT_PATH, `${JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  fixtures: reports,
}, null, 2)}\n`, 'utf8')

const failed = reports.filter((report) => !report.pass)

console.log('=== Ground-truth verification ===')
console.log(`Fixtures: ${reports.length}`)
console.log(`Passed: ${reports.length - failed.length}`)
console.log(`Failed: ${failed.length}`)
console.log(`Report: ${OUT_PATH}`)

if (failed.length > 0) {
  console.error()
  for (const report of failed) {
    console.error(`Fixture failed: ${report.id}`)
    for (const check of report.checks.filter((row) => !row.pass)) {
      console.error(`  - ${check.label}: expected ${check.expected}${check.tolerance !== undefined ? ` ±${check.tolerance}` : ''}, got ${check.actual}`)
    }
  }
  process.exitCode = 1
} else {
  console.log('Ground-truth verification passed.')
}
