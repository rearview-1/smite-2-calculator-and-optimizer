/**
 * Per-god custom ability handlers for kits whose behavior doesn't fit the
 * generic abilityResolver's pattern detection. Each handler receives the full
 * combat context and can emit multiple damage/buff events for a single cast.
 *
 * If a god has no registered handler for a slot, the engine falls back to
 * the generic resolver's ability plan.
 */
import { abilityRowAt, getAbilityTiming, type GodCatalogEntry } from '../../catalog/loadCatalogs.ts'
import type { AbilitySlot, DamageEvent, DamageType, ScenarioOptions } from './types.ts'
import type { DamagePlan } from './abilityResolver.ts'
import type { CombatState } from './combatState.ts'

/** Resolve how many hits/ticks of a multi-hit handler ability should fire,
 *  respecting `scenario.options.tickOverrides`. Use this in every god handler
 *  that emits N hits in a loop so the user's "only 3 of 8 ticks" setting
 *  actually truncates the handler's output. Key is `${godId}.${slot}`. */
export function resolveHits(ctx: HandlerContext, slot: AbilitySlot, defaultHits: number): number {
  const key = `${ctx.attacker.god.god}.${slot}`
  const override = ctx.options?.tickOverrides?.[key]
  if (override == null || !Number.isFinite(override)) return defaultHits
  return Math.max(0, Math.min(defaultHits, Math.floor(override)))
}

/** Opaque context — the engine passes itself in; we use `any` to avoid circular type deps. */
export interface HandlerContext {
  attacker: {
    god: GodCatalogEntry
    adaptiveStrength: number
    inhandPower: number
    cdrPercent: number
    godState: Record<string, number | boolean | string>
  }
  state: CombatState
  options: ScenarioOptions
  emitDamage: (
    ctx: HandlerContext,
    damageType: DamageType,
    preMitigation: number,
    label: string,
    source: DamageEvent['source'],
    notes?: string[],
  ) => void
  schedDot: (
    ctx: HandlerContext,
    plan: DamagePlan,
    label: string,
    onFirstHit?: () => void,
    source?: DamageEvent['source'],
  ) => void
  applyAbilityHitItemProcs: (ctx: HandlerContext) => void
  applyRepeatableAbilityHitItemProcs: (ctx: HandlerContext) => void
  /** Fires "On Attack Hit: X% bonus Damage" splash items (Bumba's Spear,
   *  Bumba's Golden Dagger) against a basic attack's pre-mit damage. Call it
   *  any time a god handler emits a 'basic'-source damage event so these
   *  splash passives don't get skipped on character-specific basics like
   *  Loki's Vanish triggering basic. */
  applyOnBasicHitSplashProcs: (ctx: HandlerContext, basicPre: number) => void
  currentAdaptiveStrength: () => number
  currentAdaptiveIntelligence: () => number
  currentCdrPercent: () => number
}

export interface GodHandler {
  /** Return true if the generic plan should be skipped (handler emitted everything). */
  handle: (ctx: HandlerContext, slot: AbilitySlot, rank: number) => boolean
}

/**
 * Loki A01 "Vanish": activate stealth, then the next basic within 6s is a
 * modified "Vanish Shot" that applies a 2s DoT to the target. The basic itself
 * does standard basic damage; the DoT ticks 4 times over 2s at 90 + 0.2×power
 * per tick at rank 5.
 *
 * Scenario assumption: the user casts Vanish and immediately fires the triggering
 * basic, so the "full Vanish output" includes:
 *   1. The triggering basic attack's damage
 *   2. The 4-tick DoT
 *
 * The basic does NOT trigger Oath-Sworn-style "ability hit" item procs; those
 * fire on DoT ticks (since ticks are ability damage).
 */
const LokiHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A02: (ctx, rank) => {
    // Agonizing Visions: "hits {AttackCount} times over {DeployableDuration}".
    // In-game combat log shows 8 hits — "Max Stack Count" row is the blind
    // threshold (reaches Blinded at 4 stacks), not the attack count.
    const { attacker, state, emitDamage, applyAbilityHitItemProcs, applyRepeatableAbilityHitItemProcs } = ctx
    const base = abilityRowAt(attacker.god, 'A02' as AbilitySlot, 'Base Damage', rank) ?? 0
    const scale = abilityRowAt(attacker.god, 'A02' as AbilitySlot, 'Physical Power Scaling', rank) ?? 0
    const HITS = resolveHits(ctx, 'A02', 8)  // validated 8 hits; user can truncate via tickOverrides
    const timing = getAbilityTiming('Loki', 'A02', 'channel')
    const HIT_INTERVAL = timing.hitInterval

    state.events.push({ kind: 'ability-cast', t: state.t, slot: 'A02', label: 'Agonizing Visions (cast)' })
    const strTotal = ctx.currentAdaptiveStrength()
    const pre = base + scale * strTotal
    const savedT = state.t
    let procsApplied = false
    for (let i = 1; i <= HITS; i++) {
      state.t = savedT + i * HIT_INTERVAL
      emitDamage(ctx, 'physical', pre, `Agonizing Visions (hit ${i}/${HITS})`, 'ability')
      if (i === 1 && !procsApplied) { applyAbilityHitItemProcs(ctx); procsApplied = true }
      applyRepeatableAbilityHitItemProcs(ctx)
    }
    state.t = savedT
    const cd = abilityRowAt(attacker.god, 'A02' as AbilitySlot, 'Cooldown', rank) ?? 14
    state.cooldowns.abilities.A02 = state.t + cd * (1 - ctx.currentCdrPercent() / 100)
    return true
  },
  A04: (ctx, rank) => {
    // Assassinate: two strikes — cripple (strike 1) + heavy (strike 2).
    const { attacker, state, emitDamage, applyAbilityHitItemProcs, applyRepeatableAbilityHitItemProcs } = ctx
    const cripBase = abilityRowAt(attacker.god, 'A04' as AbilitySlot, 'Cripple Base Damage', rank) ?? 0
    const cripScale = abilityRowAt(attacker.god, 'A04' as AbilitySlot, 'Cripple Physical Power Scaling', rank) ?? 0
    const heavyBase = abilityRowAt(attacker.god, 'A04' as AbilitySlot, 'Heavy Base Damage', rank) ?? 0
    const heavyScale = abilityRowAt(attacker.god, 'A04' as AbilitySlot, 'Heavy Physical Power Scaling', rank) ?? 0

    state.events.push({ kind: 'ability-cast', t: state.t, slot: 'A04', label: 'Assassinate (cast)' })
    const strTotal = ctx.currentAdaptiveStrength()
    const cripPre = cripBase + cripScale * strTotal
    const heavyPre = heavyBase + heavyScale * strTotal

    const timingA04 = getAbilityTiming('Loki', 'A04', 'burst')
    const savedT = state.t
    emitDamage(ctx, 'physical', cripPre, 'Assassinate (cripple strike)', 'ability')
    applyAbilityHitItemProcs(ctx)
    applyRepeatableAbilityHitItemProcs(ctx)
    state.t = savedT + timingA04.finalHitOffset
    emitDamage(ctx, 'physical', heavyPre, 'Assassinate (heavy strike)', 'ability')
    applyRepeatableAbilityHitItemProcs(ctx)
    state.t = savedT
    const cd = abilityRowAt(attacker.god, 'A04' as AbilitySlot, 'Cooldown', rank) ?? 90
    state.cooldowns.abilities.A04 = state.t + cd * (1 - ctx.currentCdrPercent() / 100)
    return true
  },
  A03: (ctx, rank) => {
    // Flurry Strike: channel that hits 6 times total — 5 flurry ticks + 1 final hit.
    // Tooltip (Loki.A03.InGame.Long): "Hits 6 times over {FlurryDuration} seconds."
    // Flurry hit:  Flurry Base Damage + Flurry Physical Power Scaling × STR
    // Final hit:   Final Base Damage + Final Physical Power Scaling × STR (the 6th hit)
    // Oath-Sworn's "on ability hit" proc applies after the first contact,
    // so flurry hit 1 uses full prot; hits 2-5 + final use reduced prot.
    const { attacker, state, emitDamage, applyAbilityHitItemProcs, applyRepeatableAbilityHitItemProcs } = ctx

    const flurryBase = abilityRowAt(attacker.god, 'A03' as AbilitySlot, 'Flurry Base Damage', rank) ?? 0
    const flurryScale = abilityRowAt(attacker.god, 'A03' as AbilitySlot, 'Flurry Physical Power Scaling', rank) ?? 0
    const finalBase = abilityRowAt(attacker.god, 'A03' as AbilitySlot, 'Final Base Damage', rank) ?? 0
    const finalScale = abilityRowAt(attacker.god, 'A03' as AbilitySlot, 'Final Physical Power Scaling', rank) ?? 0

    state.events.push({ kind: 'ability-cast', t: state.t, slot: 'A03', label: 'Flurry Strike (channel)' })

    const strTotal = ctx.currentAdaptiveStrength()
    const flurryPre = flurryBase + flurryScale * strTotal
    const finalPre = finalBase + finalScale * strTotal

    const FLURRY_HITS = 5  // from GA_Loki_A03 BP: AmountOfWeakSlashes = 5
    const timingA03 = getAbilityTiming('Loki', 'A03', 'channel')
    const HIT_INTERVAL = timingA03.hitInterval
    const savedT = state.t
    let procsApplied = false

    for (let i = 1; i <= FLURRY_HITS; i++) {
      state.t = savedT + i * HIT_INTERVAL
      emitDamage(ctx, 'physical', flurryPre, `Flurry Strike (flurry ${i}/${FLURRY_HITS})`, 'ability')
      if (i === 1 && !procsApplied) {
        applyAbilityHitItemProcs(ctx)
        procsApplied = true
      }
      applyRepeatableAbilityHitItemProcs(ctx)
    }
    state.t = savedT + (timingA03.finalHitOffset || (FLURRY_HITS + 1) * HIT_INTERVAL)
    emitDamage(ctx, 'physical', finalPre, 'Flurry Strike (final)', 'ability',
      [`${FLURRY_HITS} flurry + 1 final = 6 hits per tooltip`])
    applyRepeatableAbilityHitItemProcs(ctx)
    // Return to cast-time clock; caller advances time
    state.t = savedT

    const cd = abilityRowAt(attacker.god, 'A03' as AbilitySlot, 'Cooldown', rank) ?? 14
    state.cooldowns.abilities.A03 = state.t + cd * (1 - ctx.currentCdrPercent() / 100)

    return true
  },
  A01: (ctx, rank) => {
    const { attacker, state, emitDamage, schedDot, applyAbilityHitItemProcs, applyRepeatableAbilityHitItemProcs, applyOnBasicHitSplashProcs } = ctx

    state.events.push({ kind: 'ability-cast', t: state.t, slot: 'A01', label: 'Vanish (cast)' })

    // --- 1. The triggering basic ---
    // The basic itself is a basic attack — does NOT apply "Ability Hit" item
    // procs like Oath-Sworn. Either the first DoT tick applies the proc, or
    // a subsequent ability (cast before the DoT ticks) applies it first.
    const chainMultiplier = 1.0
    const strTotal = ctx.currentAdaptiveStrength()
    const basicPre = (attacker.inhandPower + strTotal) * chainMultiplier
    emitDamage(ctx, 'physical', basicPre, 'Vanish triggering basic', 'basic',
      ['basic shot fired from stealth applies the DoT'])
    // Bumba's Spear-style AoE splash items fire on this basic too.
    applyOnBasicHitSplashProcs(ctx, basicPre)

    // --- 2. DoT ---
    const damagePerTick = abilityRowAt(attacker.god, 'A01' as AbilitySlot, 'Damage Per Tick', rank) ?? 0
    const strScale = abilityRowAt(attacker.god, 'A01' as AbilitySlot, 'Physical Power Scaling', rank) ?? 0
    const tickRate = abilityRowAt(attacker.god, 'A01' as AbilitySlot, 'Tick Rate', rank) ?? 0.5
    const duration = abilityRowAt(attacker.god, 'A01' as AbilitySlot, 'Damage Over Time Duration', rank) ?? 2
    const ticks = Math.max(1, Math.round(duration / tickRate))

    const dotPlan: DamagePlan = {
      kind: 'dot',
      baseDamage: damagePerTick,
      strScaling: strScale,
      intScaling: 0,
      hits: 1,
      ticks,
      tickRate,
      duration,
      damageType: 'physical',
      label: 'Vanish (DoT)',
    }

    // First DoT tick applies Oath-Sworn-style procs (ability-hit triggers)
    let procsApplied = false
    const onFirstHit = () => {
      if (procsApplied) return
      applyAbilityHitItemProcs(ctx)
      applyRepeatableAbilityHitItemProcs(ctx)
      procsApplied = true
    }
    schedDot(ctx, dotPlan, 'Vanish (DoT)', onFirstHit)

    // Cooldown: use the catalog's Cooldown row if present, else default
    const cd = abilityRowAt(attacker.god, 'A01' as AbilitySlot, 'Cooldown', rank)
      ?? abilityRowAt(attacker.god, 'A01' as AbilitySlot, 'TalentCD', rank)
      ?? 14
    state.cooldowns.abilities.A01 = state.t + cd * (1 - ctx.currentCdrPercent() / 100)

    return true  // handled fully
  },
}

const FenrirHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A03: (ctx, rank) => {
    const { attacker, state, emitDamage, applyAbilityHitItemProcs, applyRepeatableAbilityHitItemProcs } = ctx
    const base = abilityRowAt(attacker.god, 'A03', 'Base Damage', rank) ?? 0
    const normalScaling = abilityRowAt(attacker.god, 'A03', 'Strength Scaling', rank) ?? 0
    const empoweredScaling = abilityRowAt(attacker.god, 'A03', 'Passive Ready Strength Scaling', rank) ?? normalScaling
    const runes = Number(attacker.godState.FenrirRunes ?? attacker.godState.runes ?? 0)
    const empowered = attacker.godState.FenrirPassiveReady === true || runes >= 5
    const scaling = empowered ? empoweredScaling : normalScaling
    const hits = 4
    const timing = getAbilityTiming('Fenrir', 'A03', 'channel')
    const hitInterval = timing.hitInterval
    const savedT = state.t
    const pre = base + ctx.currentAdaptiveStrength() * scaling
    let procsApplied = false

    state.events.push({
      kind: 'ability-cast',
      t: state.t,
      slot: 'A03',
      label: empowered ? 'Brutalize (empowered channel)' : 'Brutalize (channel)',
    })

    for (let i = 1; i <= hits; i++) {
      state.t = savedT + i * hitInterval
      emitDamage(ctx, 'physical', pre, `Brutalize (${empowered ? 'empowered ' : ''}hit ${i}/${hits})`, 'ability',
        i === 1 && empowered ? ['FenrirRunes/FenrirPassiveReady enabled Passive Ready Strength Scaling'] : undefined)
      if (i === 1 && !procsApplied) {
        applyAbilityHitItemProcs(ctx)
        procsApplied = true
      }
      applyRepeatableAbilityHitItemProcs(ctx)
    }

    state.t = savedT
    const cd = abilityRowAt(attacker.god, 'A03', 'Cooldown', rank) ?? 14
    state.cooldowns.abilities.A03 = state.t + cd * (1 - ctx.currentCdrPercent() / 100)
    return true
  },
  A01: undefined,
  A02: undefined,
  A04: undefined,
}

const GOD_HANDLERS: Record<string, Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined>> = {
  Loki: LokiHandlers,
  Fenrir: FenrirHandlers,
}

export function getGodHandler(godName: string, slot: AbilitySlot): ((ctx: HandlerContext, rank: number) => boolean) | undefined {
  return GOD_HANDLERS[godName]?.[slot]
}
