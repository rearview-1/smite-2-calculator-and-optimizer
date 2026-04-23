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
import { loadItems } from '../catalog/loadCatalogs.ts'
import {
  getFinalBuildItemExclusionReason,
  isFinalBuildStarter,
  itemDisplayName,
  shouldPreferItemRecord,
} from '../catalog/itemEligibility.ts'
import {
  buildExclusionIndex,
  comboViolatesExclusion,
  computeExclusionGroups,
} from '../catalog/itemGroups.ts'
import type { RotationAction, Scenario, SimResult } from '../sim/v3/types.ts'

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
   *              weighted heavier than raw DPS. */
  rankBy?: 'total' | 'physical' | 'magical' | 'true' | 'dps' | 'ability' | 'brawling' | 'bruiser' | 'burst' | 'bruiserBurst'

  /** When `rankBy === 'ability'`, sum damage of all events whose label includes
   *  this substring (case-insensitive). Example: "Flurry" catches all Flurry
   *  Strike hits. "A02" doesn't work — use the display label instead. */
  rankByAbilityLabel?: string

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
}

export interface OptimizedBuild {
  items: string[]
  totals: { total: number; physical: number; magical: number; true: number }
  comboExecutionTime: number
  dps: number
  /** The score this build was ranked on — total damage by default, or the
   *  ability-filtered total if rank-by-ability is active. */
  rankScore: number
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

function comboKey(items: string[]): string {
  return items.slice().sort().join('|')
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

function summarize(items: string[], result: SimResult, snapshotStats: OptimizedBuild['stats'], rankScore: number): OptimizedBuild {
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
    stats: snapshotStats,
  }
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
            yield [s, ...lockedRegular, ...combo]
          }
        }
      } else {
        const seen = new Set<number>()
        const produced = new Set<string>()
        for (let tries = 0; tries < maxPerms * 10 && produced.size < maxPerms; tries++) {
          const pick = Math.floor(rng() * full)
          const s = starterChoices[Math.floor(pick / perStarterCount)]
          const combo = sampleK(regularChoices, remainingRegularSlots, seen, rng)
          if (!combo) continue
          const key = comboKey([s, ...lockedRegular, ...combo])
          if (produced.has(key)) continue
          produced.add(key)
          yield [s, ...lockedRegular, ...combo]
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
          for (const combo of combinations(regularChoices, remainingSlots)) yield [...lockedNames, ...combo]
        } else {
          for (const combo of combinations(regularChoices, remainingSlots)) yield [...lockedNames, ...combo]
          for (const s of starterChoices) {
            for (const combo of combinations(regularChoices, remainingSlots - 1)) {
              yield [...lockedNames, s, ...combo]
            }
          }
        }
      } else {
        const seen = new Set<number>()
        const produced = new Set<string>()
        for (let tries = 0; tries < maxPerms * 10 && produced.size < maxPerms; tries++) {
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
  const keep: OptimizedBuild[] = []
  let min = -Infinity  // lowest score currently in keep

  const evolve = req.evolveStackingItems ?? true
  const activeSet = new Set(req.activeItems ?? [])
  const conditionalStackItems = new Set<string>()

  // Mutual-exclusion groups — builds with ≥2 items from the same group are
  // skipped (e.g. Titan's Bane + Obsidian Shard share the 35%-pen unique
  // passive and the game only applies one). Checked before we do any sim work.
  const exclusionGroups = computeExclusionGroups(Object.values(itemsCatalog))
  const exclusionIndex = buildExclusionIndex(exclusionGroups)
  let rejectedByExclusion = 0

  for (const combo of builds()) {
    if (searched >= maxPerms) break
    searched++

    if (comboViolatesExclusion(combo, exclusionIndex)) {
      rejectedByExclusion++
      continue
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
      if (!statsPass(stats)) { filtered++; continue }

      const dps = sim.comboExecutionTime > 0 ? sim.totals.total / sim.comboExecutionTime : sim.totals.total
      if (req.minTotalDamage != null && sim.totals.total < req.minTotalDamage) { filtered++; continue }
      if (req.maxTotalDamage != null && sim.totals.total > req.maxTotalDamage) { filtered++; continue }
      if (req.minDps != null && dps < req.minDps) { filtered++; continue }

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

      const score =
        rankBy === 'physical' ? sim.totals.physical
        : rankBy === 'magical' ? sim.totals.magical
        : rankBy === 'true' ? sim.totals.true
        : rankBy === 'dps' ? dps
        : rankBy === 'ability' ? abilityScore(sim)
        : rankBy === 'bruiser' ? bruiserScore
        : rankBy === 'brawling' ? brawlingScore
        : rankBy === 'burst' ? burstScore
        : rankBy === 'bruiserBurst' ? bruiserBurstScore
        : sim.totals.total

      if (keep.length < topN || score > min) {
        const summary = summarize(combo, sim, stats, score)
        keep.push(summary)
        keep.sort((a, b) => b.rankScore - a.rankScore)
        if (keep.length > topN) keep.length = topN
        min = keep[keep.length - 1].rankScore
      }
    } catch {
      // Skip builds that throw — typically item-resolution issues.
    }
  }

  if (shuffle && totalPermsEstimate > maxPerms && searched < maxPerms) {
    warnings.push(`Deterministic sampler produced ${searched.toLocaleString()} unique builds before retry exhaustion. Increase the item pool or lower max permutations if this persists.`)
  }
  if (filtered > 0) warnings.push(`${filtered.toLocaleString()} builds dropped by post-filters (stat bounds / damage bounds).`)
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

  return {
    searched,
    total: Math.min(totalPermsEstimate, maxPerms),
    results: keep,
    elapsedMs: Date.now() - started,
    warnings,
  }
}
