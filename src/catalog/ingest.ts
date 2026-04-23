import { readFileSync } from 'node:fs'
import type { Curve, CurveInterp } from './curve.ts'

interface UnrealCurveKey {
  Time: number
  Value: number
}

interface UnrealCurveRow {
  InterpMode?: number
  ['Keys[1]']?: UnrealCurveKey[]
}

interface UnrealCurveTable {
  Type: string
  Name: string
  CurveTableMode?: string
  Rows: Record<string, UnrealCurveRow>
}

function toInterp(mode: number | undefined): CurveInterp {
  return mode === 1 ? 'step' : 'linear'
}

export function readCurveTable(path: string): Record<string, Curve> {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as UnrealCurveTable[]
  const table = raw.find((entry) => entry.Type === 'CurveTable')
  if (!table) throw new Error(`No CurveTable in ${path}`)

  const out: Record<string, Curve> = {}
  for (const [rowName, row] of Object.entries(table.Rows)) {
    const keys = (row['Keys[1]'] ?? []).map((k) => ({ t: k.Time, v: k.Value }))
    if (keys.length === 0) continue
    out[rowName] = { keys, interp: toInterp(row.InterpMode) }
  }
  return out
}

export function pickStatCurve(
  table: Record<string, Curve>,
  statName: string,
): Curve | undefined {
  return table[`Character.Stat.${statName}`]
}
