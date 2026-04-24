#!/usr/bin/env tsx

import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { loadGods, loadItems } from '../src/catalog/loadCatalogs.ts'
import { getFinalBuildItemExclusionReason, itemDisplayName } from '../src/catalog/itemEligibility.ts'
import { loadGroundTruthFixtures, type CoverageArea } from './lib/groundTruth.ts'

const OUT_PATH = path.resolve('data/ground-truth-coverage.json')
const EXPECTED_GOD_AREAS: CoverageArea[] = ['basic', 'passive', 'A01', 'A02', 'A03', 'A04']

const fixtures = loadGroundTruthFixtures().fixtures
const gods = loadGods()
const items = loadItems()

const byGod = new Map<string, { areas: Set<CoverageArea>; fixtures: string[] }>()
const coveredItems = new Map<string, string[]>()

for (const fixture of fixtures) {
  const godId = fixture.coverage?.godId ?? fixture.scenario.attacker.godId
  const godCoverage = byGod.get(godId) ?? { areas: new Set<CoverageArea>(), fixtures: [] }
  for (const area of fixture.coverage?.areas ?? []) godCoverage.areas.add(area)
  godCoverage.fixtures.push(fixture.id)
  byGod.set(godId, godCoverage)

  for (const itemName of fixture.coverage?.items ?? []) {
    const bucket = coveredItems.get(itemName) ?? []
    bucket.push(fixture.id)
    coveredItems.set(itemName, bucket)
  }
}

const godRows = Object.keys(gods).sort().map((godId) => {
  const abilityAreas = Object.keys(gods[godId]?.abilities ?? {}) as CoverageArea[]
  const expectedAreas = EXPECTED_GOD_AREAS.filter((area) => area === 'basic' || area === 'passive' || abilityAreas.includes(area))
  const actual = byGod.get(godId)?.areas ?? new Set<CoverageArea>()
  const missing = expectedAreas.filter((area) => !actual.has(area))
  return {
    godId,
    expectedAreas,
    coveredAreas: [...actual].sort(),
    missingAreas: missing,
    fixtureIds: byGod.get(godId)?.fixtures ?? [],
    fullyCovered: missing.length === 0,
  }
})

const finalItemRows = Object.entries(items)
  .filter(([, item]) => getFinalBuildItemExclusionReason(item) === null)
  .map(([, item]) => itemDisplayName(item) ?? item.internalKey ?? 'unknown')
  .filter((name, index, rows) => rows.indexOf(name) === index)
  .sort()

const itemRows = finalItemRows.map((name) => ({
  itemName: name,
  fixtureIds: coveredItems.get(name) ?? [],
  covered: coveredItems.has(name),
}))

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  summary: {
    fixtures: fixtures.length,
    godsTotal: godRows.length,
    godsWithAnyFixture: godRows.filter((row) => row.fixtureIds.length > 0).length,
    godsFullyCovered: godRows.filter((row) => row.fullyCovered).length,
    finalItemsTotal: itemRows.length,
    finalItemsWithExplicitFixture: itemRows.filter((row) => row.covered).length,
  },
  gods: godRows,
  items: itemRows,
}

writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log('=== Ground-truth coverage audit ===')
console.log(`Fixtures: ${report.summary.fixtures}`)
console.log(`Gods with any fixture: ${report.summary.godsWithAnyFixture}/${report.summary.godsTotal}`)
console.log(`Gods fully covered (basic + passive + A01-A04): ${report.summary.godsFullyCovered}/${report.summary.godsTotal}`)
console.log(`Final items with explicit live fixture: ${report.summary.finalItemsWithExplicitFixture}/${report.summary.finalItemsTotal}`)
console.log(`Report: ${OUT_PATH}`)

const uncoveredGods = godRows.filter((row) => row.missingAreas.length > 0)
if (uncoveredGods.length > 0) {
  console.log()
  console.log('First 12 gods still missing live coverage:')
  for (const row of uncoveredGods.slice(0, 12)) {
    console.log(`  - ${row.godId}: missing ${row.missingAreas.join(', ')}`)
  }
}

const uncoveredItems = itemRows.filter((row) => !row.covered)
if (uncoveredItems.length > 0) {
  console.log()
  console.log('First 20 final items still missing explicit live fixtures:')
  for (const row of uncoveredItems.slice(0, 20)) {
    console.log(`  - ${row.itemName}`)
  }
}
