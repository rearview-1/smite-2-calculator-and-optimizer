export interface DefenseInputs {
  targetProtection: number
  penFlat: number
  penPercent: number
  damageMitigationPercent?: number
}

export function effectiveProtection(d: DefenseInputs): number {
  const afterPercent = d.targetProtection * (1 - d.penPercent / 100)
  return Math.max(0, afterPercent - d.penFlat)
}

export function protectionMultiplier(effProt: number): number {
  return 100 / (100 + effProt)
}

export function applyDefense(preMitigation: number, d: DefenseInputs): number {
  const eff = effectiveProtection(d)
  const mit = protectionMultiplier(eff)
  const dmgTaken = 1 - (d.damageMitigationPercent ?? 0) / 100
  return preMitigation * mit * dmgTaken
}
