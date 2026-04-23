import { readCurveTable, pickStatCurve } from '../ingest.ts'
import type { GodDef, StatTag } from '../types.ts'

const STATS =
  'tools/SmiteAssetProbe/out/Hemingway_Content_Characters_GODS_Kukulkan_CT_Kukulkan_Stats.exports.json'

const STAT_TAGS: StatTag[] = [
  'MaxHealth',
  'MaxMana',
  'PhysicalProtection',
  'MagicalProtection',
  'MovementSpeed',
  'BaseAttackSpeed',
  'AttackSpeedPercent',
  'MagicalPower',
]

export function loadKukulkan(): GodDef {
  const statTable = readCurveTable(STATS)

  const statCurves: GodDef['statCurves'] = {}
  for (const tag of STAT_TAGS) {
    const curve = pickStatCurve(statTable, tag)
    if (curve) statCurves[tag] = curve
  }

  return {
    id: 'kukulkan',
    displayName: 'Kukulkan',
    primaryDamageType: 'magical',
    statCurves,
    basicChain: [1.0],
    abilities: { A1: null, A2: null, A3: null, A4: null, Passive: null },
  }
}
