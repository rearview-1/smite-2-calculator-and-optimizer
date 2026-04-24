import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Curve } from './curve.ts'
import type { AbilitySlot } from '../sim/v3/types.ts'

interface CurveTableExportRow {
  'Keys[1]'?: Array<{ Time: number; Value: number }>
  InterpMode?: number
}

interface CurveTableExport {
  Rows?: Record<string, CurveTableExportRow>
}

interface AspectCurveSource {
  file?: string
  rows?: Record<string, string>
  constRows?: Record<string, number>
}

const OUT_DIR = join(process.cwd(), 'tools', 'SmiteAssetProbe', 'out')

const CURVE_TABLE_CACHE = new Map<string, Record<string, Curve>>()

function exportRowToCurve(row: CurveTableExportRow | undefined): Curve | null {
  const keys = (row?.['Keys[1]'] ?? [])
    .map((key) => ({ t: key.Time, v: key.Value }))
    .filter((key) => Number.isFinite(key.t) && Number.isFinite(key.v))
  if (keys.length === 0) return null
  return {
    keys,
    interp: row?.InterpMode === 0 ? 'linear' : 'step',
  }
}

function loadCurveTable(file: string): Record<string, Curve> {
  const cached = CURVE_TABLE_CACHE.get(file)
  if (cached) return cached
  const fullPath = join(OUT_DIR, file)
  const json = JSON.parse(readFileSync(fullPath, 'utf-8')) as CurveTableExport[]
  const rows = json[0]?.Rows ?? {}
  const out: Record<string, Curve> = {}
  for (const [rowName, row] of Object.entries(rows)) {
    const curve = exportRowToCurve(row)
    if (curve) out[rowName] = curve
  }
  CURVE_TABLE_CACHE.set(file, out)
  return out
}

const ASPECT_CURVE_SOURCES: Record<string, Partial<Record<AbilitySlot, AspectCurveSource[]>>> = {
  Athena: {
    A04: [{
      file: 'Hemingway_Content_Characters_GODS_Athena_Common_Talents_Talent_1_CT_Athena_Talent1_EffectValues.exports.json',
      rows: {
        'Base Damage': 'Base Damage',
        'Damage Int Scaling': 'Int Scaling',
        'Damage Amp': 'Damage Amp',
      },
      constRows: {
        'Debuff Duration': 3.4,
      },
    }],
  },
  Bacchus: {
    A01: [{
      file: 'Hemingway_Content_Characters_GODS_Bacchus_Common_Talents_Talent_1_CT_Bacchus_Talent1_EffectValues.exports.json',
      rows: {
        BuffDuration: 'Buff Duration',
        'Empowered Base Damage': 'BuffDamage',
        'STR Scaling': 'Buff STR Scaling',
      },
    }],
  },
  Cabrakan: {
    A01: [{
      file: 'Hemingway_Content_Characters_GODS_Cabrakan_Common_Talents_Talent_1_LevelConfigs_CT_Cabrakan_Talent_EffectValues.exports.json',
      rows: {
        'A01 Bonus Damage': 'Bonus Damage',
        'A01 Int Scaling': 'Bonus Int Scaling',
        'A01 Str Scaling': 'Bonus Strength Scaling',
      },
    }],
  },
  Chaac: {
    A03: [{
      file: 'Hemingway_Content_Characters_GODS_Chaac_Common_Talents_Talent_1_CT_Chaac_Talent1_EffectValues.exports.json',
      rows: {
        'DoT Base Damage': 'Damage Per Tick',
        'DoT STR Scaling': 'Strength Scaling',
        'DoT INT scaling': 'Int Scaling',
        'DoT Tick Time': 'TickTime',
      },
    }],
  },
  Cupid: {
    A01: [{
      file: 'Hemingway_Content_Characters_GODS_Cupid_Common_Talents_Talent_1_CT_Cupid_Talent1_EffectValues.exports.json',
      rows: {
        'Initial Damage': 'Aspect Initial Damage',
        'Initial STR Scaling': 'Aspect Initial STR Scaling',
        'Initial INT Scaling': 'Aspect Initial INT Scaling',
        'Explosion Damage': 'Aspect Explosion Damage',
        'Explosion STR Scaling': 'Aspect Explosion STR Scaling',
        'Explosion INT Scaling': 'Aspect Explosion INT Scaling',
      },
    }],
  },
  Anhur: {
    A02: [{
      file: 'Hemingway_Content_Characters_GODS_Anhur_Common_Talents_Talent_1_CT_Anhur_Talent1_EffectValues.exports.json',
      rows: {
        'Buff Duration': 'Buff Duration',
        ASperStack: 'Attack Speed Buff',
      },
    }],
  },
  Fenrir: {
    A02: [{
      file: 'Hemingway_Content_Characters_GODS_Fenrir_Common_Talents_Talent_1_CT_Fenrir_Talent1_EffectValues.exports.json',
      rows: {
        'Strength Bonus': 'Strength Buff',
        'Attack Speed Bonus': 'Attack Speed Buff',
        'Buff Duration': 'Buff Duration',
      },
    }],
  },
  Gilgamesh: {
    A04: [{
      file: 'Hemingway_Content_Characters_GODS_Gilgamesh_Common_Talents_Talent_1_CT_Gilgamesh_Talent1_EffectValues.exports.json',
      rows: {
        Damage: 'Aspect Launch Damage',
        'Int Scaling': 'Aspect Launch Int Scaling',
      },
    }],
  },
  Poseidon: {
    A02: [{
      file: 'Hemingway_Content_Characters_GODS_Poseidon_Common_Talents_Talent_1_CT_Poseidon_Talent1_EffectValues.exports.json',
      rows: {
        'Base Damage': 'Aspect Projectile Base Damage',
        Duration: 'Aspect Projectile Duration',
        A01InhandPowerScaling: 'Aspect Projectile Inhand Scaling',
      },
    }],
  },
  Xbalanque: {
    A01: [{
      file: 'Hemingway_Content_Characters_GODS_Xbalanque_Common_Talents_Talent_1_LevelConfigs_CT_Xbalanque_Talent1_A01_EffectValues.exports.json',
      rows: {
        Damage: 'Aspect Projectile Base Damage',
        'STR Scaling': 'Aspect Projectile Strength Scaling',
        'INT Scaling': 'Aspect Projectile Int Scaling',
      },
    }],
  },
  Ra: {
    A02: [{
      file: 'Hemingway_Content_Characters_GODS_Ra_Common_Talents_Talent_1_CT_Ra_Talent1_EffectValues.exports.json',
      rows: {
        'Enhanced Attack Damage': 'Aspect Projectile Base Damage',
        'Enhanced Attack Power Scaling': 'Aspect Projectile Int Scaling',
      },
    }],
  },
  Odin: {
    A02: [{
      file: 'Hemingway_Content_Characters_GODS_Odin_Common_Talents_Talent_1_Ability2_LevelConfigs_CT_Odin_A02_Talent_1_EffectValues.exports.json',
      rows: {
        Strength: 'Strength Buff',
        'Attack Speed': 'Attack Speed Buff',
        Duration: 'Buff Duration',
      },
    }],
    A03: [{
      file: 'Hemingway_Content_Characters_GODS_Odin_Common_Talents_Talent_1_Ability3_LevelConfigs_CT_Odin_A03_Talent_1_EffectValues.exports.json',
      rows: {
        Damage: 'Base Damage',
        'Damage Scaling': 'Strength Scaling',
      },
    }],
  },
  Thanatos: {
    A03: [{
      file: 'Hemingway_Content_Characters_GODS_Thanatos_Common_Talents_Talent_1_CT_Thanatos_Talent1_EffectValues.exports.json',
      rows: {
        A03MaxHpDamageScaling: 'Aspect Target Max HP Scaling',
      },
    }],
  },
  Yemoja: {
    A02: [{
      file: 'Hemingway_Content_Characters_GODS_Yemoja_Common_Talents_Talent_1_LevelConfigs_CT_Yemoja_Talent1_EffectValues.exports.json',
      rows: {
        A02RedBase: 'Secondary Damage',
        A02RedScaling: 'Secondary Int Scaling',
      },
    }],
  },
}

function constantCurve(value: number): Curve {
  return {
    interp: 'step',
    keys: [
      { t: 1, v: value },
      { t: 5, v: value },
    ],
  }
}

export function getAspectAbilityRows(godId: string, slot: AbilitySlot): Record<string, Curve> {
  const sources = ASPECT_CURVE_SOURCES[godId]?.[slot] ?? []
  const out: Record<string, Curve> = {}
  for (const source of sources) {
    if (source.file) {
      const table = loadCurveTable(source.file)
      for (const [sourceRow, targetRow] of Object.entries(source.rows ?? {})) {
        const curve = table[sourceRow]
        if (curve) out[targetRow] = curve
      }
    }
    for (const [rowName, value] of Object.entries(source.constRows ?? {})) {
      out[rowName] = constantCurve(value)
    }
  }
  return out
}
