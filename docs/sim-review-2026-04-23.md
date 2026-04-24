# Sim code review — 2026-04-23

An intensive review of the damage simulator against all 81 cataloged gods plus stat-scaling scenarios. Driven by the user's concern that physical builds might be running magical-only items (e.g., Obsidian Shard) without the sim properly zeroing out off-type stats.

## What was verified ✅

### 1. Stat-scaling isolation is mathematically correct

The core damage formula at [src/sim/v3/engine.ts:730](src/sim/v3/engine.ts#L730) is:

```
baseDamage + perLevelDamage * level + strTotal * strScaling + intTotal * intScaling
```

A pure-Strength ability has `intScaling = 0`, so `intTotal * 0 = 0` regardless of how much Intelligence the attacker has. Strength-only builds **cannot leak** Intelligence into their damage. Verified empirically with Loki + Obsidian Shard: his adaptiveIntelligence went 0 → 60 but **zero** magical damage was produced. Adding Obsidian Shard gave him +168 physical damage (~17%) solely from the item's 35% PhysicalPenetrationPercent.

**Obsidian Shard provenance**: the item is internally keyed `item.Balor's Eye` with icon `Icon_T3_BalorsEye`. It grants MagicalPower 60, PhysicalPenetrationPercent 35, MagicalPenetrationPercent 35 — so it's actually a hybrid pen item, not "magical only." The 35% physical pen is legitimate value for strength builds even though the +60 MagicalPower is wasted.

### 2. Sim damage classification is correct even when catalog metadata is null

For 10 gods whose catalog `damageType` field is `null`, the sim still produces damage events with the correct `damageType` tag by falling back to scaling-tag inference. Verified for Artemis A04, Chaac A01, Thanatos A02, Cernunnos A01, Fenrir A04 — all emit `damageType: 'physical'` correctly even though their catalog metadata is incomplete.

### 3. Existing regression tests pass

`npx tsx scripts/sim-regression-tests.ts` → `Sim regression tests passed.` The Loki combo (1352.92 vs in-game 1348) plus 3 other guarded scenarios are green.

## Fix applied

### `build-gods-catalog.py` now detects damage in all GE files, not just `*Damage*`-named ones

Previously `read_damage_ge` globbed only `GE_*Damage*.structure.json`, missing abilities where damage lives in differently-named GEs:

- `GE_*_Hit` (Hades Pillar of Agony — channel tick damage)
- `GE_*_Tick` (DoT helper)
- `GE_*_BoarAttack` (Artemis Calydonian Boar pet)
- `GE_*_Thunderstrike` / `_PushDamage` / etc.

The fix scans every `GE_*.structure.json` for the ability slot, then accepts any file whose `names` list contains an `Effect.Type.Damage.*` tag. Cut catalog `damageType`-null anomalies from 15 → 10.

Also widened to accept `.uasset.structure.json` files (the only form that exists for Anhur, whose folder is typo'd `Ablities` and has no plain `.structure.json` variant). Only `GameplayCue` files (`_GC_`) are skipped.

## Known gaps (not sim bugs)

### Baron_Samedi — zero damage across all 4 abilities

His ability CTs exist only as `.uasset.bin` + `.uasset.structure.json` — the `.exports.json` outputs were never produced by the asset probe. Without parsed rank values, the sim has no numbers to work with. **Fix requires re-running the asset probe with full export enabled for these files**; not addressable from the sim side.

### 10 abilities still show catalog `damageType: null`

Mostly pet/summon abilities (Artemis Boar), basic-attack modifiers (Cernunnos Shifter of Seasons, Fenrir Ragnarok transform), or summon ultimates. The damage tag lives in a companion asset's folder (e.g., `Artemis_Familiar/`), not the caster's. The sim still correctly classifies these at runtime. Cosmetic-only issue.

List: Artemis A04, Bari A01, Cernunnos A01, Chaac A01, Fenrir A04, Gilgamesh A02, Izanami A01, Ne_Zha A02, Thanatos A02, Ganesha A02 (different reason — aspect-only damage).

### 3 items have `statTags` but empty `storeFloats`

Items contribute 0 stats in sim currently. Item-extraction gap, not a sim bug:
- Dagger of Frenzy
- Eros' Bow
- Eye of Providence

### All 144 T3 items missing `totalCost`

The Python augmenter `scripts/augment-catalog-with-costs.py` has never been run. Optimizer falls back to `DEFAULT_TIER_COSTS` (T3 = 2800g flat). Build-order and power-spike scoring use these fallbacks — accurate in aggregate, individual items deviate ~±30% from their true cost.

## What I DID NOT audit

- Per-god handler correctness beyond spot checks (100% would require comparing against in-game testing, one god at a time).
- Item passives (e.g., Soul Reaver's stacking, Transcendence mana-to-power conversion) beyond the ones already covered by existing regression scenarios.
- Buff stacking edge cases (multi-source crit chance, conflicting power-buff semantics).
- Defender stat modeling — only sampled via Kukulkan, didn't verify different tank archetypes.
- Aspect damage for the 39 gods that show `NO_DELTA` in the aspect audit — documented separately in [docs/aspects-coverage.md](docs/aspects-coverage.md).

These are out of scope for a one-session audit but should be on the list for a future pass if time permits.

## Harness to reproduce

- Roster sim audit: `c:/tmp/sim-roster-audit.js`
- Stat-leak trace: `c:/tmp/obsidian-trace.js`
- Regression tests: `npx tsx scripts/sim-regression-tests.ts`
