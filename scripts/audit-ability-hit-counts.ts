#!/usr/bin/env tsx

import fs from 'node:fs'
import path from 'node:path'

import { loadGods } from '../src/catalog/loadCatalogs.ts'
import { runScenario } from '../src/sim/v3/engine.ts'
import type { AbilitySlot, Scenario } from '../src/sim/v3/types.ts'

type HitAuditRow = {
  godId: string
  slot: AbilitySlot
  abilityName: string
  expectedHits: number
  actualHits: number
  description: string
  labels: string[]
}

const OUT_PATH = path.resolve('data/ability-hit-count-audit.json')
const slots: AbilitySlot[] = ['A01', 'A02', 'A03', 'A04']
const ranks = { A01: 5, A02: 5, A03: 5, A04: 5 }

function explicitHitCount(description: string): number | null {
  const leadSentence = description
    .split(/[•\n]/, 1)[0]
    .trim()
  const targeted =
    /\b(?:deal|deals|dealing|hit|hits|hitting|strike|strikes|striking|spin|spins|spinning|fire|fires|firing|slash|slashes|slashing|punch|punches|punching|attack|attacks|attacking)\b[\s\S]{0,48}?\b(\d+)\s+times\b/i.exec(leadSentence)
  if (!targeted) return null
  const count = Number(targeted[1])
  return Number.isFinite(count) && count > 1 ? count : null
}

function buildScenario(godId: string, slot: AbilitySlot): Scenario {
  return {
    title: 'ability hit count audit',
    attacker: { godId, level: 20, abilityRanks: ranks, items: [] },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot }],
  }
}

const mismatches: HitAuditRow[] = []
for (const [godId, god] of Object.entries(loadGods())) {
  for (const slot of slots) {
    const ability = god.abilities[slot]
    const description = ability?.description?.replace(/\s+/g, ' ').trim() ?? ''
    if (!ability || !description) continue
    const expectedHits = explicitHitCount(description)
    if (!expectedHits) continue

    const result = runScenario(buildScenario(godId, slot))
    const labels = result.damageEvents
      .filter((ev) => ev.source === 'ability' || ev.source === 'dot')
      .map((ev) => ev.label)
    const actualHits = labels.length
    if (actualHits === expectedHits) continue

    mismatches.push({
      godId,
      slot,
      abilityName: ability.name ?? slot,
      expectedHits,
      actualHits,
      description,
      labels,
    })
  }
}

fs.writeFileSync(OUT_PATH, JSON.stringify({
  generatedAt: new Date().toISOString(),
  mismatches,
}, null, 2))

console.log(`Wrote ${mismatches.length} ability hit-count mismatches to ${OUT_PATH}`)
for (const row of mismatches.slice(0, 25)) {
  console.log(`${row.godId} ${row.slot} ${row.abilityName}: expected ${row.expectedHits}, got ${row.actualHits}`)
}
