#!/usr/bin/env tsx

import { getItem } from '../src/catalog/loadCatalogs.ts'
import { getFinalBuildItemExclusionReason } from '../src/catalog/itemEligibility.ts'
import { optimize } from '../src/optimizer/optimize.ts'
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
  const bare = snapshotAttacker(baseScenario([], [])) as { inhandPower: number; adaptiveStrength: number }
  const sun = snapshotAttacker(baseScenario(['Sun Beam Bow'], [])) as { inhandPower: number; adaptiveStrength: number }
  assert(close(sun.inhandPower - bare.inhandPower, 10), `Sun Beam Bow InhandPower should add 10, got ${sun.inhandPower - bare.inhandPower}`)
  assert(close(sun.adaptiveStrength, 20), `Sun Beam Bow should add 20 Strength on Loki, got ${sun.adaptiveStrength}`)
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
  assert(close(ticks[2].preMitigation, 65.5042, 0.001), `Bluestone Brooch subsequent hit should use 50% damage, got ${ticks[2].preMitigation}`)
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

console.log('Sim regression tests passed.')
