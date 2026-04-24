#!/usr/bin/env tsx

import { readFileSync } from 'node:fs'

import { loadGods } from '../../src/catalog/loadCatalogs.ts'
import type { AbilitySlot } from '../../src/sim/v3/types.ts'

type StringTableExport = Array<{
  StringTable?: {
    KeysToEntries?: Record<string, string>
  }
}>

export type AbilityDescriptionBundle = {
  prefix: string | null
  short: string | null
  longs: string[]
  combined: string | null
  keys: string[]
}

let _entries: Record<string, string> | null = null

function loadEntries(): Record<string, string> {
  if (_entries) return _entries
  const file = readFileSync(
    'tools/SmiteAssetProbe/out/Hemingway_Content_UI_StringTables_God_ST_HW_God_AbilityDescriptions.exports.json',
    'utf8',
  )
  const parsed = JSON.parse(file) as StringTableExport
  _entries = parsed[0]?.StringTable?.KeysToEntries ?? {}
  return _entries
}

function stripMarkup(text: string): string {
  return text
    .replace(/<keyword[^>]*>/gi, '')
    .replace(/<\/keyword>/gi, '')
    .replace(/<\/>/g, '')
    .replace(/\r/g, '')
    .replace(/â€¢/g, '•')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function normalizeGodPrefixes(godId: string): string[] {
  const god = loadGods()[godId]
  const prefixes = new Set<string>()
  if (god?.effectsKey) prefixes.add(god.effectsKey)
  prefixes.add(godId)
  prefixes.add(godId.replace(/_/g, ''))
  return [...prefixes].filter(Boolean)
}

function sortLongKey(a: string, b: string): number {
  const parseIndex = (key: string): number => {
    if (/\.InGame\.Long$/.test(key)) return 0
    const match = /\.InGame\.Long(?:\.?)(\d+)$/.exec(key)
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
  }
  const diff = parseIndex(a) - parseIndex(b)
  return diff !== 0 ? diff : a.localeCompare(b)
}

export function getAuthoredAbilityDescription(godId: string, slot: AbilitySlot): AbilityDescriptionBundle {
  const entries = loadEntries()
  for (const prefix of normalizeGodPrefixes(godId)) {
    const shortKey = `${prefix}.${slot}.InGame.Short`
    const outOfGameKey = `${prefix}.${slot}.OutOfGame`
    const longKeys = Object.keys(entries)
      .filter((key) => key.startsWith(`${prefix}.${slot}.InGame.Long`))
      .sort(sortLongKey)
    const short = entries[shortKey] ?? entries[outOfGameKey] ?? null
    if (!short && longKeys.length === 0) continue

    const longs = longKeys
      .map((key) => stripMarkup(entries[key] ?? ''))
      .filter(Boolean)
    const parts = [short ? stripMarkup(short) : null, ...longs].filter((part): part is string => Boolean(part))
    return {
      prefix,
      short: short ? stripMarkup(short) : null,
      longs,
      combined: parts.length > 0 ? parts.join('\n') : null,
      keys: [shortKey, ...longKeys].filter((key) => key in entries),
    }
  }

  return {
    prefix: null,
    short: null,
    longs: [],
    combined: null,
    keys: [],
  }
}
