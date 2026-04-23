#!/usr/bin/env python3
"""Rebuild data/ability-timings.json from mined animation durations in
tools/SmiteAssetProbe/out/anim-timings.json.

Mapping heuristic: SMITE 2 per-god ability animations are named
  Offhand_01, Offhand_02, Offhand_03, Offhand_04 → A01..A04 respectively.
Some abilities have multiple variants (Intro/Loop/Outro, Still, Deploy).
We pick the "primary" animation per ability slot using this priority:

  1. Exact filename "Offhand_<N>.uasset"              (canonical cast anim)
  2. "Offhand_<N>_<something>.uasset" NOT containing  "Intro"/"Outro"/"Still"
     (ranked by shortest anim — usually the cast-lockout duration)
  3. Any "Offhand_<N>_Intro" if no other match        (cast pre-phase)

Special cases noted inline.

Additionally, we preserve manually-authored entries that have extra fields
(hitInterval, deployableDuration, damage offsets) when refreshing.
"""
import json
import re
import sys
from pathlib import Path
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

REPO = Path(__file__).resolve().parents[1]
ANIM_DUMP = REPO / "tools/SmiteAssetProbe/out/anim-timings.json"
OUT = REPO / "data/ability-timings.json"


def main():
    anims = json.loads(ANIM_DUMP.read_text(encoding='utf-8'))

    # Bucket animations per (god, slot)
    by_god_slot = defaultdict(list)  # {(god, slot): [(filename, duration, path)]}
    all_by_god = defaultdict(list)   # {god: [(filename, duration, path)]}

    path_re = re.compile(
        r'/GODS/(?P<god>[^/]+)/Common/Animations/Base/(?:Montages/)?(?P<fname>[^./]+)\.uasset',
        re.IGNORECASE
    )
    # Match Offhand_N or Offhand_0N (e.g. Offhand_01). Tail can be empty or "_Variant"
    slot_re = re.compile(r'^Offhand_0?(?P<slot>[1-4])(?P<tail>($|_.*))', re.IGNORECASE)

    for a in anims:
        m = path_re.search(a['path'])
        if not m:
            continue
        god = m.group('god')
        fname = m.group('fname')
        duration = a['durationSeconds']

        all_by_god[god].append((fname, duration, a['path']))

        sm = slot_re.match(fname)
        if sm:
            slot_num = int(sm.group('slot'))
            slot = f'A0{slot_num}'
            by_god_slot[(god, slot)].append((fname, duration, a['path']))

    def pick_primary(entries):
        """Given a list of (fname, duration, path), pick the best cast-lockout candidate.
        Prefer exact Offhand_<N> first; else the shortest non-Intro/Outro/Still variant."""
        if not entries:
            return None
        # 1. Exact match (either Offhand_1 or Offhand_01 style)
        for fname, dur, path in entries:
            if re.fullmatch(r'Offhand_0?[1-4]', fname, re.IGNORECASE):
                return (fname, dur, path, 'exact')
        # 2. Shortest non-tail variant
        non_tail = [e for e in entries
                    if not re.search(r'(Intro|Outro|Still|Loop|Floating)', e[0], re.IGNORECASE)]
        if non_tail:
            best = min(non_tail, key=lambda e: e[1])
            return (*best, 'shortest-primary')
        # 3. Anything, shortest
        best = min(entries, key=lambda e: e[1])
        return (*best, 'fallback')

    # Bucket basic-attack chain anims (Fire_01..Fire_N) per god.
    # These are the authored durations at the animation's 30fps keyframe rate; the
    # engine scales by 1/AS at runtime (animations play at "1.0 AS"-equivalent speed).
    fire_re = re.compile(r'^Fire_0?([1-9])$', re.IGNORECASE)
    basic_chains = defaultdict(dict)  # {god: {1: duration, 2: duration, ...}}
    for god, entries in all_by_god.items():
        for fname, duration, _path in entries:
            m = fire_re.match(fname)
            if m:
                idx = int(m.group(1))
                # Keep the shortest if multiple variants exist (e.g. Fire_01 vs Fire_01_Still)
                if idx not in basic_chains[god] or duration < basic_chains[god][idx]:
                    basic_chains[god][idx] = round(duration, 3)

    # Build output
    output = {
        '_schema': {
            'description': (
                'Per-ability cast/damage timing data for the sim engine. '
                'Generated from tools/SmiteAssetProbe/out/anim-timings.json via '
                'scripts/build-ability-timings.py. Durations are mined from the ACL '
                'TracksHeader in each AnimSequence\'s compressed bone data. '
                'Manual overrides in _manualOverrides merge on top.'
            ),
            'fields': {
                'animDuration': 'Full AnimSequence length in seconds (from ACL NumSamples/SampleRate)',
                'castDuration': 'Seconds until the attacker can take the next action. For most abilities this equals animDuration.',
                'damageApplyOffset': 'Seconds from cast start until first damage lands',
                'channelDuration': 'Total channel time for multi-hit channels',
                'hitInterval': 'Seconds between hits in a channel',
                'finalHitOffset': 'When the last/heavy hit lands, for phase abilities',
                '_source': 'Provenance note',
                '_altAnims': 'Alternative animation variants found for this slot',
            },
        },
        '_genericDefaults': {
            'direct':  {'castDuration': 0.35, 'damageApplyOffset': 0.2},
            'dot':     {'castDuration': 0.35, 'damageApplyOffset': 0.5},
            'channel': {'castDuration': 2.0,  'hitInterval': 0.4, 'damageApplyOffset': 0.4},
            'burst':   {'castDuration': 0.5,  'damageApplyOffset': 0.0},
        },
    }

    # Shape classification drives the cast/anim ratio for abilities without explicit
    # measurements. Ratios were calibrated from Loki user-measurements:
    #   - A02 deployable: cast 0.183s / anim 0.733s = 0.25
    #   - A03 channel:    cast 1.833s / anim 2.033s = 0.90
    # Other ratios are reasonable defaults for the shape.
    SHAPE_RATIOS = {
        'channel':     0.90,
        'deployable':  0.25,
        'strike':      0.50,
        'mobility':    0.25,
        'dot':         0.35,
        'burst':       0.60,
        'default':     0.60,
    }

    # Load gods catalog so we can classify each ability by shape.
    gods_catalog = json.loads((REPO / 'data/gods-catalog.json').read_text(encoding='utf-8'))

    # Load mined body-lock durations (ANS_ForceFullBody Duration from each Mon_Offhand).
    # Overrides shape-heuristic estimates when present.
    mined = {}
    mined_path = REPO / 'data/montage-durations.json'
    if mined_path.exists():
        for entry in json.loads(mined_path.read_text(encoding='utf-8')):
            mined[(entry['god'], entry['slot'])] = entry['duration']
        print(f'[mined] loaded {len(mined)} body-lock durations')

    # HIT_COUNT_OVERRIDES from abilityResolver.ts — channel abilities
    CHANNEL_OVERRIDES = set('''
        Loki.A02 Loki.A03 Anubis.A01 Anubis.A03 Anubis.A04 Anhur.A04 Ares.A03
        Bacchus.A03 Cabrakan.A03 Cernunnos.A02 Ganesha.A02 Hades.A04 Hecate.A04
        Fenrir.A03 Khepri.A02 Kukulkan.A03 Mordred.A04 Neith.A04 Poseidon.A03
        Sol.A01 Ymir.A04 Zeus.A04 Artio.A03 Artemis.A01 Athena.A04 Chiron.A02
        Danzaburou.A04 Thor.A03
    '''.split())

    def classify_shape(god, slot):
        key = f'{god}.{slot}'
        if key in CHANNEL_OVERRIDES:
            return 'channel'
        ab = gods_catalog.get(god, {}).get('abilities', {}).get(slot, {})
        rv = ab.get('rankValues') or {}
        rows = list(rv.keys())
        # DoT pattern
        if 'Damage Per Tick' in rows and 'Tick Rate' in rows:
            return 'dot'
        # Multi-phase (strike) — has prefixed rows like "Cripple Base Damage" + "Heavy Base Damage"
        phase_prefixes = ['Cripple', 'Heavy', 'Initial', 'Final', 'Primary', 'Secondary']
        phase_count = sum(1 for p in phase_prefixes if any(r.startswith(p + ' ') for r in rows))
        if phase_count >= 2:
            return 'strike'
        # Buff-heavy → mobility/utility
        if any('Buff' in r for r in rows) or any('Movement Speed' in r for r in rows):
            return 'mobility'
        # Deployable heuristic — ability with Stun/DoT targeting area
        return 'default'

    # Per-ability user-measured overrides (cast lockout in seconds from in-game recording).
    # Add entries here as they're measured — format: ('God', 'A0N'): {'castDurationMeasured': X.XX, '_measuredBy': 'method'}
    user_measurements = {
        ('Loki', 'A02'): {'castDurationMeasured': 0.183, '_measuredBy': 'user timecode 11 frames @ 60fps'},
        ('Loki', 'A03'): {'castDurationMeasured': 1.833, '_measuredBy': 'user timecode 22:47→24:37 = 110 frames @ 60fps'},
    }

    manual_overrides = {
        # Loki A02 is a fire-and-forget deployable; cast lockout ≠ deployable lifetime.
        ('Loki', 'A02'): {
            'deployableDuration': 4.0,
            'channelDuration': 4.0,
            'hitInterval': 0.5,
            'damageApplyOffset': 0.5,
            '_comment': 'DEPLOYABLE (GA_Loki_A02 has OnDeployableSpawned). cast = 0.183s user-measured; deployable ticks independently for ~4s with 8 hits at 0.5s intervals.',
        },
        # Loki A03 — channel, 5 flurry + 1 final.
        ('Loki', 'A03'): {
            'channelDuration': None,
            'hitInterval': None,
            'damageApplyOffset': None,
            'finalHitOffset': None,
            '_comment': '5 flurry + 1 final = 6 hits (BP AmountOfWeakSlashes=5). Interval = cast / 6. cast = 1.833s user-measured.',
        },
        # Loki A04 heavy strike lands near cast midpoint.
        ('Loki', 'A04'): {
            'finalHitOffset': None,
            '_comment': 'Two-strike ult: cripple + heavy. Heavy at cast midpoint.',
        },
    }

    god_stats = {'gods': 0, 'slots_filled': 0, 'slots_missing': 0}
    # Include all gods that have EITHER anim data or mined montage data, not just anim.
    processed_gods = sorted({g for (g, _) in by_god_slot.keys()}
                            | {g for (g, _) in mined.keys()}
                            | set(gods_catalog.keys()))

    for god in processed_gods:
        god_stats['gods'] += 1
        god_out = {}
        for slot in ['A01', 'A02', 'A03', 'A04']:
            entries = by_god_slot.get((god, slot), [])
            picked = pick_primary(entries)
            has_mined = (god, slot) in mined
            has_user = (god, slot) in user_measurements
            ability_exists_in_catalog = (
                god in gods_catalog and slot in gods_catalog[god].get('abilities', {})
            )
            if not picked and not has_mined and not has_user and not ability_exists_in_catalog:
                # No evidence this ability even exists — skip.
                god_stats['slots_missing'] += 1
                continue
            god_stats['slots_filled'] += 1
            if picked:
                fname, dur, path, how = picked
            else:
                # No anim picked — use placeholder (0.0) anim duration; cast comes
                # from mined/user/catalog-fallback in the logic below.
                fname, dur, path, how = ('(no Fire_/Offhand_ anim match)', 0.0, '', 'mined-or-catalog-only')
            shape = classify_shape(god, slot)
            ratio = SHAPE_RATIOS.get(shape, SHAPE_RATIOS['default'])
            cast_estimated = round(dur * ratio, 3)

            # Priority: user-measured > mined body-lock duration > shape-heuristic estimate
            measurement = user_measurements.get((god, slot))
            if measurement and 'castDurationMeasured' in measurement:
                cast = round(measurement['castDurationMeasured'], 3)
                cast_source = f'measured ({measurement.get("_measuredBy", "user")})'
            elif (god, slot) in mined:
                mined_dur = mined[(god, slot)]
                # A mined 0.0 means the montage had no ANS_ForceFullBody — the
                # ability has no body-lock. Use a tiny floor (~0.05s) so the sim
                # still advances the action clock a bit for input processing.
                cast = max(mined_dur, 0.05) if mined_dur == 0 else mined_dur
                cast_source = (
                    f'mined: no body-lock in montage (→ 0.05s floor)'
                    if mined_dur == 0 else f'mined: ANS_ForceFullBody Duration'
                )
            elif god in gods_catalog and slot in gods_catalog[god].get('abilities', {}):
                # Ability exists in catalog but has no montage — probably a pure
                # deployable/utility ability with no player animation (e.g. Hecate A01,
                # Aladdin A01). Use a tiny floor like the mined-zero case.
                cast = 0.05
                cast_source = 'no montage found (deployable/instant — 0.05s floor)'
            else:
                cast = cast_estimated
                cast_source = f'estimated: {shape} ratio {ratio} × animDuration'

            entry = {
                'animDuration': round(dur, 3),
                'castDuration': cast,
                'shape': shape,
                'damageApplyOffset': 0.0,
                '_castSource': cast_source,
                '_animSource': f'{fname} ({how})',
            }
            if len(entries) > 1:
                entry['_altAnims'] = sorted(
                    [{'name': e[0], 'duration': round(e[1], 3)} for e in entries if e[0] != fname],
                    key=lambda x: x['duration']
                )
            # Apply manual overrides — dynamic fields computed from cast (not anim)
            ov = manual_overrides.get((god, slot), {})
            for k, v in ov.items():
                if v is None:
                    if k == 'channelDuration':
                        entry[k] = cast
                    elif k == 'hitInterval':
                        entry[k] = round(cast / 6, 3)
                    elif k == 'damageApplyOffset' and (god, slot) == ('Loki', 'A03'):
                        entry[k] = round(cast / 6, 3)
                    elif k == 'finalHitOffset' and (god, slot) == ('Loki', 'A03'):
                        entry[k] = cast
                    elif k == 'finalHitOffset' and (god, slot) == ('Loki', 'A04'):
                        entry[k] = round(cast / 2, 3)
                else:
                    entry[k] = v
            god_out[slot] = entry
        if god_out:
            # Attach basic-attack chain if mined — used by the engine for
            # chain-position-aware basic swing timing.
            chain = basic_chains.get(god)
            if chain:
                # Emit as a dense array indexed by chain step (1-based → 0-based).
                max_step = max(chain.keys())
                god_out['_basicChain'] = [chain.get(i, None) for i in range(1, max_step + 1)]
            output[god] = god_out

    OUT.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding='utf-8')

    print(f'Wrote {OUT}')
    print(f'Gods with any anim data: {god_stats["gods"]}')
    print(f'Slots filled: {god_stats["slots_filled"]}')
    print(f'Slots missing: {god_stats["slots_missing"]}')

    # Diagnostic: gods where we couldn't find any ability anim at all
    no_data_gods = sorted({g for g in all_by_god if not any((g, s) in by_god_slot for s in ['A01','A02','A03','A04'])})
    if no_data_gods:
        print(f'\nGods with anim files but no Offhand_* match ({len(no_data_gods)}):')
        for g in no_data_gods:
            # show what filenames ARE there
            sample = [e[0] for e in all_by_god[g][:6]]
            print(f'  {g}: sample files={sample}')


if __name__ == '__main__':
    main()
