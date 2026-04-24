#!/usr/bin/env python3
"""Build data/gods-catalog.json — complete kit per god from probed game files.

Sources (all from Hemingway paks):
- CT_<God>_Stats.exports.json — base stats curves keyed by Character.Stat.* tag, over level 1..20
- CT_<God>_A0X_EffectValues.exports.json — per-ability rank values (Base Damage, scaling, cost, etc.)
- GE_<God>_A0X_*Damage*.exports.json — damage GEs that carry the Effect.Type.Damage.*
  and Effect.Config.AttackPowerScaling.* tags (damage type + scaling identity)
- data/effects-catalog.json — authored tooltip text per ability and passive

Output: {
  "<God>": {
    "stats": {"<StatTag>": {"interp": "linear"|"step", "keys": [{t,v}, ...]}, ...},
    "abilities": {
      "A01": {
        "name": ...,
        "description": ...,
        "damageType": "physical"|"magical"|"true"|null,
        "scalingTags": [...],
        "rankValues": {"<row>": {"interp":..., "keys":[...]} , ...},
        "sources": {...}
      },
      ...,
      "Passive": {...}
    }
  }
}
"""
import json
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

REPO = Path(__file__).resolve().parents[1]
OUT_DIR = REPO / "tools" / "SmiteAssetProbe" / "out"
DATA_DIR = REPO / "data"
CATALOG_PATH = DATA_DIR / "gods-catalog.json"
EFFECTS_PATH = DATA_DIR / "effects-catalog.json"


def read_curve_table(path):
    """Parse a CurveTable export into {rowName: {interp, keys:[(t,v)]}}."""
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    table = None
    for entry in data:
        if entry.get('Type') == 'CurveTable':
            table = entry; break
    if not table:
        return {}
    rows = table.get('Rows', {}) or {}
    out = {}
    for name, row in rows.items():
        keys_raw = row.get('Keys[1]') or []
        if not keys_raw:
            continue
        interp = 'step' if row.get('InterpMode') == 1 else 'linear'
        out[name] = {
            'interp': interp,
            'keys': [{'t': k.get('Time'), 'v': k.get('Value')} for k in keys_raw],
        }
    return out


# Folder names under /GODS_/ that are NPC/familiar assets, not playable gods.
# They have their own CT_*_Stats but belong to their owner god and must not
# produce a standalone catalog entry.
FAMILIAR_EXCLUDES = {
    'Artemis_Familiar',
    'Cerberus_Familiar',
    'Vulcan_Familiar',
    'Vulcan_Familiar_Thumper',
}


def discover_gods():
    """Find every god by enumerating CT_*_Stats files. Returns a list of
    (folder_name, ct_stem) tuples because a handful of gods have folder-vs-CT
    filename drift we must tolerate:
        The_Morrigan -> CT_Morrigan_Stats
        Baron_Samedi -> CT_BaronSamedi_Stats
        Nu_Wa        -> CT_NuWa_Stats
        DaJi         -> CT_Daji_Stats
    Downstream code uses `folder` for ability globbing and `ct_stem` for the
    stats file only.
    """
    prefix = 'Hemingway_Content_Characters_GODS_'
    suffix = '_Stats.structure.json'
    seen: dict[str, str] = {}
    for p in OUT_DIR.glob(f'{prefix}*_CT_*_Stats.structure.json'):
        name = p.name
        if not (name.startswith(prefix) and name.endswith(suffix)):
            continue
        core = name[len(prefix):-len(suffix)]
        # core = <folder>_CT_<ct_stem>. Folders can contain underscores, so
        # anchor on the LAST '_CT_' separator.
        idx = core.rfind('_CT_')
        if idx < 0:
            continue
        folder = core[:idx]
        ct_stem = core[idx + 4:]
        if folder in FAMILIAR_EXCLUDES:
            continue
        # Dedup: keep the shortest ct_stem if two match the same folder (there
        # shouldn't be, but be defensive).
        if folder not in seen or len(ct_stem) < len(seen[folder]):
            seen[folder] = ct_stem
    return sorted(seen.items())


def read_stats(god_folder, ct_stem=None):
    """Return {statName: curve} for this god's base stats. Most gods have
    `ct_stem == god_folder`; a few (The_Morrigan, Baron_Samedi, Nu_Wa, DaJi)
    use a differently-spelled CT file — pass the CT stem explicitly."""
    if ct_stem is None:
        ct_stem = god_folder
    path = OUT_DIR / f'Hemingway_Content_Characters_GODS_{god_folder}_CT_{ct_stem}_Stats.exports.json'
    if not path.exists():
        return {}
    curves = read_curve_table(path)
    # Strip the "Character.Stat." prefix for convenience
    out = {}
    for k, v in curves.items():
        if k.startswith('Character.Stat.'):
            out[k.replace('Character.Stat.', '', 1)] = v
        elif k and not k.startswith('-'):
            out[k] = v
    return out


def read_ability_values(god, slot):
    """Search for this god's ability EffectValues file. Tolerant of folder/naming variants:
    - Most gods: /Abilities/Ability<N>/LevelConfigs/CT_<God>_A0<N>_EffectValues
    - Auxiliary packages: /Abilities/Ability<N>_Projectile/LevelConfigs/CT_<God>_A0<N>_Inhand_EffectValues
    - Anhur: /Ablities/... (typo in folder name)
    - Hercules: /Abilities/A0<N>/LevelConfigs/... (short subfolder name)
    - HouYi: CT_Hou_Yi_A0<N>_... (underscore in CT name despite HouYi folder)
    """
    # Glob patterns that cover every variant we've seen. Merge all matching
    # tables because some abilities keep projectile/inhand damage in auxiliary
    # packages while the base ability table only has cost/cooldown/buff rows.
    variants = [
        # Standard and auxiliary: /Abilities/Ability<N>*/LevelConfigs/
        f'Hemingway_Content_Characters_GODS_{god}_Common_Abilities_Ability{slot}*_LevelConfigs_CT_*_A0{slot}*_EffectValues.exports.json',
        # Anhur: typo'd folder 'Ablities'
        f'Hemingway_Content_Characters_GODS_{god}_Common_Ablities_Ability{slot}*_LevelConfigs_CT_*_A0{slot}*_EffectValues.exports.json',
        # Hercules: short subfolder A01 instead of Ability1
        f'Hemingway_Content_Characters_GODS_{god}_Common_Abilities_A0{slot}*_LevelConfigs_CT_*_A0{slot}*_EffectValues.exports.json',
    ]
    paths = []
    for pattern in variants:
        for path in OUT_DIR.glob(pattern):
            paths.append(path)

    if not paths:
        return None, []

    # Prefer non-OldSmite and load the base ability table before auxiliary
    # projectile/inhand tables so auxiliary real damage rows can replace
    # placeholder values like "Damage = 5".
    paths = sorted(
        set(paths),
        key=lambda p: (
            1 if 'OldSmite' in p.name else 0,
            0 if f'_Ability{slot}_LevelConfigs_' in p.name or f'_A0{slot}_LevelConfigs_' in p.name else 1,
            p.name,
        ),
    )

    merged = {}
    source_files = []
    for path in paths:
        curves = read_curve_table(path)
        if curves:
            merged.update(curves)
            source_files.append(path.name)
    return (merged or None), source_files


def read_damage_ge(god, slot):
    """Read GE files for this ability and pull damage-type / scaling tags.

    We used to glob only `GE_*Damage*` files, which missed abilities whose damage
    lives in differently-named GEs (Hades Pillar → GE_*_Hit, Chaac Thunder → GE_*_Tick,
    Artemis Boar → GE_*_BoarAttack, etc.). Instead, scan EVERY GE for the ability
    slot and accept the file if its `names` list contains `Effect.Type.Damage.*`
    — that's the authoritative marker for "this GE applies damage".
    """
    tags = set()
    damage_type = None
    scaling_tags = set()
    damage_ge_files = []
    all_ge_patterns = [
        f'Hemingway_Content_Characters_GODS_{god}_Common_Abilities_Ability{slot}*_GameplayEffects_GE_*.structure.json',
        f'Hemingway_Content_Characters_GODS_{god}_Common_Ablities_Ability{slot}*_GameplayEffects_GE_*.structure.json',
        f'Hemingway_Content_Characters_GODS_{god}_Common_Abilities_A0{slot}*_GameplayEffects_GE_*.structure.json',
    ]
    for pattern in all_ge_patterns:
        for p in OUT_DIR.glob(pattern):
            # Skip gameplay cues (visual/audio effects) only. Some gods' GE
            # files live under `.uasset.structure.json` (Anhur's folder is
            # typo'd as `Ablities` and has no plain `.structure.json` variant),
            # so we must accept .uasset.structure.json files.
            if '_GC_' in p.name:
                continue
            try:
                with open(p, encoding='utf-8') as f:
                    d = json.load(f)
            except Exception:
                continue
            names = d.get('names', []) or []
            # Only treat this GE as a damage source if it declares a damage type
            has_damage_type = any(n.startswith('Effect.Type.Damage.') for n in names)
            if not has_damage_type:
                continue
            damage_ge_files.append(p.name)
            for n in names:
                tags.add(n)
                if n == 'Effect.Type.Damage.Physical':
                    if damage_type is None: damage_type = 'physical'
                elif n == 'Effect.Type.Damage.Magical':
                    if damage_type is None: damage_type = 'magical'
                elif n == 'Effect.Type.Damage.True':
                    if damage_type is None: damage_type = 'true'
                elif n.startswith('Effect.Config.AttackPowerScaling.'):
                    scaling_tags.add(n.split('.', 3)[-1])  # 'Physical' / 'Magical'
                elif n == 'Strength Scaling':
                    scaling_tags.add('Strength')
                elif n == 'Intelligence Scaling' or n == 'Int Scaling':
                    scaling_tags.add('Intelligence')
    return {
        'damageType': damage_type,
        'scalingTags': sorted(scaling_tags),
        'allTags': sorted(tags),
        'sourceFiles': damage_ge_files,
    }


def load_effects():
    if not EFFECTS_PATH.exists():
        return {}
    with open(EFFECTS_PATH, encoding='utf-8') as f:
        return json.load(f)


def canonical_god_key(god_dir_name, effects_index):
    """Map disk folder name (e.g. 'Baron_Samedi', 'The_Morrigan', 'DaJi') to the effects-catalog key
    (e.g. 'BaronSamedi', 'TheMorrigan', 'Daji')."""
    candidates = [
        god_dir_name,
        god_dir_name.replace('_', ''),
        god_dir_name.title().replace('_', ''),
        god_dir_name.lower().replace('_', ''),
    ]
    normalized_cat = {k.lower().replace('_', ''): k for k in effects_index}
    target = god_dir_name.lower().replace('_', '')
    return normalized_cat.get(target)


def main():
    effects = load_effects()
    god_passives = effects.get('godPassives', {})

    gods = discover_gods()
    print(f'Gods discovered: {len(gods)}')

    catalog = {}
    for god, ct_stem in gods:
        effects_key = canonical_god_key(god, god_passives)
        eff = god_passives.get(effects_key, {}) if effects_key else {}
        eff_abilities = eff.get('abilities', {}) or {}

        abilities = {}
        for slot_idx, slot in enumerate(['1', '2', '3', '4'], start=1):
            rank_values, rank_source_files = read_ability_values(god, slot)
            dmg = read_damage_ge(god, slot)
            ability_name_data = eff_abilities.get(f'A0{slot}', {}) if eff_abilities else {}
            abilities[f'A0{slot}'] = {
                'name': ability_name_data.get('name'),
                'description': ability_name_data.get('description'),
                'damageType': dmg.get('damageType'),
                'scalingTags': dmg.get('scalingTags'),
                'rankValues': rank_values,
                'sources': {
                    'curveTable': rank_source_files[0] if rank_source_files else None,
                    'curveTables': rank_source_files,
                    'damageGEs': dmg.get('sourceFiles'),
                },
            }

        # Passive: pick up from effects catalog (name + description); numerical values
        # are usually in GE_<God>_Talent_Damage or similar
        passive = {
            'name': eff.get('passiveName'),
            'description': eff.get('passiveDescription'),
            'allDescriptions': eff.get('passiveDescriptionsAll'),
            'talentVariants': eff.get('talentPassives'),
        }

        catalog[god] = {
            'god': god,
            'effectsKey': effects_key,
            'stats': read_stats(god, ct_stem),
            'abilities': abilities,
            'passive': passive,
            'sources': {
                'stats': f'CT_{ct_stem}_Stats',
            },
        }

    DATA_DIR.mkdir(exist_ok=True)
    with open(CATALOG_PATH, 'w', encoding='utf-8') as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)

    # Report
    total = len(catalog)
    with_stats = sum(1 for g in catalog.values() if g['stats'])
    with_abilities = sum(1 for g in catalog.values() if any(a.get('rankValues') for a in g['abilities'].values()))
    with_passive_name = sum(1 for g in catalog.values() if g['passive'].get('name'))
    with_passive_desc = sum(1 for g in catalog.values() if g['passive'].get('description'))

    print(f'Gods in catalog: {total}')
    print(f'  with base-stat curves: {with_stats}')
    print(f'  with any ability rank values: {with_abilities}')
    print(f'  with passive name: {with_passive_name}')
    print(f'  with passive description: {with_passive_desc}')

    # Report damage-type coverage per ability
    from collections import Counter
    dmg_types = Counter()
    for g in catalog.values():
        for a in g['abilities'].values():
            dmg_types[a.get('damageType')] += 1
    print(f'  damage types: {dict(dmg_types)}')

    # Spot-check
    print()
    for god in ['Kali', 'Discordia', 'Loki', 'Bellona']:
        if god not in catalog:
            print(f'{god}: missing')
            continue
        g = catalog[god]
        ek = g['effectsKey']
        pname = g['passive']['name']
        print(f'{god}: effectsKey={ek}')
        print(f'  passive: {pname}')
        for slot, a in g['abilities'].items():
            rv = a.get('rankValues') or {}
            rows = list(rv.keys())[:4]
            aname = a.get('name')
            dtype = a.get('damageType')
            print(f'  {slot}: name={aname!r} type={dtype} rows={rows}')


if __name__ == '__main__':
    main()
