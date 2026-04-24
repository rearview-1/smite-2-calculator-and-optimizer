#!/usr/bin/env tsx

import { loadItems } from '../src/catalog/loadCatalogs.ts'
import { getFinalBuildItemExclusionReason, isCatalogHelperItem } from '../src/catalog/itemEligibility.ts'
import { getItemProcs, type ItemProc } from '../src/sim/v3/itemEffects.ts'

type Item = ReturnType<typeof loadItems>[string]

function normalizePassive(text: string | null | undefined): string {
  return (text ?? '').replace(/[â€¢Â·]/g, ' ').replace(/\s+/g, ' ').trim()
}

function close(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps
}

function findProc<T extends ItemProc['kind']>(procs: ItemProc[], kind: T): Extract<ItemProc, { kind: T }> | undefined {
  return procs.find((proc): proc is Extract<ItemProc, { kind: T }> => proc.kind === kind)
}

function issue(item: Item, text: string): string {
  return `  - ${item.displayName ?? item.internalKey ?? 'unknown'} (${item.internalKey ?? 'unknown'}): ${text}`
}

const items = Object.values(loadItems())
  .filter((item) => !isCatalogHelperItem(item))
  .filter((item) => getFinalBuildItemExclusionReason(item) === null)
  .filter((item) => (item.passive ?? '').trim().length > 0)

const issues: string[] = []

for (const item of items) {
  const passive = normalizePassive(item.passive)
  const procs = getItemProcs(item)

  if (/(?:On Use|Active):/i.test(passive) && !procs.some((proc) => proc.kind.startsWith('activeUse_'))) {
    issues.push(issue(item, 'active tooltip has no active-use proc/utility representation in the sim'))
  }

  const teleport = /(?:On Use|Active):\s*(?:You are\s+)?Teleported?\s+to\s+(?:a\s+targeted\s+location\s+)?up to\s*(\d+(?:\.\d+)?)m/i.exec(passive)
    ?? /(?:On Use|Active):\s*Teleport\s*up to\s*(\d+(?:\.\d+)?)m/i.exec(passive)
  if (teleport) {
    const proc = findProc(procs, 'activeUse_teleport')
    if (!proc) {
      issues.push(issue(item, `teleport tooltip (${teleport[1]}m) is missing an activeUse_teleport proc`))
    } else if (!close(proc.rangeMeters, Number(teleport[1]))) {
      issues.push(issue(item, `teleport range mismatch: tooltip ${teleport[1]}m vs sim ${proc.rangeMeters}m`))
    }
  }

  const poly = /Ability Used:[\s\S]*?Damage\s*=\s*(\d+(?:\.\d+)?)%\s*of your Intelligence/i.exec(passive)
  if (poly) {
    const proc = findProc(procs, 'onAbilityCast_nextBasicScalingDamage')
    if (!proc) {
      issues.push(issue(item, `tooltip implies a next-basic INT scaling proc, but none is wired`))
    } else if (!close(proc.intScaling, Number(poly[1]) / 100)) {
      issues.push(issue(item, `next-basic INT scaling mismatch: tooltip ${poly[1]}% vs sim ${(proc.intScaling * 100).toFixed(1)}%`))
    }
  }

  const targetHealth = /(Ability|Attack) Hit[\s\S]*?Bonus Damage\s*=\s*\+?(\d+(?:\.\d+)?)%\s*Target Base Health\s*&\s*\+?(\d+(?:\.\d+)?)%\s*Target Item Health(?:,\s*dealt\s*(\d+)\s*times\s*over\s*(\d+(?:\.\d+)?)s)?/i.exec(passive)
  if (targetHealth) {
    const trigger = targetHealth[1].toLowerCase() === 'ability' ? 'onAbilityHit_targetHealthDamage' : 'onBasicHit_targetHealthDamage'
    const proc = trigger === 'onAbilityHit_targetHealthDamage'
      ? findProc(procs, 'onAbilityHit_targetHealthDamage')
      : findProc(procs, 'onBasicHit_targetHealthDamage')
    if (!proc) {
      issues.push(issue(item, `${targetHealth[1]} target-health proc is missing from the sim`))
    } else {
      if (!close(proc.baseHealthPct, Number(targetHealth[2]) / 100)) {
        issues.push(issue(item, `target base-health scaling mismatch: tooltip ${targetHealth[2]}% vs sim ${(proc.baseHealthPct * 100).toFixed(2)}%`))
      }
      if (!close(proc.itemHealthPct, Number(targetHealth[3]) / 100)) {
        issues.push(issue(item, `target item-health scaling mismatch: tooltip ${targetHealth[3]}% vs sim ${(proc.itemHealthPct * 100).toFixed(2)}%`))
      }
      if ('ticks' in proc && targetHealth[4]) {
        const ticks = Number(targetHealth[4])
        const duration = Number(targetHealth[5])
        if (proc.ticks !== ticks) {
          issues.push(issue(item, `tick-count mismatch: tooltip ${ticks} vs sim ${proc.ticks}`))
        }
        const expectedTickRate = duration / ticks
        if (!close(proc.tickRate, expectedTickRate)) {
          issues.push(issue(item, `tick-rate mismatch: tooltip ${expectedTickRate}s vs sim ${proc.tickRate}s`))
        }
      }
    }
  }

  const antiHeal = /Apply\s+(\d+(?:\.\d+)?)%\s+Healing Reduction\s+for\s+(\d+(?:\.\d+)?)s/i.exec(passive)
  if (antiHeal) {
    const proc = findProc(procs, 'onHit_enemyDebuff')
    if (!proc) {
      issues.push(issue(item, `healing-reduction tooltip is missing an enemy-debuff proc`))
    } else {
      const healingReduction = Math.abs(proc.modifiers.HealingReduction ?? 0)
      if (!close(healingReduction, Number(antiHeal[1]))) {
        issues.push(issue(item, `healing-reduction amount mismatch: tooltip ${antiHeal[1]}% vs sim ${healingReduction}%`))
      }
      if (!close(proc.durationSeconds, Number(antiHeal[2]))) {
        issues.push(issue(item, `healing-reduction duration mismatch: tooltip ${antiHeal[2]}s vs sim ${proc.durationSeconds}s`))
      }
    }
  }

  const flatDamage = /(Physical|Magical|Magic|True)\s+Damage\s*=\s*(\d+(?:\.\d+)?)(?:\s*\+\s*(\d+(?:\.\d+)?)%\s*Intelligence)?/i.exec(passive)
  if (flatDamage && /Chain Lighting/i.test(passive)) {
    const proc = findProc(procs, 'onHit_bonusDamage') ?? findProc(procs, 'onAbilityHit_bonusDamage')
    if (!proc) {
      issues.push(issue(item, 'chain-damage tooltip is missing a bonus-damage proc'))
    } else {
      if (!close(proc.baseDamage, Number(flatDamage[2]))) {
        issues.push(issue(item, `base damage mismatch: tooltip ${flatDamage[2]} vs sim ${proc.baseDamage}`))
      }
      const intScaling = flatDamage[3] ? Number(flatDamage[3]) / 100 : 0
      if (!close(proc.intScaling, intScaling)) {
        issues.push(issue(item, `INT scaling mismatch: tooltip ${(intScaling * 100).toFixed(1)}% vs sim ${(proc.intScaling * 100).toFixed(1)}%`))
      }
    }
  }

  const cooldown = /Cooldown:\s*(\d+(?:\.\d+)?)s/i.exec(passive)
  if (cooldown) {
    const expected = Number(cooldown[1])
    const cooldownProc = procs.find((proc) =>
      'cooldown' in proc
      && typeof proc.cooldown === 'number'
      && proc.cooldown > 0)
    if (cooldownProc && !close(cooldownProc.cooldown, expected)) {
      issues.push(issue(item, `cooldown mismatch: tooltip ${expected}s vs sim ${cooldownProc.cooldown}s`))
    }
  }

  if (/Silenced?\s+for\s+(\d+(?:\.\d+)?)s/i.test(passive)) {
    const silence = findProc(procs, 'activeUse_cc')
    if (!silence || silence.flavor !== 'silence') {
      issues.push(issue(item, 'silence tooltip is not represented in active-use procs'))
    }
  }
}

console.log('=== Item description audit ===')
console.log(`Final-build items with passive text: ${items.length}`)
console.log(`Issues: ${issues.length}`)

if (issues.length > 0) {
  console.error(issues.slice(0, 80).join('\n'))
  process.exitCode = 1
} else {
  console.log('Item descriptions and wired sim hooks are aligned for the audited patterns.')
}
