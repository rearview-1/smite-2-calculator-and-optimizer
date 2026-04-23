import { loadItems } from '../src/catalog/loadCatalogs.ts'
import { getItemProcs } from '../src/sim/v3/itemEffects.ts'

const items = loadItems()
let total = 0, withPassive = 0, wiredProcs = 0
const procKinds = new Map<string, number>()
const unwired: Array<{ name: string; passive: string }> = []

for (const [, item] of Object.entries(items)) {
  total++
  const passive = (item.passive ?? '').trim()
  if (passive.length < 10) continue
  withPassive++
  const procs = getItemProcs(item)
  if (procs.length > 0) {
    wiredProcs++
    for (const p of procs) procKinds.set(p.kind, (procKinds.get(p.kind) ?? 0) + 1)
  } else {
    unwired.push({ name: item.displayName ?? '?', passive: passive.slice(0, 90) })
  }
}

console.log(`\nItem proc coverage:`)
console.log(`  total items:             ${total}`)
console.log(`  items with passive text: ${withPassive}`)
console.log(`  items with wired procs:  ${wiredProcs}  (${Math.round(wiredProcs / withPassive * 100)}%)`)
console.log(`\nProc-kind breakdown:`)
for (const [kind, n] of [...procKinds.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n.toString().padStart(4)}  ${kind}`)
}
console.log(`\nSample unwired (first 15):`)
for (const u of unwired.slice(0, 15)) {
  console.log(`  [${u.name}]: ${u.passive}`)
}
