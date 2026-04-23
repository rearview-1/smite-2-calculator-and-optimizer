/**
 * Items whose passive only procs under a trigger the sim can't model
 * (hard CC, low HP, stealth, etc.). By default these contribute only their
 * baseline stats. When `options.forceConditionalItemEffects` is true, the
 * bonuses here are added to the attacker's stats as if the trigger were
 * permanently active.
 *
 * Register new items here when you flag them — keep each entry minimal and
 * justified with a passive-text quote so it's auditable.
 */

export interface ConditionalBonus {
  /** Flat stat additions while the trigger is active. Keys match
   *  ResolvedItemStats.stats + PhysicalPower/MagicalPower (adaptive). */
  stats?: Record<string, number>
  /** Per-level stat additions while the trigger is active. */
  statsPerLevel?: Record<string, number>
  /** Percent bonus to protections from items while the trigger is active. */
  itemProtectionAmplifierPct?: { physical: number; magical: number }
  /** Plain-English description of the trigger — shown in UI warnings. */
  trigger: string
  /** Optional: why this is registered, for audit. */
  note?: string
}

export const CONDITIONAL_ITEM_BONUSES: Record<string, ConditionalBonus> = {
  'item.SpiritRobe': {
    trigger: 'Hit by Hard Crowd Control',
    stats: { PhysicalProtection: 40, MagicalProtection: 40 },
    note: '+40 prot both types + 4%HP heal over 6s under CC. HoT not modeled.',
  },
  'item.Bagua Mirror': {
    trigger: 'Take Magical Damage',
    stats: { PhysicalPower: 5, MagicalPower: 5 },
    statsPerLevel: { PhysicalPower: 1, MagicalPower: 2 },
    note: '+5 +1/level Strength and +5 +2/level Intelligence for 6s after taking Magical Damage.',
  },
  'Item.BerserkersShield': {
    trigger: 'Fall below 60% Health',
    stats: { AttackSpeedPercent: 25 },
    itemProtectionAmplifierPct: { physical: 65, magical: 65 },
    note: '+25% Attack Speed and +65% protections from items while Berserk.',
  },
  'item.BancroftsTalon': {
    trigger: 'Missing Health, capped at 40% Health',
    stats: { MagicalPower: 60, MagicalLifestealPercent: 10 },
    note: 'Caps at +60 Intelligence and +10% Lifesteal at 40% Health. Baseline sim leaves this off unless conditional passives are forced.',
  },
  // Caestus "When Hard Crowd Controlled" passive — values pending confirmation.
  // Shroud of Vengeance "When Hard Crowd Controlled" — handled as passive utility in itemEffects.
  // Mantle of Discord "below 40% HP" — handled as passive utility in itemEffects.
  // Adamantine Sickle low-HP trigger is a non-final component; Riptalon's above-50% baseline is modeled as a passive buff.
  // Add entries above as we confirm each item's bonus from live game data.
}

export function conditionalBonusFor(internalKey: string | null | undefined): ConditionalBonus | null {
  if (!internalKey) return null
  return CONDITIONAL_ITEM_BONUSES[internalKey] ?? null
}

export function conditionalItemNames(): string[] {
  return Object.keys(CONDITIONAL_ITEM_BONUSES)
}
