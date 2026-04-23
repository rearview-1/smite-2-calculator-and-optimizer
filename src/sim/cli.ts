import { buildKaliVsKukulkan } from '../scenarios/kali-vs-kukulkan.ts'
import { runScenario, type RunOptions } from './runScenario.ts'
import type { SimResult } from './types.ts'

function formatNumber(n: number): string {
  return n.toFixed(2)
}

function printResult(result: SimResult) {
  console.log('\n=== ' + result.scenarioTitle + ' ===')
  console.log('\nAttacker snapshot:')
  for (const [k, v] of Object.entries(result.attackerSnapshot)) {
    console.log(`  ${k.padEnd(32)} ${formatNumber(v as number)}`)
  }
  console.log('\nDefender snapshot:')
  console.log(`  PhysicalProtection              ${formatNumber(result.defenderSnapshot.physicalProtection)}`)
  console.log(`  MagicalProtection               ${formatNumber(result.defenderSnapshot.magicalProtection)}`)
  console.log(`  MaxHealth                       ${formatNumber(result.defenderSnapshot.maxHealth)}`)

  console.log('\nAssumptions:')
  for (const a of result.assumptions) console.log('  - ' + a)

  console.log('\nDamage events:')
  console.log(
    '  ' +
      'Label'.padEnd(34) +
      'Source'.padEnd(22) +
      'Type'.padEnd(10) +
      'Pre'.padStart(10) +
      'Post'.padStart(10),
  )
  for (const ev of result.events) {
    console.log(
      '  ' +
        ev.label.padEnd(34) +
        ev.source.padEnd(22) +
        ev.damageType.padEnd(10) +
        formatNumber(ev.preMitigation).padStart(10) +
        formatNumber(ev.postMitigation).padStart(10),
    )
    if (ev.notes) for (const n of ev.notes) console.log('      · ' + n)
  }

  console.log('\nTotals:')
  console.log(`  Physical                        ${formatNumber(result.totals.physical)}`)
  console.log(`  Magical                         ${formatNumber(result.totals.magical)}`)
  console.log(`  True                            ${formatNumber(result.totals.true)}`)
  console.log(`  TOTAL                           ${formatNumber(result.totals.total)}`)
}

function main() {
  const scenario = buildKaliVsKukulkan()

  const variants: Array<{ title: string; opts: RunOptions }> = [
    {
      title: 'Variant A — site hardcode: A01 = 2 rupture stacks, Bumba post-ability does NOT stack',
      opts: { penPercentOverride: 10, kaliA01RuptureStacks: 2, bumbaPostAbilityStacks: false },
    },
    {
      title: 'Variant B — tooltip: A01 = 3 rupture stacks, Bumba post-ability does NOT stack',
      opts: { penPercentOverride: 10, kaliA01RuptureStacks: 3, bumbaPostAbilityStacks: false },
    },
    {
      title: 'Variant C — tooltip + Bumba post-ability stacks across ability casts',
      opts: { penPercentOverride: 10, kaliA01RuptureStacks: 3, bumbaPostAbilityStacks: true },
    },
  ]

  for (const v of variants) {
    console.log('\n\n################################################################')
    console.log('## ' + v.title)
    console.log('################################################################')
    printResult(runScenario(scenario, v.opts))
  }
}

main()
