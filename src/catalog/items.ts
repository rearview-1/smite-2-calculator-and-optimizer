import { applyStatOverride, extractItemStats } from './itemIngest.ts'
import type { ItemDef, StatTag } from './types.ts'

const OUT = 'tools/SmiteAssetProbe/out'

function flatStatsFromStructure(
  structurePath: string,
  order: StatTag[],
): { flatStats: Partial<Record<StatTag, number>>; adaptiveStrength?: number; adaptiveIntelligence?: number } {
  const extraction = extractItemStats(structurePath)
  const paired = applyStatOverride(extraction, { order })

  const flat: Partial<Record<StatTag, number>> = {}
  let adaptiveStrength: number | undefined
  let adaptiveIntelligence: number | undefined

  for (const { tag, value } of paired) {
    if (tag === 'Strength') {
      adaptiveStrength = (adaptiveStrength ?? 0) + value
    } else if (tag === 'Intelligence') {
      adaptiveIntelligence = (adaptiveIntelligence ?? 0) + value
    } else {
      flat[tag] = (flat[tag] ?? 0) + value
    }
  }

  return { flatStats: flat, adaptiveStrength, adaptiveIntelligence }
}

// Hydra's Lament — flat stats derived from the probed EquipmentItem export,
// with the struct-declaration order determined empirically (floats in the raw
// export bytes appear in this order even though the NameMap is alphabetical):
//   PhysicalPower, MaxMana, ManaPerTime, CooldownReductionPercent.
// Interpreted mapping:
//   PhysicalPower 45  → adaptive Strength (SMITE 2 routes PhysicalPower to Strength for melee STR gods)
//   MaxMana 200       → flat
//   ManaPerTime 4     → flat (per second in-game)
//   CooldownReductionPercent 10 → flat
const hydraStats = flatStatsFromStructure(
  `${OUT}/Hemingway_Content_Items_November2023_HydrasLament_EquipmentItem_Item_HydrasLament.structure.json`,
  ['Strength', 'MaxMana', 'ManaPerTime', 'CooldownReductionPercent'],
)

export const hydrasLament: ItemDef = {
  id: 'hydras-lament',
  displayName: "Hydra's Lament",
  tier: 't3',
  flatStats: hydraStats.flatStats,
  adaptiveStrength: hydraStats.adaptiveStrength,
  effects: [
    {
      kind: 'onAbilityHit_nextBasic',
      powerMultiplier: 0.30,
      damageType: 'physical',
      id: 'hydra-firstbasic',
      note: 'First basic after an ability deals +30% of power as bonus damage (game tooltip value; pending confirmation via Hydra GE probe).',
    },
  ],
}

// Bluestone Pendant, Book of Thoth, Polynomicon: Kukulkan-side items, not probed yet.
// Probe via: npm run probe:smite-files -- --package=Hemingway/Content/Items/<path>
// Then add similar flatStatsFromStructure() calls with the per-item order override.

// Bumba's Cudgel — flat stats come from three GE files (not the EquipmentItem).
// Confirmed via probe:
//   GE_Items_BumbasCudgel  → +75 MaxHealth, +50 MaxMana (floats 75, 50 in export)
//   GE_BumbasCudgel_STRBuff → +15 Strength (adaptive aspect)
// True-damage procs still pending GE ingest; item effect formulas below are
// placeholders from the handoff.
export const bumbasCudgel: ItemDef = {
  id: 'bumbas-cudgel',
  displayName: "Bumba's Cudgel",
  tier: 'starter',
  flatStats: {
    MaxHealth: 75,
    MaxMana: 50,
  },
  adaptiveStrength: 15,
  effects: [
    {
      kind: 'onBasicHit_trueDamage',
      perHit: 50,
      maxTriggers: 3,
      id: 'bumba-perbasic',
      note: '+50 true damage per basic for the first three basics (placeholder formula, pending proc-GE ingest)',
    },
    {
      kind: 'onAbilityCast_nextBasic',
      bonusDamage: 10,
      damageType: 'true',
      id: 'bumba-postability',
      note: '+10 true damage on the next basic after an ability cast (placeholder, pending proc-GE ingest)',
    },
  ],
}

export const bluestonePendant: ItemDef = {
  id: 'bluestone-pendant',
  displayName: 'Bluestone Pendant',
  tier: 'starter',
  flatStats: {},
  effects: [],
}

export const bookOfThoth: ItemDef = {
  id: 'book-of-thoth',
  displayName: 'Book of Thoth (stacked/evolved)',
  tier: 'evolved',
  flatStats: {},
  effects: [
    {
      kind: 'flatStackedPower',
      perStackIntelligence: 1,
      maxStacks: 75,
      id: 'thoth-stacks',
      note: 'pending probe: fully stacked intelligence scaling',
    },
  ],
}

export const polynomicon: ItemDef = {
  id: 'polynomicon',
  displayName: 'Polynomicon',
  tier: 't3',
  flatStats: {},
  effects: [
    {
      kind: 'onAbilityHit_nextBasic',
      powerMultiplier: 1.0,
      damageType: 'magical',
      id: 'poly-postability',
      note: 'pending probe: basic after an ability cast deals bonus magical damage based on power',
    },
  ],
}
