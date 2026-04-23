import { readFileSync } from 'node:fs'
import type { StatTag } from './types.ts'

interface StructureScan {
  names: string[]
  plausibleFloats: Array<{ offset: number; value: number }>
}

interface StructureFile {
  exports: Array<{
    objectName: string
    serialScan: {
      plausibleFloats?: Array<{ offset: number; value: number }>
    }
  }>
  names: string[]
}

const STAT_TAG_PREFIX = 'Character.Stat.'

function tagToStatTag(tag: string): StatTag | null {
  const name = tag.slice(STAT_TAG_PREFIX.length) as StatTag
  return name || null
}

function readStructure(path: string): StructureScan {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as StructureFile
  const topExport = raw.exports.find((e) =>
    e.serialScan?.plausibleFloats && e.serialScan.plausibleFloats.length > 0,
  )
  return {
    names: raw.names ?? [],
    plausibleFloats: topExport?.serialScan.plausibleFloats ?? [],
  }
}

function extractStatTags(names: string[]): StatTag[] {
  const result: StatTag[] = []
  for (const n of names) {
    if (n.startsWith(STAT_TAG_PREFIX)) {
      const tag = tagToStatTag(n)
      if (tag) result.push(tag)
    }
  }
  return result
}

export interface ItemStatExtraction {
  path: string
  statTagsFound: StatTag[]
  floatsFound: number[]
  pairedProvisional: Array<{ tag: StatTag; value: number }>
  mismatchReason?: string
}

export function extractItemStats(structurePath: string): ItemStatExtraction {
  const { names, plausibleFloats } = readStructure(structurePath)
  const tags = extractStatTags(names)
  const floats = plausibleFloats.map((p) => p.value)

  const floatsUsed = floats.slice(0, tags.length)
  const mismatchReason =
    floats.length !== tags.length
      ? `tag count (${tags.length}) != float count (${floats.length}); taking first ${tags.length} floats`
      : undefined

  const paired = tags.map((tag, i) => ({ tag, value: floatsUsed[i] ?? 0 }))

  return {
    path: structurePath,
    statTagsFound: tags,
    floatsFound: floats,
    pairedProvisional: paired,
    mismatchReason,
  }
}

export interface StatOrderOverride {
  order: StatTag[]
}

export function applyStatOverride(
  extraction: ItemStatExtraction,
  override: StatOrderOverride,
): Array<{ tag: StatTag; value: number }> {
  if (override.order.length !== extraction.floatsFound.length && override.order.length > extraction.floatsFound.length) {
    throw new Error(
      `Override expects ${override.order.length} stats but found ${extraction.floatsFound.length} floats for ${extraction.path}`,
    )
  }
  return override.order.map((tag, i) => ({ tag, value: extraction.floatsFound[i] ?? 0 }))
}
