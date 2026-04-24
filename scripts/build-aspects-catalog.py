#!/usr/bin/env python3
"""Build data/aspects-catalog.json — every god's aspect (talent) with
its name, description, numeric rank-curves, and ability-level modifications.

Sources from the probe output:
  1. ST_HW_God_Talents                               — authoritative aspect name + full description per god
  2. Per-god ST_HW_<God>_AbilityDescriptions         — per-ability overrides under `.Talent.1.A0N.*` keys
  3. Common_Talents_Talent_N/CT_<God>_Talent{N}_EffectValues  — numeric rank curves for the aspect
  4. Common_Talents_Talent_N/GE_<God>_A0X_Talent*    — ability-level modifications (cooldown, damage, buffs)
  5. Common_Talents_Talent_N/GE_<God>_Talent{N}_*    — aspect-level modifications (self buff, debuff, root effect)

Output shape:
{
  "gods": {
    "<GodId>": {
      "godId": "...",               // gods-catalog key (Loki, The_Morrigan, Baron_Samedi)
      "aspectKeyPrefix": "Loki01",  // matches entries in ST_HW_God_Talents (Loki01Name / Loki01Desc)
      "aspect": {
        "name": "Aspect of Agony",
        "description": "...full tooltip...",
        "placeholder": false,                   // true when entry is "DNT" / "Placeholder Desc"
        "replacesPassive": false,               // true if `<God>.Talent.1.PSV.*` strings exist
        "abilityOverrides": {                   // from per-god AbilityDescriptions under `.Talent.1.A0N.*`
          "A01": "...revised tooltip..."
        },
        "numericValues": {                      // rows parsed from CT_<God>_Talent{N}_EffectValues
          "DamageMitigations": {"interp":"step","keys":[{"t":1,"v":15},{"t":5,"v":15}]},
          ...
        },
        "abilityMods": {                        // grouped by target ability slot
          "A01": [
            {"kind":"cooldownModification","rank":1,"file":"GE_Loki_A01_TalentCooldownModification_1"},
            ...
          ]
        },
        "rootEffectFiles": ["GE_Loki_Talent_1", "GE_Loki_Talent1_Buff", ...],
        "sources": {
          "talentFolder": "Common_Talents_Talent_1",
          "ctFile": "CT_Loki_Talent1_EffectValues",
          "talentsTable": "ST_HW_God_Talents"
        }
      }
    }
  },
  "unmapped": ["Aladdin", ...],   // catalog gods with no aspect data found
  "lastUpdated": "..."
}

Authoritative: every number comes from the probe output. If data is missing for a god,
the field is omitted rather than guessed.
"""
import json
import re
import sys
from datetime import date
from pathlib import Path
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

REPO = Path(__file__).resolve().parents[1]
OUT_DIR = REPO / "tools" / "SmiteAssetProbe" / "out"
DATA_DIR = REPO / "data"
GODS_CATALOG = DATA_DIR / "gods-catalog.json"
ASPECTS_CATALOG = DATA_DIR / "aspects-catalog.json"


# ── helpers ────────────────────────────────────────────────────────────────

def load_catalog_gods():
    with open(GODS_CATALOG, encoding='utf-8') as f:
        return list(json.load(f).keys())


def normalize(s):
    """Lowercase + strip underscores/spaces for fuzzy comparisons."""
    return re.sub(r'[_\s-]+', '', (s or '')).lower()


def walk_strings(node, out, metakeys={'Type','Name','Flags','Class','Package','TableNamespace','METADATA_ID_COMMENT'}):
    if isinstance(node, dict):
        for k, v in node.items():
            if isinstance(v, str) and k not in metakeys and not k.startswith(('/','0x')) and 2 <= len(k) <= 200 and v.strip() not in ('None','none'):
                out[k] = v
            else:
                walk_strings(v, out, metakeys)
    elif isinstance(node, list):
        for x in node:
            walk_strings(x, out, metakeys)


def strip_markup(text):
    if text is None:
        return None
    if text.strip() in ('None', 'none'):
        return None
    cleaned = re.sub(r'<keyword[^>]*>', '', text)
    cleaned = cleaned.replace('</>', '').replace('\r\n', '\n').replace('\r', '\n')
    return cleaned


def read_json_exports(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return None


def parse_curve_table(path):
    """Parse a CurveTable export into {rowName: {interp, keys:[{t,v}]}}."""
    d = read_json_exports(path)
    if not d:
        return {}
    table = None
    for entry in d:
        if isinstance(entry, dict) and entry.get('Type') == 'CurveTable':
            table = entry
            break
    if not table:
        return {}
    out = {}
    for row, cfg in (table.get('Rows') or {}).items():
        keys = cfg.get('Keys[1]') or []
        if not keys:
            continue
        interp = 'step' if cfg.get('InterpMode') == 1 else 'linear'
        out[row] = {
            'interp': interp,
            'keys': [{'t': k.get('Time'), 'v': k.get('Value')} for k in keys],
        }
    return out


# ── master talent strings table (ST_HW_God_Talents) ────────────────────────

def load_god_talents_table():
    """Parse ST_HW_God_Talents into {<prefix>: {'name': ..., 'desc': ...}}.
    Prefix is e.g. 'Loki01', 'ratatoskr01', 'Gilgamesh' (no 01).
    """
    p = OUT_DIR / 'Hemingway_Content_UI_StringTables_God_ST_HW_God_Talents.exports.json'
    d = read_json_exports(p)
    if not d:
        return {}
    strings = {}
    walk_strings(d, strings)
    table = defaultdict(dict)
    # Keys look like: <Prefix>Name / <Prefix>Desc
    for k, v in strings.items():
        for suffix, field in (('Name','name'), ('Desc','desc')):
            if k.endswith(suffix):
                prefix = k[:-len(suffix)]
                if not prefix:
                    continue
                table[prefix][field] = v
                break
    return dict(table)


def match_aspect_prefix(god_id, aspect_table):
    """Return the aspect-prefix from ST_HW_God_Talents that matches this god, or None."""
    target = normalize(god_id)
    # Direct candidates
    # Try <God>01, <God>01 with case tolerance, or <God> alone (Gilgamesh)
    for prefix in aspect_table:
        np = normalize(prefix)
        # Strip '01' suffix for comparison
        np_stripped = np[:-2] if np.endswith('01') else np
        if np_stripped == target:
            return prefix
    return None


# ── per-god ability-description overrides ──────────────────────────────────

# Map gods-catalog id ↔ per-god ST file spelling (most match exactly).
STRING_TABLE_SPELLINGS = {
    # catalog key → list of filename spellings to try in ST_HW_{spelling}_AbilityDescriptions
    'DaJi': ['Daji', 'DaJi'],
    'Baron_Samedi': ['BaronSamedi', 'Baron_Samedi'],
    'Nu_Wa': ['NuWa', 'Nu_Wa'],
    'The_Morrigan': ['TheMorrigan', 'The_Morrigan', 'Morrigan'],
    'Guan_Yu': ['GuanYu', 'Guan_Yu'],
    'Hun_Batz': ['HunBatz', 'Hunbatz', 'Hun_Batz'],
    'Sun_Wukong': ['SunWukong', 'Sun_Wukong'],
    'Ne_Zha': ['NeZha', 'Ne_Zha'],
    'Jormungandr': ['Jormungandr', 'Jorm'],
    'JingWei': ['JingWei', 'Jing_Wei'],
    'HouYi': ['HouYi', 'Hou_Yi'],
    'MorganLeFay': ['MorganLeFay', 'Morgan_Le_Fay'],
    'Ratatoskr': ['Ratatoskr', 'ratatoskr'],
}


def load_per_god_ability_strings(god_id):
    """Return {<key>: <value>} for per-god AbilityDescriptions (merged with shared
    God_AbilityDescriptions if no per-god table exists)."""
    spellings = STRING_TABLE_SPELLINGS.get(god_id, [god_id])
    strings = {}
    for spelling in spellings:
        p = OUT_DIR / f'Hemingway_Content_UI_StringTables_Abilities_ST_HW_{spelling}_AbilityDescriptions.exports.json'
        alt = OUT_DIR / f'Hemingway_Content_UI_StringTables_Abilities_ST_HW_{spelling}_AbilittDescriptions.exports.json'  # Artemis typo
        for candidate in (p, alt):
            if candidate.exists():
                d = read_json_exports(candidate)
                if d:
                    walk_strings(d, strings)
                break
    # Always also pull from shared God_AbilityDescriptions
    shared = OUT_DIR / 'Hemingway_Content_UI_StringTables_God_ST_HW_God_AbilityDescriptions.exports.json'
    if shared.exists():
        d = read_json_exports(shared)
        if d:
            walk_strings(d, strings)
    return strings


def extract_talent_abilityoverrides(god_id, strings):
    """Pull `.Talent.1.A0N.*` descriptions for this god. Prefers InGame.Short, then OutOfGame."""
    # Figure out the god's string-key prefix by looking at keys that reference
    # their ability slots (e.g., "Loki.A01.*", "TheMorrigan.A01.*"). Build a
    # candidate set from STRING_TABLE_SPELLINGS plus literal variants.
    candidates = set(STRING_TABLE_SPELLINGS.get(god_id, [god_id]))
    candidates.add(god_id)
    candidates.add(god_id.replace('_', ''))
    # Also try lowercase (ratatoskr case)
    candidates = {c for c in candidates}
    candidates |= {c.lower() for c in list(candidates)}

    overrides = {}
    for slot in ('A01', 'A02', 'A03', 'A04'):
        # Gather all matching strings, pick InGame.Short > OutOfGame > any
        candidates_for_slot = []
        for k, v in strings.items():
            if not k.startswith(tuple(f'{c}.Talent.' for c in candidates)):
                continue
            # key pattern: <prefix>.Talent.<N>.<slot>.<variant>
            parts = k.split('.')
            if len(parts) < 4:
                continue
            if slot not in parts:
                continue
            candidates_for_slot.append((k, v))
        if not candidates_for_slot:
            continue
        # Prefer InGame.Short
        preferred = next((v for k,v in candidates_for_slot if k.endswith('.InGame.Short')), None)
        if preferred is None:
            preferred = next((v for k,v in candidates_for_slot if k.endswith('.OutOfGame')), None)
        if preferred is None:
            preferred = candidates_for_slot[0][1]
        overrides[slot] = strip_markup(preferred)
    return overrides


def detect_replaces_passive(god_id, strings):
    """Does this god's talent replace its passive? Look for `.Talent.*PSV.*` or `.Talent.*Passive.*` keys."""
    candidates = set(STRING_TABLE_SPELLINGS.get(god_id, [god_id]))
    candidates.add(god_id)
    candidates.add(god_id.replace('_', ''))
    candidates |= {c.lower() for c in list(candidates)}
    for k in strings:
        for c in candidates:
            if k.startswith(f'{c}.Talent.') and ('.PSV' in k or '.Passive' in k):
                return True
    return False


# ── talent folder files (CT + GE) ──────────────────────────────────────────

TALENT_FOLDER_SPELLINGS = {
    # catalog key -> list of folder spellings used in Common_Talents file paths
    'DaJi': ['DaJi'],
    'Baron_Samedi': ['Baron_Samedi'],
    'Nu_Wa': ['Nu_Wa'],
    'The_Morrigan': ['The_Morrigan'],
    'Guan_Yu': ['Guan_Yu'],
    'Hun_Batz': ['Hun_Batz'],
    'Sun_Wukong': ['Sun_Wukong'],
    'Ne_Zha': ['Ne_Zha'],
    'Jormungandr': ['Jormungandr'],
    'HouYi': ['HouYi', 'Hou_Yi'],
}


def find_talent_folders(god_id):
    """Return list of talent indices, with '0' used as the sentinel for a FLAT
    layout (files directly under Common_Talents_ with no Talent_N subfolder —
    Awilix, Baron_Samedi use this)."""
    for spelling in TALENT_FOLDER_SPELLINGS.get(god_id, [god_id]):
        base = f'Hemingway_Content_Characters_GODS_{spelling}_Common_Talents'
        folders = set()
        for p in OUT_DIR.glob(f'{base}_Talent_[0-9]_*.exports.json'):
            m = re.search(r'Common_Talents_Talent_([0-9])_', p.name)
            if m:
                folders.add(m.group(1))
        if folders:
            return sorted(folders)
        # No Talent_N subfolder — but does Common_Talents_ have any loose files?
        if any(OUT_DIR.glob(f'{base}_*.exports.json')):
            return ['0']
    return []


def find_talent_ct(god_id, talent_idx):
    """Find the aspect's main CT curve table. Returns (path, parsed_rows) or (None, {})."""
    for spelling in TALENT_FOLDER_SPELLINGS.get(god_id, [god_id]):
        if talent_idx == '0':
            base = f'Hemingway_Content_Characters_GODS_{spelling}_Common_Talents'
            patterns = [
                f'{base}_CT_*_Talent*_EffectValues.exports.json',
                f'{base}_CT_*_Talent_EffectValues.exports.json',
            ]
        else:
            base = f'Hemingway_Content_Characters_GODS_{spelling}_Common_Talents_Talent_{talent_idx}'
            patterns = [f'{base}_CT_*_Talent{talent_idx}_EffectValues.exports.json']
        for pattern in patterns:
            for p in OUT_DIR.glob(pattern):
                rows = parse_curve_table(p)
                if rows:
                    return p.name, rows
    return None, {}


def find_base_ability_talent_rows(god_id):
    """Some gods (Daji, Nu_Wa, etc.) have NO dedicated talent CT — their aspect's
    numeric values live inside the regular ability CTs as rows prefixed with
    'Talent*'. Return {slot: {row: curve}} for those rows.

    Grabs them from every per-ability CT in Common_Abilities (standard layout).
    """
    spelling = TALENT_FOLDER_SPELLINGS.get(god_id, [god_id])[0]
    out_by_slot = {}
    for slot in ('1','2','3','4'):
        # Try primary + auxiliary CT paths (same patterns build-gods-catalog.py uses)
        patterns = [
            f'Hemingway_Content_Characters_GODS_{spelling}_Common_Abilities_Ability{slot}*_LevelConfigs_CT_*_A0{slot}*_EffectValues.exports.json',
            f'Hemingway_Content_Characters_GODS_{spelling}_Common_Ablities_Ability{slot}*_LevelConfigs_CT_*_A0{slot}*_EffectValues.exports.json',
            f'Hemingway_Content_Characters_GODS_{spelling}_Common_Abilities_A0{slot}*_LevelConfigs_CT_*_A0{slot}*_EffectValues.exports.json',
        ]
        merged = {}
        for pat in patterns:
            for p in OUT_DIR.glob(pat):
                if 'OldSmite' in p.name:
                    continue
                rows = parse_curve_table(p)
                for row, cfg in rows.items():
                    if row.startswith('Talent') or ' Talent' in row or row.startswith('talent'):
                        merged[row] = cfg
        if merged:
            out_by_slot[f'A0{slot}'] = merged
    return out_by_slot


def find_talent_ge_files(god_id, talent_idx):
    """Return list of GE files for this aspect. Each classified as (kind, slot?, file, rank?)."""
    for spelling in TALENT_FOLDER_SPELLINGS.get(god_id, [god_id]):
        base = (f'Hemingway_Content_Characters_GODS_{spelling}_Common_Talents'
                if talent_idx == '0'
                else f'Hemingway_Content_Characters_GODS_{spelling}_Common_Talents_Talent_{talent_idx}')
        out = []
        for p in OUT_DIR.glob(f'{base}_*GE_*.exports.json'):
            name = p.stem.replace('.exports', '')
            if '_GC_' in name:
                continue
            ge_name = name.rsplit('_GE_', 1)[-1]
            kind, slot, rank = classify_ge(ge_name)
            out.append({
                'file': ge_name,
                'kind': kind,
                'slot': slot,
                'rank': rank,
            })
        if out:
            return out
    return []


GE_ABILITY_MOD_PATTERNS = [
    # (regex, kind)
    (re.compile(r'_A0([1-4])_TalentCooldownModification_?(\d*)', re.I), 'cooldownModification'),
    (re.compile(r'_A0([1-4])_TalentDamage',                       re.I), 'addDamage'),
    (re.compile(r'_A0([1-4])_Talent_?Buff',                       re.I), 'addBuff'),
    (re.compile(r'_A0([1-4])_Talent_?Debuff',                     re.I), 'addDebuff'),
    (re.compile(r'_A0([1-4])_Talent_?Slow',                       re.I), 'addSlow'),
    (re.compile(r'_A0([1-4])_Talent_?Heal',                       re.I), 'addHeal'),
    (re.compile(r'_A0([1-4])_Talent_?ASBuff',                     re.I), 'addBuff'),
    (re.compile(r'_A0([1-4])_Talent_?Stun',                       re.I), 'addStun'),
    (re.compile(r'_A0([1-4])_Talent',                             re.I), 'abilityMod'),
]

GE_ASPECT_PATTERNS = [
    (re.compile(r'Talent_?Buff$',                                 re.I), 'selfBuff'),
    (re.compile(r'Talent_?Debuff$',                               re.I), 'debuff'),
    (re.compile(r'Talent[_0-9]*$',                                re.I), 'root'),
]


def classify_ge(ge_name):
    """Return (kind, slot?, rank?)."""
    # Ability-level first
    for rgx, kind in GE_ABILITY_MOD_PATTERNS:
        m = rgx.search(ge_name)
        if m:
            slot = f'A0{m.group(1)}'
            rank = None
            if len(m.groups()) >= 2 and m.group(2):
                try: rank = int(m.group(2))
                except ValueError: pass
            return kind, slot, rank
    # Aspect-level
    for rgx, kind in GE_ASPECT_PATTERNS:
        if rgx.search(ge_name):
            return kind, None, None
    return 'other', None, None


# ── main extraction ────────────────────────────────────────────────────────

def extract_god_aspect(god_id, aspect_table):
    """Return the aspect record for this god, or None if no aspect data found."""
    aspect_prefix = match_aspect_prefix(god_id, aspect_table)
    master_row = aspect_table.get(aspect_prefix, {}) if aspect_prefix else {}
    strings = load_per_god_ability_strings(god_id)
    ability_overrides = extract_talent_abilityoverrides(god_id, strings)
    replaces_passive = detect_replaces_passive(god_id, strings)
    talent_folders = find_talent_folders(god_id)
    base_ability_talent_rows = find_base_ability_talent_rows(god_id)

    if not aspect_prefix and not ability_overrides and not talent_folders and not base_ability_talent_rows:
        return None  # nothing found

    # Flag placeholders (DNT / "Placeholder Desc" / "God_01")
    name = strip_markup(master_row.get('name'))
    desc = strip_markup(master_row.get('desc'))
    placeholder = bool(desc) and (desc.strip().upper() in ('DNT', 'DO NOT TRANSLATE') or 'placeholder' in (desc or '').lower())
    if name and re.fullmatch(r'[A-Za-z_]+_?\d+', name.strip()):
        placeholder = True  # "Odin_01" style

    # Process each talent folder (usually just one; Bellona has two)
    talent_blocks = []
    for t_idx in talent_folders:
        ct_file, ct_rows = find_talent_ct(god_id, t_idx)
        ge_files = find_talent_ge_files(god_id, t_idx)
        # Group ability mods by slot
        ability_mods = defaultdict(list)
        root_effects = []
        for ge in ge_files:
            if ge['slot']:
                ability_mods[ge['slot']].append({
                    'kind': ge['kind'],
                    'rank': ge['rank'],
                    'file': ge['file'],
                })
            else:
                root_effects.append({'kind': ge['kind'], 'file': ge['file']})
        talent_blocks.append({
            'talentIndex': int(t_idx),
            'folder': f'Common_Talents_Talent_{t_idx}',
            'ctFile': ct_file,
            'numericValues': ct_rows,
            'abilityMods': {k: v for k, v in sorted(ability_mods.items())},
            'rootEffects': root_effects,
        })

    return {
        'godId': god_id,
        'aspectKeyPrefix': aspect_prefix,
        'aspect': {
            'name': name,
            'description': desc,
            'placeholder': placeholder,
            'replacesPassive': replaces_passive,
            'abilityOverrides': ability_overrides,
            'talents': talent_blocks,
            # Talent*-prefixed rows found in each ability's REGULAR CT (for gods
            # like Daji, Nu_Wa that don't have a dedicated talent CT).
            'baseAbilityTalentRows': base_ability_talent_rows,
            'sources': {
                'talentsTable': 'ST_HW_God_Talents' if master_row else None,
                'perGodStringTable': f'ST_HW_{STRING_TABLE_SPELLINGS.get(god_id, [god_id])[0]}_AbilityDescriptions',
            },
        },
    }


def main():
    gods = load_catalog_gods()
    print(f'Catalog gods: {len(gods)}')
    aspect_table = load_god_talents_table()
    print(f'ST_HW_God_Talents entries: {len(aspect_table)}')

    result = {'gods': {}, 'unmapped': [], 'lastUpdated': date.today().isoformat()}
    for god in gods:
        rec = extract_god_aspect(god, aspect_table)
        if rec is None:
            result['unmapped'].append(god)
        else:
            result['gods'][god] = rec

    ASPECTS_CATALOG.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf-8')

    # Report
    total = len(result['gods'])
    with_name = sum(1 for r in result['gods'].values() if r['aspect']['name'])
    with_desc = sum(1 for r in result['gods'].values() if r['aspect']['description'])
    with_overrides = sum(1 for r in result['gods'].values() if r['aspect']['abilityOverrides'])
    with_ct = sum(1 for r in result['gods'].values() if any(t.get('numericValues') for t in r['aspect']['talents']))
    with_ability_mods = sum(1 for r in result['gods'].values() if any(t.get('abilityMods') for t in r['aspect']['talents']))
    with_base_talent_rows = sum(1 for r in result['gods'].values() if r['aspect']['baseAbilityTalentRows'])
    placeholders = sum(1 for r in result['gods'].values() if r['aspect']['placeholder'])
    print(f'\nAspects catalogued: {total} / {len(gods)}')
    print(f'  with aspect name:       {with_name}')
    print(f'  with aspect desc:       {with_desc}')
    print(f'  placeholder/DNT:        {placeholders}')
    print(f'  with ability overrides: {with_overrides}')
    print(f'  with CT rank values:    {with_ct}')
    print(f'  with ability GE mods:   {with_ability_mods}')
    print(f'  with base-CT talent rows:  {with_base_talent_rows}')
    print(f'  unmapped gods ({len(result["unmapped"])}):', ', '.join(result['unmapped']))

    # Spot-check 4 gods
    print()
    for spot in ['Loki', 'The_Morrigan', 'DaJi', 'Bellona', 'Ratatoskr']:
        rec = result['gods'].get(spot)
        if not rec:
            print(f'{spot}: NO aspect record'); continue
        a = rec['aspect']
        print(f'{spot}: {a["name"]!r}  (placeholder={a["placeholder"]})')
        if a['description']:
            print(f'  desc: {(a["description"] or "")[:120]}...')
        print(f'  abilityOverrides slots: {list(a["abilityOverrides"].keys())}')
        for t in a['talents']:
            print(f'  Talent_{t["talentIndex"]}: numeric rows={len(t["numericValues"])}, abilityMods={ {k: len(v) for k, v in t["abilityMods"].items()} }, rootEffects={len(t["rootEffects"])}')


if __name__ == '__main__':
    main()
