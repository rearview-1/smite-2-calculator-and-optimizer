import { parentPort, workerData } from 'node:worker_threads'
import { optimize, type OptimizeRequest, type OptimizeResult } from './optimize.ts'

const result: OptimizeResult = optimize(workerData as OptimizeRequest)
parentPort?.postMessage(result)
