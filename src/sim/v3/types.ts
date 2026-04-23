/**
 * Core types for the god-agnostic sim engine (v3).
 *
 * A Scenario is the user's declarative input. The Engine walks it, producing a
 * Timeline of events (damage, buff-apply, buff-expire, debuff-apply, dot-tick,
 * ability-cast, cooldown-expire, rotation-advance). A SimResult is the
 * post-processed view suitable for UIs, tests, or CLI output.
 */

export type DamageType = 'physical' | 'magical' | 'true'
export type AbilitySlot = 'A01' | 'A02' | 'A03' | 'A04'

/** Rotation inputs. Each action advances the clock; 'auto' means "as soon as the engine can fire it". */
export type RotationAction =
  | { kind: 'ability'; slot: AbilitySlot; label?: string; castDuration?: number;
      /** Auto-attack cancel: fire cooldown + on-cast item procs (Hydra, Poly,
       *  Bumba next-basic riders) but skip the ability's own damage. Used when
       *  players cast-cancel an ability to proc items without committing to
       *  the damage windup. */
      cancel?: boolean }
  | { kind: 'basic'; label?: string }
  | { kind: 'wait'; seconds: number; label?: string }
  | { kind: 'activate'; itemKey: string; label?: string }
  | { kind: 'relic'; relicKey: string; label?: string }

export interface BuildInput {
  godId: string
  level: number
  abilityRanks: Record<AbilitySlot, number>
  items: string[]
  aspects?: string[]            // internal keys of equipped god-specific talents/aspects
  /** Character-specific state toggles, e.g. { FenrirRunes: 5 }. */
  godState?: Record<string, number | boolean | string>
  relics?: string[]             // relic item keys
  activeBuffs?: string[]        // map/jungle/objective buffs the player has before combat (Red, EFG, etc.)
  partialStacks?: Record<string, number>  // e.g. { 'item.BookOfThoth': 30 } for 30/50 stacks
  /** Stat bounds used when the UI asks "what's my damage if Strength is between X and Y". */
  statBounds?: { min?: Partial<Record<string, number>>; max?: Partial<Record<string, number>> }
}

export interface EnemyInput {
  godId: string
  level: number
  items?: string[]
  activeBuffs?: string[]   // debuffs applied to this enemy (Void Shield range debuff, etc.)
  flatHealthBonus?: number
}

export interface ScenarioOptions {
  combatWindow?: number               // seconds — if set, sim runs basics repeatedly until rotation + window expire
  greedyBasics?: boolean              // fill gaps with basics when off-cooldown
  penPercentOverride?: number         // testing convenience
  /** Explicitly disable buffs even if declared. For "what if no Red Buff" comparisons. */
  disableBuffs?: string[]
  /** Hit-count controls for abilities whose output you want to truncate.
   *  Applies to BOTH DoT ticks AND multi-hit direct abilities (Da Ji A02's
   *  3-hit combo, Ratatoskr A02's dash hits, Loki A02 dagger DoT). The value
   *  is the number of ticks/hits actually applied; anything beyond is dropped.
   *  Key format: `${godId}.${abilityLabel}`, e.g. `'Loki.A02'`. */
  tickOverrides?: Record<string, number>
  /** Force crit rolls to a deterministic value (0..1); default is expected-value (chance × damage). */
  critMode?: 'expected' | 'alwaysCrit' | 'neverCrit'
  /** Random seed for any stochastic rolls (unused at expected-value default). */
  seed?: number
  /** Opt-in target HP cap — if the defender reaches 0 HP, further damage is tracked as overkill. */
  trackOverkill?: boolean
  /** When true, items whose passive only procs under a trigger the sim can't
   *  model (Spirit Robe's +40 prot under CC, Caestus's CC-triggered bonuses,
   *  Mantle of Discord below 40% HP, etc.) have those bonuses applied as
   *  always-on. Default false: optimizer plans around the baseline stats only,
   *  which matches how players plan — you don't assume you're always CC'd. */
  forceConditionalItemEffects?: boolean
}

export interface Scenario {
  title: string
  attacker: BuildInput
  defender: EnemyInput            // single-target for now; enemies[] is on the way
  enemies?: EnemyInput[]          // optional multi-target list; if set, each ability hits the appropriate subset
  rotation: RotationAction[]
  options?: ScenarioOptions

  /** Optional team comp: additional attackers beyond `attacker`. Each carries
   *  their own rotation. When set, the sim runs per-attacker and accumulates
   *  damage against the shared defender(s). Use `attacker` as the primary and
   *  `teamAttackers` as allies. */
  teamAttackers?: Array<BuildInput & { rotation: RotationAction[]; title?: string }>
}

// ---- Timeline events ----

export interface DamageEvent {
  kind: 'damage'
  t: number
  label: string
  source: 'ability' | 'basic' | 'item' | 'passive' | 'dot' | 'relic' | 'active' | 'buff-drop'
  damageType: DamageType
  preMitigation: number
  postMitigation: number
  target?: string
  crit?: boolean
  notes?: string[]
}
export interface BuffApplyEvent {
  kind: 'buff-apply'
  t: number
  label: string
  target: 'self' | 'enemy'
  durationSeconds: number
  expiresAt: number
}
export interface BuffExpireEvent {
  kind: 'buff-expire'
  t: number
  label: string
  target: 'self' | 'enemy'
}
export interface AbilityCastEvent {
  kind: 'ability-cast'
  t: number
  slot: AbilitySlot
  label: string
}
export interface ActiveItemUseEvent {
  kind: 'active-use'
  t: number
  itemKey: string
  label: string
}
export interface CooldownExpireEvent {
  kind: 'cooldown-expire'
  t: number
  slot: AbilitySlot | 'basic' | 'active'
  label: string
}

export type TimelineEvent =
  | DamageEvent
  | BuffApplyEvent
  | BuffExpireEvent
  | AbilityCastEvent
  | ActiveItemUseEvent
  | CooldownExpireEvent

export interface SimResult {
  scenarioTitle: string
  /** Time from first action until the last damage lands (includes lingering DoT ticks). */
  totalCombatTime: number
  /** Time from first action until the last rotation input is consumed — "how long did
   *  the player spend pressing buttons". Excludes post-combo DoT ticks and deployables. */
  comboExecutionTime: number
  /** Per-attacker damage subtotals when a team comp was simulated. Keys are
   *  `attacker.godId` unless a `title` was set. */
  perAttackerTotals?: Record<string, number>
  /** Time-series of (time, instantDps, cumulativeDamage) sampled at 0.1s
   *  intervals — backend data for a UI DPS graph. */
  dpsSeries: Array<{ t: number; instantDps: number; cumulativeDamage: number }>
  /** First timestamp where cumulative damage reaches defender HP, if it does. */
  defenderDefeatedAt?: number
  /** Stacking items (Book of Thoth, Transcendence, Brawler's Beat Stick) reach
   *  peak effect after N stacks/Ns. Each entry estimates stack time-to-full
   *  and marks the combat-time point at which max effect is reached. */
  timeAwareItems?: Array<{
    itemName: string
    ramp: 'stacks' | 'uptime' | 'unknown'
    secondsToFull: number
    effectAtFull: string
  }>
  events: TimelineEvent[]
  /** Damage events only, for convenience. */
  damageEvents: DamageEvent[]
  /** Per-source damage totals. */
  totals: {
    physical: number
    magical: number
    true: number
    total: number
  }
  byLabel: Record<string, number>
  bySource: Record<string, number>
  overkill: number
  attackerSnapshot: unknown
  defenderSnapshot: unknown
  assumptions: string[]
  warnings: string[]
}
