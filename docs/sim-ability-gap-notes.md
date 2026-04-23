# Ability Resolver Gap Notes

This note records the remaining ability rows that look damage-related in the
local SMITE 2 files but are intentionally not emitted as direct damage by the
v3 generic resolver.

## Resolved in this pass

- The broad ability audit now separates covered risky shapes into
  `data/ability-audit-covered.json`; open audit flags are down to 0.
- Kali A03 rupture bonus now uses its local `Passive Bonus Damage` rank rows.
- Fenrir A03 Brutalize now uses local normal/empowered scaling rows and reads
  `BuildInput.godState` for rune/passive-ready state.
- Mercury A02's passive movement-speed row is recognized as a non-damage buff
  shape instead of an unresolved damage risk.
- `Bari.A03` now merges the auxiliary `Ability3_Projectile` curve table:
  `Damage`, `STR Scaling`, `INT Scaling`, and enhanced Mystic Surge rows.
  The default resolver uses the normal projectile damage and skips enhanced
  rows until Mystic Surge state is modeled.
- `Ares.A02` now emits timed self-buffs for both protections and basic attack
  damage.
- `Rama.A02` now emits its attack-speed buff with a 6s duration from the local
  gameplay effect.
- `Artio.A02` now emits its shield metadata as a timed self-buff.
- Scylla-style `BuffDamage`/`BuffScaling` next-basic riders are handled by the
  sim engine.

## Still intentionally blocked

These are not open audit failures. They are deliberately not emitted as direct
damage by default because they need stance, talent, damage-amp, or target-state
modeling to avoid false positives.

- `Anhur.A01`: local files expose `Damage Buff` plus slow rows and a
  `GE_Anhur_A01_DamageAmpAura` tag effect. The extracted GE does not expose a
  safe direct-damage formula or a duration row.
- `Discordia.A03`: damage-looking row is `TalentInhandPowerBuff`; it is talent
  gated and should not be applied by default.
- `Ganesha.A02`: damage rows are `Base Damage Talent 1` and
  `Int Scaling Talent 1`; they are talent gated.
- `HouYi.A02`: `Damage Increase Percent At 0% Health` is a mark/damage amp,
  not direct damage. The sim needs a target debuff/damage-taken model before
  applying it.
- `Ishtar.A01`: only exposes placeholder `Damage = 5` in the ability table.
  The real empowered-basic modes need stance/shot-mode handling.
- `Ullr.A04`: stance swap rows expose `Physical Power (Bow)` and
  `Physical Lifesteal (Axe)`. The sim needs an explicit stance state before
  applying either safely.
