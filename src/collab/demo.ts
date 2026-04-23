/**
 * Two-session collab demo. Runs two YjsBuildRepository instances against a
 * shared relay server and shows:
 *   1. Both sessions see each other (presence)
 *   2. Alice creates a build; Bob receives it
 *   3. Alice + Bob edit different parts simultaneously; both converge
 *   4. Bob runs the synced build through the sim to prove it round-trips
 *
 * Prereq: start the relay server in a separate terminal:
 *     npm run collab:server
 *
 * Then run this:
 *     npm run collab:demo
 */

import { YjsBuildRepository } from './yjsBuildRepository.ts'
import { runScenario } from '../sim/v3/engine.ts'
import { buildToScenario } from './buildDoc.ts'
// WebSocket constructor isn't available globally in Node older than 22; y-websocket
// auto-detects and uses `ws`, but we set it explicitly to avoid surprises.
import { WebSocket as NodeWebSocket } from 'ws'
;(globalThis as unknown as { WebSocket: typeof NodeWebSocket }).WebSocket = NodeWebSocket

const WS_URL = process.env.COLLAB_URL ?? 'ws://localhost:4455'

async function sleep(ms: number) { await new Promise((r) => setTimeout(r, ms)) }

function banner(title: string) {
  console.log('\n' + '─'.repeat(60))
  console.log(title)
  console.log('─'.repeat(60))
}

async function main() {
  const alice = new YjsBuildRepository({
    wsUrl: WS_URL, userId: 'alice', userName: 'Alice', userColor: '#f56565',
  })
  const bob = new YjsBuildRepository({
    wsUrl: WS_URL, userId: 'bob', userName: 'Bob', userColor: '#4fd1c5',
  })

  banner('1. Alice creates a build')
  const created = await alice.createNew({
    title: 'Loki burst demo (collab test)',
    godId: 'Loki', level: 20,
  })
  const buildId = created.id
  console.log(`   created: ${created.title}  id=${buildId}  v${created.version}`)

  banner('2. Bob opens the same build')
  const bobUnsubPresence = bob.subscribePresence(buildId, (peers) => {
    const names = peers.map((p) => `${p.userName}${p.isMe ? '*' : ''}`).join(', ')
    console.log(`   [bob-presence] peers: ${names}`)
  })
  const bobSeen = await bob.get(buildId)
  console.log(`   bob sees: "${bobSeen?.title}" v${bobSeen?.version} — owner=${bobSeen?.ownerId}`)

  await sleep(200)

  banner('3. Concurrent edits — Alice changes items, Bob builds the rotation')
  const aliceUnsub = alice.subscribe(buildId, (d) => {
    console.log(`   [alice-recv] v${d.version}  last=${d.lastEditorId}  rotation=[${d.rotation.map((r) => r.kind).join(',')}]  items=[${d.attacker.items.join(', ')}]`)
  })
  const bobUnsub = bob.subscribe(buildId, (d) => {
    console.log(`   [bob-recv]   v${d.version}  last=${d.lastEditorId}  rotation=[${d.rotation.map((r) => r.kind).join(',')}]  items=[${d.attacker.items.join(', ')}]`)
  })

  alice.applyPatch(buildId, (p) => {
    p.setTitle('Loki burst demo v2')
    p.setAttacker({
      godId: 'Loki', level: 20,
      abilityRanks: { A01: 5, A02: 5, A03: 5, A04: 5 },
      items: ['Oath-Sworn Spear'],
    })
  })
  bob.applyPatch(buildId, (p) => {
    p.appendRotationStep({ kind: 'ability', slot: 'A01', label: 'Vanish' })
    p.appendRotationStep({ kind: 'ability', slot: 'A03', label: 'Flurry' })
  })
  bob.applyPatch(buildId, (p) => {
    p.appendRotationStep({ kind: 'ability', slot: 'A02', label: 'Visions' })
    p.appendRotationStep({ kind: 'ability', slot: 'A04', label: 'Assassinate' })
  })

  await sleep(500)

  banner('4. Bob runs the synced build through the sim')
  const synced = await bob.get(buildId)
  if (!synced) throw new Error('build vanished after sync')
  const scenario = buildToScenario(synced)
  const result = runScenario(scenario)
  console.log(`   "${result.scenarioTitle}"`)
  console.log(`   total = ${result.totals.total.toFixed(2)}  combo t = ${result.comboExecutionTime.toFixed(2)}s`)
  console.log(`   rotation resolved: ${synced.rotation.map((r) => r.label ?? r.kind).join(' → ')}`)

  banner('5. Cleanup')
  aliceUnsub()
  bobUnsub()
  bobUnsubPresence()
  await alice.dispose()
  await bob.dispose()
  console.log('   done.')

  // Ensure the process exits (y-websocket keeps handles open).
  setTimeout(() => process.exit(0), 100)
}

main().catch((err) => {
  console.error('demo failed:', err)
  process.exit(1)
})
