export interface ItemEligibilityLike {
  internalKey?: string | null
  tier?: string | null
  categories?: readonly string[]
  statTags?: readonly string[]
  storeFloats?: readonly number[]
  sourceFile?: string | null
  displayName?: string | null
  name?: string | null
}

const ITEM_DISPLAY_NAME_FALLBACKS: Record<string, string> = {
  Starter_DeathsEmbrace: "Death's Embrace",
  Starter_DeathsToll: "Death's Toll",
  Starter_GildedArrow: 'Gilded Arrow',
  Starter_GildedArrowUpgrade: 'Gilded Arrow Upgrade',
  Starter_HuntersCowl: "Hunter's Cowl",
  Starter_PendulumOfTheAges: 'Pendulum of the Ages',
  Starter_SandsOfTime: 'Sands of Time',
  Starter_SunderingAxe: 'Sundering Axe',
  Starter_SunderingAxeUpgrade: 'Sundering Axe Upgrade',
}

/** Items that exist in the game files but have been removed from live SMITE 2.
 *  They're still extracted by the catalog build (game hasn't deleted the assets
 *  yet), so we filter them here. Key on internalKey because display names can
 *  be reused when Hi-Rez reworks an item into something different. */
const DEPRECATED_ITEMS = new Set<string>([
  'item.Dominance',  // Removed from live; confirmed by user on 2026-04-22.
])

export function isDeprecatedItem(item: ItemEligibilityLike): boolean {
  return !!item.internalKey && DEPRECATED_ITEMS.has(item.internalKey)
}

function isDeprecated(item: ItemEligibilityLike): boolean {
  return isDeprecatedItem(item)
}

function categoriesOf(item: ItemEligibilityLike): readonly string[] {
  return item.categories ?? []
}

export function isCatalogHelperItem(item: ItemEligibilityLike): boolean {
  const key = `${item.internalKey ?? ''} ${item.sourceFile ?? ''}`.toLowerCase()
  return key.includes('listener') || key.includes('_psv') || key.includes('psv_')
}

export function hasMissingStatRows(item: ItemEligibilityLike): boolean {
  if (categoriesOf(item).includes('GodLocked') || (item.sourceFile ?? '').startsWith('godLocked:')) return false
  return (item.statTags?.length ?? 0) > 0 && (item.storeFloats?.length ?? 0) === 0
}

export function itemDisplayName(item: ItemEligibilityLike): string | null {
  return item.displayName
    ?? item.name
    ?? (item.internalKey ? ITEM_DISPLAY_NAME_FALLBACKS[item.internalKey] : undefined)
    ?? null
}

export function isRelicItem(item: ItemEligibilityLike): boolean {
  const categories = categoriesOf(item)
  return categories.includes('Relic')
    || categories.includes('StartingRelic')
    || categories.includes('UpgradedRelic')
}

export function isUpgradedStarter(item: ItemEligibilityLike): boolean {
  return item.tier === 'Starter' && categoriesOf(item).includes('UpgradedStarter')
}

export function isFinalBuildStarter(item: ItemEligibilityLike): boolean {
  return isUpgradedStarter(item)
}

export function getFinalBuildItemExclusionReason(item: ItemEligibilityLike): string | null {
  if (!itemDisplayName(item)) return 'missing display name'
  if (isDeprecated(item)) return 'deprecated'
  if (isCatalogHelperItem(item)) return 'helper row'

  const categories = categoriesOf(item)
  if (isRelicItem(item)) return 'relic'
  if (categories.includes('Consumable')) return 'consumable'
  if (categories.includes('Curio')) return 'curio'

  if (item.tier === 'T1' || item.tier === 'T2') return `${item.tier} component`
  if (item.tier === 'Starter' && !isUpgradedStarter(item)) return 'base starter'
  if (hasMissingStatRows(item)) return 'missing stat rows'
  if (item.tier === 'T3' || isUpgradedStarter(item)) return null

  return 'unknown tier'
}

export function isFinalBuildItem(item: ItemEligibilityLike): boolean {
  return getFinalBuildItemExclusionReason(item) === null
}

export function itemRecordPriority(item: ItemEligibilityLike): number {
  let score = 0

  if (isFinalBuildItem(item)) score += 1000
  if (item.tier) score += 100
  score += (item.statTags?.length ?? 0) * 10
  score += (item.storeFloats?.length ?? 0) * 5
  if (item.displayName) score += 2

  if (isCatalogHelperItem(item)) score -= 500

  return score
}

export function shouldPreferItemRecord(
  candidate: ItemEligibilityLike,
  current: ItemEligibilityLike | null | undefined,
): boolean {
  if (!current) return true
  return itemRecordPriority(candidate) > itemRecordPriority(current)
}
