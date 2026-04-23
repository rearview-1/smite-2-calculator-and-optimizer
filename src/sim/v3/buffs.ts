/**
 * Pre-wired map/objective/drop buffs and debuffs. Applied at scenario start
 * (via BuildInput.activeBuffs or EnemyInput.activeBuffs) or triggered mid-combat
 * via a rotation action.
 *
 * Values are taken from the effects-catalog's authored tooltip text where
 * possible; flagged as approximate where the tooltip is qualitative.
 */

export interface DropBuffDef {
  key: string
  label: string
  target: 'self' | 'enemy'
  defaultDurationSeconds: number
  modifiers: Partial<Record<string, number>>
  /** If > 0, buff falls off this many seconds after taking damage. Pathfinder-style. */
  dropOnDamageSeconds?: number
  /** Free-form note. */
  note?: string
}

export const DROP_BUFFS: Record<string, DropBuffDef> = {
  // Pathfinder (Speed Buff) — Centaur camp. Tier 3 values from JungleBuff.PathfinderV2.3
  'Pathfinder.3': {
    key: 'Pathfinder.3',
    label: 'Pathfinder III',
    target: 'self',
    defaultDurationSeconds: 120,
    modifiers: { Pathfinding: 15, Tenacity: 15 },
    dropOnDamageSeconds: 6,
    note: '+15 Pathfinding, +15 Tenacity; Trail Lost for 6s after damage',
  },
  // Red Buff (generic damage buff) — placeholder until actual Red Buff GE is probed
  'RedBuff': {
    key: 'RedBuff',
    label: 'Red Buff',
    target: 'self',
    defaultDurationSeconds: 120,
    modifiers: { PhysicalPower: 22, MagicalPower: 22 },  // approximation; real value is level-scaled
    note: 'approximate — exact values depend on patch',
  },
  // Fire Giant
  'FireGiant': {
    key: 'FireGiant',
    label: 'Fire Giant Buff',
    target: 'self',
    defaultDurationSeconds: 240,
    modifiers: { PhysicalPower: 30, MagicalPower: 30, MovementSpeed: 30 },
    note: 'approximate — objective buff, durations/values from tooltip text',
  },
  // Enhanced Fire Giant
  'EnhancedFireGiant': {
    key: 'EnhancedFireGiant',
    label: 'Enhanced Fire Giant',
    target: 'self',
    defaultDurationSeconds: 240,
    modifiers: { PhysicalPower: 46, MagicalPower: 46, MovementSpeed: 30 },
    note: 'approximate — EFG numbers scaled up from FG',
  },
  // Gold Fury / Gilded Speed
  'GoldFury': {
    key: 'GoldFury',
    label: 'Gold Fury Buff',
    target: 'self',
    defaultDurationSeconds: 60,
    modifiers: { MovementSpeed: 10 },
    note: 'approximate — gold-only buff in current patches mostly',
  },
  // Elixir of Power (generic)
  'ElixirOfPower': {
    key: 'ElixirOfPower',
    label: 'Elixir of Power',
    target: 'self',
    defaultDurationSeconds: 240,
    modifiers: { PhysicalPower: 35, MagicalPower: 50 },
    note: 'approximate — values from in-game elixir description',
  },
  // Blue Buff (Mana) — Furies camp. Tier 1 approximation.
  'BlueBuff': {
    key: 'BlueBuff',
    label: 'Blue Buff (Furies)',
    target: 'self',
    defaultDurationSeconds: 120,
    modifiers: { ManaPerTime: 8, CooldownReductionPercent: 10 },
    note: 'approximate — mana regen + 10% CDR, scaled per-tier',
  },
  // Minor normal camp — Manticores / Minotaur / etc. (legacy Smite 1: Purple Buff)
  'DamageBuff': {
    key: 'DamageBuff',
    label: 'Damage Buff',
    target: 'self',
    defaultDurationSeconds: 90,
    modifiers: { PhysicalPower: 15, MagicalPower: 15 },
    note: 'approximate — normal-camp damage buff',
  },
  // Elixir of Speed / Dexterity
  'ElixirOfSpeed': {
    key: 'ElixirOfSpeed',
    label: 'Elixir of Speed',
    target: 'self',
    defaultDurationSeconds: 240,
    modifiers: { MovementSpeed: 30, AttackSpeedPercent: 15 },
    note: 'approximate',
  },
}
