/**
 * Role-based macro metrics (GPM, XP/min, avg game length) for optimizer
 * power-spike scoring. Values live in `data/role-metrics.json`.
 *
 * The current schema is mode-aware per role:
 *   roles[role].casual / roles[role].ranked
 *
 * This loader also normalizes the older flat schema so the rest of the
 * optimizer can consume one shape.
 */

import { readFileSync } from 'node:fs'

export type RoleId = 'carry' | 'mid' | 'solo' | 'jungle' | 'support'
export type RoleMetricsMode = 'casual' | 'ranked'

export interface RoleModeStats {
  gpm: number
  xpPerMin: number
  levelPerMin: number
  firstItemCompleteMin: number
  fullBuildMin: number
  teamGoldShare?: number
  samplePlayers?: number
  note?: string
}

export interface RoleMetricsCatalog {
  avgGameLengthMin: Record<RoleMetricsMode, number>
  avgTeamGpm?: Record<RoleMetricsMode, number>
  avgTeamGold?: Record<RoleMetricsMode, number>
  levelPerMin: Record<RoleMetricsMode, number>
  roles: Record<RoleId, Record<RoleMetricsMode, RoleModeStats>>
  lastUpdated: string
  source: string
}

interface LegacyRoleStats {
  gpm: number
  xpPerMin: number
  firstItemCompleteMin: number
  fullBuildMin: number
  note?: string
}

let _cached: RoleMetricsCatalog | null = null

function normalizeLegacyModeStats(
  rawRole: LegacyRoleStats,
  fallbackLevelPerMin: Record<RoleMetricsMode, number>,
): Record<RoleMetricsMode, RoleModeStats> {
  return {
    casual: {
      ...rawRole,
      levelPerMin: fallbackLevelPerMin.casual,
    },
    ranked: {
      ...rawRole,
      levelPerMin: fallbackLevelPerMin.ranked,
    },
  }
}

export function loadRoleMetrics(): RoleMetricsCatalog {
  if (_cached) return _cached
  const raw = JSON.parse(readFileSync('data/role-metrics.json', 'utf-8')) as Record<string, unknown>

  const avgGameLengthMin = (raw.avgGameLengthMin ?? { casual: 30, ranked: 30 }) as Record<RoleMetricsMode, number>
  const rawLevelPerMin = raw.levelPerMin
  const normalizedLevelPerMin: Record<RoleMetricsMode, number> =
    typeof rawLevelPerMin === 'number'
      ? { casual: rawLevelPerMin, ranked: rawLevelPerMin }
      : (rawLevelPerMin as Record<RoleMetricsMode, number> ?? { casual: 0.6, ranked: 0.6 })

  const rolesRaw = (raw.roles ?? {}) as Record<RoleId, LegacyRoleStats | Record<RoleMetricsMode, RoleModeStats>>
  const roles = Object.fromEntries(
    (['carry', 'mid', 'solo', 'jungle', 'support'] as RoleId[]).map((role) => {
      const entry = rolesRaw[role]
      if (entry && typeof entry === 'object' && 'casual' in entry && 'ranked' in entry) {
        return [role, entry as Record<RoleMetricsMode, RoleModeStats>]
      }
      return [role, normalizeLegacyModeStats(entry as LegacyRoleStats, normalizedLevelPerMin)]
    }),
  ) as Record<RoleId, Record<RoleMetricsMode, RoleModeStats>>

  _cached = {
    avgGameLengthMin,
    avgTeamGpm: raw.avgTeamGpm as Record<RoleMetricsMode, number> | undefined,
    avgTeamGold: raw.avgTeamGold as Record<RoleMetricsMode, number> | undefined,
    levelPerMin: normalizedLevelPerMin,
    roles,
    lastUpdated: String(raw.lastUpdated ?? ''),
    source: String(raw.source ?? ''),
  }
  return _cached
}

/** Gold a player of the given role has earned by `minute`. */
export function goldAt(role: RoleId, minute: number, mode: RoleMetricsMode): number {
  return loadRoleMetrics().roles[role][mode].gpm * minute
}

/** Minute a role expects to have `gold` in hand. */
export function minuteToReachGold(role: RoleId, gold: number, mode: RoleMetricsMode): number {
  const gpm = loadRoleMetrics().roles[role][mode].gpm
  return gpm > 0 ? gold / gpm : Infinity
}

/** Rough level a character reaches by `minute`, capped at 20. */
export function levelAt(minute: number, mode: RoleMetricsMode, role?: RoleId): number {
  const levelPerMin = role
    ? loadRoleMetrics().roles[role][mode].levelPerMin
    : loadRoleMetrics().levelPerMin[mode]
  return Math.max(1, Math.min(20, Math.round(1 + minute * levelPerMin)))
}

export function powerSpikeScore(params: {
  totalBuildCost: number
  totalDamage: number
  role: RoleId
  mode: RoleMetricsMode
}): number {
  const { totalBuildCost, totalDamage, role, mode } = params
  const cat = loadRoleMetrics()
  const gameLen = cat.avgGameLengthMin[mode]
  const minutesToComplete = minuteToReachGold(role, totalBuildCost, mode)
  const usefulMinutes = Math.max(0, gameLen - minutesToComplete)
  const uptimeFraction = gameLen > 0 ? usefulMinutes / gameLen : 0
  return totalDamage * uptimeFraction
}
