#!/usr/bin/env python3
"""Build data/effects-catalog.json — every buff, debuff, and god passive in SMITE 2.

Sources:
- ST_HW_Buff_Names / ST_HW_Buff_Descriptions  -> map/jungle/objective buffs and some debuffs
- ST_HW_<God>_AbilityNames / ST_HW_<God>_AbilityDescriptions (75 gods)  -> god passives
  (also captures talents for gods that have alt-passive talents)

Output structure:
{
  "buffs": {
    "<internalKey>": {"name": ..., "description": ..., "source": ...}
  },
  "godPassives": {
    "<God>": {
      "name": ..., "description": ..., "descriptionShort": ...,
      "talents": {"Talent.1": {...}, ...},
      "sources": [...]
    }
  }
}
"""
import json
import os
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

REPO = Path(__file__).resolve().parents[1]
OUT_DIR = REPO / "tools" / "SmiteAssetProbe" / "out"
DATA_DIR = REPO / "data"
CATALOG_PATH = DATA_DIR / "effects-catalog.json"


META_KEYS = {'Type', 'Name', 'Flags', 'Class', 'Package', 'TableNamespace', 'METADATA_ID_COMMENT'}


def load_strings(export_path):
    """Walk a string-table export and return {key: value} for real entries (skip UE metadata)."""
    with open(export_path, encoding='utf-8') as f:
        d = json.load(f)
    out = {}

    def walk(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if isinstance(v, str):
                    if k in META_KEYS:
                        continue
                    # Skip UE header fields
                    if k.startswith(('/', '0x')):
                        continue
                    if len(k) < 2 or len(k) > 200:
                        continue
                    # Filter UE literal-None sentinel
                    if v.strip() in ('None', 'none'):
                        continue
                    # Real entries have either a dot, uppercase, or underscore structure
                    if not ('.' in k or any(c.isupper() for c in k) or '_' in k):
                        continue
                    out[k] = v
                else:
                    walk(v)
        elif isinstance(node, list):
            for x in node:
                walk(x)

    walk(d)
    return out


def strip_markup(text):
    if text is None:
        return None
    # Filter Unreal's literal "None" sentinel that leaks through the string table
    if text.strip() in ('None', 'none'):
        return None
    cleaned = re.sub(r'<keyword[^>]*>', '', text)
    cleaned = cleaned.replace('</>', '').replace('\r\n', '\n').replace('\r', '\n')
    return cleaned


def build_buffs():
    buffs_out = {}
    names_path = OUT_DIR / 'Hemingway_Content_UI_StringTables_Buff_ST_HW_Buff_Names.exports.json'
    descs_path = OUT_DIR / 'Hemingway_Content_UI_StringTables_Buff_ST_HW_Buff_Descriptions.exports.json'
    names = load_strings(names_path)
    descs = load_strings(descs_path)
    all_keys = set(names) | set(descs)
    for k in sorted(all_keys):
        buffs_out[k] = {
            'name': names.get(k),
            'description': strip_markup(descs.get(k)),
            'descriptionRaw': descs.get(k),
            'source': {
                'namesTable': 'ST_HW_Buff_Names' if k in names else None,
                'descTable': 'ST_HW_Buff_Descriptions' if k in descs else None,
            },
        }
    return buffs_out


def load_shared_god_tables():
    """Load the four shared ST_HW_God_* tables and index entries by god name."""
    base = OUT_DIR / 'Hemingway_Content_UI_StringTables_God_'
    tables = {}
    for key, fname in [
        ('names', 'ST_HW_God_AbilityNames'),
        ('desc', 'ST_HW_God_AbilityDescriptions'),
        ('short', 'ST_HW_God_AbilityShortDescriptions'),
        ('compact', 'ST_HW_God_AbilityCompactDescriptions'),
    ]:
        p = Path(str(base) + fname + '.exports.json')
        tables[key] = load_strings(p) if p.exists() else {}
    # Index by god
    shared = {}
    for kind, strings in tables.items():
        for full_key, val in strings.items():
            god = full_key.split('.')[0]
            shared.setdefault(god, {}).setdefault(kind, {})[full_key] = val
    return shared


def load_real_god_list():
    """Read all-passives.txt to determine which god names are real.
    Returns a case-insensitive set."""
    result = set()
    try:
        with open(r'C:\tmp\all-passives.txt') as f:
            for ln in f:
                parts = ln.strip().split('/')
                if 'GODS' in parts:
                    idx = parts.index('GODS')
                    if idx + 1 < len(parts):
                        result.add(parts[idx + 1])
    except FileNotFoundError:
        pass
    return result


def build_god_passives():
    out = {}
    # Per-god tables (Discordia, Kali, etc.) take priority
    names_files = sorted(OUT_DIR.glob('Hemingway_Content_UI_StringTables_Abilities_ST_HW_*_AbilityNames.exports.json'))
    seen_gods = set()
    shared = load_shared_god_tables()
    real_gods = load_real_god_list()
    # Normalize for case-insensitive comparison
    real_gods_lower = {g.lower().replace('_', '') for g in real_gods}

    def process(god, names, descs, source_names=None, source_desc=None):
        if god in seen_gods:
            return
        seen_gods.add(god)

        # Passive keys: ending in .PSV, .Passive
        name_keys = list(names.keys())
        passive_name_key = next(
            (k for k in name_keys if k.endswith('.PSV') or k.endswith('.Passive')),
            None,
        )
        passive_name = names.get(passive_name_key) if passive_name_key else None

        # Gather descriptions tagged to passive: .PSV.*, .Passive.*
        passive_descs = {}
        for k, v in descs.items():
            kl = k.lower()
            if '.psv' in kl or '.passive' in kl:
                passive_descs[k] = v

        # Primary descriptions: prefer OutOfGame, then InGame.Short, then Compact
        def pick_primary(d_dict):
            for suffix in ['.OutOfGame', '.Description.OutOfGame', '.InGame.Short', '.Compact', '.InGame']:
                for k, v in d_dict.items():
                    if k.endswith(suffix):
                        return k, v
            if d_dict:
                return next(iter(d_dict.items()))
            return None, None

        primary_key, primary = pick_primary(passive_descs)

        # Look for talent variants that replace the passive
        talent_passive_descs = {}
        for k, v in descs.items():
            if '.Talent.' in k and ('.PSV' in k or '.Passive' in k):
                talent_passive_descs[k] = v

        # Also grab per-ability names/descriptions for completeness
        abilities = {}
        for slot in ['A01', 'A02', 'A03', 'A04']:
            slot_key = f'{god}.{slot}'
            # Some tables have exact key, some use different style
            name = names.get(slot_key)
            # Find matching descriptions (Primary / OutOfGame / InGame.Short / Description.OutOfGame)
            desc_matches = {k: v for k, v in descs.items() if k.startswith(slot_key + '.') and ('Description' in k or 'OutOfGame' in k or 'InGame' in k or 'Compact' in k)}
            desc_k, desc = pick_primary(desc_matches)
            abilities[slot] = {
                'name': name,
                'description': strip_markup(desc),
                'descriptionKey': desc_k,
            }

        out[god] = {
            'god': god,
            'passiveName': passive_name,
            'passiveKey': passive_name_key,
            'passiveDescription': strip_markup(primary) if primary else None,
            'passiveDescriptionKey': primary_key,
            'passiveDescriptionsAll': {k: strip_markup(v) for k, v in passive_descs.items() if strip_markup(v)},
            'talentPassives': {k: strip_markup(v) for k, v in talent_passive_descs.items() if strip_markup(v)},
            'abilities': abilities,
            'sources': {
                'namesTable': source_names,
                'descTable': source_desc,
            },
        }

    # First pass: per-god dedicated tables
    for names_path in names_files:
        m = re.search(r'ST_HW_(.+?)_AbilityNames', names_path.name)
        if not m:
            continue
        god = m.group(1)
        if god == 'God':
            continue  # skip the shared "God" table (handled separately)
        desc_candidates = [
            OUT_DIR / f'Hemingway_Content_UI_StringTables_Abilities_ST_HW_{god}_AbilityDescriptions.exports.json',
            OUT_DIR / f'Hemingway_Content_UI_StringTables_Abilities_ST_HW_{god}_AbilittDescriptions.exports.json',  # Artemis typo
        ]
        desc_path = next((p for p in desc_candidates if p.exists()), None)
        names = load_strings(names_path)
        descs = load_strings(desc_path) if desc_path else {}
        # If there are no per-god descriptions, fall back to shared tables for this god
        shared_desc_source = None
        if not descs and god in shared:
            tables = shared[god]
            for kind in ['desc', 'short', 'compact']:
                descs.update(tables.get(kind, {}))
            if descs:
                shared_desc_source = 'ST_HW_God_AbilityDescriptions (shared)'
        process(god, names, descs,
                source_names=f'ST_HW_{god}_AbilityNames',
                source_desc=(desc_path.stem.replace('.exports', '') if desc_path else shared_desc_source))

    # Second pass: shared ST_HW_God_* tables (for gods without their own tables)
    for god, tables in shared.items():
        if god in seen_gods:
            continue
        # Filter out non-god prefixes (helper keys, stats)
        if god.lower().replace('_', '') not in real_gods_lower:
            continue
        names = tables.get('names', {})
        descs = {}
        descs.update(tables.get('desc', {}))
        descs.update(tables.get('short', {}))
        descs.update(tables.get('compact', {}))
        process(god, names, descs,
                source_names='ST_HW_God_AbilityNames (shared)',
                source_desc='ST_HW_God_AbilityDescriptions (shared)')

    return out


def main():
    buffs = build_buffs()
    gods = build_god_passives()

    DATA_DIR.mkdir(exist_ok=True)
    catalog = {
        'buffs': buffs,
        'godPassives': gods,
    }
    with open(CATALOG_PATH, 'w', encoding='utf-8') as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)

    print(f'Effects catalog written: {CATALOG_PATH}')
    print(f'Buffs in table: {len(buffs)}')
    print(f'Gods with passive data: {len(gods)}')
    with_passive = sum(1 for v in gods.values() if v.get('passiveName'))
    with_desc = sum(1 for v in gods.values() if v.get('passiveDescription'))
    print(f'  with passive NAME: {with_passive}')
    print(f'  with passive DESCRIPTION: {with_desc}')

    # Report which gods are in the GODS folder but NOT in the catalog (no string table on disk)
    gods_folder = sorted({
        p.name.split('_Common_Abilities_Passive_')[0].split('Hemingway_Content_Characters_GODS_')[-1]
        for p in OUT_DIR.glob('Hemingway_Content_Characters_GODS_*_Common_Abilities_Passive_*')
    })
    known = set(gods.keys())
    # Also derive from all-passives.txt on disk if we have it
    print()
    print('Gods that have passive GE files but no AbilityNames string table (tooltip-less):')
    try:
        with open(r'C:\tmp\all-passives.txt') as f:
            all_gods_in_passive_folders = set()
            for ln in f:
                parts = ln.strip().split('/')
                if 'GODS' in parts:
                    idx = parts.index('GODS')
                    if idx + 1 < len(parts):
                        all_gods_in_passive_folders.add(parts[idx + 1])
            missing = sorted(all_gods_in_passive_folders - known)
            print(f'  count: {len(missing)}')
            print(f'  {missing}')
    except FileNotFoundError:
        pass

    print()
    # Spot-check a few
    for god in ['Discordia', 'Kali', 'Kukulkan', 'Loki', 'Thor', 'Pele', 'Bellona']:
        if god in gods:
            g = gods[god]
            name = g.get('passiveName')
            desc = g.get('passiveDescription')
            desc_preview = (desc[:120] + '...') if desc and len(desc) > 120 else desc
            print(f'  {god}: passive="{name}" desc="{desc_preview}"')
        else:
            print(f'  {god}: (no string table — tooltip-less)')

    print()
    print('Buff categories by prefix:')
    from collections import Counter
    prefixes = Counter()
    for k in buffs:
        prefixes[k.split('.')[0]] += 1
    for p, n in prefixes.most_common():
        print(f'  {p}: {n}')


if __name__ == '__main__':
    main()
