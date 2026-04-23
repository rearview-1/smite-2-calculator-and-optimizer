#!/usr/bin/env python3
"""Build a catalog of every SMITE 2 shop item from probed game files.

Output: data/items-catalog.json

For each item we extract:
- internalKey (the 'item.XYZ' ID in the names string table)
- displayName (the in-game name from ItemNames)
- tier ('T1', 'T2', 'T3', 'Starter', 'Relic', 'Consumable', 'Active', 'Aspect', or None)
- category (Offensive / Defensive / Utility / Starter, from ItemStore.Category tags)
- role tags (STR/INT/Carry/Mid/Jungle/Solo/Support, from ItemStore.Filter.Role.*)
- statTags (the Character.Stat.* tags referenced)
- storeFloats (the plausibleFloats from the HWEquipmentItem_ItemTooltipData export — these
  are the three/four numbers the item store actually shows)
- passive (the authored tooltip text from ItemDescriptions, stripped of UE keyword markup)
- passiveRaw (the original tooltip with markup preserved)

This is best-effort: storeFloats order isn't guaranteed to match statTags order, but
the combination of (tags + floats + passive text) is a reliable enough surface that
downstream code can produce a correct stat block when cross-checked against the
tooltip.
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
CATALOG_PATH = DATA_DIR / "items-catalog.json"

NAMES_TABLE = OUT_DIR / "Hemingway_Content_UI_StringTables_Items_ST_HW_Items_ItemNames.exports.json"
DESC_TABLE = OUT_DIR / "Hemingway_Content_UI_StringTables_Items_ST_HW_Items_ItemDescriptions.exports.json"
DESC_SHORT_TABLE = OUT_DIR / "Hemingway_Content_UI_StringTables_Items_ST_HW_Items_ItemDescriptions_Short.exports.json"


def load_string_table(path):
    """String tables in CUE4Parse land as nested exports with key/value entries."""
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    out = {}

    def walk(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if isinstance(v, str) and k.lower().startswith(('item.', 'item:')):
                    out[k] = v
                else:
                    walk(v)
        elif isinstance(node, list):
            for x in node:
                walk(x)

    walk(data)
    return out


def strip_keyword_markup(text):
    """Remove UE <keyword tag=...>...</> markup from tooltip text."""
    if text is None:
        return None
    # <keyword tag="Keyword.X">content</>
    cleaned = re.sub(r'<keyword[^>]*>', '', text)
    cleaned = cleaned.replace('</>', '')
    # Normalize \r\n to \n
    cleaned = cleaned.replace('\r\n', '\n').replace('\r', '\n')
    return cleaned


def load_description_tables():
    """Return (long, short) dicts of internal_key -> tooltip_text."""
    def read(path):
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        out = {}

        def walk(node):
            if isinstance(node, dict):
                for k, v in node.items():
                    if isinstance(v, str):
                        # Heuristic: description-table keys are item names or item.* keys
                        if k.lower().startswith(('item.', 'item:')) or (
                            not any(ch in k for ch in ':/\\')
                            and len(v) > 10
                            and len(k) > 2
                        ):
                            out[k] = v
                    else:
                        walk(v)
            elif isinstance(node, list):
                for x in node:
                    walk(x)

        walk(data)
        return out

    return read(DESC_TABLE), read(DESC_SHORT_TABLE)


def classify_tier(names):
    """Determine tier from ItemStore.ItemTier.* and Equipment.Type.* tags."""
    for n in names:
        if n == 'ItemStore.ItemTier.Tier3':
            return 'T3'
        if n == 'ItemStore.ItemTier.Tier2':
            return 'T2'
        if n == 'ItemStore.ItemTier.Tier1':
            return 'T1'
    for n in names:
        if 'ItemStore.Category.Starter' in n or 'ItemStore.Category.StartingLoadout' in n:
            return 'Starter'
        if 'Equipment.Type.Relic' in n:
            return 'Relic'
        if 'Aspect' in n and 'EquipmentItem' in n:
            return 'Aspect'
    return None


def extract_categories(names):
    cats = []
    roles = []
    keywords = []
    for n in names:
        if n.startswith('ItemStore.Category.'):
            cat = n.split('.', 2)[-1]
            if cat not in ('Starter', 'StartingLoadout') and not cat.startswith('Tier'):
                cats.append(cat)
        elif n.startswith('ItemStore.Filter.Role.'):
            role = n.split('.', 3)[-1]
            roles.append(role)
        elif n.startswith('Keyword.'):
            kw = n.split('.', 1)[-1]
            if kw not in ('Bold',):
                keywords.append(kw)
    return cats, roles, keywords


def extract_stat_tags(names):
    return [n for n in names if n.startswith('Character.Stat.')]


def process_equipment_item(path):
    with open(path, encoding='utf-8') as f:
        data = json.load(f)

    names = data.get('names', []) or []
    exports = data.get('exports', []) or []

    tier = classify_tier(names)
    categories, roles, keywords = extract_categories(names)
    stat_tags = extract_stat_tags(names)

    def extract_tooltip_stat_floats(export):
        """Return only contiguous stat-row floats from a tooltip-data export."""
        scan = export.get('serialScan', {})
        raw = []
        for f in scan.get('plausibleFloats', []) or []:
            v = f.get('value')
            off = f.get('offset')
            if v is None or off is None:
                continue
            if abs(v + 8.0) < 0.01:
                continue  # UE sentinel
            if abs(v + 2.0) < 0.01:
                continue  # overlap artifact before small regen/cooldown rows
            if abs(v - 128.0) < 0.01:
                continue  # UI padding marker
            if abs(v + 1.0) < 0.01:
                continue  # sentinel
            if v < 0 or v >= 1000:
                continue
            raw.append((off, v))

        by_offset = {}
        for off, v in raw:
            by_offset.setdefault(off, v)

        # HWEquipmentItem_ItemTooltipData stat rows are stored at 15, 32, 49...
        # Passive cooldowns and other non-stat tooltip values appear after a gap.
        out = []
        row_offset = 15
        while row_offset in by_offset:
            out.append(by_offset[row_offset])
            row_offset += 17
        if out:
            return out

        return []

    # Find the tooltip-data export; its stat-row floats are the store-displayed stats
    store_floats = []
    for e in exports:
        name = e.get('objectName', '')
        if 'ItemTooltipData' in name or 'TooltipData' in name:
            store_floats.extend(extract_tooltip_stat_floats(e))

    # Internal item key: the 'item.XYZ' string stored in the main export's asciiStrings
    internal_candidates = set()
    for e in exports:
        name = e.get('objectName', '')
        if 'EquipmentItem_Item' in name:
            scan = e.get('serialScan', {})
            for s in scan.get('asciiStrings', []) or []:
                v = s.get('value', '')
                if v.lower().startswith(('item.', 'item:')):
                    internal_candidates.add(v)

    return {
        'tier': tier,
        'categories': categories,
        'roles': roles,
        'keywords': keywords,
        'statTags': [n.removeprefix('Character.Stat.') for n in stat_tags],
        'storeFloats': store_floats,
        'internalCandidates': sorted(internal_candidates),
    }


def _normalize_key(k):
    """Collapse case and whitespace/underscores so 'item.Wyrmskin Hide' matches 'item.WyrmskinHide'."""
    if not k:
        return k
    return k.lower().replace(' ', '').replace('_', '').replace('-', '').replace("'", '')


def main():
    names_map = load_string_table(NAMES_TABLE)
    desc_long, desc_short = load_description_tables()

    # Build both a direct and normalized lookup so we tolerate spelling variation
    # between internal keys (e.g. 'item.Wyrmskin Hide' in asciiStrings vs
    # 'item.WyrmskinHide' in the names table).
    internal_to_display_norm = {_normalize_key(k): v for k, v in names_map.items()}
    internal_to_display = {k.lower(): v for k, v in names_map.items()}

    # Walk all probed EquipmentItem structure files
    catalog = {}
    unmatched = []
    item_files = sorted(OUT_DIR.glob("Hemingway_Content_*Items*_*EquipmentItem*structure.json"))
    for path in item_files:
        item_info = process_equipment_item(path)
        # The internal key is in asciiStrings from the main export
        internals = item_info['internalCandidates']
        if not internals:
            # Fall back to the folder name in the probe filename
            # e.g. Hemingway_Content_Items_November2023_Transcendence_EquipmentItem_Item_Transcendence.structure.json
            m = re.match(r".*EquipmentItem(?:_Items?)?_(?:Item_)?(.+)\.structure\.json$", path.name)
            internal_key = m.group(1) if m else None
        else:
            internal_key = internals[0]
        # Display name: try direct, then normalized, then folder-based guess
        display = None
        if internal_key:
            display = (
                internal_to_display.get(internal_key.lower())
                or internal_to_display_norm.get(_normalize_key(internal_key))
            )
        if not display:
            # Folder name from the source path — works for items without an 'item.X' string
            m = re.match(r".*Items_(?:November2023|Starters)_([^_]+)_Equipment.*", path.name)
            if m:
                display = internal_to_display_norm.get(_normalize_key('item.' + m.group(1)))

        # Try to find tooltip for this item. Description table keys are sometimes
        # the full 'item.X' path and sometimes just the display name. Normalized
        # matching handles typos and spacing inconsistencies.
        passive_raw = None
        desc_long_norm = {_normalize_key(k): v for k, v in desc_long.items()}
        desc_short_norm = {_normalize_key(k): v for k, v in desc_short.items()}
        for candidate in filter(None, [internal_key, display]):
            passive_raw = (
                desc_long.get(candidate)
                or desc_short.get(candidate)
                or desc_long_norm.get(_normalize_key(candidate))
                or desc_short_norm.get(_normalize_key(candidate))
            )
            if passive_raw:
                break

        record = {
            'internalKey': internal_key,
            'displayName': display,
            'tier': item_info['tier'],
            'categories': item_info['categories'],
            'roles': item_info['roles'],
            'keywords': item_info['keywords'],
            'statTags': item_info['statTags'],
            'storeFloats': item_info['storeFloats'],
            'passive': strip_keyword_markup(passive_raw) if passive_raw else None,
            'passiveRaw': passive_raw,
            'sourceFile': path.name,
        }

        key = internal_key or path.stem
        if not display or not item_info['tier']:
            unmatched.append({'file': path.name, 'internal': internal_key, 'display': display, 'tier': item_info['tier']})
        catalog[key] = record

    # Sort by display name where possible, else by key
    sorted_catalog = dict(sorted(catalog.items(), key=lambda kv: (kv[1].get('displayName') or kv[0]).lower()))

    DATA_DIR.mkdir(exist_ok=True)
    with open(CATALOG_PATH, 'w', encoding='utf-8') as f:
        json.dump(sorted_catalog, f, indent=2, ensure_ascii=False)

    # Reporting
    from collections import Counter
    tier_counts = Counter(r.get('tier') for r in catalog.values())
    cat_counts = Counter()
    for r in catalog.values():
        for c in r.get('categories') or []:
            cat_counts[c] += 1

    print(f"Catalog written: {CATALOG_PATH}")
    print(f"Total items: {len(catalog)}")
    print(f"Tier distribution: {dict(tier_counts)}")
    print(f"Category distribution: {dict(cat_counts)}")
    print(f"Items without tier OR without display name: {len(unmatched)}")
    if unmatched:
        print("First 15 unmatched:")
        for u in unmatched[:15]:
            print(f"  {u['file']}  internal={u['internal']}  display={u['display']}  tier={u['tier']}")


if __name__ == '__main__':
    main()
