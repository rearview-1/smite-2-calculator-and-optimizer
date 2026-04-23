#!/usr/bin/env python3
"""Augment items-catalog.json with gold-cost data from probed Recipe_Item files.

Layout of Recipe_Item_X.structure.json:

T1 / base components (14-byte payload):
  int16 @ 0: -1 marker (FFFF)
  int16 @ 2: gold cost
  rest: zeros + magic sentinel

T2/T3 (24 or 28-byte payload):
  int32 @ 0: import index to the item this recipe creates
  int32 @ 4: gold cost for this recipe step
  int32 @ 8: component count (1 or 2)
  int32 @ 12, 16: component import indices
  int32 @ 20: zero padding (present when 2 components)
  int32 end: 0xC1832A9E magic sentinel

Import indices are negative; their absolute form maps into the imports[] array.
"""
import json
import re
import struct
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

REPO = Path(__file__).resolve().parents[1]
OUT_DIR = REPO / "tools" / "SmiteAssetProbe" / "out"
CATALOG_PATH = REPO / "data" / "items-catalog.json"

# ---- load catalog ----
with open(CATALOG_PATH, encoding='utf-8') as f:
    catalog = json.load(f)

# Build a lookup from EquipmentItem path-stem -> catalog key
# e.g. 'Items_November2023/Caestus/EquipmentItem_Item_Caestus' -> 'item.Caestus'
path_to_key = {}
for k, v in catalog.items():
    src = v.get('sourceFile') or ''
    # source is like 'Hemingway_Content_Items_November2023_Caestus_EquipmentItem_Item_Caestus.structure.json'
    m = re.match(r'Hemingway_Content_(.+?)_EquipmentItem_(.+)\.structure\.json$', src)
    if not m:
        continue
    folder_path = m.group(1).replace('_', '/')
    equip_name = 'EquipmentItem_' + m.group(2)
    # Import paths look like /Game/Items_November2023/Caestus/EquipmentItem_Item_Caestus.EquipmentItem_Item_Caestus
    path_to_key[f'{folder_path}/{equip_name}'] = k

# Also build a looser (EquipmentItem filename -> catalog key) for fallback
equip_name_to_key = {}
for k, v in catalog.items():
    src = v.get('sourceFile') or ''
    m = re.match(r'Hemingway_Content_.+_(EquipmentItem_.+?)\.structure\.json$', src)
    if m:
        equip_name_to_key.setdefault(m.group(1), []).append(k)

def resolve_import_path(import_path):
    """Map an import path from the structure's imports[] to a catalog key."""
    if not import_path:
        return None
    # Strip /Game/ prefix and the .ObjectName suffix
    p = import_path.lstrip('/')
    if p.startswith('Game/'):
        p = p[len('Game/'):]
    p = p.split('.', 1)[0]  # trim the trailing .ObjectName
    # Direct match on folder/equipmentname
    if p in path_to_key:
        return path_to_key[p]
    # Fallback: match by EquipmentItem name
    equip = p.split('/')[-1]
    keys = equip_name_to_key.get(equip, [])
    if len(keys) == 1:
        return keys[0]
    return None


def read_recipe(recipe_path):
    """Return dict: {cost, components:[catalog_keys], raw, error}."""
    try:
        with open(recipe_path, encoding='utf-8') as f:
            d = json.load(f)
    except FileNotFoundError:
        return None
    recipe_export = None
    for e in d.get('exports') or []:
        if 'Recipe' in e.get('objectName', ''):
            recipe_export = e; break
    if recipe_export is None:
        return {'cost': 0, 'components': [], 'error': 'no recipe export'}
    scan = recipe_export.get('serialScan', {})
    hx = scan.get('firstBytesHex') or ''
    b = bytes.fromhex(hx)
    size = recipe_export.get('cookedSerialSize', len(b))
    imports = d.get('imports', []) or []

    if size <= 14:
        # T1 / base component layout. cost at int16 offset 2.
        if len(b) >= 4:
            cost = struct.unpack('<h', b[2:4])[0]
            if cost < 0 or cost > 20000:
                cost = 0
        else:
            cost = 0
        return {'cost': cost, 'components': [], 'layout': 'base'}

    if len(b) < 12:
        return {'cost': 0, 'components': [], 'error': f'short recipe, size={len(b)}'}
    cost = struct.unpack('<i', b[4:8])[0]
    if cost < 0 or cost > 20000:
        cost = 0
    comp_count = struct.unpack('<i', b[8:12])[0]
    comp_refs = []
    for i in range(comp_count):
        off = 12 + i * 4
        if off + 4 > len(b): break
        idx = struct.unpack('<i', b[off:off+4])[0]
        comp_refs.append(idx)
    # Resolve negative import indices to paths. FPackageIndex convention:
    # negative N -> imports[-N - 1]
    components = []
    unresolved = []
    for idx in comp_refs:
        if idx >= 0:
            unresolved.append(idx); continue
        imp_i = -idx - 1
        if 0 <= imp_i < len(imports):
            key = resolve_import_path(imports[imp_i].get('path'))
            if key:
                components.append(key)
            else:
                unresolved.append(imports[imp_i].get('path'))
        else:
            unresolved.append(idx)

    return {'cost': cost, 'components': components, 'unresolved': unresolved, 'layout': 'full'}


# Build: recipe path for each catalog item
recipe_lookup = {}
for recipe_file in sorted(OUT_DIR.glob('Hemingway_Content_*Recipe_Item_*.structure.json')):
    recipe_lookup[recipe_file.name] = recipe_file

# Attach recipe data to each item
for k, v in catalog.items():
    src = v.get('sourceFile') or ''
    # Recipe lives in the same folder as EquipmentItem. Build its expected structure.json name.
    # e.g. source 'Hemingway_Content_Items_November2023_Caestus_EquipmentItem_Item_Caestus.structure.json'
    #      recipe 'Hemingway_Content_Items_November2023_Caestus_Recipe_Item_Caestus.structure.json'
    m = re.match(r'Hemingway_Content_(.+?)_EquipmentItem(?:_Items?|_Starter)?_(Item_)?(.+)\.structure\.json$', src)
    recipe_path = None
    if m:
        folder, _, tail = m.groups()
        # The recipe filename is typically Recipe_Item_<Tail>.structure.json
        candidate = f'Hemingway_Content_{folder}_Recipe_Item_{tail}.structure.json'
        if candidate in recipe_lookup:
            recipe_path = recipe_lookup[candidate]
        else:
            # search by tail matching
            for name in recipe_lookup:
                if name.endswith(f'_Recipe_Item_{tail}.structure.json'):
                    recipe_path = recipe_lookup[name]; break
    if not recipe_path:
        v['recipeStepCost'] = None
        v['recipeComponents'] = None
        continue
    rec = read_recipe(recipe_path)
    if rec is None:
        v['recipeStepCost'] = None; v['recipeComponents'] = None; continue
    v['recipeStepCost'] = rec.get('cost')
    v['recipeComponents'] = rec.get('components')
    if rec.get('error'):
        v['recipeError'] = rec['error']
    if rec.get('unresolved'):
        v['recipeUnresolved'] = rec['unresolved']

# Compute totalCost by walking the component tree with memoization
def total_cost(key, stack=None):
    stack = stack or set()
    if key in stack:
        return 0  # cycle guard
    item = catalog.get(key)
    if not item:
        return 0
    if 'totalCost' in item and item['totalCost'] is not None:
        return item['totalCost']
    step = item.get('recipeStepCost') or 0
    comps = item.get('recipeComponents') or []
    sub = sum(total_cost(c, stack | {key}) for c in comps)
    item['totalCost'] = step + sub
    return item['totalCost']

for k in list(catalog.keys()):
    total_cost(k)

# Save
with open(CATALOG_PATH, 'w', encoding='utf-8') as f:
    json.dump(catalog, f, indent=2, ensure_ascii=False)

# Report
missing_step = sum(1 for v in catalog.values() if v.get('recipeStepCost') is None)
zero_total = sum(1 for v in catalog.values() if (v.get('totalCost') or 0) == 0)
print(f'Catalog updated: {CATALOG_PATH}')
print(f'Items with no recipe file found: {missing_step}')
print(f'Items with totalCost == 0: {zero_total}')

# Spot-check
spot = ['item.Blood-Forged Blade', 'item.PendulumBlade', 'item.Transcendance', 'item.HydrasLament', 'item.Obsidian Macuahuitl', 'item.Axe', 'item.Medallion']
for name in spot:
    for k, v in catalog.items():
        if k.lower() == name.lower():
            print(f'  {v.get("displayName")}: step={v.get("recipeStepCost")}, comps={v.get("recipeComponents")}, total={v.get("totalCost")}')
            break
