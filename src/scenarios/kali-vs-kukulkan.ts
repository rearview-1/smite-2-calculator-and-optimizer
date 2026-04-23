import { loadKali } from '../catalog/gods/kali.ts'
import { loadKukulkan } from '../catalog/gods/kukulkan.ts'
import {
  bluestonePendant,
  bookOfThoth,
  bumbasCudgel,
  hydrasLament,
  polynomicon,
} from '../catalog/items.ts'
import type { Scenario } from '../sim/types.ts'

export function buildKaliVsKukulkan(): Scenario {
  const kali = loadKali()
  const kukulkan = loadKukulkan()

  return {
    title: 'Kali lvl6 (Bumba + Hydra) → Kukulkan lvl9 (Bluestone + stacked Thoth + Polynomicon), combo 1+AA+1',
    attacker: {
      god: kali,
      godLevel: 6,
      abilityRanks: { A1: 1, A2: 3, A3: 1, A4: 1, Passive: 1 },
      items: [bumbasCudgel, hydrasLament],
    },
    defender: {
      god: kukulkan,
      godLevel: 9,
      items: [bluestonePendant, bookOfThoth, polynomicon],
    },
    rotation: [
      { kind: 'ability', slot: 'A1', label: 'A1 (first)' },
      { kind: 'basic', label: 'AA1' },
      { kind: 'ability', slot: 'A1', label: 'A1 (second)' },
    ],
  }
}
