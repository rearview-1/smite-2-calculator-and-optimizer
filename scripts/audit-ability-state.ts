#!/usr/bin/env tsx

import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { loadGods } from '../src/catalog/loadCatalogs.ts'
import { buildAbilityPlan } from '../src/sim/v3/abilityResolver.ts'
import { getGodHandler } from '../src/sim/v3/godHandlers.ts'

type AuditRow = {
  godId: string
  slot: 'A01' | 'A02' | 'A03' | 'A04'
  name: string | null
  description: string | null
  rows: string[]
  stateComponents: string[]
}

const OUT_PATH = path.resolve('data/ability-state-audit.json')
const gods = loadGods()
const rows: AuditRow[] = []

for (const [godId, god] of Object.entries(gods)) {
  for (const slot of ['A01', 'A02', 'A03', 'A04'] as const) {
    const ability = god.abilities?.[slot]
    if (!ability?.rankValues) continue
    const interestingRows = Object.keys(ability.rankValues).filter((row) =>
      /Penetration|ProtDebuff|Protection Debuff|ProtectionsDebuff|Mag(?:ical)?ProtDebuff|Damage Amp/i.test(row))
    if (interestingRows.length === 0) continue
    if (getGodHandler(godId, slot)) continue
    const plan = buildAbilityPlan(god, slot, 5)
    const stateComponents = (plan?.components ?? [])
      .filter((component) => component.kind === 'self-buff' || component.kind === 'enemy-debuff')
      .map((component) => `${component.kind}:${component.label}`)
    if (stateComponents.length > 0) continue
    rows.push({
      godId,
      slot,
      name: ability.name,
      description: ability.description,
      rows: interestingRows,
      stateComponents,
    })
  }
}

writeFileSync(OUT_PATH, `${JSON.stringify(rows, null, 2)}\n`, 'utf8')

console.log('=== Ability state audit ===')
console.log(`Open ability state rows: ${rows.length}`)
console.log(`Report: ${OUT_PATH}`)
if (rows.length > 0) {
  console.log()
  for (const row of rows.slice(0, 20)) {
    console.log(`  - ${row.godId} ${row.slot} ${row.name ?? '(unnamed)'} :: ${row.rows.join(', ')}`)
  }
}
