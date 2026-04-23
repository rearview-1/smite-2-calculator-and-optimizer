# Sim Data Status

This tracks what is currently backed by local SMITE 2 files and what still
needs explicit simulator handlers.

## Current Coverage

- `data/gods-catalog.json`: 77 gods, 308 ability slots, 303 ability slots with
  rank rows.
- `data/items-catalog.json`: 259 item-like records, 219 with visible item stat
  rows, 835 attached item GE summaries.
- `data/effects-catalog.json`: 87 god passive records and 116 buff records.
- Item stat extraction now uses `HWEquipmentItem_ItemTooltipData` stat-row
  offsets `15, 32, 49, ...` so passive cooldowns and overlapping float scan
  artifacts are not treated as item stats.
- The TypeScript resolver now maps visible stat values to likely stat tags by
  numeric range, with manual overrides for passive-only tag collisions.

## Modeled In Sim

- Physical and magical percent/flat penetration.
- Cooldown stat diminishing returns: `CDR = CD / (CD + 100)`.
- Adaptive starter/item stats from local passive text.
- Transcendence and Book of Thoth mana conversion and partial-stack mana.
- Polynomicon next-basic magical damage.
- Existing v3 item hooks for Hydra's Lament, Bumba's Cudgel, Oath-Sworn Spear,
  Bloodforge, Pendulum Blade, and Transcendence.
- Relic `relic` rotation actions now resolve against `attacker.relics` instead
  of item slots.
- Generic passive-text hooks now cover common ability-hit bonus damage, target
  health damage, ability bleed/burn damage, basic-hit bonus damage, active
  damage, active shields, utility actives, on-hit enemy debuffs, percent
  protection shred, and ability-cast self-buffs when the tooltip shape is
  parseable.
- Stack/stat passives now include partial-stack Strength/Intelligence/Health/
  Lifesteal/Mana, item stat amplification, Dwarven Plate-style protection
  amplification, and stackable self-buffs.
- Additional hardcoded item hooks cover Divine Ruin, The Crusher, Heartseeker,
  Soul Reaver, Qin's Blade, Death Metal, Odysseus' Bow, Lernaean Bow, Phoenix
  Feather, Glorious Pridwen, Staff of Myrddin, and Wyrmskin/Bracer ramp effects.
- Stacking percent protection shred is wired for Executioner/Demonic/Totem and
  Avenging Blade style passives.
- Kali A03 rupture bonus now uses local `Passive Bonus Damage` rank rows instead
  of the older level-based approximation.
- Fenrir A03 Brutalize now has an explicit handler. Use `godState` values like
  `{ "FenrirRunes": 5 }` or `{ "FenrirPassiveReady": true }` for empowered
  scaling.
- Team mode merges independent attacker timelines onto one shared defender HP
  pool for kill timing and overkill.
- `data/ability-audit-covered.json` records risky-looking ability rows already
  handled by the generic resolver or explicit engine logic.

## Known Gaps

- 111 item passives contain proc-like text; 81 are covered by generic/hardcoded
  hooks and 30 still need explicit review. Most of the remaining entries are
  conditional defensive triggers, aura/team effects, summons, healing, incoming
  damage reflection/mitigation, kill effects, or advanced item-specific rules.
- Ability audit flags are currently at 0 open entries.
- Multi-target resolution still targets the primary defender only.
- Team mode shares HP/overkill timing, but cross-attacker debuffs/shields are
  not yet applied during mitigation.
