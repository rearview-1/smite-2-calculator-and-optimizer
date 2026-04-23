import { readFileSync } from 'node:fs'
import { interp, type Curve } from './curve.ts'
import { itemDisplayName, shouldPreferItemRecord } from './itemEligibility.ts'

// ---- Catalog JSON shapes (mirroring the Python-built artifacts) ----

export interface GodCatalogEntry {
  god: string
  effectsKey: string | null
  stats: Record<string, Curve>
  abilities: Record<'A01' | 'A02' | 'A03' | 'A04', AbilityCatalogEntry>
  passive: {
    name: string | null
    description: string | null
    allDescriptions?: Record<string, string>
    talentVariants?: Record<string, string>
  }
  abilityEffects?: Record<string, GeEffectSummary[]>
  talents?: Record<string, { effects: GeEffectSummary[] }>
}

export interface AbilityCatalogEntry {
  name: string | null
  description: string | null
  damageType: 'physical' | 'magical' | 'true' | null
  scalingTags: string[]
  rankValues: Record<string, Curve> | null
}

export interface GeEffectSummary {
  source: string
  tags: string[]
  asciiRefs: string[]
  interestingFloats: Array<{ export: string; offset: number; value: number }>
}

export interface ItemCatalogEntry {
  internalKey: string | null
  displayName: string | null
  tier: string | null
  categories: string[]
  roles: string[]
  keywords: string[]
  statTags: string[]
  storeFloats: number[]
  passive: string | null
  passiveRaw?: string | null
  sourceFile: string
  recipeStepCost?: number | null
  recipeComponents?: string[] | null
  totalCost?: number | null
  geEffects?: GeEffectSummary[]
}

export interface BuffCatalogEntry {
  name: string | null
  description: string | null
  descriptionRaw?: string | null
  source: { namesTable: string | null; descTable: string | null }
}

export interface EffectsCatalog {
  buffs: Record<string, BuffCatalogEntry>
  godPassives: Record<string, {
    god: string
    passiveName: string | null
    passiveKey: string | null
    passiveDescription: string | null
    passiveDescriptionKey?: string | null
    passiveDescriptionsAll?: Record<string, string>
    talentPassives?: Record<string, string>
    abilities?: Record<string, { name: string | null; description: string | null; descriptionKey?: string | null }>
    sources?: { namesTable: string | null; descTable: string | null }
  }>
}

// ---- Singleton loaders (read once, cached in module-level) ----

let _gods: Record<string, GodCatalogEntry> | null = null
let _items: Record<string, ItemCatalogEntry> | null = null
let _effects: EffectsCatalog | null = null

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T
}

export function loadGods(): Record<string, GodCatalogEntry> {
  if (!_gods) _gods = readJson('data/gods-catalog.json')
  return _gods!
}

export function loadItems(): Record<string, ItemCatalogEntry> {
  if (!_items) _items = readJson('data/items-catalog.json')
  return _items!
}

export function loadEffects(): EffectsCatalog {
  if (!_effects) _effects = readJson('data/effects-catalog.json')
  return _effects!
}

export interface AbilityTiming {
  castDuration?: number
  damageApplyOffset?: number
  channelDuration?: number
  hitInterval?: number
  finalHitOffset?: number
  shape?: string
}

export type AbilityTimingShape = 'direct' | 'dot' | 'channel' | 'burst'

export interface AbilityTimingsCatalog {
  _schema?: unknown
  _genericDefaults: Record<AbilityTimingShape, AbilityTiming>
  [godId: string]: unknown
}

let _timings: AbilityTimingsCatalog | null = null
export function loadAbilityTimings(): AbilityTimingsCatalog {
  if (!_timings) _timings = readJson('data/ability-timings.json')
  return _timings!
}

/**
 * Look up a god+slot's timing, falling back to the generic shape default.
 * Returns merged timing where god-specific fields override the shape default.
 */
export function getAbilityTiming(
  godId: string,
  slot: 'A01' | 'A02' | 'A03' | 'A04',
  shape?: AbilityTimingShape,
): Required<AbilityTiming> {
  const cat = loadAbilityTimings()
  const godEntry = cat[godId] as Record<string, AbilityTiming> | undefined
  const explicit = godEntry?.[slot] ?? {}
  const explicitShape = explicit.shape
  const resolvedShape: AbilityTimingShape =
    shape
    ?? (explicitShape === 'dot' || explicitShape === 'channel' || explicitShape === 'burst' || explicitShape === 'direct'
      ? explicitShape
      : 'direct')
  const shapeDefault = cat._genericDefaults[resolvedShape] ?? {}
  return {
    castDuration: explicit.castDuration ?? shapeDefault.castDuration ?? 0.35,
    damageApplyOffset: explicit.damageApplyOffset ?? shapeDefault.damageApplyOffset ?? 0,
    channelDuration: explicit.channelDuration ?? shapeDefault.channelDuration ?? 0,
    hitInterval: explicit.hitInterval ?? shapeDefault.hitInterval ?? 0.4,
    finalHitOffset: explicit.finalHitOffset ?? shapeDefault.finalHitOffset ?? 0,
    shape: explicit.shape ?? resolvedShape,
  }
}

/**
 * Per-god basic-attack chain swing times (authored seconds, scaled by 1/AS at runtime).
 * Fire_01.uasset → chain[0], Fire_02.uasset → chain[1], etc. Returns null if the god
 * has no chain data; caller should fall back to a 1-hit [1.0] chain.
 */
export function getBasicChain(godId: string): number[] | null {
  const cat = loadAbilityTimings()
  const entry = cat[godId] as Record<string, unknown> | undefined
  const chain = entry?._basicChain
  if (Array.isArray(chain) && chain.length > 0) return chain as number[]
  return null
}

// ---- Lookups with normalized spelling tolerance ----

function normKey(s: string): string {
  return s.toLowerCase().replace(/[_\-'\s]/g, '')
}

export function getGod(idOrName: string): GodCatalogEntry {
  const gods = loadGods()
  // Direct match first
  if (idOrName in gods) return gods[idOrName]
  // Normalized match (Baron_Samedi → BaronSamedi, Nu_Wa → NuWa, DaJi → Daji, etc.)
  const target = normKey(idOrName)
  for (const [k, v] of Object.entries(gods)) {
    if (normKey(k) === target) return v
  }
  throw new Error(`God not found: ${idOrName}`)
}

export function getItem(displayNameOrKey: string): ItemCatalogEntry {
  const items = loadItems()
  if (displayNameOrKey in items) return items[displayNameOrKey]
  const target = normKey(displayNameOrKey)
  // Some items have BOTH a current record (e.g. `item.TheCrusher`, post-rework)
  // and a stale duplicate with the same normalized key (e.g. `TheCrusher`,
  // pre-rework). Iterate every candidate and let `shouldPreferItemRecord`
  // pick the one with more complete stats — never return on first match.
  let best: ItemCatalogEntry | null = null
  for (const [k, v] of Object.entries(items)) {
    const keyMatches = normKey(k) === target
    const displayName = itemDisplayName(v)
    const displayMatches = displayName != null && normKey(displayName) === target
    if (!keyMatches && !displayMatches) continue
    if (shouldPreferItemRecord(v, best)) best = v
  }
  if (best) return best
  throw new Error(`Item not found: ${displayNameOrKey}`)
}

export function getBuff(keyOrName: string): BuffCatalogEntry {
  const { buffs } = loadEffects()
  if (keyOrName in buffs) return buffs[keyOrName]
  const target = normKey(keyOrName)
  for (const [k, v] of Object.entries(buffs)) {
    if (normKey(k) === target) return v
    if (v.name && normKey(v.name) === target) return v
  }
  throw new Error(`Buff not found: ${keyOrName}`)
}

// ---- Curve interpolation helpers tied to the catalog ----

export function statAt(god: GodCatalogEntry, statKey: string, level: number): number {
  const curve = god.stats[statKey]
  if (!curve) return 0
  return interp(curve, level)
}

export function abilityRowAt(
  god: GodCatalogEntry,
  slot: 'A01' | 'A02' | 'A03' | 'A04',
  row: string,
  rank: number,
): number | null {
  const ability = god.abilities[slot]
  if (!ability || !ability.rankValues) return null
  const curve = ability.rankValues[row]
  if (!curve) return null
  return interp(curve, rank)
}

// ---- Item stat mapping: catalog storeFloats paired with statTags ----
// The catalog tags come alphabetized; the storeFloats are in struct-declaration order
// which for most items matches a known convention. We supply per-item overrides when
// needed, but for now we apply the same pairing strategy that validated against
// the Kali stat screen (see items.ts in the previous sim).

export interface ResolvedItemStats {
  // Numerical stats by canonical tag (without Character.Stat. prefix)
  stats: Record<string, number>
  // Adaptive stats are tracked separately because they only apply to an STR/INT god
  adaptiveStrength: number
  adaptiveIntelligence: number
  adaptiveChoice?: { strength: number; intelligence: number }
}

/** Plausibility filter for adaptive values mined from geEffects. Game files
 *  sprinkle 128 (byte padding) and other sentinels into float blobs; real
 *  adaptive stats in SMITE 2 are in a bounded range. Also exclude 0 and exact
 *  integer powers of two which are usually offsets, not stat values. */
function plausibleAdaptiveValue(v: number): boolean {
  if (!(v > 0)) return false
  if (v === 128 || v === 256 || v === 512 || v === 1024 || v === 2048 || v === 8192) return false
  return v >= 10 && v <= 200
}

/** Fallback: when an item's tooltip passive is missing the "Adaptive Stat:"
 *  line (true for several upgraded starters — Death's Embrace, Archmage's Gem,
 *  Hunter's Cowl, Pendulum of the Ages, etc.), mine the paired
 *  GE_Items_Str_* / GE_Items_Int_* effects for the values. The game stores
 *  them in `asciiRefs: ['PhysicalPowerItem' | 'MagicalPowerItem']` with one
 *  numeric value per effect. */
function parseAdaptiveFromGeEffects(item: ItemCatalogEntry): ResolvedItemStats['adaptiveChoice'] {
  const ges = item.geEffects
  if (!ges || ges.length === 0) return undefined
  const strCandidates: number[] = []
  const intCandidates: number[] = []
  for (const ge of ges) {
    const refs = ge.asciiRefs ?? []
    const hasPhys = refs.includes('PhysicalPowerItem')
    const hasMag = refs.includes('MagicalPowerItem')
    if (!hasPhys && !hasMag) continue
    const values = (ge.interestingFloats ?? [])
      .map((f) => f.value)
      .filter(plausibleAdaptiveValue)
    if (values.length === 0) continue
    // Some items (e.g. Archmage's Gem) have entries for both refs on a single
    // GE; those GEs typically carry a single correct numeric stat, so we
    // only attribute the value when the GE is unambiguously STR or INT.
    if (hasPhys && !hasMag) strCandidates.push(...values)
    else if (hasMag && !hasPhys) intCandidates.push(...values)
  }
  // Pick the MAX value from each side — multiple entries can appear (Pendulum
  // of the Ages has two PhysicalPowerItem GEs, one with real data, one empty
  // or upgrade-tier). The largest plausible value is the final-form value.
  if (strCandidates.length === 0 && intCandidates.length === 0) return undefined
  const strength = strCandidates.length > 0 ? Math.max(...strCandidates) : 0
  const intelligence = intCandidates.length > 0 ? Math.max(...intCandidates) : 0
  if (strength === 0 && intelligence === 0) return undefined
  return { strength, intelligence }
}

function parseAdaptiveStat(item: ItemCatalogEntry): ResolvedItemStats['adaptiveChoice'] {
  const passive = item.passive
  if (passive) {
    const m = passive.match(/Adaptive Stat:\s*\+([\d.]+)\s+Strength\s+or\s+\+([\d.]+)\s+Intelligence/i)
    if (m) return { strength: Number(m[1]), intelligence: Number(m[2]) }
  }
  // geEffects fallback — ONLY for starters. Every upgraded starter in SMITE 2
  // grants adaptive at level 20, and several have null/partial passive text
  // (Death's Embrace, Archmage's Gem, Hunter's Cowl, etc.). Non-starter items
  // (Transcendence, Hydra's Lament, Avenging Blade, …) also carry
  // PhysicalPowerItem asciiRefs for unrelated reasons (evolve bonuses, base
  // power stats) and would be misread as false adaptive bonuses. Restricting
  // to tier=Starter makes the fallback safe.
  if (item.tier !== 'Starter') return undefined
  return parseAdaptiveFromGeEffects(item)
}

function canonicalStatTag(tag: string, allTags: string[]): string {
  if (tag === 'Strength' || tag === 'PhysicalPower') return 'PhysicalPower'
  if (tag === 'Intelligence' || tag === 'MagicalPower') return 'MagicalPower'
  if (tag === 'PhysicalProtectionItem') return 'PhysicalProtection'
  if (tag === 'MagicalProtectionItem') return 'MagicalProtection'
  if (tag === 'CrowdControlReductionItem') return 'CrowdControlReduction'
  if (tag === 'PathfindingItem') return 'Pathfinding'
  if (tag === 'LifeStealPercent') {
    if (allTags.some((t) => t === 'PhysicalPower' || t === 'Strength')) return 'PhysicalInhandLifestealPercent'
    if (allTags.some((t) => t === 'MagicalPower' || t === 'Intelligence')) return 'MagicalLifestealPercent'
  }
  return tag
}

function rangeScore(value: number, min: number, max: number, idealMin = min, idealMax = max): number {
  if (value >= idealMin && value <= idealMax) return 100
  if (value >= min && value <= max) return 70
  const distance = value < min ? min - value : value - max
  return Math.max(-100, 40 - distance * 2)
}

function statValueScore(tag: string, value: number, allTags: string[]): number {
  const canonical = canonicalStatTag(tag, allTags)
  switch (canonical) {
    case 'PhysicalPower': return rangeScore(value, 5, 110, 10, 80)
    case 'MagicalPower': return rangeScore(value, 10, 170, 20, 120)
    case 'InhandPower': return rangeScore(value, 5, 40, 8, 30)
    case 'MaxHealth': return rangeScore(value, 70, 800, 100, 600)
    case 'MaxMana': return rangeScore(value, 50, 600, 100, 450)
    case 'HealthPerTime': return rangeScore(value, 0.5, 15, 1, 8)
    case 'ManaPerTime': return rangeScore(value, 0.5, 15, 1, 8)
    case 'PhysicalProtection': return rangeScore(value, 5, 80, 10, 55)
    case 'MagicalProtection': return rangeScore(value, 5, 80, 10, 55)
    case 'CooldownReductionPercent': return rangeScore(value, 4, 35, 10, 25)
    case 'AttackSpeedPercent': return rangeScore(value, 5, 70, 10, 40)
    case 'MovementSpeed': return rangeScore(value, 1, 20, 3, 10)
    case 'PhysicalInhandLifestealPercent':
    case 'MagicalLifestealPercent':
      return rangeScore(value, 3, 30, 5, 20)
    case 'CritChance': return rangeScore(value, 5, 40, 10, 30)
    case 'PhysicalPenetrationPercent':
    case 'MagicalPenetrationPercent':
      return rangeScore(value, 5, 45, 10, 35)
    case 'PhysicalPenetrationFlat':
    case 'MagicalPenetrationFlat':
      return rangeScore(value, 3, 30, 5, 20)
    case 'Dampening': return rangeScore(value, 5, 35, 10, 25)
    case 'Plating': return rangeScore(value, 5, 70, 10, 50)
    case 'CrowdControlReduction': return rangeScore(value, 5, 40, 10, 25)
    case 'Pathfinding': return rangeScore(value, 1, 25, 5, 15)
    case 'EchoItem': return rangeScore(value, 1, 50, 10, 30)
    default: return 0
  }
}

function inferOrderedTags(tags: string[], values: number[]): string[] {
  const count = Math.min(tags.length, values.length)
  if (count === 0) return []

  let bestScore = -Infinity
  let bestOrder: number[] = []
  const used = new Set<number>()
  const current: number[] = []

  const visit = (pos: number, score: number) => {
    if (pos === count) {
      if (score > bestScore) {
        bestScore = score
        bestOrder = current.slice()
      }
      return
    }
    for (let i = 0; i < tags.length; i++) {
      if (used.has(i)) continue
      used.add(i)
      current.push(i)
      visit(pos + 1, score + statValueScore(tags[i], values[pos], tags))
      current.pop()
      used.delete(i)
    }
  }

  visit(0, 0)
  return bestOrder.map((idx) => tags[idx])
}

function addResolvedStat(
  out: ResolvedItemStats,
  tag: string,
  value: number,
  allTags: string[],
) {
  const canonical = canonicalStatTag(tag, allTags)
  if (canonical === 'PhysicalPower') {
    out.adaptiveStrength += value
  } else if (canonical === 'MagicalPower') {
    out.adaptiveIntelligence += value
  } else {
    out.stats[canonical] = (out.stats[canonical] ?? 0) + value
  }
}

export function resolveItemStats(item: ItemCatalogEntry): ResolvedItemStats {
  const out: ResolvedItemStats = {
    stats: {},
    adaptiveStrength: 0,
    adaptiveIntelligence: 0,
    adaptiveChoice: parseAdaptiveStat(item),
  }

  // Match visible stat rows to plausible stat tags by numeric range.
  // This was validated against Hydra (Strength, MaxMana, ManaPerTime, CooldownReductionPercent → 45, 200, 4, 10)
  // via the declaration-order bytes from the EquipmentItem tooltip-data export.
  const tags = item.statTags ?? []
  const values = (item.storeFloats ?? []).filter((v) => v >= 0 && v < 1000 && Math.abs(v - 128) > 0.01)

  const orderedTags = inferOrderedTags(tags, values)

  for (let i = 0; i < orderedTags.length && i < values.length; i++) {
    addResolvedStat(out, orderedTags[i], values[i], tags)
  }

  return out
}

// Hard-coded item deltas for items where even ORDER_OVERRIDES can't rescue the stats
// (e.g. Bumba: stats come from GE files, not the EquipmentItem tooltip-data).
// Until a follow-up pass reads the GE plausibleFloats for these items, we
// supply known values here — flagged explicitly so it's easy to find and replace.
export const MANUAL_ITEM_OVERRIDES: Record<string, ResolvedItemStats> = {
  "item.BumbasCudgel": {
    stats: { MaxHealth: 75, MaxMana: 50 },
    adaptiveStrength: 0,
    adaptiveIntelligence: 0,
    adaptiveChoice: { strength: 15, intelligence: 25 },
  },
  "Item.BumbasCudgel": {
    stats: { MaxHealth: 75, MaxMana: 50 },
    adaptiveStrength: 0,
    adaptiveIntelligence: 0,
    adaptiveChoice: { strength: 15, intelligence: 25 },
  },
  "Item.BlueStoneBrooch": {
    stats: { MaxHealth: 200, ManaPerTime: 4, HealthPerTime: 2.5 },
    adaptiveStrength: 0,
    adaptiveIntelligence: 0,
    adaptiveChoice: { strength: 30, intelligence: 50 },
  },
  "item.Brawler's Ruin": {
    stats: { MagicalProtection: 15, PhysicalProtection: 15 },
    adaptiveStrength: 0,
    adaptiveIntelligence: 0,
    adaptiveChoice: { strength: 30, intelligence: 45 },
  },
  // Bragi's Harp: the resolver's value-range heuristic ties between orderings
  // for [35, 25, 10] → picks AttackSpeedPercent=35 which is wrong. Per in-game
  // observation (2026-04-22): 35 STR, 25 INT, 10% AS.
  "item.Bragi's Harp": {
    stats: { AttackSpeedPercent: 10 },
    adaptiveStrength: 35,
    adaptiveIntelligence: 25,
  },
  "item.Leviathan's Hide": {
    stats: { MaxHealth: 300, Plating: 15 },
    adaptiveStrength: 0,
    adaptiveIntelligence: 0,
  },
  "item.Pharaoh's Curse": {
    stats: { MaxHealth: 250, PhysicalProtection: 20, Plating: 20 },
    adaptiveStrength: 0,
    adaptiveIntelligence: 0,
  },
  "item.Shogun's Ofuda": {
    stats: { MaxHealth: 200, MagicalProtection: 15, Dampening: 15 },
    adaptiveStrength: 0,
    adaptiveIntelligence: 0,
  },
  // Oath-Sworn Spear: statTags include PhysicalPenetrationFlat as a store-filter tag,
  // but the only applied flat stat is +60 Strength (PhysicalPower). The "pen flavor"
  // comes from the -1 prot per level passive, not a flat pen number.
  "item.Obsidian Macuahuitl": {
    stats: {},
    adaptiveStrength: 60,
    adaptiveIntelligence: 0,
  },
  // Transcendence base: +35 Strength, +400 Mana, +4 MP5 (validated from tooltip-data floats)
  "item.Transcendance": {
    stats: { MaxMana: 400, ManaPerTime: 4 },
    adaptiveStrength: 35,
    adaptiveIntelligence: 0,
  },
  "item.Transcendence": {
    stats: { MaxMana: 400, ManaPerTime: 4 },
    adaptiveStrength: 35,
    adaptiveIntelligence: 0,
  },
  // Bloodforge base: +45 Strength, +7.5% Lifesteal
  "item.Blood-Forged Blade": {
    stats: { PhysicalInhandLifestealPercent: 7.5 },
    adaptiveStrength: 45,
    adaptiveIntelligence: 0,
  },
  // Pendulum Blade base: +35 Strength, +10% CDR
  "item.PendulumBlade": {
    stats: { CooldownReductionPercent: 10 },
    adaptiveStrength: 35,
    adaptiveIntelligence: 0,
  },
  // Wyrmskin Hide base from current local files: +20 Strength, +300 HP, +10 Dampening
  "item.Wyrmskin Hide": {
    stats: { MaxHealth: 300, Dampening: 10 },
    adaptiveStrength: 20,
    adaptiveIntelligence: 0,
  },
  "item.WyrmskinHide": {
    stats: { MaxHealth: 300, Dampening: 10 },
    adaptiveStrength: 20,
    adaptiveIntelligence: 0,
  },
}

export function resolveItemStatsWithOverrides(item: ItemCatalogEntry): ResolvedItemStats {
  if (item.internalKey && item.internalKey in MANUAL_ITEM_OVERRIDES) {
    const override = MANUAL_ITEM_OVERRIDES[item.internalKey]
    return {
      ...override,
      adaptiveChoice: override.adaptiveChoice ?? parseAdaptiveStat(item),
    }
  }
  return resolveItemStats(item)
}
