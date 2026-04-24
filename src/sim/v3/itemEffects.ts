/**
 * Data-driven item-effect resolver. Given an item's catalog entry, returns a
 * structured list of proc hooks the engine wires to combat events.
 *
 * Detection is tag + asciiRef + plausibleFloat based. We recognize:
 *
 *  - onAbilityNextBasic (multiplier)   Hydra's Lament        (×1.3 / ×1.2 next basic)
 *  - onBasicHitTrueDamage              Bumba's Cudgel        (+50 true per basic, first 3)
 *  - onAbilityCastBonusTrue            Bumba's Cudgel        (+10 true on next basic after ability)
 *  - onAbilityCastScalingDamage        Polynomicon           (+80% INT next basic)
 *  - targetProtShredPerLevel           Oath-Sworn Spear      (-1 prot per level on ability hit, 4s)
 *  - activeUse_shield                  Bloodforge            (shield on use)
 *  - activeUse_cdr                     Pendulum Blade        (-4s ability cooldowns)
 *  - stacks_power                      Transcendence         (stacking mana → strength)
 *
 * For items we don't recognize, the engine still loads their flat stats (those
 * went through the catalog's resolveItemStatsWithOverrides path).
 */

import type { ItemCatalogEntry } from '../../catalog/loadCatalogs.ts'

export type ItemProc =
  | { kind: 'onAbilityHit_nextBasicMult'; meleeMultiplier: number; rangedMultiplier: number; id: string }
  | { kind: 'onBasicHit_trueDamage'; perHit: number; maxTriggers: number; id: string }
  | { kind: 'onBasicHit_bonusDamage'; baseDamage: number; perLevelDamage: number; strScaling: number; intScaling: number; damageType: 'physical' | 'magical' | 'true'; cooldown: number; id: string }
  | { kind: 'onBasicHit_protectionScalingDamage'; baseDamage: number; itemProtectionScaling: number; damageType: 'physical' | 'magical' | 'true'; cooldown: number; id: string }
  // Bumba's Spear-style "On Attack Hit: X% bonus Physical Damage to Enemies
  // within Ym of the target" — applies a % of the basic's pre-mit damage as an
  // additional event. Single-target sim: applies to the primary target.
  | { kind: 'onBasicHit_bonusPctOfBasicDamage'; percent: number; damageType: 'physical' | 'magical' | 'true'; id: string }
  | { kind: 'onBasicHit_targetHealthDamage'; baseHealthPct: number; itemHealthPct: number; damageType: 'physical' | 'magical' | 'true'; cooldown: number; id: string }
  | { kind: 'onBasicHit_prechargedHealthScalingDamage'; baseDamage: number; maxHealthPct: number; damageType: 'physical' | 'magical' | 'true'; id: string }
  | { kind: 'onBasicOrHardCc_prechargedTargetHealthDamage'; targetMaxHealthPctPerStack: number; damageType: 'physical' | 'magical' | 'true'; id: string }
  | { kind: 'onEveryNthBasic_inhandScalingDamage'; every: number; baseDamage: number; inhandScaling: number; damageType: 'physical' | 'magical' | 'true'; id: string }
  | { kind: 'onAbilityHit_bonusDamage'; baseDamage: number; perLevelDamage: number; strScaling: number; intScaling: number; damageType: 'physical' | 'magical' | 'true'; cooldown: number; id: string }
  | { kind: 'onHit_bonusDamage'; baseDamage: number; perLevelDamage: number; strScaling: number; intScaling: number; damageType: 'physical' | 'magical' | 'true'; cooldown: number; trigger: 'ability' | 'basic' | 'any'; id: string }
  | { kind: 'onAbilityHit_protectionScalingDamage'; baseDamage: number; itemProtectionScaling: number; damageType: 'physical' | 'magical' | 'true'; cooldown: number; id: string }
  | { kind: 'onAbilityHit_bleed'; damagePerTick: number; strScaling: number; intScaling: number; ticks: number; tickRate: number; damageType: 'physical' | 'magical' | 'true'; cooldown: number; id: string }
  | { kind: 'onAbilityHit_currentHealthDot'; flatDamage: number; currentHealthPct: number; ticks: number; tickRate: number; damageType: 'physical' | 'magical' | 'true'; repeatWindowSeconds: number; repeatMultiplier: number; id: string }
  | { kind: 'onAbilityHit_targetHealthDamage'; baseHealthPct: number; itemHealthPct: number; strengthAsTargetMaxPct?: number; damageType: 'physical' | 'magical' | 'true'; ticks: number; tickRate: number; cooldown: number; id: string }
  | { kind: 'onAbilityHit_damageEchoDebuff'; basePercent: number; lifestealBonusPercentPer10: number; durationSeconds: number; maxStacks: number; id: string }
  | { kind: 'onAbilityHit_stackingBonusDamage'; stacksRequired: number; baseDamage: number; perLevelDamage: number; strScaling: number; intScaling: number; damageType: 'physical' | 'magical' | 'true'; id: string }
  | { kind: 'onDamage_selfBuff'; modifiers: Partial<Record<string, number>>; modifiersPerLevel?: Partial<Record<string, number>>; durationSeconds: number; cooldown: number; stacksMax: number; trigger: 'ability' | 'basic' | 'any'; id: string }
  | { kind: 'onCrit_selfBuff'; modifiers: Partial<Record<string, number>>; durationSeconds: number; stacksMax: number; id: string }
  | { kind: 'onHit_enemyDebuff'; modifiers: Partial<Record<string, number>>; durationSeconds: number; cooldown: number; stacksMax: number; trigger: 'ability' | 'basic' | 'any'; id: string }
  | { kind: 'onHardCc_enemyDebuff'; modifiers: Partial<Record<string, number>>; durationSeconds: number; stacksMax: number; id: string }
  | { kind: 'onAbilityCast_nextBasicBonus'; bonusTrue: number; id: string }
  | { kind: 'onAbilityCast_nextBasicScalingDamage'; baseDamage: number; strScaling: number; intScaling: number; damageType: 'physical' | 'magical' | 'true'; durationSeconds: number; cooldown: number; id: string }
  | { kind: 'onAbilityCast_selfBuff'; modifiers: Partial<Record<string, number>>; durationSeconds: number; cooldown: number; id: string; stacksMax?: number; addStacks?: number }
  | { kind: 'passive_selfBuff'; modifiers: Partial<Record<string, number>>; id: string }
  | { kind: 'passive_enemyDebuff'; modifiers: Partial<Record<string, number>>; id: string }
  | { kind: 'targetProtShred_perLevel'; durationSeconds: number; maxStacks: number; id: string }
  | { kind: 'targetProtShredPct'; protPct: number; durationSeconds: number; maxStacks: number; trigger: 'ability' | 'basic' | 'any'; id: string }
  | { kind: 'periodic_cdr'; intervalSeconds: number; secondsReduced: number; id: string }
  | { kind: 'activeUse_shield'; flatShield: number; shieldPerLevel: number; maxHealthPct: number; strengthFromItemsPct: number; intelligenceFromItemsPct: number; durationSeconds: number; lifestealBonusPct: number; cooldown: number; id: string }
  | { kind: 'activeUse_cdr'; secondsReduced: number; cooldown: number; id: string }
  | { kind: 'activeUse_selfBuff'; modifiers: Partial<Record<string, number>>; durationSeconds: number; cooldown: number; id: string }
  | { kind: 'activeUse_convertIntToStrength'; strengthFromCurrentIntPct: number; intelligencePercent: number; critChance: number; durationSeconds: number; cooldown: number; id: string }
  | { kind: 'activeUse_damage'; baseDamage: number; perLevelDamage: number; damageType: 'physical' | 'magical' | 'true'; ticks: number; cooldown: number; id: string }
  | { kind: 'activeUse_instantDamage'; baseDamage: number; perLevelDamage: number; strScaling: number; intScaling: number; targetCurrentHealthPct: number; damageType: 'physical' | 'magical' | 'true'; cooldown: number; id: string }
  | { kind: 'activeUse_inhandScalingDamage'; baseDamage: number; inhandScaling: number; hits: number; damageType: 'physical' | 'magical' | 'true'; cooldown: number; id: string }
  | { kind: 'activeUse_extraBasicProjectiles'; baseDamage: number; inhandScaling: number; hits: number; damageType: 'physical' | 'magical' | 'true'; durationSeconds: number; cooldown: number; id: string }
  | { kind: 'activeUse_targetHealthDamage'; baseHealthPct: number; itemHealthPct: number; ticks: number; tickRate: number; damageType: 'physical' | 'magical' | 'true'; cooldown: number; id: string }
  | { kind: 'activeUse_targetMaxHealthDamage'; targetMaxHealthPct: number; lifestealBonusPctPer10: number; damageCap: number; ticks: number; tickRate: number; damageType: 'physical' | 'magical' | 'true'; cooldown: number; id: string }
  | { kind: 'activeUse_protectionScalingDamage'; protectionScaling: number; delaySeconds: number; damageType: 'physical' | 'magical' | 'true'; cooldown: number; id: string }
  | { kind: 'activeUse_nextNonUltimateNoCooldown'; cooldown: number; id: string }
  | { kind: 'activeUse_enemyDebuff'; modifiers: Partial<Record<string, number>>; durationSeconds: number; cooldown: number; id: string }
  | { kind: 'activeUse_cc'; flavor: 'stun' | 'silence' | 'root' | 'slow'; durationSeconds: number; cooldown: number; id: string }
  | { kind: 'activeUse_teleport'; rangeMeters: number; cooldown: number; id: string }
  | { kind: 'activeUse_utility'; description: string; cooldown: number; id: string }
  | { kind: 'passive_utility'; description: string; id: string }
  | { kind: 'stacks_adaptive'; perStackMana: number; maxStacks: number; onEvolveExtra: { strength: number; mana: number }; id: string }

const HARD_CODED_ITEM_PROCS: Record<string, ItemProc[]> = {
  "item.Hydra's Lament": [{
    kind: 'onAbilityHit_nextBasicMult',
    meleeMultiplier: 1.3,
    rangedMultiplier: 1.2,
    id: 'hydra-nextBasicMult',
  }],
  "item.HydrasLament": [{
    kind: 'onAbilityHit_nextBasicMult',
    meleeMultiplier: 1.3,
    rangedMultiplier: 1.2,
    id: 'hydra-nextBasicMult',
  }],
  "item.BumbasCudgel": [
    { kind: 'onBasicHit_trueDamage', perHit: 50, maxTriggers: 3, id: 'bumba-perbasic' },
    { kind: 'onAbilityCast_nextBasicBonus', bonusTrue: 10, id: 'bumba-postability' },
  ],
  "Item.BumbasCudgel": [
    { kind: 'onBasicHit_trueDamage', perHit: 50, maxTriggers: 3, id: 'bumba-perbasic' },
    { kind: 'onAbilityCast_nextBasicBonus', bonusTrue: 10, id: 'bumba-postability' },
  ],
  "item.BumbasHammer": [
    { kind: 'onAbilityCast_nextBasicBonus', bonusTrue: 60, id: 'bumbas-hammer-postability' },
    {
      kind: 'passive_utility',
      description: 'next-basic cooldown reduction and heal are not included in outgoing damage totals.',
      id: 'bumbas-hammer-cooldown-heal',
    },
  ],
  "item.Polynomicon": [{
    kind: 'onAbilityCast_nextBasicScalingDamage',
    baseDamage: 0,
    strScaling: 0,
    intScaling: 0.8,
    damageType: 'magical',
    durationSeconds: 8,
    cooldown: 2,
    id: 'polynomicon-next-basic',
  }],
  "item.Lorg Mor": [{
    kind: 'onAbilityHit_protectionScalingDamage',
    baseDamage: 10,
    itemProtectionScaling: 0.4,
    damageType: 'physical',
    cooldown: 0.5,
    id: 'gladiators-shield-item-protection-damage',
  }],
  "item.Meteor Hammer": [{
    kind: 'onBasicHit_protectionScalingDamage',
    baseDamage: 20,
    itemProtectionScaling: 0.15,
    damageType: 'physical',
    cooldown: 0,
    id: 'golden-blade-item-protection-cleave',
  }],
  "item.Baneful Rapier": [{
    kind: 'onCrit_selfBuff',
    modifiers: { AttackSpeedPercent: 30 },
    durationSeconds: 3,
    stacksMax: 1,
    id: 'demon-blade-crit-attack-speed',
  }],
  "item.Shogun's Ofuda": [{
    kind: 'passive_selfBuff',
    modifiers: { AttackSpeedPercent: 20 },
    id: 'shoguns-ofuda-attack-speed-aura',
  }],
  "Item.VoidShield": [{
    kind: 'passive_enemyDebuff',
    modifiers: { PhysicalProtectionPercent: -10 },
    id: 'void-shield-physical-protection-aura',
  }],
  "item.VoidStone": [{
    kind: 'passive_enemyDebuff',
    modifiers: { MagicalProtectionPercent: -10 },
    id: 'void-stone-magical-protection-aura',
  }],
  "item.Obsidian Macuahuitl": [{
    kind: 'targetProtShred_perLevel',
    durationSeconds: 4,
    maxStacks: 1, // assumed — BP opcode for stacking is not readable. Most-common convention is refresh, not stack.
    id: 'oathsworn-shred',
  }],
  "item.Blood-Forged Blade": [{
    kind: 'activeUse_shield',
    flatShield: 0,
    shieldPerLevel: 0,
    maxHealthPct: 0.10,
    strengthFromItemsPct: 1.5,
    intelligenceFromItemsPct: 0,
    durationSeconds: 6,
    lifestealBonusPct: 10,
    cooldown: 80,
    id: 'bloodforge-active',
  }],
  "item.Blood-Bound Book": [{
    kind: 'activeUse_shield',
    flatShield: 0,
    shieldPerLevel: 0,
    maxHealthPct: 0.075,
    strengthFromItemsPct: 0,
    intelligenceFromItemsPct: 0.75,
    durationSeconds: 6,
    lifestealBonusPct: 10,
    cooldown: 80,
    id: 'blood-bound-book-active',
  }],
  "item.DemonicGrip": [{
    kind: 'targetProtShredPct',
    protPct: 0.06,
    durationSeconds: 4,
    maxStacks: 4,
    trigger: 'basic',
    id: 'demonic-grip-piercing',
  }],
  "item.The Executioner": [{
    kind: 'targetProtShredPct',
    protPct: 0.06,
    durationSeconds: 4,
    maxStacks: 5,
    trigger: 'basic',
    id: 'executioner-piercing',
  }],
  "item.Totem of Death": [{
    kind: 'targetProtShredPct',
    protPct: 0.06,
    durationSeconds: 4,
    maxStacks: 5,
    trigger: 'ability',
    id: 'totem-of-death-piercing',
  }],
  "item.ProtectionOfItus": [{
    kind: 'targetProtShredPct',
    protPct: 0.035,
    durationSeconds: 4,
    maxStacks: 3,
    trigger: 'basic',
    id: 'avenging-blade-shred',
  }],
  "item.TheCrusher": [{
    kind: 'onAbilityHit_bleed',
    damagePerTick: 0,
    strScaling: 0.35,
    intScaling: 0,
    ticks: 1,
    tickRate: 1,
    damageType: 'physical',
    cooldown: 0,
    id: 'crusher-strength-dot',
  }],
  "item.Heartseeker": [{
    kind: 'onAbilityHit_targetHealthDamage',
    baseHealthPct: 0,
    itemHealthPct: 0,
    strengthAsTargetMaxPct: 0.02,
    damageType: 'physical',
    ticks: 1,
    tickRate: 0,
    cooldown: 0,
    id: 'heartseeker-strength-health',
  }],
  "item.Soul Devourer": [{
    kind: 'onAbilityHit_targetHealthDamage',
    baseHealthPct: 0.012,
    itemHealthPct: 0.03,
    damageType: 'magical',
    ticks: 4,
    tickRate: 0.5,
    cooldown: 0,
    id: 'soul-reaver-health-dot',
  }],
  "item.Qin's Blade": [{
    kind: 'onBasicHit_targetHealthDamage',
    baseHealthPct: 0.02,
    itemHealthPct: 0.05,
    damageType: 'physical',
    cooldown: 0,
    id: 'qins-target-health',
  }],
  "item.Divine Ruin": [
    {
      kind: 'onHit_bonusDamage',
      baseDamage: 40,
      perLevelDamage: 0,
      strScaling: 0,
      intScaling: 0.2,
      damageType: 'magical',
      cooldown: 15,
      trigger: 'any',
      id: 'divine-ruin-chain-lightning-primary',
    },
    {
      kind: 'onHit_enemyDebuff',
      modifiers: { HealingReduction: 25 },
      durationSeconds: 5,
      cooldown: 0,
      stacksMax: 1,
      trigger: 'any',
      id: 'divine-ruin-antiheal',
    },
  ],
  "item.HandOfTheAbyss": [{
    kind: 'onDamage_selfBuff',
    modifiers: { InhandPower: 10 },
    durationSeconds: 10,
    cooldown: 0,
    stacksMax: 8,
    trigger: 'any',
    id: 'bracer-abyss-attack-damage',
  }],
  "item.Wyrmskin Hide": [{
    kind: 'onDamage_selfBuff',
    modifiers: {},
    modifiersPerLevel: { Dampening: 1 },
    durationSeconds: 999,
    cooldown: 8,
    stacksMax: 1,
    trigger: 'any',
    id: 'wyrmskin-hide-dampening',
  }],
  "item.WyrmskinHide": [{
    kind: 'onDamage_selfBuff',
    modifiers: {},
    modifiersPerLevel: { Dampening: 1 },
    durationSeconds: 999,
    cooldown: 8,
    stacksMax: 1,
    trigger: 'any',
    id: 'wyrmskin-hide-dampening',
  }],
  "item.OdysseusBow": [{
    kind: 'onEveryNthBasic_inhandScalingDamage',
    every: 4,
    baseDamage: 15,
    inhandScaling: 0.6,
    damageType: 'physical',
    id: 'odysseus-bow-chain-lightning',
  }],
  "item.CircesHexstone": [
    {
      kind: 'activeUse_selfBuff',
      modifiers: { PhysicalProtection: 60, MagicalProtection: 60, ccImmune: 1 },
      durationSeconds: 1,
      cooldown: 120,
      id: 'circe-hexstone-protections',
    },
    {
      kind: 'activeUse_instantDamage',
      baseDamage: 50,
      perLevelDamage: 0,
      strScaling: 0,
      intScaling: 0,
      targetCurrentHealthPct: 0.10,
      damageType: 'physical',
      cooldown: 120,
      id: 'circe-hexstone-hit',
    },
    {
      kind: 'activeUse_utility',
      description: 'polymorphs the user, dashes forward, knocks up enemy gods hit, and refunds 40s cooldown on enemy-god hit.',
      cooldown: 120,
      id: 'circe-hexstone-utility',
    },
  ],
  "item.Dreamer's Idol": [{
    kind: 'activeUse_selfBuff',
    modifiers: { adaptiveIntelligencePercent: 25, displacementImmune: 1 },
    durationSeconds: 10,
    cooldown: 120,
    id: 'dreamers-idol-active',
  }],
  "item.Death Metal": [{
    kind: 'activeUse_convertIntToStrength',
    strengthFromCurrentIntPct: 0.66,
    intelligencePercent: -100,
    critChance: 25,
    durationSeconds: 6,
    cooldown: 45,
    id: 'death-metal-active',
  }],
  "item.RagnaroksWake": [{
    kind: 'activeUse_instantDamage',
    baseDamage: 600,
    perLevelDamage: 0,
    strScaling: 0,
    intScaling: 0,
    targetCurrentHealthPct: 0,
    damageType: 'magical',
    cooldown: 140,
    id: 'ragnaroks-wake-impact',
  }],
  "Item.ShieldSplitter": [{
    kind: 'activeUse_instantDamage',
    baseDamage: 40,
    perLevelDamage: 5,
    strScaling: 0,
    intScaling: 0,
    targetCurrentHealthPct: 0,
    damageType: 'true',
    cooldown: 15,
    id: 'shield-splitter-projectile',
  }],
  "item.LifeBinder": [
    {
      kind: 'activeUse_instantDamage',
      baseDamage: 60,
      perLevelDamage: 8,
      strScaling: 0,
      intScaling: 0,
      targetCurrentHealthPct: 0,
      damageType: 'magical',
      cooldown: 20,
      id: 'lifebinder-projectile',
    },
    {
      kind: 'activeUse_utility',
      description: 'marks enemy gods for 6s; the first ally to damage the marked target heals and shields for 60 + 8 per level.',
      cooldown: 20,
      id: 'lifebinder-mark-heal-shield',
    },
  ],
  "item.LernaeanBow": [{
    kind: 'activeUse_inhandScalingDamage',
    baseDamage: 0,
    inhandScaling: 0.4,
    hits: 3,
    damageType: 'physical',
    cooldown: 30,
    id: 'lernaean-bow-arrows',
  }],
  "item.Sun Beam Bow": [{
    kind: 'activeUse_extraBasicProjectiles',
    baseDamage: 10,
    inhandScaling: 0.3,
    hits: 2,
    damageType: 'magical',
    durationSeconds: 999,
    cooldown: 0,
    id: 'sun-beam-bow-projectiles',
  }],
  "item.Omen Drum": [{
    kind: 'activeUse_utility',
    description: '5s ability-damage echo window is not yet modeled as delayed target damage.',
    cooldown: 90,
    id: 'omen-drum-echo-window',
  }],
  "item.GloriousPridwen": [
    {
      kind: 'activeUse_protectionScalingDamage',
      protectionScaling: 0.4,
      delaySeconds: 0,
      damageType: 'magical',
      cooldown: 45,
      id: 'glorious-pridwen-initial-explosion',
    },
    {
      kind: 'activeUse_protectionScalingDamage',
      protectionScaling: 0.7,
      delaySeconds: 5,
      damageType: 'magical',
      cooldown: 45,
      id: 'glorious-pridwen-expire-explosion',
    },
  ],
  "item.Phoenix Amulet": [{
    kind: 'activeUse_targetHealthDamage',
    baseHealthPct: 0,
    itemHealthPct: 0.03,
    ticks: 3,
    tickRate: 0.5,
    damageType: 'true',
    cooldown: 120,
    id: 'phoenix-feather-pulses',
  }],
  "item.StaffOfMyrddin": [{
    kind: 'activeUse_nextNonUltimateNoCooldown',
    cooldown: 80,
    id: 'staff-of-myrddin-next-no-cooldown',
  }],
  "item.Pharaoh's Curse": [{
    kind: 'activeUse_enemyDebuff',
    modifiers: { MovementSpeed: -20, AttackSpeedPercent: -40 },
    durationSeconds: 4,
    cooldown: 45,
    id: 'pharaohs-curse-debuff',
  }],
  "item.Screeching Gargoyle ": [
    {
      kind: 'activeUse_cc',
      flavor: 'silence',
      durationSeconds: 1,
      cooldown: 90,
      id: 'screeching-gargoyle-silence',
    },
    {
      kind: 'activeUse_enemyDebuff',
      modifiers: { PhysicalProtectionPercent: -10, MagicalProtectionPercent: -10 },
      durationSeconds: 4,
      cooldown: 90,
      id: 'screeching-gargoyle-prot-debuff',
    },
    {
      kind: 'activeUse_utility',
      description: 'during Moonlight Phase the silence lasts 1.5s and the protection debuff increases to 15%.',
      cooldown: 90,
      id: 'screeching-gargoyle-moonlight-phase',
    },
  ],
  "item.PendulumBlade": [{
    kind: 'activeUse_cdr',
    secondsReduced: 4,
    cooldown: 40,
    id: 'pendulum-cdr',
  }],
  "item.Alchemist Coat": [{
    kind: 'passive_utility',
    description: 'Consumable use grants +10 Dampening for 8s; consumable actions are not part of the outgoing damage sim.',
    id: 'alchemist-coat-consumable-dampening',
  }],
  "item.Restorative Amanita": [{
    kind: 'activeUse_utility',
    description: 'healing mushroom; healing and incoming damage reduction are tracked as utility',
    cooldown: 60,
    id: 'amanita-healing-mushroom',
  }],
  "Item.Ancile": [{
    kind: 'activeUse_cc',
    flavor: 'silence',
    durationSeconds: 1.5,
    cooldown: 70,
    id: 'ancile-next-damaging-ability-silence',
  }],
  "Item.BarbedCarver": [{
    kind: 'onAbilityHit_damageEchoDebuff',
    basePercent: 8,
    lifestealBonusPercentPer10: 1,
    durationSeconds: 5,
    maxStacks: 3,
    id: 'barbed-carver-jagged-wounds',
  }],
  "item.ChandrasGrace": [{
    kind: 'passive_utility',
    description: 'Every 30s ally regen/cooldown pulse; self portion depends on Moonlight phase, which is not scenario-authored yet.',
    id: 'chandras-grace-moonlight-pulse',
  }],
  "item.Chronos' Pendant": [{
    kind: 'periodic_cdr',
    intervalSeconds: 10,
    secondsReduced: 1,
    id: 'chronos-pendant-periodic-cdr',
  }],
  "item.Contagion": [{
    kind: 'onBasicOrHardCc_prechargedTargetHealthDamage',
    targetMaxHealthPctPerStack: 0.01,
    damageType: 'magical',
    id: 'contagion-precharged-stacks',
  }],
  "item.Damaru": [{
    kind: 'onCrit_selfBuff',
    modifiers: { AbilityDamagePercent: 8, AttackDamagePercent: 8 },
    durationSeconds: 5,
    stacksMax: 3,
    id: 'damaru-crit-ability-attack-damage',
  }],
  "Item.DaybreakGavel": [{
    kind: 'passive_utility',
    description: 'healing-ability stack generation and non-healing ability consumption need authored healing events before they can affect outgoing damage.',
    id: 'daybreak-gavel-heal-stacks',
  }],
  "Item.Erosion": [{
    kind: 'passive_utility',
    description: 'Shield suppression and protection gain only matter in incoming shield/tank simulations.',
    id: 'erosion-shield-suppression',
  }],
  "Item.DwarfForgedPlate": [{
    kind: 'activeUse_utility',
    description: 'toggles whether the larger protection amplifier applies to Physical or Magical Protection; default snapshot uses the current catalog orientation.',
    cooldown: 30,
    id: 'dwarven-plate-toggle',
  }],
  "item.Eye of the Storm": [{
    kind: 'activeUse_utility',
    description: 'vortex pull; self-damage is ignored because it is not target damage',
    cooldown: 60,
    id: 'eye-of-the-storm-vortex',
  }],
  "item.EyeOfErebus": [{
    kind: 'activeUse_targetMaxHealthDamage',
    targetMaxHealthPct: 0.15,
    lifestealBonusPctPer10: 0,
    damageCap: 999999,
    ticks: 1,
    tickRate: 0,
    damageType: 'magical',
    cooldown: 40,
    id: 'eye-of-erebus-watchful-eye-shot',
  }],
  "item.HastenedFatalis": [{
    kind: 'onDamage_selfBuff',
    modifiers: { InhandMoveSpeedPenaltyReductionPercent: 12.5 },
    durationSeconds: 2,
    cooldown: 0,
    stacksMax: 4,
    trigger: 'basic',
    id: 'hastened-fatalis-basic-haste',
  }],
  "Item.HeartwoodCharm": [{
    kind: 'activeUse_utility',
    description: 'next non-ultimate healing ability has no cooldown; healing-only ability routing is not modeled as outgoing damage',
    cooldown: 120,
    id: 'heartwood-charm-healing-reset',
  }],
  "item.Helm of Darkness": [{
    kind: 'activeUse_utility',
    description: 'stealth and wall/player pass-through; Moonlight pass-through damage needs phase state',
    cooldown: 90,
    id: 'helm-of-darkness-stealth',
  }],
  "item.Helm of Radiance": [{
    kind: 'passive_utility',
    description: 'incoming physical-damage trigger grants stacking Physical Protection; incoming enemy attacks are not modeled yet.',
    id: 'helm-of-radiance-incoming-physical-prot',
  }],
  "item.HideOfTheNemeanLion": [{
    kind: 'activeUse_utility',
    description: 'reflects incoming pre-mitigated damage; requires incoming-damage sim context',
    cooldown: 60,
    id: 'nemean-lion-reflect',
  }],
  "item.Kinetic Cuirass": [{
    kind: 'onBasicHit_prechargedHealthScalingDamage',
    baseDamage: 40,
    maxHealthPct: 0.04,
    damageType: 'physical',
    id: 'kinetic-cuirass-precharged-shockwave',
  }],
  "item.Jotunn's Revenge": [{
    kind: 'passive_utility',
    description: 'god kill/assist cooldown refund is not applied inside a single-target pre-kill rotation.',
    id: 'jotunns-revenge-kill-assist-cdr',
  }],
  "item.MagisCloak": [{
    kind: 'passive_utility',
    description: '90s hard-CC bubble; no direct outgoing damage effect.',
    id: 'magis-cloak-cc-bubble',
  }],
  "item.MantleOfDiscord": [{
    kind: 'passive_utility',
    description: 'below-40% incoming-damage stun/CC-immunity trigger is defensive and needs incoming damage state.',
    id: 'mantle-of-discord-low-health-stun',
  }],
  "item.OniHuntersGarb": [{
    kind: 'passive_utility',
    description: 'enemy-count-based incoming Damage Mitigation; tank simulation needs nearby enemy count.',
    id: 'oni-hunters-garb-mitigation-aura',
  }],
  "item.PropheticCloak": [{
    kind: 'passive_utility',
    description: 'protection stacks and evolved mitigation are defensive state; use partial stack data in future tank passes.',
    id: 'prophetic-cloak-protection-stacks',
  }],
  "item.Resolute Mantle": [{
    kind: 'passive_utility',
    description: 'hard-CC-taken trigger grants regen/tenacity; incoming CC events are not scenario-authored yet.',
    id: 'resolute-mantle-cc-taken-stacks',
  }],
  "item.Riptalon": [{
    kind: 'passive_selfBuff',
    modifiers: { AttackDamagePercent: 10 },
    id: 'riptalon-above-half-attack-damage',
  }],
  "item.Shroud of Vengeance": [{
    kind: 'passive_utility',
    description: 'hard-CC-taken shockwave requires an incoming CC trigger; outgoing rotations do not author enemy CC events yet.',
    id: 'shroud-of-vengeance-cc-shockwave',
  }],
  "Item.RodOfAsclepius": [{
    kind: 'activeUse_utility',
    description: 'ally healing and non-damage immunity',
    cooldown: 90,
    id: 'rod-of-asclepius-heal',
  }],
  "item.Ruinous Ankh": [{
    kind: 'passive_utility',
    description: 'range-based anti-heal aura; healing received by the defender is not part of outgoing damage totals.',
    id: 'ruinous-ankh-antiheal-aura',
  }],
  "Item.SanguineLash": [{
    kind: 'activeUse_targetMaxHealthDamage',
    targetMaxHealthPct: 0.0075,
    lifestealBonusPctPer10: 0.01,
    damageCap: 200,
    ticks: 12,
    tickRate: 0.33,
    damageType: 'physical',
    cooldown: 60,
    id: 'sanguine-lash-active-health-drain',
  }],
  "Item.ShieldOfThePhoenix": [{
    kind: 'passive_utility',
    description: 'ability-hit self heal and mana restore; no direct outgoing damage effect.',
    id: 'shield-of-the-phoenix-sustain',
  }],
  "item.SoulGem": [{
    kind: 'onAbilityHit_stackingBonusDamage',
    stacksRequired: 3,
    baseDamage: 0,
    perLevelDamage: 0,
    strScaling: 0,
    intScaling: 0.4,
    damageType: 'magical',
    id: 'soul-gem-three-stack-bonus',
  }],
  "Item.SphereOfNegation": [{
    kind: 'passive_utility',
    description: 'periodic magical shield; shield durability belongs to incoming-damage/tank simulations.',
    id: 'sphere-of-negation-magical-shield',
  }],
  "item.Bindings of Lyngvi": [{
    kind: 'onHardCc_enemyDebuff',
    modifiers: { PhysicalProtection: -7, MagicalProtection: -7 },
    durationSeconds: 6,
    stacksMax: 3,
    id: 'stone-of-binding-hard-cc-prot-shred',
  }],
  "item.The Reaper": [{
    kind: 'passive_utility',
    description: 'heal on god kill or assist; no direct outgoing damage effect.',
    id: 'the-reaper-kill-heal',
  }],
  "Item.TyphonsHeart": [{
    kind: 'passive_utility',
    description: 'kill/assist stacks summon a monster; pet behavior is not modeled by the single-attacker rotation sim yet.',
    id: 'typhons-heart-monster-summon',
  }],
  "Item.VitalAmplifier": [{
    kind: 'passive_utility',
    description: 'healing-triggered Attack Speed/Attack Damage stacks need authored healing events before they can affect outgoing damage.',
    id: 'vital-amplifier-heal-trigger',
  }],
  "item.XibalbanEffigy": [
    {
      kind: 'activeUse_selfBuff',
      modifiers: { DamageTakenPercent: -50 },
      durationSeconds: 4,
      cooldown: 90,
      id: 'xibalban-effigy-damage-delay',
    },
    {
      kind: 'activeUse_utility',
      description: 'delayed mitigated damage return; incoming damage storage is not modeled in outgoing damage totals',
      cooldown: 90,
      id: 'xibalban-effigy-delayed-return',
    },
  ],
  "item.Transcendance": [{
    kind: 'stacks_adaptive',
    perStackMana: 7,
    maxStacks: 50,
    onEvolveExtra: { strength: 15, mana: 100 },
    id: 'trans-stacks',
  }],
  "item.Transcendence": [{
    kind: 'stacks_adaptive',
    perStackMana: 7,
    maxStacks: 50,
    onEvolveExtra: { strength: 15, mana: 100 },
    id: 'trans-stacks',
  }],
}

export function getItemProcs(item: ItemCatalogEntry): ItemProc[] {
  if (item.internalKey && HARD_CODED_ITEM_PROCS[item.internalKey]) {
    return HARD_CODED_ITEM_PROCS[item.internalKey]
  }
  // Fallback: derive procs from passive text using pattern matching. This scales
  // to the majority of items whose passives follow common shapes (On Use: X, On
  // Ability Hit: Y, On Basic Attack Hit: Z, When Below N% Health: W).
  return parsePassiveForProcs(item)
}

// ---- Passive-text auto-parser -----------------------------------------------
//
// Covers the common SMITE 2 passive patterns. When a passive text matches, we
// emit a structured ItemProc with extracted numeric parameters. Items whose
// passive doesn't match any pattern return []; those still work at stat level
// via resolveItemStatsWithOverrides, they just don't get simulated effects.

export function parsePassiveForProcs(item: ItemCatalogEntry): ItemProc[] {
  // Normalize passive text: collapse whitespace, normalize bullet points.
  const passive = (item.passive ?? '')
    .replace(/[•·]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!passive) return []
  const procs: ItemProc[] = []
  const idBase = (item.displayName ?? item.internalKey ?? 'item').replace(/\W+/g, '-').toLowerCase()

  // Cooldown parse: "Cooldown: Xs"
  const cooldownMatch = /Cooldown:\s*(\d+(?:\.\d+)?)\s*s/i.exec(passive)
  const parsedCooldown = cooldownMatch ? Number(cooldownMatch[1]) : null
  const activeCooldown = parsedCooldown ?? 60

  const damageTypeFromText = (text: string, fallback: 'physical' | 'magical' | 'true' = 'physical') => {
    const type = /(Physical|Magical|Magic|True)\s+Damage/i.exec(text)?.[1]?.toLowerCase()
    if (type === 'magic') return 'magical'
    return (type ?? fallback) as 'physical' | 'magical' | 'true'
  }

  // --- Basic Attack Hit: +X True Damage -----------------------------------
  {
    const m = /Basic (?:Attack )?Hit[^:]*:?\s*(?:Deal|Inflicts?|Applies?)?\s*\+?(\d+(?:\.\d+)?)\s+True(?:\s+Damage)?/i.exec(passive)
    if (m) procs.push({
      kind: 'onBasicHit_trueDamage',
      perHit: Number(m[1]),
      maxTriggers: 999,
      id: `${idBase}-basic-true`,
    })
  }

  // --- Attack Hit: +X (+Y per Level) bonus Damage -------------------------
  {
    const m = /(?:Basic\s+)?Attack(?:s deal|\s+Hit)[^:]*:?\s*\+?(\d+(?:\.\d+)?)\s*(?:\(\+(\d+(?:\.\d+)?)\s*per Level\)\s*)?bonus\s*(Physical|Magical|True)?\s*Damage/i.exec(passive)
    if (m) {
      procs.push({
        kind: 'onBasicHit_bonusDamage',
        baseDamage: Number(m[1]),
        perLevelDamage: m[2] ? Number(m[2]) : 0,
        strScaling: 0,
        intScaling: 0,
        damageType: (m[3] ?? 'physical').toLowerCase() as 'physical' | 'magical' | 'true',
        cooldown: parsedCooldown ?? 0,
        id: `${idBase}-basic-bonus`,
      })
    }
  }

  // --- On Attack Hit: X% bonus <Type> Damage to Enemies within Ym of the target
  // Bumba's Spear / Bumba's Golden Dagger style AoE cleave. Matches the %
  // form specifically (the regex above demands a flat number, not X%).
  {
    const m = /(?:On\s+)?(?:Basic\s+)?Attack\s+Hit[^:]*:?\s*(\d+(?:\.\d+)?)%\s*bonus\s*(Physical|Magical|True)?\s*Damage/i.exec(passive)
    if (m) {
      procs.push({
        kind: 'onBasicHit_bonusPctOfBasicDamage',
        percent: Number(m[1]),
        damageType: (m[2] ?? 'physical').toLowerCase() as 'physical' | 'magical' | 'true',
        id: `${idBase}-basic-pct-splash`,
      })
    }
  }

  // --- Ability/Attack Hit: -X% Protections (shred) -----------------------
  {
    const m = /(Ability|Attack)\s+[Hh]it[^:]*:?[^.]*?-(\d+(?:\.\d+)?)%\s*(?:Physical\s+|Magical\s+)?Protections?/i.exec(passive)
    const stacks = /Stacks?\s+up\s+to\s+(\d+)/i.exec(passive)
    if (m) procs.push({
      kind: 'targetProtShredPct',
      protPct: Number(m[2]) / 100,
      durationSeconds: 4,
      maxStacks: stacks ? Number(stacks[1]) : 1,
      trigger: m[1].toLowerCase() === 'ability' ? 'ability' : 'basic',
      id: `${idBase}-hit-prot-shred`,
    })
  }

  // --- Ability Hit: +X bonus Damage  (Ancient Signet, etc.) --------------
  {
    const m = /Ability Hit[^:]*:\s*\+?(\d+(?:\.\d+)?)\s*(?:\(\+(\d+(?:\.\d+)?)\s*per Level\)\s*)?bonus\s*(Physical|Magical|True)?\s*Damage/i.exec(passive)
    if (m) {
      const base = Number(m[1])
      const perLevel = m[2] ? Number(m[2]) : 0
      const type = (m[3] ?? 'magical').toLowerCase() as 'physical' | 'magical' | 'true'
      procs.push({
        kind: 'onAbilityHit_bonusDamage',
        baseDamage: base,
        perLevelDamage: perLevel,
        strScaling: 0,
        intScaling: 0,
        damageType: type,
        cooldown: parsedCooldown ?? 0,
        id: `${idBase}-ability-bonus`,
      })
    }
  }

  // --- Attack Hit: target base/item health bonus damage ------------------
  {
    const m = /Attack Hit[\s\S]*?Bonus Damage\s*=\s*\+?(\d+(?:\.\d+)?)%\s*Target Base Health\s*&\s*\+?(\d+(?:\.\d+)?)%\s*Target Item Health/i.exec(passive)
    if (m) {
      procs.push({
        kind: 'onBasicHit_targetHealthDamage',
        baseHealthPct: Number(m[1]) / 100,
        itemHealthPct: Number(m[2]) / 100,
        damageType: damageTypeFromText(passive, 'physical'),
        cooldown: parsedCooldown ?? 0,
        id: `${idBase}-basic-target-health`,
      })
    }
  }

  // --- Ability Hit: target base/item health bonus damage -----------------
  {
    const m = /Ability Hit[\s\S]*?Bonus Damage\s*=\s*\+?(\d+(?:\.\d+)?)%\s*Target Base Health\s*&\s*\+?(\d+(?:\.\d+)?)%\s*Target Item Health(?:,\s*dealt\s*(\d+)\s*times\s*over\s*(\d+(?:\.\d+)?)s)?/i.exec(passive)
    if (m) {
      const ticks = m[3] ? Number(m[3]) : 1
      const over = m[4] ? Number(m[4]) : 0
      procs.push({
        kind: 'onAbilityHit_targetHealthDamage',
        baseHealthPct: Number(m[1]) / 100,
        itemHealthPct: Number(m[2]) / 100,
        damageType: damageTypeFromText(passive, 'magical'),
        ticks,
        tickRate: ticks > 1 && over > 0 ? over / ticks : 0,
        cooldown: parsedCooldown ?? 0,
        id: `${idBase}-ability-target-health`,
      })
    }
  }

  // --- Ability Hit: strength as target max-health percentage -------------
  {
    const m = /Ability Hit[\s\S]*?\+%Health\s*(Physical|Magical|Magic|True)?\s*Damage[\s\S]*?Damage\s*=\s*(\d+(?:\.\d+)?)%\s*of your Strength[\s\S]*?Max Health/i.exec(passive)
    if (m) {
      procs.push({
        kind: 'onAbilityHit_targetHealthDamage',
        baseHealthPct: 0,
        itemHealthPct: 0,
        strengthAsTargetMaxPct: Number(m[2]) / 100,
        damageType: damageTypeFromText(m[0], 'physical'),
        ticks: 1,
        tickRate: 0,
        cooldown: parsedCooldown ?? 0,
        id: `${idBase}-ability-strength-target-health`,
      })
    }
  }

  // --- Ability Hit: scaling damage over a short window -------------------
  {
    const m = /Ability Hit[\s\S]*?\+(Physical|Magical|Magic|True)\s+Damage[\s\S]*?Damage\s*=\s*(\d+(?:\.\d+)?)%\s*of your Strength[\s\S]*?over\s*(\d+(?:\.\d+)?)s/i.exec(passive)
    if (m) {
      procs.push({
        kind: 'onAbilityHit_bleed',
        damagePerTick: 0,
        strScaling: Number(m[2]) / 100,
        intScaling: 0,
        ticks: 1,
        tickRate: Number(m[3]),
        damageType: damageTypeFromText(m[0], 'physical'),
        cooldown: parsedCooldown ?? 0,
        id: `${idBase}-ability-scaling-bleed`,
      })
    }
  }

  // --- Ability Hit: +X <Type> Damage over Ns --- Bluestone Brooch/Pendant
  // form. Flat base damage (no STR scaling) distributed as a DoT over N
  // seconds. Tick rate defaults to 1s (matching SMITE 2's standard DoT cadence
  // for Bluestone). Must run AFTER the "bonus Damage" regex — they'd both
  // match otherwise, and this flat-DoT shape is more specific.
  {
    const m = /Ability Hit[^:]*:\s*\+?(\d+(?:\.\d+)?)\s+(Physical|Magical|Magic|True)\s+Damage\s+over\s+(\d+(?:\.\d+)?)\s*s/i.exec(passive)
    if (m) {
      const totalDamage = Number(m[1])
      const duration = Number(m[3])
      const TICK_RATE = 1.0
      const ticks = Math.max(1, Math.round(duration / TICK_RATE))
      const currentHealth = /additional damage\s*=\s*(\d+(?:\.\d+)?)%\s*of their current Health/i.exec(passive)
      const subsequent = /Subsequent hits on the same target:\s*(\d+(?:\.\d+)?)%\s+bonus damage for\s+(\d+(?:\.\d+)?)s/i.exec(passive)
      if (subsequent) {
        procs.push({
          kind: 'onAbilityHit_currentHealthDot',
          flatDamage: totalDamage,
          currentHealthPct: currentHealth ? Number(currentHealth[1]) / 100 : 0,
          ticks,
          tickRate: TICK_RATE,
          damageType: damageTypeFromText(m[0], 'physical'),
          repeatWindowSeconds: Number(subsequent[2]),
          repeatMultiplier: 1 + Number(subsequent[1]) / 100,
          id: `${idBase}-ability-current-health-dot`,
        })
      } else {
        procs.push({
          kind: 'onAbilityHit_bleed',
          damagePerTick: totalDamage / ticks,
          strScaling: 0,
          intScaling: 0,
          ticks,
          tickRate: TICK_RATE,
          damageType: damageTypeFromText(m[0], 'physical'),
          cooldown: parsedCooldown ?? 0,
          id: `${idBase}-ability-flat-dot`,
        })
      }
    }
  }

  // --- Ability Used: stackable self buff (Gem of Focus/Tekko momentum) ----
  {
    const m = /Ability Used:\s*Gain a stack of Momentum[\s\S]*?Momentum grants\s+\+?(\d+(?:\.\d+)?)%\s+Pathfinding\s+for\s+(\d+(?:\.\d+)?)s\.\s*Stacks up to\s+(\d+)/i.exec(passive)
    if (m) {
      procs.push({
        kind: 'onAbilityCast_selfBuff',
        modifiers: { Pathfinding: Number(m[1]) },
        durationSeconds: Number(m[2]),
        cooldown: 0,
        id: `${idBase}-ability-momentum`,
        stacksMax: Number(m[3]),
        addStacks: 1,
      })
    }
  }

  // --- Ability/basic hit utility debuffs (slow, anti-heal) ----------------
  {
    const slow = /Damaging Ability Hit:\s*(\d+(?:\.\d+)?)%\s*Slow[\s\S]*?lasts\s+for\s+(\d+(?:\.\d+)?)s/i.exec(passive)
    if (slow) {
      procs.push({
        kind: 'onHit_enemyDebuff',
        modifiers: { MovementSpeed: -Number(slow[1]) },
        durationSeconds: Number(slow[2]),
        cooldown: 0,
        stacksMax: 1,
        trigger: 'ability',
        id: `${idBase}-ability-slow`,
      })
    }

    const hitAntiHeal = /Enemies hit by your Basic Attacks or Abilities have\s+(\d+(?:\.\d+)?)%\s+reduced healing\s+for\s+(\d+(?:\.\d+)?)s/i.exec(passive)
    if (hitAntiHeal) {
      procs.push({
        kind: 'onHit_enemyDebuff',
        modifiers: { HealingReduction: Number(hitAntiHeal[1]) },
        durationSeconds: Number(hitAntiHeal[2]),
        cooldown: 0,
        stacksMax: 1,
        trigger: 'any',
        id: `${idBase}-hit-antiheal`,
      })
    }

    const damageAntiHeal = /On God Damage Dealt:\s*Apply\s+(\d+(?:\.\d+)?)%\s+Healing Reduction\s+for\s+(\d+(?:\.\d+)?)s/i.exec(passive)
    if (damageAntiHeal) {
      procs.push({
        kind: 'onHit_enemyDebuff',
        modifiers: { HealingReduction: Number(damageAntiHeal[1]) },
        durationSeconds: Number(damageAntiHeal[2]),
        cooldown: 0,
        stacksMax: 1,
        trigger: 'any',
        id: `${idBase}-damage-antiheal`,
      })
    }
  }

  // --- Ability Hit: Bleed  (damage over time applied by abilities) -------
  {
    const m = /Ability Hit[^:]*:[^.]*(Bleed|Burn)[^.]*?(\d+(?:\.\d+)?)[^.]*?True Damage\s*(\d+)\s*times\s*over\s*(\d+(?:\.\d+)?)s/i.exec(passive)
    if (m) {
      const per = Number(m[2])
      const ticks = Number(m[3])
      const over = Number(m[4])
      procs.push({
        kind: 'onAbilityHit_bleed',
        damagePerTick: per,
        strScaling: 0,
        intScaling: 0,
        ticks,
        tickRate: over / ticks,
        damageType: 'true',
        cooldown: parsedCooldown ?? 5,
        id: `${idBase}-ability-bleed`,
      })
    }
  }

  // --- On Use/Active: Teleport up to X.Ym  (Blink-style relics) ----------
  {
    const m = /(?:On Use|Active):\s*(?:You are\s+)?Teleported?\s+to\s+(?:a\s+targeted\s+location\s+)?up to\s*(\d+(?:\.\d+)?)m/i.exec(passive)
      ?? /(?:On Use|Active):\s*Teleport\s*up to\s*(\d+(?:\.\d+)?)m/i.exec(passive)
    if (m) procs.push({
      kind: 'activeUse_teleport',
      rangeMeters: Number(m[1]),
      cooldown: activeCooldown,
      id: `${idBase}-active-teleport`,
    })
  }

  // --- On Use/Active: Silence enemies for Xs -----------------------------
  {
    const m = /(?:On Use|Active):[^.]*(Silence|Stun|Root|Silenced|Stunned|Rooted)(?:\s+(?:them|enemies|[a-z]+))?\s+for\s+(\d+(?:\.\d+)?)s/i.exec(passive)
    if (m) procs.push({
      kind: 'activeUse_cc',
      flavor: m[1].toLowerCase().startsWith('sil') ? 'silence'
        : m[1].toLowerCase().startsWith('stu') ? 'stun'
        : 'root',
      durationSeconds: Number(m[2]),
      cooldown: activeCooldown,
      id: `${idBase}-active-cc`,
    })
  }

  // --- On Use/Active: +X% Strength / Intelligence / Speed for Ys ---------
  {
    const m = /(?:On Use|Active):\s*\+?(\d+(?:\.\d+)?)%?\s*(Strength|Intelligence|Movement Speed|Attack Speed|Protections)\s+(?:and\s+[A-Za-z\s]+?\s+)?for\s+(\d+(?:\.\d+)?)s/i.exec(passive)
    if (m) {
      const amt = Number(m[1])
      const statWord = m[2].toLowerCase()
      const statKey =
        statWord.startsWith('str') ? 'adaptiveStrength'
        : statWord.startsWith('int') ? 'adaptiveIntelligence'
        : statWord.includes('movement') ? 'MovementSpeed'
        : statWord.includes('attack') ? 'AttackSpeedPercent'
        : statWord.startsWith('prot') ? 'PhysicalProtection'
        : null
      if (statKey) {
        const isPct = /%/.test(m[0])
        const modifiers = statWord.startsWith('str') && isPct
          ? { adaptiveStrengthPercent: amt }
          : statWord.startsWith('int') && isPct
            ? { adaptiveIntelligencePercent: amt }
            : statWord.startsWith('prot') && isPct
              ? { PhysicalProtectionPercent: amt, MagicalProtectionPercent: amt }
              : statWord.startsWith('prot')
          ? { PhysicalProtection: amt, MagicalProtection: amt }
          : { [statKey]: amt }
        procs.push({
          kind: 'activeUse_selfBuff',
          modifiers,
          durationSeconds: Number(m[3]),
          cooldown: activeCooldown,
          id: `${idBase}-active-buff-${statWord.replace(' ', '-')}`,
        })
      }
    }
  }

  // --- On Use/Active: movement-speed aura text split across bullets ------
  {
    const m = /(?:On Use|Active):[\s\S]*?\+?(\d+(?:\.\d+)?)%\s*Movement Speed[\s\S]*?over\s+(\d+(?:\.\d+)?)s/i.exec(passive)
    if (m) {
      procs.push({
        kind: 'activeUse_selfBuff',
        modifiers: { MovementSpeed: Number(m[1]), slowImmune: 1 },
        durationSeconds: Number(m[2]),
        cooldown: activeCooldown,
        id: `${idBase}-active-movement-speed`,
      })
    }
  }

  // --- On Use/Active: Bleed/deal X (+Y per Level) Damage N times over Ms --
  {
    const m = /(?:On Use|Active):[^.]*(\d+(?:\.\d+)?)\s*(?:\(\+(\d+(?:\.\d+)?)\s*per Level\)\s*)?(Physical|Magical|True)\s+Damage\s*(\d+)\s*times\s*over\s*(\d+(?:\.\d+)?)s/i.exec(passive)
    if (m) {
      procs.push({
        kind: 'activeUse_damage',
        baseDamage: Number(m[1]),
        perLevelDamage: m[2] ? Number(m[2]) : 0,
        damageType: m[3].toLowerCase() as 'physical' | 'magical' | 'true',
        ticks: Number(m[4]),
        cooldown: activeCooldown,
        id: `${idBase}-active-damage`,
      })
    }
  }

  // --- On Use/Active: instant active damage ------------------------------
  {
    const m = /(?:On Use|Active):[\s\S]*?(?:Deal(?:ing)?|deals|take Deal|projectile that deals)?\s*\+?(\d+(?:\.\d+)?)(?:\s*\(\+(\d+(?:\.\d+)?)\s*per Level\))?(?:\s*\(\+(\d+(?:\.\d+)?)%\s*Strength(?:\s*&\s*Intelligence)?\))?\s*(Physical|Magical|Magic|True)\s+Damage/i.exec(passive)
    if (m && !/Damage\s+\d+\s+times\s+over/i.test(m[0])) {
      const scaling = m[3] ? Number(m[3]) / 100 : 0
      procs.push({
        kind: 'activeUse_instantDamage',
        baseDamage: Number(m[1]),
        perLevelDamage: m[2] ? Number(m[2]) : 0,
        strScaling: scaling,
        intScaling: scaling,
        targetCurrentHealthPct: 0,
        damageType: damageTypeFromText(m[0], 'physical'),
        cooldown: activeCooldown,
        id: `${idBase}-active-instant-damage`,
      })
    }
  }

  // --- On Use/Active: active enemy debuffs -------------------------------
  {
    if (/(?:On Use|Active):/i.test(passive) && /-\d+(?:\.\d+)?%/.test(passive)) {
      const modifiers: Partial<Record<string, number>> = {}
      const movement = /-(\d+(?:\.\d+)?)%\s*Movement Speed/i.exec(passive)
      const attackSpeed = /-(\d+(?:\.\d+)?)%\s*Attack Speed/i.exec(passive)
      const protections = /-(\d+(?:\.\d+)?)%\s*Protections/i.exec(passive)
      if (movement) modifiers.MovementSpeed = -Number(movement[1])
      if (attackSpeed) modifiers.AttackSpeedPercent = -Number(attackSpeed[1])
      if (protections) {
        modifiers.PhysicalProtectionPercent = -Number(protections[1])
        modifiers.MagicalProtectionPercent = -Number(protections[1])
      }
      if (Object.keys(modifiers).length > 0) {
        const durationMatch = /Debuff lasts\s*(\d+(?:\.\d+)?)s/i.exec(passive)
          ?? /for\s*(\d+(?:\.\d+)?)s/i.exec(passive)
        procs.push({
          kind: 'activeUse_enemyDebuff',
          modifiers,
          durationSeconds: durationMatch ? Number(durationMatch[1]) : 4,
          cooldown: activeCooldown,
          id: `${idBase}-active-enemy-debuff`,
        })
      }
    }
  }

  // --- On Use/Active: Shield self/allies  (Pridwen, Shell, Phantom) -----
  {
    const m = /(?:On Use|Active):[\s\S]*?(?:(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)\*Level|(\d+(?:\.\d+)?)\s*(?:\(\+(\d+(?:\.\d+)?)\s*per Level\)\s*)?)\s*(?:HP\s+)?(?:Health\s+)?Shield(?:\s+yourself|\s+and\s+allies)?/i.exec(passive)
    if (m) {
      const base = Number(m[1] ?? m[3])
      const perLevel = Number(m[2] ?? m[4] ?? 0)
      const duration = /Shield[^.]*for\s+(\d+(?:\.\d+)?)s/i.exec(passive)
      procs.push({
        kind: 'activeUse_shield',
        flatShield: base,
        shieldPerLevel: perLevel,
        maxHealthPct: 0,
        strengthFromItemsPct: 0,
        intelligenceFromItemsPct: 0,
        durationSeconds: duration ? Number(duration[1]) : 3,
        lifestealBonusPct: 0,
        cooldown: activeCooldown,
        id: `${idBase}-active-shield`,
      })
    }
  }

  // --- On Use/Active: utility text we don't model numerically ------------
  {
    const utilityMatch = /(?:On Use|Active):[\s\S]*?(Place a Ward|Place a jade current|Reveal|Dash|Stealthed|Protective Link|wall of light|Stasis|Pulse a reveal|Fire a traveling flare|Create a zone|Marks enemy Gods|Immune to Impediments|walk through player made walls)/i.exec(passive)
    const hasUnmodeledDamage = /(?:Deal|Deals|dealing|Damage equal|True Damage|Physical Damage|Magical Damage|Magic Damage)/i.test(passive)
    if (utilityMatch && !hasUnmodeledDamage) {
      procs.push({
        kind: 'activeUse_utility',
        description: utilityMatch[1],
        cooldown: activeCooldown,
        id: `${idBase}-active-utility`,
      })
    }
  }

  // --- On Use/Active: Immune for Xs (Aegis, Time-lock) -------------------
  {
    const m = /(?:On Use|Active):\s*(?:Become\s+)?Immune[^.]*for\s+(\d+(?:\.\d+)?)s/i.exec(passive)
    if (m) procs.push({
      kind: 'activeUse_selfBuff',
      modifiers: { invulnerable: 1 },
      durationSeconds: Number(m[1]),
      cooldown: activeCooldown,
      id: `${idBase}-active-immune`,
    })
  }

  // --- On Use/Active: CDR (Pendulum-style) -------------------------------
  {
    const m = /(?:On Use|Active):[^.]*Reduce[^.]*(Cooldowns?|cooldown)\s+(?:by\s+)?(\d+(?:\.\d+)?)s/i.exec(passive)
    if (m) procs.push({
      kind: 'activeUse_cdr',
      secondsReduced: Number(m[2]),
      cooldown: activeCooldown,
      id: `${idBase}-active-cdr`,
    })
  }

  return procs
}
