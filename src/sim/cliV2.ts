import { runScenario, type Scenario } from './runScenarioV2.ts'

function f(n: number): string { return n.toFixed(2) }

function printResult(s: Scenario) {
  const result = runScenario(s)
  console.log('\n=== ' + result.scenario.title + ' ===\n')
  const a = result.scenario.attacker
  const d = result.scenario.defender
  console.log('Attacker snapshot:')
  console.log('  God                         ' + a.god.god + ' (lvl ' + a.level + ')')
  console.log('  MaxHealth                   ' + f(a.maxHealth))
  console.log('  MaxMana                     ' + f(a.maxMana))
  console.log('  HealthPerTime               ' + f(a.healthPerTime))
  console.log('  ManaPerTime                 ' + f(a.manaPerTime))
  console.log('  PhysicalProtection          ' + f(a.physicalProtection))
  console.log('  MagicalProtection           ' + f(a.magicalProtection))
  console.log('  MovementSpeed               ' + f(a.moveSpeed))
  console.log('  BaseAttackSpeed             ' + f(a.baseAttackSpeed))
  console.log('  AttackSpeedPercent          ' + f(a.attackSpeedPercent))
  console.log('  TotalAttackSpeed            ' + f(a.totalAttackSpeed))
  console.log('  InhandPower                 ' + f(a.inhandPower))
  console.log('  Strength (adaptive)         ' + f(a.adaptiveStrength))
  console.log('  Intelligence (adaptive)     ' + f(a.adaptiveIntelligence))
  console.log('  CooldownReduction %         ' + f(a.cdrPercent))
  console.log('  Physical Pen Flat           ' + f(a.penFlat))
  console.log('  Physical Pen %              ' + f(a.penPercent))

  console.log('\nDefender snapshot:')
  console.log('  God                         ' + d.god.god + ' (lvl ' + d.level + ')')
  console.log('  MaxHealth                   ' + f(d.maxHealth))
  console.log('  PhysicalProtection          ' + f(d.physicalProtection))
  console.log('  MagicalProtection           ' + f(d.magicalProtection))

  console.log('\nAssumptions:')
  for (const note of result.assumptions) console.log('  - ' + note)

  console.log('\nDamage events:')
  console.log('  ' + 'Label'.padEnd(34) + 'Source'.padEnd(10) + 'Type'.padEnd(10) + 'Pre'.padStart(10) + 'Post'.padStart(10))
  for (const ev of result.events) {
    console.log('  ' + ev.label.padEnd(34) + ev.source.padEnd(10) + ev.damageType.padEnd(10) + f(ev.preMitigation).padStart(10) + f(ev.postMitigation).padStart(10))
    if (ev.notes) for (const n of ev.notes) console.log('      · ' + n)
  }

  console.log('\nTotals:')
  console.log('  Physical  ' + f(result.totals.physical))
  console.log('  Magical   ' + f(result.totals.magical))
  console.log('  True      ' + f(result.totals.true))
  console.log('  TOTAL     ' + f(result.totals.total))
  console.log('  Overkill  ' + f(result.overkill))
}

// Scenario: Kali lvl 6 (Bumba + Hydra) vs lvl 9 Kukulkan, AA + A3 + AA
const scenario: Scenario = {
  title: 'Kali lvl6 (Bumba + Hydra) vs lvl9 Kukulkan — combo AA+3+AA',
  attacker: {
    godId: 'Kali',
    level: 6,
    abilityRanks: { A01: 1, A02: 3, A03: 1, A04: 1 },
    items: ["Bumba's Cudgel", "Hydra's Lament"],
  },
  defender: {
    godId: 'Kukulkan',
    level: 9,
    items: [],
  },
  rotation: [
    { kind: 'basic', label: 'AA1' },
    { kind: 'ability', slot: 'A03', label: 'A3 Incense' },
    { kind: 'basic', label: 'AA2' },
  ],
  options: { penPercentOverride: 10 }, // +10% pen (from site; pending in-game confirmation)
}

printResult(scenario)
