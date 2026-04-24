#!/usr/bin/env tsx

import { readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { loadGods, loadItems, type ItemCatalogEntry } from '../src/catalog/loadCatalogs.ts'
import { getFinalBuildItemExclusionReason, itemDisplayName } from '../src/catalog/itemEligibility.ts'
import { loadGroundTruthFixtures, type CoverageArea } from './lib/groundTruth.ts'

const OUT_DIR = 'tools/SmiteAssetProbe/out'
const OUT_PATH = path.resolve('data/ground-truth-backlog.json')
const EXPECTED_GOD_AREAS: CoverageArea[] = ['basic', 'passive', 'A01', 'A02', 'A03', 'A04']

type GodBacklogEntry = {
  kind: 'god'
  godId: string
  area: CoverageArea
  fixtureIdSuggestion: string
  scenarioTemplate: {
    title: string
    attacker: { godId: string; level: number; abilityRanks: Record<'A01' | 'A02' | 'A03' | 'A04', number>; items: string[] }
    defender: { godId: string; level: number }
    rotation: Array<{ kind: 'ability'; slot: 'A01' | 'A02' | 'A03' | 'A04' } | { kind: 'basic'; label: string }>
  }
  probeFiles: string[]
}

type ItemBacklogEntry = {
  kind: 'item'
  itemName: string
  fixtureIdSuggestion: string
  sourceFiles: string[]
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function rankBlock(): Record<'A01' | 'A02' | 'A03' | 'A04', number> {
  return { A01: 5, A02: 5, A03: 5, A04: 5 }
}

function scenarioRotationFor(area: CoverageArea): GodBacklogEntry['scenarioTemplate']['rotation'] {
  if (area === 'basic') return [{ kind: 'basic', label: 'AA1' }]
  if (area === 'passive') return []
  return [{ kind: 'ability', slot: area }]
}

function probeFilesForGodArea(files: string[], godId: string, area: CoverageArea): string[] {
  const godFiles = files.filter((file) => file.includes(`GODS_${godId}_`))
  if (area === 'basic') {
    return godFiles
      .filter((file) => /Common_Abilities_(?:BearBasicAttack|BasicAttack|InhandAttack|Inhand|Inhands)/i.test(file))
      .slice(0, 24)
  }
  if (area === 'passive') {
    return godFiles
      .filter((file) => /Common_Abilities_Passive|Common_Passive/i.test(file))
      .slice(0, 24)
  }
  const abilityNumber = Number(area.slice(2))
  return godFiles
    .filter((file) =>
      new RegExp(`Common_Abilities_Ability${abilityNumber}_|_${area}_`, 'i').test(file))
    .slice(0, 24)
}

function bestItemRecordByName(items: Record<string, ItemCatalogEntry>): Map<string, ItemCatalogEntry> {
  const out = new Map<string, ItemCatalogEntry>()
  for (const item of Object.values(items)) {
    if (getFinalBuildItemExclusionReason(item) !== null) continue
    const name = itemDisplayName(item) ?? item.internalKey
    if (!name) continue
    if (!out.has(name)) out.set(name, item)
  }
  return out
}

const probeFiles = readdirSync(OUT_DIR)
const fixtures = loadGroundTruthFixtures().fixtures
const gods = loadGods()
const items = loadItems()
const bestItems = bestItemRecordByName(items)

const byGod = new Map<string, Set<CoverageArea>>()
const coveredItems = new Set<string>()
for (const fixture of fixtures) {
  const godId = fixture.coverage?.godId ?? fixture.scenario.attacker.godId
  const areas = byGod.get(godId) ?? new Set<CoverageArea>()
  for (const area of fixture.coverage?.areas ?? []) areas.add(area)
  byGod.set(godId, areas)
  for (const itemName of fixture.coverage?.items ?? []) coveredItems.add(itemName)
}

const godBacklog: GodBacklogEntry[] = []
for (const godId of Object.keys(gods).sort()) {
  const abilityAreas = Object.keys(gods[godId]?.abilities ?? {}) as CoverageArea[]
  const expectedAreas = EXPECTED_GOD_AREAS.filter((area) => area === 'basic' || area === 'passive' || abilityAreas.includes(area))
  const covered = byGod.get(godId) ?? new Set<CoverageArea>()
  for (const area of expectedAreas) {
    if (covered.has(area)) continue
    godBacklog.push({
      kind: 'god',
      godId,
      area,
      fixtureIdSuggestion: `${slug(godId)}_${slug(area)}_capture`,
      scenarioTemplate: {
        title: `${godId} ${area} live capture`,
        attacker: { godId, level: 20, abilityRanks: rankBlock(), items: [] },
        defender: { godId: 'Kukulkan', level: 20 },
        rotation: scenarioRotationFor(area),
      },
      probeFiles: probeFilesForGodArea(probeFiles, godId, area),
    })
  }
}

const itemBacklog: ItemBacklogEntry[] = []
for (const [itemName, item] of [...bestItems.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (coveredItems.has(itemName)) continue
  const sourceFiles = new Set<string>()
  if (item.sourceFile) sourceFiles.add(item.sourceFile)
  for (const effect of item.geEffects ?? []) {
    if (effect.source) sourceFiles.add(effect.source)
  }
  itemBacklog.push({
    kind: 'item',
    itemName,
    fixtureIdSuggestion: `${slug(itemName)}_capture`,
    sourceFiles: [...sourceFiles],
  })
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  summary: {
    godEntries: godBacklog.length,
    itemEntries: itemBacklog.length,
  },
  gods: godBacklog,
  items: itemBacklog,
}

writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log('=== Ground-truth backlog ===')
console.log(`Missing god-area fixtures: ${godBacklog.length}`)
console.log(`Missing item fixtures: ${itemBacklog.length}`)
console.log(`Report: ${OUT_PATH}`)
