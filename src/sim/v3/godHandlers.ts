/**
 * Per-god custom ability handlers for kits whose behavior doesn't fit the
 * generic abilityResolver's pattern detection. Each handler receives the full
 * combat context and can emit multiple damage/buff events for a single cast.
 *
 * If a god has no registered handler for a slot, the engine falls back to
 * the generic resolver's ability plan.
 */
import { abilityRowAt, getAbilityTiming, inferGodDamageType, type GodCatalogEntry } from '../../catalog/loadCatalogs.ts'
import { interp } from '../../catalog/curve.ts'
import { getAspectAbilityRows } from '../../catalog/aspectCurves.ts'
import { findGodLockedItem } from '../../catalog/godLockedItems.ts'
import type { AbilitySlot, DamageEvent, DamageType, ScenarioOptions } from './types.ts'
import type { DamagePlan } from './abilityResolver.ts'
import { applyOrRefreshBuff, applyOrRefreshDebuff, type CombatState } from './combatState.ts'

function hasActiveAspect(ctx: HandlerContext): boolean {
  return Array.isArray(ctx.attacker.aspects) && ctx.attacker.aspects.length > 0
}

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

function aspectRowAt(god: GodCatalogEntry, slot: AbilitySlot, row: string, rank: number): number {
  const curve = getAspectAbilityRows(god.god, slot)[row]
  return curve ? interp(curve, rank) : 0
}

function setAbilityCooldown(ctx: HandlerContext, slot: AbilitySlot, seconds: number) {
  ctx.state.cooldowns.abilities[slot] = ctx.state.t + seconds * (1 - ctx.currentCdrPercent() / 100)
}

function gilgameshWallExpiresAt(ctx: HandlerContext): number {
  return ctx.state.cooldowns.actives['Gilgamesh.aspect.wall'] ?? 0
}

function readNumericGodState(
  godState: Record<string, number | boolean | string>,
  keys: string[],
  fallback = 0,
): number {
  for (const key of keys) {
    const value = godState[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return fallback
}

function equippedRatAcorn(ctx: HandlerContext, slot: AbilitySlot): ReturnType<typeof findGodLockedItem> {
  for (const item of ctx.attacker.items ?? []) {
    const acorn = findGodLockedItem(item.internalKey ?? item.displayName ?? '')
    if (acorn?.godId === 'Ratatoskr' && acorn.abilitySlot === slot) return acorn
  }
  return null
}

function ishtarA01Mode(
  godState: Record<string, number | boolean | string>,
): 'lob' | 'spread' | 'storm' {
  const raw = godState.IshtarA01Stance ?? godState.IshtarStance ?? godState.A01Stance
  if (typeof raw === 'number') {
    if (raw === 1) return 'spread'
    if (raw === 2) return 'storm'
    return 'lob'
  }
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (['spread', 'cone', 'shotgun'].includes(text)) return 'spread'
  if (['storm', 'snipe', 'sniper'].includes(text)) return 'storm'
  return 'lob'
}

function baronTargetHysteria(ctx: HandlerContext): number {
  return readNumericGodState(ctx.attacker.godState, [
    'BaronTargetHysteria',
    'TargetHysteria',
    'EnemyHysteria',
    'Hysteria',
  ])
}

/** Opaque context — the engine passes itself in; we use `any` to avoid circular type deps. */
export interface HandlerContext {
  attacker: {
    god: GodCatalogEntry
    adaptiveStrength: number
    items: Array<{ internalKey?: string; displayName?: string }>
    aspects?: string[]
    inhandPower: number
    cdrPercent: number
    godState: Record<string, number | boolean | string>
  }
  defender: {
    maxHealth: number
    physicalProtection: number
    magicalProtection: number
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
  cancel?: boolean
}

export interface GodHandler {
  /** Return true if the generic plan should be skipped (handler emitted everything). */
  handle: (ctx: HandlerContext, slot: AbilitySlot, rank: number) => boolean
}

const AresHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A04: (ctx, rank) => {
    const initialBase = abilityRowAt(ctx.attacker.god, 'A04', 'InitialDamage', rank) ?? 0
    const initialStrScaling = abilityRowAt(ctx.attacker.god, 'A04', 'InitialDamageScaling', rank) ?? 0
    const initialIntScaling = abilityRowAt(ctx.attacker.god, 'A04', 'InitialDamageIntScaling', rank) ?? 0
    const stunBase = abilityRowAt(ctx.attacker.god, 'A04', 'StunDamage', rank) ?? 0
    const stunStrScaling = abilityRowAt(ctx.attacker.god, 'A04', 'StunDamageScaling', rank) ?? 0
    const stunIntScaling = abilityRowAt(ctx.attacker.god, 'A04', 'StunDamageIntScaling', rank) ?? 0
    const stunDuration = abilityRowAt(ctx.attacker.god, 'A04', 'StunDuration', rank) ?? 0
    if ((initialBase <= 0 && initialStrScaling <= 0 && initialIntScaling <= 0)
      && (stunBase <= 0 && stunStrScaling <= 0 && stunIntScaling <= 0)) return false

    const savedT = ctx.state.t
    const finalHitDelay = 2.17
    const initialPre =
      initialBase
      + ctx.currentAdaptiveStrength() * initialStrScaling
      + ctx.currentAdaptiveIntelligence() * initialIntScaling
    const stunPre =
      stunBase
      + ctx.currentAdaptiveStrength() * stunStrScaling
      + ctx.currentAdaptiveIntelligence() * stunIntScaling

    ctx.state.events.push({ kind: 'ability-cast', t: savedT, slot: 'A04', label: 'No Escape' })
    if (initialPre > 0) {
      ctx.emitDamage(ctx, 'magical', initialPre, 'No Escape (initial)', 'ability')
      ctx.applyAbilityHitItemProcs(ctx)
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }
    if (stunPre > 0) {
      ctx.state.t = savedT + finalHitDelay
      ctx.emitDamage(
        ctx,
        'magical',
        stunPre,
        'No Escape (stun)',
        'ability',
        ['delayed from authored tooltip: displaced after 2.17s of channeling'],
      )
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
      if (stunDuration > 0) {
        ctx.state.events.push({
          kind: 'buff-apply',
          t: ctx.state.t,
          label: 'No Escape stun',
          target: 'enemy',
          durationSeconds: stunDuration,
          expiresAt: ctx.state.t + stunDuration,
        })
      }
    }

    ctx.state.t = savedT
    setAbilityCooldown(ctx, 'A04', abilityRowAt(ctx.attacker.god, 'A04', 'Cooldown', rank) ?? 90)
    return true
  },
  A01: undefined,
  A02: undefined,
  A03: undefined,
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
    const intTotal = ctx.currentAdaptiveIntelligence()
    const basicPre = (attacker.inhandPower + strTotal + intTotal * 0.2) * chainMultiplier
    emitDamage(ctx, inferGodDamageType(attacker.god), basicPre, 'Vanish triggering basic', 'basic',
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
      ?? (hasActiveAspect(ctx) ? abilityRowAt(attacker.god, 'A01' as AbilitySlot, 'TalentCD', rank) : null)
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

const ChaacHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A03: (ctx, rank) => {
    if (!hasActiveAspect(ctx)) return false
    const tickDamage = aspectRowAt(ctx.attacker.god, 'A03', 'Damage Per Tick', rank)
    const tickRate = aspectRowAt(ctx.attacker.god, 'A03', 'TickTime', rank) || 1
    const duration = abilityRowAt(ctx.attacker.god, 'A03', 'Rain Duration', rank) ?? 0
    if (tickDamage <= 0 || duration <= 0) return false

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A03', label: 'Rain Dance (aspect)' })
    let procsApplied = false
    ctx.schedDot(ctx, {
      kind: 'dot',
      baseDamage: tickDamage,
      strScaling: aspectRowAt(ctx.attacker.god, 'A03', 'Strength Scaling', rank),
      intScaling: aspectRowAt(ctx.attacker.god, 'A03', 'Int Scaling', rank),
      hits: 1,
      ticks: Math.max(1, Math.round(duration / tickRate)),
      tickRate,
      duration,
      damageType: 'physical',
      label: 'Rain Dance (aspect DoT)',
    }, 'Rain Dance (aspect DoT)', () => {
      if (procsApplied) return
      ctx.applyAbilityHitItemProcs(ctx)
      procsApplied = true
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    })
    setAbilityCooldown(ctx, 'A03', abilityRowAt(ctx.attacker.god, 'A03', 'Cooldown', rank) ?? 14)
    return true
  },
  A01: undefined,
  A02: undefined,
  A04: undefined,
}

const CupidHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A01: (ctx, rank) => {
    if (!hasActiveAspect(ctx)) return false
    const initialDamage = aspectRowAt(ctx.attacker.god, 'A01', 'Aspect Initial Damage', rank)
    const explosionDamage = aspectRowAt(ctx.attacker.god, 'A01', 'Aspect Explosion Damage', rank)
    if (initialDamage <= 0 && explosionDamage <= 0) return false

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A01', label: 'Heart Bomb (aspect)' })

    if (initialDamage > 0) {
      ctx.emitDamage(
        ctx,
        'physical',
        initialDamage
          + ctx.currentAdaptiveStrength() * aspectRowAt(ctx.attacker.god, 'A01', 'Aspect Initial STR Scaling', rank)
          + ctx.currentAdaptiveIntelligence() * aspectRowAt(ctx.attacker.god, 'A01', 'Aspect Initial INT Scaling', rank),
        'Heart Bomb (aspect impact)',
        'ability',
      )
      ctx.applyAbilityHitItemProcs(ctx)
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }

    if (explosionDamage > 0) {
      const savedT = ctx.state.t
      ctx.state.t = savedT + 3
      ctx.emitDamage(
        ctx,
        'physical',
        explosionDamage
          + ctx.currentAdaptiveStrength() * aspectRowAt(ctx.attacker.god, 'A01', 'Aspect Explosion STR Scaling', rank)
          + ctx.currentAdaptiveIntelligence() * aspectRowAt(ctx.attacker.god, 'A01', 'Aspect Explosion INT Scaling', rank),
        'Heart Bomb (aspect explosion)',
        'ability',
      )
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
      ctx.state.t = savedT
    }

    setAbilityCooldown(ctx, 'A01', abilityRowAt(ctx.attacker.god, 'A01', 'Cooldown', rank) ?? 14)
    return true
  },
  A02: undefined,
  A03: undefined,
  A04: undefined,
}

const GilgameshHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A04: (ctx, rank) => {
    if (!hasActiveAspect(ctx)) return false
    const wallDuration = abilityRowAt(ctx.attacker.god, 'A04', 'TalentWallDuration', rank) ?? 0
    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A04', label: 'Winds of Shamash (aspect wall)' })
    if (wallDuration > 0) {
      ctx.state.cooldowns.actives['Gilgamesh.aspect.wall'] = ctx.state.t + wallDuration
      ctx.state.events.push({
        kind: 'buff-apply',
        t: ctx.state.t,
        label: 'Winds of Shamash (aspect wall)',
        target: 'self',
        durationSeconds: wallDuration,
        expiresAt: ctx.state.t + wallDuration,
      })
    }
    setAbilityCooldown(ctx, 'A04', abilityRowAt(ctx.attacker.god, 'A04', 'Talent Cooldown', rank) ?? 14)
    return true
  },
  A01: (ctx, rank) => {
    if (!hasActiveAspect(ctx) || gilgameshWallExpiresAt(ctx) <= ctx.state.t) return false
    ctx.state.cooldowns.actives['Gilgamesh.aspect.wall'] = 0
    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A01', label: 'Sun-forged Scimitar (aspect ignite)' })

    const initial = abilityRowAt(ctx.attacker.god, 'A04', 'Talent Initial Burn', rank) ?? 0
    const initialScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Talent Inital Burn Scaling', rank) ?? 0
    if (initial > 0) {
      ctx.emitDamage(ctx, 'magical', initial + ctx.currentAdaptiveIntelligence() * initialScaling, 'Winds of Shamash (ignite)', 'ability')
      ctx.applyAbilityHitItemProcs(ctx)
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }

    const burn = abilityRowAt(ctx.attacker.god, 'A04', 'Talent Burn', rank) ?? 0
    const burnScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Talent Burn Scaling', rank) ?? 0
    const duration = abilityRowAt(ctx.attacker.god, 'A04', 'TalentWallDuration', rank) ?? 0
    if (burn > 0 && duration > 0) {
      const tickRate = 1
      let procsApplied = initial > 0
      ctx.schedDot(ctx, {
        kind: 'dot',
        baseDamage: burn,
        strScaling: 0,
        intScaling: burnScaling,
        hits: 1,
        ticks: Math.max(1, Math.round(duration / tickRate)),
        tickRate,
        duration,
        damageType: 'magical',
        label: 'Winds of Shamash (ignite DoT)',
      }, 'Winds of Shamash (ignite DoT)', () => {
        if (procsApplied) return
        ctx.applyAbilityHitItemProcs(ctx)
        procsApplied = true
        ctx.applyRepeatableAbilityHitItemProcs(ctx)
      })
    }

    const attackSpeed = abilityRowAt(ctx.attacker.god, 'A04', 'TalentSpeedIncrease', rank) ?? 0
    const attackSpeedDuration = abilityRowAt(ctx.attacker.god, 'A04', 'TalentSpeedDuration', rank) ?? 0
    if (attackSpeed > 0 && attackSpeedDuration > 0) {
      ctx.state.attackerBuffs.set('Gilgamesh.aspect.A04.attackSpeed', {
        key: 'Gilgamesh.aspect.A04.attackSpeed',
        label: 'Winds of Shamash (attack speed)',
        appliedAt: ctx.state.t,
        expiresAt: ctx.state.t + attackSpeedDuration,
        modifiers: { AttackSpeedPercent: attackSpeed },
        stacks: 1,
      })
      ctx.state.events.push({
        kind: 'buff-apply',
        t: ctx.state.t,
        label: 'Winds of Shamash (attack speed)',
        target: 'self',
        durationSeconds: attackSpeedDuration,
        expiresAt: ctx.state.t + attackSpeedDuration,
      })
    }

    setAbilityCooldown(ctx, 'A01', abilityRowAt(ctx.attacker.god, 'A01', 'Cooldown', rank) ?? 14)
    return true
  },
  A02: undefined,
  A03: undefined,
}

const BacchusHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A03: (ctx, rank) => {
    const base = abilityRowAt(ctx.attacker.god, 'A03', 'Base Damage', rank) ?? 0
    const intScaling = abilityRowAt(ctx.attacker.god, 'A03', 'Int Scaling', rank) ?? 0
    if (base <= 0 && intScaling <= 0) return false

    const hits = resolveHits(ctx, 'A03', 6)
    const interval = 0.5
    const pre = base + ctx.currentAdaptiveIntelligence() * intScaling
    const savedT = ctx.state.t
    const tipsy =
      ctx.attacker.godState.BacchusTipsy === true
      || ctx.attacker.godState.Tipsy === true
      || readNumericGodState(ctx.attacker.godState, ['BacchusTipsyStacks', 'TipsyStacks']) > 0

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A03', label: 'Belch Of The Gods (channel)' })
    for (let i = 0; i < hits; i += 1) {
      ctx.state.t = savedT + (i + 1) * interval
      ctx.emitDamage(ctx, 'magical', pre, `Belch Of The Gods (hit ${i + 1}/${hits})`, 'ability')
      if (i === 0) ctx.applyAbilityHitItemProcs(ctx)
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }
    if (tipsy) {
      const stun = abilityRowAt(ctx.attacker.god, 'A03', 'Stun Duration', rank) ?? 0
      if (stun > 0) {
        applyOrRefreshDebuff(ctx.state, {
          key: 'Bacchus.A03.stun',
          label: 'Belch Of The Gods stun',
          expiresAt: ctx.state.t + stun,
          modifiers: {},
        })
      }
    }
    ctx.state.t = savedT
    setAbilityCooldown(ctx, 'A03', abilityRowAt(ctx.attacker.god, 'A03', 'Cooldown', rank) ?? 14)
    return true
  },
  A01: undefined,
  A02: undefined,
  A04: undefined,
}

const CabrakanHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A03: (ctx, rank) => {
    const base = abilityRowAt(ctx.attacker.god, 'A03', 'Damage', rank) ?? 0
    const intScaling = abilityRowAt(ctx.attacker.god, 'A03', 'INT Scaling', rank) ?? 0
    if (base <= 0 && intScaling <= 0) return false

    const hits = resolveHits(ctx, 'A03', 5)
    const interval = 0.5
    const pre = base + ctx.currentAdaptiveIntelligence() * intScaling
    const savedT = ctx.state.t

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A03', label: 'Tremors (channel)' })
    for (let i = 0; i < hits; i += 1) {
      ctx.state.t = savedT + (i + 1) * interval
      ctx.emitDamage(ctx, 'magical', pre, `Tremors (hit ${i + 1}/${hits})`, 'ability')
      if (i === 0) ctx.applyAbilityHitItemProcs(ctx)
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }
    ctx.state.t = savedT
    setAbilityCooldown(ctx, 'A03', abilityRowAt(ctx.attacker.god, 'A03', 'Cooldown', rank) ?? 14)
    return true
  },
  A01: undefined,
  A02: undefined,
  A04: undefined,
}

const CharonHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A01: (ctx, rank) => {
    const base = abilityRowAt(ctx.attacker.god, 'A01', 'Damage', rank) ?? 0
    const intScaling = abilityRowAt(ctx.attacker.god, 'A01', 'IntScaling', rank) ?? 0
    if (base <= 0 && intScaling <= 0) return false

    const pre = base + ctx.currentAdaptiveIntelligence() * intScaling
    const trailTickBase = abilityRowAt(ctx.attacker.god, 'A01', 'TrailDamagePerTick', rank) ?? 0
    const trailTickScaling = abilityRowAt(ctx.attacker.god, 'A01', 'TrailDamageScaling', rank) ?? 0
    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A01', label: 'Spectral Surge' })
    ctx.emitDamage(ctx, 'magical', pre, 'Spectral Surge', 'ability')
    ctx.applyAbilityHitItemProcs(ctx)
    ctx.applyRepeatableAbilityHitItemProcs(ctx)

    ctx.emitDamage(
      ctx,
      'magical',
      pre,
      'Spectral Surge (explosion)',
      'ability',
      trailTickBase > 0 || trailTickScaling > 0
        ? ['authored tooltip explosion on first enemy god hit', 'trail damage remains positional and is not auto-applied to the same target']
        : ['authored tooltip explosion on first enemy god hit'],
    )
    ctx.applyRepeatableAbilityHitItemProcs(ctx)

    const silenceDuration = abilityRowAt(ctx.attacker.god, 'A01', 'SilenceDuration', rank) ?? 0
    if (silenceDuration > 0) {
      applyOrRefreshDebuff(ctx.state, {
        key: 'Charon.A01.silence',
        label: 'Spectral Surge silence',
        expiresAt: ctx.state.t + silenceDuration,
        modifiers: {},
      })
    }

    const trailDuration = abilityRowAt(ctx.attacker.god, 'A01', 'TrailDuration', rank) ?? 0
    if (trailDuration > 0) {
      applyOrRefreshDebuff(ctx.state, {
        key: 'Charon.A01.trail',
        label: 'Spectral Surge trail',
        expiresAt: ctx.state.t + trailDuration,
        modifiers: {},
      })
    }
    setAbilityCooldown(ctx, 'A01', abilityRowAt(ctx.attacker.god, 'A01', 'Cooldown', rank) ?? 15)
    return true
  },
  A02: undefined,
  A03: undefined,
  A04: undefined,
}

const DiscordiaHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A01: (ctx, rank) => {
    if (hasActiveAspect(ctx)) return false

    const projectileBase = abilityRowAt(ctx.attacker.god, 'A01', 'Damage', rank) ?? 0
    const projectileScaling = abilityRowAt(ctx.attacker.god, 'A01', 'INTScaling', rank) ?? 0
    const areaBase = abilityRowAt(ctx.attacker.god, 'A01', 'AreaDamage', rank) ?? 0
    const areaScaling = abilityRowAt(ctx.attacker.god, 'A01', 'AreaINTScaling', rank) ?? 0
    if ((projectileBase <= 0 && projectileScaling <= 0) && (areaBase <= 0 && areaScaling <= 0)) return false

    const projectilePre = projectileBase + ctx.currentAdaptiveIntelligence() * projectileScaling
    const areaPre = areaBase + ctx.currentAdaptiveIntelligence() * areaScaling

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A01', label: 'Unruly Magic' })
    if (projectilePre > 0) {
      ctx.emitDamage(ctx, 'magical', projectilePre, 'Unruly Magic', 'ability')
      ctx.applyAbilityHitItemProcs(ctx)
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }
    if (areaPre > 0) {
      ctx.emitDamage(
        ctx,
        'magical',
        areaPre,
        'Unruly Magic (area)',
        'ability',
        ['authored long tooltip: enemies hit by the area damage will not take damage from the minor projectiles'],
      )
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }

    setAbilityCooldown(ctx, 'A01', abilityRowAt(ctx.attacker.god, 'A01', 'Cooldown', rank) ?? 12)
    return true
  },
  A04: (ctx, rank) => {
    if (hasActiveAspect(ctx)) return false

    const initialBase = abilityRowAt(ctx.attacker.god, 'A04', 'Damage', rank) ?? 0
    const initialScaling = abilityRowAt(ctx.attacker.god, 'A04', 'INTScaling', rank) ?? 0
    const burstBase = abilityRowAt(ctx.attacker.god, 'A04', 'BurstDamage', rank) ?? 0
    const burstScaling = abilityRowAt(ctx.attacker.god, 'A04', 'BurstINTScaling', rank) ?? 0
    const debuffDuration = abilityRowAt(ctx.attacker.god, 'A04', 'DebuffDuration', rank) ?? 0
    if ((initialBase <= 0 && initialScaling <= 0) && (burstBase <= 0 && burstScaling <= 0)) return false

    const savedT = ctx.state.t
    const initialPre = initialBase + ctx.currentAdaptiveIntelligence() * initialScaling
    const burstPre = burstBase + ctx.currentAdaptiveIntelligence() * burstScaling

    ctx.state.events.push({ kind: 'ability-cast', t: savedT, slot: 'A04', label: 'Golden Apple of Discord' })
    if (initialPre > 0) {
      ctx.emitDamage(ctx, 'magical', initialPre, 'Golden Apple of Discord', 'ability')
      ctx.applyAbilityHitItemProcs(ctx)
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }
    if (debuffDuration > 0) {
      applyOrRefreshDebuff(ctx.state, {
        key: 'Discordia.A04.apple',
        label: 'Golden Apple of Discord affliction',
        expiresAt: savedT + debuffDuration,
        modifiers: {},
      })
    }
    if (burstPre > 0) {
      ctx.state.t = savedT + debuffDuration
      ctx.emitDamage(
        ctx,
        'magical',
        burstPre,
        'Golden Apple of Discord (burst)',
        'ability',
        ['burst damage applied at the end of DebuffDuration from local rows'],
      )
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }
    ctx.state.t = savedT

    setAbilityCooldown(ctx, 'A04', abilityRowAt(ctx.attacker.god, 'A04', 'Cooldown', rank) ?? 90)
    return true
  },
  A02: undefined,
  A03: undefined,
}

const AmaterasuHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A02: (ctx, rank) => {
    const base = abilityRowAt(ctx.attacker.god, 'A02', 'Damage', rank) ?? 0
    const strScaling = abilityRowAt(ctx.attacker.god, 'A02', 'STR Scaling Damage', rank) ?? 0
    const intScaling = abilityRowAt(ctx.attacker.god, 'A02', 'INT Scaling Damage', rank) ?? 0
    if (base <= 0 && strScaling <= 0 && intScaling <= 0) return false

    const mitigationBuff = abilityRowAt(ctx.attacker.god, 'A02', 'Mitigation Buff', rank) ?? 0
    const mitigationIntScaling = abilityRowAt(ctx.attacker.god, 'A02', 'INT Scaling Mitigation', rank) ?? 0
    const damagePre =
      base
      + ctx.currentAdaptiveStrength() * strScaling
      + ctx.currentAdaptiveIntelligence() * intScaling

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A02', label: 'Heavenly Reflection' })
    if (mitigationBuff !== 0 || mitigationIntScaling !== 0) {
      applyOrRefreshBuff(ctx.state, {
        key: 'Amaterasu.A02.mitigation',
        label: 'Heavenly Reflection mitigation',
        expiresAt: ctx.state.t + 0.5,
        modifiers: {
          DamageTakenPercent: mitigationBuff - ctx.currentAdaptiveIntelligence() * mitigationIntScaling,
        },
      })
    }

    ctx.emitDamage(
      ctx,
      'physical',
      damagePre,
      'Heavenly Reflection',
      'ability',
      ['immediate-refire assumption: mirror fired with no extra charge'],
    )
    ctx.applyAbilityHitItemProcs(ctx)
    ctx.applyRepeatableAbilityHitItemProcs(ctx)
    setAbilityCooldown(ctx, 'A02', abilityRowAt(ctx.attacker.god, 'A02', 'Cooldown', rank) ?? 14)
    return true
  },
  A03: (ctx, rank) => {
    const base = abilityRowAt(ctx.attacker.god, 'A03', 'Dash Damage', rank) ?? 0
    const strScaling = abilityRowAt(ctx.attacker.god, 'A03', 'Dash Scaling', rank) ?? 0
    if (base <= 0 && strScaling <= 0) return false

    const silenceDuration = abilityRowAt(ctx.attacker.god, 'A03', 'Silence Duration', rank) ?? 0
    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A03', label: 'Glorious Charge' })
    if (silenceDuration > 0) {
      applyOrRefreshDebuff(ctx.state, {
        key: 'Amaterasu.A03.silence',
        label: 'Glorious Charge silence',
        expiresAt: ctx.state.t + silenceDuration,
        modifiers: {},
      })
    }
    ctx.emitDamage(
      ctx,
      'physical',
      base + ctx.currentAdaptiveStrength() * strScaling,
      'Glorious Charge',
      'ability',
    )
    ctx.applyAbilityHitItemProcs(ctx)
    ctx.applyRepeatableAbilityHitItemProcs(ctx)
    setAbilityCooldown(ctx, 'A03', abilityRowAt(ctx.attacker.god, 'A03', 'Cooldown', rank) ?? 14)
    return true
  },
  A01: undefined,
  A04: undefined,
}

const AnubisHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A01: (ctx, rank) => {
    const base = abilityRowAt(ctx.attacker.god, 'A01', 'Base Damage', rank) ?? 0
    const intScaling = abilityRowAt(ctx.attacker.god, 'A01', 'Magical Power Scaling', rank) ?? 0
    const duration = abilityRowAt(ctx.attacker.god, 'A01', 'Duration', rank) ?? 0
    const tickRate = abilityRowAt(ctx.attacker.god, 'A01', 'Tick Rate', rank) ?? 0
    const movementPenalty = abilityRowAt(ctx.attacker.god, 'A01', 'MovementSpeedPenalty', rank) ?? 0
    if ((base <= 0 && intScaling <= 0) || duration <= 0 || tickRate <= 0) return false

    const ticks = resolveHits(ctx, 'A01', Math.max(1, Math.round(duration / tickRate)))
    const savedT = ctx.state.t
    let procsApplied = false
    ctx.state.events.push({ kind: 'ability-cast', t: savedT, slot: 'A01', label: 'Plague Of Locusts' })
    applyOrRefreshBuff(ctx.state, {
      key: 'Anubis.A01.channel',
      label: 'Plague Of Locusts channel',
      expiresAt: savedT + duration,
      modifiers: movementPenalty > 0 ? { MovementSpeedPercent: -movementPenalty } : {},
    })

    for (let i = 1; i <= ticks; i++) {
      ctx.state.t = savedT + i * tickRate
      ctx.emitDamage(
        ctx,
        'magical',
        base + ctx.currentAdaptiveIntelligence() * intScaling,
        `Plague Of Locusts (hit ${i}/${ticks})`,
        'ability',
        i === 1 ? ['tick count from local Duration / Tick Rate rows'] : undefined,
      )
      if (!procsApplied) {
        ctx.applyAbilityHitItemProcs(ctx)
        procsApplied = true
      }
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }
    ctx.state.t = savedT
    setAbilityCooldown(ctx, 'A01', abilityRowAt(ctx.attacker.god, 'A01', 'Cooldown', rank) ?? 14)
    return true
  },
  A03: (ctx, rank) => {
    const base = abilityRowAt(ctx.attacker.god, 'A03', 'Base Damage', rank) ?? 0
    const intScaling = abilityRowAt(ctx.attacker.god, 'A03', 'Magical Power Scaling', rank) ?? 0
    const slowDuration = abilityRowAt(ctx.attacker.god, 'A03', 'Slow Duration', rank) ?? 0
    const slowStrength = abilityRowAt(ctx.attacker.god, 'A03', 'Slow Strength', rank) ?? 0
    if (base <= 0 && intScaling <= 0) return false

    const hitInterval = getAbilityTiming('Anubis', 'A03', 'channel').hitInterval || 0.4
    const duration = slowDuration > 0 ? slowDuration : 2
    const hits = resolveHits(ctx, 'A03', Math.max(1, Math.round(duration / hitInterval)))
    const savedT = ctx.state.t
    let procsApplied = false
    ctx.state.events.push({ kind: 'ability-cast', t: savedT, slot: 'A03', label: 'Grasping Hands' })
    if (slowDuration > 0 && slowStrength > 0) {
      applyOrRefreshDebuff(ctx.state, {
        key: 'Anubis.A03.slow',
        label: 'Grasping Hands slow',
        expiresAt: savedT + slowDuration,
        modifiers: { MovementSpeedPercent: -slowStrength },
      })
    }
    for (let i = 1; i <= hits; i++) {
      ctx.state.t = savedT + i * hitInterval
      ctx.emitDamage(
        ctx,
        'magical',
        base + ctx.currentAdaptiveIntelligence() * intScaling,
        `Grasping Hands (hit ${i}/${hits})`,
        'ability',
        i === 1 ? ['cadence uses local slow duration + channel timing interval'] : undefined,
      )
      if (!procsApplied) {
        ctx.applyAbilityHitItemProcs(ctx)
        procsApplied = true
      }
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }
    ctx.state.t = savedT
    setAbilityCooldown(ctx, 'A03', abilityRowAt(ctx.attacker.god, 'A03', 'Cooldown', rank) ?? 12)
    return true
  },
  A04: (ctx, rank) => {
    const initialBase = abilityRowAt(ctx.attacker.god, 'A04', 'Base Damage Initial', rank) ?? 0
    const initialScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Magical Power Scaling Initial', rank) ?? 0
    const tickBase = abilityRowAt(ctx.attacker.god, 'A04', 'Base Damage', rank) ?? 0
    const tickScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Magical Power Scaling', rank) ?? 0
    const duration = abilityRowAt(ctx.attacker.god, 'A04', 'Duration', rank) ?? 0
    if ((initialBase <= 0 && initialScaling <= 0) && (tickBase <= 0 && tickScaling <= 0)) return false

    const hitInterval = getAbilityTiming('Anubis', 'A04', 'channel').hitInterval || 0.4
    const hits = resolveHits(ctx, 'A04', Math.max(1, Math.round(duration / hitInterval)))
    const savedT = ctx.state.t
    let procsApplied = false
    ctx.state.events.push({ kind: 'ability-cast', t: savedT, slot: 'A04', label: 'Death Gaze' })
    applyOrRefreshBuff(ctx.state, {
      key: 'Anubis.A04.channel',
      label: 'Death Gaze channel',
      expiresAt: savedT + duration,
      modifiers: {},
    })
    if (initialBase > 0 || initialScaling > 0) {
      ctx.emitDamage(
        ctx,
        'magical',
        initialBase + ctx.currentAdaptiveIntelligence() * initialScaling,
        'Death Gaze (initial)',
        'ability',
      )
      ctx.applyAbilityHitItemProcs(ctx)
      procsApplied = true
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }
    for (let i = 1; i <= hits; i++) {
      ctx.state.t = savedT + i * hitInterval
      ctx.emitDamage(
        ctx,
        'magical',
        tickBase + ctx.currentAdaptiveIntelligence() * tickScaling,
        `Death Gaze (tick ${i}/${hits})`,
        'ability',
        i === 1 ? ['cadence uses local duration + channel timing interval'] : undefined,
      )
      if (!procsApplied) {
        ctx.applyAbilityHitItemProcs(ctx)
        procsApplied = true
      }
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }
    ctx.state.t = savedT
    setAbilityCooldown(ctx, 'A04', abilityRowAt(ctx.attacker.god, 'A04', 'Cooldown', rank) ?? 90)
    return true
  },
  A02: undefined,
}

const AchillesHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A01: (ctx, rank) => {
    const base = abilityRowAt(ctx.attacker.god, 'A01', 'Damage', rank) ?? 0
    const scaling = abilityRowAt(ctx.attacker.god, 'A01', 'Scaling', rank) ?? 0
    const farMultiplier = abilityRowAt(ctx.attacker.god, 'A01', 'Far Away Multiplier', rank) ?? 0
    const stunDuration = abilityRowAt(ctx.attacker.god, 'A01', 'Stun Duration', rank) ?? 0
    if (base <= 0 && scaling <= 0) return false

    const savedT = ctx.state.t
    const fullPre = base + ctx.currentAdaptiveStrength() * scaling
    const farPre = fullPre * farMultiplier
    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A01', label: 'Shield of Achilles' })

    ctx.emitDamage(ctx, 'physical', fullPre, 'Shield of Achilles (shield)', 'ability')
    ctx.applyAbilityHitItemProcs(ctx)
    ctx.applyRepeatableAbilityHitItemProcs(ctx)

    if (farMultiplier > 0) {
      ctx.emitDamage(ctx, 'physical', farPre, 'Shield of Achilles (radiated force)', 'ability',
        ['Far Away Multiplier applied from local A01 row'])
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }

    if (stunDuration > 0) {
      ctx.state.events.push({
        kind: 'buff-apply',
        t: savedT,
        label: 'Shield of Achilles stun',
        target: 'enemy',
        durationSeconds: stunDuration,
        expiresAt: savedT + stunDuration,
      })
    }

    setAbilityCooldown(ctx, 'A01', abilityRowAt(ctx.attacker.god, 'A01', 'Cooldown', rank) ?? 12)
    return true
  },
  A02: undefined,
  A03: undefined,
  A04: undefined,
}

const AnhurHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A04: (ctx, rank) => {
    const base = abilityRowAt(ctx.attacker.god, 'A04', 'Base Damage', rank) ?? 0
    const scaling = abilityRowAt(ctx.attacker.god, 'A04', 'Physical Power Scaling', rank) ?? 0
    const finalBase = abilityRowAt(ctx.attacker.god, 'A04', 'Base Damage Final', rank) ?? 0
    const finalScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Physical Power Scaling Final', rank) ?? 0
    if ((base <= 0 && scaling <= 0) && (finalBase <= 0 && finalScaling <= 0)) return false

    const hits = resolveHits(ctx, 'A04', 6)
    const interval = 0.4
    const savedT = ctx.state.t
    const volleyPre = base + ctx.currentAdaptiveStrength() * scaling
    const finalPre = finalBase + ctx.currentAdaptiveStrength() * finalScaling

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A04', label: 'Desert Fury' })
    for (let i = 0; i < hits; i += 1) {
      ctx.state.t = savedT + i * interval
      ctx.emitDamage(ctx, 'physical', volleyPre, `A04 (hit ${i + 1}/${hits})`, 'ability')
      if (i === 0) ctx.applyAbilityHitItemProcs(ctx)
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }
    ctx.state.t = savedT + hits * interval
    ctx.emitDamage(ctx, 'physical', finalPre, 'A04 (final)', 'ability')
    ctx.applyRepeatableAbilityHitItemProcs(ctx)
    ctx.state.t = savedT
    setAbilityCooldown(ctx, 'A04', abilityRowAt(ctx.attacker.god, 'A04', 'Cooldown', rank) ?? 90)
    return true
  },
  A01: undefined,
  A02: undefined,
  A03: undefined,
}

const PeleHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A01: (ctx, rank) => {
    const initialBase = abilityRowAt(ctx.attacker.god, 'A01', 'Base Damage Initial', rank) ?? 0
    const initialScaling = abilityRowAt(ctx.attacker.god, 'A01', 'Initial Physical Power Scaling', rank) ?? 0
    const returnBase = abilityRowAt(ctx.attacker.god, 'A01', 'Base Damage Return', rank) ?? 0
    const returnScaling = abilityRowAt(ctx.attacker.god, 'A01', 'Return Physical Power Scaling', rank) ?? 0
    const shardCount = Math.max(1, Math.floor(abilityRowAt(ctx.attacker.god, 'A01', 'ReturnProjectiles', rank) ?? 1))
    if ((initialBase <= 0 && initialScaling <= 0) && (returnBase <= 0 && returnScaling <= 0)) return false

    const savedT = ctx.state.t
    ctx.state.events.push({ kind: 'ability-cast', t: savedT, slot: 'A01', label: 'Pyroclast' })

    const initialPre = initialBase + ctx.currentAdaptiveStrength() * initialScaling
    ctx.emitDamage(ctx, 'physical', initialPre, 'Pyroclast (initial)', 'ability')
    ctx.applyAbilityHitItemProcs(ctx)
    ctx.applyRepeatableAbilityHitItemProcs(ctx)

    const returnPre = returnBase + ctx.currentAdaptiveStrength() * returnScaling
    for (let i = 1; i <= shardCount; i++) {
      ctx.state.t = savedT + 0.35 + (i - 1) * 0.05
      ctx.emitDamage(ctx, 'physical', returnPre, `Pyroclast (return ${i}/${shardCount})`, 'ability',
        ['ReturnProjectiles row determines shard count'])
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }
    ctx.state.t = savedT

    setAbilityCooldown(ctx, 'A01', abilityRowAt(ctx.attacker.god, 'A01', 'Cooldown', rank) ?? 12)
    return true
  },
  A02: (ctx, rank) => {
    const innerBase = abilityRowAt(ctx.attacker.god, 'A02', 'Base Damage Inner', rank) ?? 0
    const innerScaling = abilityRowAt(ctx.attacker.god, 'A02', 'Damage Scaling Inner', rank) ?? 0
    const outerBase = abilityRowAt(ctx.attacker.god, 'A02', 'Base Damage Outer', rank) ?? 0
    const outerScaling = abilityRowAt(ctx.attacker.god, 'A02', 'Damage Scaling Outer', rank) ?? 0
    const rings = Math.max(1, Math.floor(abilityRowAt(ctx.attacker.god, 'A02', 'Rings', rank) ?? 1))
    if ((innerBase <= 0 && innerScaling <= 0) && (outerBase <= 0 && outerScaling <= 0)) return false

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A02', label: 'Eruption' })
    const innerPre = innerBase + ctx.currentAdaptiveStrength() * innerScaling
    ctx.emitDamage(ctx, 'physical', innerPre, 'Eruption (inner)', 'ability')
    ctx.applyAbilityHitItemProcs(ctx)
    ctx.applyRepeatableAbilityHitItemProcs(ctx)

    const outerPre = outerBase + ctx.currentAdaptiveStrength() * outerScaling
    for (let i = 1; i <= rings; i++) {
      ctx.emitDamage(ctx, 'physical', outerPre, `Eruption (outer ${i}/${rings})`, 'ability',
        ['Rings row determines outer explosion count'])
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }

    setAbilityCooldown(ctx, 'A02', abilityRowAt(ctx.attacker.god, 'A02', 'Cooldown', rank) ?? 12)
    return true
  },
  A03: undefined,
  A04: (ctx, rank) => {
    const dashBase = abilityRowAt(ctx.attacker.god, 'A04', 'Dash Hit Base Damage', rank) ?? 0
    const dashScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Dash Hit Damage Scaling', rank) ?? 0
    const coneBase = abilityRowAt(ctx.attacker.god, 'A04', 'Cone Attack Base Damage', rank) ?? 0
    const coneScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Cone Attack Damage Scaling', rank) ?? 0
    const duration = abilityRowAt(ctx.attacker.god, 'A04', 'BuffDuration', rank) ?? 0
    if ((dashBase <= 0 && dashScaling <= 0) && (coneBase <= 0 && coneScaling <= 0)) return false

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A04', label: 'Volcanic Lightning' })
    const dashPre = dashBase + ctx.currentAdaptiveStrength() * dashScaling
    ctx.emitDamage(ctx, 'physical', dashPre, 'Volcanic Lightning (dash)', 'ability')
    ctx.applyAbilityHitItemProcs(ctx)
    ctx.applyRepeatableAbilityHitItemProcs(ctx)

    if (coneBase > 0 && duration > 0) {
      ctx.state.riders.activeBasicProjectiles.push({
        key: 'Pele.A04.followup',
        label: 'Volcanic Lightning (follow-up cone)',
        damageType: 'physical',
        baseDamage: coneBase,
        inhandScaling: 0,
        strScaling: coneScaling,
        hits: 1,
        expiresAt: ctx.state.t + duration,
        remainingBasics: 4,
        source: 'ability',
        notes: ['BuffDuration rows arm 4 follow-up cone attacks'],
      })
      ctx.state.events.push({
        kind: 'buff-apply',
        t: ctx.state.t,
        label: 'Volcanic Lightning follow-up',
        target: 'self',
        durationSeconds: duration,
        expiresAt: ctx.state.t + duration,
      })
    }

    setAbilityCooldown(ctx, 'A04', abilityRowAt(ctx.attacker.god, 'A04', 'Cooldown', rank) ?? 70)
    return true
  },
}

const EsetHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A01: (ctx, rank) => {
    const aspect = hasActiveAspect(ctx)
    const base = aspect
      ? (abilityRowAt(ctx.attacker.god, 'A01', 'Talent Base Damage', rank) ?? 0)
      : (abilityRowAt(ctx.attacker.god, 'A01', 'Damage', rank) ?? 0)
    const intScaling = aspect
      ? (abilityRowAt(ctx.attacker.god, 'A01', 'TalentDamageProtScaling', rank) ?? 0)
      : (abilityRowAt(ctx.attacker.god, 'A01', 'Intelligence Scaling', rank) ?? 0)
    if (base <= 0 && intScaling <= 0) return false

    const hits = resolveHits(ctx, 'A01', 4)
    const interval = 0.15
    const savedT = ctx.state.t
    const pre = aspect
      ? base + ctx.defender.magicalProtection * intScaling
      : base + ctx.currentAdaptiveIntelligence() * intScaling

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A01', label: aspect ? 'Wing Gust (aspect)' : 'Wing Gust' })
    for (let i = 0; i < hits; i += 1) {
      ctx.state.t = savedT + i * interval
      ctx.emitDamage(ctx, 'magical', pre, `Wing Gust (projectile ${i + 1}/${hits})`, 'ability',
        aspect ? ['aspect talent damage modeled from local Talent Base Damage + TalentDamageProtScaling rows'] : undefined)
      if (i === 0) ctx.applyAbilityHitItemProcs(ctx)
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }
    ctx.state.t = savedT
    setAbilityCooldown(ctx, 'A01', abilityRowAt(ctx.attacker.god, 'A01', 'Cooldown', rank) ?? 5)
    return true
  },
  A02: undefined,
  A03: undefined,
  A04: undefined,
}

const BaronHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A01: (ctx, rank) => {
    const base = abilityRowAt(ctx.attacker.god, 'A01', 'Base Damage', rank) ?? 0
    const intScaling = abilityRowAt(ctx.attacker.god, 'A01', 'Int Scaling', rank) ?? 0
    const overlapMultiplier = abilityRowAt(ctx.attacker.god, 'A01', 'Second Hit Damage Dealt', rank) ?? 0
    if (base <= 0 && intScaling <= 0) return false

    const pre = base + ctx.currentAdaptiveIntelligence() * intScaling
    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A01', label: 'Vivid Gaze' })
    ctx.emitDamage(ctx, 'magical', pre, 'Vivid Gaze', 'ability')
    ctx.applyAbilityHitItemProcs(ctx)
    ctx.applyRepeatableAbilityHitItemProcs(ctx)
    if (overlapMultiplier > 0) {
      ctx.emitDamage(
        ctx,
        'magical',
        pre * overlapMultiplier,
        'Vivid Gaze (overlap)',
        'ability',
        ['single-target overlap assumption from description + Second Hit Damage Dealt row'],
      )
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }

    const hysteria = baronTargetHysteria(ctx)
    const reductionDuration = abilityRowAt(ctx.attacker.god, 'A01', 'Power Reduction Duration', rank) ?? 0
    if (hysteria > 30 && reductionDuration > 0) {
      applyOrRefreshDebuff(ctx.state, {
        key: 'Baron_Samedi.A01.reduction',
        label: 'Vivid Gaze reduction',
        expiresAt: ctx.state.t + reductionDuration,
        modifiers: {},
      })
    }

    setAbilityCooldown(ctx, 'A01', abilityRowAt(ctx.attacker.god, 'A01', 'Cooldown', rank) ?? 13)
    return true
  },
  A02: (ctx, rank) => {
    const base = abilityRowAt(ctx.attacker.god, 'A02', 'Base Damage', rank) ?? 0
    const intScaling = abilityRowAt(ctx.attacker.god, 'A02', 'Int Scaling', rank) ?? 0
    if (base <= 0 && intScaling <= 0) return false

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A02', label: 'Consign Spirits' })
    ctx.emitDamage(ctx, 'magical', base + ctx.currentAdaptiveIntelligence() * intScaling, 'Consign Spirits', 'ability')
    ctx.applyAbilityHitItemProcs(ctx)
    ctx.applyRepeatableAbilityHitItemProcs(ctx)

    if (hasActiveAspect(ctx)) {
      const slowPct = abilityRowAt(ctx.attacker.god, 'A02', 'TalentSlow', rank) ?? 0
      const slowDuration = abilityRowAt(ctx.attacker.god, 'A02', 'TalentSlowDuration', rank) ?? 0
      if (slowPct > 0 && slowDuration > 0) {
        applyOrRefreshDebuff(ctx.state, {
          key: 'Baron_Samedi.A02.aspectSlow',
          label: 'Consign Spirits slow',
          expiresAt: ctx.state.t + slowDuration,
          modifiers: { MovementSpeedPercent: -slowPct },
        })
      }
    }

    setAbilityCooldown(ctx, 'A02', abilityRowAt(ctx.attacker.god, 'A02', 'Cooldown', rank) ?? 14)
    return true
  },
  A03: (ctx, rank) => {
    const tickBase = abilityRowAt(ctx.attacker.god, 'A03', 'Damage Per Tick', rank) ?? 0
    const tickScaling = abilityRowAt(ctx.attacker.god, 'A03', 'Int Scaling Per Tick', rank) ?? 0
    if (tickBase <= 0 && tickScaling <= 0) return false

    const slowAndRootDuration = abilityRowAt(ctx.attacker.god, 'A03', 'Slow and Root Duration', rank) ?? 2.5
    const rootDuration = abilityRowAt(ctx.attacker.god, 'A03', 'Root Duration', rank) ?? 0.75
    const mesmerizeDuration = abilityRowAt(ctx.attacker.god, 'A03', 'Mesmerize Duration', rank) ?? 1.5
    const explosionBase = abilityRowAt(ctx.attacker.god, 'A03', 'Explosion Damage', rank) ?? 0
    const explosionScaling = abilityRowAt(ctx.attacker.god, 'A03', 'Explosion Int Scaling', rank) ?? 0
    const hysteria = baronTargetHysteria(ctx)
    const savedT = ctx.state.t
    const tickRate = 0.25
    const duration = abilityRowAt(ctx.attacker.god, 'A03', 'Slow Duration', rank) ?? 1.75
    const tickCount = Math.max(1, Math.round(duration / tickRate))
    let procsApplied = false

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A03', label: 'Wrap It Up' })
    applyOrRefreshDebuff(ctx.state, {
      key: 'Baron_Samedi.A03.constrict',
      label: 'Wrap It Up constrict',
      expiresAt: ctx.state.t + slowAndRootDuration,
      modifiers: {},
    })

    for (let i = 1; i <= tickCount; i++) {
      ctx.state.t = savedT + i * tickRate
      ctx.emitDamage(
        ctx,
        'magical',
        tickBase + ctx.currentAdaptiveIntelligence() * tickScaling,
        `Wrap It Up (tick ${i}/${tickCount})`,
        'dot',
        i === 1 ? ['1.75s description modeled as 7 ticks at 0.25s'] : undefined,
      )
      if (!procsApplied) {
        ctx.applyAbilityHitItemProcs(ctx)
        procsApplied = true
      }
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }

    if (hysteria > 30 && explosionBase > 0) {
      ctx.state.t = savedT + rootDuration
      ctx.emitDamage(
        ctx,
        'magical',
        explosionBase + ctx.currentAdaptiveIntelligence() * explosionScaling,
        'Wrap It Up (explosion)',
        'ability',
      )
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
      if (mesmerizeDuration > 0) {
        applyOrRefreshDebuff(ctx.state, {
          key: 'Baron_Samedi.A03.mesmerize',
          label: 'Wrap It Up mesmerize',
          expiresAt: ctx.state.t + mesmerizeDuration,
          modifiers: {},
        })
      }
    }

    ctx.state.t = savedT
    setAbilityCooldown(ctx, 'A03', abilityRowAt(ctx.attacker.god, 'A03', 'Cooldown', rank) ?? 15)
    return true
  },
  A04: (ctx, rank) => {
    const tickBase = abilityRowAt(ctx.attacker.god, 'A04', 'Damage Per Tick', rank) ?? 0
    const tickScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Int Scaling', rank) ?? 0
    const slamBase = abilityRowAt(ctx.attacker.god, 'A04', 'Damage On Hit', rank) ?? 0
    const slamScaling = abilityRowAt(ctx.attacker.god, 'A04', 'On Hit Int Scaling', rank) ?? 0
    if ((tickBase <= 0 && tickScaling <= 0) && (slamBase <= 0 && slamScaling <= 0)) return false

    const stunDuration = abilityRowAt(ctx.attacker.god, 'A04', 'Stun Duration', rank) ?? 1.3
    const selfDr = abilityRowAt(ctx.attacker.god, 'A04', 'Self Damage Reduction', rank) ?? 0
    const maxHealthDamage = abilityRowAt(ctx.attacker.god, 'A04', 'Max Health Damage', rank) ?? 0
    const savedT = ctx.state.t
    const hitInterval = 0.5
    const vortexDuration = 1
    const vortexTicks = Math.max(1, Math.round(vortexDuration / hitInterval))
    let procsApplied = false

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A04', label: 'Life of the Party' })
    if (selfDr > 0) {
      applyOrRefreshBuff(ctx.state, {
        key: 'Baron_Samedi.A04.damageReduction',
        label: 'Life of the Party damage reduction',
        expiresAt: ctx.state.t + vortexDuration,
        modifiers: { DamageTakenPercent: -selfDr },
      })
    }

    for (let i = 1; i <= vortexTicks; i++) {
      ctx.state.t = savedT + i * hitInterval
      ctx.emitDamage(
        ctx,
        'magical',
        tickBase + ctx.currentAdaptiveIntelligence() * tickScaling,
        `Life of the Party (vortex ${i}/${vortexTicks})`,
        'ability',
      )
      if (!procsApplied) {
        ctx.applyAbilityHitItemProcs(ctx)
        procsApplied = true
      }
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }

    ctx.state.t = savedT + vortexDuration
    ctx.emitDamage(
      ctx,
      'magical',
      slamBase + ctx.currentAdaptiveIntelligence() * slamScaling + ctx.defender.maxHealth * maxHealthDamage,
      'Life of the Party (slam)',
      'ability',
      ['vortex loop duration taken from local A04 timing/loop asset'],
    )
    ctx.applyRepeatableAbilityHitItemProcs(ctx)
    if (stunDuration > 0) {
      applyOrRefreshDebuff(ctx.state, {
        key: 'Baron_Samedi.A04.stun',
        label: 'Life of the Party stun',
        expiresAt: ctx.state.t + stunDuration,
        modifiers: {},
      })
    }

    ctx.state.t = savedT
    setAbilityCooldown(ctx, 'A04', abilityRowAt(ctx.attacker.god, 'A04', 'Cooldown', rank) ?? 90)
    return true
  },
}

const XbalanqueHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A01: (ctx, rank) => {
    if (!hasActiveAspect(ctx)) return false
    const baseDamage = aspectRowAt(ctx.attacker.god, 'A01', 'Aspect Projectile Base Damage', rank)
    if (baseDamage <= 0) return false
    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A01', label: 'Branching Bola (aspect)' })
    ctx.state.riders.activeBasicProjectiles.push({
      key: 'Xbalanque.aspect.A01',
      label: 'Branching Bola (aspect projectile)',
      damageType: 'physical',
      baseDamage,
      inhandScaling: 0,
      strScaling: aspectRowAt(ctx.attacker.god, 'A01', 'Aspect Projectile Strength Scaling', rank),
      intScaling: aspectRowAt(ctx.attacker.god, 'A01', 'Aspect Projectile Int Scaling', rank),
      hits: 1,
      expiresAt: ctx.state.t + 30,
      remainingBasics: 3,
    })
    setAbilityCooldown(ctx, 'A01', 12)
    return true
  },
  A04: (ctx, rank) => {
    if (!hasActiveAspect(ctx)) return false
    const duration = abilityRowAt(ctx.attacker.god, 'A04', 'Buff Duration', rank) ?? 0
    const abilityDamagePct = abilityRowAt(ctx.attacker.god, 'A04', 'TalentAbilityMulti', rank) ?? 0
    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A04', label: 'Darkest of Nights (aspect)' })
    if (duration > 0 && abilityDamagePct > 0) {
      ctx.state.attackerBuffs.set('Xbalanque.aspect.A04', {
        key: 'Xbalanque.aspect.A04',
        label: 'Darkest of Nights (ability damage)',
        appliedAt: ctx.state.t,
        expiresAt: ctx.state.t + duration,
        modifiers: { AbilityDamagePercent: abilityDamagePct * 100 },
        stacks: 1,
      })
      ctx.state.events.push({
        kind: 'buff-apply',
        t: ctx.state.t,
        label: 'Darkest of Nights (ability damage)',
        target: 'self',
        durationSeconds: duration,
        expiresAt: ctx.state.t + duration,
      })
    }
    setAbilityCooldown(ctx, 'A04', abilityRowAt(ctx.attacker.god, 'A04', 'Cooldown', rank) ?? 70)
    return true
  },
  A02: undefined,
  A03: undefined,
}

const IshtarHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A01: (ctx, rank) => {
    const bonusDamage = abilityRowAt(ctx.attacker.god, 'A01', 'Damage', rank) ?? 0
    const cooldown = abilityRowAt(ctx.attacker.god, 'A01', 'Cooldown', rank) ?? 12
    if (bonusDamage <= 0) return false

    const mode = ishtarA01Mode(ctx.attacker.godState)
    const duration = 6
    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A01', label: 'Imbue Arrows' })

    if (mode === 'storm') {
      applyOrRefreshBuff(ctx.state, {
        key: 'Ishtar.A01.storm',
        label: 'Imbue Arrows (Storm Shot)',
        expiresAt: ctx.state.t + duration,
        modifiers: { AttackSpeedPercent: 25 },
      })
    } else if (mode === 'spread') {
      ctx.state.riders.activeBasicProjectiles.push({
        key: 'Ishtar.A01.spread',
        label: 'Imbue Arrows (Spread Shot)',
        damageType: 'physical',
        baseDamage: bonusDamage,
        inhandScaling: 0,
        hits: 5,
        expiresAt: ctx.state.t + duration,
        source: 'ability',
        notes: ['stance selected from godState; all 5 arrows are emitted in single-target verifier mode'],
      })
    } else {
      ctx.state.riders.activeBasicProjectiles.push({
        key: 'Ishtar.A01.lob',
        label: 'Imbue Arrows (Strike Shot)',
        damageType: 'physical',
        baseDamage: bonusDamage,
        inhandScaling: 0,
        hits: 1,
        expiresAt: ctx.state.t + duration,
        source: 'ability',
        notes: ['defaulted to Strike Shot/Lob when stance is unspecified'],
      })
    }

    setAbilityCooldown(ctx, 'A01', cooldown)
    return true
  },
  A02: undefined,
  A03: undefined,
  A04: undefined,
}

const SusanoHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A01: (ctx, rank) => {
    const stageKey = 'Susano.A01.stage'
    const stageExpiryKey = 'Susano.A01.stageExpiry'
    const storedStage = Number(ctx.state.cooldowns.actives[stageKey] ?? 1)
    const stageExpiresAt = ctx.state.cooldowns.actives[stageExpiryKey] ?? 0
    const stage = stageExpiresAt > ctx.state.t ? Math.max(1, Math.min(3, Math.floor(storedStage))) : 1
    const stageLabels = ['Storm Kata (cone)', 'Storm Kata (whirlwind)', 'Storm Kata (dash)'] as const

    const base = abilityRowAt(ctx.attacker.god, 'A01', 'Base Damage', rank) ?? 0
    const scaling = abilityRowAt(ctx.attacker.god, 'A01', 'Strength Scaling', rank) ?? 0
    const pre = base + ctx.currentAdaptiveStrength() * scaling

    ctx.state.events.push({
      kind: 'ability-cast',
      t: ctx.state.t,
      slot: 'A01',
      label: ctx.cancel ? `${stageLabels[stage - 1]} (cancel)` : stageLabels[stage - 1],
    })
    ctx.emitDamage(ctx, 'physical', pre, stageLabels[stage - 1], 'ability')
    ctx.applyAbilityHitItemProcs(ctx)
    ctx.applyRepeatableAbilityHitItemProcs(ctx)

    const cooldown = abilityRowAt(ctx.attacker.god, 'A01', 'Cooldown', rank) ?? 12
    if (stage >= 3) {
      setAbilityCooldown(ctx, 'A01', cooldown)
      ctx.state.cooldowns.actives[stageKey] = 1
      ctx.state.cooldowns.actives[stageExpiryKey] = 0
    } else {
      ctx.state.cooldowns.abilities.A01 = ctx.state.t
      ctx.state.cooldowns.actives[stageKey] = stage + 1
      ctx.state.cooldowns.actives[stageExpiryKey] = ctx.state.t + 5
    }
    return true
  },
  A02: undefined,
  A03: undefined,
  A04: (ctx, rank) => {
    const tickBase = abilityRowAt(ctx.attacker.god, 'A04', 'Base Damage Per Tick', rank) ?? 0
    const tickScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Strength Scaling Per Tick', rank) ?? 0
    const projectileBase = abilityRowAt(ctx.attacker.god, 'A04', 'Base Damage Projectile', rank) ?? 0
    const projectileScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Strength Scaling Projectile', rank) ?? 0
    const tickTime = abilityRowAt(ctx.attacker.god, 'A04', 'TickTime', rank) ?? 0.4
    const refireTime = abilityRowAt(ctx.attacker.god, 'A04', 'RefireTime', rank) ?? 2
    if ((tickBase <= 0 && tickScaling <= 0) && (projectileBase <= 0 && projectileScaling <= 0)) return false

    const ticks = resolveHits(ctx, 'A04', Math.max(1, Math.round(refireTime / Math.max(0.05, tickTime))))
    const savedT = ctx.state.t
    const tickPre = tickBase + ctx.currentAdaptiveStrength() * tickScaling
    const projectilePre = projectileBase + ctx.currentAdaptiveStrength() * projectileScaling

    ctx.state.events.push({ kind: 'ability-cast', t: savedT, slot: 'A04', label: 'Typhoon' })
    let procsApplied = false
    for (let i = 1; i <= ticks; i += 1) {
      ctx.state.t = savedT + i * tickTime
      if (tickPre > 0) {
        ctx.emitDamage(ctx, 'physical', tickPre, `Typhoon (tick ${i}/${ticks})`, 'ability')
        if (!procsApplied) {
          ctx.applyAbilityHitItemProcs(ctx)
          procsApplied = true
        }
        ctx.applyRepeatableAbilityHitItemProcs(ctx)
      }
    }
    if (projectilePre > 0) {
      ctx.state.t = savedT + refireTime
      ctx.emitDamage(
        ctx,
        'physical',
        projectilePre,
        'Typhoon (launch)',
        'ability',
        ['delayed from authored tooltip: automatically refires after 2s'],
      )
      if (!procsApplied) ctx.applyAbilityHitItemProcs(ctx)
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }

    ctx.state.t = savedT
    setAbilityCooldown(ctx, 'A04', abilityRowAt(ctx.attacker.god, 'A04', 'Cooldown', rank) ?? 90)
    return true
  },
}

const KaliHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A02: (ctx, rank) => {
    const base = abilityRowAt(ctx.attacker.god, 'A02', 'Base Damage', rank) ?? 0
    const strScaling = abilityRowAt(ctx.attacker.god, 'A02', 'Scaling', rank) ?? 0
    const intScaling = abilityRowAt(ctx.attacker.god, 'A02', 'Int Scaling', rank) ?? 0
    const bleedBase = abilityRowAt(ctx.attacker.god, 'A02', 'Bleed Damage', rank) ?? 0
    const bleedStrScaling = abilityRowAt(ctx.attacker.god, 'A02', 'Bleed Str Scaling', rank) ?? 0
    const bleedIntScaling = abilityRowAt(ctx.attacker.god, 'A02', 'Bleed Int Scaling', rank) ?? 0
    if ((base <= 0 && strScaling <= 0 && intScaling <= 0) && (bleedBase <= 0 && bleedStrScaling <= 0 && bleedIntScaling <= 0)) return false

    const savedT = ctx.state.t
    const blades = resolveHits(ctx, 'A02', 3)
    const bladePre = base + ctx.currentAdaptiveStrength() * strScaling + ctx.currentAdaptiveIntelligence() * intScaling

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A02', label: 'Lash' })
    for (let i = 0; i < blades; i += 1) {
      ctx.state.t = savedT + i * 0.05
      ctx.emitDamage(ctx, 'physical', bladePre, `Lash (blade ${i + 1}/${blades})`, 'ability')
      if (i === 0) ctx.applyAbilityHitItemProcs(ctx)
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }

    const tickRate = 0.5
    const duration = 3
    const ticks = Math.max(1, Math.round(duration / tickRate))
    let procsApplied = true
    ctx.schedDot(ctx, {
      kind: 'dot',
      baseDamage: bleedBase,
      strScaling: bleedStrScaling,
      intScaling: bleedIntScaling,
      hits: 1,
      ticks,
      tickRate,
      duration,
      damageType: 'physical',
      label: 'Lash (bleed)',
    }, 'Lash (bleed)', () => {
      if (!procsApplied) {
        ctx.applyAbilityHitItemProcs(ctx)
        procsApplied = true
      }
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    })

    ctx.state.t = savedT
    setAbilityCooldown(ctx, 'A02', abilityRowAt(ctx.attacker.god, 'A02', 'Cooldown', rank) ?? 14)
    return true
  },
  A04: (ctx, rank) => {
    const tickBase = abilityRowAt(ctx.attacker.god, 'A04', 'Damage Per Tick', rank) ?? 0
    const strScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Str Scaling Per Tick', rank) ?? 0
    const intScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Int Scaling Per Tick', rank) ?? 0
    const duration = abilityRowAt(ctx.attacker.god, 'A04', 'Duration', rank) ?? 0
    if (tickBase <= 0 && strScaling <= 0 && intScaling <= 0) return false

    const tickRate = 0.25
    const ticks = Math.max(1, Math.round(duration / tickRate))
    const pre = tickBase + ctx.currentAdaptiveStrength() * strScaling + ctx.currentAdaptiveIntelligence() * intScaling
    const savedT = ctx.state.t

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A04', label: 'Destruction' })
    for (let i = 0; i < ticks; i += 1) {
      ctx.state.t = savedT + (i + 1) * tickRate
      ctx.emitDamage(ctx, 'physical', pre, `Destruction (tick ${i + 1}/${ticks})`, 'ability')
      if (i === 0) ctx.applyAbilityHitItemProcs(ctx)
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }
    ctx.state.t = savedT
    setAbilityCooldown(ctx, 'A04', abilityRowAt(ctx.attacker.god, 'A04', 'Cooldown', rank) ?? 90)
    return true
  },
  A01: undefined,
  A03: undefined,
}

const SolHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A02: (ctx, rank) => {
    const base = abilityRowAt(ctx.attacker.god, 'A02', 'Base Damage', rank) ?? 0
    const strScaling = abilityRowAt(ctx.attacker.god, 'A02', 'STR Scaling', rank) ?? 0
    const intScaling = abilityRowAt(ctx.attacker.god, 'A02', 'Int Scaling', rank) ?? 0
    if (base <= 0 && strScaling <= 0 && intScaling <= 0) return false

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A02', label: 'Stellar Burst' })
    const expiresAt = ctx.state.t + 5
    ctx.state.riders.nextBasicBonusDamages.push({
      label: 'Stellar Burst (explosion)',
      damageType: 'magical',
      baseDamage: base,
      strScaling,
      intScaling,
      expiresAt,
      source: 'ability',
      notes: ['armed on next basic from local CT Base Damage / Scaling rows'],
    })
    ctx.state.riders.nextBasicBonusDamages.push({
      label: 'Stellar Burst (retraction)',
      damageType: 'magical',
      baseDamage: base,
      strScaling,
      intScaling,
      expiresAt,
      delaySeconds: 0.25,
      source: 'ability',
      notes: ['local CT Base Damage / Scaling rows + separate GE_Sol_A02_RetractionDamage'],
    })
    setAbilityCooldown(ctx, 'A02', abilityRowAt(ctx.attacker.god, 'A02', 'Cooldown', rank) ?? 14)
    return true
  },
  A04: (ctx, rank) => {
    const { attacker, state, emitDamage, applyAbilityHitItemProcs, applyRepeatableAbilityHitItemProcs } = ctx
    const base = abilityRowAt(attacker.god, 'A04', 'Base Damage', rank) ?? 0
    const intScale = abilityRowAt(attacker.god, 'A04', 'Int Scaling', rank) ?? 0
    if (base <= 0 && intScale <= 0) return false

    // Extracted GE set includes:
    // - GE_Sol_A04_Damage
    // - GE_Sol_A04_SubsequentDamage      (0.65 multiplier visible in dump)
    // - GE_Sol_A04_FinalSubsequentDamage (0.30 multiplier visible in dump)
    const FULL_HIT_MULT = 1
    const SUBSEQUENT_HIT_MULT = 0.65
    const FINAL_HIT_MULT = 0.30
    const TOTAL_HITS = 8
    const HIT_INTERVAL = 0.18

    state.events.push({ kind: 'ability-cast', t: state.t, slot: 'A04', label: 'Supernova (channel)' })
    const savedT = state.t
    const fullPre = base + ctx.currentAdaptiveIntelligence() * intScale
    let procsApplied = false

    for (let i = 1; i <= TOTAL_HITS; i++) {
      const mult =
        i === 1 ? FULL_HIT_MULT
        : i === TOTAL_HITS ? FINAL_HIT_MULT
        : SUBSEQUENT_HIT_MULT
      state.t = savedT + i * HIT_INTERVAL
      emitDamage(ctx, 'magical', fullPre * mult, `Supernova (hit ${i}/${TOTAL_HITS})`, 'ability',
        i === 1 ? ['GE_Sol_A04_Damage'] : i === TOTAL_HITS ? ['GE_Sol_A04_FinalSubsequentDamage'] : ['GE_Sol_A04_SubsequentDamage'])
      if (i === 1 && !procsApplied) {
        applyAbilityHitItemProcs(ctx)
        procsApplied = true
      }
      applyRepeatableAbilityHitItemProcs(ctx)
    }

    state.t = savedT
    setAbilityCooldown(ctx, 'A04', abilityRowAt(attacker.god, 'A04', 'Cooldown', rank) ?? 90)
    return true
  },
  A01: undefined,
  A03: undefined,
}

const TsukuyomiHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A04: (ctx, rank) => {
    const beamBase = abilityRowAt(ctx.attacker.god, 'A04', 'Beam Damage', rank) ?? 0
    const beamStrScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Beam Scaling', rank) ?? 0
    const beamIntScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Int Beam Scaling', rank) ?? 0
    const dashBase = abilityRowAt(ctx.attacker.god, 'A04', 'Dash Damage', rank) ?? 0
    const dashStrScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Dash Scaling', rank) ?? 0
    const dashIntScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Int Dash Scaling', rank) ?? 0
    if ((beamBase <= 0 && beamStrScaling <= 0 && beamIntScaling <= 0) && (dashBase <= 0 && dashStrScaling <= 0 && dashIntScaling <= 0)) return false

    const beams = resolveHits(ctx, 'A04', 4)
    const beamInterval = 0.2
    const dashInterval = 0.2
    const savedT = ctx.state.t
    const beamPre = beamBase + ctx.currentAdaptiveStrength() * beamStrScaling + ctx.currentAdaptiveIntelligence() * beamIntScaling
    const dashPre = dashBase + ctx.currentAdaptiveStrength() * dashStrScaling + ctx.currentAdaptiveIntelligence() * dashIntScaling

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A04', label: 'Piercing Moonlight' })
    for (let i = 0; i < beams; i += 1) {
      ctx.state.t = savedT + i * beamInterval
      ctx.emitDamage(ctx, 'physical', beamPre, `Piercing Moonlight (beam ${i + 1}/${beams})`, 'ability')
      if (i === 0) ctx.applyAbilityHitItemProcs(ctx)
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }
    // The local A04 GA tracks per-projectile authority hit targets (Proj1-4)
    // plus a teleport target list. Model dash strikes as one warp attack per
    // successful beam hit so 2 beams -> 2 dashes and 4 beams -> 4 dashes.
    const dashHits = beams
    const dashStartT = savedT + beams * beamInterval
    for (let i = 0; i < dashHits; i += 1) {
      ctx.state.t = dashStartT + i * dashInterval
      ctx.emitDamage(
        ctx,
        'physical',
        dashPre,
        `Piercing Moonlight (dash ${i + 1}/${dashHits})`,
        'ability',
        ['local GA TargetListEventData.Proj1-4 + TargetsToTeleportTo imply one warp strike per beam hit'],
      )
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    }

    if (hasActiveAspect(ctx)) {
      const targetBase = abilityRowAt(ctx.attacker.god, 'A04', 'Talent_TargetBaseDamage', rank) ?? 0
      const targetStrScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Talent_TargetStrengthScaling', rank) ?? 0
      const targetIntScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Talent_TargetIntelligenceScaling', rank) ?? 0
      const areaBase = abilityRowAt(ctx.attacker.god, 'A04', 'Talent_AoEBaseDamage', rank) ?? 0
      const areaStrScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Talent_AoEStrengthScaling', rank) ?? 0
      const areaIntScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Talent_AoEIntelligenceScaling', rank) ?? 0

      for (let i = 0; i < dashHits; i += 1) {
        ctx.state.t = dashStartT + i * dashInterval
        if (targetBase > 0 || targetStrScaling > 0 || targetIntScaling > 0) {
          ctx.emitDamage(
            ctx,
            'physical',
            targetBase + ctx.currentAdaptiveStrength() * targetStrScaling + ctx.currentAdaptiveIntelligence() * targetIntScaling,
            `Piercing Moonlight (aspect target ${i + 1}/${dashHits})`,
            'ability',
          )
          ctx.applyRepeatableAbilityHitItemProcs(ctx)
        }
        if (areaBase > 0 || areaStrScaling > 0 || areaIntScaling > 0) {
          ctx.emitDamage(
            ctx,
            'physical',
            areaBase + ctx.currentAdaptiveStrength() * areaStrScaling + ctx.currentAdaptiveIntelligence() * areaIntScaling,
            `Piercing Moonlight (aspect area ${i + 1}/${dashHits})`,
            'ability',
          )
          ctx.applyRepeatableAbilityHitItemProcs(ctx)
        }
      }
    }
    ctx.state.t = savedT
    setAbilityCooldown(ctx, 'A04', abilityRowAt(ctx.attacker.god, 'A04', 'Cooldown', rank) ?? 90)
    return true
  },
  A01: undefined,
  A02: undefined,
  A03: undefined,
}

const MordredHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A04: (ctx, rank) => {
    const base = abilityRowAt(ctx.attacker.god, 'A04', 'Base Damage', rank) ?? 0
    const strScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Strength Scaling', rank) ?? 0
    const dotBase = abilityRowAt(ctx.attacker.god, 'A04', 'Dot Damage', rank) ?? 0
    const dotScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Dot Scaling', rank) ?? 0
    const dotTickRate = abilityRowAt(ctx.attacker.god, 'A04', 'Dot Tick Rate', rank) ?? 0.3
    const duration = abilityRowAt(ctx.attacker.god, 'A04', 'Channel Duration', rank) ?? 1.5
    if ((base <= 0 && strScaling <= 0) && (dotBase <= 0 && dotScaling <= 0)) return false

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A04', label: 'Heart Slash' })
    ctx.emitDamage(ctx, 'physical', base + ctx.currentAdaptiveStrength() * strScaling, 'Heart Slash', 'ability')
    ctx.applyAbilityHitItemProcs(ctx)
    ctx.applyRepeatableAbilityHitItemProcs(ctx)

    const ticks = Math.max(1, Math.round(duration / dotTickRate))
    let procsApplied = true
    ctx.schedDot(ctx, {
      kind: 'dot',
      baseDamage: dotBase,
      strScaling: dotScaling,
      intScaling: 0,
      hits: 1,
      ticks,
      tickRate: dotTickRate,
      duration,
      damageType: 'physical',
      label: 'Heart Slash (DoT)',
    }, 'Heart Slash (DoT)', () => {
      if (!procsApplied) {
        ctx.applyAbilityHitItemProcs(ctx)
        procsApplied = true
      }
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
    })

    setAbilityCooldown(ctx, 'A04', abilityRowAt(ctx.attacker.god, 'A04', 'Cooldown', rank) ?? 14)
    return true
  },
  A01: undefined,
  A02: undefined,
  A03: undefined,
}

const OdinHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A02: (ctx, rank) => {
    const shieldBase = abilityRowAt(ctx.attacker.god, 'A02', 'Shield Health', rank) ?? 0
    const shieldStrScaling = abilityRowAt(ctx.attacker.god, 'A02', 'Str Scaling Shield', rank) ?? 0
    const shieldIntScaling = abilityRowAt(ctx.attacker.god, 'A02', 'Int Scaling Shield', rank) ?? 0
    const duration = abilityRowAt(ctx.attacker.god, 'A02', 'Duration', rank) ?? 0
    const fullShieldBonusPct = abilityRowAt(ctx.attacker.god, 'A02', 'Bonus Damage', rank) ?? 0
    if (shieldBase <= 0 && shieldStrScaling <= 0 && shieldIntScaling <= 0) return false

    const shieldValue =
      shieldBase
      + ctx.currentAdaptiveStrength() * shieldStrScaling
      + ctx.currentAdaptiveIntelligence() * shieldIntScaling

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A02', label: 'Raven Shout' })
    if (duration > 0) {
      applyOrRefreshBuff(ctx.state, {
        key: 'Odin.A02.shield',
        label: 'Raven Shout shield',
        expiresAt: ctx.state.t + duration,
        modifiers: { ShieldHealth: shieldValue },
      })
    }

    if (hasActiveAspect(ctx) && duration > 0) {
      const strengthBuff = aspectRowAt(ctx.attacker.god, 'A02', 'Strength Buff', rank)
      const attackSpeedBuff = aspectRowAt(ctx.attacker.god, 'A02', 'Attack Speed Buff', rank)
      const aspectBuffDuration = aspectRowAt(ctx.attacker.god, 'A02', 'Buff Duration', rank) || duration
      const modifiers: Partial<Record<string, number>> = {}
      if (strengthBuff > 0) modifiers.adaptiveStrength = strengthBuff
      if (attackSpeedBuff > 0) modifiers.AttackSpeedPercent = attackSpeedBuff
      if (Object.keys(modifiers).length > 0) {
        applyOrRefreshBuff(ctx.state, {
          key: 'Odin.A02.aspectBuff',
          label: 'Raven Shout (aspect buff)',
          expiresAt: ctx.state.t + aspectBuffDuration,
          modifiers,
        })
      }
    }

    if (duration > 0 && shieldValue > 0) {
      const savedT = ctx.state.t
      ctx.state.t = savedT + duration
      const pre = shieldValue * (1 + fullShieldBonusPct)
      ctx.emitDamage(ctx, 'physical', pre, 'Raven Shout (shield burst)', 'ability',
        ['cast-alone assumption: full shield remained intact', 'damage uses Shield Health + Bonus Damage rows', 'GE_Odin_A02_Damage_Timeout local asset present'])
      ctx.applyAbilityHitItemProcs(ctx)
      ctx.applyRepeatableAbilityHitItemProcs(ctx)
      ctx.state.t = savedT
    }

    setAbilityCooldown(ctx, 'A02', abilityRowAt(ctx.attacker.god, 'A02', 'Cooldown', rank) ?? 14)
    return true
  },
  A01: undefined,
  A03: undefined,
  A04: undefined,
}

const MerlinHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A01: (ctx, rank) => {
    const base = abilityRowAt(ctx.attacker.god, 'A01', 'Damage', rank) ?? 0
    const intScaling = abilityRowAt(ctx.attacker.god, 'A01', 'Int Scaling', rank) ?? 0
    if (base <= 0 && intScaling <= 0) return false

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A01', label: 'Eclipse' })
    ctx.emitDamage(ctx, 'magical', base + ctx.currentAdaptiveIntelligence() * intScaling, 'Eclipse', 'ability',
      ['conditional outer-range bonus damage is not auto-applied in a naked one-cast sim'])
    ctx.applyAbilityHitItemProcs(ctx)
    ctx.applyRepeatableAbilityHitItemProcs(ctx)
    setAbilityCooldown(ctx, 'A01', abilityRowAt(ctx.attacker.god, 'A01', 'Cooldown', rank) ?? 13)
    return true
  },
  A04: (ctx, rank) => {
    const base = abilityRowAt(ctx.attacker.god, 'A04', 'Damage', rank) ?? 0
    const intScaling = abilityRowAt(ctx.attacker.god, 'A04', 'INT Scaling', rank) ?? 0
    if (base <= 0 && intScaling <= 0) return false

    const pre = base + ctx.currentAdaptiveIntelligence() * intScaling
    const savedT = ctx.state.t
    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A04', label: 'Elemental Mastery' })
    ctx.emitDamage(ctx, 'magical', pre, 'Elemental Mastery', 'ability')
    ctx.applyAbilityHitItemProcs(ctx)
    ctx.applyRepeatableAbilityHitItemProcs(ctx)

    ctx.state.t = savedT + 0.35
    ctx.emitDamage(ctx, 'magical', pre, 'Elemental Mastery (collapse)', 'ability',
      ['local CT Damage row reused for collapse', 'separate GE_Merlin_A04_RetractionDamage local asset present'])
    ctx.applyRepeatableAbilityHitItemProcs(ctx)
    ctx.state.t = savedT

    setAbilityCooldown(ctx, 'A04', abilityRowAt(ctx.attacker.god, 'A04', 'Cooldown', rank) ?? 14)
    return true
  },
  A02: undefined,
  A03: undefined,
}

const MORRIGAN_DARK_OMEN_EXPIRES_KEY = 'TheMorrigan.A02.omen.expires'
const MORRIGAN_DARK_OMEN_BASE_KEY = 'TheMorrigan.A02.omen.base'
const MORRIGAN_DARK_OMEN_SCALE_KEY = 'TheMorrigan.A02.omen.intScale'
const MORRIGAN_DARK_OMEN_DURATION_SECONDS = 5

const TheMorriganHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A01: undefined,
  A02: (ctx, rank) => {
    const initialBase = abilityRowAt(ctx.attacker.god, 'A02', 'Initial Damage', rank) ?? 0
    const initialScale = abilityRowAt(ctx.attacker.god, 'A02', 'Initial Scaling', rank) ?? 0
    const triggerBase = abilityRowAt(ctx.attacker.god, 'A02', 'Trigger Damage Gods', rank) ?? 0
    const triggerScale = abilityRowAt(ctx.attacker.god, 'A02', 'Trigger Scaling Gods', rank) ?? 0
    const pre = initialBase + ctx.currentAdaptiveIntelligence() * initialScale

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A02', label: 'Dark Omen' })
    ctx.emitDamage(ctx, 'magical', pre, 'Dark Omen', 'ability')
    ctx.applyAbilityHitItemProcs(ctx)
    ctx.applyRepeatableAbilityHitItemProcs(ctx)

    ctx.state.cooldowns.actives[MORRIGAN_DARK_OMEN_EXPIRES_KEY] = ctx.state.t + MORRIGAN_DARK_OMEN_DURATION_SECONDS
    ctx.state.cooldowns.actives[MORRIGAN_DARK_OMEN_BASE_KEY] = triggerBase
    ctx.state.cooldowns.actives[MORRIGAN_DARK_OMEN_SCALE_KEY] = triggerScale

    const cooldown = abilityRowAt(ctx.attacker.god, 'A02', 'Cooldown', rank) ?? 12
    setAbilityCooldown(ctx, 'A02', cooldown)
    return true
  },
  A03: undefined,
  A04: undefined,
}

const NutHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A01: (ctx, rank) => {
    const sideBase = abilityRowAt(ctx.attacker.god, 'A01', 'Side Damage Base', rank) ?? 0
    const sideStrScaling = abilityRowAt(ctx.attacker.god, 'A01', 'Side Strength Scaling', rank) ?? 0
    const sideIntScaling = abilityRowAt(ctx.attacker.god, 'A01', 'Side Int Scaling', rank) ?? 0
    const shots = Math.max(1, Math.floor(abilityRowAt(ctx.attacker.god, 'A01', 'Stacks per Shot', rank) ?? 4))
    const protDebuffPct = Math.max(
      abilityRowAt(ctx.attacker.god, 'A01', 'PhysProtDebuff', rank) ?? 0,
      abilityRowAt(ctx.attacker.god, 'A01', 'MagicalProtDebuff', rank) ?? 0,
    )
    const astralFluxStacks = readNumericGodState(ctx.attacker.godState, [
      'NutAstralFluxStacks',
      'AstralFluxStacks',
      'AstralFlux',
      'NutPassiveStacks',
    ])

    ctx.state.attackerBuffs.delete('Nut.A01.active')
    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A01', label: 'Convergence' })
    applyOrRefreshBuff(ctx.state, {
      key: 'Nut.A01.active',
      label: 'Convergence',
      expiresAt: ctx.state.t + 10,
      modifiers: {},
      stacksMax: shots,
      addStacks: shots,
    })
    ctx.state.cooldowns.actives['Nut.A01.sideBaseDamage'] = sideBase
    ctx.state.cooldowns.actives['Nut.A01.sideStrengthScaling'] = sideStrScaling
    ctx.state.cooldowns.actives['Nut.A01.sideIntScaling'] = sideIntScaling
    ctx.state.cooldowns.actives['Nut.A01.sideProjectileCount'] = 2
    if (astralFluxStacks >= 4 && protDebuffPct > 0) {
      ctx.state.cooldowns.actives['Nut.A01.protDebuffPct'] = protDebuffPct
      ctx.attacker.godState.NutAstralFluxStacks = astralFluxStacks - 4
    } else {
      delete ctx.state.cooldowns.actives['Nut.A01.protDebuffPct']
    }

    setAbilityCooldown(ctx, 'A01', abilityRowAt(ctx.attacker.god, 'A01', 'Cooldown', rank) ?? 12)
    return true
  },
  A02: undefined,
  A03: undefined,
  A04: undefined,
}

const NuWaHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A02: (ctx, rank) => {
    const created = Math.max(1, Math.floor(abilityRowAt(ctx.attacker.god, 'A02', 'SoldiersCreated', rank) ?? 2))
    const dashBase = abilityRowAt(ctx.attacker.god, 'A02', 'Minion Dash Damage', rank) ?? 0
    const dashScaling = abilityRowAt(ctx.attacker.god, 'A02', 'Minion Dash Scaling', rank) ?? 0
    const flatPen = abilityRowAt(ctx.attacker.god, 'A02', 'Flat Pen Buff', rank) ?? 0
    const buffDuration = abilityRowAt(ctx.attacker.god, 'A02', 'Buff Duration', rank) ?? 0
    if (dashBase <= 0 && dashScaling <= 0 && flatPen <= 0) return false

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A02', label: 'Clay Soldiers' })
    if (flatPen > 0 && buffDuration > 0) {
      applyOrRefreshBuff(ctx.state, {
        key: 'Nu_Wa.A02.flatPen',
        label: 'Strength of Earth',
        expiresAt: ctx.state.t + buffDuration,
        modifiers: { MagicalPenetrationFlat: flatPen },
      })
    }

    if (dashBase > 0 || dashScaling > 0) {
      const savedT = ctx.state.t
      let procsApplied = false
      for (let i = 1; i <= created; i++) {
        ctx.state.t = savedT + i * 0.1
        const pre = dashBase + ctx.currentAdaptiveIntelligence() * dashScaling
        ctx.emitDamage(ctx, 'magical', pre, `Clay Soldiers (dash ${i}/${created})`, 'ability')
        if (!procsApplied) {
          ctx.applyAbilityHitItemProcs(ctx)
          procsApplied = true
        }
        ctx.applyRepeatableAbilityHitItemProcs(ctx)
      }
      ctx.state.t = savedT
    }

    setAbilityCooldown(ctx, 'A02', abilityRowAt(ctx.attacker.god, 'A02', 'Cooldown', rank) ?? 14)
    return true
  },
  A04: (ctx, rank) => {
    const base = abilityRowAt(ctx.attacker.god, 'A04', 'Base Damage', rank) ?? 0
    const intScaling = abilityRowAt(ctx.attacker.god, 'A04', 'Int Scaling', rank) ?? 0
    if (base <= 0 && intScaling <= 0) return false

    ctx.state.events.push({ kind: 'ability-cast', t: ctx.state.t, slot: 'A04', label: 'Fire Shards' })
    ctx.emitDamage(ctx, 'magical', base + ctx.currentAdaptiveIntelligence() * intScaling, 'Fire Shards', 'ability')
    ctx.applyAbilityHitItemProcs(ctx)
    ctx.applyRepeatableAbilityHitItemProcs(ctx)
    setAbilityCooldown(ctx, 'A04', abilityRowAt(ctx.attacker.god, 'A04', 'Cooldown', rank) ?? 90)
    return true
  },
  A01: undefined,
  A03: undefined,
}

const RatatoskrHandlers: Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined> = {
  A01: undefined,
  A02: undefined,
  A03: (ctx, rank) => {
    const thistlethorn = equippedRatAcorn(ctx, 'A03')
    const thistlethornEquipped = thistlethorn?.internalKey === 'acorn.Ratatoskr.T3.Thistlethorn'
    const aspectThistlethorn = thistlethornEquipped && hasActiveAspect(ctx)

    const baseDamage = aspectThistlethorn
      ? (abilityRowAt(ctx.attacker.god, 'A03', 'TalentAcorn3cDamage', rank) ?? 0)
      : (abilityRowAt(ctx.attacker.god, 'A03', 'Damage', rank) ?? 0)
    const strScaling = aspectThistlethorn
      ? (abilityRowAt(ctx.attacker.god, 'A03', 'TalentAcorn3cSTRScaling', rank) ?? 0)
      : (abilityRowAt(ctx.attacker.god, 'A03', 'STRScaling', rank) ?? 0)
    if (baseDamage <= 0) return false

    const defaultHits = aspectThistlethorn ? 5 : 3
    const actualHits = resolveHits(ctx, 'A03', defaultHits)
    const reductionPerExtraHit = abilityRowAt(ctx.attacker.god, 'A03', 'DamageRedMulti', rank) ?? 0.4
    const savedT = ctx.state.t
    let firstHit = true

    ctx.state.events.push({
      kind: 'ability-cast',
      t: ctx.state.t,
      slot: 'A03',
      label: aspectThistlethorn ? 'Acorn Blast (aspect)' : 'Acorn Blast',
    })

    for (let hitIndex = 0; hitIndex < actualHits; hitIndex++) {
      const multiplier = thistlethornEquipped
        ? 1
        : Math.max(0.2, 1 - reductionPerExtraHit * hitIndex)
      const preMitigation =
        (baseDamage + ctx.currentAdaptiveStrength() * strScaling) * multiplier
      ctx.emitDamage(
        ctx,
        'physical',
        preMitigation,
        `Acorn Blast (hit ${hitIndex + 1}/${actualHits})`,
        'ability',
      )
      if (firstHit) {
        ctx.applyAbilityHitItemProcs(ctx)
        firstHit = false
      }
      ctx.applyRepeatableAbilityHitItemProcs(ctx)

      if (aspectThistlethorn) {
        const debuffDuration = abilityRowAt(ctx.attacker.god, 'A03', 'TalentAcorn3cDebuffDuration', rank) ?? 0
        const vulnerability = (abilityRowAt(ctx.attacker.god, 'A03', 'TalentAcorn3cDebuffMulti', rank) ?? 0) * 100
        if (debuffDuration > 0 && vulnerability > 0) {
          applyOrRefreshDebuff(ctx.state, {
            key: 'Ratatoskr.A03.ThistlethornAspect',
            label: 'Thistlethorn vulnerability',
            expiresAt: ctx.state.t + debuffDuration,
            modifiers: { DamageTakenFromSourcePercent: vulnerability },
            stacksMax: 3,
            addStacks: 1,
          })
        }
      }
    }

    if (thistlethornEquipped) {
      const explosionBase = aspectThistlethorn
        ? (abilityRowAt(ctx.attacker.god, 'A03', 'TalentAcorn3cAOEDamage', rank) ?? 0)
        : baseDamage
      const explosionScaling = aspectThistlethorn
        ? (abilityRowAt(ctx.attacker.god, 'A03', 'TalentAcorn3cAOESTRScaling', rank) ?? 0)
        : strScaling
      const explosionDelay = (abilityRowAt(ctx.attacker.god, 'A03', 'TalentAcorn3cExplodeTime', rank) ?? 0) || 0.8
      if (explosionBase > 0) {
        ctx.state.t = savedT + explosionDelay
        for (let hitIndex = 0; hitIndex < actualHits; hitIndex++) {
          const explosionPre =
            explosionBase + ctx.currentAdaptiveStrength() * explosionScaling
          ctx.emitDamage(
            ctx,
            'physical',
            explosionPre,
            `Acorn Blast explosion (${hitIndex + 1}/${actualHits})`,
            'ability',
          )
          ctx.applyRepeatableAbilityHitItemProcs(ctx)
        }
      }
      ctx.state.t = savedT
    }

    setAbilityCooldown(ctx, 'A03', abilityRowAt(ctx.attacker.god, 'A03', 'Cooldown', rank) ?? 12)
    return true
  },
  A04: undefined,
}

const GOD_HANDLERS: Record<string, Record<AbilitySlot, ((ctx: HandlerContext, rank: number) => boolean) | undefined>> = {
  Ares: AresHandlers,
  Amaterasu: AmaterasuHandlers,
  Anubis: AnubisHandlers,
  Achilles: AchillesHandlers,
  Anhur: AnhurHandlers,
  Bacchus: BacchusHandlers,
  Baron_Samedi: BaronHandlers,
  Cabrakan: CabrakanHandlers,
  Charon: CharonHandlers,
  Discordia: DiscordiaHandlers,
  Eset: EsetHandlers,
  Ishtar: IshtarHandlers,
  Loki: LokiHandlers,
  Fenrir: FenrirHandlers,
  Chaac: ChaacHandlers,
  Cupid: CupidHandlers,
  Gilgamesh: GilgameshHandlers,
  Pele: PeleHandlers,
  Xbalanque: XbalanqueHandlers,
  Susano: SusanoHandlers,
  Kali: KaliHandlers,
  Sol: SolHandlers,
  Tsukuyomi: TsukuyomiHandlers,
  Mordred: MordredHandlers,
  Odin: OdinHandlers,
  Merlin: MerlinHandlers,
  The_Morrigan: TheMorriganHandlers,
  Nut: NutHandlers,
  Nu_Wa: NuWaHandlers,
  Ratatoskr: RatatoskrHandlers,
}

export function getGodHandler(godName: string, slot: AbilitySlot): ((ctx: HandlerContext, rank: number) => boolean) | undefined {
  return GOD_HANDLERS[godName]?.[slot]
}
