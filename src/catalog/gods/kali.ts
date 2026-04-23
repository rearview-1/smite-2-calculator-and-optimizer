import { readCurveTable, pickStatCurve } from '../ingest.ts'
import type { GodDef, StatTag } from '../types.ts'

const OUT = 'tools/SmiteAssetProbe/out'
const STATS = `${OUT}/Hemingway_Content_Characters_GODS_Kali_CT_Kali_Stats.exports.json`
const A01 = `${OUT}/Hemingway_Content_Characters_GODS_Kali_Common_Abilities_Ability1_LevelConfigs_CT_Kali_A01_EffectValues.exports.json`
const A02 = `${OUT}/Hemingway_Content_Characters_GODS_Kali_Common_Abilities_Ability2_LevelConfigs_CT_Kali_A02_EffectValues.exports.json`
const A03 = `${OUT}/Hemingway_Content_Characters_GODS_Kali_Common_Abilities_Ability3_LevelConfigs_CT_Kali_A03_EffectValues.exports.json`

const STAT_TAGS: StatTag[] = [
  'MaxHealth',
  'MaxMana',
  'HealthPerTime',
  'ManaPerTime',
  'PhysicalProtection',
  'MagicalProtection',
  'MovementSpeed',
  'BaseAttackSpeed',
  'AttackSpeedPercent',
  'InhandPower',
  'PhysicalPenetrationFlat',
  'PhysicalPenetrationPercent',
  'CritChance',
  'CooldownReductionPercent',
  'PhysicalInhandLifestealPercent',
  'PhysicalAbilityLifestealPercent',
]

export function loadKali(): GodDef {
  const statTable = readCurveTable(STATS)
  const a01 = readCurveTable(A01)
  const a02 = readCurveTable(A02)
  const a03 = readCurveTable(A03)

  const statCurves: GodDef['statCurves'] = {}
  for (const tag of STAT_TAGS) {
    const curve = pickStatCurve(statTable, tag)
    if (curve) statCurves[tag] = curve
  }

  return {
    id: 'kali',
    displayName: 'Kali',
    primaryDamageType: 'physical',
    statCurves,
    basicChain: [1.0, 0.5, 0.5],
    abilities: {
      A1: {
        slot: 'A1',
        displayName: 'Nimble Strike',
        rankValues: a01,
        tags: ['leap', 'rupture-applier'],
      },
      A2: {
        slot: 'A2',
        displayName: 'Lash',
        rankValues: a02,
        tags: ['stun', 'bleed'],
      },
      A3: {
        slot: 'A3',
        displayName: 'Tormented Strike',
        rankValues: a03,
        tags: ['steroid', 'stun'],
      },
      A4: null,
      Passive: null,
    },
  }
}
