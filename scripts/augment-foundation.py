#!/usr/bin/env python3
"""Augment gods-catalog.json and items-catalog.json with proc-GE data.

For each god + ability slot, collect every GE file under
/Abilities/<Slot>/GameplayEffects/ and produce a compact 'effects' array:
  {
    geName, tags (Character.Stat., Effect.Type., Status.*, Gameplay*),
    interestingFloats (from plausibleFloats, de-noised),
    asciiRefs (strings like 'MaxHealth', 'PhysicalPower', 'Mana'),
    durationHints (float candidates at offset 0 of main export)
  }

Same treatment for items under Items*/<Folder>/GameplayEffects/ and items'
own GA_/GE_ files living at the folder root.

Also: attach talents (aspects) to gods-catalog.json:
  gods[god]['talents'] = {
    'Talent_1': { effects: [...], curves: {...} },
    ...
  }
"""
import json
import re
import sys
from pathlib import Path
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

REPO = Path(__file__).resolve().parents[1]
OUT_DIR = REPO / "tools" / "SmiteAssetProbe" / "out"
DATA_DIR = REPO / "data"
GODS_PATH = DATA_DIR / "gods-catalog.json"
ITEMS_PATH = DATA_DIR / "items-catalog.json"


def summarize_ge(structure_path: Path):
    """Return a compact summary of interesting content in a GE file."""
    try:
        with open(structure_path, encoding='utf-8') as f:
            d = json.load(f)
    except FileNotFoundError:
        return None
    names = d.get('names') or []
    tags = [n for n in names if (
        n.startswith('Character.Stat.')
        or n.startswith('Effect.Type.')
        or n.startswith('Effect.Config.')
        or n.startswith('Effect.Property.')
        or n.startswith('Status.')
        or n.startswith('GameplayCue.')
        or n.startswith('Gods.')
        or n.startswith('Items.')
        or n.startswith('Keyword.')
        or n.startswith('Equipment.Type.')
        or n.startswith('Ability.Type.')
    )]
    # Collect interesting floats + ascii strings across all exports
    interesting_floats = []
    ascii_refs = set()
    for e in (d.get('exports') or []):
        ss = e.get('serialScan') or {}
        for f in (ss.get('plausibleFloats') or []):
            v = f.get('value')
            if v is None:
                continue
            # Filter padding/sentinels
            if abs(v + 8.0) < 0.01 or abs(v - 32.0) < 0.0001 or abs(v - 1.0) < 0.00001:
                continue
            if abs(v) > 20000 or (0 < abs(v) < 0.001):
                continue
            interesting_floats.append({'export': e.get('objectName'), 'offset': f.get('offset'), 'value': round(v, 6)})
        for s in (ss.get('asciiStrings') or []):
            val = s.get('value') or ''
            # Only keep short, symbol-like strings (stat attribute names, tag strings)
            if len(val) <= 32 and (val.isalnum() or any(c in '_. ' for c in val)) and val not in ('BPTYPE_Normal',):
                ascii_refs.add(val)
    return {
        'source': structure_path.name,
        'tags': tags,
        'asciiRefs': sorted(ascii_refs),
        'interestingFloats': interesting_floats,
    }


def gather_god_ge_files(god: str):
    """Return {'A01':[paths], 'A02':[...], 'Passive':[...]} of GE structure.json files for this god."""
    result = {'A01': [], 'A02': [], 'A03': [], 'A04': [], 'Passive': []}
    patterns = [
        (f'Hemingway_Content_Characters_GODS_{god}_Common_Abilities_Ability{{slot}}*_GameplayEffects_GE_*.structure.json', 'Ability{slot}'),
        (f'Hemingway_Content_Characters_GODS_{god}_Common_Ablities_Ability{{slot}}*_GameplayEffects_GE_*.structure.json', 'Ability{slot}'),  # Anhur
        (f'Hemingway_Content_Characters_GODS_{god}_Common_Abilities_A0{{slot}}*_GameplayEffects_GE_*.structure.json', 'A0{slot}'),  # Hercules
    ]
    for slot_num in (1, 2, 3, 4):
        slot_key = f'A0{slot_num}'
        for pat, _ in patterns:
            glob_pattern = pat.format(slot=slot_num)
            for p in OUT_DIR.glob(glob_pattern):
                result[slot_key].append(p)
    # Passive
    for p in OUT_DIR.glob(f'Hemingway_Content_Characters_GODS_{god}_Common_Abilities_Passive_GameplayEffect_*.structure.json'):
        result['Passive'].append(p)
    for p in OUT_DIR.glob(f'Hemingway_Content_Characters_GODS_{god}_Common_Abilities_Passive_GameplayEffects_*.structure.json'):
        result['Passive'].append(p)
    for p in OUT_DIR.glob(f'Hemingway_Content_Characters_GODS_{god}_Common_Ablities_Passive_GameplayEffect_*.structure.json'):
        result['Passive'].append(p)
    return result


def gather_god_talent_files(god: str):
    """Return {'Talent_1': {'ges': [paths], 'curves': [paths], 'equipmentItems': [paths]}, ...}."""
    result = {}
    for p in OUT_DIR.glob(f'Hemingway_Content_Characters_GODS_{god}_Common_Talents_*_*.structure.json'):
        # Extract the Talent_N portion
        rest = p.name[len(f'Hemingway_Content_Characters_GODS_{god}_Common_Talents_'):]
        talent_name = rest.split('_', 1)[0]
        if talent_name.startswith('Talent'):
            # Talent_1 -> "Talent" + the next segment. Simpler: the next segment after Talents_.
            m = re.match(r'(Talent[^_]*)_?(.*)', rest)
            if m:
                talent_name = m.group(1)
        result.setdefault(talent_name, {'files': []})
        result[talent_name]['files'].append(p)
    return result


def gather_item_ge_files(item_source_file: str):
    """Given a catalog source EquipmentItem file, find matching GE/GA files in same item folder."""
    # source_file looks like 'Hemingway_Content_Items_November2023_HydrasLament_EquipmentItem_Item_HydrasLament.structure.json'
    # Folder path is everything up to (and including) the item folder name.
    m = re.match(r'Hemingway_Content_(Items.*?)_EquipmentItem.*\.structure\.json$', item_source_file)
    if not m:
        return []
    folder_prefix = f'Hemingway_Content_{m.group(1)}_'
    out = []
    for p in OUT_DIR.glob(f'{folder_prefix}*.structure.json'):
        # Keep GE_, GA_, LC_ files; skip EquipmentItem + EquipmentInfo + Recipe (already tracked)
        stem = p.stem.replace('.structure', '')
        after = stem[len(folder_prefix):]
        if after.startswith(('GE_', 'GA_', 'LC_', 'GameplayEffects_GE_')):
            out.append(p)
    return out


def main():
    # Load existing catalogs
    with open(GODS_PATH, encoding='utf-8') as f:
        gods = json.load(f)
    with open(ITEMS_PATH, encoding='utf-8') as f:
        items = json.load(f)

    god_ge_totals = 0
    god_talent_totals = 0
    for god, data in gods.items():
        ge_map = gather_god_ge_files(god)
        data['abilityEffects'] = {}
        for slot, paths in ge_map.items():
            effs = []
            for p in paths:
                summary = summarize_ge(p)
                if summary:
                    effs.append(summary)
                    god_ge_totals += 1
            data['abilityEffects'][slot] = effs

        # Talents
        talents = gather_god_talent_files(god)
        data['talents'] = {}
        for talent_name, info in talents.items():
            effs = []
            for p in info['files']:
                summary = summarize_ge(p)
                if summary:
                    effs.append(summary)
                    god_talent_totals += 1
            data['talents'][talent_name] = {'effects': effs}

    # Items
    item_ge_totals = 0
    for key, item in items.items():
        src = item.get('sourceFile') or ''
        if not src:
            continue
        ge_paths = gather_item_ge_files(src)
        effs = []
        for p in ge_paths:
            summary = summarize_ge(p)
            if summary:
                effs.append(summary)
                item_ge_totals += 1
        item['geEffects'] = effs

    # Write back
    with open(GODS_PATH, 'w', encoding='utf-8') as f:
        json.dump(gods, f, indent=2, ensure_ascii=False)
    with open(ITEMS_PATH, 'w', encoding='utf-8') as f:
        json.dump(items, f, indent=2, ensure_ascii=False)

    print(f'Gods augmented: {len(gods)}')
    print(f'  total ability GE summaries attached: {god_ge_totals}')
    print(f'  total talent GE summaries attached: {god_talent_totals}')
    print(f'Items augmented: {len(items)}')
    print(f'  total item GE summaries attached: {item_ge_totals}')

    # Spot-check
    print()
    def show(title, effects, limit=6):
        print(f'=== {title} ===')
        for e in effects[:limit]:
            src = e.get('source')
            tags = e.get('tags', [])[:4]
            floats = [f['value'] for f in e.get('interestingFloats', [])[:8]]
            asciis = e.get('asciiRefs', [])[:6]
            print(f'  {src}')
            print(f'    tags[:4]: {tags}')
            print(f'    floats: {floats}')
            print(f'    asciiRefs: {asciis}')

    show('Kali A01 effects', gods.get('Kali', {}).get('abilityEffects', {}).get('A01', []))
    print()
    show('Kali Passive effects', gods.get('Kali', {}).get('abilityEffects', {}).get('Passive', []))
    print()
    ishtar_talents = gods.get('Ishtar', {}).get('talents', {})
    for talent_name, talent in ishtar_talents.items():
        show(f'Ishtar {talent_name}', talent.get('effects', []), limit=4)
        print()


if __name__ == '__main__':
    main()
