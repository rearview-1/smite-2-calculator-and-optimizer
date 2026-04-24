import { Worker } from 'node:worker_threads'
import { availableParallelism } from 'node:os'
import { optimize, type OptimizeRequest, type OptimizeResult, type OptimizedBuild } from './optimize.ts'

const PARALLEL_MIN_PERMUTATIONS = 10_000
const MAX_WORKERS = 16
const MIN_PER_WORKER_PERMUTATIONS = 4_000

function shouldParallelize(req: OptimizeRequest): boolean {
  const maxPerms = req.maxPermutations ?? 20_000
  return maxPerms >= PARALLEL_MIN_PERMUTATIONS
}

function mergeResults(results: OptimizeResult[], req: OptimizeRequest, workerCount: number, elapsedMs: number): OptimizeResult {
  const topN = req.topN ?? 100
  const warnings = [...new Set(results.flatMap((r) => r.warnings))]
  const searched = results.reduce((sum, r) => sum + r.searched, 0)
  const total = results[0]?.total ?? 0
  const deduped = new Map<string, OptimizedBuild>()
  const styleLeaders: NonNullable<OptimizeResult['styleLeaders']> = {}

  for (const result of results) {
    for (const build of result.results) {
      const key = build.items.slice().sort().join('|')
      const existing = deduped.get(key)
      if (!existing || build.rankScore > existing.rankScore) deduped.set(key, build)
    }
  }

  const merged = [...deduped.values()]
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, topN)

  for (const result of results) {
    for (const [style, leader] of Object.entries(result.styleLeaders ?? {})) {
      if (!leader) continue
      const key = style as keyof NonNullable<OptimizeResult['styleLeaders']>
      const current = styleLeaders[key]
      if (!current || leader.rankScore > current.rankScore) styleLeaders[key] = leader
    }
  }

  return {
    searched,
    total,
    results: merged,
    elapsedMs,
    warnings,
    parallelismUsed: workerCount,
    styleLeaders,
  }
}

function runWorker(request: OptimizeRequest): Promise<OptimizeResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./optimizeWorker.ts', import.meta.url), {
      workerData: request,
      execArgv: process.execArgv,
    })
    worker.once('message', (result) => resolve(result as OptimizeResult))
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`optimizer worker exited with code ${code}`))
    })
  })
}

export async function optimizeParallel(req: OptimizeRequest): Promise<OptimizeResult> {
  const cpuCount = Math.max(1, availableParallelism())
  if (!shouldParallelize(req) || cpuCount <= 1) return optimize(req)

  const maxPerms = req.maxPermutations ?? 20_000
  const workerCount = Math.max(
    2,
    Math.min(
      MAX_WORKERS,
      cpuCount,
      Math.max(2, Math.floor(maxPerms / MIN_PER_WORKER_PERMUTATIONS)),
    ),
  )
  const perWorkerMaxPerms = Math.max(1, Math.ceil(maxPerms / workerCount))
  const started = Date.now()

  try {
    const shardRequests = Array.from({ length: workerCount }, (_, shardIndex) => ({
      ...req,
      maxPermutations: perWorkerMaxPerms,
      shardIndex,
      shardCount: workerCount,
      shuffleSeed: `${req.shuffleSeed ?? 'parallel'}:shard:${shardIndex}`,
    } satisfies OptimizeRequest))
    const shardResults = await Promise.all(shardRequests.map((request) => runWorker(request)))
    return mergeResults(shardResults, req, workerCount, Date.now() - started)
  } catch {
    const fallback = optimize(req)
    return {
      ...fallback,
      warnings: [...fallback.warnings, 'Parallel optimizer failed; fell back to single-threaded search.'],
    }
  }
}
