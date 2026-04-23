# Game Data Mining

The project can now index packaged SMITE 2 asset paths directly from a local Steam install without touching the live process.

Current workflow:

```powershell
npm.cmd run extract:smite-assets
npm.cmd run probe:smite-files
```

Optional overrides:

```powershell
npm.cmd run extract:smite-assets -- --game-path="D:\SteamLibrary\steamapps\common\SMITE 2"
npm.cmd run extract:smite-assets -- --focus=Loki,Kali,Sol
npm.cmd run probe:smite-files -- --package=Hemingway/Content/Characters/GODS/Loki/CT_Loki_Stats
```

Outputs:

- `data/extracted/smite2/manifest-asset-index.json`
- `data/extracted/smite2/manifest-asset-summary.md`
- `tools/SmiteAssetProbe/out/*.structure.json`
- `tools/SmiteAssetProbe/out/*.exports.json`
- `tools/SmiteAssetProbe/out/*.pseudo.cpp`

What this gives us today:

- A repeatable index of packaged asset paths from `Manifest_UFSFiles_Win64.txt`
- Classification for high-value assets such as `EquipmentInfo_*`, `EquipmentItem_*`, `CT_*EffectValues`, `GE_*`, `TalentInfo_*`, `AbilitySet_*`, and target-dummy assets
- A ranked list of likely formula-bearing packages
- Focus-god slices for quick manual investigation
- Direct deserialization for at least some local `UCurveTable` assets via a local mappings provider
- Raw-file-backed stat extraction from selected item and gameplay-effect assets

Current exact values recovered from local files:

- `CT_Loki_Stats` gives Loki level curves, including `Character.Stat.InhandPower = 93.36` at level `20`
- `CT_Loki_A02_EffectValues` gives Loki 2 rank curves, including `Base Damage = 20/25/30/35/40` and `Physical Power Scaling = 0.15`
- `EquipmentItem_Item_HydrasLament` tooltip payload exposes file-backed item values consistent with `PhysicalPower = 45`, `MaxMana = 200`, and `ManaPerTime = 10`
- `GE_Items_HydrasLament` names and payloads expose `PhysicalPowerItem`, `MaxManaItem`, `ManaPerTimeItem`, and `CooldownRateItem`
- `EquipmentItem_Item_SerpentSpear` tooltip payload exposes file-backed item values consistent with `PhysicalPower = 40` and `PhysicalPenetrationPercent = 35`
- `GE_Items_TitansBane_Shattering` exposes `PhysicalPenetrationPercentItem` and `MagicalPenetrationPercentItem`, with `35` present in the payload

Current file-only proof for damage and mitigation:

- `GE_Damage_GenericHit` resolves to `/Script/Hemingway.HWGameplayEffect_Damage` and references `Effect.Type.Damage.Physical` plus `Health`, which is the clearest client-file evidence that generic hits are applied through a dedicated Hemingway damage effect against the health attribute
- `GE_Damage_GenericHit` also imports both `/Script/Hemingway.HWAttributeSet_Core` and `/Script/Hemingway.HWAttributeSet_Character_Base`, which places the damage effect in the same attribute-set layer as combat stats
- `GEMMC_BaseStat_PhysicalProtection`, `GEMMC_BaseStat_PhysicalProtectionItems`, `GEMMC_BaseStat_PhysicalPenetrationFlat`, `GEMMC_BaseStat_PhysicalPenetrationPercent`, and `GEMMC_BaseStat_DamageTakenPercentModifier` all resolve to `/Script/Hemingway.HWGEMMC_CharacterBaseStat`, which shows these values are computed as dedicated magnitude-calculated combat stats rather than anonymous item-local numbers
- `GE_Items_VoidShield_PhysicalProtectionDebuff_Close` references `PhysicalProtection`, `PhysicalProtectionBase`, and `PhysicalProtectionItem`, which is direct proof that at least one penetration-style debuff item targets protection attributes themselves
- `GE_Items_TitansBane_Shattering` references `PhysicalPenetrationPercentItem` and `MagicalPenetrationPercentItem`, which is direct proof that item penetration effects are represented as named combat attributes in client assets
- The shipping binary contains `HWGameplayCompositeAttribute`, `HWAttributeSet_Core.cpp`, `OnRep_DamageDealtPercentModifierBase`, `OnRep_DamageDealtPercentModifierItem`, `OnRep_DamageTakenPercentModifier`, and `Player.Stat.Mitigation`, which strongly supports a client architecture where the final combat state is assembled in the core attribute set before damage is applied

New numeric evidence from local files:

- `GE_Damage_GenericHit` default-object payload carries `PhysicalInhandPower` and `Health`, which supports the interpretation that generic hit damage consumes a named power input and writes into the health attribute
- `GE_Loki_A02_DamageMitigation_Talent` names `DamageTakenPercentModifier`, imports `CT_Loki_A02_EffectValues`, and exposes a `DecreasedDamageTaken` UI string, which is direct proof that this Loki mitigation effect is implemented as a damage-taken modifier rather than as a protection buff
- `CT_Loki_A02_EffectValues` row `Talent Mitigation for Allies` has exact file-backed values `15 / 17.5 / 20 / 22.5 / 25`, and `Talent Duration for Allies` is `3`
- `GE_Items_TitansBane_Shattering` default-object payload contains two `35.0` values, and `GE_Items_ObsidianShard_Shattering` does the same, alongside `PhysicalPenetrationPercentItem` and `MagicalPenetrationPercentItem`
- `GE_Items_VoidShield_PhysicalProtectionDebuff_Close` default-object payload contains two `-0.05` values alongside `PhysicalProtection`, `PhysicalProtectionItem`, and `PhysicalProtectionBase`
- `GE_Items_VoidStone_MagicalProtectionDebuff_Close` default-object payload contains two `-0.05` values alongside `MagicalProtection`, `MagicalProtectionItem`, and `MagicalProtectionBase`
- `GE_Items_VoidShield_PhysicalProtectionDebuff_Medium` and `GE_Items_VoidShield_PhysicalProtectionDebuff_Far` serialize the same `-0.05` pattern as the close variant in the current client build

Binary-side limitation observed:

- The shipping binary exposes a source breadcrumb for `HWGEExecCalc_Heal.cpp`, but this pass did not surface an equivalent `HWGEExecCalc_Damage.cpp` or similarly named damage execution file
- Combined with the `HWGameplayEffect_Damage` asset/class evidence, the current best file-only inference is that at least some damage handling may be encapsulated in the custom damage gameplay-effect class rather than a separately named execution calculator that leaves obvious string breadcrumbs

Current proof standard:

- Proven from files: the game has explicit core attributes for protections, flat pen, percent pen, dealt modifiers, taken modifiers, and mitigation, and it applies generic damage through a dedicated damage gameplay effect that targets health
- Strongly implied from files: composite/core attributes are aggregated first, item and debuff gameplay effects write into those attributes, and damage effects then consume the resulting combat state
- Not yet proven from files: the exact arithmetic order between protection shred, protection reduction, flat pen, percent pen, damage dealt modifiers, damage taken modifiers, and the final mitigation formula
- Until deeper decoder coverage lands, calculator math should only use coefficients we can cite directly and should label any order-of-operations assumptions as unverified

What this does not solve yet:

- It does not decode `.uasset` or `.uexp` payload contents from the IoStore containers
- It does not recover server-authoritative logic if any combat math is validated server-side
- It does not guarantee exact damage formulas without a deeper Unreal asset decoder or trusted hand-verified formulas
- Blueprint gameplay effect payloads are still only partially decoded; some values are inferred from nearby stat names and raw serialized floats

Current practical conclusion:

- Static data discovery is feasible from the client install
- We can already pull several exact god and item values from the client files without using external sites
- `UCurveTable` assets are the current highest-signal path for reliable file-only coefficients
- Full combat order-of-operations is still not proven from files alone, so calculator math should only use values we can cite directly until more decoder coverage is added

Additional findings from deeper local-only digging:

- The probe now enables `ReadScriptData` and writes `*.pseudo.cpp` files for class exports. For the combat assets investigated so far, those pseudo outputs are empty blueprint shells such as `class UGE_Damage_GenericHit_C : public UHWGameplayEffect_Damage;`, `class UBP_GEExecCalc_DamageTarget_ObsidianDagger_C : public UHWGEExecCalc_DamageTarget;`, and `class UGEMMC_BaseStat_PhysicalPenetrationPercent_C : public UHWGEMMC_CharacterBaseStat;`. That is strong evidence that the real combat logic sits in native Hemingway classes rather than in blueprint bytecode.
- `GE_Damage_GenericHit` names `Ability.Type.Inhand`, `Effect.Config.AttackPowerScaling.InhandPhysical`, `Effect.Type.Damage.Physical`, and `Health`, while its default-object payload carries `PhysicalInhandPower` and `Health`. This is the cleanest file-backed generic-hit shape recovered so far: inhand attack-power input feeding a native damage effect that writes health.
- `GE_Loki_A02_Damage` is more explicit than the generic hit asset. It names `Base Damage`, `Effect.Config.AttackPowerScaling.Physical`, `Effect.Config.BaseDamage`, `Effect.Type.Damage.Physical`, `GameplayCue.Loki.A02.Hit`, and `PhysicalPower`, and it imports both `HWGEExecCalc_DamageTarget` and `CT_Loki_A02_EffectValues`. That is direct proof that a concrete ability damage effect is layered as native damage execution plus curve-table-backed coefficients.
- `CT_Loki_A02_EffectValues` now gives a complete mini-model for Loki 2 from local files:
  - `Base Damage`: `20 / 25 / 30 / 35 / 40`
  - `Physical Power Scaling`: `0.15`
  - `Damage Dealt Reduction`: `5`
  - `Damage Reduction %`: `-5`
  - `Max Stack Count`: `4`
  - `Damage Reduction Duration`: `2.5`
  - `Blinded Duration`: `3`
  - `Talent Duration for Allies`: `3`
  - `Talent Mitigation for Allies`: `15 / 17.5 / 20 / 22.5 / 25`
  - `Talent Slow`: `15`
- Loki 2 is implemented as multiple separate gameplay effects, not one monolithic asset:
  - `GE_Loki_A02_Damage` handles the actual damage path through `HWGameplayEffect_Damage` and `HWGEExecCalc_DamageTarget`
  - `GE_Loki_A02_BlindedTracker` is the debuff carrier; it names `Blinded Duration`, `GameplayCue.Loki.A02.BlindVFX`, `Gods.Loki.A02.Blinded`, `Status.Debuff`, imports `GEAR_IsEnemy`, and imports the same A02 curve table
  - `GE_Loki_A02_DamageReduction` names `Damage Reduction %`, `Damage Reduction Duration`, and writes into `DamageDealtPercentModifierBase`
  - `GE_Loki_A02_DamageMitigation_Talent` writes into `DamageTakenPercentModifier`
- The protection and penetration item layering is now clearer:
  - `GE_Items_TitansBane_Shattering` names `PhysicalPenetrationPercentItem` and `MagicalPenetrationPercentItem` and serializes `35.0`
  - `GE_Items_ObsidianShard_Shattering` does the same
  - `GE_Items_Generic_Piercing` serializes four `-0.06` values and targets `PhysicalProtection`, `PhysicalProtectionItem`, `PhysicalProtectionBase`, `MagicalProtection`, `MagicalProtectionItem`, and `MagicalProtectionBase`
  - `GE_Items_VoidShield_PhysicalProtectionDebuff_Close` serializes `-0.05` against `PhysicalProtection`, `PhysicalProtectionItem`, and `PhysicalProtectionBase`
  - `GE_Items_VoidShield_PhysicalProtectionDebuff_Medium` and `..._Far` serialize the same `-0.05` pattern as the close asset
- Local binary string mining against `Hemingway-Win64-Shipping.exe` exposed the native combat attribute neighborhoods even though the formulas themselves remain compiled:
  - one neighborhood contains `PhysicalPenetrationFlat`, `PhysicalPenetrationFlatBase`, `PhysicalPenetrationFlatItem`, `PhysicalPenetrationPercent`, `PhysicalPenetrationPercentBase`, `PhysicalPenetrationPercentItem`, `PhysicalProtection`, `PhysicalProtectionBase`, and `PhysicalProtectionItem`
  - another contains `DamageDealtPercentModifier`, `DamageDealtPercentModifierBase`, `DamageDealtPercentModifierItem`, `DamageDealtFlatModifier`, `DamageTakenPercentModifier`, `DamageTakenPercentModifierBase`, `DamageTakenPercentModifierItem`, and `DamageTakenFlatModifier`
  - replication breadcrumbs exist for `OnRep_DamageDealtPercentModifierBase`, `OnRep_DamageDealtPercentModifierItem`, `OnRep_DamageTakenPercentModifier`, `OnRep_DamageTakenPercentModifierBase`, `OnRep_DamageTakenPercentModifierItem`, `OnRep_PhysicalPenetrationFlat`, `OnRep_PhysicalPenetrationFlatBase`, `OnRep_PhysicalPenetrationFlatItem`, `OnRep_PhysicalPenetrationPercent`, `OnRep_PhysicalPenetrationPercentBase`, `OnRep_PhysicalPenetrationPercentItem`, `OnRep_PhysicalProtection`, `OnRep_PhysicalProtectionBase`, and `OnRep_PhysicalProtectionItem`
  - gameplay-tag strings in the same binary include `Character.Stat.PhysicalProtection`, `Character.Stat.MagicalProtection`, `Character.Stat.InhandPower`, `Character.Stat.PhysicalPenetrationPercent`, `Player.Stat.Damage`, and `Player.Stat.Mitigation`
- The binary also leaks native source-path breadcrumbs:
  - `H:\hemingway\Hemingway\Source\Hemingway\Private\AbilitySystem\AttributeSets\HWAttributeSet_Core.cpp`
  - `H:\hemingway\Hemingway\Source\Hemingway\Private\AbilitySystem\GameplayEffects\Executions\HWGEExecCalc_Heal.cpp`
  - `H:\hemingway\Hemingway\Source\Hemingway\Private\AbilitySystem\GameplayEffects\ModifierMagnitudes\HWGEMMC_Cooldown.cpp`
  - there is still no surviving `HWGEExecCalc_Damage*.cpp` source-path breadcrumb in the current client build

Current best file-backed layering model:

1. Coefficients and durations live in data assets such as `CT_*EffectValues` and god stat tables.
2. Items and abilities instantiate concrete gameplay effects that target named combat attributes like `PhysicalProtectionBase`, `PhysicalProtectionItem`, `PhysicalPenetrationPercentItem`, `DamageDealtPercentModifierBase`, and `DamageTakenPercentModifier`.
3. Native Hemingway attribute-set code in `HWAttributeSet_Core` appears to own the current/base/item combat state and replication for those fields.
4. Native Hemingway damage effects and execution code consume those attributes and apply final damage into `Health`, with `Player.Stat.Mitigation` present as a downstream combat-stat output.

What is still not proven even after this deeper pass:

- the exact arithmetic inside the native damage path
- the exact order between protection-targeting debuffs, flat pen, percent pen, damage dealt modifiers, damage taken modifiers, and the final mitigation multiplier
- whether `Player.Stat.Mitigation` is computed strictly client-side, strictly server-side, or mirrored in both
