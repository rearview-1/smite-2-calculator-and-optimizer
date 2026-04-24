# Aspects — data coverage and sim wiring status

Generated from `data/aspects-catalog.json` + the aspect-on/off regression harness at `c:\tmp\aspect-verify.js`.

## Sources

- `ST_HW_God_Talents` (string table) — master aspect NAME + DESCRIPTION per god.
- Per-god `ST_HW_<God>_AbilityDescriptions` — `<God>.Talent.N.A0X.*` per-ability tooltip overrides.
- `Common_Talents/Talent_N/CT_<God>_Talent{N}_EffectValues` — dedicated aspect CurveTable (dedicated CT, 19 gods).
- Regular ability CT rows prefixed `Talent*` / suffixed ` Talent` (base-CT rows, 32 gods).
- `Common_Talents/Talent_N/GE_*` — ability-level mods (CDR, damage adds, buffs). Classified by filename pattern.

## Tier definitions

| Tier | Meaning |
|---|---|
| CT | Has a dedicated `CT_<God>_Talent{N}_EffectValues` curve table |
| BASE | Has `Talent*`-prefixed or `* Talent` suffixed rows inside the regular ability CTs |
| TEXT | Per-ability talent overrides in strings, but no numeric rows in any CT |
| NAME | Only the aspect name + description from `ST_HW_God_Talents` (no numeric data) |
| PLACE | `Common_Talents` folder has loose files but no structured content |
| NONE | No aspect data in the current probe dump |

## Sim status definitions

| Sim status | Meaning |
|---|---|
| WIRED | Enabling the aspect changes total sim damage by ≥0.5% on an A01→A02→A03→A04 rotation |
| NO_DELTA | Aspect data exists but toggling it produces no damage change (aspect is behavioral-only, or the generic row-mapper didn't find a match) |
| PLACEHOLDER | `ST_HW_God_Talents` entry is `"DNT"`, `"Placeholder Desc"`, or `"<God>_01"` — not shippable |
| NO_DATA | No aspect data at all |

## Totals

- **81** gods in catalog.
- **65** have extractable aspect data.
- **26** of those are WIRED to sim.
- **37** are data-only / behavioral-only (`NO_DELTA`).
- **2** placeholders (`Odin`, `Atlas`).
- **16** have no aspect data in the probe dump (`NO_DATA`).

## Per-god matrix

| God | Data tier | Sim status | Aspect name |
|---|---|---|---|
| Achilles | TEXT | NO_DELTA | Aspect of Prowess |
| Agni | BASE | WIRED | Aspect of Combustion |
| Aladdin | NONE | NO_DATA | — |
| Amaterasu | NAME | NO_DELTA | Aspect Of Valor |
| Anhur | CT | NO_DELTA | Aspect of Pride |
| Anubis | NONE | NO_DATA | — |
| Aphrodite | NONE | NO_DATA | — |
| Apollo | BASE | NO_DELTA | Aspect of Harmony |
| Ares | TEXT | NO_DELTA | Aspect of Reverberation |
| Artemis | BASE | WIRED | Aspect of the Wild |
| Artio | BASE | NO_DELTA | (name not in master table) |
| Athena | CT | WIRED | Aspect of War |
| Atlas | BASE | PLACEHOLDER | Aspect of the Unburdened |
| Awilix | PLACE | NO_DELTA | (name not in master table) |
| Bacchus | CT | NO_DELTA | Aspect of Revelry |
| Bari | NONE | NO_DATA | — |
| Baron_Samedi | NAME | NO_DELTA | Aspect of Hysteria |
| Bellona | CT | NO_DELTA | Aspect of Vindication |
| Cabrakan | TEXT | WIRED | (name not in master table) |
| Cerberus | TEXT | NO_DELTA | Aspect of Souls |
| Cernunnos | BASE | NO_DELTA | Aspect of Strife |
| Chaac | CT | WIRED | Aspect of Fulmination |
| Charon | PLACE | NO_DELTA | (name not in master table) |
| Chiron | BASE | NO_DELTA | (name not in master table) |
| Cupid | CT | WIRED | Aspect of Love |
| DaJi | BASE | WIRED | Aspect of Ferocity |
| Danzaburou | CT | NO_DELTA | Aspect of Fellowship |
| Discordia | BASE | WIRED | Aspect of the Gilded Victor |
| Eset | BASE | WIRED | (name not in master table) |
| Fenrir | CT | WIRED | Aspect of Loyalty |
| Ganesha | BASE | WIRED | Aspect of the Triumphant |
| Geb | CT | WIRED | Aspect of Calamity |
| Gilgamesh | CT | WIRED | Aspect of Shamash |
| Guan_Yu | NAME | NO_DELTA | Aspect of the General |
| Hades | NONE | NO_DATA | — |
| Hecate | CT | NO_DELTA | Aspect of Ruin |
| Hercules | CT | NO_DELTA | Aspect of Preservation |
| HouYi | NONE | NO_DATA | — |
| Hun_Batz | BASE | WIRED | Aspect of Disruption |
| Ishtar | BASE | WIRED | (name not in master table) |
| Izanami | NONE | NO_DATA | — |
| Janus | NONE | NO_DATA | — |
| JingWei | NONE | NO_DATA | — |
| Jormungandr | BASE | WIRED | Aspect of the Unyielding |
| Kali | NAME | NO_DELTA | Aspect of Unbound Destruction |
| Khepri | TEXT | NO_DELTA | Aspect of Laceration |
| Kukulkan | BASE | WIRED | Aspect of the Squall |
| Loki | CT | NO_DELTA | Aspect of Agony |
| Medusa | NONE | NO_DATA | — |
| Mercury | NONE | NO_DATA | — |
| Merlin | CT | NO_DELTA | Aspect of Pandemonium |
| Mordred | TEXT | NO_DELTA | Aspect of Rage |
| MorganLeFay | BASE | NO_DELTA | Aspect of the Cursed Crown |
| Mulan | NONE | NO_DATA | — |
| Ne_Zha | BASE | NO_DELTA | (name not in master table) |
| Neith | CT | NO_DELTA | Aspect of Wind |
| Nu_Wa | BASE | NO_DELTA | Aspect of Shining Mist |
| Nut | BASE | NO_DELTA | Aspect of the Cosmos |
| Odin | PLACE | PLACEHOLDER | Odin_01 (placeholder) |
| Osiris | BASE | NO_DELTA | (name not in master table) |
| Pele | BASE | NO_DELTA | Aspect of Obsidian |
| Poseidon | CT | NO_DELTA | Aspect of the Trident |
| Ra | CT | NO_DELTA | Aspect of Thermotherapy |
| Rama | BASE | WIRED | Aspect of Precision |
| Ratatoskr | BASE | NO_DELTA | Aspect of the Thickbark (handled via acorn items, not generic aspect path) |
| Scylla | BASE | WIRED | Aspect of the Devourer |
| Sobek | BASE | WIRED | Aspect of Prey |
| Sol | BASE | WIRED | Aspect of Conflagration |
| Sun_Wukong | BASE | NO_DELTA | Aspect of Transformation |
| Susano | NONE | NO_DATA | — |
| Sylvanus | CT | NO_DELTA | Aspect of Grover's Wrath |
| Thanatos | CT | WIRED | Aspect of Reaping |
| The_Morrigan | BASE | NO_DELTA | Aspect of Mischief |
| Thor | BASE | NO_DELTA | Aspect of Thunderstruck |
| Tsukuyomi | BASE | WIRED | (name not in master table) |
| Ullr | NONE | NO_DATA | — |
| Vulcan | BASE | WIRED | Aspect of Fortification |
| Xbalanque | BASE | WIRED | Aspect of the Nightstalker |
| Yemoja | TEXT | WIRED | Aspect of Downpour |
| Ymir | NONE | NO_DATA | — |
| Zeus | NONE | NO_DATA | — |

## Why NO_DELTA?

Broadly one of three reasons:

1. **Basic-attack-only aspect**. Many aspects (Bacchus Revelry, Neith Wind, Poseidon Trident, Anhur Pride, Sylvanus Grover's Wrath, Cernunnos Strife) modify *basic attacks*. The verify harness uses an ability-only rotation, so BA mods don't surface.
2. **Behavioral-only aspect**. Aspects like Loki Agony (Bleed → Blind, backstab prot mechanics), Hecate Ruin (spell-eater refire gated), Merlin Pandemonium (random stance selection), and The_Morrigan Mischief (Confusion swaps positions) have no numeric delta that maps onto the sim's damage model.
3. **Needs per-god handler**. A few aspects with numeric data (MorganLeFay Cursed Crown, Sun_Wukong Transformation, Chiron A02 per-stack damage) require god-specific sim logic that the generic row-mapper doesn't cover.

The catalog still contains ALL of their data; the sim just doesn't apply it yet.

## Accuracy provenance

All numeric values in `aspects-catalog.json` come directly from the CurveTable exports in `tools/SmiteAssetProbe/out/`. The extractor performs no interpolation, inference, or manual entry — if a number appears in the catalog, it was read verbatim from a `.exports.json` file produced by the asset probe.

## Regenerate

```
python scripts/build-aspects-catalog.py
```

Writes to `data/aspects-catalog.json`.
