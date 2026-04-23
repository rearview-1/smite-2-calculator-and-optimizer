#!/usr/bin/env python3
"""Mine "body-lock" notify Duration from every god's ability montage (Mon_Offhand_N).

Approach: the montage binary holds a FAnimNotifyEvent array referencing notify
state class instances. We cannot decode the properties without a usmap, but we
can find the ANS_ForceFullBody_C export reference in the main montage binary
and read the float at +12 (consistently the Duration of the state notify per
validation on Loki A03 1.700s matching user-measured 1.833s cast lockout).

Preconditions:
  - All Mon_Offhand_* montages probed (structure.json + .bin next to them).
    Run probe first if missing:
      dotnet tools/SmiteAssetProbe/bin/Release/net8.0/SmiteAssetProbe.dll \\
        --raw-dump --query=Mon_Offhand

Output: data/montage-durations.json — flat list of {god, slot, duration, source}
"""
import json
import re
import struct
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

REPO = Path(__file__).resolve().parents[1]
PROBE_OUT = REPO / "tools/SmiteAssetProbe/out"
OUT = REPO / "data/montage-durations.json"

MON_PATH_RE = re.compile(
    # Primary: slot from /AbilityN/ folder. Variants of montage filename covered:
    #   Mon_Offhand_*, MON_A0N, Montages_MON_Offhand_*, Mon_Genie_Offhand_*
    #   (Aladdin), Mon_{godname}_Offhand_*
    r'GODS_(?P<god>[A-Za-z_]+?)_Common_(?:Abilities|Ablities)_Ability(?P<slot>\d)[a-z]?_'
    r'(?:[A-Za-z0-9_]*_)?'
    r'(?:Mon_Offhand|MON_A0?\d|Montages_MON_Offhand|Mon_[A-Za-z]+_Offhand)',
    re.IGNORECASE
)

# Fallback: slot inferred from filename (Sylvanus, Artio C04 etc.)
# Matches Mon_Offhand_<prefix?><digit> where prefix is A/B/C/0 optional.
MON_FNAME_RE = re.compile(
    r'GODS_(?P<god>[A-Za-z_]+?)_Common_Animations.*_Mon_Offhand_[A-Za-z]?0?(?P<slot>\d)',
    re.IGNORECASE
)


def scan_montage(struct_json_path: Path, bin_path: Path):
    """Return list of (ans_export_idx, offset_in_main, duration_float_at+12) tuples."""
    with open(struct_json_path, encoding='utf-8') as f:
        s = json.load(f)
    bin_bytes = bin_path.read_bytes()

    exports = s.get('exports', [])
    if not exports:
        return []
    main = max(exports, key=lambda e: e.get('cookedSerialSize', 0))
    abs_start = s['summary']['TotalHeaderSize'] + main['cookedSerialOffset']
    abs_end = abs_start + main['cookedSerialSize']

    ans_exports = [e for e in exports
                   if re.search(r'ANS_ForceFullBody', e.get('objectName', ''), re.IGNORECASE)]
    if not ans_exports:
        return []

    results = []
    for ans in ans_exports:
        target_idx = ans['index']
        target_bytes = struct.pack('<I', target_idx)
        # Find all 4-byte matches inside the main export bytes, filter to those
        # where the NEXT 4 bytes have top bit set (matches the PackageObjectIndex
        # pair signature seen at body-lock notify entries).
        for i in range(abs_start, abs_end - 20):
            if bin_bytes[i:i+4] != target_bytes:
                continue
            # Extract candidate Duration float at +12 and neighbor at +16
            if i + 20 > abs_end:
                continue
            f12 = struct.unpack_from('<f', bin_bytes, i + 12)[0]
            f16 = struct.unpack_from('<f', bin_bytes, i + 16)[0]
            if not (0 < f12 < 10):
                continue
            # The "good" ANS reference pattern has +16 ≈ 1.0 (RateScale).
            # Prefer those but accept others as candidates.
            results.append({
                'ans_export_idx': target_idx,
                'ans_export_name': ans['objectName'],
                'offset_in_main': i - abs_start,
                'duration': round(f12, 3),
                'rate_scale': round(f16, 3),
                'rate_is_one': abs(f16 - 1.0) < 0.02,
            })
    return results


def main():
    # Find all montage structure+bin file pairs (case-insensitive). Montage files
    # are `.uasset.structure.json` with either "Mon_Offhand" or "MON_A0N" in the name.
    struct_files = [f for f in PROBE_OUT.glob('*.structure.json')
                    if re.search(r'mon_offhand|mon_a0?\d|mon_genie_offhand', f.name, re.IGNORECASE)]

    per_god_slot = {}  # (god, slot) -> best result
    processed = 0
    failed = 0

    for sf in struct_files:
        name = sf.name.replace('.structure.json', '')
        m = MON_PATH_RE.search(name) or MON_FNAME_RE.search(name)
        if not m:
            continue
        god = m.group('god')
        slot = f"A0{m.group('slot')}"

        bin_path = sf.parent / (name + '.bin')
        if not bin_path.exists():
            # Try different capitalization
            candidates = list(sf.parent.glob(name.replace('Mon_', '*on_') + '.bin'))
            if candidates:
                bin_path = candidates[0]
            else:
                failed += 1
                continue

        try:
            results = scan_montage(sf, bin_path)
        except Exception as e:
            print(f'  err {sf.name}: {e}')
            failed += 1
            continue

        processed += 1
        candidate = None
        if results:
            preferred = [r for r in results if r['rate_is_one']]
            pool = preferred if preferred else results
            best = max(pool, key=lambda r: r['duration'])
            candidate = {
                'god': god,
                'slot': slot,
                'duration': best['duration'],
                'rate_scale': best['rate_scale'],
                'source': f"ANS_ForceFullBody @+12 (offset {best['offset_in_main']}) from {sf.name}",
            }
        else:
            candidate = {
                'god': god,
                'slot': slot,
                'duration': 0.0,
                'source': f'no ANS_ForceFullBody in {sf.name} (no body-lock)',
            }

        existing = per_god_slot.get((god, slot))
        if existing is None:
            per_god_slot[(god, slot)] = candidate
        else:
            # Prefer a candidate with a real body-lock duration over a zero one;
            # among non-zero ones keep the one with smallest duration (primary
            # commit montage, not a long variant like "Pre"/"Still"/"WallRun").
            if existing['duration'] == 0 and candidate['duration'] > 0:
                per_god_slot[(god, slot)] = candidate
            elif candidate['duration'] > 0 and 0 < candidate['duration'] < existing['duration']:
                per_god_slot[(god, slot)] = candidate

    out = sorted(per_god_slot.values(), key=lambda r: (r['god'], r['slot']))
    # Clean NaN/inf from any float fields before serializing to strict JSON.
    import math
    def clean(v):
        if isinstance(v, float):
            if math.isnan(v) or math.isinf(v): return None
            return round(v, 3)
        if isinstance(v, dict): return {k: clean(v2) for k, v2 in v.items()}
        if isinstance(v, list): return [clean(x) for x in v]
        return v
    OUT.write_text(json.dumps(clean(out), indent=2, ensure_ascii=False), encoding='utf-8')

    print(f'Processed {processed} montages, failed {failed}')
    print(f'Extracted durations for {len(out)} god/slot pairs')
    print(f'Wrote {OUT}')

    # Preview Loki
    print('\nLoki values:')
    for entry in out:
        if entry['god'] == 'Loki':
            print(f"  {entry['slot']}: {entry['duration']}s  ({entry['source']})")


if __name__ == '__main__':
    main()
