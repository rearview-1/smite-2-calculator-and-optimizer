#!/usr/bin/env python3
"""Audit god ability rows that may need custom simulator handling.

The report separates truly open risks from risky-looking shapes that are already
covered by the generic resolver or by explicit custom handlers/overrides.
"""

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

REPO = Path(__file__).resolve().parents[1]
GODS = REPO / "data" / "gods-catalog.json"
OUT_DIR = REPO / "tools" / "SmiteAssetProbe" / "out"

GENERIC_SINGLE = {"Base Damage", "Damage", "BaseDamage"}
GENERIC_STR = {
    "Strength Scaling", "Base Str Scaling", "Scaling", "Physical Power Scaling",
    "StrScaling", "Bleed Str Scaling",
}
GENERIC_INT = {
    "Intelligence Scaling", "Int Scaling", "Base Int Scaling", "Magical Power Scaling",
    "INTScaling", "SmallINTScaling", "Magical Scaling", "Bleed Int Scaling",
}
GENERIC_DOT = {"Damage Per Tick", "Tick Rate", "Damage Over Time Duration", "DoT Duration"}
GENERIC_BLEED = {"Bleed Damage", "Bleed Str Scaling", "Bleed Int Scaling"}
GENERIC_BUFF = {"Strength Buff", "Intelligence Buff", "Buff Duration"}
GENERIC_CC = {"Stun Duration", "StunDuration", "Slow Duration", "Root Duration", "Silence Duration"}
GENERIC_META = {
    "Cooldown", "Base Cooldown", "Mana Cost", "Cost", "TalentCD", "Range",
    "Hit Count", "Hits", "Number of Hits",
}

MULTIPHASE_PREFIXES = [
    "Final", "Initial", "Primary", "Secondary", "Heavy", "Cripple",
    "Flurry", "Early", "Late", "First", "Second", "Third", "Charge",
    "Strong", "Weak", "Quick", "Explosion", "Burst", "Passive Bonus",
    "Passive", "Empowered", "Normal", "Unempowered",
]

STACK_LIKE_ROWS = [
    "Max Stack Count", "Max Stacks", "Stack Count", "Max Attacks",
    "AttackCount", "Attack Count", "Stack Cap",
]

GENERIC_PHASE_PREFIXES = {
    "Initial", "Secondary", "Primary", "Cripple", "Heavy", "Flurry", "Final",
    "Charge", "Burst", "Early", "Late", "Strong", "Weak", "Empowered",
    "Normal", "Unempowered", "Quick", "Explosion", "First", "Second", "Third",
    "Stun", "Root", "Impact",
}

CUSTOM_HANDLED = {
    "Loki.A01", "Loki.A02", "Loki.A03", "Loki.A04",
    "Fenrir.A03",
}

SPECIAL_COVERED = {
    "Ares.A04": "phase damage rows are handled by the generic resolver; Channel text is pull/CC timing",
    "Kali.A03": "rupture passive bonus rows are consumed by the engine with local rank values",
    "Mercury.A02": "passive movement-speed row is non-damage and the active attack-speed buff is generic",
}

# Mirrors HIT_COUNT_OVERRIDES in src/sim/v3/abilityResolver.ts.
HIT_COUNT_OVERRIDE_KEYS = {
    "Loki.A02", "Anubis.A01", "Anubis.A03", "Anubis.A04", "Anhur.A04",
    "Ares.A03", "Bacchus.A03", "Cabrakan.A03", "Cernunnos.A02",
    "Ganesha.A02", "Hades.A04", "Hecate.A04", "Fenrir.A03",
    "Khepri.A02", "Kukulkan.A03", "Mordred.A04", "Neith.A04",
    "Poseidon.A03", "Sol.A01", "Ymir.A04", "Zeus.A04", "Artio.A03",
    "Artemis.A01", "Athena.A04", "Chiron.A02", "Danzaburou.A04",
    "Thor.A03", "Loki.A03",
}


def looks_multiphase(rows: list[str]) -> list[str]:
    hits = set()
    for row in rows:
        for prefix in MULTIPHASE_PREFIXES:
            if row.startswith(prefix + " ") or row == prefix:
                hits.add(prefix)
    return sorted(hits)


def row_budget(rows: list[str]) -> dict:
    cats = {
        "direct": 0, "dot": 0, "bleed": 0, "buff": 0, "cc": 0,
        "meta": 0, "stacklike": 0, "multiphase_prefix": 0, "unknown": 0,
    }
    for row in rows:
        if row in GENERIC_SINGLE or row in GENERIC_STR or row in GENERIC_INT:
            cats["direct"] += 1
        elif row in GENERIC_DOT:
            cats["dot"] += 1
        elif row in GENERIC_BLEED:
            cats["bleed"] += 1
        elif row in GENERIC_BUFF:
            cats["buff"] += 1
        elif row in GENERIC_CC:
            cats["cc"] += 1
        elif row in GENERIC_META:
            cats["meta"] += 1
        elif any(row == s or row.startswith(s) for s in STACK_LIKE_ROWS):
            cats["stacklike"] += 1
        elif any(row.startswith(p + " ") for p in MULTIPHASE_PREFIXES):
            cats["multiphase_prefix"] += 1
        else:
            cats["unknown"] += 1
    return cats


def read_god_tooltip(god: str, slot: str) -> str:
    candidates = [
        OUT_DIR / f"Hemingway_Content_UI_StringTables_Abilities_ST_HW_{god}_AbilityDescriptions.exports.json",
        OUT_DIR / f"Hemingway_Content_UI_StringTables_Abilities_ST_HW_{god}_AbilittDescriptions.exports.json",
        OUT_DIR / "Hemingway_Content_UI_StringTables_God_ST_HW_God_AbilityDescriptions.exports.json",
    ]
    for path in candidates:
        if not path.exists():
            continue
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue
        tooltip_fragments = []

        def walk(node):
            if isinstance(node, dict):
                for key, value in node.items():
                    if isinstance(value, str) and key.startswith(f"{god}.{slot}"):
                        tooltip_fragments.append(value)
                    else:
                        walk(value)
            elif isinstance(node, list):
                for child in node:
                    walk(child)

        walk(data)
        if tooltip_fragments:
            return " | ".join(tooltip_fragments)
    return ""


def extract_hit_count_hints(tooltip: str) -> list[str]:
    hints = []
    patterns = [
        (r"hits? (\d+)", "explicit hit count"),
        (r"Hits (\d+) times", "explicit hits N times"),
        (r"(\d+) (?:strikes|dagger|shots|bolts|projectiles)", "explicit projectile count"),
        (r"repeatedly", "repeating-damage phrase"),
        (r"over \{?\w*Duration\}?", "duration-based multi-hit"),
        (r"\{AttackCount\}", "attack count formula token"),
        (r"\{HitCount\}", "hit count formula token"),
        (r"Channel", "channeled"),
        (r"tick", "tick-based"),
    ]
    for pattern, label in patterns:
        match = re.search(pattern, tooltip, re.IGNORECASE)
        if match:
            hints.append(f'{label}: "{match.group(0)}"')
    return hints


def main():
    with open(GODS, encoding="utf-8") as f:
        catalog = json.load(f)

    flagged = []
    covered = []

    for god_name, data in catalog.items():
        for slot in ["A01", "A02", "A03", "A04"]:
            ability = data["abilities"].get(slot)
            if not ability:
                continue
            rows = list((ability.get("rankValues") or {}).keys())
            if not rows:
                continue

            ability_key = f"{god_name}.{slot}"
            cats = row_budget(rows)
            multiphase = looks_multiphase(rows)
            tooltip = read_god_tooltip(god_name, slot)
            hints = extract_hit_count_hints(tooltip)
            is_custom_handled = ability_key in CUSTOM_HANDLED
            is_special_covered = ability_key in SPECIAL_COVERED
            has_hit_override = ability_key in HIT_COUNT_OVERRIDE_KEYS

            flags = []
            coverage = []

            if cats["stacklike"]:
                stack_rows = [r for r in rows if any(r.startswith(s) or r == s for s in STACK_LIKE_ROWS)]
                if is_custom_handled or is_special_covered or has_hit_override:
                    coverage.append("stack-like rows covered by custom handler/hit-count override")
                else:
                    flags.append(f"STACK-LIKE ROW(s) - may be miscounted as hit count: {stack_rows}")

            if cats["multiphase_prefix"]:
                if is_special_covered:
                    coverage.append(SPECIAL_COVERED[ability_key])
                elif is_custom_handled:
                    coverage.append("multi-phase shape covered by custom handler")
                elif set(multiphase).issubset(GENERIC_PHASE_PREFIXES):
                    coverage.append("multi-phase rows covered by generic phase resolver")
                else:
                    flags.append(f"MULTI-PHASE rows with prefixes {multiphase}")

            if "channeled" in " ".join(hints).lower() or "Channel" in tooltip:
                if is_special_covered:
                    coverage.append(SPECIAL_COVERED[ability_key])
                elif is_custom_handled or has_hit_override:
                    coverage.append("channel hit count covered by custom handler/hit-count override")
                else:
                    flags.append("CHANNELED (tooltip)")

            hits_match = re.search(r"[Hh]its (\d+) times", tooltip)
            if hits_match:
                if is_custom_handled or is_special_covered or has_hit_override:
                    coverage.append(f"tooltip hit count {hits_match.group(1)} covered by custom handler/hit-count override")
                else:
                    flags.append(f"TOOLTIP says hits {hits_match.group(1)} times")

            if "{AttackCount}" in tooltip:
                if is_custom_handled or is_special_covered or has_hit_override:
                    coverage.append("AttackCount token covered by custom handler/hit-count override")
                else:
                    flags.append("TOOLTIP uses {AttackCount} formula token")

            if flags:
                flagged.append({
                    "god": god_name,
                    "slot": slot,
                    "name": ability.get("name"),
                    "rows": rows,
                    "hints": hints[:4],
                    "flags": flags,
                })
            elif coverage:
                covered.append({
                    "god": god_name,
                    "slot": slot,
                    "name": ability.get("name"),
                    "coverage": sorted(set(coverage)),
                })

    by_god = defaultdict(list)
    for item in flagged:
        by_god[item["god"]].append(item)

    print("Scanned 77 gods x up to 4 abilities.")
    print(f"Abilities covered by generic/custom resolver despite risky shape: {len(covered)}")
    print(f"Abilities flagged for possible custom-handler need: {len(flagged)}")
    print(f"Gods affected: {len(by_god)}")
    print()

    for god in sorted(by_god.keys(), key=lambda g: -len(by_god[g])):
        entries = by_god[god]
        print(f"{god} ({len(entries)} flagged):")
        for entry in entries:
            print(f"  {entry['slot']} {entry['name']!r}")
            for flag in entry["flags"]:
                print(f"     - {flag}")
            if entry["hints"]:
                print(f"     - tooltip hints: {entry['hints']}")
        print()

    out_path = REPO / "data" / "ability-audit.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(flagged, f, indent=2, ensure_ascii=False)
    covered_path = REPO / "data" / "ability-audit-covered.json"
    with open(covered_path, "w", encoding="utf-8") as f:
        json.dump(covered, f, indent=2, ensure_ascii=False)
    print(f"Full audit written to: {out_path}")
    print(f"Covered audit notes written to: {covered_path}")


if __name__ == "__main__":
    main()
