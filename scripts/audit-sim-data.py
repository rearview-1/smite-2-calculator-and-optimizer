#!/usr/bin/env python3
"""Audit local-file-backed sim data coverage.

This does not validate combat math. It checks whether the generated catalogs
contain enough data for the simulator to make defensible stat/ability decisions
and prints the remaining data gaps that should not be silently ignored.
"""

import json
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "data"

MANUAL_STAT_OVERRIDE_KEYS = {
    "item.BumbasCudgel",
    "Item.BumbasCudgel",
    "Item.BlueStoneBrooch",
    "item.Brawler's Ruin",
    "item.Leviathan's Hide",
    "item.Pharaoh's Curse",
    "item.Shogun's Ofuda",
    "item.Obsidian Macuahuitl",
    "item.Transcendance",
    "item.Transcendence",
    "item.Blood-Forged Blade",
    "item.PendulumBlade",
    "item.Wyrmskin Hide",
    "item.WyrmskinHide",
    "item.Bragi's Harp",
}


def load(name):
    with open(DATA / name, encoding="utf-8") as f:
        return json.load(f)


def passive_has_unmodeled_proc(text):
    if not text:
        return False
    patterns = [
        r"\bAbility Hit\b",
        r"\bAbility Used\b",
        r"\bOn Use\b",
        r"\bAttack Hit\b",
        r"\bHit a God\b",
        r"\bKill a God\b",
        r"\bEvery [\d.]+s\b",
        r"\bStack",
    ]
    return any(re.search(p, text, re.I) for p in patterns)


HARDCODED_OR_RESOLVED_PASSIVES = {
    "item.Hydra's Lament",
    "item.HydrasLament",
    "item.BumbasCudgel",
    "Item.BumbasCudgel",
    "item.BumbasHammer",
    "item.Bagua Mirror",
    "Item.BerserkersShield",
    "item.Sun Beam Bow",
    "item.Omen Drum",
    "item.Rage",
    "item.Polynomicon",
    "item.Obsidian Macuahuitl",
    "item.Blood-Forged Blade",
    "item.Blood-Bound Book",
    "item.PendulumBlade",
    "item.Transcendance",
    "item.Transcendence",
    "item.BookOfThoth",
    "item.DemonicGrip",
    "item.The Executioner",
    "item.Totem of Death",
    "item.ProtectionOfItus",
    "item.TheCrusher",
    "item.Heartseeker",
    "item.Soul Devourer",
    "item.Qin's Blade",
    "item.Divine Ruin",
    "item.HandOfTheAbyss",
    "item.Death Metal",
    "item.CircesHexstone",
    "item.Dreamer's Idol",
    "item.RagnaroksWake",
    "Item.ShieldSplitter",
    "item.LifeBinder",
    "item.LernaeanBow",
    "item.GloriousPridwen",
    "item.OdysseusBow",
    "item.Phoenix Amulet",
    "item.Pharaoh's Curse",
    "item.Screeching Gargoyle ",
    "item.StaffOfMyrddin",
    "item.Wyrmskin Hide",
    "item.WyrmskinHide",
    "item.Alchemist Coat",
    "item.Restorative Amanita",
    "Item.Ancile",
    "Item.BarbedCarver",
    "item.ChandrasGrace",
    "item.Chronos' Pendant",
    "item.Contagion",
    "item.Damaru",
    "Item.DaybreakGavel",
    "Item.DwarfForgedPlate",
    "Item.Erosion",
    "item.EyeOfErebus",
    "item.Eye of the Storm",
    "item.HastenedFatalis",
    "Item.HeartwoodCharm",
    "item.Helm of Darkness",
    "item.Helm of Radiance",
    "item.HideOfTheNemeanLion",
    "item.Kinetic Cuirass",
    "item.Jotunn's Revenge",
    "item.MagisCloak",
    "item.MantleOfDiscord",
    "item.OniHuntersGarb",
    "item.PropheticCloak",
    "item.Resolute Mantle",
    "item.Riptalon",
    "Item.RodOfAsclepius",
    "item.Ruinous Ankh",
    "Item.SanguineLash",
    "Item.ShieldOfThePhoenix",
    "item.Shroud of Vengeance",
    "item.SoulGem",
    "Item.SphereOfNegation",
    "item.Bindings of Lyngvi",
    "item.The Reaper",
    "Item.TyphonsHeart",
    "Item.VitalAmplifier",
    "item.XibalbanEffigy",
}


def passive_is_generically_modeled(key, text):
    """Mirror the broad patterns wired in src/sim/v3/itemEffects.ts.

    This is intentionally conservative: if a passive has extra conditional logic
    beyond the modeled hook, it stays in the review list.
    """
    if not text:
        return False
    if key in HARDCODED_OR_RESOLVED_PASSIVES:
        return True
    if re.search(
        r"On Use:[\s\S]*?(?:Place a Ward|Place a jade current|Reveal|Dash|Stealthed|Protective Link|wall of light|Stasis|Pulse a reveal|Fire a traveling flare|Create a zone)",
        text,
        re.I,
    ) and not re.search(
        r"(?:Deal|Deals|dealing|Damage equal|True Damage|Physical Damage|Magical Damage|Magic Damage)",
        text,
        re.I,
    ):
        return True

    modeled_patterns = [
        r"Adaptive Stat:\s*\+[\d.]+\s+Strength\s+or\s+\+[\d.]+\s+Intelligence",
        r"\+[\d.]+%\s+of all Stats from Items",
        r"(?:Per Stack|Each Stack|Stacks grants|Stack(?:s)?(?: of)?)[\s\S]*?\+\.?[\d.]+%?\s+(?:Strength|Intelligence|Max Health|Lifesteal|Mana)",
        r"At\s+\d+\s+Stacks[\s\S]*?\+\.?[\d.]+%?\s+(?:Strength|Intelligence|Max Health|Lifesteal|Mana)",
        r"\+[\d.]+%\s+bonus Physical Protections from items[\s\S]*\+[\d.]+%\s+bonus Magical Protections from items",
        r"Basic (?:Attack )?Hit[^:]*:?\s*(?:Deal|Inflicts?|Applies?)?\s*\+?[\d.]+\s+True",
        r"(?:Basic\s+)?Attack(?:s deal|\s+Hit)[^:]*:?\s*\+?[\d.]+(?:\s*\(\+[\d.]+\s*per Level\))?\s*bonus\s*(?:Physical|Magical|True)?\s*Damage",
        r"Attack Hit[\s\S]*?Bonus Damage\s*=\s*\+?[\d.]+%\s*Target Base Health\s*&\s*\+?[\d.]+%\s*Target Item Health",
        r"(Ability|Attack)\s+[Hh]it[^:]*:?[^.]*?-[\d.]+%\s*(?:Physical\s+|Magical\s+)?Protections?",
        r"Ability Hit[^:]*:\s*\+?[\d.]+(?:\s*\(\+[\d.]+\s*per Level\))?\s*bonus\s*(?:Physical|Magical|True)?\s*Damage",
        r"Ability Hit[\s\S]*?Bonus Damage\s*=\s*\+?[\d.]+%\s*Target Base Health\s*&\s*\+?[\d.]+%\s*Target Item Health",
        r"Ability Hit[\s\S]*?\+%Health\s*(?:Physical|Magical|True)?\s*Damage[\s\S]*?Damage\s*=\s*[\d.]+%\s*of your Strength[\s\S]*?Max Health",
        r"Ability Hit[\s\S]*?\+(?:Physical|Magical|True)\s+Damage[\s\S]*?Damage\s*=\s*[\d.]+%\s*of your Strength[\s\S]*?over\s*[\d.]+s",
        r"Ability Used:\s*Gain a stack of Momentum[\s\S]*?Momentum grants\s+\+?[\d.]+%\s+Pathfinding\s+for\s+[\d.]+s\.\s*Stacks up to\s+\d+",
        r"Damaging Ability Hit:\s*[\d.]+%\s*Slow[\s\S]*?lasts\s+for\s+[\d.]+s",
        r"Enemies hit by your Basic Attacks or Abilities have\s+[\d.]+%\s+reduced healing\s+for\s+[\d.]+s",
        r"On God Damage Dealt:\s*Apply\s+[\d.]+%\s+Healing Reduction\s+for\s+[\d.]+s",
        r"Ability Hit[^:]*:[^.]*(?:Bleed|Burn)[^.]*?[\d.]+[^.]*?True Damage\s*\d+\s*times\s*over\s*[\d.]+s",
        r"On Use:\s*Teleport\s*up to\s*[\d.]+m",
        r"On Use:[^.]*(?:Silence|Stun|Root)\s+(?:them|enemies|[a-z]+)\s+for\s+[\d.]+s",
        r"On Use:[\s\S]*?-\d+(?:\.\d+)?%\s*(?:Movement Speed|Attack Speed|Protections)",
        r"On Use:\s*\+?[\d.]+%?\s*(?:Strength|Intelligence|Movement Speed|Attack Speed|Protections)\s+(?:and\s+[A-Za-z\s]+?\s+)?for\s+[\d.]+s",
        r"On Use:[\s\S]*?\+?[\d.]+%\s*Movement Speed[\s\S]*?over\s+[\d.]+s",
        r"On Use:[^.]*[\d.]+(?:\s*\(\+[\d.]+\s*per Level\))?\s*(?:Physical|Magical|True)\s+Damage\s*\d+\s*times\s*over\s*[\d.]+s",
        r"On Use:[\s\S]*?\+?[\d.]+(?:\s*\(\+[\d.]+\s*per Level\))?(?:\s*\(\+[\d.]+%\s*Strength(?:\s*&\s*Intelligence)?\))?\s*(?:Physical|Magical|Magic|True)\s+Damage",
        r"On Use:[\s\S]*?\+?[\d.]+(?:\s*\(\+[\d.]+\s*per Level\))?\s*(?:Health\s+)?Shield",
        r"On Use:\s*(?:Become\s+)?Immune[^.]*for\s+[\d.]+s",
        r"On Use:[^.]*Reduce[^.]*(?:Cooldowns?|cooldown)\s+(?:by\s+)?[\d.]+s",
    ]
    return any(re.search(p, text, re.I) for p in modeled_patterns)


def main():
    gods = load("gods-catalog.json")
    items = load("items-catalog.json")
    effects = load("effects-catalog.json")
    ability_audit_path = DATA / "ability-audit.json"
    ability_audit = load("ability-audit.json") if ability_audit_path.exists() else []

    total_abilities = sum(len(g.get("abilities") or {}) for g in gods.values())
    abilities_with_rows = sum(
        1
        for g in gods.values()
        for a in (g.get("abilities") or {}).values()
        if a.get("rankValues")
    )
    god_ge = sum(
        len(effs or [])
        for g in gods.values()
        for effs in (g.get("abilityEffects") or {}).values()
    )
    item_ge = sum(len(i.get("geEffects") or []) for i in items.values())

    item_stat_rows = [
        (k, v)
        for k, v in items.items()
        if v.get("statTags") and v.get("storeFloats")
    ]
    missing_stat_rows = [
        (k, v)
        for k, v in items.items()
        if v.get("statTags") and not v.get("storeFloats")
    ]
    passive_proc_candidates = [
        (k, v)
        for k, v in items.items()
        if passive_has_unmodeled_proc(v.get("passive"))
    ]
    modeled_passive_proc_items = [
        (k, v)
        for k, v in passive_proc_candidates
        if passive_is_generically_modeled(k, v.get("passive") or "")
    ]
    passive_proc_items = [
        (k, v)
        for k, v in passive_proc_candidates
        if not passive_is_generically_modeled(k, v.get("passive") or "")
    ]

    fewer_values_than_tags = [
        (k, v)
        for k, v in item_stat_rows
        if k not in MANUAL_STAT_OVERRIDE_KEYS
        and len(v.get("storeFloats") or []) < len(v.get("statTags") or [])
    ]
    manual_override_count = sum(1 for k in items if k in MANUAL_STAT_OVERRIDE_KEYS)

    print("=== Sim data coverage ===")
    print(f"Gods: {len(gods)}")
    print(f"Abilities: {abilities_with_rows}/{total_abilities} with rank rows")
    print(f"God ability GE summaries: {god_ge}")
    print(f"God passives in effects catalog: {len(effects.get('godPassives') or {})}")
    print()
    print(f"Items: {len(items)}")
    print(f"Items with stat rows: {len(item_stat_rows)}")
    print(f"Items with stat tags but no stat rows: {len(missing_stat_rows)}")
    print(f"Item GE summaries: {item_ge}")
    print(f"Item passives detected with proc-like text: {len(passive_proc_candidates)}")
    print(f"Item passives covered by generic/hardcoded hooks: {len(modeled_passive_proc_items)}")
    print(f"Item passives still needing explicit review: {len(passive_proc_items)}")
    print(f"Items with fewer visible stat rows than stat tags: {len(fewer_values_than_tags)}")
    print(f"Items covered by manual stat overrides: {manual_override_count}")

    if ability_audit:
        print()
        print(f"Ability audit flags still open: {len(ability_audit)}")
        for row in ability_audit[:12]:
            print(f"  - {row.get('god')}.{row.get('slot')} {row.get('name')}: {', '.join(row.get('flags') or [])}")

    if missing_stat_rows:
        print()
        print("First items with tags but no stat rows:")
        for k, v in missing_stat_rows[:12]:
            print(f"  - {v.get('displayName') or k}: tags={v.get('statTags')}")

    if fewer_values_than_tags:
        print()
        print("First items where some tags are passive-only or unresolved:")
        for k, v in fewer_values_than_tags[:12]:
            print(
                f"  - {v.get('displayName') or k}: "
                f"tags={v.get('statTags')} rows={v.get('storeFloats')}"
            )

    if passive_proc_items:
        print()
        print("First passive/proc items needing explicit sim handlers:")
        for k, v in passive_proc_items[:20]:
            first_line = (v.get("passive") or "").splitlines()[0]
            print(f"  - {v.get('displayName') or k}: {first_line}")


if __name__ == "__main__":
    main()
