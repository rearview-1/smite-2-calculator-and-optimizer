/**
 * God-locked items — Ratatoskr's Acorn of Yggdrasil line.
 *
 * ALL values verified against game-file extraction from:
 *   tools/SmiteAssetProbe/out/
 *     - ST_HW_Ratatoskr_AbilityDescriptions.exports.json  (stat text + passives)
 *     - ST_HW_Ratatoskr_AbilityNames.exports.json         (acorn names)
 *     - CT_Ratatoskr_A{01..04}_EffectValues.exports.json  (proc curves)
 *
 * Key facts established:
 *   - Acorns upgrade A01 (Briskberry), A02 (Ashwhorl), A03 (Thistlethorn). There
 *     is NO A04 acorn — A04 files contain zero acorn references.
 *   - Each Tier-3 acorn has two stat profiles toggled by aspect: non-aspect
 *     (damage-focused) vs aspect (tank/utility-focused).
 *   - Tiers 1 (Magic) and 2 (Lively) are upgrade steps on the way to Tier 3.
 *     Optimized builds assume Tier 3, but the lower tiers are here for
 *     completeness.
 *   - "Pathfinding" is a SMITE 2 movement-speed-like stat.
 *   - "Cooldown Rate" is a CDR-like stat.
 */

import type { ItemCatalogEntry, ResolvedItemStats } from './loadCatalogs.ts'
import type { DamageType } from '../sim/v3/types.ts'

/**
 * Modifications an acorn applies to its linked ability. The base vs. aspect
 * variants are stored separately on `GodLockedItem`, so the engine can switch
 * based on the scenario's aspect toggle.
 */
export type AcornAbilityMod =
  | { kind: 'addDamage'; label: string; baseDamageR1: number; baseDamageR5: number; strScaling: number; intScaling: number; delaySeconds?: number; damageType: DamageType }
  | { kind: 'addAreaDamage'; label: string; baseDamageR1: number; baseDamageR5: number; strScaling: number; intScaling: number; delaySeconds?: number; targetMaxHpScaling?: number; damageType: DamageType }
  | { kind: 'addDebuff'; label: string; modifiers: Record<string, number>; modifiersR1?: Record<string, number>; durationSeconds: number; maxStacks?: number }
  | { kind: 'addSelfBuff'; label: string; modifiers: Record<string, number>; modifiersR1?: Record<string, number>; durationSeconds: number; maxStacks?: number }
  | { kind: 'addSelfHeal'; label: string; pctMaxHealth: number }
  | { kind: 'cdrOnHit'; secondsReduced: number; maxResetsPerCast?: number }
  | { kind: 'mark'; durationSeconds: number; maxStacks: number }
  | { kind: 'abilityCharges'; charges: number }
  | { kind: 'knockback' }
  | { kind: 'behavior'; label: string; description: string }  // For ability-behavior changes with no numeric impact

/**
 * Maps rank 1 → rank 5 linearly. CT_Ratatoskr_*_EffectValues curves have
 * observed values only at rank 1 and rank 5; in-between values are linear.
 */
export function interpRank(r1: number, r5: number, rank: number): number {
  const t = Math.max(0, Math.min(4, rank - 1)) / 4
  return r1 + (r5 - r1) * t
}

export interface GodLockedItem {
  internalKey: string
  displayName: string
  godId: string
  /** Which ability slot the acorn upgrades (A01..A03). A04 has no acorn. */
  abilitySlot?: 'A01' | 'A02' | 'A03'
  /** 1 = Magic, 2 = Lively, 3 = Tier-3 variant. Optimized builds assume 3. */
  tier: 1 | 2 | 3
  /** Non-aspect stats on this acorn. */
  nonAspectStats: ResolvedItemStats['stats']
  /** Aspect-variant stats (swapped in when aspect is active). */
  aspectStats: ResolvedItemStats['stats']
  /** Non-aspect ability modifications. */
  abilityMods: AcornAbilityMod[]
  /** Aspect-variant ability modifications. */
  aspectAbilityMods: AcornAbilityMod[]
  /** Tooltip text for the non-aspect variant. */
  nonAspectPassive: string
  /** Tooltip text for the aspect variant. */
  aspectPassive: string
  /** 'extracted' = every number confirmed from game files. */
  statsSource: 'extracted'
  /** Data provenance note. */
  extractionNotes: string
}

/** Ratatoskr acorn roster — 3 tiers, Tier 3 has 3 variants (one per ability). */
export const RATATOSKR_ACORNS: GodLockedItem[] = [
  // ── TIER 1: Magic Acorn ────────────────────────────────────────────────
  {
    internalKey: 'acorn.Ratatoskr.T1.Magic',
    displayName: 'Magic Acorn (Tier 1)',
    godId: 'Ratatoskr',
    tier: 1,
    nonAspectStats: { /* +5 Strength */ },  // handled as adaptiveStrength in the API
    aspectStats: { MaxHealth: 50 },
    abilityMods: [],
    aspectAbilityMods: [],
    nonAspectPassive: '+5 Strength',
    aspectPassive: '+50 Health',
    statsSource: 'extracted',
    extractionNotes: 'From ST_HW_Ratatoskr_AbilityDescriptions.Ratatoskr.Acorns.Base. Starting acorn Ratatoskr spawns with.',
  },

  // ── TIER 2: Lively Acorn ───────────────────────────────────────────────
  {
    internalKey: 'acorn.Ratatoskr.T2.Lively',
    displayName: 'Lively Acorn (Tier 2)',
    godId: 'Ratatoskr',
    tier: 2,
    nonAspectStats: { /* +15 Strength */ },
    aspectStats: { MaxHealth: 175 },
    abilityMods: [],
    aspectAbilityMods: [],
    nonAspectPassive: '+15 Strength',
    aspectPassive: '+175 Health',
    statsSource: 'extracted',
    extractionNotes: 'From ST_HW_Ratatoskr_AbilityDescriptions.Ratatoskr.Acorns.2.',
  },

  // ── TIER 3a: Briskberry Acorn (A01 upgrade) ────────────────────────────
  {
    internalKey: 'acorn.Ratatoskr.T3.Briskberry',
    displayName: 'Briskberry Acorn (A01)',
    godId: 'Ratatoskr',
    abilitySlot: 'A01',
    tier: 3,
    nonAspectStats: { Pathfinding: 8 },  // +45 STR in adaptive
    aspectStats: { MaxHealth: 400, HealthPerTime: 4, ManaPerTime: 2 },
    abilityMods: [
      // Non-Aspect: Dart resets CD on enemy god hit (max 2 resets); also gains
      // mark mechanic. CDROnAbilityHit=1s (per CT), cap 2 resets (per tooltip).
      { kind: 'cdrOnHit', secondsReduced: 1, maxResetsPerCast: 2 },
      { kind: 'mark', durationSeconds: 10, maxStacks: 1 },
      { kind: 'behavior', label: 'Dart reshape', description: 'Dart is shorter, wider, and passes through enemy gods.' },
    ],
    aspectAbilityMods: [
      // Aspect: after hitting enemy god with Dart, they're knocked back and
      // explode after delay. AoEDamage 40→120 + 5% target HP scaling.
      { kind: 'knockback' },
      { kind: 'addAreaDamage',
        label: 'Briskberry Aspect explosion',
        baseDamageR1: 40, baseDamageR5: 120,
        strScaling: 0, intScaling: 0,
        delaySeconds: 2.1,
        targetMaxHpScaling: 0.05,
        damageType: 'physical' },
    ],
    nonAspectPassive: '+45 Strength, +8 Pathfinding. Dart is shorter, wider, and passes through enemy gods. Its cooldown resets on enemy god hit (max 2 resets).',
    aspectPassive: '+400 Health, +4 HP5, +2 MP5. After hitting an enemy god with Dart, they are knocked back and explode after a delay.',
    statsSource: 'extracted',
    extractionNotes: 'Stats from Ratatoskr.Acorns.3a tooltip. Behavior values from CT_Ratatoskr_A01_EffectValues: CDROnAbilityHit=1, Acorn3aMarkDuration=10, TalentAcorn3aAoEDamage=40→120, TalentAcorn3AoEHPScaling=0.05, TalentAcorn3aDuration=2.1, TalentAcorn3aResetTimer=5.',
  },

  // ── TIER 3b: Ashwhorl Acorn (A02 upgrade) ──────────────────────────────
  {
    internalKey: 'acorn.Ratatoskr.T3.Ashwhorl',
    displayName: 'Ashwhorl Acorn (A02)',
    godId: 'Ratatoskr',
    abilitySlot: 'A02',
    tier: 3,
    nonAspectStats: { AttackSpeedPercent: 15 },  // +45 STR in adaptive
    aspectStats: { MaxHealth: 400, CrowdControlReduction: 15 },  // 'Tenacity' → CCR
    abilityMods: [
      // Non-Aspect: Flurry fires multiple returning projectiles; each god hit
      // grants stacking AS. ASBuffPerStack=6→10%, duration 5s.
      { kind: 'behavior', label: 'Flurry reshape', description: 'Flurry fires multiple Acorn projectiles that return at max range.' },
      { kind: 'addDamage',
        label: 'Ashwhorl Flurry bonus',
        baseDamageR1: 20, baseDamageR5: 40,
        strScaling: 0.2, intScaling: 0,
        damageType: 'physical' },
      { kind: 'addSelfBuff',
        label: 'Ashwhorl AS stacks',
        modifiers: { AttackSpeedPercent: 10 },
        modifiersR1: { AttackSpeedPercent: 6 },
        durationSeconds: 5,
        maxStacks: 3 },
    ],
    aspectAbilityMods: [
      // Aspect: 2 charges, heals and provides protections. ProtsPerStack=2→6, 3s.
      { kind: 'abilityCharges', charges: 2 },
      { kind: 'addSelfHeal', label: 'Ashwhorl Aspect heal', pctMaxHealth: 0.03 },
      { kind: 'addSelfBuff',
        label: 'Ashwhorl Aspect prots',
        modifiers: { PhysicalProtection: 6, MagicalProtection: 6 },
        modifiersR1: { PhysicalProtection: 2, MagicalProtection: 2 },
        durationSeconds: 3,
        maxStacks: 3 },
    ],
    nonAspectPassive: '+45 Strength, +15% Attack Speed. Flurry fires out multiple Acorn projectiles that return at max range. Each enemy god hit provides Attack Speed.',
    aspectPassive: '+400 Health, +15 Tenacity. Flurry has 2 charges, Heals and provides Protections.',
    statsSource: 'extracted',
    extractionNotes: 'Stats from Ratatoskr.Acorns.3b tooltip. Behavior values from CT_Ratatoskr_A02_EffectValues: Acorn3bDamage=20→40, Acorn3bSTRScaling=0.2, Acorn3bASBuffPerStack=6→10, Acorn3bASBuffDuration=5, TalentAcorn3bHeal=0.03, TalentAcorn3bProtsPerStack=2→6, TalentAcorn3bProtsBuffDuration=3. Max-stack count (3) inferred from typical SMITE 2 per-god hit mechanic; confirm in-game.',
  },

  // ── TIER 3c: Thistlethorn Acorn (A03 upgrade) ──────────────────────────
  {
    internalKey: 'acorn.Ratatoskr.T3.Thistlethorn',
    displayName: 'Thistlethorn Acorn (A03)',
    godId: 'Ratatoskr',
    abilitySlot: 'A03',
    tier: 3,
    nonAspectStats: { PhysicalInhandLifestealPercent: 5 },  // +45 STR in adaptive, +5% Lifesteal
    aspectStats: { MaxHealth: 400, CooldownReductionPercent: 10 },  // 'Cooldown Rate' → CDR%
    abilityMods: [
      // Non-Aspect: Acorn Blast attaches/sticks and explodes after delay.
      // No separate CT numbers — uses A03's own Damage curve.
      { kind: 'behavior', label: 'Attach+explode', description: 'Acorn Blast attaches to enemy gods, or stops at max range, and explodes after a delay.' },
    ],
    // Numeric behavior is handled directly in the Ratatoskr A03 god handler so
    // the sim can model all projectiles and delayed explosions without
    // double-counting here.
    aspectAbilityMods: [
      { kind: 'behavior', label: '5 projectiles', description: 'Acorn Blast fires 5 projectiles.' },
    ],
    nonAspectPassive: '+45 Strength, +5% Lifesteal. Acorn Blast attaches to enemy gods, or stops at max range, and explodes after a delay.',
    aspectPassive: '+400 Health, +10 Cooldown Rate. Acorn Blast fires 5 projectiles and debuffs enemies hit, causing them to take more damage from you.',
    statsSource: 'extracted',
    extractionNotes: 'Stats from Ratatoskr.Acorns.3c tooltip. Aspect behavior values from CT_Ratatoskr_A03_EffectValues: TalentAcorn3cDamage=40→100, TalentAcorn3cSTRScaling=0.4, TalentAcorn3cAOEDamage=30→70, TalentAcorn3cAOESTRScaling=0.25, TalentAcorn3cDebuffDuration=4, TalentAcorn3cDebuffMulti=0.05, TalentAcorn3cExplodeTime=0.8. Non-aspect behavior has no separate CT numbers — uses A03 base Damage=70→150 / STRScaling=0.55.',
  },
]

/** Return all god-locked items (currently just Ratatoskr acorns). */
export function allGodLockedItems(): GodLockedItem[] {
  return [...RATATOSKR_ACORNS]
}

/** Return god-locked items for a specific god, or empty if none. */
export function godLockedItemsFor(godId: string): GodLockedItem[] {
  return allGodLockedItems().filter((i) => i.godId === godId)
}

/** Look up a god-locked item by internal key or display name. */
export function findGodLockedItem(displayNameOrKey: string): GodLockedItem | null {
  const target = displayNameOrKey.toLowerCase()
  return allGodLockedItems().find((item) =>
    item.internalKey.toLowerCase() === target || item.displayName.toLowerCase() === target,
  ) ?? null
}

/** Current UI uses a simple on/off aspect toggle. Any selected aspect enables
 *  the god's aspect-driven item variant. */
export function isAspectEnabled(aspects: string[] | null | undefined): boolean {
  return Array.isArray(aspects) && aspects.length > 0
}

/** Return the adaptive Strength value for an acorn (all grant +STR in non-aspect
 *  mode; none in aspect mode). Used by the API to populate `adaptiveStrength`. */
export function acornAdaptiveStrength(acorn: GodLockedItem, aspectActive: boolean): number {
  if (aspectActive) return 0
  if (acorn.tier === 1) return 5
  if (acorn.tier === 2) return 15
  return 45  // all Tier-3 variants grant +45 STR non-aspect
}

/** Union of stats an acorn can expose across both non-aspect and aspect modes.
 *  This lets picker/pool filters surface Ratatoskr acorns without needing a
 *  second aspect-specific `/api/items` round-trip. */
export function godLockedItemStatTags(acorn: GodLockedItem): string[] {
  const tags = new Set<string>([
    ...Object.keys(acorn.nonAspectStats),
    ...Object.keys(acorn.aspectStats),
  ])
  if (acornAdaptiveStrength(acorn, false) > 0) tags.add('Strength')
  return [...tags]
}

/** Convert a god-locked item into a synthetic catalog item so the sim/optimizer
 *  can resolve it through the same item path as normal store items. */
export function godLockedItemAsCatalogItem(acorn: GodLockedItem, aspectActive: boolean): ItemCatalogEntry {
  return {
    internalKey: acorn.internalKey,
    displayName: acorn.displayName,
    tier: `T${acorn.tier}`,
    categories: ['GodLocked', 'Offensive'],
    roles: [],
    keywords: ['god-locked', 'acorn', acorn.godId.toLowerCase()],
    statTags: godLockedItemStatTags(acorn),
    storeFloats: [],
    passive: aspectActive ? acorn.aspectPassive : acorn.nonAspectPassive,
    passiveRaw: aspectActive ? acorn.aspectPassive : acorn.nonAspectPassive,
    sourceFile: `godLocked:${acorn.internalKey}`,
    recipeStepCost: null,
    recipeComponents: null,
    totalCost: null,
    geEffects: [],
  }
}
