#!/usr/bin/env tsx

import { getItem, loadItems } from '../src/catalog/loadCatalogs.ts'
import {
  getFinalBuildItemExclusionReason,
  hasMissingStatRows,
  isCatalogHelperItem,
  itemDisplayName,
  shouldPreferItemRecord,
} from '../src/catalog/itemEligibility.ts'
import { getItemProcs } from '../src/sim/v3/itemEffects.ts'

type Item = ReturnType<typeof loadItems>[string]

function passiveLooksSimRelevant(item: Item): boolean {
  const passive = item.passive ?? ''
  return /\b(On Use|Active|Ability Hit|Ability Used|Attack Hit|Basic Attack Hit|Hit this Attack|Every|Kill or Assist|Stack|Below|When|For every|Critical Strike Damage|Critically Strike|Enemies Within|Abilities deal bonus|Attacks deal bonus|Lifesteal empowers|Cooldown|Strength|Intelligence|Protections?)\b/i.test(passive)
}

const ENGINE_HANDLED_WITHOUT_PROC = new Map<string, string>([
  ['item.Bagua Mirror', 'incoming Magical Damage conditional stats are registered in conditionalItems and apply when forceConditionalItemEffects is enabled'],
  ['Item.BerserkersShield', 'low-health conditional Attack Speed is registered in conditionalItems and applies when forceConditionalItemEffects is enabled'],
  ['item.BancroftsTalon', 'missing-health Intelligence and Lifesteal are registered in conditionalItems and apply when forceConditionalItemEffects is enabled'],
  ['item.BookOfThoth', 'mana stacks and mana-to-Intelligence conversion are applied in snapshotAttacker'],
  ['item.DevourersGauntlet', 'Strength/lifesteal stacks are applied by generic stack parsing'],
  ['Item.DoomOrb', 'temporary Intelligence stacks are applied only from explicit partialStacks, not optimizer auto-evolve'],
  ['item.The Nemes', 'Gauntlet of Thebes health stacks are applied by generic stack parsing'],
  ['item.Necronomicon', 'God kill/assist Intelligence stacks are applied only from explicit partialStacks, not optimizer auto-evolve'],
  ['item.Rage', 'God kill/assist Critical Strike stacks are applied only from explicit partialStacks, not optimizer auto-evolve'],
  ['item.NimbleRing', 'Intelligence-to-Attack-Damage/Attack-Speed conversion is applied in snapshotAttacker'],
  ['item.Deathbringer', 'Critical Strike Damage is applied in basic crit math from passive text'],
  ['item.EldritchOrb', 'Rod of Tahuti current-Intelligence multiplier is applied in snapshotAttacker from GE data'],
  ['item.Staff of Cosmic Horror', 'Cooldown-vs-Echo Intelligence mode is applied in snapshotAttacker'],
  ["item.Triton's Conch", 'Strength/Intelligence aura is applied in snapshotAttacker'],
  ['Item.TyphonsFang', 'Lifesteal-to-Intelligence conversion is applied in snapshotAttacker'],
  ['Starter_ArchmagesGem', 'upgraded starter adaptive stats are mined from GE data; vague bonus-damage passive remains covered by timeAwareItems/assumptions until exact live formula is confirmed'],
  ['item.BreastplateOfValor', 'incoming damage / self-healing cooldown trigger is defensive and not part of outgoing damage totals'],
  ['item.Blinking Amulet', 'teleport active has no direct outgoing damage component'],
  ['item.Emblem of Namaka', 'shield active has no direct outgoing damage component'],
  ['Item.GenjisGuard', 'incoming magical ability damage cooldown trigger is defensive and not part of outgoing damage totals'],
  ['Item.GluttonousGrimoir', 'basic-attack lifesteal empowerment formula is not exposed clearly enough in mined text; treated as unresolved utility rather than silently adding damage'],
  ['item.Hussar\'s Wings', 'slow immunity has no direct outgoing damage component'],
  ['item.Leviathan\'s Hide', 'incoming damage debuffs and permanent health stacking require incoming/enemy action state'],
  ['item.Mercury\'s Talaria', 'out-of-combat movement charge damage is conditional scenario state and is not assumed baseline'],
  ['item.Musashi\'s Dual Swords', 'crit-triggered movement speed has no direct outgoing damage component'],
  ['Item.MysticalMail', 'periodic proximity aura damage requires combat-window aura ticking and is documented as not included in instant rotations'],
  ['item.PhantomRing', 'wall/impediment immunity active has no direct outgoing damage component'],
  ['Item.RegrowthStriders', 'healing-triggered movement/heal effects have no direct outgoing damage component'],
  ['Item.RuneforgedHammer', 'hard-CC mark into attack proc requires authored hard-CC target state before it can fire'],
  ['Item.SpearOfDesolation', 'god kill/assist cooldown refund is not applied inside a pre-kill single-target rotation'],
  ['item.Silken Mailcoat', 'critical-damage reduction is defensive and not part of outgoing damage totals'],
  ['item.SpiritRobe', 'hard-CC conditional protections are registered in conditionalItems and apply when forceConditionalItemEffects is enabled'],
  ['item.TheWorldStone', 'ultimate-only cooldown modifier affects future cooldown timing, not immediate damage math'],
  ['Item.UmbralLink', 'ally lifesteal-sharing protection trigger needs healing/ally scenario state'],
])

function itemKey(item: Item): string {
  return item.internalKey ?? itemDisplayName(item) ?? 'unknown'
}

function groupByName(rows: Array<[string, Item]>): Map<string, Array<[string, Item]>> {
  const grouped = new Map<string, Array<[string, Item]>>()
  for (const row of rows) {
    const name = itemDisplayName(row[1])
    if (!name) continue
    const bucket = grouped.get(name) ?? []
    bucket.push(row)
    grouped.set(name, bucket)
  }
  return grouped
}

function describeRows(rows: Array<[string, Item]>, limit = 12): string[] {
  return rows.slice(0, limit).map(([key, item]) => {
    const name = itemDisplayName(item) ?? key
    return `  - ${name} (${itemKey(item)})`
  })
}

const items = loadItems()
const allRows = Object.entries(items)
const finalRows = allRows.filter(([, item]) => getFinalBuildItemExclusionReason(item) === null)
const excludedRows = allRows.filter(([, item]) => getFinalBuildItemExclusionReason(item) !== null)

const helperRows = finalRows.filter(([, item]) => isCatalogHelperItem(item))
const missingStatRows = finalRows.filter(([, item]) => hasMissingStatRows(item))

const duplicateGroups = [...groupByName(finalRows).entries()].filter(([, rows]) => rows.length > 1)
const duplicateResolutionFailures: string[] = []
for (const [name, rows] of duplicateGroups) {
  const expected = rows.reduce<Item | null>(
    (best, [, item]) => shouldPreferItemRecord(item, best) ? item : best,
    null,
  )
  const resolved = getItem(name)
  if (expected && itemKey(resolved) !== itemKey(expected)) {
    duplicateResolutionFailures.push(`  - ${name}: getItem resolved ${itemKey(resolved)}, expected ${itemKey(expected)}`)
  }
}

const procReviewRows = finalRows.filter(([, item]) =>
  passiveLooksSimRelevant(item)
  && getItemProcs(item).length === 0
  && !ENGINE_HANDLED_WITHOUT_PROC.has(itemKey(item)))
const engineHandledNoProcRows = finalRows.filter(([, item]) =>
  passiveLooksSimRelevant(item)
  && getItemProcs(item).length === 0
  && ENGINE_HANDLED_WITHOUT_PROC.has(itemKey(item)))

const hardFailures: string[] = []
if (helperRows.length > 0) {
  hardFailures.push(`Helper/listener rows are still final-build eligible:\n${describeRows(helperRows).join('\n')}`)
}
if (missingStatRows.length > 0) {
  hardFailures.push(`Rows with stat tags but no numeric stat rows are still final-build eligible:\n${describeRows(missingStatRows).join('\n')}`)
}
if (duplicateResolutionFailures.length > 0) {
  hardFailures.push(`Duplicate display-name resolution is not selecting the preferred row:\n${duplicateResolutionFailures.join('\n')}`)
}
if (procReviewRows.length > 0) {
  hardFailures.push(`Final items have sim-relevant passives with no proc hook or documented engine handler:\n${describeRows(procReviewRows, 20).join('\n')}`)
}

console.log('=== Final item audit ===')
console.log(`Catalog rows: ${allRows.length}`)
console.log(`Final-build eligible rows: ${finalRows.length}`)
console.log(`Excluded rows: ${excludedRows.length}`)
console.log(`Duplicate final display names: ${duplicateGroups.length}`)
console.log(`Proc-like final passives handled in stat/snapshot engine: ${engineHandledNoProcRows.length}`)
console.log(`Proc-like final passives without damage/utility hooks: ${procReviewRows.length}`)

if (duplicateGroups.length > 0) {
  console.log()
  console.log('Duplicate final display names resolved by item priority:')
  for (const [name, rows] of duplicateGroups.slice(0, 12)) {
    console.log(`  - ${name}: ${rows.map(([, item]) => itemKey(item)).join(', ')}`)
  }
}

if (engineHandledNoProcRows.length > 0) {
  console.log()
  console.log('Proc-like final passives covered outside item proc hooks:')
  for (const [, item] of engineHandledNoProcRows.slice(0, 20)) {
    console.log(`  - ${itemDisplayName(item) ?? itemKey(item)} (${itemKey(item)}): ${ENGINE_HANDLED_WITHOUT_PROC.get(itemKey(item))}`)
  }
}

if (hardFailures.length > 0) {
  console.error()
  console.error(hardFailures.join('\n\n'))
  process.exitCode = 1
} else {
  console.log()
  console.log('Final item audit passed.')
}
