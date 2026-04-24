import type { Curve } from './curve.ts'
import type { AbilitySlot } from '../sim/v3/types.ts'

type AbilityFallbackMap = Partial<Record<AbilitySlot, Record<string, Curve>>>

const curve = (pairs: Array<[number, number]>): Curve => ({
  interp: 'linear',
  keys: pairs.map(([t, v]) => ({ t, v })),
})

// Local-data-backed supplemental rows for abilities whose probe CT exists but
// the current extractor did not surface into gods-catalog.json.
const ABILITY_ROW_FALLBACKS: Record<string, AbilityFallbackMap> = {
  Amaterasu: {
    A02: {
      'Damage': curve([[1, 80], [2, 120], [3, 160], [4, 200], [5, 240]]),
      'STR Scaling Damage': curve([[1, 0.6], [5, 0.6]]),
      'INT Scaling Damage': curve([[1, 0.6], [5, 0.6]]),
      'Mitigation Buff': curve([[1, -15], [5, -15]]),
      'INT Scaling Mitigation': curve([[1, 0.05], [5, 0.05]]),
      'Mana Cost': curve([[1, 60], [2, 65], [3, 70], [4, 75], [5, 80]]),
    },
    A03: {
      'Dash Damage': curve([[1, 80], [2, 135], [3, 190], [4, 245], [5, 300]]),
      'Dash Scaling': curve([[1, 0.6], [5, 0.6]]),
      'Silence Duration': curve([[1, 1], [5, 1]]),
      'Mana Cost': curve([[1, 60], [5, 60]]),
    },
  },
  Baron_Samedi: {
    A01: {
      'Base Damage': curve([[1, 70], [5, 290]]),
      'Int Scaling': curve([[1, 0.7], [5, 0.7]]),
      'Second Hit Damage Dealt': curve([[1, 0.35], [5, 0.35]]),
      'Power Reduction %': curve([[1, 0.2], [5, 0.2]]),
      'Attack Speed Reduction %': curve([[1, 20], [5, 20]]),
      'Power Reduction Duration': curve([[1, 3], [5, 5]]),
      'Power Reduction Prot Scaling': curve([[1, 0.05], [5, 0.05]]),
      'Attack Speed Reduction Prot Scaling': curve([[1, 0.05], [5, 0.05]]),
      'Hysteria Per Hit': curve([[1, 15], [5, 15]]),
      'TalentDotHysteria': curve([[1, 5], [5, 5]]),
      'TalentDotDuration': curve([[1, 2], [5, 2]]),
      'Cost': curve([[1, 55], [5, 75]]),
    },
    A02: {
      'Base Damage': curve([[1, 85], [5, 305]]),
      'Int Scaling': curve([[1, 0.8], [5, 0.8]]),
      'Base Heal': curve([[1, 25], [5, 65]]),
      'Missing Health Heal': curve([[1, 0.03], [5, 0.03]]),
      'Speed Buff': curve([[1, 25], [5, 35]]),
      'Speed Buff Duration': curve([[1, 3], [5, 4]]),
      'Cooldown Rate Scaling': curve([[1, 0.05], [5, 0.05]]),
      'Hysteria Per Hit': curve([[1, 20], [5, 20]]),
      'TalentSlow': curve([[1, 10], [5, 20]]),
      'TalentSlowDuration': curve([[1, 1], [5, 1]]),
      'BaseDamageTalent': curve([[1, 40], [5, 120]]),
      'ScalingDamageTalent': curve([[1, 0], [5, 0]]),
      'Cost': curve([[1, 60], [5, 60]]),
    },
    A03: {
      'Damage Per Tick': curve([[1, 18], [5, 58]]),
      'Int Scaling Per Tick': curve([[1, 0.1], [5, 0.1]]),
      'Explosion Damage': curve([[1, 90], [5, 290]]),
      'Explosion Int Scaling': curve([[1, 0.5], [5, 0.5]]),
      'Slow Duration': curve([[1, 1.75], [5, 1.75]]),
      'Root Duration': curve([[1, 0.75], [5, 0.75]]),
      'Slow and Root Duration': curve([[1, 2.5], [5, 2.5]]),
      'Mesmerize Duration': curve([[1, 1.5], [5, 1.5]]),
      'Hysteria Per Tick': curve([[1, 5], [5, 5]]),
      'Explosion Hysteria': curve([[1, 25], [5, 25]]),
      'Cost': curve([[1, 60], [5, 80]]),
    },
    A04: {
      'Damage Per Tick': curve([[1, 15], [5, 35]]),
      'Int Scaling': curve([[1, 0.07], [5, 0.07]]),
      'Damage On Hit': curve([[1, 200], [5, 480]]),
      'On Hit Int Scaling': curve([[1, 0.7], [5, 0.7]]),
      'Max Health Damage': curve([[1, 0.1], [5, 0.1]]),
      'Stun Duration': curve([[1, 1.3], [5, 1.3]]),
      'Hysteria Per Hit': curve([[1, 2], [5, 2]]),
      'Self Damage Reduction': curve([[1, 50], [5, 50]]),
      'Self Slow Penalty': curve([[1, 30], [5, 20]]),
      'ProtectionScaling': curve([[1, 0.025], [5, 0.025]]),
      'HysteriaPerSlam': curve([[1, 30], [5, 30]]),
      'Cost': curve([[1, 70], [5, 90]]),
    },
  },
  Nu_Wa: {
    A04: {
      'Base Damage': curve([[1, 100], [5, 400]]),
      'Int Scaling': curve([[1, 0.3], [5, 0.3]]),
      'Cost': curve([[1, 100], [5, 100]]),
    },
  },
}

export function getFallbackAbilityRows(
  godId: string,
  slot: AbilitySlot,
): Record<string, Curve> | null {
  return ABILITY_ROW_FALLBACKS[godId]?.[slot] ?? null
}
