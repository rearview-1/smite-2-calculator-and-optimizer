#!/usr/bin/env tsx

import { getItem } from '../src/catalog/loadCatalogs.ts'
import { resolveItemStatsWithOverrides } from '../src/catalog/loadCatalogs.ts'
import { getFinalBuildItemExclusionReason } from '../src/catalog/itemEligibility.ts'
import { itemMatchesStrictOffensePreset } from '../src/catalog/itemPool.ts'
import { optimize } from '../src/optimizer/optimize.ts'
import { getItemProcs } from '../src/sim/v3/itemEffects.ts'
import {
  runScenario,
  snapshotAttacker,
  maxStackCountFor,
  shouldAutoEvolveStackingItem,
} from '../src/sim/v3/engine.ts'
import type { Scenario } from '../src/sim/v3/types.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function close(actual: number, expected: number, tolerance = 0.01): boolean {
  return Math.abs(actual - expected) <= tolerance
}

const ranks = { A01: 5, A02: 5, A03: 5, A04: 5 }
const baseScenario = (items: string[], rotation: Scenario['rotation']): Scenario => ({
  title: 'regression',
  attacker: { godId: 'Loki', level: 20, abilityRanks: ranks, items },
  defender: { godId: 'Kukulkan', level: 20 },
  rotation,
})

;{
  const charonSurge = runScenario({
    title: 'charon spectral surge regression',
    attacker: {
      godId: 'Charon',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A01', label: 'Spectral Surge' }],
  })
  const charonSurgeHits = charonSurge.damageEvents.filter((ev) => ev.label.startsWith('Spectral Surge'))
  assert(charonSurgeHits.length === 2, `Charon A01 should emit the direct hit and the explosion, got ${charonSurgeHits.length}`)
  assert(close(charonSurgeHits[0]?.preMitigation ?? 0, 200, 0.001) && close(charonSurgeHits[1]?.preMitigation ?? 0, 200, 0.001),
    `Charon A01 rank 5 naked hit and explosion should each be 200 pre-mit, got ${charonSurgeHits.map((ev) => ev.preMitigation).join(', ')}`)
  assert(charonSurgeHits.some((ev) => ev.label === 'Spectral Surge (explosion)'), 'Charon A01 should label the second hit as Spectral Surge (explosion)')
  assert(charonSurge.events.some((ev) => ev.kind === 'buff-apply' && ev.label === 'Spectral Surge silence'), 'Charon A01 should apply its silence debuff')
  assert(charonSurge.events.some((ev) => ev.kind === 'buff-apply' && ev.label === 'Spectral Surge trail'), 'Charon A01 should apply its trail status')
}

;{
  const discordiaOrb = runScenario({
    title: 'discordia unruly magic regression',
    attacker: {
      godId: 'Discordia',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A01', label: 'Unruly Magic' }],
  })
  const discordiaOrbHits = discordiaOrb.damageEvents.filter((ev) => ev.label.startsWith('Unruly Magic'))
  assert(discordiaOrbHits.length === 2, `Discordia A01 should only deal projectile + area damage to the same target, got ${discordiaOrbHits.length}`)
  assert(discordiaOrbHits.some((ev) => ev.label === 'Unruly Magic (area)'), 'Discordia A01 should emit its area explosion')
  assert(!discordiaOrbHits.some((ev) => ev.label === 'Unruly Magic (small)'), 'Discordia A01 should not also hit the same area-damaged target with a minor projectile')

  const discordiaApple = runScenario({
    title: 'discordia golden apple regression',
    attacker: {
      godId: 'Discordia',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A04', label: 'Golden Apple of Discord' }],
  })
  const discordiaAppleInitial = discordiaApple.damageEvents.find((ev) => ev.label === 'Golden Apple of Discord')
  const discordiaAppleBurst = discordiaApple.damageEvents.find((ev) => ev.label === 'Golden Apple of Discord (burst)')
  assert(close(discordiaAppleInitial?.preMitigation ?? 0, 225, 0.001), `Discordia A04 initial hit should be 225 pre-mit at rank 5, got ${discordiaAppleInitial?.preMitigation ?? 0}`)
  assert(close(discordiaAppleBurst?.preMitigation ?? 0, 400, 0.001), `Discordia A04 burst should be 400 pre-mit at rank 5, got ${discordiaAppleBurst?.preMitigation ?? 0}`)
  assert(close((discordiaAppleBurst?.t ?? 0) - (discordiaAppleInitial?.t ?? 0), 2, 0.001), `Discordia A04 burst should occur after local DebuffDuration, got ${(discordiaAppleBurst?.t ?? 0) - (discordiaAppleInitial?.t ?? 0)}`)
  assert(discordiaApple.events.some((ev) => ev.kind === 'buff-apply' && ev.label === 'Golden Apple of Discord affliction'), 'Discordia A04 should apply its apple affliction state')
}

;{
  const anubisLocusts = runScenario({
    title: 'anubis plague of locusts regression',
    attacker: {
      godId: 'Anubis',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A01', label: 'Plague Of Locusts' }],
  })
  const anubisLocustHits = anubisLocusts.damageEvents.filter((ev) => ev.label.startsWith('Plague Of Locusts (hit '))
  assert(anubisLocustHits.length === 12, `Anubis A01 should tick 12 times from local 3s / 0.25s rows, got ${anubisLocustHits.length}`)
  assert(anubisLocustHits.every((ev) => close(ev.preMitigation, 43, 0.001)), `Anubis A01 rank 5 naked ticks should each be 43 pre-mit, got ${anubisLocustHits.map((ev) => ev.preMitigation).join(', ')}`)
  assert(close(anubisLocustHits[1].t - anubisLocustHits[0].t, 0.25, 0.001), `Anubis A01 should space ticks by 0.25s, got ${anubisLocustHits[1].t - anubisLocustHits[0].t}`)

  const anubisMummify = runScenario({
    title: 'anubis mummify regression',
    attacker: {
      godId: 'Anubis',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A02', label: 'Mummify' }],
  })
  const anubisMummifyHit = anubisMummify.damageEvents.find((ev) => ev.label === 'Mummify')
  assert(close(anubisMummifyHit?.preMitigation ?? 0, 160, 0.001), `Anubis A02 rank 5 should deal 160 pre-mit naked, got ${anubisMummifyHit?.preMitigation ?? 0}`)
  assert(anubisMummify.events.some((ev) => ev.kind === 'buff-apply' && ev.label === 'Mummify stun'), 'Anubis A02 should apply its stun debuff')

  const anubisHands = runScenario({
    title: 'anubis grasping hands regression',
    attacker: {
      godId: 'Anubis',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A03', label: 'Grasping Hands' }],
  })
  const anubisHandsHits = anubisHands.damageEvents.filter((ev) => ev.label.startsWith('Grasping Hands (hit '))
  assert(anubisHandsHits.length === 5, `Anubis A03 should emit 5 repeated hits over its 2s slow window using local channel timing, got ${anubisHandsHits.length}`)
  assert(anubisHandsHits.every((ev) => close(ev.preMitigation, 105, 0.001)), `Anubis A03 rank 5 naked hits should each be 105 pre-mit, got ${anubisHandsHits.map((ev) => ev.preMitigation).join(', ')}`)
  assert(anubisHands.events.some((ev) => ev.kind === 'buff-apply' && ev.label === 'Grasping Hands slow'), 'Anubis A03 should apply its slow debuff')

  const anubisGaze = runScenario({
    title: 'anubis death gaze regression',
    attacker: {
      godId: 'Anubis',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A04', label: 'Death Gaze' }],
  })
  const anubisGazeInitial = anubisGaze.damageEvents.find((ev) => ev.label === 'Death Gaze (initial)')
  const anubisGazeTicks = anubisGaze.damageEvents.filter((ev) => ev.label.startsWith('Death Gaze (tick '))
  assert(close(anubisGazeInitial?.preMitigation ?? 0, 260, 0.001), `Anubis A04 initial burst should be 260 pre-mit naked at rank 5, got ${anubisGazeInitial?.preMitigation ?? 0}`)
  assert(anubisGazeTicks.length === 8, `Anubis A04 should emit 8 repeated ticks across its 3s duration using local channel timing, got ${anubisGazeTicks.length}`)
  assert(anubisGazeTicks.every((ev) => close(ev.preMitigation, 47, 0.001)), `Anubis A04 rank 5 naked ticks should each be 47 pre-mit, got ${anubisGazeTicks.map((ev) => ev.preMitigation).join(', ')}`)
}

;{
  const aresUlt = runScenario({
    title: 'ares no escape regression',
    attacker: {
      godId: 'Ares',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A04', label: 'No Escape' }],
  })
  const aresInitial = aresUlt.damageEvents.find((ev) => ev.label === 'No Escape (initial)')
  const aresStun = aresUlt.damageEvents.find((ev) => ev.label === 'No Escape (stun)')
  assert(close(aresInitial?.preMitigation ?? 0, 200, 0.001), `Ares A04 initial attach should be 200 pre-mit at rank 5, got ${aresInitial?.preMitigation ?? 0}`)
  assert(close(aresStun?.preMitigation ?? 0, 550, 0.001), `Ares A04 final stun damage should be 550 pre-mit at rank 5, got ${aresStun?.preMitigation ?? 0}`)
  assert(close((aresStun?.t ?? 0) - (aresInitial?.t ?? 0), 2.17, 0.001), `Ares A04 final stun hit should land after 2.17s, got ${(aresStun?.t ?? 0) - (aresInitial?.t ?? 0)}`)

  const hadesUlt = runScenario({
    title: 'hades pillar of agony regression',
    attacker: {
      godId: 'Hades',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A04', label: 'Pillar Of Agony' }],
  })
  const hadesTicks = hadesUlt.damageEvents.filter((ev) => ev.label.startsWith('Pillar Of Agony (DoT) (tick '))
  assert(hadesTicks.length === 8, `Hades A04 should hit 8 times over 4 seconds, got ${hadesTicks.length}`)
  assert(close(hadesTicks[0]?.t ?? 0, 0.5, 0.001) && close(hadesTicks.at(-1)?.t ?? 0, 4.0, 0.001),
    `Hades A04 should tick from 0.5s to 4.0s, got ${hadesTicks[0]?.t ?? 0}..${hadesTicks.at(-1)?.t ?? 0}`)

  const khepriSun = runScenario({
    title: 'khepri rising dawn regression',
    attacker: {
      godId: 'Khepri',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A02', label: 'Rising Dawn' }],
  })
  const khepriTicks = khepriSun.damageEvents.filter((ev) => ev.label.startsWith('Rising Dawn (DoT) (tick '))
  assert(khepriTicks.length === 11, `Khepri A02 should hit 11 times, got ${khepriTicks.length}`)
  assert(close(khepriTicks[0]?.t ?? 0, 0, 0.001) && close(khepriTicks.at(-1)?.t ?? 0, 3.0, 0.001),
    `Khepri A02 should tick from 0.0s to 3.0s, got ${khepriTicks[0]?.t ?? 0}..${khepriTicks.at(-1)?.t ?? 0}`)

  const kukuWhirlwind = runScenario({
    title: 'kukulkan whirlwind regression',
    attacker: {
      godId: 'Kukulkan',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A03', label: 'Whirlwind' }],
  })
  const kukuTicks = kukuWhirlwind.damageEvents.filter((ev) => ev.label.startsWith('Whirlwind (DoT) (tick '))
  assert(kukuTicks.length === 6, `Kukulkan A03 should hit 6 times, got ${kukuTicks.length}`)
  assert(close(kukuTicks[0]?.t ?? 0, 0, 0.001) && close(kukuTicks.at(-1)?.t ?? 0, 2.5, 0.001),
    `Kukulkan A03 should tick from 0.0s to 2.5s, got ${kukuTicks[0]?.t ?? 0}..${kukuTicks.at(-1)?.t ?? 0}`)

  const susanoTyphoon = runScenario({
    title: 'susano typhoon regression',
    attacker: {
      godId: 'Susano',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A04', label: 'Typhoon' }],
  })
  const susanoTyphoonTicks = susanoTyphoon.damageEvents.filter((ev) => ev.label.startsWith('Typhoon (tick '))
  const susanoTyphoonLaunch = susanoTyphoon.damageEvents.find((ev) => ev.label === 'Typhoon (launch)')
  assert(susanoTyphoonTicks.length === 5, `Susano A04 should tick 5 times across its 2s grow window, got ${susanoTyphoonTicks.length}`)
  assert(close(susanoTyphoonLaunch?.t ?? 0, 2.0, 0.001), `Susano A04 launch should occur at 2.0s, got ${susanoTyphoonLaunch?.t ?? 0}`)
}

;{
  const amaReflection = runScenario({
    title: 'amaterasu reflection regression',
    attacker: {
      godId: 'Amaterasu',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A02', label: 'Heavenly Reflection' }],
  })
  const amaReflectionHit = amaReflection.damageEvents.find((ev) => ev.label === 'Heavenly Reflection')
  assert(close(amaReflectionHit?.preMitigation ?? 0, 240, 0.001), `Amaterasu A02 rank 5 should deal 240 pre-mit naked on immediate refire, got ${amaReflectionHit?.preMitigation ?? 0}`)

  const amaCharge = runScenario({
    title: 'amaterasu charge regression',
    attacker: {
      godId: 'Amaterasu',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A03', label: 'Glorious Charge' }],
  })
  const amaChargeHit = amaCharge.damageEvents.find((ev) => ev.label === 'Glorious Charge')
  assert(close(amaChargeHit?.preMitigation ?? 0, 300, 0.001), `Amaterasu A03 rank 5 should deal 300 pre-mit naked, got ${amaChargeHit?.preMitigation ?? 0}`)
  assert(amaCharge.events.some((ev) => ev.kind === 'buff-apply' && ev.label === 'Glorious Charge silence'), 'Amaterasu A03 should apply its silence debuff')

  const baronGaze = runScenario({
    title: 'baron vivid gaze regression',
    attacker: {
      godId: 'Baron_Samedi',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A01', label: 'Vivid Gaze' }],
  })
  const baronGazeHits = baronGaze.damageEvents.filter((ev) => ev.label.startsWith('Vivid Gaze'))
  assert(baronGazeHits.length === 2, `Baron A01 should emit base + overlap damage, got ${baronGazeHits.map((ev) => ev.label).join(', ')}`)
  assert(close(baronGazeHits[0].preMitigation, 290, 0.001), `Baron A01 base hit should be 290 pre-mit naked, got ${baronGazeHits[0]?.preMitigation}`)
  assert(close(baronGazeHits[1].preMitigation, 101.5, 0.001), `Baron A01 overlap hit should be 35% of the base hit, got ${baronGazeHits[1]?.preMitigation}`)

  const baronSpirits = runScenario({
    title: 'baron consign spirits regression',
    attacker: {
      godId: 'Baron_Samedi',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A02', label: 'Consign Spirits' }],
  })
  const baronSpiritsHit = baronSpirits.damageEvents.find((ev) => ev.label === 'Consign Spirits')
  assert(close(baronSpiritsHit?.preMitigation ?? 0, 305, 0.001), `Baron A02 should deal 305 pre-mit naked at rank 5, got ${baronSpiritsHit?.preMitigation ?? 0}`)

  const baronSnake = runScenario({
    title: 'baron wrap it up regression',
    attacker: {
      godId: 'Baron_Samedi',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A03', label: 'Wrap It Up' }],
  })
  const baronSnakeTicks = baronSnake.damageEvents.filter((ev) => ev.label.startsWith('Wrap It Up (tick '))
  assert(baronSnakeTicks.length === 7, `Baron A03 should tick across the 1.75s constrict duration, got ${baronSnakeTicks.length}`)
  assert(baronSnake.events.some((ev) => ev.kind === 'buff-apply' && ev.label === 'Wrap It Up constrict'), 'Baron A03 should apply its constrict debuff')

  const baronUlt = runScenario({
    title: 'baron life of the party regression',
    attacker: {
      godId: 'Baron_Samedi',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A04', label: 'Life of the Party' }],
  })
  const baronUltVortex = baronUlt.damageEvents.filter((ev) => ev.label.startsWith('Life of the Party (vortex '))
  const baronUltSlam = baronUlt.damageEvents.find((ev) => ev.label === 'Life of the Party (slam)')
  assert(baronUltVortex.length === 2, `Baron A04 should tick every 0.5s through its local 1.0s loop window, got ${baronUltVortex.length}`)
  assert(baronUltSlam != null, 'Baron A04 should resolve its coffin slam hit')
  assert(baronUlt.events.some((ev) => ev.kind === 'buff-apply' && ev.label === 'Life of the Party stun'), 'Baron A04 should apply its stun on the slam')

  const ishtarImbue = runScenario({
    title: 'ishtar imbue arrows regression',
    attacker: {
      godId: 'Ishtar',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [
      { kind: 'basic', label: 'AA1' },
      { kind: 'ability', slot: 'A01', label: 'Imbue Arrows' },
      { kind: 'basic', label: 'AA2' },
    ],
  })
  const ishtarImbueHit = ishtarImbue.damageEvents.find((ev) => ev.label.startsWith('Imbue Arrows (Strike Shot)'))
  assert(close(ishtarImbueHit?.preMitigation ?? 0, 5, 0.001), `Ishtar A01 default follow-up should emit its local 5-damage strike-shot bonus, got ${ishtarImbueHit?.preMitigation ?? 0}`)
}

;{
  const achillesShield = runScenario({
    title: 'achilles shield regression',
    attacker: {
      godId: 'Achilles',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A01', label: 'Shield of Achilles' }],
  })
  const achillesHits = achillesShield.damageEvents.filter((ev) => ev.label.startsWith('Shield of Achilles'))
  assert(achillesHits.length === 2, `Achilles A01 should emit shield + radiated force, got ${achillesHits.map((ev) => ev.label).join(', ')}`)
  assert(close(achillesHits[0].preMitigation, 320, 0.001), `Achilles A01 primary hit should be 320 pre-mit at rank 5, got ${achillesHits[0]?.preMitigation}`)
  assert(close(achillesHits[1].preMitigation, 256, 0.001), `Achilles A01 radiated force should use Far Away Multiplier, got ${achillesHits[1]?.preMitigation}`)

  const pelePyro = runScenario({
    title: 'pele pyroclast regression',
    attacker: {
      godId: 'Pele',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A01', label: 'Pyroclast' }],
  })
  const pelePyroReturns = pelePyro.damageEvents.filter((ev) => ev.label.startsWith('Pyroclast (return '))
  assert(pelePyroReturns.length === 5, `Pele A01 rank 5 should return 5 shards, got ${pelePyroReturns.length}`)
  assert(pelePyroReturns.every((ev) => close(ev.preMitigation, 25, 0.001)), `Pele A01 return shard damage should be 25 pre-mit naked, got ${pelePyroReturns.map((ev) => ev.preMitigation).join(', ')}`)

  const peleEruption = runScenario({
    title: 'pele eruption regression',
    attacker: {
      godId: 'Pele',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A02', label: 'Eruption' }],
  })
  const peleOuterHits = peleEruption.damageEvents.filter((ev) => ev.label.startsWith('Eruption (outer '))
  assert(peleOuterHits.length === 3, `Pele A02 rank 5 should emit 3 outer explosions, got ${peleOuterHits.length}`)

  const peleUlt = runScenario({
    title: 'pele volcanic lightning regression',
    attacker: {
      godId: 'Pele',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [
      { kind: 'ability', slot: 'A04', label: 'Volcanic Lightning' },
      { kind: 'basic', label: 'AA1' },
      { kind: 'basic', label: 'AA2' },
    ],
  })
  const peleFollowupCones = peleUlt.damageEvents.filter((ev) => ev.label.startsWith('Volcanic Lightning (follow-up cone)'))
  assert(peleFollowupCones.length === 2, `Pele A04 should fire follow-up cone damage on each basic while buffed, got ${peleFollowupCones.length}`)

  const susanoScenario = (rotation: Scenario['rotation']): Scenario => ({
    title: 'susano storm kata regression',
    attacker: { godId: 'Susano', level: 20, abilityRanks: ranks, items: [] },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation,
  })
  const staged = runScenario(susanoScenario([
    { kind: 'ability', slot: 'A01', cancel: true },
    { kind: 'basic' },
    { kind: 'ability', slot: 'A01', cancel: true },
    { kind: 'basic' },
    { kind: 'ability', slot: 'A01', cancel: true },
    { kind: 'basic' },
  ]))
  const susanoAbilityHits = staged.damageEvents.filter((ev) => ev.source === 'ability').map((ev) => ev.label)
  assert(
    susanoAbilityHits.join('|') === 'Storm Kata (cone)|Storm Kata (whirlwind)|Storm Kata (dash)',
    `Susano A01 cancel path should preserve staged damage, got ${susanoAbilityHits.join(', ')}`,
  )
  assert(staged.comboExecutionTime < 2, `Susano staged cancels should not wait for full cooldowns between recasts, got ${staged.comboExecutionTime}`)
}

;{
  const bare = snapshotAttacker(baseScenario([], [])) as { inhandPower: number; adaptiveStrength: number }
  const sun = snapshotAttacker(baseScenario(['Sun Beam Bow'], [])) as { inhandPower: number; adaptiveStrength: number }
  assert(close(sun.inhandPower - bare.inhandPower, 10), `Sun Beam Bow InhandPower should add 10, got ${sun.inhandPower - bare.inhandPower}`)
  assert(close(sun.adaptiveStrength, 20), `Sun Beam Bow should add 20 Strength on Loki, got ${sun.adaptiveStrength}`)
}

;{
  const ratBase: Scenario = {
    title: 'rat acorn regression',
    attacker: {
      godId: 'Ratatoskr',
      level: 20,
      abilityRanks: ranks,
      items: ['Briskberry Acorn (A01)'],
      aspects: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [],
  }
  const ratAspect: Scenario = {
    ...ratBase,
    attacker: { ...ratBase.attacker, aspects: ['Ratatoskr.aspect'] },
  }
  const nonAspect = snapshotAttacker(ratBase) as { adaptiveStrength: number; maxHealth: number; healthPerTime: number; manaPerTime: number }
  const aspect = snapshotAttacker(ratAspect) as { adaptiveStrength: number; maxHealth: number; healthPerTime: number; manaPerTime: number }
  assert(close(nonAspect.adaptiveStrength, 45), `Briskberry non-aspect should add 45 Strength, got ${nonAspect.adaptiveStrength}`)
  assert(close(aspect.adaptiveStrength, 0), `Briskberry aspect should remove adaptive Strength, got ${aspect.adaptiveStrength}`)
  assert(close(aspect.maxHealth - nonAspect.maxHealth, 400), `Briskberry aspect should add 400 Health over non-aspect, got ${aspect.maxHealth - nonAspect.maxHealth}`)
  assert(close(aspect.healthPerTime - nonAspect.healthPerTime, 4), `Briskberry aspect should add 4 HP5, got ${aspect.healthPerTime - nonAspect.healthPerTime}`)
  assert(close(aspect.manaPerTime - nonAspect.manaPerTime, 2), `Briskberry aspect should add 2 MP5, got ${aspect.manaPerTime - nonAspect.manaPerTime}`)

  const ratFlurry = runScenario({
    title: 'rat flurry base regression',
    attacker: {
      godId: 'Ratatoskr',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A02', label: 'Flurry' }],
  })
  const ratFlurryHits = ratFlurry.damageEvents.filter((ev) => ev.label.startsWith('Flurry'))
  assert(ratFlurryHits.length === 4, `Ratatoskr A02 should hit 4 times base, got ${ratFlurryHits.length}`)
  assert(
    ratFlurryHits[1].postMitigation > ratFlurryHits[0].postMitigation
    && ratFlurryHits[2].postMitigation > ratFlurryHits[1].postMitigation
    && ratFlurryHits[3].postMitigation > ratFlurryHits[2].postMitigation,
    `Ratatoskr A02 should ramp per hit from prot shred, got ${ratFlurryHits.map((ev) => ev.postMitigation.toFixed(2)).join(', ')}`,
  )

  const ratBlastBase = runScenario({
    title: 'rat acorn blast base regression',
    attacker: {
      godId: 'Ratatoskr',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A03', label: 'Acorn Blast' }],
  })
  const ratBlastBaseHits = ratBlastBase.damageEvents.filter((ev) => ev.label.startsWith('Acorn Blast (hit '))
  assert(ratBlastBaseHits.length === 3, `Ratatoskr A03 base should fire 3 projectiles, got ${ratBlastBaseHits.length}`)
  assert(close(ratBlastBaseHits[0].preMitigation, 150, 0.001), `Ratatoskr A03 first projectile should deal 150 pre-mit at rank 5, got ${ratBlastBaseHits[0]?.preMitigation}`)
  assert(close(ratBlastBaseHits[1].preMitigation, 90, 0.001), `Ratatoskr A03 second projectile should deal 60% damage, got ${ratBlastBaseHits[1]?.preMitigation}`)
  assert(close(ratBlastBaseHits[2].preMitigation, 30, 0.001), `Ratatoskr A03 third projectile should floor at 20% damage, got ${ratBlastBaseHits[2]?.preMitigation}`)

  const ratThistleBase = runScenario({
    title: 'rat thistlethorn base regression',
    attacker: {
      godId: 'Ratatoskr',
      level: 20,
      abilityRanks: ranks,
      items: ['Thistlethorn Acorn (A03)'],
      aspects: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A03', label: 'Acorn Blast' }],
  })
  const ratThistleBaseHits = ratThistleBase.damageEvents.filter((ev) => ev.label.startsWith('Acorn Blast (hit '))
  const ratThistleBaseExplosions = ratThistleBase.damageEvents.filter((ev) => ev.label.startsWith('Acorn Blast explosion'))
  assert(ratThistleBaseHits.length === 3, `Thistlethorn base should still fire 3 direct projectiles, got ${ratThistleBaseHits.length}`)
  assert(ratThistleBaseHits.every((ev) => close(ev.preMitigation, 174.75, 0.001)), `Thistlethorn base should remove direct-hit falloff and include its +45 STR, got ${ratThistleBaseHits.map((ev) => ev.preMitigation).join(', ')}`)
  assert(ratThistleBaseExplosions.length === 3, `Thistlethorn base should schedule 3 delayed explosions, got ${ratThistleBaseExplosions.length}`)
  assert(ratThistleBaseExplosions.every((ev) => close(ev.preMitigation, 174.75, 0.001)), `Thistlethorn base explosions should use A03 base damage and Thistlethorn STR, got ${ratThistleBaseExplosions.map((ev) => ev.preMitigation).join(', ')}`)

  const ratThistleAspect = runScenario({
    title: 'rat thistlethorn aspect regression',
    attacker: {
      godId: 'Ratatoskr',
      level: 20,
      abilityRanks: ranks,
      items: ['Thistlethorn Acorn (A03)'],
      aspects: ['Ratatoskr.aspect'],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A03', label: 'Acorn Blast' }],
  })
  const ratThistleAspectHits = ratThistleAspect.damageEvents.filter((ev) => ev.label.startsWith('Acorn Blast (hit '))
  const ratThistleAspectExplosions = ratThistleAspect.damageEvents.filter((ev) => ev.label.startsWith('Acorn Blast explosion'))
  const ratThistleAspectDebuffs = ratThistleAspect.events.filter((ev) => ev.kind === 'buff-apply' && ev.label === 'Thistlethorn vulnerability')
  assert(ratThistleAspectHits.length === 5, `Thistlethorn aspect should fire 5 direct projectiles, got ${ratThistleAspectHits.length}`)
  assert(close(ratThistleAspectHits[0].preMitigation, 100, 0.001), `Thistlethorn aspect first projectile should start at TalentAcorn3cDamage, got ${ratThistleAspectHits[0]?.preMitigation}`)
  assert(close(ratThistleAspectHits[1].preMitigation, 105, 0.001), `Thistlethorn aspect second projectile should include 1 vulnerability stack, got ${ratThistleAspectHits[1]?.preMitigation}`)
  assert(close(ratThistleAspectHits[2].preMitigation, 110, 0.001), `Thistlethorn aspect third projectile should include 2 vulnerability stacks, got ${ratThistleAspectHits[2]?.preMitigation}`)
  assert(close(ratThistleAspectHits[3].preMitigation, 115, 0.001) && close(ratThistleAspectHits[4].preMitigation, 115, 0.001), `Thistlethorn aspect projectiles should cap at 3 vulnerability stacks, got ${ratThistleAspectHits.map((ev) => ev.preMitigation).join(', ')}`)
  assert(ratThistleAspectExplosions.length === 5, `Thistlethorn aspect should schedule 5 delayed explosions, got ${ratThistleAspectExplosions.length}`)
  assert(ratThistleAspectExplosions.every((ev) => close(ev.preMitigation, 80.5, 0.001)), `Thistlethorn aspect explosions should use TalentAcorn3cAOEDamage at max vulnerability, got ${ratThistleAspectExplosions.map((ev) => ev.preMitigation).join(', ')}`)
  assert(ratThistleAspectDebuffs.length === 1, `Thistlethorn aspect should apply its vulnerability debuff, got ${ratThistleAspectDebuffs.length}`)

  const daJiCuts = runScenario({
    title: 'daji one thousand cuts regression',
    attacker: {
      godId: 'DaJi',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A02', label: 'One Thousand Cuts' }],
  })
  const daJiHits = daJiCuts.damageEvents.filter((ev) => ev.label.startsWith('One Thousand Cuts'))
  assert(daJiHits.length === 4, `Da Ji A02 should hit 4 times, got ${daJiHits.length}`)

  const solSupernova = runScenario({
    title: 'sol supernova regression',
    attacker: {
      godId: 'Sol',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A04', label: 'Supernova' }],
  })
  const solHits = solSupernova.damageEvents.filter((ev) => ev.label.startsWith('Supernova (hit '))
  assert(solHits.length === 8, `Sol A04 should hit 8 times, got ${solHits.length}`)

  const solBurstBasic = runScenario({
    title: 'sol stellar burst regression',
    attacker: {
      godId: 'Sol',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A02', label: 'Stellar Burst' }, { kind: 'basic', label: 'AA1' }],
  })
  const solBurstExplosion = solBurstBasic.damageEvents.find((ev) => ev.label === 'Stellar Burst (explosion)')
  const solBurstRetraction = solBurstBasic.damageEvents.find((ev) => ev.label === 'Stellar Burst (retraction)')
  assert(solBurstExplosion, 'Sol A02 should arm explosion damage on the next basic')
  assert(solBurstRetraction, 'Sol A02 should arm retraction damage on the next basic')
  assert((solBurstRetraction?.t ?? 0) > (solBurstExplosion?.t ?? 0), 'Sol A02 retraction should land after the explosion')

  const merlinMastery = runScenario({
    title: 'merlin elemental mastery regression',
    attacker: {
      godId: 'Merlin',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A04', label: 'Elemental Mastery' }],
  })
  assert(merlinMastery.damageEvents.filter((ev) => ev.label.startsWith('Elemental Mastery')).length === 2,
    `Merlin A04 should deal initial and collapse damage, got ${merlinMastery.damageEvents.map((ev) => ev.label).join(', ')}`)

  const odinShield = runScenario({
    title: 'odin raven shout regression',
    attacker: {
      godId: 'Odin',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A02', label: 'Raven Shout' }],
  })
  const odinBurst = odinShield.damageEvents.find((ev) => ev.label === 'Raven Shout (shield burst)')
  assert(odinBurst, 'Odin A02 should schedule a timeout burst from the shield')
  assert((odinBurst?.t ?? 0) >= 4, `Odin A02 shield burst should occur near timeout, got t=${odinBurst?.t ?? 0}`)

  const nuWaSoldiers = runScenario({
    title: 'nu wa clay soldiers regression',
    attacker: {
      godId: 'Nu_Wa',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A02', label: 'Clay Soldiers' }],
  })
  assert(nuWaSoldiers.damageEvents.filter((ev) => ev.label.startsWith('Clay Soldiers (dash')).length === 3,
    `Nu Wa A02 rank 5 should create 3 soldier dash hits, got ${nuWaSoldiers.damageEvents.map((ev) => ev.label).join(', ')}`)

  const nuWaFireShards = runScenario({
    title: 'nu wa fire shards regression',
    attacker: {
      godId: 'Nu_Wa',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A04', label: 'Fire Shards' }],
  })
  assert(nuWaFireShards.damageEvents.some((ev) => ev.label === 'Fire Shards'),
    'Nu Wa A04 should resolve direct shard damage from local fallback rows')

  const thanScytheSolo = runScenario({
    title: 'thanatos death scythe solo regression',
    attacker: {
      godId: 'Thanatos',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A01', label: 'Death Scythe' }],
  })
  const thanBuffedScythe = runScenario({
    title: 'thanatos scent into scythe regression',
    attacker: {
      godId: 'Thanatos',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [
      { kind: 'ability', slot: 'A02', label: 'Scent of Death' },
      { kind: 'ability', slot: 'A01', label: 'Death Scythe' },
    ],
  })
  const thanScentOnly = runScenario({
    title: 'thanatos scent only regression',
    attacker: {
      godId: 'Thanatos',
      level: 20,
      abilityRanks: ranks,
      items: [],
    },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A02', label: 'Scent of Death' }],
  })
  assert(thanScentOnly.damageEvents.length === 0, `Thanatos A02 should be a buff setup, got ${thanScentOnly.damageEvents.map((ev) => ev.label).join(', ')}`)
  assert(
    thanBuffedScythe.totals.total > thanScytheSolo.totals.total,
    `Thanatos A02 -> A01 should buff Death Scythe, got ${thanBuffedScythe.totals.total} vs ${thanScytheSolo.totals.total}`,
  )
}

;{
  const morriganScenario = (rotation: Scenario['rotation']): Scenario => ({
    title: 'morrigan dark omen regression',
    attacker: { godId: 'The_Morrigan', level: 20, abilityRanks: ranks, items: [] },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation,
  })

  const nakedBasic = runScenario(morriganScenario([
    { kind: 'basic', label: 'AA1' },
  ])).damageEvents.find((ev) => ev.source === 'basic')
  assert(nakedBasic?.damageType === 'magical', `The Morrigan basics should be magical, got ${nakedBasic?.damageType ?? 'none'}`)
  assert(close(nakedBasic?.postMitigation ?? 0, 60.78125, 0.05), `The Morrigan naked basic should land for ~60.78 vs Kukulkan, got ${nakedBasic?.postMitigation ?? 0}`)

  const nakedOmen = runScenario(morriganScenario([
    { kind: 'ability', slot: 'A02', label: 'Dark Omen' },
  ])).damageEvents.find((ev) => ev.label === 'Dark Omen')
  assert(close(nakedOmen?.postMitigation ?? 0, 113.9322916667, 0.05), `Dark Omen naked hit should land for ~113.93 vs Kukulkan, got ${nakedOmen?.postMitigation ?? 0}`)

  const aaOmenAa = runScenario(morriganScenario([
    { kind: 'basic', label: 'AA1' },
    { kind: 'ability', slot: 'A02', label: 'Dark Omen' },
    { kind: 'basic', label: 'AA2' },
  ]))
  const omenHits = aaOmenAa.damageEvents.filter((ev) => ev.label.startsWith('Dark Omen'))
  assert(omenHits.length === 1, `Dark Omen should not self-pop or pop from basics in AA -> A02 -> AA, got ${omenHits.map((ev) => ev.label).join(', ')}`)
  assert(omenHits[0]?.label === 'Dark Omen', `Expected only the initial Dark Omen hit, got ${omenHits[0]?.label ?? 'none'}`)

  const omenIntoAbility = runScenario(morriganScenario([
    { kind: 'ability', slot: 'A02', label: 'Dark Omen' },
    { kind: 'ability', slot: 'A01', label: 'Deadly Aspects' },
  ]))
  const omenTriggerHits = omenIntoAbility.damageEvents.filter((ev) => ev.label === 'Dark Omen (trigger)')
  assert(omenTriggerHits.length === 1, `Dark Omen should pop once on the next god ability hit, got ${omenTriggerHits.length}`)

  const morriganIntBasicScenario: Scenario = {
    title: 'morrigan int basic scaling regression',
    attacker: { godId: 'The_Morrigan', level: 20, abilityRanks: ranks, items: ['Divine Ruin'] },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'basic', label: 'AA1' }],
  }
  const morriganIntSnapshot = snapshotAttacker(morriganIntBasicScenario) as {
    inhandPower: number
    adaptiveStrength: number
    adaptiveIntelligence: number
  }
  const morriganIntBasic = runScenario(morriganIntBasicScenario).damageEvents.find((ev) => ev.source === 'basic')
  const expectedMorriganPre =
    morriganIntSnapshot.inhandPower
    + morriganIntSnapshot.adaptiveStrength
    + morriganIntSnapshot.adaptiveIntelligence * 0.2
  assert(close(morriganIntBasic?.preMitigation ?? 0, expectedMorriganPre, 0.05), `The Morrigan basics should include 20% INT scaling, expected ${expectedMorriganPre}, got ${morriganIntBasic?.preMitigation ?? 0}`)

  const lokiIntBasicScenario = baseScenario(['Divine Ruin'], [{ kind: 'basic', label: 'AA1' }])
  const lokiIntSnapshot = snapshotAttacker(lokiIntBasicScenario) as {
    inhandPower: number
    adaptiveStrength: number
    adaptiveIntelligence: number
  }
  const lokiIntBasic = runScenario(lokiIntBasicScenario).damageEvents.find((ev) => ev.source === 'basic')
  const expectedLokiPre =
    lokiIntSnapshot.inhandPower
    + lokiIntSnapshot.adaptiveStrength
    + lokiIntSnapshot.adaptiveIntelligence * 0.2
  assert(close(lokiIntBasic?.preMitigation ?? 0, expectedLokiPre, 0.05), `Physical gods should still gain 20% INT on basics, expected ${expectedLokiPre}, got ${lokiIntBasic?.preMitigation ?? 0}`)
}

;{
  const nutScenario = (rotation: Scenario['rotation'], godState: Record<string, number | boolean | string> = {}): Scenario => ({
    title: 'nut convergence regression',
    attacker: { godId: 'Nut', level: 20, abilityRanks: ranks, items: [], godState },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation,
  })

  const nutBuffOnly = runScenario(nutScenario([
    { kind: 'ability', slot: 'A01', label: 'Convergence' },
  ]))
  assert(nutBuffOnly.damageEvents.length === 0, `Nut A01 should be a stim cast with no direct damage, got ${nutBuffOnly.damageEvents.map((ev) => ev.label).join(', ')}`)

  const nutBasicOnly = runScenario(nutScenario([
    { kind: 'basic', label: 'AA1' },
  ]))
  const nutConvergence = runScenario(nutScenario([
    { kind: 'ability', slot: 'A01', label: 'Convergence' },
    { kind: 'basic', label: 'AA1' },
  ]))
  const nutSideShots = nutConvergence.damageEvents.filter((ev) => ev.label.startsWith('Convergence side shot'))
  assert(nutSideShots.length === 2, `Nut A01-enhanced basic should fire 2 side projectiles, got ${nutSideShots.length}`)
  assert(nutConvergence.totals.total > nutBasicOnly.totals.total, `Nut A01-enhanced basic should outdamage a naked basic, got ${nutConvergence.totals.total} vs ${nutBasicOnly.totals.total}`)

  const nutAstral = runScenario(nutScenario([
    { kind: 'ability', slot: 'A01', label: 'Convergence' },
    { kind: 'basic', label: 'AA1' },
    { kind: 'basic', label: 'AA2' },
  ], { NutAstralFluxStacks: 4 }))
  const nutAstralBasics = nutAstral.damageEvents.filter((ev) => ev.source === 'basic')
  const nutAstralDebuffApplied = nutAstral.events.some((ev) =>
    ev.kind === 'buff-apply'
    && ev.target === 'enemy'
    && ev.label === 'Convergence protection shred')
  assert(nutAstralDebuffApplied, 'Nut A01 with 4 Astral Flux stacks should apply a protection shred debuff')
  assert(nutAstralBasics.length >= 2, `Nut A01 astral test should have 2 basics, got ${nutAstralBasics.length}`)
  assert(
    nutAstralBasics[1].postMitigation > nutAstralBasics[0].postMitigation,
    `Nut A01 protection shred should increase later basic damage, got ${nutAstralBasics.map((ev) => ev.postMitigation.toFixed(2)).join(', ')}`,
  )
}

;{
  const aspectScenario = (godId: string, slot: 'A01' | 'A02' | 'A03' | 'A04', aspects: string[] = [], items: string[] = [], rotation: Scenario['rotation'] = [{ kind: 'ability', slot }]): Scenario => ({
    title: `${godId} aspect regression`,
    attacker: { godId, level: 20, abilityRanks: ranks, items, aspects },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation,
  })

  const kukuA01Base = runScenario(aspectScenario('Kukulkan', 'A01'))
  const kukuA01Aspect = runScenario(aspectScenario('Kukulkan', 'A01', ['Kukulkan.aspect']))
  assert(kukuA01Aspect.totals.total > kukuA01Base.totals.total, 'Kukulkan A01 aspect rows should add damage')

  const kukuA03Base = runScenario(aspectScenario('Kukulkan', 'A03'))
  const kukuA03Aspect = runScenario(aspectScenario('Kukulkan', 'A03', ['Kukulkan.aspect']))
  assert(kukuA03Aspect.totals.total > kukuA03Base.totals.total, 'Kukulkan A03 aspect rows should add direct/tick damage')

  const ganeshaBase = runScenario(aspectScenario('Ganesha', 'A02'))
  const ganeshaAspect = runScenario(aspectScenario('Ganesha', 'A02', ['Ganesha.aspect']))
  assert(ganeshaAspect.totals.total > ganeshaBase.totals.total, 'Ganesha A02 aspect rows should create damage output')

  const agniBase = runScenario(aspectScenario('Agni', 'A04'))
  const agniAspect = runScenario(aspectScenario('Agni', 'A04', ['Agni.aspect']))
  assert(agniAspect.totals.total > agniBase.totals.total, 'Agni A04 aspect rows should add bonus damage')

  const athenaBase = runScenario(aspectScenario('Athena', 'A04'))
  const athenaAspect = runScenario(aspectScenario('Athena', 'A04', ['Athena.aspect']))
  assert(athenaAspect.totals.total > athenaBase.totals.total, 'Athena A04 aspect CT rows should add landing damage')

  const bacchusBase = runScenario(aspectScenario('Bacchus', 'A01', [], [], [{ kind: 'ability', slot: 'A01' }, { kind: 'basic' }]))
  const bacchusAspect = runScenario(aspectScenario('Bacchus', 'A01', ['Bacchus.aspect'], [], [{ kind: 'ability', slot: 'A01' }, { kind: 'basic' }]))
  assert(bacchusAspect.totals.total > bacchusBase.totals.total, 'Bacchus A01 aspect should add empowered next-basic damage')

  const fenrirBase = runScenario(aspectScenario('Fenrir', 'A02', [], [], [{ kind: 'ability', slot: 'A02' }, { kind: 'ability', slot: 'A03' }]))
  const fenrirAspect = runScenario(aspectScenario('Fenrir', 'A02', ['Fenrir.aspect'], [], [{ kind: 'ability', slot: 'A02' }, { kind: 'ability', slot: 'A03' }]))
  assert(fenrirAspect.totals.total > fenrirBase.totals.total, 'Fenrir A02 aspect buffs should increase follow-up Brutalize damage')

  const discordiaBase = runScenario(aspectScenario('Discordia', 'A03', [], [], [{ kind: 'ability', slot: 'A03' }, { kind: 'basic' }]))
  const discordiaAspect = runScenario(aspectScenario('Discordia', 'A03', ['Discordia.aspect'], [], [{ kind: 'ability', slot: 'A03' }, { kind: 'basic' }]))
  assert(discordiaAspect.totals.total > discordiaBase.totals.total, 'Discordia A03 aspect buff rows should increase follow-up basic damage')

  const odinA02Base = runScenario(aspectScenario('Odin', 'A02', [], [], [{ kind: 'ability', slot: 'A02' }, { kind: 'basic' }]))
  const odinA02Aspect = runScenario(aspectScenario('Odin', 'A02', ['Odin.aspect'], [], [{ kind: 'ability', slot: 'A02' }, { kind: 'basic' }]))
  assert(odinA02Aspect.totals.total > odinA02Base.totals.total, 'Odin A02 aspect buffs should increase follow-up basic damage')

  const odinA03Base = runScenario(aspectScenario('Odin', 'A03'))
  const odinA03Aspect = runScenario(aspectScenario('Odin', 'A03', ['Odin.aspect']))
  assert(odinA03Aspect.totals.total > odinA03Base.totals.total, 'Odin A03 aspect CT rows should add direct damage')

  const poseidonBase = runScenario(aspectScenario('Poseidon', 'A02', [], [], [{ kind: 'ability', slot: 'A02' }, { kind: 'basic' }]))
  const poseidonAspect = runScenario(aspectScenario('Poseidon', 'A02', ['Poseidon.aspect'], [], [{ kind: 'ability', slot: 'A02' }, { kind: 'basic' }]))
  assert(poseidonAspect.totals.total > poseidonBase.totals.total, 'Poseidon A02 aspect should add side-shot basic projectiles')

  const raBase = runScenario(aspectScenario('Ra', 'A02', [], [], [{ kind: 'ability', slot: 'A02' }, { kind: 'basic' }]))
  const raAspect = runScenario(aspectScenario('Ra', 'A02', ['Ra.aspect'], [], [{ kind: 'ability', slot: 'A02' }, { kind: 'basic' }]))
  assert(raAspect.totals.total > raBase.totals.total, 'Ra A02 aspect should add enhanced solar ray damage to follow-up basics')

  const ratBriskBase = runScenario(aspectScenario('Ratatoskr', 'A01', [], ['Briskberry Acorn (A01)']))
  const ratBriskAspect = runScenario(aspectScenario('Ratatoskr', 'A01', ['Ratatoskr.aspect'], ['Briskberry Acorn (A01)']))
  assert(ratBriskAspect.totals.total > ratBriskBase.totals.total, 'Ratatoskr Briskberry aspect should add explosion damage')

  const ratThistleBase = runScenario(aspectScenario('Ratatoskr', 'A03', [], ['Thistlethorn Acorn (A03)']))
  const ratThistleAspect = runScenario(aspectScenario('Ratatoskr', 'A03', ['Ratatoskr.aspect'], ['Thistlethorn Acorn (A03)']))
  assert(ratThistleBase.damageEvents.filter((ev) => ev.label.startsWith('Acorn Blast (hit ')).length === 3, 'Ratatoskr Thistlethorn base should stay on 3 direct projectiles')
  assert(ratThistleAspect.damageEvents.filter((ev) => ev.label.startsWith('Acorn Blast (hit ')).length === 5, 'Ratatoskr Thistlethorn aspect should switch to 5 direct projectiles')
  assert(ratThistleAspect.events.some((ev) => ev.kind === 'buff-apply' && ev.label === 'Thistlethorn vulnerability'), 'Ratatoskr Thistlethorn aspect should apply its vulnerability debuff')

  const yemojaBase = runScenario(aspectScenario('Yemoja', 'A02'))
  const yemojaAspect = runScenario(aspectScenario('Yemoja', 'A02', ['Yemoja.aspect']))
  assert(yemojaAspect.totals.total > yemojaBase.totals.total, 'Yemoja A02 aspect CT rows should add chained damage')

  const cabrakanBase = runScenario(aspectScenario('Cabrakan', 'A01', [], [], [
    { kind: 'ability', slot: 'A01' },
    { kind: 'ability', slot: 'A02' },
  ]))
  const cabrakanAspect = runScenario(aspectScenario('Cabrakan', 'A01', ['Cabrakan.aspect'], [], [
    { kind: 'ability', slot: 'A01' },
    { kind: 'ability', slot: 'A02' },
  ]))
  assert(cabrakanAspect.totals.total > cabrakanBase.totals.total, 'Cabrakan A01 aspect CT rows should buff follow-up ability damage')

  const thanatosBase = runScenario(aspectScenario('Thanatos', 'A03'))
  const thanatosAspect = runScenario(aspectScenario('Thanatos', 'A03', ['Thanatos.aspect']))
  assert(thanatosAspect.totals.total > thanatosBase.totals.total, 'Thanatos A03 aspect should add target max-health damage')

  const chaacBase = runScenario(aspectScenario('Chaac', 'A03'))
  const chaacAspect = runScenario(aspectScenario('Chaac', 'A03', ['Chaac.aspect']))
  assert(chaacAspect.totals.total > chaacBase.totals.total, 'Chaac A03 aspect should replace healing with damage-over-time output')

  const cupidAspect = runScenario(aspectScenario('Cupid', 'A01', ['Cupid.aspect']))
  assert(cupidAspect.damageEvents.some((ev) => ev.label === 'Heart Bomb (aspect explosion)'), 'Cupid aspect should schedule the delayed Heart Bomb explosion')

  const gilgameshAspect = runScenario(aspectScenario('Gilgamesh', 'A04', ['Gilgamesh.aspect'], [], [
    { kind: 'ability', slot: 'A04' },
    { kind: 'ability', slot: 'A01' },
  ]))
  assert(gilgameshAspect.damageEvents.some((ev) => ev.label === 'Winds of Shamash (ignite)'), 'Gilgamesh aspect should convert Winds of Shamash into an ignite follow-up on A01')

  const xbalA01Base = runScenario(aspectScenario('Xbalanque', 'A01', [], [], [
    { kind: 'ability', slot: 'A01' },
    { kind: 'basic' },
    { kind: 'basic' },
    { kind: 'basic' },
  ]))
  const xbalA01Aspect = runScenario(aspectScenario('Xbalanque', 'A01', ['Xbalanque.aspect'], [], [
    { kind: 'ability', slot: 'A01' },
    { kind: 'basic' },
    { kind: 'basic' },
    { kind: 'basic' },
  ]))
  assert(xbalA01Aspect.totals.total > xbalA01Base.totals.total, 'Xbalanque A01 aspect should grant 3 enhanced ability-based basic projectiles')

  const xbalA04Base = runScenario(aspectScenario('Xbalanque', 'A04', [], [], [
    { kind: 'ability', slot: 'A04' },
    { kind: 'ability', slot: 'A02' },
  ]))
  const xbalA04Aspect = runScenario(aspectScenario('Xbalanque', 'A04', ['Xbalanque.aspect'], [], [
    { kind: 'ability', slot: 'A04' },
    { kind: 'ability', slot: 'A02' },
  ]))
  assert(xbalA04Aspect.totals.total > xbalA04Base.totals.total, 'Xbalanque A04 aspect should buff follow-up ability damage')

  const anhurBase = runScenario(aspectScenario('Anhur', 'A01', [], [], [
    { kind: 'basic' },
    { kind: 'basic' },
    { kind: 'basic' },
    { kind: 'basic' },
  ]))
  const anhurAspect = runScenario(aspectScenario('Anhur', 'A01', ['Anhur.aspect'], [], [
    { kind: 'basic' },
    { kind: 'basic' },
    { kind: 'basic' },
    { kind: 'basic' },
  ]))
  const anhurBaseEnd = anhurBase.damageEvents.at(-1)?.t ?? 0
  const anhurAspectEnd = anhurAspect.damageEvents.at(-1)?.t ?? 0
  assert(anhurAspectEnd < anhurBaseEnd, 'Anhur aspect should ramp attack speed against the same target on repeated basics')

  const jormBase = runScenario(aspectScenario('Jormungandr', 'A02', [], [], [
    { kind: 'ability', slot: 'A02' },
    { kind: 'ability', slot: 'A01' },
  ]))
  const jormAspect = runScenario(aspectScenario('Jormungandr', 'A02', ['Jormungandr.aspect'], [], [
    { kind: 'ability', slot: 'A02' },
    { kind: 'ability', slot: 'A01' },
  ]))
  assert(jormAspect.totals.total > jormBase.totals.total, 'Jormungandr aspect should buff follow-up ability output from the A02 self-buff')

  const sobekBase = runScenario(aspectScenario('Sobek', 'A01'))
  const sobekAspect = runScenario(aspectScenario('Sobek', 'A01', ['Sobek.aspect']))
  assert(sobekAspect.totals.total > sobekBase.totals.total, 'Sobek A01 aspect rows should add bonus damage')

  const esetBase = runScenario(aspectScenario('Eset', 'A01'))
  const esetAspect = runScenario(aspectScenario('Eset', 'A01', ['Eset.aspect']))
  assert(esetAspect.totals.total > esetBase.totals.total, 'Eset A01 aspect rows should add bonus damage')

  const tsukuBase = runScenario(aspectScenario('Tsukuyomi', 'A04'))
  const tsukuBaseBeams = tsukuBase.damageEvents.filter((ev) => ev.label.startsWith('Piercing Moonlight (beam '))
  const tsukuBaseDashes = tsukuBase.damageEvents.filter((ev) => ev.label.startsWith('Piercing Moonlight (dash '))
  assert(tsukuBaseBeams.length === 4, `Tsukuyomi A04 should emit 4 beam hits on a full single-target cast, got ${tsukuBaseBeams.length}`)
  assert(tsukuBaseDashes.length === 4, `Tsukuyomi A04 should emit 1 dash strike per beam hit, got ${tsukuBaseDashes.length}`)

  const tsukuTwoBeam = runScenario({
    ...aspectScenario('Tsukuyomi', 'A04'),
    options: { tickOverrides: { 'Tsukuyomi.A04': 2 } },
  })
  const tsukuTwoBeamDashes = tsukuTwoBeam.damageEvents.filter((ev) => ev.label.startsWith('Piercing Moonlight (dash '))
  assert(tsukuTwoBeamDashes.length === 2, `Tsukuyomi A04 with 2 beam hits should emit 2 dash strikes, got ${tsukuTwoBeamDashes.length}`)

  const tsukuAspect = runScenario(aspectScenario('Tsukuyomi', 'A04', ['Tsukuyomi.aspect']))
  const tsukuAspectTargetExplosions = tsukuAspect.damageEvents.filter((ev) => ev.label.startsWith('Piercing Moonlight (aspect target '))
  const tsukuAspectAreaExplosions = tsukuAspect.damageEvents.filter((ev) => ev.label.startsWith('Piercing Moonlight (aspect area '))
  assert(tsukuAspectTargetExplosions.length === 4, `Tsukuyomi A04 aspect target explosions should follow dash strike count, got ${tsukuAspectTargetExplosions.length}`)
  assert(tsukuAspectAreaExplosions.length === 4, `Tsukuyomi A04 aspect area explosions should follow dash strike count, got ${tsukuAspectAreaExplosions.length}`)
  assert(tsukuAspect.totals.total > tsukuBase.totals.total, 'Tsukuyomi A04 aspect rows should add target and area damage')
}

;{
  const titans = getItem("Titan's Bane")
  const obShard = getItem('Obsidian Shard')
  const titansPoolShape = {
    categories: titans.categories,
    statTags: titans.statTags,
    resolvedStats: resolveItemStatsWithOverrides(titans),
  }
  const shardPoolShape = {
    categories: obShard.categories,
    statTags: obShard.statTags,
    resolvedStats: resolveItemStatsWithOverrides(obShard),
  }
  assert(itemMatchesStrictOffensePreset(titansPoolShape, 'physical', false), "Titan's Bane should stay in strict physical pools")
  assert(!itemMatchesStrictOffensePreset(titansPoolShape, 'magical', false), "Titan's Bane should not appear in strict magical pools")
  assert(itemMatchesStrictOffensePreset(shardPoolShape, 'magical', false), 'Obsidian Shard should stay in strict magical pools')
}

;{
  const nimble = snapshotAttacker(baseScenario(['Nimble Ring'], [])) as {
    inhandPower: number
    adaptiveIntelligence: number
    attackSpeedPercent: number
  }
  assert(close(nimble.adaptiveIntelligence, 20), `Nimble Ring base Intelligence expected 20, got ${nimble.adaptiveIntelligence}`)
  assert(close(nimble.inhandPower, 95.36), `Nimble Ring should convert 20 INT into +2 Attack Damage, got ${nimble.inhandPower}`)
  assert(close(nimble.attackSpeedPercent, 65), `Nimble Ring should convert 20 INT into +2% Attack Speed, got ${nimble.attackSpeedPercent}`)
}

;{
  const riptalon = runScenario(baseScenario(['Riptalon'], [{ kind: 'basic' }]))
  const basic = riptalon.damageEvents.find((ev) => ev.source === 'basic')
  assert(basic, 'Riptalon scenario should produce a basic attack')
  assert(close(basic.preMitigation, 124.696), `Riptalon above-50% Attack Damage buff should apply before first hit, got ${basic.preMitigation}`)
}

;{
  const bumba = runScenario(baseScenario(["Bumba's Hammer"], [
    { kind: 'ability', slot: 'A01', cancel: true },
    { kind: 'basic' },
  ]))
  const hammer = bumba.damageEvents.find((ev) => ev.label === 'Bumba post-ability')
  assert(hammer && close(hammer.preMitigation, 60), `Bumba's Hammer next-basic true damage should be 60, got ${hammer?.preMitigation}`)
}

;{
  const bluestone = runScenario(baseScenario(['Bluestone Brooch'], [
    { kind: 'ability', slot: 'A02' },
  ]))
  const ticks = bluestone.damageEvents.filter((ev) => ev.label.startsWith('Bluestone Brooch'))
  assert(ticks.length === 16, `Bluestone Brooch should proc on each of Loki A02's 8 hits with 2 ticks each, got ${ticks.length}`)
  assert(close(ticks[0].preMitigation, 131.9904, 0.001), `Bluestone Brooch first tick should include 7.5% current health, got ${ticks[0].preMitigation}`)
  assert(close(ticks[2].preMitigation, 196.5125, 0.001), `Bluestone Brooch subsequent hit should use +50% bonus damage, got ${ticks[2].preMitigation}`)
}

;{
  const soulReaver = runScenario({
    title: 'soul reaver cadence regression',
    attacker: { godId: 'Anubis', level: 20, abilityRanks: ranks, items: ['Soul Reaver'] },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A02', label: 'Mummify' }],
  })
  const reaverTicks = soulReaver.damageEvents.filter((ev) => ev.label.startsWith('Soul Reaver'))
  assert(reaverTicks.length === 4, `Soul Reaver should deal 4 ticks over 2s, got ${reaverTicks.length}`)
  assert(close(reaverTicks[0]?.t ?? 0, 0.5, 0.001) && close(reaverTicks[3]?.t ?? 0, 2.0, 0.001),
    `Soul Reaver should tick every 0.5s from 0.5s to 2.0s, got ${reaverTicks.map((ev) => ev.t).join(', ')}`)
}

;{
  const divineBasic = runScenario({
    title: 'divine ruin on-hit regression',
    attacker: { godId: 'The_Morrigan', level: 20, abilityRanks: ranks, items: ['Divine Ruin'] },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [{ kind: 'basic', label: 'AA1' }],
  })
  const divineProc = divineBasic.damageEvents.find((ev) => ev.label === 'Divine Ruin')
  assert(divineProc, 'Divine Ruin should proc on god damage, including basics')
  assert(close(divineProc?.preMitigation ?? 0, 57, 0.001), `Divine Ruin basic-trigger proc should deal 40 + 20% INT, got ${divineProc?.preMitigation ?? 0}`)
}

;{
  const poly = runScenario({
    title: 'polynomicon source regression',
    attacker: { godId: 'The_Morrigan', level: 20, abilityRanks: ranks, items: ['Polynomicon'] },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [
      { kind: 'ability', slot: 'A02', label: 'Dark Omen' },
      { kind: 'basic', label: 'AA1' },
    ],
  })
  const polyProc = poly.damageEvents.find((ev) => ev.label === 'Polynomicon')
  assert(polyProc?.source === 'item', `Polynomicon should be emitted as an item proc, got ${polyProc?.source ?? 'none'}`)
}

;{
  const blink = getItem('Blinking Amulet')
  const namaka = getItem('Emblem of Namaka')
  const phantom = getItem('Phantom Ring')
  assert(getItemProcs(blink).some((proc) => proc.kind === 'activeUse_teleport'),
    'Blinking Amulet should parse as an active teleport item')
  const namakaShield = getItemProcs(namaka).find((proc) => proc.kind === 'activeUse_shield')
  assert(namakaShield && close(namakaShield.flatShield, 100) && close(namakaShield.shieldPerLevel, 12) && close(namakaShield.durationSeconds, 4),
    `Emblem of Namaka should parse a 100 + 12*level shield for 4s, got ${JSON.stringify(namakaShield)}`)
  assert(getItemProcs(phantom).some((proc) => proc.kind === 'activeUse_utility'),
    'Phantom Ring should expose its impediment-immunity wall-walk text as active utility')
}

;{
  const sun = runScenario(baseScenario(['Sun Beam Bow'], [
    { kind: 'activate', itemKey: 'Sun Beam Bow' },
    { kind: 'basic' },
  ]))
  const projectiles = sun.damageEvents.filter((ev) => ev.label.startsWith('Sun Beam Bow (projectile'))
  assert(projectiles.length === 2, `Sun Beam Bow active should add 2 projectile hits per basic, got ${projectiles.length}`)
  assert(projectiles.every((ev) => close(ev.preMitigation, 47.01)), `Sun Beam Bow projectile pre-mit damage mismatch: ${projectiles.map((ev) => ev.preMitigation).join(', ')}`)
}

;{
  const eye = runScenario(baseScenario(['Eye of Erebus'], [
    { kind: 'activate', itemKey: 'Eye of Erebus' },
  ]))
  const active = eye.damageEvents.find((ev) => ev.label === 'Eye of Erebus')
  assert(active && close(active.preMitigation, 331.89, 0.1), `Eye of Erebus active should deal 15% target max HP pre-mit, got ${active?.preMitigation}`)
}

;{
  const rod = snapshotAttacker(baseScenario(['Rod of Tahuti'], [])) as { adaptiveIntelligence: number }
  assert(close(rod.adaptiveIntelligence, 106.25), `Rod of Tahuti should multiply its 85 Intelligence by 25%, got ${rod.adaptiveIntelligence}`)
}

;{
  const typhon = snapshotAttacker(baseScenario(["Typhon's Fang"], [])) as { adaptiveIntelligence: number }
  assert(close(typhon.adaptiveIntelligence, 76), `Typhon's Fang should convert 20 Lifesteal into +36 Intelligence, got ${typhon.adaptiveIntelligence}`)

  const conch = snapshotAttacker(baseScenario(["Triton's Conch"], [])) as { adaptiveStrength: number; adaptiveIntelligence: number }
  assert(close(conch.adaptiveStrength, 55), `Triton's Conch should include its level 20 Strength aura, got ${conch.adaptiveStrength}`)
  assert(close(conch.adaptiveIntelligence, 50), `Triton's Conch should include its level 20 Intelligence aura, got ${conch.adaptiveIntelligence}`)

  const cosmicOnly = snapshotAttacker(baseScenario(['The Cosmic Horror'], [])) as { adaptiveIntelligence: number }
  const cosmicWithCdr = snapshotAttacker(baseScenario(['The Cosmic Horror', "Chronos' Pendant"], [])) as { adaptiveIntelligence: number }
  assert(close(cosmicOnly.adaptiveIntelligence, 75), `The Cosmic Horror should not gain +35 INT when Echo exceeds CDR, got ${cosmicOnly.adaptiveIntelligence}`)
  assert(close(cosmicWithCdr.adaptiveIntelligence - cosmicOnly.adaptiveIntelligence, 90), `The Cosmic Horror with Chronos should add Chronos INT plus +35 mode INT, got ${cosmicWithCdr.adaptiveIntelligence - cosmicOnly.adaptiveIntelligence}`)

  const shogunBare = snapshotAttacker(baseScenario([], [])) as { totalAttackSpeed: number }
  const shogun = snapshotAttacker(baseScenario(["Shogun's Ofuda"], [])) as { totalAttackSpeed: number }
  assert(shogun.totalAttackSpeed > shogunBare.totalAttackSpeed, "Shogun's Ofuda passive aura should increase attack speed")

  const bancroftBase = snapshotAttacker(baseScenario(["Bancroft's Talon"], [])) as { adaptiveIntelligence: number }
  const bancroftForced = snapshotAttacker({
    ...baseScenario(["Bancroft's Talon"], []),
    options: { forceConditionalItemEffects: true },
  }) as { adaptiveIntelligence: number; lifestealGeneric: number; lifestealPhysicalInhand: number; lifestealPhysicalAbility: number }
  assert(close(bancroftForced.adaptiveIntelligence - bancroftBase.adaptiveIntelligence, 60), `Forced Bancroft's Talon missing-health passive should add 60 Intelligence, got ${bancroftForced.adaptiveIntelligence - bancroftBase.adaptiveIntelligence}`)
}

;{
  const deathbringer = snapshotAttacker(baseScenario(['Deathbringer'], [])) as { critDamageBonus: number }
  assert(close(deathbringer.critDamageBonus, 35), `Deathbringer should add 35 Critical Strike Damage, got ${deathbringer.critDamageBonus}`)
  const crit = runScenario({
    ...baseScenario(['Deathbringer'], [{ kind: 'basic' }]),
    options: { critMode: 'alwaysCrit' },
  })
  const basic = crit.damageEvents.find((ev) => ev.source === 'basic')
  assert(basic && basic.crit === true, 'Deathbringer forced-crit basic should be marked as crit')
}

;{
  const glad = runScenario(baseScenario(["Gladiator's Shield"], [{ kind: 'ability', slot: 'A01' }]))
  assert(glad.damageEvents.some((ev) => ev.label === "Gladiator's Shield"), "Gladiator's Shield should emit item-protection scaling damage on ability hit")

  const golden = runScenario(baseScenario(['Golden Blade'], [{ kind: 'basic' }]))
  assert(golden.damageEvents.some((ev) => ev.label === 'Golden Blade'), 'Golden Blade should emit item-protection scaling damage on basic hit')

  const mageScenario = (items: string[]): Scenario => ({
    title: 'mage regression',
    attacker: { godId: 'Kukulkan', level: 20, abilityRanks: ranks, items },
    defender: { godId: 'Ymir', level: 20 },
    rotation: [{ kind: 'ability', slot: 'A01' }],
  })
  const voidStoneBare = runScenario(mageScenario([]))
  const voidStone = runScenario(mageScenario(['Void Stone']))
  assert(voidStone.totals.total > voidStoneBare.totals.total, 'Void Stone passive magical protection aura should increase magical damage')
}

;{
  const necronomicon = getItem('Necronomicon')
  const rage = getItem('Rage')
  const doomOrb = getItem('Doom Orb')
  const book = getItem('Book of Thoth')
  const devourers = getItem("Devourer's Gauntlet")
  const thebes = getItem('Gauntlet of Thebes')
  const transcendence = getItem('Transcendence')
  const bracer = getItem('Bracer of The Abyss')
  const demonic = getItem('Demonic Grip')
  assert(maxStackCountFor(necronomicon) === 6, `Necronomicon max stacks should parse as 6, got ${maxStackCountFor(necronomicon)}`)
  assert(shouldAutoEvolveStackingItem(necronomicon) === false, 'Necronomicon god kill/assist stacks should not auto-evolve')
  assert(shouldAutoEvolveStackingItem(rage) === false, 'Rage god kill/assist stacks should not auto-evolve')
  assert(shouldAutoEvolveStackingItem(doomOrb) === false, 'Doom Orb temporary stacks should not auto-evolve')
  assert(shouldAutoEvolveStackingItem(bracer) === false, 'Bracer of The Abyss combat-window stacks should not auto-evolve')
  assert(shouldAutoEvolveStackingItem(demonic) === false, 'Demonic Grip hit-triggered debuff stacks should not auto-evolve')
  assert(shouldAutoEvolveStackingItem(book) === true, 'Book of Thoth farmed stacks should still auto-evolve')
  assert(shouldAutoEvolveStackingItem(devourers) === true, "Devourer's Gauntlet farmed stacks should still auto-evolve")
  assert(shouldAutoEvolveStackingItem(thebes) === true, 'Gauntlet of Thebes farmed stacks should still auto-evolve')
  assert(shouldAutoEvolveStackingItem(transcendence) === true, 'Transcendence farmed stacks should still auto-evolve')

  const unstacked = snapshotAttacker(baseScenario(['Necronomicon'], [])) as { adaptiveIntelligence: number }
  const optimizerBuildUnstacked = snapshotAttacker(baseScenario(['Bluestone Brooch', 'Necronomicon'], [])) as { adaptiveIntelligence: number }
  const fullyStacked = snapshotAttacker({
    ...baseScenario(['Necronomicon'], []),
    attacker: {
      ...baseScenario(['Necronomicon'], []).attacker,
      partialStacks: { 'item.Necronomicon': 6 },
    },
  }) as { adaptiveIntelligence: number }
  assert(
    close(fullyStacked.adaptiveIntelligence - unstacked.adaptiveIntelligence, 180, 0.001),
    `Explicit Necronomicon stacks should add 180 Intelligence, got ${fullyStacked.adaptiveIntelligence - unstacked.adaptiveIntelligence}`,
  )

  const result = optimize({
    scenario: baseScenario([], [{ kind: 'ability', slot: 'A02' }]),
    itemPool: ['Bluestone Brooch', 'Necronomicon'],
    buildSize: 1,
    requireOneStarter: true,
    maxPermutations: 10,
    topN: 1,
    evolveStackingItems: true,
  })
  const necroBuild = result.results.find((r) => r.items.includes('Necronomicon'))
  assert(necroBuild, 'Optimizer should evaluate a Bluestone Brooch + Necronomicon build')
  assert(
    close(necroBuild.stats.adaptiveIntelligence, optimizerBuildUnstacked.adaptiveIntelligence, 0.001),
    `Necronomicon should keep only base Intelligence unless partialStacks are supplied, got ${necroBuild.stats.adaptiveIntelligence}`,
  )
  assert(
    result.warnings.some((w) => w.includes('not auto-stacked') && w.includes('Necronomicon')),
    'Optimizer should warn when conditional stack items are left unstacked by auto-evolve',
  )

  const bracerBaseline = snapshotAttacker(baseScenario(['Bluestone Brooch', 'Bracer of The Abyss'], [])) as { inhandPower: number }
  const bracerResult = optimize({
    scenario: baseScenario([], [{ kind: 'basic' }]),
    itemPool: ['Bluestone Brooch', 'Bracer of The Abyss'],
    buildSize: 1,
    requireOneStarter: true,
    maxPermutations: 10,
    topN: 1,
    evolveStackingItems: true,
  })
  const bracerBuild = bracerResult.results.find((r) => r.items.includes('Bracer of The Abyss'))
  assert(bracerBuild, 'Optimizer should evaluate a Bluestone Brooch + Bracer of The Abyss build')
  assert(
    close(bracerBuild.stats.inhandPower, bracerBaseline.inhandPower, 0.001),
    `Bracer of The Abyss should not get precharged Attack Damage from auto-evolve, got ${bracerBuild.stats.inhandPower}`,
  )
}

;{
  assert(getFinalBuildItemExclusionReason(getItem('Dagger of Frenzy')) === 'missing stat rows', 'Dagger of Frenzy should be excluded until stat rows are mined')
  assert(getFinalBuildItemExclusionReason(getItem("Eros' Bow")) === 'missing stat rows', "Eros' Bow should be excluded until stat rows are mined")
  const result = optimize({
    scenario: baseScenario([], [{ kind: 'basic' }]),
    itemPool: ['Dagger of Frenzy', "Eros' Bow", 'Eye of Providence', 'Axe', 'Rage', 'Sun Beam Bow', "Bumba's Hammer"],
    buildSize: 2,
    requireOneStarter: true,
    maxPermutations: 10,
    topN: 3,
  })
  assert(result.warnings.some((w) => w.includes('missing stat rows')), 'Optimizer should warn about missing-stat final rows')
  assert(result.results.every((r) => !r.items.includes('Dagger of Frenzy') && !r.items.includes("Eros' Bow") && !r.items.includes('Axe')), 'Optimizer returned excluded items')
}

;{
  const locked = optimize({
    scenario: baseScenario(["Titan's Bane", "Hydra's Lament"], [{ kind: 'ability', slot: 'A01' }, { kind: 'basic' }]),
    itemPool: ["Bumba's Hammer", "Titan's Bane", "Hydra's Lament", 'Heartseeker', 'The Crusher', "Jotunn's Revenge", "Devourer's Gauntlet"],
    buildSize: 4,
    requireOneStarter: true,
    maxPermutations: 50,
    topN: 10,
  })
  assert(locked.results.length > 0, 'Optimizer should produce builds when two regular items are locked')
  assert(locked.results.every((r) => r.items.includes("Titan's Bane") && r.items.includes("Hydra's Lament")), 'Every optimized build should include locked equipped items')
  assert(locked.warnings.some((w) => w.includes('Locked item(s) forced')), 'Optimizer should warn when equipped items are locked into all builds')
}

;{
  const request = {
    scenario: baseScenario([], [{ kind: 'ability', slot: 'A01' }, { kind: 'basic' }]),
    itemPool: ["Bumba's Hammer", 'Heartseeker', 'The Crusher', "Jotunn's Revenge"],
    buildSize: 2,
    requireOneStarter: true,
    maxPermutations: 20,
    topN: 10,
  } satisfies Parameters<typeof optimize>[0]
  const direct = optimize(request)
  const shard0 = optimize({ ...request, shardCount: 2, shardIndex: 0 })
  const shard1 = optimize({ ...request, shardCount: 2, shardIndex: 1 })
  const merged = [...shard0.results, ...shard1.results]
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, request.topN)

  assert(shard0.searched + shard1.searched === direct.searched, 'Sharded optimizer search count should sum to the single-thread exact count')
  assert(merged.length === direct.results.length, 'Sharded optimizer result count should match the direct exact search')
  assert(merged[0].items.join('|') === direct.results[0].items.join('|'), 'Sharded optimizer top build should match the direct exact search')
}

;{
  const request = {
    scenario: baseScenario([], [{ kind: 'ability', slot: 'A01' }, { kind: 'basic' }]),
    itemPool: ["Bumba's Hammer", 'Heartseeker', 'The Crusher', "Jotunn's Revenge", "Hydra's Lament", "Titan's Bane", 'Bloodforge', 'Deathbringer'],
    buildSize: 4,
    requireOneStarter: true,
    maxPermutations: 10,
    topN: 5,
  } satisfies Parameters<typeof optimize>[0]
  const shards = [0, 1, 2, 3].map((shardIndex) => optimize({ ...request, shardCount: 4, shardIndex }))
  const activeShards = shards.filter((result) => result.searched > 0).length
  const searchedTotal = shards.reduce((sum, result) => sum + result.searched, 0)
  assert(activeShards >= 3, `Sampled sharding with one starter should distribute work across shards, got ${activeShards} active shards`)
  assert(searchedTotal >= 30, `Sampled sharding should retain most of the total search budget across shards, got ${searchedTotal}`)
}

;{
  const scenario = baseScenario(["Titan's Bane", "Hydra's Lament"], [{ kind: 'ability', slot: 'A01' }, { kind: 'basic' }])
  const carry = optimize({
    scenario,
    itemPool: ["Bumba's Hammer", "Titan's Bane", "Hydra's Lament"],
    buildSize: 2,
    requireOneStarter: true,
    maxPermutations: 10,
    topN: 1,
    rankBy: 'powerSpike',
    role: 'carry',
    gameMode: 'casual',
  })
  const support = optimize({
    scenario,
    itemPool: ["Bumba's Hammer", "Titan's Bane", "Hydra's Lament"],
    buildSize: 2,
    requireOneStarter: true,
    maxPermutations: 10,
    topN: 1,
    rankBy: 'powerSpike',
    role: 'support',
    gameMode: 'casual',
  })

  assert(carry.results.length === 1, 'Power-spike carry regression should produce exactly one fixed build')
  assert(support.results.length === 1, 'Power-spike support regression should produce exactly one fixed build')

  const carryOrder = carry.results[0].buildOrder ?? []
  const supportOrder = support.results[0].buildOrder ?? []
  assert(carryOrder.length === 3, 'Power-spike build order should include starter + two locked items')
  assert(carryOrder[0].name === "Bumba's Hammer", 'Starter should be the first powerspike step')
  assert(close(carryOrder[0].estimatedMinute, 0), `Starter should land at minute 0, got ${carryOrder[0].estimatedMinute}`)
  assert(carryOrder[0].projectedLevel === 1, `Starter should project to level 1, got ${carryOrder[0].projectedLevel}`)
  assert(carryOrder[1].projectedLevel < 20, `First purchased item should be re-simmed before level 20, got ${carryOrder[1].projectedLevel}`)
  assert(carry.results[0].powerSpike?.peakItem != null, 'Power-spike result should expose a peak step summary')
  assert((carry.results[0].powerSpike?.peakMinute ?? 0) > 0, 'Power-spike summary should report a post-starter purchase minute')
  assert((carry.results[0].powerSpike?.peakMarginalDamage ?? 0) > 0, 'Power-spike summary should report a positive peak marginal damage')
  assert(carryOrder[1].estimatedMinute < supportOrder[1].estimatedMinute, 'Carry powerspike timings should land earlier than support for the same build path')
  assert(carry.results[0].rankScore > support.results[0].rankScore, 'Carry should score a stronger powerspike than support on the same locked build because it reaches items sooner')
}

;{
  const mixedRotation = [{ kind: 'ability', slot: 'A01' }, { kind: 'basic' }, { kind: 'basic' }, { kind: 'basic' }] as Scenario['rotation']
  const request = {
    scenario: baseScenario([], mixedRotation),
    itemPool: ["Bumba's Hammer", 'Rage', 'Demon Blade', "Hydra's Lament", 'Heartseeker'],
    buildSize: 2,
    requireOneStarter: true,
    maxPermutations: 20,
    topN: 10,
    rankBy: 'dps',
  } satisfies Parameters<typeof optimize>[0]
  const leaders = optimize(request)
  assert(leaders.styleLeaders?.auto != null, 'Optimizer should expose an auto style leader')
  assert(leaders.styleLeaders?.ability != null, 'Optimizer should expose an ability style leader')
  assert((leaders.styleLeaders?.auto?.autoShare ?? 0) > (leaders.styleLeaders?.ability?.autoShare ?? 0), 'Auto style leader should preserve more basic damage share than the ability leader')
  assert((leaders.styleLeaders?.ability?.abilityShare ?? 0) > (leaders.styleLeaders?.auto?.abilityShare ?? 0), 'Ability style leader should preserve more ability damage share than the auto leader')

  const autoFocused = optimize({ ...request, damageProfile: 'auto' })
  const abilityFocused = optimize({ ...request, damageProfile: 'ability' })
  assert((autoFocused.results[0]?.profile?.autoShare ?? 0) > (abilityFocused.results[0]?.profile?.autoShare ?? 0), 'Auto-focused optimizer should bias the top build toward more basic damage share')
  assert((abilityFocused.results[0]?.profile?.abilityShare ?? 0) > (autoFocused.results[0]?.profile?.abilityShare ?? 0), 'Ability-focused optimizer should bias the top build toward more ability damage share')
}

console.log('Sim regression tests passed.')
