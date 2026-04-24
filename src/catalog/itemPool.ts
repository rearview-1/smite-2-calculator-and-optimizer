export interface ItemPoolResolvedStats {
  stats: Record<string, number>
  adaptiveStrength: number
  adaptiveIntelligence: number
  adaptiveChoice?: { strength: number; intelligence: number } | null
}

export interface ItemPoolCandidate {
  categories?: readonly string[]
  statTags?: readonly string[]
  resolvedStats?: ItemPoolResolvedStats | null
}

function statValue(stats: ItemPoolResolvedStats | null | undefined, key: string): number {
  return stats?.stats[key] ?? 0
}

function hasPhysicalSignal(item: ItemPoolCandidate): boolean {
  const stats = item.resolvedStats
  const tags = new Set(item.statTags ?? [])
  return (stats?.adaptiveStrength ?? 0) > 0
    || !!stats?.adaptiveChoice
    || statValue(stats, 'PhysicalPenetrationFlat') > 0
    || statValue(stats, 'PhysicalPenetrationPercent') > 0
    || statValue(stats, 'PhysicalInhandLifestealPercent') > 0
    || tags.has('CritChance')
    || tags.has('AttackSpeedPercent')
}

function hasMagicalSignal(item: ItemPoolCandidate): boolean {
  const stats = item.resolvedStats
  return (stats?.adaptiveIntelligence ?? 0) > 0
    || !!stats?.adaptiveChoice
    || statValue(stats, 'MagicalPenetrationFlat') > 0
    || statValue(stats, 'MagicalPenetrationPercent') > 0
    || statValue(stats, 'MagicalLifestealPercent') > 0
    || statValue(stats, 'MaxMana') > 0
}

function hasStrengthOnlyMainStat(item: ItemPoolCandidate): boolean {
  const stats = item.resolvedStats
  return (stats?.adaptiveStrength ?? 0) > 0
    && (stats?.adaptiveIntelligence ?? 0) <= 0
    && !stats?.adaptiveChoice
}

function hasIntelligenceOnlyMainStat(item: ItemPoolCandidate): boolean {
  const stats = item.resolvedStats
  return (stats?.adaptiveIntelligence ?? 0) > 0
    && (stats?.adaptiveStrength ?? 0) <= 0
    && !stats?.adaptiveChoice
}

export function itemMatchesStrictOffensePreset(
  item: ItemPoolCandidate,
  preset: 'physical' | 'magical',
  isHybridGod: boolean,
): boolean {
  if (isHybridGod) return hasPhysicalSignal(item) || hasMagicalSignal(item) || (item.categories ?? []).includes('Hybrid')

  if (preset === 'physical') {
    if (hasIntelligenceOnlyMainStat(item) && !hasPhysicalSignal(item)) return false
    if (hasIntelligenceOnlyMainStat(item)) return false
    return hasPhysicalSignal(item)
  }

  if (hasStrengthOnlyMainStat(item) && !hasMagicalSignal(item)) return false
  if (hasStrengthOnlyMainStat(item)) return false
  return hasMagicalSignal(item)
}
