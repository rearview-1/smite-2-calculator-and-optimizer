export type CurveInterp = 'linear' | 'step'

export interface CurveKey {
  t: number
  v: number
}

export interface Curve {
  keys: CurveKey[]
  interp: CurveInterp
}

export function interp(curve: Curve, at: number): number {
  const { keys, interp: mode } = curve
  if (keys.length === 0) return 0
  if (at <= keys[0].t) return keys[0].v
  if (at >= keys[keys.length - 1].t) return keys[keys.length - 1].v

  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]
    const b = keys[i + 1]
    if (at === b.t) return b.v
    if (at > a.t && at < b.t) {
      if (mode === 'step') return a.v
      const span = b.t - a.t
      if (span === 0) return a.v
      const f = (at - a.t) / span
      return a.v + (b.v - a.v) * f
    }
    if (at === a.t) return a.v
  }
  return keys[keys.length - 1].v
}
