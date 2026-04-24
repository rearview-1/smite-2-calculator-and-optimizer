#!/usr/bin/env tsx

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inferGodDamageType, loadGods, type BasicAttackCatalogEntry } from '../src/catalog/loadCatalogs.ts'

type DamageType = 'physical' | 'magical' | 'true' | 'unknown'

interface BasicAssetAuditRow {
  godId: string
  inferredDamageType: Exclude<DamageType, 'unknown'>
  assetDamageTypes: DamageType[]
  assetCanCrit: boolean
  assetFiles: string[]
  mismatch: boolean
  missingAssetData: boolean
}

const OUT_DIR = 'tools/SmiteAssetProbe/out'
const OUT_PATH = 'data/basic-attack-audit.json'
const CATALOG_PATH = 'data/basic-attacks-catalog.json'

function detectDamageType(names: Set<string>): DamageType {
  if (names.has('Effect.Type.Damage.Magical')) return 'magical'
  if (names.has('Effect.Type.Damage.Physical')) return 'physical'
  if (names.has('Effect.Type.Damage.True')) return 'true'
  return 'unknown'
}

function isBasicAttackAssetFile(file: string): boolean {
  if (!file.endsWith('.structure.json')) return false
  if (!/GameplayEffect/i.test(file)) return false
  if (!/Common_Abilities_(?:BearBasicAttack|BasicAttack|InhandAttack|Inhand|Inhands)/i.test(file)) return false
  if (/Common_Abilities_Ability[1-4]_/i.test(file)) return false
  if (/Common_Abilities_Passive_/i.test(file)) return false
  if (/Common_Talents_/i.test(file)) return false
  if (/Tag_(?:Melee|Ranged)/i.test(file)) return false
  return true
}

function extractGodId(file: string): string | null {
  const match = file.match(/GODS_(.+?)_Common_Abilities_(?:BearBasicAttack|BasicAttack|InhandAttack|Inhand|Inhands)/i)
  return match?.[1] ?? null
}

function main() {
  const gods = loadGods()
  const files = readdirSync(OUT_DIR).filter(isBasicAttackAssetFile)

  const assetRows = new Map<string, { types: Set<DamageType>; canCrit: boolean; files: string[] }>()
  for (const file of files) {
    const godId = extractGodId(file)
    if (!godId) continue

    const fullPath = join(OUT_DIR, file)
    const raw = JSON.parse(readFileSync(fullPath, 'utf8')) as { names?: string[] }
    const names = new Set(raw.names ?? [])
    if (!names.has('Ability.Type.Inhand')) continue

    const type = detectDamageType(names)
    if (type === 'unknown') continue

    const current = assetRows.get(godId) ?? { types: new Set<DamageType>(), canCrit: false, files: [] }
    current.types.add(type)
    current.canCrit ||= names.has('Effect.Property.CanCrit')
    current.files.push(file)
    assetRows.set(godId, current)
  }

  const audit: BasicAssetAuditRow[] = Object.keys(gods).sort().map((godId) => {
    const inferredDamageType = inferGodDamageType(gods[godId])
    const asset = assetRows.get(godId)
    const assetDamageTypes = asset ? [...asset.types].sort() : []
    return {
      godId,
      inferredDamageType,
      assetDamageTypes,
      assetCanCrit: asset?.canCrit ?? false,
      assetFiles: asset?.files.sort() ?? [],
      mismatch: assetDamageTypes.length > 0 && !assetDamageTypes.includes(inferredDamageType),
      missingAssetData: assetDamageTypes.length === 0,
    }
  })

  const basicsCatalog: Record<string, BasicAttackCatalogEntry> = {}
  for (const row of audit) {
    basicsCatalog[row.godId] = {
      godId: row.godId,
      damageType: row.assetDamageTypes[0] && row.assetDamageTypes[0] !== 'unknown'
        ? row.assetDamageTypes[0] as BasicAttackCatalogEntry['damageType']
        : row.inferredDamageType,
      canCrit: row.assetFiles.length > 0 ? row.assetCanCrit : true,
      sourceFiles: row.assetFiles,
      extraction: row.assetFiles.length > 0 ? 'asset' : 'fallback',
    }
  }

  writeFileSync(OUT_PATH, `${JSON.stringify(audit, null, 2)}\n`, 'utf8')
  writeFileSync(CATALOG_PATH, `${JSON.stringify(basicsCatalog, null, 2)}\n`, 'utf8')

  const mismatches = audit.filter((row) => row.mismatch)
  const missing = audit.filter((row) => row.missingAssetData)
  console.log(`Gods audited: ${audit.length}`)
  console.log(`Damage-type mismatches: ${mismatches.length}`)
  console.log(`Missing extracted basic-attack asset data: ${missing.length}`)
  if (mismatches.length > 0) {
    console.log('Mismatches:')
    for (const row of mismatches) {
      console.log(`  - ${row.godId}: inferred=${row.inferredDamageType} assets=${row.assetDamageTypes.join(', ')}`)
    }
  }
  if (missing.length > 0) {
    console.log('Missing asset data:')
    for (const row of missing) {
      console.log(`  - ${row.godId}: inferred=${row.inferredDamageType}`)
    }
  }
  console.log(`Full audit written to ${OUT_PATH}`)
  console.log(`Basic-attack catalog written to ${CATALOG_PATH}`)
}

main()
