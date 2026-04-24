#!/usr/bin/env tsx

import { writeFileSync } from 'node:fs'
import { loadItems, type ItemCatalogEntry } from '../src/catalog/loadCatalogs.ts'
import { getFinalBuildItemExclusionReason, isFinalBuildStarter, itemDisplayName, shouldPreferItemRecord } from '../src/catalog/itemEligibility.ts'

type ModeId = 'casual' | 'ranked'
type RoleId = 'carry' | 'mid' | 'solo' | 'jungle' | 'support'

interface MatchPageMeta {
  queueType: string
  durationSeconds: number
  startTimestamp: string | null
}

interface MatchPlayerRecord {
  id: number
  teamId: number
  assignedRole: string
  playedRole: string | null
  playerLevel: number
  totalGoldEarned: number
  totalXpEarned: number
  totalWardsPlaced: number
  totalDamage: number
  totalDamageMitigated: number
  isBot: boolean
}

interface ParsedMatch {
  url: string
  mode: ModeId
  durationMinutes: number
  startTimestamp: string | null
  players: Array<{
    role: RoleId
    teamId: number
    gold: number
    xp: number
    level: number
    gpm: number
    xpm: number
    levelPerMin: number
  }>
  teamGolds: number[]
}

interface ModeAggregate {
  matchDurations: number[]
  teamGpms: number[]
  teamGolds: number[]
  overallLevelPerMin: number[]
  overallXpm: number[]
  roleSamples: Record<RoleId, Array<{
    gpm: number
    xpm: number
    levelPerMin: number
    teamGoldShare: number
  }>>
  sampledMatches: ParsedMatch[]
}

const DEFAULT_TARGET_MATCHES_PER_MODE = 120
const DEFAULT_MAX_FETCHES = 320
const DEFAULT_CONCURRENCY = 8
const MATCH_SITEMAP_URL = 'https://smitesource.com/sitemaps/matches.xml'
const MATCH_URL_RE = /<loc>(https:\/\/smitesource\.com\/match\/[0-9a-f-]+)<\/loc>/g
const NEXT_FLIGHT_RE = /self\.__next_f\.push\(\[(\d+),"([\s\S]*?)"\]\)<\/script>/g

function parseArgs(argv: string[]) {
  const out = {
    targetPerMode: DEFAULT_TARGET_MATCHES_PER_MODE,
    maxFetches: DEFAULT_MAX_FETCHES,
    concurrency: DEFAULT_CONCURRENCY,
    output: 'data/role-metrics.json',
    rawOutput: 'data/role-metrics-sample.json',
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--target-per-mode' && next) { out.targetPerMode = Math.max(10, Number(next) || out.targetPerMode); i++ }
    else if (arg === '--max-fetches' && next) { out.maxFetches = Math.max(20, Number(next) || out.maxFetches); i++ }
    else if (arg === '--concurrency' && next) { out.concurrency = Math.max(1, Number(next) || out.concurrency); i++ }
    else if (arg === '--output' && next) { out.output = next; i++ }
    else if (arg === '--raw-output' && next) { out.rawOutput = next; i++ }
  }
  return out
}

async function fetchText(url: string, retries = 2): Promise<string> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
          'accept-language': 'en-US,en;q=0.9',
        },
      })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      return await res.text()
    } catch (err) {
      lastErr = err
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

function decodeFlightChunks(html: string): string {
  const parts: string[] = []
  let match: RegExpExecArray | null
  while ((match = NEXT_FLIGHT_RE.exec(html))) {
    try {
      parts.push(JSON.parse(`"${match[2]}"`) as string)
    } catch {
      // Ignore undecodable chunks and keep moving.
    }
  }
  return parts.join('')
}

function extractBalancedObject(text: string, start: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function extractMatchMeta(decoded: string): MatchPageMeta | null {
  const token = '{"queueType":"'
  const idx = decoded.indexOf(token)
  if (idx < 0) return null
  const objectText = extractBalancedObject(decoded, idx)
  if (!objectText) return null
  try {
    const raw = JSON.parse(objectText) as MatchPageMeta
    return raw
  } catch {
    return null
  }
}

function extractPlayerObjects(decoded: string): MatchPlayerRecord[] {
  const out: MatchPlayerRecord[] = []
  const seen = new Set<number>()
  let searchFrom = 0
  while (true) {
    const roleIdx = decoded.indexOf('"assignedRole":"', searchFrom)
    if (roleIdx < 0) break
    const start = decoded.lastIndexOf('{"id":', roleIdx)
    if (start < 0) {
      searchFrom = roleIdx + 1
      continue
    }
    const objectText = extractBalancedObject(decoded, start)
    if (!objectText) {
      searchFrom = roleIdx + 1
      continue
    }
    searchFrom = start + objectText.length
    try {
      const raw = JSON.parse(objectText) as MatchPlayerRecord
      if (
        typeof raw.id === 'number'
        && typeof raw.teamId === 'number'
        && typeof raw.assignedRole === 'string'
        && typeof raw.totalGoldEarned === 'number'
        && typeof raw.totalXpEarned === 'number'
        && typeof raw.playerLevel === 'number'
        && !seen.has(raw.id)
      ) {
        seen.add(raw.id)
        out.push(raw)
      }
    } catch {
      // Skip malformed object and continue.
    }
  }
  return out
}

function queueTypeToMode(queueType: string): ModeId | null {
  if (queueType === 'casual_conquest') return 'casual'
  if (queueType === 'ranked_conquest') return 'ranked'
  return null
}

function normalizeRole(role: string | null | undefined): RoleId | null {
  const normalized = (role ?? '').trim().toLowerCase()
  if (normalized === 'carry' || normalized === 'adc') return 'carry'
  if (normalized === 'middle' || normalized === 'mid') return 'mid'
  if (normalized === 'solo') return 'solo'
  if (normalized === 'jungle') return 'jungle'
  if (normalized === 'support') return 'support'
  return null
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function round(value: number, digits = 1): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function buildFinalBuildCostEstimate(): number {
  const items = loadItems()
  const bestByName = new Map<string, ItemCatalogEntry>()
  for (const entry of Object.values(items)) {
    const name = itemDisplayName(entry)
    if (!name) continue
    if (getFinalBuildItemExclusionReason(entry)) continue
    if (shouldPreferItemRecord(entry, bestByName.get(name))) bestByName.set(name, entry)
  }
  const starters: number[] = []
  const finals: number[] = []
  for (const entry of bestByName.values()) {
    const cost = typeof entry.totalCost === 'number' && entry.totalCost > 0 ? entry.totalCost : 0
    if (cost <= 0) continue
    if (isFinalBuildStarter(entry)) starters.push(cost)
    else finals.push(cost)
  }
  const starterMedian = median(starters) || 600
  const finalMedian = median(finals) || 2800
  return starterMedian + finalMedian * 5
}

async function parseMatchPage(url: string): Promise<ParsedMatch | null> {
  const html = await fetchText(url)
  const decoded = decodeFlightChunks(html)
  if (!decoded) return null
  const meta = extractMatchMeta(decoded)
  if (!meta) return null
  const mode = queueTypeToMode(meta.queueType)
  if (!mode) return null
  if (!(meta.durationSeconds > 0)) return null
  const durationMinutes = meta.durationSeconds / 60
  const rawPlayers = extractPlayerObjects(decoded)
    .filter((player) => !player.isBot)

  if (rawPlayers.length < 8) return null

  const teamGolds = new Map<number, number>()
  for (const player of rawPlayers) {
    teamGolds.set(player.teamId, (teamGolds.get(player.teamId) ?? 0) + player.totalGoldEarned)
  }

  const players = rawPlayers.flatMap((player) => {
    const role = normalizeRole(player.assignedRole || player.playedRole)
    if (!role) return []
    return [{
      role,
      teamId: player.teamId,
      gold: player.totalGoldEarned,
      xp: player.totalXpEarned,
      level: player.playerLevel,
      gpm: player.totalGoldEarned / durationMinutes,
      xpm: player.totalXpEarned / durationMinutes,
      levelPerMin: Math.max(0, player.playerLevel - 1) / durationMinutes,
    }]
  })

  if (players.length < 8) return null

  return {
    url,
    mode,
    durationMinutes,
    startTimestamp: meta.startTimestamp?.replace(/^\$D/, '') ?? null,
    players,
    teamGolds: [...teamGolds.values()],
  }
}

function createEmptyModeAggregate(): ModeAggregate {
  return {
    matchDurations: [],
    teamGpms: [],
    teamGolds: [],
    overallLevelPerMin: [],
    overallXpm: [],
    roleSamples: {
      carry: [],
      mid: [],
      solo: [],
      jungle: [],
      support: [],
    },
    sampledMatches: [],
  }
}

function summarizeMode(
  mode: ModeId,
  agg: ModeAggregate,
  firstTier3Cost: number,
  fullBuildCost: number,
) {
  const roleSummary = Object.fromEntries(
    (Object.keys(agg.roleSamples) as RoleId[]).map((role) => {
      const samples = agg.roleSamples[role]
      const gpm = median(samples.map((sample) => sample.gpm))
      const xpm = median(samples.map((sample) => sample.xpm))
      const levelPerMin = median(samples.map((sample) => sample.levelPerMin))
      const teamGoldShare = median(samples.map((sample) => sample.teamGoldShare))
      return [role, {
        gpm: round(gpm, 1),
        xpPerMin: round(xpm, 1),
        levelPerMin: round(levelPerMin, 3),
        firstItemCompleteMin: gpm > 0 ? round(firstTier3Cost / gpm, 1) : 0,
        fullBuildMin: gpm > 0 ? round(fullBuildCost / gpm, 1) : 0,
        teamGoldShare: round(teamGoldShare, 3),
        samplePlayers: samples.length,
      }]
    }),
  ) as Record<RoleId, {
    gpm: number
    xpPerMin: number
    levelPerMin: number
    firstItemCompleteMin: number
    fullBuildMin: number
    teamGoldShare: number
    samplePlayers: number
  }>

  return {
    avgGameLengthMin: round(median(agg.matchDurations), 1),
    avgTeamGpm: round(median(agg.teamGpms), 1),
    avgTeamGold: round(median(agg.teamGolds), 0),
    avgXpPerMin: round(median(agg.overallXpm), 1),
    levelPerMin: round(median(agg.overallLevelPerMin), 3),
    sampleMatches: agg.sampledMatches.length,
    samplePlayers: Object.values(agg.roleSamples).reduce((sum, samples) => sum + samples.length, 0),
    roles: roleSummary,
    samples: agg.sampledMatches,
    mode,
  }
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  async function run() {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      out[index] = await worker(items[index], index)
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => run())
  await Promise.all(workers)
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const sitemapXml = await fetchText(MATCH_SITEMAP_URL)
  const matchUrls = [...sitemapXml.matchAll(MATCH_URL_RE)]
    .map((match) => match[1])
    .slice(0, args.maxFetches)

  if (matchUrls.length === 0) throw new Error('No match URLs discovered from SmiteSource matches.xml sitemap.')

  console.log(`Sampling up to ${matchUrls.length} recent SmiteSource match pages...`)
  const parsed = await mapLimit(matchUrls, args.concurrency, async (url, index) => {
    try {
      const match = await parseMatchPage(url)
      if ((index + 1) % 25 === 0) console.log(`  fetched ${index + 1}/${matchUrls.length}`)
      return match
    } catch {
      return null
    }
  })

  const aggregates: Record<ModeId, ModeAggregate> = {
    casual: createEmptyModeAggregate(),
    ranked: createEmptyModeAggregate(),
  }

  for (const match of parsed) {
    if (!match) continue
    const agg = aggregates[match.mode]
    const currentCount = agg.sampledMatches.length
    if (currentCount >= args.targetPerMode) continue

    agg.sampledMatches.push(match)
    agg.matchDurations.push(match.durationMinutes)
    for (const teamGold of match.teamGolds) {
      agg.teamGolds.push(teamGold)
      agg.teamGpms.push(teamGold / match.durationMinutes)
    }
    const teamGoldById = new Map<number, number>()
    match.players.forEach((player) => {
      teamGoldById.set(player.teamId, (teamGoldById.get(player.teamId) ?? 0) + player.gold)
    })
    for (const player of match.players) {
      agg.overallLevelPerMin.push(player.levelPerMin)
      agg.overallXpm.push(player.xpm)
      const teamGold = teamGoldById.get(player.teamId) ?? 0
      agg.roleSamples[player.role].push({
        gpm: player.gpm,
        xpm: player.xpm,
        levelPerMin: player.levelPerMin,
        teamGoldShare: teamGold > 0 ? player.gold / teamGold : 0,
      })
    }
  }

  const firstTier3Cost = 2800
  const fullBuildCost = buildFinalBuildCostEstimate()
  const casual = summarizeMode('casual', aggregates.casual, firstTier3Cost, fullBuildCost)
  const ranked = summarizeMode('ranked', aggregates.ranked, firstTier3Cost, fullBuildCost)

  const output = {
    _schema: {
      description: 'Empirical SMITE 2 Conquest macro-economy metrics generated from recent SmiteSource public match pages.',
      sourceMethod: 'Scraped from SmiteSource matches sitemap + server-rendered match payloads embedded in HTML flight chunks.',
      assumptions: {
        firstTier3Cost,
        fullBuildCost,
        notes: [
          'firstItemCompleteMin is derived as 2800g / median role GPM.',
          'fullBuildMin is derived from an estimated starter + 5-item final build cost based on current catalog medians.',
          'Role gold share is relative to the player team total at match end.',
        ],
      },
      fetchedMatchPages: matchUrls.length,
      requestedMatchesPerMode: args.targetPerMode,
    },
    avgGameLengthMin: {
      casual: casual.avgGameLengthMin,
      ranked: ranked.avgGameLengthMin,
    },
    avgTeamGpm: {
      casual: casual.avgTeamGpm,
      ranked: ranked.avgTeamGpm,
    },
    avgTeamGold: {
      casual: casual.avgTeamGold,
      ranked: ranked.avgTeamGold,
    },
    levelPerMin: {
      casual: casual.levelPerMin,
      ranked: ranked.levelPerMin,
    },
    modes: {
      casual: {
        avgGameLengthMin: casual.avgGameLengthMin,
        avgTeamGpm: casual.avgTeamGpm,
        avgTeamGold: casual.avgTeamGold,
        avgXpPerMin: casual.avgXpPerMin,
        levelPerMin: casual.levelPerMin,
        sampleMatches: casual.sampleMatches,
        samplePlayers: casual.samplePlayers,
      },
      ranked: {
        avgGameLengthMin: ranked.avgGameLengthMin,
        avgTeamGpm: ranked.avgTeamGpm,
        avgTeamGold: ranked.avgTeamGold,
        avgXpPerMin: ranked.avgXpPerMin,
        levelPerMin: ranked.levelPerMin,
        sampleMatches: ranked.sampleMatches,
        samplePlayers: ranked.samplePlayers,
      },
    },
    roles: Object.fromEntries(
      (['carry', 'mid', 'solo', 'jungle', 'support'] as RoleId[]).map((role) => [
        role,
        {
          casual: casual.roles[role],
          ranked: ranked.roles[role],
        },
      ]),
    ),
    lastUpdated: new Date().toISOString().slice(0, 10),
    source: `SmiteSource public match pages sampled from ${MATCH_SITEMAP_URL}. casual=${casual.sampleMatches} matches, ranked=${ranked.sampleMatches} matches.`,
  }

  const rawOutput = {
    generatedAt: new Date().toISOString(),
    source: MATCH_SITEMAP_URL,
    sampledMatches: {
      casual: casual.samples,
      ranked: ranked.samples,
    },
  }

  writeFileSync(args.output, `${JSON.stringify(output, null, 2)}\n`, 'utf-8')
  writeFileSync(args.rawOutput, `${JSON.stringify(rawOutput, null, 2)}\n`, 'utf-8')

  console.log(`Wrote ${args.output}`)
  console.log(`Wrote ${args.rawOutput}`)
  console.log(`Casual conquest: ${casual.sampleMatches} matches, median length ${casual.avgGameLengthMin}m`)
  console.log(`Ranked conquest: ${ranked.sampleMatches} matches, median length ${ranked.avgGameLengthMin}m`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exitCode = 1
})
