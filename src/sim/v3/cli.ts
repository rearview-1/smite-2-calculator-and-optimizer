import { runScenario, type Scenario, type SimResult } from './engine.ts'

function f(n: number): string { return n.toFixed(2) }

interface CliSnapshotBase {
  god: { god: string }
  level: number
  maxHealth: number
  physicalProtection: number
  magicalProtection: number
}

interface CliAttackerSnapshot extends CliSnapshotBase {
  items: Array<{ displayName: string | null }>
  maxMana: number
  moveSpeed: number
  totalAttackSpeed: number
  inhandPower: number
  adaptiveStrength: number
  adaptiveIntelligence: number
  cooldownStat: number
  cdrPercent: number
  penFlat: number
  penPercent: number
  magicalPenFlat: number
  magicalPenPercent: number
  critChance: number
  primaryStat: string
}

type CliDefenderSnapshot = CliSnapshotBase

function printResult(result: SimResult) {
  const a = result.attackerSnapshot as CliAttackerSnapshot
  const d = result.defenderSnapshot as CliDefenderSnapshot

  console.log('\n=== ' + result.scenarioTitle + ' ===\n')

  console.log('Attacker snapshot:')
  console.log('  God                         ' + a.god.god + ' (lvl ' + a.level + ')')
  console.log('  Items                       ' + a.items.map((i) => i.displayName).join(', '))
  console.log('  MaxHealth                   ' + f(a.maxHealth))
  console.log('  MaxMana                     ' + f(a.maxMana))
  console.log('  PhysicalProtection          ' + f(a.physicalProtection))
  console.log('  MagicalProtection           ' + f(a.magicalProtection))
  console.log('  MovementSpeed               ' + f(a.moveSpeed))
  console.log('  TotalAttackSpeed            ' + f(a.totalAttackSpeed))
  console.log('  InhandPower                 ' + f(a.inhandPower))
  console.log('  Strength (adaptive)         ' + f(a.adaptiveStrength))
  console.log('  Intelligence (adaptive)     ' + f(a.adaptiveIntelligence))
  console.log('  Cooldown Stat / CDR %       ' + f(a.cooldownStat) + ' / ' + f(a.cdrPercent))
  console.log('  Physical Pen Flat / %       ' + f(a.penFlat) + ' / ' + f(a.penPercent))
  console.log('  Magical Pen Flat / %        ' + f(a.magicalPenFlat) + ' / ' + f(a.magicalPenPercent))
  console.log('  Crit Chance %               ' + f(a.critChance))
  console.log('  primaryStat                 ' + a.primaryStat)

  console.log('\nDefender snapshot:')
  console.log('  God                         ' + d.god.god + ' (lvl ' + d.level + ')')
  console.log('  MaxHealth                   ' + f(d.maxHealth))
  console.log('  PhysicalProtection          ' + f(d.physicalProtection))
  console.log('  MagicalProtection           ' + f(d.magicalProtection))

  if (result.assumptions.length) {
    console.log('\nAssumptions:')
    for (const n of result.assumptions) console.log('  - ' + n)
  }
  if (result.warnings.length) {
    console.log('\nWarnings:')
    for (const n of result.warnings) console.log('  - ' + n)
  }

  console.log('\nDamage events:')
  console.log('  ' + 't'.padEnd(7) + 'Label'.padEnd(44) + 'Source'.padEnd(10) + 'Type'.padEnd(10) + 'Pre'.padStart(10) + 'Post'.padStart(10))
  for (const ev of result.damageEvents) {
    console.log('  ' + f(ev.t).padEnd(7) + ev.label.padEnd(44) + ev.source.padEnd(10) + ev.damageType.padEnd(10) + f(ev.preMitigation).padStart(10) + f(ev.postMitigation).padStart(10))
    if (ev.notes) for (const n of ev.notes) console.log('         · ' + n)
  }

  console.log('\nTotals:')
  console.log('  Physical  ' + f(result.totals.physical))
  console.log('  Magical   ' + f(result.totals.magical))
  console.log('  True      ' + f(result.totals.true))
  console.log('  TOTAL     ' + f(result.totals.total))
  console.log('  Combat t  ' + f(result.totalCombatTime) + 's  (incl post-combo DoT/ticks)')
  console.log('  Combo t   ' + f(result.comboExecutionTime) + 's  (press-1 to last input)')
  if (result.defenderDefeatedAt !== undefined) {
    console.log('  Kill t    ' + f(result.defenderDefeatedAt) + 's')
  }

  if (result.perAttackerTotals) {
    console.log('\nPer-attacker totals:')
    for (const [name, v] of Object.entries(result.perAttackerTotals)) {
      console.log('  ' + name.padEnd(20) + f(v))
    }
  }
  if (result.timeAwareItems && result.timeAwareItems.length > 0) {
    console.log('\nTime-aware items (ramp profiles):')
    for (const r of result.timeAwareItems) {
      console.log('  ' + r.itemName.padEnd(24) + '[' + r.ramp + ' → full at ' + r.secondsToFull + 's]  ' + r.effectAtFull)
    }
  }
  console.log('  Overkill  ' + f(result.overkill))

  console.log('\nDamage by source:')
  for (const [source, v] of Object.entries(result.bySource)) {
    console.log('  ' + source.padEnd(10) + f(v as number))
  }
  console.log('\nTop labels:')
  const top = Object.entries(result.byLabel).sort((a, b) => (b[1] as number) - (a[1] as number)).slice(0, 10)
  for (const [label, v] of top) {
    console.log('  ' + label.padEnd(44) + f(v as number))
  }
}

// --- Scenarios ---

const lokiVanishMaxRank: Scenario = {
  title: 'Loki lvl20, rank-5 Vanish, Oath-Sworn Spear only, vs lvl10 Kukulkan',
  attacker: {
    godId: 'Loki',
    level: 20,
    abilityRanks: { A01: 5, A02: 1, A03: 1, A04: 1 },
    items: ['Oath-Sworn Spear'],
  },
  defender: { godId: 'Kukulkan', level: 10 },
  rotation: [{ kind: 'ability', slot: 'A01', label: 'Vanish (rank 5)' }],
}

const kaliComboRegression: Scenario = {
  title: 'Kali lvl6 (Bumba + Hydra) vs lvl9 Kukulkan — combo AA+3+AA (regression)',
  attacker: {
    godId: 'Kali',
    level: 6,
    abilityRanks: { A01: 1, A02: 3, A03: 1, A04: 1 },
    items: ["Bumba's Cudgel", "Hydra's Lament"],
  },
  defender: { godId: 'Kukulkan', level: 9 },
  rotation: [
    { kind: 'basic', label: 'AA1' },
    { kind: 'ability', slot: 'A03', label: 'A3 Incense' },
    { kind: 'basic', label: 'AA2' },
  ],
  options: { penPercentOverride: 10 },
}

const lokiFlurryMaxRank: Scenario = {
  title: 'Loki lvl20, rank-5 Flurry Strike (full channel), Oath-Sworn Spear only, vs lvl10 Kukulkan',
  attacker: {
    godId: 'Loki',
    level: 20,
    abilityRanks: { A01: 1, A02: 1, A03: 5, A04: 1 },
    items: ['Oath-Sworn Spear'],
  },
  defender: { godId: 'Kukulkan', level: 10 },
  rotation: [{ kind: 'ability', slot: 'A03', label: 'Flurry Strike (rank 5)' }],
}

const lokiFullCombo: Scenario = {
  title: 'Loki lvl20 full combo 1→3→2→4, Oath-Sworn Spear only, vs lvl20 Kukulkan',
  attacker: {
    godId: 'Loki',
    level: 20,
    abilityRanks: { A01: 5, A02: 5, A03: 5, A04: 5 },
    items: ['Oath-Sworn Spear'],
  },
  defender: { godId: 'Kukulkan', level: 20 },
  rotation: [
    { kind: 'ability', slot: 'A01', label: 'Vanish' },
    { kind: 'ability', slot: 'A03', label: 'Flurry Strike' },
    { kind: 'ability', slot: 'A02', label: 'Agonizing Visions' },
    { kind: 'ability', slot: 'A04', label: 'Assassinate' },
  ],
}

const lokiAaCombo: Scenario = {
  title: 'Loki lvl20: 1 → AA → 2 → AA → 4 → AA → 3 (cancel) → AA  (combo-timing test)',
  attacker: {
    godId: 'Loki',
    level: 20,
    abilityRanks: { A01: 5, A02: 5, A03: 5, A04: 5 },
    items: ['Oath-Sworn Spear'],
  },
  defender: { godId: 'Kukulkan', level: 20 },
  rotation: [
    // "1 AA" is modeled as a single step — the Loki A01 handler already emits
    // the triggering Vanish shot as part of the ability. Do NOT add a separate
    // basic after, or the shot will be double-counted.
    { kind: 'ability', slot: 'A01', label: 'Vanish (+ stealth shot)' },
    { kind: 'ability', slot: 'A02', label: 'Agonizing Visions' },
    { kind: 'basic', label: 'AA (post-2)' },
    { kind: 'ability', slot: 'A04', label: 'Assassinate' },
    { kind: 'basic', label: 'AA (post-4)' },
    // Flurry cancel — estimate pending user measurement of cancel frame.
    { kind: 'ability', slot: 'A03', label: 'Flurry Strike (cancelled)', castDuration: 1.3 },
    { kind: 'basic', label: 'AA (post-3 cancel)' },
  ],
}

// --- Team comp scenario: Loki + Kali burst the same Kukulkan ---
const teamLokiKali: Scenario = {
  title: 'Team: Loki + Kali burst lvl20 Kukulkan (multi-attacker combo)',
  attacker: {
    godId: 'Loki',
    level: 20,
    abilityRanks: { A01: 5, A02: 5, A03: 5, A04: 5 },
    items: ['Oath-Sworn Spear'],
  },
  defender: { godId: 'Kukulkan', level: 20 },
  rotation: [
    { kind: 'ability', slot: 'A01' },
    { kind: 'ability', slot: 'A03', label: 'Flurry' },
    { kind: 'ability', slot: 'A04', label: 'Assassinate' },
  ],
  teamAttackers: [
    {
      godId: 'Kali',
      level: 20,
      abilityRanks: { A01: 5, A02: 5, A03: 5, A04: 5 },
      items: ["Bumba's Cudgel", "Hydra's Lament"],
      title: 'Kali-ally',
      rotation: [
        { kind: 'basic' },
        { kind: 'ability', slot: 'A03', label: 'Incense' },
        { kind: 'basic' },
        { kind: 'basic' },
      ],
    },
  ],
}

printResult(runScenario(lokiVanishMaxRank))
printResult(runScenario(lokiFlurryMaxRank))
printResult(runScenario(lokiFullCombo))
printResult(runScenario(kaliComboRegression))
printResult(runScenario(lokiAaCombo))
printResult(runScenario(teamLokiKali))
