/**
 * Build optimizer. Given a base scenario + an item pool, iterate combinations
 * of size N (≤6), run the sim on each, and rank by total damage.
 *
 * The search space is huge (pool of 40 items × choose 5 = 658k). We prune by:
 *   • Requiring exactly one starter (or none, if `allowNoStarter`).
 *   • Capping total permutations via `maxPermutations` (default 20k).
 *   • Short-circuit when a scenario throws (skip, not abort).
 *
 * Results are sorted by `rankBy` (default "total damage"). Top-N returned,
 * each with a mini SimResult (damage totals + combo time + effective stats).
 */

import {
  runScenario,
  snapshotAttacker,
  maxStackCountFor,
  shouldAutoEvolveStackingItem,
  itemHasActive,
} from '../sim/v3/engine.ts'
import { loadItems, type ItemCatalogEntry } from '../catalog/loadCatalogs.ts'
import {
  getFinalBuildItemExclusionReason,
  isFinalBuildStarter,
  itemDisplayName,
  shouldPreferItemRecord,
} from '../catalog/itemEligibility.ts'
import {
  allGodLockedItems,
  godLockedItemAsCatalogItem,
  isAspectEnabled,
} from '../catalog/godLockedItems.ts'
import {
  buildExclusionIndex,
  comboViolatesExclusion,
  computeExclusionGroups,
} from '../catalog/itemGroups.ts'
import { levelAt, loadRoleMetrics, minuteToReachGold, type RoleId } from '../catalog/roleMetrics.ts'
import type { AbilitySlot, DamageEvent, RotationAction, Scenario, SimResult } from '../sim/v3/types.ts'

export type DamageProfile = 'any' | 'auto' | 'ability' | 'hybrid'
type NonAnyDamageProfile = Exclude<DamageProfile, 'any'>

export interface OptimizeRequest {
  /** Base scenario. attacker.items are locked into every optimized build;
   *  remaining slots are filled from itemPool. */
  scenario: Scenario

  /** Candidate item display-names to draw from. Empty = no builds evaluated. */
  itemPool?: string[]

  /** Max number of items in a build (≤6). Default 6. */
  buildSize?: number

  /** Exactly one must be a starter. Default true. */
  requireOneStarter?: boolean

  /** Maximum combinations to evaluate before stopping. Default 20000. */
  maxPermutations?: number

  /** Top-N results to return. Default 100. */
  topN?: number

  /** How to rank results. Default 'total'. */
  /** Ranking modes:
   *   total    — raw total damage dealt
   *   physical/magical/true — type-slice of total
   *   dps      — damage / combo execution time
   *   ability  — sum of events whose label matches `rankByAbilityLabel`
   *   bruiser  — sqrt(avgEHP × damage). Geometric mean — pure tank and pure
   *              glass cannon both lose to balanced damage+survivability.
   *   brawling — bruiser score × (1 + CDR/100). Same balance but with a
   *              sustain weighting: CDR means more rotations in a long fight.
   *   burst    — damage / time² . More aggressive than dps: a build doing
   *              2000 in 2s beats one doing 2900 in 3.4s. Time compression
   *              weighted heavier than raw DPS.
   *   powerSpike — average damage available over an average match length,
   *              using role + mode-specific gold curves to project when each
   *              item is bought. Prefix builds are re-simmed at their projected
   *              minute / level windows, so early-slot spikes matter. Requires
   *              `role` + `gameMode`. */
  rankBy?: 'total' | 'physical' | 'magical' | 'true' | 'dps' | 'ability' | 'brawling' | 'bruiser' | 'burst' | 'bruiserBurst' | 'powerSpike'

  /** Role for power-spike scoring + build-order computation. */
  role?: RoleId

  /** Queue mode for power-spike timing. Default 'casual'. */
  gameMode?: 'casual' | 'ranked'

  /** When `rankBy === 'ability'`, sum damage of all events whose label includes
   *  this substring (case-insensitive). Example: "Flurry" catches all Flurry
   *  Strike hits. "A02" doesn't work — use the display label instead. */
  rankByAbilityLabel?: string

  /** Optional playstyle bias layered on top of the rank metric:
   *   any     — no bias, raw rank metric
   *   auto    — prefer builds whose damage is driven by basics/basic-triggered procs
   *   ability — prefer builds whose damage is driven by abilities/ability-triggered procs
   *   hybrid  — prefer builds that keep both autos and abilities relevant
   */
  damageProfile?: DamageProfile

  /** Post-filter bounds on computed stats. Builds that violate any are dropped.
   *  Keys match AttackerSnapshot field names (adaptiveStrength, cdrPercent,
   *  penPercent, critChance, maxHealth, totalAttackSpeed, etc.). */
  statMin?: Partial<Record<string, number>>
  statMax?: Partial<Record<string, number>>

  /** Post-filter bounds on damage totals. */
  minTotalDamage?: number
  maxTotalDamage?: number
  minDps?: number

  /** If true AND the pool is larger than what `maxPermutations` allows to be
   *  fully explored, sample combinations at random instead of lexicographically.
   *  Prevents the "only alphabetic prefix is explored" failure mode. Default true. */
  shuffleSample?: boolean

  /** Optional deterministic sample seed. Same seed + same request = same builds. */
  shuffleSeed?: string | number

  /** When true, stacking items (Transcendence, Book of Thoth, Bloodforge, Soul
   *  Reaver, Momentum, etc.) are treated as fully evolved — `partialStacks` is
   *  auto-populated with the max count for each such item in the tested build.
   *  Default true. Matches the "fully built / late-game" scoring assumption. */
  evolveStackingItems?: boolean

  /** Item display-names whose `On Use:` active should fire in the combo. The
   *  optimizer prepends `{ kind: 'activate', itemKey: name }` steps to the
   *  scenario rotation for any of these items present in the tested build.
   *  Items not listed here contribute their flat stats only — their active
   *  isn't counted. */
  activeItems?: string[]

  /** Internal worker-sharding fields. Used by the server's parallel optimizer
   *  path so shards can search disjoint build slices and merge top-N results. */
  shardIndex?: number
  shardCount?: number
}

export interface OptimizedBuild {
  items: string[]
  totals: { total: number; physical: number; magical: number; true: number }
  comboExecutionTime: number
  dps: number
  /** The score this build was ranked on — total damage by default, or the
   *  ability-filtered total if rank-by-ability is active. */
  rankScore: number
  /** Items in recommended build order, earliest to latest. Present only when
   *  `role` is set on the request. Timings / levels come from role metrics,
   *  and damage values are re-simmed on the projected prefix state. */
  buildOrder?: Array<{
    name: string
    itemCost: number
    cumulativeCost: number
    estimatedMinute: number
    projectedLevel: number
    damage: number
    marginalDamage: number
    spikeEfficiency: number
  }>
  powerSpike?: {
    averageDamage: number
    peakItem: string
    peakMinute: number
    peakLevel: number
    peakMarginalDamage: number
    peakEfficiency: number
  }
  profile?: {
    autoDamage: number
    abilityDamage: number
    otherDamage: number
    autoShare: number
    abilityShare: number
    dominantStyle: NonAnyDamageProfile
  }
  /** Subset of attacker snapshot, for result-grid columns. */
  stats: {
    adaptiveStrength: number
    adaptiveIntelligence: number
    totalAttackSpeed: number
    inhandPower: number
    cdrPercent: number
    critChance: number
    maxHealth: number
    physicalProtection: number
    magicalProtection: number
    penFlat: number
    penPercent: number
    magicalPenFlat: number
    magicalPenPercent: number
  }
}

export interface OptimizeResult {
  searched: number
  total: number
  results: OptimizedBuild[]
  elapsedMs: number
  warnings: string[]
  parallelismUsed?: number
  styleLeaders?: Partial<Record<NonAnyDamageProfile, {
    items: string[]
    rankScore: number
    baseScore: number
    dps: number
    totalDamage: number
    autoShare: number
    abilityShare: number
    dominantStyle: NonAnyDamageProfile
  }>>
}

// -- small combinatorics helpers ---------------------------------------------

function* combinations<T>(arr: T[], k: number): Generator<T[]> {
  if (k === 0) { yield []; return }
  if (arr.length < k) return
  for (let i = 0; i <= arr.length - k; i++) {
    const head = arr[i]
    for (const tail of combinations(arr.slice(i + 1), k - 1)) {
      yield [head, ...tail]
    }
  }
}

function combinationCount(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  let x = 1
  for (let i = 0; i < k; i++) x = (x * (n - i)) / (i + 1)
  return Math.round(x)
}

function positiveInteger(value: unknown, fallback: number, min = 1): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.floor(parsed))
}

function hashString(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function createPrng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s += 0x6D2B79F5
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function sampleK<T>(arr: T[], k: number, seen: Set<number>, rng: () => number): T[] | null {
  if (k < 0 || arr.length < k) return null
  seen.clear()
  const out: T[] = []
  while (out.length < k) {
    const i = Math.floor(rng() * arr.length)
    if (seen.has(i)) continue
    seen.add(i)
    out.push(arr[i])
  }
  return out
}

function sampleTryLimit(targetBuilds: number, shardCount: number): number {
  return Math.max(targetBuilds * 20, targetBuilds * shardCount * 12)
}

function comboKey(items: string[]): string {
  return items.slice().sort().join('|')
}

function shardIndexForCombo(items: string[], shardCount: number): number {
  if (shardCount <= 1) return 0
  return hashString(comboKey(items)) % shardCount
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

function summarize(
  items: string[],
  result: SimResult,
  snapshotStats: OptimizedBuild['stats'],
  rankScore: number,
  profile?: OptimizedBuild['profile'],
): OptimizedBuild {
  const dps = result.comboExecutionTime > 0 ? result.totals.total / result.comboExecutionTime : result.totals.total
  return {
    items,
    totals: {
      total: result.totals.total,
      physical: result.totals.physical,
      magical: result.totals.magical,
      true: result.totals.true,
    },
    comboExecutionTime: result.comboExecutionTime,
    dps,
    rankScore,
    profile,
    stats: snapshotStats,
  }
}

type BuildOrderStep = NonNullable<OptimizedBuild['buildOrder']>[number]
type PowerSpikeSummary = NonNullable<OptimizedBuild['powerSpike']>
type DamageProfileSummary = NonNullable<OptimizedBuild['profile']>
type SimDamageOptions = {
  evolve: boolean
  activeSet: Set<string>
  minute?: number
  role?: RoleId
  mode?: 'casual' | 'ranked'
  conservativeStacks?: boolean
}

const NON_ULT_SLOTS: AbilitySlot[] = ['A01', 'A02', 'A03']
const ULT_RANK_LEVELS = [5, 9, 13, 17, 20]
const NON_ANY_DAMAGE_PROFILES: NonAnyDamageProfile[] = ['auto', 'ability', 'hybrid']

function classifyDamageEvent(event: DamageEvent): 'auto' | 'ability' | 'other' {
  const notes = (event.notes ?? []).join(' ').toLowerCase()
  if (event.source === 'basic') return 'auto'
  if (event.source === 'ability' || event.source === 'dot') {
    if (notes.includes('basic')) return 'auto'
    return 'ability'
  }
  if (notes.includes('basic')) return 'auto'
  if (notes.includes('ability')) return 'ability'
  return 'other'
}

function buildDamageProfile(sim: SimResult): DamageProfileSummary {
  let autoDamage = 0
  let abilityDamage = 0
  let otherDamage = 0
  for (const event of sim.damageEvents) {
    const bucket = classifyDamageEvent(event)
    if (bucket === 'auto') autoDamage += event.postMitigation
    else if (bucket === 'ability') abilityDamage += event.postMitigation
    else otherDamage += event.postMitigation
  }
  const total = autoDamage + abilityDamage + otherDamage
  const autoShare = total > 0 ? autoDamage / total : 0
  const abilityShare = total > 0 ? abilityDamage / total : 0
  const balanceGap = Math.abs(autoShare - abilityShare)
  const dominantStyle: NonAnyDamageProfile =
    autoDamage <= 0 && abilityDamage > 0 ? 'ability'
    : abilityDamage <= 0 && autoDamage > 0 ? 'auto'
    : balanceGap <= 0.15 ? 'hybrid'
    : autoShare > abilityShare ? 'auto'
    : 'ability'
  return {
    autoDamage,
    abilityDamage,
    otherDamage,
    autoShare,
    abilityShare,
    dominantStyle,
  }
}

function damageProfileMultiplier(profile: DamageProfile, summary: DamageProfileSummary): number {
  if (profile === 'any') return 1
  if (profile === 'auto') return Math.max(0.01, summary.autoShare + summary.otherDamage / Math.max(1, summary.autoDamage + summary.abilityDamage + summary.otherDamage) * 0.1)
  if (profile === 'ability') return Math.max(0.01, summary.abilityShare + summary.otherDamage / Math.max(1, summary.autoDamage + summary.abilityDamage + summary.otherDamage) * 0.1)
  return Math.max(0.01, 4 * summary.autoShare * summary.abilityShare)
}

function deriveAbilityPriority(
  scenario: Scenario,
): AbilitySlot[] {
  const counts = new Map<AbilitySlot, number>()
  for (const step of scenario.rotation) {
    if (step.kind !== 'ability') continue
    counts.set(step.slot, (counts.get(step.slot) ?? 0) + 1)
  }
  return NON_ULT_SLOTS.slice().sort((a, b) => {
    const freqDelta = (counts.get(b) ?? 0) - (counts.get(a) ?? 0)
    if (freqDelta !== 0) return freqDelta
    const baseDelta = (scenario.attacker.abilityRanks[b] ?? 0) - (scenario.attacker.abilityRanks[a] ?? 0)
    if (baseDelta !== 0) return baseDelta
    return a.localeCompare(b)
  })
}

function projectedAbilityRanks(
  scenario: Scenario,
  level: number,
): Record<AbilitySlot, number> {
  const clampedLevel = Math.max(1, Math.min(20, Math.floor(level)))
  const out: Record<AbilitySlot, number> = { A01: 0, A02: 0, A03: 0, A04: 0 }
  let remainingPoints = clampedLevel

  out.A04 = Math.min(5, ULT_RANK_LEVELS.filter((threshold) => clampedLevel >= threshold).length)
  remainingPoints -= out.A04

  const maxBasicRank = Math.min(5, Math.floor((clampedLevel + 1) / 2))
  for (const slot of deriveAbilityPriority(scenario)) {
    if (remainingPoints <= 0) break
    const spend = Math.min(maxBasicRank, remainingPoints)
    out[slot] = spend
    remainingPoints -= spend
  }

  if (remainingPoints > 0) {
    for (const slot of deriveAbilityPriority(scenario)) {
      if (remainingPoints <= 0) break
      const cap = Math.min(5, maxBasicRank)
      const room = cap - out[slot]
      if (room <= 0) continue
      const spend = Math.min(room, remainingPoints)
      out[slot] += spend
      remainingPoints -= spend
    }
  }

  return out
}

function projectScenarioForMinute(
  scenario: Scenario,
  minute: number,
  mode: 'casual' | 'ranked',
  role?: RoleId,
): Scenario {
  const attackerLevel = Math.min(scenario.attacker.level, levelAt(minute, mode, role))
  const defenderLevel = Math.min(scenario.defender.level, levelAt(minute, mode))
  return {
    ...scenario,
    attacker: {
      ...scenario.attacker,
      level: attackerLevel,
      abilityRanks: projectedAbilityRanks(scenario, attackerLevel),
    },
    defender: {
      ...scenario.defender,
      level: defenderLevel,
    },
    teamAttackers: scenario.teamAttackers?.map((ally) => {
      const allyLevel = Math.min(ally.level, levelAt(minute, mode))
      return {
        ...ally,
        level: allyLevel,
        abilityRanks: projectedAbilityRanks({
          ...scenario,
          attacker: ally,
        }, allyLevel),
      }
    }),
  }
}

/** Default gold costs per tier for items whose `totalCost` isn't populated
 *  in the catalog yet. The Python `augment-catalog-with-costs.py` script
 *  fills the real values from game files; until it's run, these tier-based
 *  approximations keep build-order timings directionally correct. */
const DEFAULT_TIER_COSTS: Record<string, number> = {
  'T1': 650,
  'T2': 1400,
  'T3': 2800,
  'Starter': 600,  // upgraded starter (final-build eligible)
}

function itemGoldCost(entry: ItemCatalogEntry | undefined): number {
  if (!entry) return 0
  // God-locked items (Ratatoskr acorns) are spawned, not purchased.
  if (entry.categories?.includes('GodLocked')) return 0
  if (typeof entry.totalCost === 'number' && entry.totalCost > 0) return entry.totalCost
  return DEFAULT_TIER_COSTS[entry.tier ?? ''] ?? 0
}

// -- main entry point --------------------------------------------------------

export function optimize(req: OptimizeRequest): OptimizeResult {
  const started = Date.now()
  const itemsCatalog = loadItems()
  const warnings: string[] = []

  // Resolve candidate pool. An EMPTY pool means "no items allowed" — not
  // "all items". Users should be explicit about the pool to get good builds.
  const names = new Set<string>()
  if (req.itemPool && req.itemPool.length > 0) {
    for (const n of req.itemPool) names.add(n)
  }
  const requestedPool = [...names]

  if (requestedPool.length === 0) {
    return {
      searched: 0, total: 0, results: [], elapsedMs: Date.now() - started,
      warnings: ['Item pool is empty. Select "ALL", "PHYSICAL", or "MAGICAL" to fill it, or add items to a custom pool.'],
    }
  }

  // Separate final-build starters from regular final items. This is enforced
  // here, not only in the UI, so custom/API optimizer requests cannot rank
  // T1/T2 components, base starters, relics, consumables, or half-ingested rows.
  const starters: string[] = []
  const regular: string[] = []
  const byName = new Map<string, typeof itemsCatalog[keyof typeof itemsCatalog]>()
  for (const it of Object.values(itemsCatalog)) {
    const displayName = itemDisplayName(it)
    if (displayName && shouldPreferItemRecord(it, byName.get(displayName))) {
      byName.set(displayName, it)
    }
  }
  // Inject god-locked items (Ratatoskr acorns) for the attacker god so users
  // can lock them as part of a build. They aren't in items-catalog.json — they
  // live alongside it, synthesized on demand. The sim engine resolves them via
  // getItem() → findGodLockedItem() fallback.
  const attackerGodId = req.scenario.attacker.godId
  const aspectActive = isAspectEnabled(req.scenario.attacker.aspects)
  for (const glItem of allGodLockedItems()) {
    if (glItem.godId !== attackerGodId) continue
    const synth = godLockedItemAsCatalogItem(glItem, aspectActive)
    if (shouldPreferItemRecord(synth, byName.get(glItem.displayName))) {
      byName.set(glItem.displayName, synth)
    }
  }

  const lockedUnknownItems: string[] = []
  const lockedExcludedItems: Array<{ name: string; reason: string }> = []
  const lockedNames: string[] = []
  for (const rawName of uniqueNames(req.scenario.attacker.items ?? [])) {
    const entry = byName.get(rawName)
    if (!entry) {
      lockedUnknownItems.push(rawName)
      continue
    }
    const displayName = itemDisplayName(entry) ?? rawName
    const exclusionReason = getFinalBuildItemExclusionReason(entry)
    if (exclusionReason) {
      lockedExcludedItems.push({ name: displayName, reason: exclusionReason })
      continue
    }
    lockedNames.push(displayName)
  }
  if (lockedUnknownItems.length > 0 || lockedExcludedItems.length > 0) {
    const lockedWarnings = [...warnings]
    if (lockedUnknownItems.length > 0) {
      lockedWarnings.push(`Locked item(s) are unknown: ${lockedUnknownItems.join(', ')}.`)
    }
    if (lockedExcludedItems.length > 0) {
      lockedWarnings.push(`Locked item(s) are not final-build eligible: ${lockedExcludedItems.map((i) => `${i.name} (${i.reason})`).join(', ')}.`)
    }
    return { searched: 0, total: 0, results: [], elapsedMs: Date.now() - started, warnings: lockedWarnings }
  }
  const lockedSet = new Set(lockedNames)
  const lockedStarters = lockedNames.filter((name) => {
    const entry = byName.get(name)
    return entry ? isFinalBuildStarter(entry) : false
  })
  const lockedRegular = lockedNames.filter((name) => !lockedStarters.includes(name))

  const pool: string[] = []
  const unknownItems: string[] = []
  const excludedItems: Array<{ name: string; reason: string }> = []
  for (const n of requestedPool) {
    const entry = byName.get(n)
    if (!entry) {
      unknownItems.push(n)
      continue
    }
    const exclusionReason = getFinalBuildItemExclusionReason(entry)
    if (exclusionReason) {
      excludedItems.push({ name: n, reason: exclusionReason })
      continue
    }
    const displayName = itemDisplayName(entry) ?? n
    if (lockedSet.has(displayName)) continue
    pool.push(displayName)
    if (isFinalBuildStarter(entry)) starters.push(displayName)
    else regular.push(displayName)
  }
  if (unknownItems.length > 0) {
    warnings.push(`${unknownItems.length.toLocaleString()} unknown item(s) ignored: ${unknownItems.slice(0, 5).join(', ')}${unknownItems.length > 5 ? ', ...' : ''}.`)
  }
  if (excludedItems.length > 0) {
    const reasonCounts = new Map<string, number>()
    for (const { reason } of excludedItems) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1)
    }
    const reasonSummary = [...reasonCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${count} ${reason}`)
      .join(', ')
    warnings.push(
      `${excludedItems.length.toLocaleString()} non-final item(s) ignored (${reasonSummary}). ` +
      `Examples: ${excludedItems.slice(0, 5).map((i) => i.name).join(', ')}${excludedItems.length > 5 ? ', ...' : ''}.`,
    )
  }

  if (pool.length === 0 && lockedNames.length === 0) {
    return {
      searched: 0, total: 0, results: [], elapsedMs: Date.now() - started,
      warnings: [...warnings, 'No valid items remain after resolving the selected pool.'],
    }
  }

  // `buildSize` is the number of REGULAR (non-starter) item slots. A final
  // build always has one dedicated starter in addition, so total slots =
  // (requireStarter ? 1 : 0) + buildSize. Default 6 regulars → 7 total slots.
  const buildSize = Math.min(6, positiveInteger(req.buildSize, 6))
  const requireStarter = req.requireOneStarter ?? true
  const maxPerms = positiveInteger(req.maxPermutations, 20000)
  const topN = positiveInteger(req.topN, 100)
  const rankBy = req.rankBy ?? 'total'
  const damageProfile = req.damageProfile ?? 'any'
  const shardCount = Math.max(1, positiveInteger(req.shardCount, 1, 1))
  const shardIndex = Math.max(0, Math.min(shardCount - 1, positiveInteger(req.shardIndex, 0, 0)))
  const remainingRegularSlots = buildSize - lockedRegular.length

  if (lockedNames.length > 0) {
    warnings.push(`Locked item(s) forced into every optimized build: ${lockedNames.join(', ')}.`)
  }
  if (lockedStarters.length > 1) {
    return {
      searched: 0,
      total: 0,
      results: [],
      elapsedMs: Date.now() - started,
      warnings: [...warnings, `Only one upgraded starter can be locked, but ${lockedStarters.length} were selected: ${lockedStarters.join(', ')}.`],
    }
  }
  if (remainingRegularSlots < 0) {
    return {
      searched: 0,
      total: 0,
      results: [],
      elapsedMs: Date.now() - started,
      warnings: [...warnings, `${lockedRegular.length} locked regular item(s) exceed the optimizer's ${buildSize} regular item slots.`],
    }
  }

  if (requireStarter && lockedStarters.length === 0 && starters.length === 0) {
    return {
      searched: 0,
      total: 0,
      results: [],
      elapsedMs: Date.now() - started,
      warnings: ['Starter is required, but the selected item pool contains no starter items. Add a starter or disable the starter requirement.'],
    }
  }

  const shuffle = req.shuffleSample ?? true
  const seedText = String(req.shuffleSeed ?? JSON.stringify({
    pool: pool.slice().sort(),
    buildSize,
    requireStarter,
    scenario: req.scenario,
    rankBy,
    rankByAbilityLabel: req.rankByAbilityLabel,
    statMin: req.statMin,
    statMax: req.statMax,
  }))
  const rng = createPrng(hashString(seedText))

  // allocations. Not secure — just for even sampling across the combinatorial
  // Generator of legal candidate builds. Starter items are constrained to at
  // most one per build even when they are not required.
  function* builds(): Generator<string[]> {
    if (requireStarter && (lockedStarters.length > 0 || starters.length > 0)) {
      const starterChoices = lockedStarters.length > 0 ? lockedStarters : starters
      const regularChoices = regular.filter((name) => !lockedSet.has(name))
      // One dedicated starter + `buildSize` regulars = buildSize+1 total items.
      // If the full space fits in the cap, enumerate lexicographically.
      const perStarterCount = combinationCount(regularChoices.length, remainingRegularSlots)
      const full = starterChoices.length * perStarterCount
      if (!shuffle || full <= maxPerms) {
        for (const s of starterChoices) {
          for (const combo of combinations(regularChoices, remainingRegularSlots)) {
            const build = [s, ...lockedRegular, ...combo]
            if (shardIndexForCombo(build, shardCount) !== shardIndex) continue
            yield build
          }
        }
      } else {
        const seen = new Set<number>()
        const produced = new Set<string>()
        const maxTries = sampleTryLimit(maxPerms, shardCount)
        for (let tries = 0; tries < maxTries && produced.size < maxPerms; tries++) {
          const pick = Math.floor(rng() * full)
          const starterIdx = Math.floor(pick / perStarterCount)
          const s = starterChoices[starterIdx]
          const combo = sampleK(regularChoices, remainingRegularSlots, seen, rng)
          if (!combo) continue
          const build = [s, ...lockedRegular, ...combo]
          if (shardIndexForCombo(build, shardCount) !== shardIndex) continue
          const key = comboKey(build)
          if (produced.has(key)) continue
          produced.add(key)
          yield build
        }
      }
    } else {
      const regularChoices = regular.filter((name) => !lockedSet.has(name))
      const starterChoices = starters.filter((name) => !lockedSet.has(name))
      const remainingSlots = buildSize - lockedNames.length
      if (remainingSlots < 0) return
      const lockedHasStarter = lockedStarters.length > 0
      const zeroStarterCount = lockedHasStarter ? 0 : combinationCount(regularChoices.length, remainingSlots)
      const oneStarterPerStarterCount = lockedHasStarter ? combinationCount(regularChoices.length, remainingSlots) : combinationCount(regularChoices.length, remainingSlots - 1)
      const full = zeroStarterCount + starterChoices.length * oneStarterPerStarterCount
      if (!shuffle || full <= maxPerms) {
        if (lockedHasStarter) {
          for (const combo of combinations(regularChoices, remainingSlots)) {
            const build = [...lockedNames, ...combo]
            if (shardIndexForCombo(build, shardCount) !== shardIndex) continue
            yield build
          }
        } else {
          for (const combo of combinations(regularChoices, remainingSlots)) {
            const build = [...lockedNames, ...combo]
            if (shardIndexForCombo(build, shardCount) !== shardIndex) continue
            yield build
          }
          for (const s of starterChoices) {
            for (const combo of combinations(regularChoices, remainingSlots - 1)) {
              const build = [...lockedNames, s, ...combo]
              if (shardIndexForCombo(build, shardCount) !== shardIndex) continue
              yield build
            }
          }
        }
      } else {
        const seen = new Set<number>()
        const produced = new Set<string>()
        const maxTries = sampleTryLimit(maxPerms, shardCount)
        for (let tries = 0; tries < maxTries && produced.size < maxPerms; tries++) {
          const pick = Math.floor(rng() * full)
          const combo = lockedHasStarter
            ? [...lockedNames, ...(sampleK(regularChoices, remainingSlots, seen, rng) ?? [])]
            : pick < zeroStarterCount
              ? [...lockedNames, ...(sampleK(regularChoices, remainingSlots, seen, rng) ?? [])]
              : [
                  ...lockedNames,
                  starterChoices[Math.floor((pick - zeroStarterCount) / oneStarterPerStarterCount)],
                  ...(sampleK(regularChoices, remainingSlots - 1, seen, rng) ?? []),
                ]
          if (!combo || combo.length !== buildSize) continue
          if (shardIndexForCombo(combo, shardCount) !== shardIndex) continue
          const key = comboKey(combo)
          if (produced.has(key)) continue
          produced.add(key)
          yield combo
        }
      }
    }
  }

  // Count total permutations up front (capped) so we can report progress.
  // Starter-required: starters × C(regular, buildSize). Non-starter legacy path
  // treats buildSize as total slots, starter optional.
  let totalPermsEstimate = 0
  if (requireStarter && (lockedStarters.length > 0 || starters.length > 0)) {
    const starterChoices = lockedStarters.length > 0 ? lockedStarters : starters
    totalPermsEstimate = starterChoices.length * combinationCount(regular.length, remainingRegularSlots)
  } else {
    const remainingSlots = buildSize - lockedNames.length
    const lockedHasStarter = lockedStarters.length > 0
    totalPermsEstimate =
      (lockedHasStarter ? 0 : combinationCount(regular.length, remainingSlots))
      + (lockedHasStarter ? 0 : starters.length * combinationCount(regular.length, remainingSlots - 1))
      + (lockedHasStarter ? combinationCount(regular.length, remainingSlots) : 0)
  }

  if (totalPermsEstimate === 0) {
    return {
      searched: 0,
      total: 0,
      results: [],
      elapsedMs: Date.now() - started,
      warnings: [`Selected pool cannot produce a ${buildSize}-item build${requireStarter ? ' with exactly one starter' : ''}. Add more items or lower build size.`],
    }
  }

  if (totalPermsEstimate > maxPerms) {
    warnings.push(`pool of ${pool.length} items would produce ${totalPermsEstimate.toLocaleString()} legal builds; ${shuffle ? 'deterministically sampling' : 'capping'} at ${maxPerms.toLocaleString()}. Narrow the pool for full search.`)
  }

  const abilityLabel = (req.rankByAbilityLabel ?? '').trim().toLowerCase()
  if (rankBy === 'ability' && abilityLabel.length === 0) {
    warnings.push('Rank-by-ability selected without an ability label; ranking falls back to total damage.')
  }

  function statsPass(snap: {
    adaptiveStrength: number; adaptiveIntelligence: number; totalAttackSpeed: number
    inhandPower: number; cdrPercent: number; critChance: number; maxHealth: number
    physicalProtection: number; magicalProtection: number; penFlat: number; penPercent: number
    magicalPenFlat: number; magicalPenPercent: number
  }): boolean {
    if (req.statMin) {
      for (const [k, v] of Object.entries(req.statMin)) {
        if (v == null) continue
        const s = (snap as Record<string, number>)[k]
        if (s == null || s < v) return false
      }
    }
    if (req.statMax) {
      for (const [k, v] of Object.entries(req.statMax)) {
        if (v == null) continue
        const s = (snap as Record<string, number>)[k]
        if (s != null && s > v) return false
      }
    }
    return true
  }

  function abilityScore(sim: SimResult): number {
    if (!abilityLabel) return sim.totals.total
    let sum = 0
    for (const [lab, v] of Object.entries(sim.byLabel)) {
      if (lab.toLowerCase().includes(abilityLabel)) sum += v
    }
    return sum
  }

  // Run the search.
  let searched = 0
  let filtered = 0
  let failedBuilds = 0
  const keep: OptimizedBuild[] = []
  let min = -Infinity  // lowest score currently in keep
  const seenBuilds = new Set<string>()
  const styleLeaders: NonNullable<OptimizeResult['styleLeaders']> = {}

  const evolve = req.evolveStackingItems ?? true
  const activeSet = new Set(req.activeItems ?? [])
  const conditionalStackItems = new Set<string>()

  // Mutual-exclusion groups — builds with ≥2 items from the same group are
  // skipped (e.g. Titan's Bane + Obsidian Shard share the 35%-pen unique
  // passive and the game only applies one). Checked before we do any sim work.
  const exclusionGroups = computeExclusionGroups(Object.values(itemsCatalog))
  const exclusionIndex = buildExclusionIndex(exclusionGroups)
  let rejectedByExclusion = 0

  function considerCombo(combo: string[]): void {
    const seenKey = comboKey(combo)
    if (seenBuilds.has(seenKey)) return
    seenBuilds.add(seenKey)
    searched++

    if (comboViolatesExclusion(combo, exclusionIndex)) {
      rejectedByExclusion++
      return
    }

    try {
      // Build per-combo partialStacks + activate-step prefix.
      const partialStacks: Record<string, number> = { ...(req.scenario.attacker.partialStacks ?? {}) }
      const prefixSteps: RotationAction[] = []
      for (const name of combo) {
        const entry = byName.get(name)
        if (!entry) continue
        if (evolve) {
          const max = maxStackCountFor(entry)
          if (max && max > 0) {
            if (!shouldAutoEvolveStackingItem(entry)) {
              conditionalStackItems.add(itemDisplayName(entry) ?? entry.internalKey ?? name)
              continue
            }
            const internal = entry.internalKey ?? ''
            const display = entry.displayName ?? ''
            if (partialStacks[internal] == null && partialStacks[display] == null) {
              if (internal) partialStacks[internal] = max
              else if (display) partialStacks[display] = max
            }
          }
        }
        if (activeSet.has(name) && itemHasActive(entry)) {
          prefixSteps.push({ kind: 'activate', itemKey: entry.internalKey ?? name })
        }
      }

      const scenario: Scenario = {
        ...req.scenario,
        attacker: {
          ...req.scenario.attacker,
          items: combo,
          partialStacks,
        },
        rotation: prefixSteps.length > 0
          ? [...prefixSteps, ...req.scenario.rotation]
          : req.scenario.rotation,
      }
      const sim = runScenario(scenario)
      const snap = snapshotAttacker(scenario)
      const profile = buildDamageProfile(sim)

      const stats = {
        adaptiveStrength: snap.adaptiveStrength,
        adaptiveIntelligence: snap.adaptiveIntelligence,
        totalAttackSpeed: snap.totalAttackSpeed,
        inhandPower: snap.inhandPower,
        cdrPercent: snap.cdrPercent,
        critChance: snap.critChance,
        maxHealth: snap.maxHealth,
        physicalProtection: snap.physicalProtection,
        magicalProtection: snap.magicalProtection,
        penFlat: snap.penFlat,
        penPercent: snap.penPercent,
        magicalPenFlat: snap.magicalPenFlat,
        magicalPenPercent: snap.magicalPenPercent,
      }
      if (!statsPass(stats)) { filtered++; return }

      const dps = sim.comboExecutionTime > 0 ? sim.totals.total / sim.comboExecutionTime : sim.totals.total
      if (req.minTotalDamage != null && sim.totals.total < req.minTotalDamage) { filtered++; return }
      if (req.maxTotalDamage != null && sim.totals.total > req.maxTotalDamage) { filtered++; return }
      if (req.minDps != null && dps < req.minDps) { filtered++; return }

      // Survivability metrics for bruiser/brawling scores.
      const ehpPhys = stats.maxHealth * (1 + stats.physicalProtection / 100)
      const ehpMag = stats.maxHealth * (1 + stats.magicalProtection / 100)
      const avgEHP = (ehpPhys + ehpMag) / 2
      const bruiserScore = Math.sqrt(Math.max(0, avgEHP * sim.totals.total))
      const brawlingScore = bruiserScore * (1 + stats.cdrPercent / 100)
      // Burst: compress damage by squared time. Clamp time to 0.5s to avoid
      // absurd scores from near-instant rotations.
      const comboT = Math.max(0.5, sim.comboExecutionTime)
      const burstScore = sim.totals.total / (comboT * comboT)

      // Bruiser-burst = bruiser (EHP × dmg) combined with burst (time²
       // compression). sqrt(avgEHP × damage²/time²) — rewards builds that
       // hit hard in short windows while still carrying survivability.
      const bruiserBurstScore = Math.sqrt(Math.max(0, avgEHP) * (sim.totals.total * sim.totals.total) / (comboT * comboT))

      let powerSpikeRankScore = sim.totals.total
      let buildOrderForScore: OptimizedBuild['buildOrder'] | undefined
      let powerSpikeSummary: OptimizedBuild['powerSpike'] | undefined
      if (req.role && rankBy === 'powerSpike') {
        const powerSpikePath = computePowerSpikePath({
          items: combo,
          byName,
          scenario: req.scenario,
          role: req.role,
          mode: req.gameMode ?? 'casual',
          evolve,
          activeSet,
        })
        buildOrderForScore = powerSpikePath.buildOrder
        powerSpikeSummary = powerSpikePath.summary
        powerSpikeRankScore = powerSpikePath.score
      }

      const baseScore =
        rankBy === 'physical' ? sim.totals.physical
        : rankBy === 'magical' ? sim.totals.magical
        : rankBy === 'true' ? sim.totals.true
        : rankBy === 'dps' ? dps
        : rankBy === 'ability' ? abilityScore(sim)
        : rankBy === 'bruiser' ? bruiserScore
        : rankBy === 'brawling' ? brawlingScore
        : rankBy === 'burst' ? burstScore
        : rankBy === 'bruiserBurst' ? bruiserBurstScore
        : rankBy === 'powerSpike' ? powerSpikeRankScore
        : sim.totals.total
      const score = baseScore * damageProfileMultiplier(damageProfile, profile)

      for (const style of NON_ANY_DAMAGE_PROFILES) {
        const styleScore = baseScore * damageProfileMultiplier(style, profile)
        const current = styleLeaders[style]
        if (!current || styleScore > current.rankScore) {
          styleLeaders[style] = {
            items: combo.slice(),
            rankScore: styleScore,
            baseScore,
            dps,
            totalDamage: sim.totals.total,
            autoShare: profile.autoShare,
            abilityShare: profile.abilityShare,
            dominantStyle: profile.dominantStyle,
          }
        }
      }

      if (keep.length < topN || score > min) {
        const summary = summarize(combo, sim, stats, score, profile)
        if (buildOrderForScore) summary.buildOrder = buildOrderForScore
        if (powerSpikeSummary) summary.powerSpike = powerSpikeSummary
        keep.push(summary)
        keep.sort((a, b) => b.rankScore - a.rankScore)
        if (keep.length > topN) keep.length = topN
        min = keep[keep.length - 1].rankScore
      }
    } catch {
      failedBuilds++
    }
  }

  for (const combo of builds()) {
    if (searched >= maxPerms) break
    considerCombo(combo)
  }

  const sampledSearch = totalPermsEstimate > maxPerms
  if (sampledSearch && keep.length > 0) {
    const refineBudget = Math.min(20000, Math.max(1000, Math.floor(maxPerms * 0.25)))
    const starterChoices = lockedStarters.length > 0 ? lockedStarters : starters
    const starterSet = new Set(starterChoices)
    const regularChoices = regular.filter((name) => !lockedSet.has(name))
    const seedBuilds = keep.slice(0, Math.min(keep.length, 24))
    const searchLimit = maxPerms + refineBudget

    for (const build of seedBuilds) {
      if (searched >= searchLimit) break
      const starter = build.items.find((name) => starterSet.has(name)) ?? null
      const regularItems = build.items.filter((name) => name !== starter)

      if (!lockedStarters.length && starter) {
        for (const altStarter of starterChoices) {
          if (altStarter === starter || searched >= searchLimit) continue
          const candidate = [altStarter, ...regularItems]
          considerCombo(candidate)
        }
      }

      for (let index = 0; index < regularItems.length; index++) {
        if (lockedSet.has(regularItems[index])) continue
        for (const replacement of regularChoices) {
          if (replacement === regularItems[index] || build.items.includes(replacement) || searched >= searchLimit) continue
          const swappedRegular = regularItems.slice()
          swappedRegular[index] = replacement
          const candidate = starter ? [starter, ...swappedRegular] : swappedRegular
          considerCombo(candidate)
        }
      }
    }
  }

  if (shuffle && totalPermsEstimate > maxPerms && searched < maxPerms) {
    warnings.push(`Deterministic sampler produced ${searched.toLocaleString()} unique builds before retry exhaustion. Increase the item pool or lower max permutations if this persists.`)
  }
  if (sampledSearch) {
    warnings.push(`Optimizer sampled the full space (${totalPermsEstimate.toLocaleString()} legal builds) and then ran a local swap-refinement pass around the best sampled builds.`)
  }
  if (filtered > 0) warnings.push(`${filtered.toLocaleString()} builds dropped by post-filters (stat bounds / damage bounds).`)
  if (failedBuilds > 0) warnings.push(`${failedBuilds.toLocaleString()} builds failed during sim evaluation and were skipped. This can hide better builds if a god/item interaction is still broken.`)
  if (conditionalStackItems.size > 0) {
    warnings.push(
      `Conditional/temporary stack item(s) were not auto-stacked: ${[...conditionalStackItems].sort().join(', ')}. ` +
      'Set partialStacks explicitly to model existing stacks.',
    )
  }
  if (rejectedByExclusion > 0) {
    const groupLabels = exclusionGroups.map((g) => g.label).join(', ')
    warnings.push(`${rejectedByExclusion.toLocaleString()} builds rejected: two items from the same unique-passive family (${groupLabels}).`)
  }

  // Post-process: fill recommended build order on each kept build when the
  // result was ranked by something other than powerSpike. powerSpike builds
  // already computed a timed prefix path inside the main loop.
  if (req.role && keep.length > 0) {
    for (const build of keep) {
      if (build.buildOrder && build.buildOrder.length > 0) continue
      try {
        const powerSpikePath = computePowerSpikePath({
          items: build.items,
          byName,
          scenario: req.scenario,
          role: req.role,
          mode: req.gameMode ?? 'casual',
          evolve,
          activeSet,
        })
        build.buildOrder = powerSpikePath.buildOrder
        build.powerSpike = powerSpikePath.summary
      } catch {
        // If the per-item sim fails (item-resolution issue), skip ordering
        // for this build but don't kill the whole result set.
      }
    }
  }

  return {
    searched,
    total: totalPermsEstimate,
    results: keep,
    elapsedMs: Date.now() - started,
    warnings,
    styleLeaders,
  }
}

/** Helper: run a sim with exactly the given items and return total damage.
 *  Can also project that build into a role/mode-specific minute window so
 *  early powerspike ranking uses realistic levels instead of level 20. */
function simBuildDamage(
  items: string[],
  byName: Map<string, ItemCatalogEntry>,
  scenario: Scenario,
  options: SimDamageOptions,
): number {
  const partialStacks: Record<string, number> = { ...(scenario.attacker.partialStacks ?? {}) }
  const prefixSteps: RotationAction[] = []
  const useEvolve = options.conservativeStacks ? false : options.evolve
  if (useEvolve) {
    for (const name of items) {
      const entry = byName.get(name)
      if (!entry) continue
      if (!shouldAutoEvolveStackingItem(entry)) continue
      const max = maxStackCountFor(entry)
      if (max && max > 0) {
        const internal = entry.internalKey ?? ''
        const display = entry.displayName ?? ''
        if (partialStacks[internal] == null && partialStacks[display] == null) {
          if (internal) partialStacks[internal] = max
          else if (display) partialStacks[display] = max
        }
      }
    }
  }
  for (const name of items) {
    const entry = byName.get(name)
    if (entry && options.activeSet.has(name) && itemHasActive(entry)) {
      prefixSteps.push({ kind: 'activate', itemKey: entry.internalKey ?? name })
    }
  }
  const projectedScenario =
    options.minute != null && options.mode
      ? projectScenarioForMinute(scenario, options.minute, options.mode, options.role)
      : scenario
  const subScenario: Scenario = {
    ...projectedScenario,
    attacker: { ...projectedScenario.attacker, items, partialStacks },
    rotation: prefixSteps.length > 0 ? [...prefixSteps, ...projectedScenario.rotation] : projectedScenario.rotation,
  }
  try {
    const result = runScenario(subScenario)
    return result.totals.total
  } catch {
    return 0
  }
}

function buildStarterAndRest(
  items: string[],
  byName: Map<string, ItemCatalogEntry>,
): { starter: string | null; rest: string[] } {
  let starter: string | null = null
  const rest: string[] = []
  for (const name of items) {
    const entry = byName.get(name)
    if (!starter && entry && isFinalBuildStarter(entry)) {
      starter = name
      continue
    }
    rest.push(name)
  }
  return { starter, rest }
}

function summarizePowerSpike(buildOrder: BuildOrderStep[], score: number): PowerSpikeSummary {
  const peak = buildOrder
    .slice(1)
    .sort((a, b) => {
      if (b.spikeEfficiency !== a.spikeEfficiency) return b.spikeEfficiency - a.spikeEfficiency
      if (b.marginalDamage !== a.marginalDamage) return b.marginalDamage - a.marginalDamage
      return a.estimatedMinute - b.estimatedMinute
    })[0] ?? buildOrder[0]
  return {
    averageDamage: score,
    peakItem: peak?.name ?? '',
    peakMinute: peak?.estimatedMinute ?? 0,
    peakLevel: peak?.projectedLevel ?? 1,
    peakMarginalDamage: peak?.marginalDamage ?? 0,
    peakEfficiency: peak?.spikeEfficiency ?? 0,
  }
}

function computePowerSpikePath(params: {
  items: string[]
  byName: Map<string, ItemCatalogEntry>
  scenario: Scenario
  role: RoleId
  mode: 'casual' | 'ranked'
  evolve: boolean
  activeSet: Set<string>
}): { buildOrder: BuildOrderStep[]; score: number; summary: PowerSpikeSummary } {
  const { items, byName, scenario, role, mode, evolve, activeSet } = params
  const cat = loadRoleMetrics()
  const avgGameMinutes = cat.avgGameLengthMin[mode]
  const { starter, rest } = buildStarterAndRest(items, byName)
  const orderedSteps: BuildOrderStep[] = []
  const purchased = starter ? [starter] : []
  let cumulativeCost = 0
  let previousDamage = 0

  if (starter) {
    const starterDamage = simBuildDamage(purchased, byName, scenario, {
      evolve,
      activeSet,
      minute: 0,
      role,
      mode,
      conservativeStacks: true,
    })
    orderedSteps.push({
      name: starter,
      itemCost: itemGoldCost(byName.get(starter)),
      cumulativeCost: 0,
      estimatedMinute: 0,
      projectedLevel: 1,
      damage: starterDamage,
      marginalDamage: starterDamage,
      spikeEfficiency: starterDamage,
    })
    previousDamage = starterDamage
  }

  const baseEarlyDamage = purchased.length > 0
    ? previousDamage
    : simBuildDamage([], byName, scenario, {
        evolve: false,
        activeSet,
        minute: 0,
        role,
        mode,
        conservativeStacks: true,
      })

  const scored = rest.map((name) => {
    const itemCost = itemGoldCost(byName.get(name))
    const projectedMinute = minuteToReachGold(role, cumulativeCost + itemCost, mode)
    const earlyDamage = simBuildDamage([...purchased, name], byName, scenario, {
      evolve,
      activeSet,
      minute: projectedMinute,
      role,
      mode,
      conservativeStacks: true,
    })
    const baseline = purchased.length > 0
      ? simBuildDamage(purchased, byName, scenario, {
          evolve,
          activeSet,
          minute: projectedMinute,
          role,
          mode,
          conservativeStacks: true,
        })
      : baseEarlyDamage
    const marginalDamage = Math.max(0, earlyDamage - baseline)
    return {
      name,
      itemCost,
      earlyDamage,
      marginalDamage,
      spikeEfficiency: itemCost > 0 ? marginalDamage / itemCost : marginalDamage,
    }
  })

  scored.sort((a, b) => {
    if (b.spikeEfficiency !== a.spikeEfficiency) return b.spikeEfficiency - a.spikeEfficiency
    if (b.marginalDamage !== a.marginalDamage) return b.marginalDamage - a.marginalDamage
    return a.name.localeCompare(b.name)
  })

  for (const step of scored) {
    purchased.push(step.name)
    cumulativeCost += step.itemCost
    const estimatedMinute = minuteToReachGold(role, cumulativeCost, mode)
    const projectedLevel = levelAt(estimatedMinute, mode, role)
    const damage = simBuildDamage(purchased, byName, scenario, {
      evolve,
      activeSet,
      minute: estimatedMinute,
      role,
      mode,
      conservativeStacks: true,
    })
    const marginalDamage = Math.max(0, damage - previousDamage)
    orderedSteps.push({
      name: step.name,
      itemCost: step.itemCost,
      cumulativeCost,
      estimatedMinute,
      projectedLevel,
      damage,
      marginalDamage,
      spikeEfficiency: step.itemCost > 0 ? marginalDamage / step.itemCost : marginalDamage,
    })
    previousDamage = damage
  }

  let accumulated = 0
  for (let i = 0; i < orderedSteps.length; i++) {
    const step = orderedSteps[i]
    const start = Math.min(avgGameMinutes, step.estimatedMinute)
    const end = Math.min(avgGameMinutes, orderedSteps[i + 1]?.estimatedMinute ?? avgGameMinutes)
    if (end > start) accumulated += step.damage * (end - start)
  }
  const score = avgGameMinutes > 0 ? accumulated / avgGameMinutes : 0
  return {
    buildOrder: orderedSteps,
    score,
    summary: summarizePowerSpike(orderedSteps, score),
  }
}
