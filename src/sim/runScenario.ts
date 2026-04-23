import { interp } from '../catalog/curve.ts'
import type { AbilitySlot, GodDef, ItemDef, StatTag } from '../catalog/types.ts'
import { applyDefense } from './formula.ts'
import type { BuildInput, DamageInstance, EnemyInput, Scenario, SimResult } from './types.ts'

function statAt(god: GodDef, tag: StatTag, level: number): number {
  const curve = god.statCurves[tag]
  if (!curve) return 0
  return interp(curve, level)
}

function sumItemStat(items: ItemDef[], tag: StatTag): number {
  let total = 0
  for (const it of items) total += it.flatStats[tag] ?? 0
  return total
}

function sumAdaptiveStrength(items: ItemDef[]): number {
  let s = 0
  for (const it of items) s += it.adaptiveStrength ?? 0
  return s
}

function sumAdaptiveIntelligence(items: ItemDef[]): number {
  let i = 0
  for (const it of items) i += it.adaptiveIntelligence ?? 0
  return i
}

function sumStackedStats(items: ItemDef[]): { str: number; int: number } {
  let str = 0
  let int = 0
  for (const it of items) {
    for (const fx of it.effects) {
      if (fx.kind === 'flatStackedPower') {
        str += (fx.perStackStrength ?? 0) * fx.maxStacks
        int += (fx.perStackIntelligence ?? 0) * fx.maxStacks
      }
    }
  }
  return { str, int }
}

function abilityRankValue(god: GodDef, slot: AbilitySlot, rank: number, row: string): number {
  const ability = god.abilities[slot]
  if (!ability) throw new Error(`No ability on ${slot} for ${god.id}`)
  const curve = ability.rankValues[row]
  if (!curve) throw new Error(`Missing row "${row}" on ${god.id}.${slot}`)
  return interp(curve, rank)
}

export interface AttackerStats {
  maxHealth: number
  maxMana: number
  manaPerTime: number
  healthPerTime: number
  physicalProtection: number
  magicalProtection: number
  moveSpeed: number
  baseAttackSpeed: number
  attackSpeedPercent: number
  totalAttackSpeed: number
  inhandPower: number
  adaptiveStrength: number
  adaptiveIntelligence: number
  penFlat: number
  penPercent: number
  cooldownReductionPercent: number
  strengthBuffsFromAbilities: number
  intelligenceBuffsFromAbilities: number
}

export function snapshotAttacker(b: BuildInput): AttackerStats {
  const baseHealth = statAt(b.god, 'MaxHealth', b.godLevel)
  const baseMana = statAt(b.god, 'MaxMana', b.godLevel)
  const baseManaPerTime = statAt(b.god, 'ManaPerTime', b.godLevel)
  const baseHealthPerTime = statAt(b.god, 'HealthPerTime', b.godLevel)
  const basePhysProt = statAt(b.god, 'PhysicalProtection', b.godLevel)
  const baseMagProt = statAt(b.god, 'MagicalProtection', b.godLevel)
  const baseMoveSpeed = statAt(b.god, 'MovementSpeed', b.godLevel)
  const baseAttackSpeed = statAt(b.god, 'BaseAttackSpeed', b.godLevel)
  const attackSpeedPct = statAt(b.god, 'AttackSpeedPercent', b.godLevel)

  const basePower = statAt(b.god, 'InhandPower', b.godLevel)
  const itemFlatPower = sumItemStat(b.items, 'InhandPower')
  const adaptiveStr = sumAdaptiveStrength(b.items)
  const adaptiveInt = sumAdaptiveIntelligence(b.items)
  const { str: stackedStr, int: stackedInt } = sumStackedStats(b.items)

  return {
    maxHealth: baseHealth + sumItemStat(b.items, 'MaxHealth'),
    maxMana: baseMana + sumItemStat(b.items, 'MaxMana'),
    manaPerTime: baseManaPerTime + sumItemStat(b.items, 'ManaPerTime'),
    healthPerTime: baseHealthPerTime + sumItemStat(b.items, 'HealthPerTime'),
    physicalProtection: basePhysProt + sumItemStat(b.items, 'PhysicalProtection'),
    magicalProtection: baseMagProt + sumItemStat(b.items, 'MagicalProtection'),
    // 1.18× is the universal "GE_IncreasedStartingMovementSpeed" modifier every
    // god carries. Confirmed via probe: the GE contains a float 18.0 which
    // resolves to +18% MS. Kali base 380 × 1.18 = 448.4, matches in-game.
    moveSpeed: (baseMoveSpeed + sumItemStat(b.items, 'MovementSpeed')) * 1.18,
    baseAttackSpeed,
    attackSpeedPercent: attackSpeedPct + sumItemStat(b.items, 'AttackSpeedPercent'),
    totalAttackSpeed: baseAttackSpeed * (1 + (attackSpeedPct + sumItemStat(b.items, 'AttackSpeedPercent')) / 100),
    inhandPower: basePower + itemFlatPower,
    adaptiveStrength: adaptiveStr + stackedStr,
    adaptiveIntelligence: adaptiveInt + stackedInt,
    penFlat: sumItemStat(b.items, 'PhysicalPenetrationFlat'),
    penPercent: sumItemStat(b.items, 'PhysicalPenetrationPercent'),
    cooldownReductionPercent: sumItemStat(b.items, 'CooldownReductionPercent'),
    strengthBuffsFromAbilities: 0,
    intelligenceBuffsFromAbilities: 0,
  }
}

export function snapshotDefender(e: EnemyInput) {
  return {
    physicalProtection: statAt(e.god, 'PhysicalProtection', e.godLevel),
    magicalProtection: statAt(e.god, 'MagicalProtection', e.godLevel),
    maxHealth: statAt(e.god, 'MaxHealth', e.godLevel) + (e.flatHealthBonus ?? 0),
  }
}

export interface RunOptions {
  penPercentOverride?: number
  kaliA01RuptureStacks?: 2 | 3
  bumbaPostAbilityStacks?: boolean
}

export function runScenario(scenario: Scenario, opts: RunOptions = {}): SimResult {
  const attacker = snapshotAttacker(scenario.attacker)
  const defender = snapshotDefender(scenario.defender)
  const assumptions: string[] = []

  const penPercent = opts.penPercentOverride ?? attacker.penPercent
  if (opts.penPercentOverride !== undefined) {
    assumptions.push(`penPercentOverride = ${opts.penPercentOverride}% (site-inferred)`)
  }

  const ruptureStacks = opts.kaliA01RuptureStacks ?? 3
  assumptions.push(`Kali A01 rupture stacks = ${ruptureStacks} (${ruptureStacks === 2 ? 'site hardcode' : 'tooltip'})`)

  const events: DamageInstance[] = []

  const a03StrBuff = scenario.attacker.god.abilities.A3
    ? abilityRankValue(scenario.attacker.god, 'A3', scenario.attacker.abilityRanks.A3, 'Strength Buff')
    : 0
  const a03IntBuff = scenario.attacker.god.abilities.A3
    ? abilityRankValue(scenario.attacker.god, 'A3', scenario.attacker.abilityRanks.A3, 'Intelligence Buff')
    : 0
  assumptions.push(
    `A03 rank ${scenario.attacker.abilityRanks.A3} interp → +${a03StrBuff} STR, +${a03IntBuff} INT (linear interp applied regardless of InterpMode)`,
  )

  let a03BuffActive = false
  let bumbaBasicsUsed = 0
  let pendingHydra = false
  let pendingPoly = false
  let pendingBumbaPost = 0

  const strengthTotal = () =>
    attacker.adaptiveStrength + (a03BuffActive ? a03StrBuff : 0)
  const intelligenceTotal = () =>
    attacker.adaptiveIntelligence + (a03BuffActive ? a03IntBuff : 0)
  const effectivePhysicalPower = () => attacker.inhandPower + strengthTotal()

  const physDefense = {
    targetProtection: defender.physicalProtection,
    penFlat: attacker.penFlat,
    penPercent,
  }

  function record(ev: DamageInstance) {
    events.push(ev)
  }

  for (const action of scenario.rotation) {
    if (action.kind === 'wait') continue

    if (action.kind === 'ability') {
      if (action.slot === 'A1') {
        // A1 Nimble Strike: just Base Damage + Strength × Strength Scaling.
        // No rupture multiplier — rupture is Kali's PASSIVE (see
        // GE_Kali_Talent_Damage with rows RuptureProcDamageBase/PerLevel).
        // Stacks are built by basic attacks and consumed separately; they
        // are not applied by A1 itself. Passive proc modeling pending.
        const base = abilityRankValue(
          scenario.attacker.god,
          'A1',
          scenario.attacker.abilityRanks.A1,
          'Base Damage',
        )
        const strScale = abilityRankValue(
          scenario.attacker.god,
          'A1',
          scenario.attacker.abilityRanks.A1,
          'Strength Scaling',
        )
        const pre = base + strengthTotal() * strScale
        const post = applyDefense(pre, physDefense)
        record({
          label: action.label ?? 'A1 Nimble Strike',
          source: 'ability',
          damageType: 'physical',
          preMitigation: pre,
          postMitigation: post,
          notes: [`${base} + ${strengthTotal()} × ${strScale}`],
        })
        pendingHydra = true
        pendingPoly = true
        pendingBumbaPost = opts.bumbaPostAbilityStacks
          ? pendingBumbaPost + 10
          : 10
      } else if (action.slot === 'A2') {
        const base = abilityRankValue(scenario.attacker.god, 'A2', scenario.attacker.abilityRanks.A2, 'Base Damage')
        const strScale = abilityRankValue(scenario.attacker.god, 'A2', scenario.attacker.abilityRanks.A2, 'Scaling')
        const intScale = abilityRankValue(scenario.attacker.god, 'A2', scenario.attacker.abilityRanks.A2, 'Int Scaling')
        const preImpact = base + strengthTotal() * strScale + intelligenceTotal() * intScale
        const postImpact = applyDefense(preImpact, physDefense)
        record({
          label: action.label ?? 'A2 Lash (impact)',
          source: 'ability',
          damageType: 'physical',
          preMitigation: preImpact,
          postMitigation: postImpact,
          notes: [`${base} + ${strengthTotal()} × ${strScale} + ${intelligenceTotal()} × ${intScale}`],
        })

        const bleedBase = abilityRankValue(scenario.attacker.god, 'A2', scenario.attacker.abilityRanks.A2, 'Bleed Damage')
        const bleedStr = abilityRankValue(scenario.attacker.god, 'A2', scenario.attacker.abilityRanks.A2, 'Bleed Str Scaling')
        const bleedInt = abilityRankValue(scenario.attacker.god, 'A2', scenario.attacker.abilityRanks.A2, 'Bleed Int Scaling')
        const bleedPerTick = bleedBase + strengthTotal() * bleedStr + intelligenceTotal() * bleedInt
        const BLEED_TICKS = 5 // Confirmed by audio files Kali_A02_Bleed_Hit_01..05 and GA_Kali_A02 int values
        for (let tick = 1; tick <= BLEED_TICKS; tick++) {
          const postBleed = applyDefense(bleedPerTick, physDefense)
          record({
            label: `A2 Lash (bleed tick ${tick}/${BLEED_TICKS})`,
            source: 'ability',
            damageType: 'physical',
            preMitigation: bleedPerTick,
            postMitigation: postBleed,
            notes: tick === 1
              ? [`${bleedBase} + ${strengthTotal()} × ${bleedStr} + ${intelligenceTotal()} × ${bleedInt} per tick`]
              : undefined,
          })
        }

        pendingHydra = true
        pendingPoly = true
        pendingBumbaPost = opts.bumbaPostAbilityStacks
          ? pendingBumbaPost + 10
          : 10
      } else if (action.slot === 'A3') {
        // GE_Kali_A03_Damage references only Effect.Config.BaseDamage — no
        // power-scaling tags. The Base Str/Int Scaling curves in the
        // EffectValues table appear to feed the PASSIVE proc damage
        // (GE_Kali_A03_Damage_Talent), not the direct cast.
        const base = abilityRankValue(scenario.attacker.god, 'A3', scenario.attacker.abilityRanks.A3, 'Base Damage')
        const pre = base
        const post = applyDefense(pre, physDefense)
        record({
          label: action.label ?? 'A3 Tormented Strike',
          source: 'ability',
          damageType: 'physical',
          preMitigation: pre,
          postMitigation: post,
          notes: [`${base} (no power scaling on direct cast)`],
        })
        a03BuffActive = true
        pendingHydra = true
        pendingPoly = true
        pendingBumbaPost = opts.bumbaPostAbilityStacks
          ? pendingBumbaPost + 10
          : 10
      }
      continue
    }

    if (action.kind === 'basic') {
      const chain = scenario.attacker.god.basicChain
      const step = events.filter((e) => e.source === 'basic').length % chain.length
      const basicMultiplier = chain[step]
      const pre = effectivePhysicalPower() * basicMultiplier
      const post = applyDefense(pre, physDefense)
      record({
        label: action.label ?? `Basic (chain step ${step + 1})`,
        source: 'basic',
        damageType: 'physical',
        preMitigation: pre,
        postMitigation: post,
        notes: [`${effectivePhysicalPower().toFixed(2)} × ${basicMultiplier}`],
      })

      if (pendingHydra) {
        const hydra = scenario.attacker.items.find((it) =>
          it.effects.some((fx) => fx.kind === 'onAbilityHit_nextBasic' && fx.damageType === 'physical'),
        )
        if (hydra) {
          const fx = hydra.effects.find(
            (e) => e.kind === 'onAbilityHit_nextBasic' && e.damageType === 'physical',
          )
          if (fx && fx.kind === 'onAbilityHit_nextBasic') {
            const pre2 = effectivePhysicalPower() * fx.powerMultiplier
            const post2 = applyDefense(pre2, physDefense)
            record({
              label: `Hydra rider (after ${action.label ?? 'basic'})`,
              source: 'item-postability',
              damageType: 'physical',
              preMitigation: pre2,
              postMitigation: post2,
            })
          }
          pendingHydra = false
        } else {
          pendingHydra = false
        }
      }

      if (bumbaBasicsUsed < 3) {
        const bumba = scenario.attacker.items.find((it) =>
          it.effects.some((fx) => fx.kind === 'onBasicHit_trueDamage'),
        )
        if (bumba) {
          const fx = bumba.effects.find((e) => e.kind === 'onBasicHit_trueDamage')
          if (fx && fx.kind === 'onBasicHit_trueDamage') {
            record({
              label: 'Bumba true (per-basic)',
              source: 'item-perbasic',
              damageType: 'true',
              preMitigation: fx.perHit,
              postMitigation: fx.perHit,
            })
          }
        }
        bumbaBasicsUsed += 1
      }

      if (pendingBumbaPost > 0) {
        record({
          label: 'Bumba post-ability true',
          source: 'item-postability',
          damageType: 'true',
          preMitigation: pendingBumbaPost,
          postMitigation: pendingBumbaPost,
          notes: [opts.bumbaPostAbilityStacks ? 'stacks across ability casts (toggle on)' : 'single +10 (toggle off)'],
        })
        pendingBumbaPost = 0
      }

      pendingPoly = false
    }
  }

  const totals = { physical: 0, magical: 0, true: 0, total: 0 }
  for (const ev of events) {
    totals[ev.damageType] += ev.postMitigation
    totals.total += ev.postMitigation
  }

  const byLabelMap = new Map<string, number>()
  for (const ev of events) {
    byLabelMap.set(ev.label, (byLabelMap.get(ev.label) ?? 0) + ev.postMitigation)
  }
  const byLabel = [...byLabelMap.entries()].map(([label, total]) => ({ label, total }))

  void pendingPoly

  return {
    scenarioTitle: scenario.title,
    attackerSnapshot: {
      MaxHealth: attacker.maxHealth,
      MaxMana: attacker.maxMana,
      HealthPerTime: attacker.healthPerTime,
      ManaPerTime: attacker.manaPerTime,
      PhysicalProtection: attacker.physicalProtection,
      MagicalProtection: attacker.magicalProtection,
      MovementSpeed: attacker.moveSpeed,
      BaseAttackSpeed: attacker.baseAttackSpeed,
      AttackSpeedPercent: attacker.attackSpeedPercent,
      TotalAttackSpeed: attacker.totalAttackSpeed,
      InhandPower: attacker.inhandPower,
      Strength: attacker.adaptiveStrength,
      Intelligence: attacker.adaptiveIntelligence,
      CooldownReductionPercent: attacker.cooldownReductionPercent,
      PhysicalPenetrationFlat: attacker.penFlat,
      PhysicalPenetrationPercent: penPercent,
    },
    defenderSnapshot: defender,
    events,
    totals,
    byLabel,
    assumptions,
  }
}
